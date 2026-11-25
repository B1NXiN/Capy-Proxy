// capy-relay：把「Capy 桌面客户端」变成 OpenAI 兼容端点。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { session, createJam, getJam, followJam, followBreakpoint, archiveJam, listEvents, deviceInfo, eventCursor, emptyCursor, snapshotCursor, sendJamMessage } from './lib/capy.js';
import { findGit, bashInfo } from './lib/device.js';
import { createHub } from './lib/clienttools.js';
import { openJamStream } from './lib/realtime.js';
import {
  LIMITS,
  FORWARDABLE,
  parseClientTools,
  parseToolChoice,
  forwardableHandlers,
  matchClientTool,
  toolKindOf,
  buildToolArguments,
} from './lib/oaitools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(__dirname, 'config.json');
const MODELS_PATH = path.join(__dirname, 'models.json');

const defaults = {
  port: 8787,
  host: '127.0.0.1',
  localKey: '',
  defaultModel: 'particle/particle-1',
  timeoutMs: 180000,
  archive: true,
  // 把本机工具调用轨迹附在回复末尾（排查「到底有没有跑命令」时很有用）
  showTools: false,
  // 客户端自带的 system prompt 常写着「你无法访问用户电脑」，会把 Capy 的动手能力压掉，
  // 这里在带 system 的请求前补一句事实，避免模型自我阉割。
  capabilityHint: true,
  // 账号没有权限的模型，上游会静默换成 particle-1；这里默认把它当错误抛出，而不是假装成功
  strictModel: true,
  // 把「同名付费模型」自动指到带广告的免费版（如 1017 -> -ads）
  preferAdsFree: true,
  // 直接拿一个已有文件夹当工作区（linked）。留空则让 Capy 在 worktrees 下新建
  workspaceRoot: '',
  // 工具在哪执行：
  //   local  —— 就在跑服务的这台机器上（默认，自己用）
  //   client —— 以 tool_calls 交回调用方，在对方自己的电脑上跑（开中转站给别人用时）
  //   none   —— 拒绝一切执行，只出模型
  execMode: 'local',
  // 旧字段，等价于 execMode: 'client'
  clientTools: false,
  // 流式输出走 realtime websocket 拿逐字增量；关掉就退回「轮询事件 + 攒完整段再吐」
  realtime: true,
};
let cfg = { ...defaults };
try {
  cfg = { ...defaults, ...JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) };
} catch {
  /* 首次运行没有配置文件，用默认值 */
}

let catalog = [];
try {
  catalog = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));
} catch {
  catalog = [{ id: 'particle/particle-1', name: 'Particle-1', context: 1048576, maxOutput: 131072, free: true }];
}

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

// 工具外抛的中枢：设备端把 invocation 挂在这里等调用方执行
const hub = createHub({ log: (...a) => log('[hub]', ...a) });

// 工作区：
//   配了 workspaceRoot 就直接用那个文件夹（联动，不建 worktree）
//   没配就走 Capy 默认的 worktree（需要设备端实现完整的 git 侧写）
function workspaceSpec() {
  const root = String(cfg.workspaceRoot || '').trim();
  if (!root) return { kind: 'worktree' };
  const abs = path.resolve(root);
  try {
    fs.mkdirSync(abs, { recursive: true });
  } catch {}
  return { kind: 'linked', root: abs, roots: [abs] };
}

// ---------------- 请求工具 ----------------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function oaiError(res, status, message, type = 'invalid_request_error') {
  // 已经开了 SSE 流（比如建线程那一步花了 8 秒才发现出错）：头都发出去了，
  // 改不了状态码，只能把错误写进流里，别让客户端一直等。
  if (res.headersSent) {
    try {
      if (String(res.getHeader('content-type') || '').includes('event-stream')) {
        res.write(`data: ${JSON.stringify({ error: { message, type, code: status, param: null } })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
    } catch {}
    try {
      res.end();
    } catch {}
    return;
  }
  sendJson(res, status, { error: { message, type, code: null, param: null } });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.status = 400;
    throw err;
  }
}

// 把 OpenAI 的 messages 压成一段对话文本交给 Capy 的线程
function flattenMessages(messages, model, opts = {}) {
  if (!Array.isArray(messages) || !messages.length) throw Object.assign(new Error('messages 不能为空'), { status: 400 });

  const part = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => {
          if (typeof c === 'string') return c;
          if (c?.type === 'text') return c.text || '';
          if (c?.type === 'image_url') return '[图片：当前通道不支持，请改用文字描述]';
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  };

  // 历史里的 assistant 可能只有 tool_calls、没有正文（标准 OpenAI 里很常见）。
  // 直接按 text 过滤会把它整条丢掉，模型就看不出上一轮自己调过什么。
  const turns = messages
    .map((m) => {
      let text = part(m.content).trim();
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const calls = m.tool_calls
          .map((c) => {
            const fn = c?.function || c || {};
            const name = fn.name || 'tool';
            let args = fn.arguments;
            if (args && typeof args !== 'string') {
              try {
                args = JSON.stringify(args);
              } catch {
                args = '';
              }
            }
            return `${name}(${String(args ?? '{}').slice(0, 400)})`;
          })
          .join('；');
        text = text ? `${text}\n（上一轮调用工具：${calls}）` : `（上一轮调用工具：${calls}）`;
      }
      return { role: m.role, text };
    })
    .filter((m) => m.text);
  if (!turns.length) throw Object.assign(new Error('消息内容为空'), { status: 400 });

  const systems = turns.filter((t) => t.role === 'system');
  const rest = turns.filter((t) => t.role !== 'system');

  // 只有一轮用户消息时不加任何包装，保持原始语义
  if (!systems.length && rest.length === 1 && rest[0].role === 'user') return rest[0].text;

  const lines = [];
  if (systems.length) {
    lines.push('以下是系统指示，请在整段对话中始终遵守：');
    for (const s of systems) lines.push(s.text);
    lines.push('');
  }
  if (cfg.capabilityHint) {
    if (opts.clientTools) {
      lines.push('补充事实：你通过接口为远程调用方服务。你可以调用 bash，但命令会在调用方自己的电脑上执行，不在服务器上。');
      lines.push('需要真实数据时先执行再回答，不要声称自己「没有执行环境」。');
    } else {
      lines.push('补充事实：你运行在这台 Windows 电脑上，可以调用本机 bash（Git Bash / PowerShell）、读写文件、执行命令来完成任务。');
      lines.push('需要真实数据时先动手执行再回答，不要声称自己「无法访问用户电脑」或「没有执行环境」。');
    }
    lines.push('');
  }
  lines.push('以下是对话记录，最后一条是你要回复的：');
  for (const t of rest) {
    const label = t.role === 'assistant' ? '助手' : t.role === 'tool' ? '工具结果' : '用户';
    lines.push(`【${label}】${t.text}`);
  }
  lines.push(`【助手】`);
  return lines.join('\n');
}

// 带广告的免费模型和服务端里的「同名」模型是两套 id。
// 账号没有付费计划时，选不带 -ads 的那个会被上游静默换成 particle-1，
// 所以默认把它们指到广告免费版上（客户端本身也是这么用的）。
const ADS_TWIN = {
  'deepseek/deepseek-v4.1-flash-1017': 'deepseek/deepseek-v4.1-flash-ads',
};

function adsTwin(id) {
  if (ADS_TWIN[id]) return ADS_TWIN[id];
  if (/-1017$/.test(id)) return id.replace(/-1017$/, '-ads');
  return null;
}

function resolveModel(requested) {
  const name = typeof requested === 'string' ? requested.trim() : '';
  if (!name) return { id: cfg.defaultModel, aliasOf: null };
  const hit =
    catalog.find((m) => m.id === name) ||
    catalog.find((m) => m.id.endsWith(`/${name}`)) ||
    catalog.find((m) => m.name.toLowerCase() === name.toLowerCase());
  const id = hit ? hit.id : name;
  const twin = cfg.preferAdsFree ? adsTwin(id) : null;
  return twin ? { id: twin, aliasOf: id } : { id, aliasOf: null };
}

// 工具轨迹开关：config 默认值 ← 请求头 x-capy-tools ← 请求体 capy.showTools
function pickShowTools(req, body) {
  const header = String(req.headers['x-capy-tools'] || '').toLowerCase();
  if (header === '1' || header === 'true') return true;
  if (header === '0' || header === 'false') return false;
  if (body?.capy && typeof body.capy.showTools === 'boolean') return body.capy.showTools;
  return !!cfg.showTools;
}

function traceBlock(tools) {
  if (!Array.isArray(tools) || !tools.length) return '';
  const lines = tools.map((t) => `- ${t.name}${t.arg ? `: ${t.arg}` : ''}`);
  return `\n\n---\n本机工具轨迹（${tools.length} 次）：\n${lines.join('\n')}`;
}

function modelSubstitutedMessage(err) {
  return (
    `你选的 ${err.requestedModel} 实际跑成了 ${err.servedModel}：这个模型在当前账号下没权限（需要付费计划或额度），` +
    'Capy 不会报错，只会悄悄换成免费的 Particle-1。' +
    '要么在 ChatBox 里选 deepseek/deepseek-v4.1-flash-ads（带广告的免费版，反代会自动映射），要么把 config.json 里的 strictModel 改成 false 接受降级。'
  );
}

// ---------------- 接口 ----------------
async function handleHealth(res) {
  try {
    const s = await session();
    const local = s.source === 'local';
    const dev = local ? null : await deviceInfo().catch(() => null);
    const b = local ? bashInfo() : null;
    const bash = local ? !!b.path : dev ? dev.gitBash : null;
    sendJson(res, 200, {
      ok: true,
      mode: local ? 'self-login' : 'desktop-client',
      user: { id: s.userId },
      orgId: s.orgId,
      device: { id: s.deviceId, name: s.deviceName, os: dev?.os || process.platform, daemon: dev?.daemon || null },
      // bash = 能不能执行命令；false 时 agent 只能读写文件
      // gitBashVia 说明它是从哪儿找到的：env:CAPY_BASH / git-windows / path:git / path:bash
      tools: {
        bash,
        gitBashRaw: dev?.gitBashRaw ?? (b?.path ?? null),
        gitBashVia: b?.via ?? (dev ? 'desktop-client' : null),
        gitBin: local ? findGit() : undefined,
      },
      defaultModel: cfg.defaultModel,
      showTools: cfg.showTools,
      execMode: cfg.execMode || (cfg.clientTools ? 'client' : 'local'),
      // 外抛模式细节：能看到哪些 handler 可交给调用方、上限是多少
      toolMode: cfg.execMode === 'client' || cfg.clientTools ? 'standard' : 'local',
      forwardable: cfg.execMode === 'client' || cfg.clientTools ? [...FORWARDABLE] : [],
      limits: LIMITS,
      models: catalog.length,
    });
  } catch (err) {
    sendJson(res, 503, { ok: false, mode: 'unknown', error: err.message, code: err.code || null });
  }
}

function handleModels(res) {
  const list = catalog.slice();
  // 带广告的免费版本身不在客户端目录里，但能用；补进去，方便客户端直接选
  for (const twin of Object.values(ADS_TWIN)) {
    if (!list.some((m) => m.id === twin)) {
      const base = catalog.find((m) => ADS_TWIN[m.id] === twin);
      list.push({ id: twin, name: base ? `${base.name}（广告免费版）` : twin, provider: 'deepseek', context: base?.context ?? 1048576, maxOutput: base?.maxOutput ?? 384000, free: true });
    }
  }
  sendJson(res, 200, {
    object: 'list',
    data: list.map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: m.provider || 'capy',
      capy: { name: m.name, context: m.context, maxOutput: m.maxOutput, free: m.free },
    })),
  });
}

// 设备端把 invocation 挂过来之前，先核对它是不是「模型真的要求调用」。
// 云端会在每条 bash 前面注入自己的环境准备脚本，那些必须留在本机跑，
// 只有事件流里确实出现过对应 tool_use 的，才交给调用方。
async function matchToolUse({ cwd, handler, params }) {
  const m = /jam_[0-9A-Za-z]+/.exec(String(cwd || ''));
  if (!m) return null;
  const jamId = m[0];
  const cmd = params?.command;
  const events = await listEvents(jamId, 300).catch(() => []);
  for (const evt of events) {
    if (evt.kind !== 'assistant') continue;
    for (const b of evt.payload?.blocks || []) {
      if (b.type !== 'tool_use' || !b.toolCallId) continue;
      if (b.toolName === 'message_user') continue;
      if (handler && b.toolName !== handler) continue;
      if (hub.find(b.toolCallId) || hub.wasUsed(b.toolCallId)) continue;
      const want = b.args?.command;
      // 云端会把命令包一层（co-author 之类），所以用包含关系而不是相等
      if (cmd && want && !String(cmd).includes(String(want))) continue;
      return { jamId, block: b };
    }
  }
  return null;
}

// ---------------- 工具外抛 ----------------
// Capy 想执行工具时，relay 把它翻译成标准 tool_calls 交回调用方，
// 调用方在自己机器上跑完，把结果放进下一轮 messages，relay 再回灌给云端。
//
// 关键：能不能外抛由「调用方声明了什么」决定。
// 它声明了 read_file 我们才把 read 交出去；没声明就让设备端本机执行（老行为），
// 绝不发一个它认不出的工具名过去。
const jamCtx = new Map(); // jamId -> { clientTools, choice, parallel }

function setJamCtx(jamId, ctx) {
  if (!jamId) return;
  jamCtx.set(jamId, ctx);
  if (jamCtx.size > 500) jamCtx.delete(jamCtx.keys().next().value);
}

function getJamCtx(jamId, fallback) {
  return jamCtx.get(jamId) || fallback;
}

// tool_choice 与「哪些 handler 能外抛」的判定都在 lib/oaitools.js，
// 这样单元测试能直接验证，不用把服务起起来。


async function waitForToolCall(toolCallId, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rec = hub.find(toolCallId);
    if (rec || Date.now() > until) return rec;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// 开一条 SSE 流并先把 role 发出去，后面才能真正边收边发。
function openSse(res, { id, created, model }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  const chunk = (delta, finish = null) =>
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  chunk({ role: 'assistant', content: '' });
  // 云端调度 + 模型起跑这一段可能十几秒没有任何正文；定期发注释帧保活，
  // 免得中间的反代/客户端把连接判死。
  const hb = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  hb.unref?.();
  const stop = () => clearInterval(hb);
  res.on('close', stop);
  res.on('finish', stop);
  return chunk;
}

function sendToolCalls(res, { id, created, model, stream, text, calls, jamId, usage, elapsedMs, includeUsage = false, sse = null }) {
  const usageObj = {
    prompt_tokens: usage?.inputTokens ?? 0,
    completion_tokens: usage?.outputTokens ?? 0,
    total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
  };
  if (!stream) {
    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text || null, tool_calls: calls },
          finish_reason: 'tool_calls',
        },
      ],
      usage: usageObj,
      capy: { jamId, elapsedMs, mode: 'client-tools' },
    });
  }
  // 流已经由调用方开好（realtime 模式下正文可能已经边收边发了），这里只补剩下的部分
  if (sse) {
    if (text) sse({ content: text });
    calls.forEach((call, index) => sse({ tool_calls: [{ index, ...call }] }));
    sse({}, 'tool_calls');
    if (includeUsage) {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: usageObj,
        })}\n\n`,
      );
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  const chunk = openSse(res, { id, created, model });
  if (text) chunk({ content: text });
  calls.forEach((call, index) => chunk({ tool_calls: [{ index, ...call }] }));
  chunk({}, 'tool_calls');
  // 标准做法：最后单独发一个只有 usage 的 chunk（choices 为空数组）
  if (includeUsage) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: usageObj,
      })}\n\n`,
    );
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// 回填之后先探一眼线程状态：还在 working 就什么都不用做（云端自己会接着跑），
// 停在 waiting 说明模型正等着那个永远不会完成的 operation，直接把它叫醒。
// 叫醒前先记下事件基线，这样新产出的事件才不会漏。
async function resumeIfStuck(jamId, nudgeText, model) {
  const deadline = Date.now() + 2500;
  for (;;) {
    const jam = await getJam(jamId).catch(() => null);
    const st = jam?.status;
    if (st && st !== 'waiting') return null;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const cursor = await snapshotCursor(jamId);
  await sendJamMessage(jamId, nudgeText, { model });
  log('唤醒', jamId, '| 模型停在 wait 上，补发工具结果');
  return cursor;
}

// 把一条内部调用翻成客户端认得的 tool_call：名字按它声明的来，参数按它的 schema 摆。
function toClientCall(scope, { toolCallId, toolName, args }) {
  const tool = matchClientTool(toolKindOf(toolName), scope.clientTools);
  return {
    id: toolCallId,
    type: 'function',
    function: {
      name: tool?.name || toolName,
      arguments: JSON.stringify(buildToolArguments(toolName, args || {}, tool)),
    },
  };
}

async function runToBreakpoint(res, { id, created, model, stream, body, jamId, cursor = null, nudge = null, sse = null }) {
  const fallbackScope = {
    clientTools: parseClientTools(body?.tools),
    choice: parseToolChoice(body?.tool_choice),
    parallel: body?.parallel_tool_calls !== false,
  };
  // 工具声明存在 jam 上：调用方回填那一轮不一定会再把 tools 带全
  const scope = getJamCtx(jamId, fallbackScope);
  const execTools = forwardableHandlers(scope);
  const includeUsage = body?.stream_options?.include_usage === true;

  let cur = cursor;
  let nudged = !!nudge?.sent;
  let requiredTried = false;
  let result = null;
  let lastCalls = 0;

  // 流式：先把 SSE 头开出来，正文交给 realtime 边收边发，别等整轮跑完再吐
  let chunk = null;
  let emitted = '';
  let rt = null;
  if (stream) {
    chunk = sse || openSse(res, { id, created, model });
    if (cfg.realtime !== false && !process.env.CAPY_NO_REALTIME) {
      rt = openJamStream({
        jamId,
        onText: (t) => {
          if (!t || res.writableEnded) return;
          emitted += t;
          chunk({ content: t });
        },
        onReasoning: (t) => {
          if (!t || res.writableEnded) return;
          chunk({ reasoning_content: t });
        },
        log: (...a) => log(...a),
      });
      res.on('close', () => rt?.close());
      res.on('finish', () => rt?.close());
    }
  }
  // 已经实时流过的正文不再重复发；实流没拿到才整段补
  const remainder = (full) => {
    if (!full) return '';
    if (full.startsWith(emitted)) return full.slice(emitted.length);
    return emitted ? '' : full;
  };

  try {
    // 最多转三圈：唤醒一次、required 催一次、指定函数空转一次
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await followBreakpoint({
        jamId,
        timeoutMs: cfg.timeoutMs,
        execTools,
        expectModel: cfg.strictModel ? model : null,
        cursor: cur,
      });

      // 云端把慢调用转成后台 operation 后，模型会停在 wait 上不动。
      // 这时把调用方的输出当成一条新输入推回去，线程会从 waiting 回到 working。
      if (!nudged && nudge?.text && result.type === 'final' && !String(result.text || '').trim()) {
        cur = await snapshotCursor(jamId);
        await sendJamMessage(jamId, nudge.text, { model });
        nudged = true;
        log('唤醒', jamId, '| 模型停在 wait 上，补发工具结果');
        continue;
      }

      if (result.type !== 'tool_call') {
        // tool_choice=required 却只回了文本：催一次，还不调就如实报错，不拿文本冒充
        if (scope.choice?.mode === 'required' && !requiredTried) {
          requiredTried = true;
          cur = await snapshotCursor(jamId);
          await sendJamMessage(jamId, '这一轮必须调用工具，不能直接给出文本回答。请立刻发起一次工具调用。', { model });
          log('催调用', jamId, '| tool_choice=required');
          continue;
        }
        break;
      }

      let calls = result.calls || [];
      lastCalls = calls.length;

      // 指定函数模式：只放行同名工具。
      // 其余调用不在这里处理 —— 设备端挂它们时会被 /internal/hold 直接拒掉，
      // 模型收到失败后自己会改用被指定的工具或直接给文本。
      if (scope.choice?.mode === 'function') {
        calls = calls.filter((c) => toClientCall(scope, c).function.name === scope.choice.name);
        if (!calls.length) {
          cur = await snapshotCursor(jamId);
          continue;
        }
      }

      // 等设备端把这些调用挂上来（它得先核对事件流，确认不是云端自己的准备脚本）
      const ready = [];
      for (const c of calls) {
        const rec = await waitForToolCall(c.toolCallId, ready.length ? 2000 : 12000);
        if (rec) ready.push({ rec, c });
      }
      if (!ready.length) {
        cur = await snapshotCursor(jamId);
        continue;
      }

      // parallel_tool_calls=false：只发第一个，其余直接判失败，别让设备端干等
      let keep = ready;
      if (scope.parallel === false && keep.length > 1) {
        for (const x of keep.slice(1)) hub.fail(x.c.toolCallId, 'parallel_tool_calls=false，本轮只发一个调用');
        keep = keep.slice(0, 1);
      }
      // 单轮上限：超出的判失败，让模型下一轮重发
      if (keep.length > LIMITS.maxToolCalls) {
        for (const x of keep.slice(LIMITS.maxToolCalls)) {
          hub.fail(x.c.toolCallId, `单轮最多 ${LIMITS.maxToolCalls} 个调用，这一条被丢弃`);
        }
        keep = keep.slice(0, LIMITS.maxToolCalls);
      }

      const emitted = keep.map(({ rec, c }) =>
        toClientCall(scope, { toolCallId: c.toolCallId, toolName: c.toolName || rec.handler, args: c.args }),
      );
      log(
        '外抛',
        jamId,
        '|',
        emitted.map((e) => e.function.name).join(','),
        `| ${emitted.length} 个调用 |`,
        emitted[0].function.arguments.slice(0, 120),
      );
      return sendToolCalls(res, {
        id,
        created,
        model,
        stream,
        text: remainder(result.textSoFar),
        calls: emitted,
        jamId,
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        includeUsage,
        sse: chunk,
      });
    }
  } catch (err) {
    if (err.code === 'model_substituted') return oaiError(res, 400, modelSubstitutedMessage(err), 'model_not_available');
    return oaiError(res, 502, err.message, 'upstream_error');
  }

  // 转了三圈还是没交出去：说明设备端一直没挂这条调用
  if (result?.type === 'tool_call' && lastCalls) {
    log('外抛失败', jamId, '| 设备端没有挂起该调用');
    return oaiError(
      res,
      503,
      '设备端没有开启工具外抛模式。请用 CAPY_EXEC=client 重启 device-worker，再重试。',
      'device_not_forwarding',
    );
  }

  // tool_choice=required 最终仍然没调工具：按规格报错，不用文本顶替
  if (scope.choice?.mode === 'required') {
    return oaiError(
      res,
      400,
      'tool_choice 要求这一轮必须调用工具，但模型只给出了文本回答。可以重试，或改用 tool_choice=auto。',
      'tool_choice_violation',
    );
  }

  // 不归档：这个 jam 还要接着跑（客户端回填结果后，云端会继续推）
  const usageObj = {
    prompt_tokens: result?.usage?.inputTokens ?? 0,
    completion_tokens: result?.usage?.outputTokens ?? 0,
    total_tokens: (result?.usage?.inputTokens ?? 0) + (result?.usage?.outputTokens ?? 0),
  };
  const content =
    result?.text ||
    (nudge?.text
      ? `（模型没有继续推理，下面是调用方执行命令的输出）\n${nudge.text}`
      : result?.status === 'waiting'
        ? '（命令仍在调用方电脑上执行，稍后重试可继续）'
        : '（模型没有返回文本）');

  if (!stream) {
    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: usageObj,
      capy: { jamId, servedModel: result?.servedModel, mode: 'client-tools', elapsedMs: result?.elapsedMs },
    });
  }
  const tail = remainder(content);
  if (tail) chunk({ content: tail });
  chunk({}, 'stop');
  if (includeUsage) {
    res.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageObj })}\n\n`,
    );
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// 每个 jam 记住调用方声明了哪些工具、tool_choice 是什么。
// 设备端挂调用时要问这张表：能映射才外抛，不能就让本机跑。
function syncScope(jamId, body) {
  const declared = parseClientTools(body?.tools);
  const prev = jamCtx.get(jamId);
  const scope = {
    clientTools: declared.length ? declared : prev?.clientTools || [],
    choice: parseToolChoice(body?.tool_choice),
    parallel: body?.parallel_tool_calls !== false,
  };
  setJamCtx(jamId, scope);
  return scope;
}

// 403 有好几种：账号被暂停、额度用尽、设备被解绑。不区分的话只会看到「上游返回 403」，
// 用户根本不知道是自己要去申诉还是代码有问题。
async function describeUpstreamError(err) {
  if (err?.status === 403) {
    const { accountStatus } = await import('./lib/auth.js');
    const st = await accountStatus().catch(() => null);
    if (st?.suspended) {
      return 'Capy 账号已被暂停（capy/AccountSuspended）：登录本身有效，但设备和接口都会被拒。请到 capy.ai 看提示或申诉，恢复后不用改代码。';
    }
    return `上游拒绝访问（403${st?.tag ? ` ${st.tag}` : ''}）。可能是额度用尽或设备被解绑，可运行 node login.js status 查看。`;
  }
  return err?.message || String(err);
}

async function handleChatClientTools(req, res, body, ctx) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];

  const declared = parseClientTools(body?.tools);
  if (declared.length > LIMITS.maxTools) {
    return oaiError(res, 400, `tools 最多 ${LIMITS.maxTools} 个，当前 ${declared.length} 个。请精简后再请求。`, 'too_many_tools');
  }

  // 客户端把命令执行完，把结果送回来了：找到那些挂着的线，把结果灌回去，然后接着看云端的新事件
  const backfills = msgs
    .filter((m) => m && m.role === 'tool' && m.tool_call_id)
    .map((m) => ({ msg: m, rec: hub.find(m.tool_call_id) }))
    .filter((x) => x.rec);

  if (backfills.length) {
    const jamId = backfills[0].rec.jamId;
    // 调用方这一轮可能只回传了 role:tool（有的客户端不带 tools），
    // syncScope 会在声明为空时沿用这个 jam 之前的声明，避免中途丢失映射
    syncScope(jamId, body);
    // 先拿基线，再灌结果：否则云端被我们唤醒后新产出的事件会被算进基线，看不到
    const cursor = await (async () => {
      const events = await listEvents(jamId, 300).catch(() => []);
      return eventCursor(events);
    })();

    const settled = new Set();
    const outputs = [];
    for (const { msg, rec } of backfills) {
      const raw = msg.content;
      const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((c) => c?.text || '').join('\n') : String(raw ?? '');
      hub.settle(msg.tool_call_id, { text, isError: msg.is_error === true });
      settled.add(msg.tool_call_id);
      // 空输出也是合法结果（比如 mkdir 成功但没打印任何东西），
      // 必须照样进汇总，否则这一轮不会被唤醒，线程就停在 waiting 上了。
      outputs.push(text.trim() || '(没有输出)');
      log('回填', msg.tool_call_id, '|', text.length, 'chars', '| jam', rec.jamId);
    }

    // 同一轮里还有一些调用没被客户端执行（比如它只回了一条）：别让设备端干等到超时，
    // 直接判失败，模型看到错误会重新发一次。
    for (const p of hub.listPending()) {
      if (p.jamId !== jamId || !p.toolCallId || settled.has(p.toolCallId)) continue;
      hub.fail(p.toolCallId, '这个调用没有被调用方执行，请重新发起。');
      log('丢弃', p.toolCallId, '| 调用方没有回传结果');
    }

    const nudge = {
      text:
        '【工具结果】命令已经在调用方自己的电脑上执行完毕，输出如下：\n' +
        '```\n' +
        outputs.join('\n\n') +
        '\n```\n' +
        '请基于这个输出继续。如果任务已经完成，直接用 message_user 给出最终回答。',
      sent: false,
    };

    // 线程已经卡在 waiting 上就直接叫醒，别等 followBreakpoint 空等十几秒
    {
      const resumed = await resumeIfStuck(jamId, nudge.text, ctx.model).catch((err) => {
        log('唤醒失败', jamId, '|', err.message);
        return null;
      });
      if (resumed) return runToBreakpoint(res, { ...ctx, body, jamId, cursor: resumed, nudge: { ...nudge, sent: true }, sse: ctx.sse });
    }

    return runToBreakpoint(res, { ...ctx, body, jamId, cursor, nudge, sse: ctx.sse });
  }

  const unknownTool = msgs.find((m) => m && m.role === 'tool' && m.tool_call_id && !hub.find(m.tool_call_id));
  if (unknownTool) log('回填', unknownTool.tool_call_id, '| 找不到对应会话，改为重新发起');

  let prompt;
  try {
    prompt = flattenMessages(msgs, ctx.model, { clientTools: true });
  } catch (err) {
    return oaiError(res, err.status || 400, err.message);
  }

  if (prompt.length > LIMITS.maxPromptChars) {
    return oaiError(
      res,
      400,
      `拼出来的对话有 ${prompt.length} 字符，超过上限 ${LIMITS.maxPromptChars}。请压缩会话（删掉旧消息或先做摘要）再请求。`,
      'context_too_long',
    );
  }

  let jamId;
  try {
    const created_ = await createJam({ prompt, model: ctx.model, workspace: workspaceSpec(), title: prompt.slice(0, 60).replace(/\s+/g, ' ') });
    jamId = created_.jamId;
    syncScope(jamId, body);
    log('jam', jamId, '| client-tools | model', ctx.model, '|', prompt.length, 'chars');
  } catch (err) {
    const localAuthIssue = ['no_auth', 'session_expired', 'no_device'].includes(err.code);
    const status =
      localAuthIssue || ['client_offline', 'device_offline', 'client_signed_out'].includes(err.code) ? 503 : err.status || 502;
    return oaiError(res, status, await describeUpstreamError(err), localAuthIssue ? err.code : status === 403 ? 'account_suspended' : 'upstream_error');
  }
  // 新线程里不该有历史事件，基线给空，任何事件都算新增
  return runToBreakpoint(res, { ...ctx, body, jamId, cursor: emptyCursor() });
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return oaiError(res, err.status || 400, err.message);
  }

  const { id: model, aliasOf } = resolveModel(body.model);
  const stream = !!body.stream;
  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const showTools = pickShowTools(req, body);
  if (aliasOf) log('model alias', aliasOf, '->', model);

  // 先把流开出来。建线程要等云端调度（实测 5~8 秒），客户端这段时间至少能看到
  // 连接已建立 + role 帧，而不是盯着空白等一大坨。
  const sse = stream ? openSse(res, { id, created, model }) : null;

  // 外抛模式：工具交给调用方执行。请求头 x-capy-exec 可覆盖配置，方便同一份服务里区分自己和别人。
  const execHeader = String(req.headers['x-capy-exec'] || '').toLowerCase();
  const configuredClientTools = cfg.execMode === 'client' || cfg.clientTools === true;
  const wantClientTools =
    execHeader === 'client' ? true : execHeader === 'local' || execHeader === 'none' ? false : configuredClientTools;
  if (wantClientTools) {
    const names = (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.function?.name).filter(Boolean);
    log('client-tools | model', model, '| client tools:', names.join(',') || 'none');
    return handleChatClientTools(req, res, body, { id, created, model, stream, sse });
  }

  let prompt;
  try {
    prompt = flattenMessages(body.messages, model);
  } catch (err) {
    return oaiError(res, err.status || 400, err.message);
  }

  // 先建线程：这一步失败还能干净地回 JSON 错误，而不是半截流
  let jamId;
  try {
    const created_ = await createJam({
      prompt,
      model,
      workspace: workspaceSpec(),
      title: prompt.slice(0, 60).replace(/\s+/g, ' '),
    });
    jamId = created_.jamId;
    log('jam', jamId, '| model', model, '| prompt', prompt.length, 'chars');
  } catch (err) {
    const localAuthIssue = ['no_auth', 'session_expired', 'no_device'].includes(err.code);
    const status =
      localAuthIssue || ['client_offline', 'device_offline', 'client_signed_out'].includes(err.code) ? 503 : err.status || 502;
    return oaiError(
      res,
      status,
      await describeUpstreamError(err),
      localAuthIssue ? err.code : status === 503 ? 'service_unavailable' : status === 403 ? 'account_suspended' : 'upstream_error',
    );
  }

  if (!stream) {
    try {
      const result = await followJam({ jamId, timeoutMs: cfg.timeoutMs, expectModel: cfg.strictModel ? model : null });
      if (result.error && !result.text) {
        return oaiError(res, 400, result.error.message, result.error.code);
      }
      if (cfg.archive) archiveJam(jamId).catch(() => {});
      const content = (result.text || '') + (showTools ? traceBlock(result.tools) : '');
      log('tools', jamId, '|', result.tools.map((t) => t.name).join(',') || 'none', '| served', result.servedModel);
      return sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: result.usage?.inputTokens ?? 0,
          completion_tokens: result.usage?.outputTokens ?? 0,
          total_tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        },
        // 非标准字段：这些工具是 Capy 在本机真实执行过的，客户端不认也无害
        capy: { jamId, tools: result.tools, servedModel: result.servedModel, requestedModel: body.model || model, resolvedModel: model, elapsedMs: result.elapsedMs },
      });
    } catch (err) {
      if (err.code === 'model_substituted') return oaiError(res, 400, modelSubstitutedMessage(err), 'model_not_available');
      return oaiError(res, 502, err.message, 'upstream_error');
    }
  }

  // ---- 流式 ----（头已经开好了，这里直接发增量）
  const sendChunk = sse;

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  // 已经吐给客户端的正文。realtime 和兜底轮询都按这个对齐，避免同一段发两遍。
  let emitted = '';
  const emitText = (text) => {
    if (!text || closed) return;
    emitted += text;
    sendChunk({ content: text });
  };
  const emitReasoning = (text) => {
    if (!text || closed) return;
    sendChunk({ reasoning_content: text });
  };

  // 逐字增量走 realtime；拿不到就靠下面的 followJam 轮询兜底
  const useRealtime = cfg.realtime !== false && !process.env.CAPY_NO_REALTIME;
  const rt = useRealtime
    ? openJamStream({
        jamId,
        onText: emitText,
        onReasoning: emitReasoning,
        onTool: (info) => {
          if (info?.phase === 'turn-start') log('stream', jamId, '| realtime 回合开始');
        },
        shouldStop: () => closed,
        log: (...a) => log(...a),
      })
    : null;

  try {
    const result = await followJam({
      jamId,
      timeoutMs: cfg.timeoutMs,
      shouldStop: () => closed,
      expectModel: cfg.strictModel ? model : null,
      // 轮询给的是「累计全文」：只补 realtime 还没吐出来的尾巴
      onDelta: (_delta, combined) => {
        if (typeof combined !== 'string' || !combined) return;
        if (combined.startsWith(emitted)) return emitText(combined.slice(emitted.length));
        // 前缀对不上（通常是首尾空白差异）：只在还没吐过任何正文时整段补发
        if (!emitted) return emitText(combined);
        log('stream', jamId, '| realtime 与轮询文本不一致，跳过补偿', emitted.length, combined.length);
      },
    });
    if (result.error && !result.text) {
      sendChunk({ content: `\n\n[上游错误] ${result.error.message}` });
    }
    if (showTools) {
      const trace = traceBlock(result.tools);
      if (trace) sendChunk({ content: trace });
    }
    sendChunk({}, 'stop');
    res.write('data: [DONE]\n\n');
    log('done', jamId, '|', result.text.length, 'chars |', result.elapsedMs, 'ms | tools:', result.tools.map((t) => t.name).join(',') || 'none', '| served', result.servedModel);
  } catch (err) {
    const note = err.code === 'model_substituted' ? modelSubstitutedMessage(err) : `[中断] ${err.message}`;
    sendChunk({ content: `\n\n${note}` });
    sendChunk({}, 'stop');
    res.write('data: [DONE]\n\n');
  } finally {
    rt?.close();
    res.end();
    if (cfg.archive) archiveJam(jamId).catch(() => {});
  }
}

// 单个请求出岔子不该把整个中转站带走
process.on('unhandledRejection', (err) => log('未处理的异常：', err?.message || err));
process.on('uncaughtException', (err) => log('未捕获的异常：', err?.message || err));

// ---------------- 启动 ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  // 设备端把 invocation 挂过来：这条请求会一直挂着，直到调用方执行完才返回。
  // 只允许本机，且不走 localKey（设备端进程不带密钥）。
  if (p === '/internal/hold' && req.method === 'POST') {
    const remote = req.socket.remoteAddress || '';
    if (!/^(127\.|::1|::ffff:127\.)/.test(remote)) return oaiError(res, 403, 'forbidden');
    let payload = {};
    try {
      payload = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad json' });
    }
    const { invocationId, handler, params, cwd } = payload;
    if (!invocationId) return sendJson(res, 400, { ok: false, error: 'invocationId 缺失' });

    let hit = await matchToolUse({ cwd, handler, params });
    if (!hit) {
      await new Promise((r) => setTimeout(r, 900));
      hit = await matchToolUse({ cwd, handler, params });
    }
    if (!hit) {
      // 不是模型要的工具调用（云端自己的准备脚本），让设备端老老实实本地跑
      return sendJson(res, 200, { ok: true, forward: false });
    }

    // 这条 handler 能不能交给调用方，取决于它声明了什么工具、tool_choice 是什么。
    // 声明里没有对应工具就别硬发 —— 客户端认不出这个名字，只会回一个「未知工具」错误。
    // scope 缺失（比如 relay 中途重启过）时退回老行为：只外抛 bash。
    const scope = getJamCtx(hit.jamId, null);

    if (!scope) {
      // 老行为兜底：relay 中途重启过，jam 上下文丢了，只外抛 bash
      if (handler !== 'bash') {
        logOnce(`local:${handler}`, `  · ${handler} 没有 jam 上下文，本机执行`);
        return sendJson(res, 200, { ok: true, forward: false });
      }
    } else if (scope.choice?.mode === 'none') {
      // tool_choice=none：调用方明确说这轮不要工具。模型硬要调就如实拒绝，
      // 它拿到失败会改用文本回答 —— 既不在本机跑，也不发给调用方。
      return sendJson(res, 200, {
        ok: false,
        error: '本轮 tool_choice=none，不允许调用工具。请直接用文本回答，不要执行命令。',
      });
    } else if (!scope.clientTools.length) {
      // 共享端点下绝不偷偷在本机执行调用方的命令，宁可如实拒绝
      return sendJson(res, 200, {
        ok: false,
        error: '调用方这次请求没有声明任何工具，命令不会在服务端执行。请声明一个执行类工具（如 execute_command）后重试。',
      });
    } else if (!forwardableHandlers(scope).includes(handler)) {
      // 声明了工具，但没有能承接这一类的那一个：也不能退回本机
      const mapped = matchClientTool(toolKindOf(handler), scope.clientTools);
      return sendJson(res, 200, {
        ok: false,
        error: mapped
          ? `本轮不允许调用 ${mapped.name}（tool_choice / parallel 限制），${handler} 没有执行。`
          : `调用方没有声明能承接 ${handler} 的工具，这条没有执行。需要就加上 read_file / write_file / execute_command 这类工具。`,
      });
    }

    let replied = false;
    const reply = (out) => {
      if (replied) return;
      replied = true;
      if (!res.writableEnded) sendJson(res, 200, out);
    };
    hub.hold(
      {
        invocationId,
        handler,
        params,
        cwd,
        toolCallId: hit.block.toolCallId,
        jamId: hit.jamId,
        args: hit.block.args || {},
      },
      reply,
    );
    req.on('close', () => {
      if (!replied) hub.drop(invocationId, '设备端连接已断开');
    });
    return;
  }

  if (cfg.localKey) {
    const auth = req.headers.authorization || '';
    const key = auth.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
    if (key !== cfg.localKey) return oaiError(res, 401, '本地密钥不匹配（config.json 里的 localKey）', 'authentication_error');
  }

  try {
    if (p === '/health' && req.method === 'GET') return handleHealth(res);
    if ((p === '/v1/models' || p === '/models') && req.method === 'GET') return handleModels(res);
    if ((p === '/v1/chat/completions' || p === '/chat/completions') && req.method === 'POST') return await handleChat(req, res);
    if (p === '/v1' || p === '/') return sendJson(res, 200, { ok: true, endpoints: ['/v1/models', '/v1/chat/completions', '/health'] });
    return oaiError(res, 404, `没有这个路由：${p}`);
  } catch (err) {
    log('error', err.message);
    return oaiError(res, 500, err.message);
  }
});

server.on('error', (err) => {  if (err.code === 'EADDRINUSE') {
    log(`端口 ${cfg.port} 已被占用：可能已经有一个 capy-relay 在跑了。`);
    log(`先关掉旧的那个，或改 config.json 里的 port。`);
    process.exit(1);
  }
  log('服务出错：', err.message);
  process.exit(1);
});

server.listen(cfg.port, cfg.host, async () => {
  log(`capy-relay 已启动  http://${cfg.host}:${cfg.port}/v1`);
  log(`默认模型 ${cfg.defaultModel}，目录 ${catalog.length} 个模型`);
  try {
    const { loadAuth, loadDevice } = await import('./lib/auth.js');
    const a = loadAuth();
    const d = loadDevice();
    if (a && d?.deviceId) {
      log(`上游 = 你的 Capy 账号（自持登录）；设备 ${d.deviceId}，不需要桌面客户端`);
    } else if (d?.deviceId) {
      log(`⚠ 设备已绑定，但还没有登录账号：先运行 node login.js login`);
    } else {
      log(`上游 = 本机 Capy 桌面客户端（需保持客户端在线）`);
    }
  } catch {
    log(`上游 = 本机 Capy 桌面客户端`);
  }
});
