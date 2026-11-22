// Capy 桌面客户端的桥：取它自己的登录态，用它自己的接口，跑在「这台电脑」上。
import { randomUUID } from 'node:crypto';

const CDP_PORT = Number(process.env.CAPY_CDP_PORT || 9333);
const APP_BASE = process.env.CAPY_APP_BASE || 'https://api.capy.ai/app';

// 客户端自己会带的标识头。少了这三个，上游会把我们当「第三方」，把带广告的免费模型拒掉
// （错误原文：is free because it shows ads in the Capy web and desktop app）。
const APP_HEADERS = {
  'x-capy-client-surface': 'desktop',
  'x-capy-client-features': 'message-edit,visual,ads-models',
};
let clientId = null;

// ---------- ULID ----------
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid() {
  let t = Date.now();
  let head = '';
  for (let i = 9; i >= 0; i -= 1) {
    head = B32[t % 32] + head;
    t = Math.floor(t / 32);
  }
  let tail = '';
  for (let i = 0; i < 16; i += 1) tail += B32[Math.floor(Math.random() * 32)];
  return head + tail;
}

// ---------- 通过 CDP 找客户端的页面 ----------
async function pageTarget() {
  let list;
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    list = await res.json();
  } catch {
    const err = new Error(
      '连不上 Capy 桌面客户端。请用 start.bat 启动（它会带上调试端口），或确认客户端已登录并保持运行。',
    );
    err.code = 'client_offline';
    throw err;
  }
  const page = list.find((t) => t.type === 'page' && /capy:\/\//.test(t.url));
  if (!page) {
    const err = new Error('客户端没有打开的窗口，请先打开 Capy 主窗口。');
    err.code = 'client_offline';
    throw err;
  }
  return page;
}

function evaluate(ws, expression, id = 1) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (m.error) return reject(new Error(m.error.message));
      if (m.result?.exceptionDetails) {
        return reject(new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text));
      }
      resolve(m.result?.result?.value);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

// ---------- 会话（令牌 + 组织 + 设备）----------
let sessionCache = { value: null, at: 0 };

// 自持登录：本地已有会话与设备注册时，完全不碰桌面客户端
async function localSession() {
  const auth = await import('./auth.js');
  const saved = auth.loadAuth();
  const dev = auth.loadDevice();
  if (!saved) {
    // 已经绑定成本机独立执行端，却没登录：别再让用户去开客户端
    if (dev?.deviceId) {
      const err = new Error('这台机器已绑定为独立执行端，但还没有登录 Capy 账号：请运行 node login.js login');
      err.code = 'no_auth';
      throw err;
    }
    return null;
  }
  if (!dev?.deviceId) {
    const err = new Error('已登录但还没有注册执行设备：运行 node login.js enroll');
    err.code = 'no_device';
    throw err;
  }

  const jwt = await auth.getJwt();
  const claims = auth.jwtClaims(jwt);
  const orgId = dev.orgId || saved.orgId;
  if (!orgId) {
    const err = new Error('登录了但还不知道组织 ID，请跑一次 node login.js enroll');
    err.code = 'no_org';
    throw err;
  }
  return {
    token: jwt,
    userId: claims.sub || saved.userId,
    exp: claims.exp,
    orgId,
    deviceId: dev.deviceId,
    deviceName: dev.name || 'this pc',
    orgs: [orgId],
    source: 'local',
  };
}

export async function session({ force = false } = {}) {
  if (!force && sessionCache.value && Date.now() - sessionCache.at < 25_000) return sessionCache.value;

  // 优先用自己保存的登录态；没有再退回客户端
  const local = await localSession().catch((err) => {
    if (err.code === 'no_auth' || err.code === 'session_expired') {
      const e = new Error(err.message);
      e.code = err.code;
      throw e;
    }
    throw err;
  });
  if (local) {
    sessionCache = { at: Date.now(), value: local };
    return local;
  }

  const page = await pageTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('连不上客户端调试端口'));
  });
  let value;
  try {
    value = await evaluate(
      ws,
      `(async()=>{
        const token = await window.capyDesktop.session.token();
        const state = await window.capyDesktop.session.state();
        const device = await window.capyDesktop.device.state();
        return JSON.stringify({ token, state, device });
      })()`,
    );
  } finally {
    ws.close();
  }

  const raw = JSON.parse(value);
  if (!raw.token || raw.state?.status !== 'signed-in') {
    const err = new Error('客户端未登录，请先在 Capy 桌面客户端里登录。');
    err.code = 'client_signed_out';
    throw err;
  }
  const orgs = raw.device?.state?.orgs ?? [];
  const connected = orgs.filter((o) => o.entry?.state === 'connected');
  const jwt = raw.token;
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

  // 组织/设备不一定非得靠客户端「正在连着」才知道：
  // 自建 device worker 接管通道时，客户端会显示 connecting，但设备的身份没变。
  let orgId = connected[0]?.orgId;
  let deviceId = connected[0]?.entry?.deviceId;
  if (!orgId) {
    try {
      const { readCredentials } = await import('./credentials.js');
      const creds = readCredentials();
      const [id, entry] = Object.entries(creds)[0] || [];
      if (id && entry) {
        orgId = id;
        deviceId = entry.deviceId;
      }
    } catch {}
  }
  if (!orgId) orgId = orgs.find((o) => o.entry?.deviceId)?.orgId;
  if (!deviceId) deviceId = orgs.find((o) => o.entry?.deviceId)?.entry?.deviceId;

  if (!orgId || !deviceId) {
    const err = new Error('找不到这台机器的设备身份，请先在 Capy 客户端里登录并连接一次。');
    err.code = 'device_offline';
    throw err;
  }

  sessionCache = {
    at: Date.now(),
    value: {
      token: jwt,
      userId: claims.sub,
      exp: claims.exp,
      orgId,
      deviceId,
      deviceName: raw.device?.identity?.hostname || 'this pc',
      orgs: orgs.length ? orgs.map((o) => o.orgId) : [orgId],
    },
  };
  return sessionCache.value;
}

// ---------- 设备能力（能不能跑命令，全看这个）----------
let deviceCache = { value: null, at: 0 };

export async function deviceInfo({ force = false } = {}) {
  if (!force && deviceCache.value && Date.now() - deviceCache.at < 20_000) return deviceCache.value;

  const page = await pageTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('连不上客户端调试端口'));
  });
  let raw;
  try {
    raw = await evaluate(
      ws,
      `(async()=>{
        const out = {};
        try { out.gitBash = await window.capyDesktop.device.gitBash(); } catch (e) { out.gitBash = 'ERR ' + e.message; }
        try { out.device = await window.capyDesktop.device.state(); } catch (e) { out.device = null; }
        return JSON.stringify(out);
      })()`,
    );
  } finally {
    ws.close();
  }
  const data = JSON.parse(raw);
  const git = data.gitBash;
  deviceCache = {
    at: Date.now(),
    value: {
      // Capy 的 bash 工具依赖 Git for Windows；拿不到时 agent 只能读写文件，不能执行命令
      gitBash: git === true || (typeof git === 'string' && git.length > 0),
      gitBashRaw: git,
      daemon: data.device?.state?.daemon || null,
      os: data.device?.state?.identity?.os || null,
      linkedFolders: data.device?.state?.linkedFolders ?? 0,
    },
  };
  return deviceCache.value;
}

// ---------- 应用内 API ----------
export async function call(path, init = {}, { retry = true } = {}) {
  const s = await session();
  if (!clientId) clientId = `relay${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const res = await fetch(`${APP_BASE}${path}`, {
    ...init,
    headers: {
      ...APP_HEADERS,
      'x-capy-client-id': clientId,
      authorization: `Bearer ${s.token}`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (res.status === 401 && retry) {
    sessionCache = { value: null, at: 0 };
    return call(path, init, { retry: false });
  }
  if (!res.ok) {
    const err = new Error(typeof body === 'object' && body?.message ? body.message : `上游返回 ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---------- 建线程（无项目，落在本机）----------
// workspace 两种：
//   { kind: 'worktree' }                     让设备现场开 git worktree（需要设备端实现整套 worktree/git 侧写）
//   { kind: 'linked', root, roots: [root] }  直接用一个已有文件夹当工作区（跳过 worktree 准备）
export async function createJam({ prompt, model, title, workspace }) {
  const s = await session();
  const jamId = `jam_${ulid()}`;
  const ws =
    workspace && workspace.kind === 'linked' && workspace.root
      ? { kind: 'linked', root: workspace.root, roots: workspace.roots || [workspace.root] }
      : { kind: 'worktree' };
  const body = {
    jamId,
    requestId: `relay_${randomUUID()}`,
    message: prompt,
    model: model ? { modelId: model } : undefined,
    device: { deviceId: s.deviceId, workspace: ws },
    clientSurface: 'desktop',
    clientFeatures: ['message-edit', 'visual', 'ads-models'],
    ...(title ? { title: String(title).slice(0, 120) } : {}),
  };
  const jam = await call(`/orgs/${s.orgId}/jams`, { method: 'POST', body: JSON.stringify(body) });
  return { jamId: jam?.id || jamId, jam };
}

export async function getJam(jamId) {
  const s = await session();
  return call(`/orgs/${s.orgId}/jams/${jamId}`);
}

export async function listEvents(jamId, limit = 500) {
  const s = await session();
  const data = await call(`/orgs/${s.orgId}/jams/${jamId}/events?limit=${limit}`);
  return data.items ?? data ?? [];
}

export async function archiveJam(jamId) {
  const s = await session();
  await call(`/orgs/${s.orgId}/jams/archive`, { method: 'POST', body: JSON.stringify({ jamIds: [jamId] }) });
}

// 往一个已经在跑的线程里补一条用户消息（等价于「用户接着说了一句」）。
// 用途：云端把慢调用转成后台 operation 后，模型有时会卡在 wait 上不动了，
// 这时把命令输出当成新输入推回去，线程就会从 waiting 回到 working 继续跑。
export async function sendJamMessage(jamId, text, { model = null } = {}) {
  const s = await session();
  const body = { text, ...(model ? { model: { modelId: model } } : {}) };
  return call(`/orgs/${s.orgId}/jams/${jamId}/message`, { method: 'POST', body: JSON.stringify(body) });
}

// ---------- 从事件里取出助手说的话 ----------
// 一轮里可能同时有「可见文本块」和「message_user 终稿」，只取终稿，避免重复一遍。
const TOOL_ARG_KEYS = ['command', 'cmd', 'path', 'file', 'pattern', 'query', 'url', 'prompt'];

function briefArgs(args) {
  if (!args || typeof args !== 'object') return '';
  for (const k of TOOL_ARG_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim().slice(0, 140);
  }
  let s;
  try {
    s = JSON.stringify(args);
  } catch {
    return '';
  }
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

export function collectText(events) {
  const seenTools = new Set();
  const seenCalls = new Set();
  const msgs = [];
  const texts = [];
  const tools = [];
  let usage = null;
  let error = null;

  for (const evt of events) {
    if (evt.kind === 'assistant' && Array.isArray(evt.payload?.blocks)) {
      if (evt.payload.usage) usage = evt.payload.usage;
      for (const block of evt.payload.blocks) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          texts.push(block.text.trim());
        }
        if (block.type === 'tool_use' && block.toolName === 'message_user') {
          const text = block.args?.text;
          if (typeof text === 'string' && text.trim() && !seenTools.has(block.toolCallId)) {
            seenTools.add(block.toolCallId);
            msgs.push(text.trim());
          }
        }
        // 其余工具调用（bash / read / write / execute …）只做记录，不当作回复
        if (block.type === 'tool_use' && block.toolName && block.toolName !== 'message_user') {
          const key = block.toolCallId || `${block.toolName}:${briefArgs(block.args)}`;
          if (!seenCalls.has(key)) {
            seenCalls.add(key);
            tools.push({ name: block.toolName, arg: briefArgs(block.args) });
          }
        }
      }
    }
    if (evt.kind === 'error' && !error) {
      error = {
        code: evt.payload?.code || 'upstream_error',
        message: evt.payload?.message || '上游报错',
        retryable: !!evt.payload?.retryable,
      };
    }
  }

  return {
    msg: msgs.join('\n\n'),
    textBlocks: texts.join('\n\n'),
    // 终稿优先；没有终稿（比如报错退出）才退回可见文本
    combined: (msgs.length ? msgs.join('\n\n') : texts.join('\n\n')).trim(),
    tools,
    usage,
    error,
  };
}

// ---------- 等一轮跑完 ----------
export async function runJam({ prompt, model, timeoutMs = 180000, onDelta, shouldStop }) {
  const { jamId } = await createJam({ prompt, model, title: prompt.slice(0, 60).replace(/\s+/g, ' ') });
  return followJam({ jamId, timeoutMs, onDelta, shouldStop });
}

export async function followJam({ jamId, timeoutMs = 180000, onDelta, shouldStop, expectModel = null }) {  const startedAt = Date.now();
  let emitted = '';
  let finalText = '';
  let usage = null;
  let error = null;
  let tools = [];
  let servedModel = null;
  let status = 'working';
  let stopEarly = false;
  let sawActivity = false;

  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (shouldStop?.()) {
        const err = new Error('客户端已断开');
        err.code = 'aborted';
        throw err;
      }
      await new Promise((r) => setTimeout(r, 450));

      const [events, jam] = await Promise.all([listEvents(jamId), getJam(jamId)]);
      const collected = collectText(events);
      usage = collected.usage || usage;
      error = collected.error || error;
      if (collected.tools.length) tools = collected.tools;

      // 上游会把「账号没权限的模型」静默换成 particle-1，界面看不出来，只能靠这里的 servedModel 拆穿
      const served = jam?.servedModel?.modelId || null;
      if (served) servedModel = served;
      if (expectModel && served && served !== expectModel) {
        const err = new Error(`上游实际用的是 ${served}，不是你选的 ${expectModel}`);
        err.code = 'model_substituted';
        err.servedModel = served;
        err.requestedModel = expectModel;
        stopEarly = true;
        throw err;
      }

      const target = collected.combined;
      if (target) finalText = target;
      if (target.length > emitted.length && target.startsWith(emitted)) {
        const delta = target.slice(emitted.length);
        emitted = target;
        onDelta?.(delta, emitted);
      }

      status = jam?.status || status;
      // jam 刚建好时本来就是 idle，真正起跑要等云端调度（约 3~8 秒）。
      // 所以「没任何活动」时不能急着判结束，否则会把还没启动的 run 归档掉。
      if (status === 'working' || collected.combined || collected.tools.length) sawActivity = true;
      const terminal = status === 'idle' || status === 'failed' || status === 'waiting';
      if (terminal && (emitted || error)) break;
      if (terminal && Date.now() - startedAt > (sawActivity ? 4000 : 15000)) break;
    }
  } finally {
    if (status !== 'working' || stopEarly) {
      // 跑完就归档，免得侧栏被这些一次性会话塞满
      archiveJam(jamId).catch(() => {});
    }
  }

  return { jamId, text: finalText || emitted, tools, usage, error, servedModel, status, elapsedMs: Date.now() - startedAt };
}

// ---------- 跑到一个「断点」就停：要么模型要调外部工具，要么它说完了 ----------
// 用于把 Capy 的 agent 循环切成一个个 OpenAI 的回合。
const seenToolUse = new Map(); // jamId -> Set(toolCallId)

export function forgetJamState(jamId) {
  seenToolUse.delete(jamId);
}

export function seenToolCalls(jamId) {
  return seenToolUse.get(jamId) || new Set();
}

// ---------- 事件游标 ----------
// 不能用「事件条数」当基线：listEvents 有上限，一旦超过上限，条数就恒等于上限，
// slice(基线) 永远是空数组，回填之后就会一直看不到新增事件（表现为模型「不动了」）。
// 改成认事件 id：取一份 id 快照，之后凡是 id 不在快照里的就是新增的。
export function eventKey(evt) {
  if (evt?.id) return `i:${evt.id}`;
  if (typeof evt?.seq === 'number') return `s:${evt.seq}`;
  return null;
}

export function eventCursor(events = []) {
  const ids = new Set();
  for (const evt of events) {
    const k = eventKey(evt);
    if (!k) return { ids: null, count: events.length };
    ids.add(k);
  }
  return { ids, count: events.length };
}

export const emptyCursor = () => ({ ids: new Set(), count: 0 });

export function freshSince(events = [], cursor) {
  if (!cursor) return events;
  if (cursor.ids) return events.filter((evt) => !cursor.ids.has(eventKey(evt) || ''));
  return events.slice(Math.min(cursor.count || 0, events.length));
}

export async function snapshotCursor(jamId, limit = 300) {
  const events = await listEvents(jamId, limit).catch(() => []);
  return eventCursor(events);
}

export async function followBreakpoint({
  jamId,
  timeoutMs = 180000,
  onDelta,
  shouldStop,
  expectModel = null,
  execTools = ['bash'],
  cursor = null,
  afterCount = null,
}) {
  const startedAt = Date.now();
  if (!seenToolUse.has(jamId)) seenToolUse.set(jamId, new Set());
  const seen = seenToolUse.get(jamId);

  // 只看「本次调用之后新增的事件」：jam 里还留着上一轮的对话，
  // 如果把历史也算进来，回填结果的那一轮会立刻被判定为「已经说完」。
  let base = cursor;
  if (!base) base = afterCount == null ? await snapshotCursor(jamId) : { ids: null, count: afterCount };

  let emitted = '';
  let tools = [];
  let status = 'working';
  let sawActivity = false;
  let usage = null;
  let servedModel = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (shouldStop?.()) {
      const err = new Error('客户端已断开');
      err.code = 'aborted';
      throw err;
    }
    await new Promise((r) => setTimeout(r, 400));

    const [events, jam] = await Promise.all([listEvents(jamId, 300), getJam(jamId)]);
    const fresh = freshSince(events, base);
    const collected = collectText(fresh);
    if (collected.usage) usage = collected.usage;
    if (collected.tools.length) tools = collected.tools;

    const served = jam?.servedModel?.modelId || null;
    if (served) servedModel = served;
    if (expectModel && served && served !== expectModel) {
      const err = new Error(`上游实际用的是 ${served}，不是你选的 ${expectModel}`);
      err.code = 'model_substituted';
      err.servedModel = served;
      err.requestedModel = expectModel;
      throw err;
    }

    // 本轮新增的工具调用：交给调用方去跑。
    // 同一个 assistant 事件里可能有多个 tool_use（模型并行发起），
    // 它们属于同一轮，必须一起交出去 —— 只给第一个的话，
    // 剩下的会让设备端一直挂着等不到结果。
    for (const evt of fresh) {
      if (evt.kind !== 'assistant') continue;
      const blocks = evt.payload?.blocks || [];

      // message_user 是它「把话说完」的明确信号，只有这个才算终稿
      const said = blocks.find(
        (b) => b.type === 'tool_use' && b.toolName === 'message_user' && typeof b.args?.text === 'string' && b.args.text.trim(),
      );
      if (said && !seen.has(`msg:${said.toolCallId}`)) {
        seen.add(`msg:${said.toolCallId}`);
        return {
          type: 'final',
          jamId,
          text: said.args.text.trim(),
          tools,
          usage,
          servedModel,
          status: 'idle',
          elapsedMs: Date.now() - startedAt,
        };
      }

      const calls = [];
      for (const block of blocks) {
        if (block.type !== 'tool_use' || !block.toolCallId) continue;
        if (block.toolName === 'message_user') continue;
        if (seen.has(block.toolCallId)) continue;
        seen.add(block.toolCallId);
        if (!execTools.includes(block.toolName)) continue;
        calls.push({ toolCallId: block.toolCallId, toolName: block.toolName, args: block.args || {} });
      }
      if (calls.length) {
        return {
          type: 'tool_call',
          jamId,
          calls,
          // 兼容旧字段：取第一条
          toolCallId: calls[0].toolCallId,
          toolName: calls[0].toolName,
          args: calls[0].args,
          textSoFar: collected.combined || '',
          tools,
          usage,
          servedModel,
          elapsedMs: Date.now() - startedAt,
        };
      }
    }

    const target = collected.combined;
    if (target) {
      if (target.length > emitted.length && target.startsWith(emitted)) {
        onDelta?.(target.slice(emitted.length), target);
        emitted = target;
      } else if (!emitted) {
        emitted = target;
      }
    }
    if (fresh.length) sawActivity = true;

    status = jam?.status || status;
    // 云端把慢命令转成后台 operation 后，模型会先「等一下」再继续，
    // 这段时间没有文本是正常的，不能当成结束，否则会把还在跑的线程归档掉。
    if (terminal(status) && collected.combined) break;
    if (terminal(status) && Date.now() - startedAt > (sawActivity ? 12000 : 20000)) break;
  }

  return {
    type: 'final',
    jamId,
    text: emitted,
    tools,
    usage,
    servedModel,
    status,
    elapsedMs: Date.now() - startedAt,
  };
}

function terminal(status) {
  return status === 'idle' || status === 'failed' || status === 'waiting';
}
