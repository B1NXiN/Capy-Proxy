// 本机设备 worker：不启动桌面客户端，直接连 Capy 的设备通道，替它执行工具调用
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveDeviceIdentity } from './lib/auth.js';
import { createDevice, bashInfo } from './lib/device.js';
import { handleGitRoute } from './lib/gitvm.js';
import { shapeResult } from './lib/oaitools.js';
import { Tunnel } from './lib/tunnel.js';

const TUNNEL_URL = process.env.CAPY_TUNNEL_URL || 'wss://device-tunnel-production.cloud.capy.ai/tunnel';
const RELAY_URL = process.env.CAPY_RELAY_URL || `http://127.0.0.1:${process.env.CAPY_RELAY_PORT || 8787}`;
const WAIT_MS = Number(process.env.CAPY_CLIENT_TOOL_WAIT_MS || 300000);

// 执行模式统一由 config.json 的 execMode 决定，环境变量可临时覆盖：
//   local  —— 就在这台机器上跑（自己用）
//   client —— 把命令交给调用方，在他们自己的电脑上跑（开中转站给别人用时）
//   none   —— 拒绝一切执行，只出模型
let fileExecMode = 'local';
try {
  fileExecMode = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8')).execMode || 'local';
} catch {}
const EXEC_MODE = String(process.env.CAPY_EXEC || fileExecMode).toLowerCase();

const stamp = () => new Date().toTimeString().slice(0, 8);

// 日志同时落盘：以前只打在窗口里，窗口一关现场就没了，
// 出了问题只能靠回忆「好像一直在刷屏」。现在直接看 data/logs/worker-YYYY-MM-DD.log。
let logStream = null;
try {
  const dir = new URL('./data/logs/', import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  logStream = fs.createWriteStream(new URL(`worker-${day}.log`, dir), { flags: 'a' });
  logStream.on('error', () => {
    logStream = null;
  });
} catch {}

const log = (...a) => {
  const fmt = (x) => {
    if (typeof x === 'string') return x;
    try {
      return JSON.stringify(x);
    } catch {
      return String(x);
    }
  };
  const line = `[${stamp()}] ${a.map(fmt).join(' ')}`;
  console.log(line);
  try {
    logStream?.write(line + '\n');
  } catch {}
};

// 准备阶段云端会一秒一次地轮询同样的 handler，日志只按 3 秒去重，免得刷屏
const recent = new Map();
function logOnce(key, ...args) {
  const now = Date.now();
  if (now - (recent.get(key) || 0) < 3000) return;
  recent.set(key, now);
  log(...args);
}

let identity;
try {
  identity = await resolveDeviceIdentity();
} catch (err) {
  console.error('✗', err.message);
  process.exit(1);
}
const orgId = identity.orgId;
const entry = { deviceId: identity.deviceId, secret: identity.secret };

const root = path.join(os.homedir(), '.capy', 'worktrees');
const device = createDevice({ root, log });
const shell = bashInfo();

log('设备', entry.deviceId, '| 组织', orgId, '| 来源', identity.source);
log('执行器', shell.path ? `Git Bash: ${shell.path}（${shell.via}）` : '未找到 Git Bash（只能读写文件）');

// 同一个设备身份只允许一条隧道。桌面客户端还开着的时候启动本程序，
// 两边会互相把对方顶下线（4002 displaced），表现出来就是通道每隔几十秒抖一次。
// 与其让用户对着刷屏猜，不如启动时就说清楚。
if (process.platform === 'win32') {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Capy.exe', '/NH'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (/Capy\.exe/i.test(out)) {
      log('⚠ 检测到 Capy 桌面客户端正在运行：它和本程序共用同一个设备身份，会互相顶下线。');
      log('  建议先退出客户端；想让两者共存，运行 node login.js enroll 给 relay 注册一个独立设备。');
    }
  } catch {}
}

let stop = false;
process.on('SIGINT', () => {
  stop = true;
  log('正在退出…');
  process.exit(0);
});

// 把命令交给调用方执行：发给 relay，挂在那里等客户端回填结果。
//
// 云端对一条 invocation 的耐心大约 2 秒，超时会先给模型一句
// 「Still running after N.Ns as operation <opId>」，模型随即 wait 这个 operation。
// 之后云端靠 GET /v1/invocations/<id>?wait=... 长轮询来取结果（见下面的注册表），
// 所以这一条请求可以一直挂着，不需要提前回 running。
const aborters = new Map(); // invocationId -> AbortController（取消用）

async function runOnClient({ invocationId, handler, params, cwd, signal }) {
  let res;
  try {
    res = await fetch(`${RELAY_URL}/internal/hold`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invocationId, handler, params, cwd }),
      signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(WAIT_MS + 15000)]),
    });
  } catch (err) {
    return {
      kind: 'failure',
      isError: true,
      message: signal?.aborted ? '这条命令被取消了。' : `调用方通道不可用：${err.message}`,
    };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    return { failure: data.error || `调用方没有执行该工具（${res.status}）` };
  }
  // relay 核对过事件流：这条不是模型要的调用（云端自己的准备脚本），本机自己跑；
  // 或者调用方没声明这类工具，也不该硬塞给它
  if (data.forward === false) return { local: true };
  const text = String(data.text ?? '');
  const isError = !!data.isError;
  log(`  ↩ 调用方执行完毕 ${text.length} 字符${isError ? '（非零退出）' : ''}`);
  // 具体结果结构由调用方按 handler 整形（见 lib/oaitools.js）
  return { forwarded: true, text, isError };
}

// ---------------- invocation 注册表 ----------------
// 客户端的真实结构（对齐 out/main/main.js 里的 invocations 注册表）：
//   POST /v1/invocations?wait=<ms>  发起一次调用，最多在这儿等 wait 毫秒
//   GET  /v1/invocations/<id>?wait=<ms>  拿这条调用的结果快照，等不到就 404
//   POST /v1/invocations/<id>/cancel     取消
// 云端超过约 2 秒就会把这次调用转成后台 operation，让模型自己去 wait，
// 然后靠上面那个 GET 长轮询取结果。所以结果必须留在注册表里，等谁来取。
const jobs = new Map(); // invocationId -> { snapshot, done, resolve, at, aborted }
const JOB_TTL = 180000;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startJob(invocationId, runner) {
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const job = { snapshot: { status: 'running' }, done, resolve, at: Date.now(), ctl: new AbortController() };
  jobs.set(invocationId, job);
  aborters.set(invocationId, job.ctl);
  (async () => {
    let snap;
    try {
      const result = await runner();
      snap = { status: job.ctl.signal.aborted ? 'cancelled' : 'succeeded', result };
    } catch (err) {
      snap = { status: 'failed', error: { code: err?.code || 'invocation_failed', message: err?.message || String(err) } };
    }
    job.snapshot = snap;
    aborters.delete(invocationId);
    if (process.env.CAPY_DEBUG_STREAM) log(`  ✓ ${invocationId.slice(-6)} → ${snap.status}`);
    resolve(snap);
    setTimeout(() => {
      // 结果要留一会儿：云端可能过几秒才来取
      if (jobs.get(invocationId) === job) jobs.delete(invocationId);
    }, JOB_TTL).unref?.();
  })();
  return job;
}

async function waitJob(invocationId, ms) {
  const job = jobs.get(invocationId);
  if (!job) return undefined;
  if (job.snapshot.status === 'running' && ms > 0) {
    await Promise.race([job.done, delay(ms)]);
  }
  return job.snapshot;
}

const UNKNOWN_INVOCATION = { code: 'Vm.UnknownInvocation', message: 'Unknown invocation id' };

// 单条 invocation 的实际执行：返回 result 对象（不是快照信封）
async function runInvocation(body) {
  const handler = body.handler || '';
  const bodyParams = body.params || {};
  const t0 = Date.now();
  const pbrief = JSON.stringify(bodyParams);
  if (process.env.CAPY_DUMP_INVOCATION) {
    const shallow = {};
    for (const [k, v] of Object.entries(body)) if (k !== 'params') shallow[k] = v;
    log('  ? invocation 字段', JSON.stringify(shallow).slice(0, 400));
  }

  // 执行模式见文件顶部：local 本机跑 / client 交给调用方 / none 只出模型
  const EXEC_ONLY = /^(bash|bash_output|read|file_read|file_write|edit|apply_patch)$/;
  // 允许外抛给调用方执行的那几类（relay 还会再看它声明的工具决定是否真外抛）
  const FORWARD_TRY = /^(bash|read|file_read|file_write|edit|apply_patch)$/;
  let result;

  if (handler === 'bash_output') {
    // 云端拿 operationId 来问「跑到哪了」：正在跑就说还在跑，跑完了就说没了
    const opId = bodyParams.operationId;
    const job = jobs.get(opId);
    if (job && job.snapshot.status === 'running') result = { kind: 'output', output: '' };
    else result = { kind: 'not-running' };
  } else if (handler === 'operation_kill') {
    // 模型等不及会来取消：把那条还挂着的调用掐掉，并如实回报
    const target = bodyParams.operationId;
    const job = jobs.get(target);
    if (job && job.snapshot.status === 'running') {
      job.ctl.abort();
      const ctl = aborters.get(target);
      ctl?.abort?.();
      log(`  ✕ 取消调用 ${target}`);
      result = { kind: 'killed', stop: { outcome: 'confirmed' } };
    } else {
      result = { kind: 'killed', stop: { outcome: 'unknown', reason: 'operation not found' } };
    }
  } else if (EXEC_MODE === 'none' && EXEC_ONLY.test(handler)) {
    result = {
      kind: 'failure',
      isError: true,
      message:
        'Command execution and file access are disabled on this shared endpoint. Answer from your own knowledge instead.',
    };
  } else if (EXEC_MODE === 'client' && FORWARD_TRY.test(handler)) {
    // 能交给调用方的工具：bash 和文件类。
    // 具体交不交由 relay 判断（要看调用方声明了哪些工具、tool_choice 是什么），
    // 它回 forward:false 就说明这条得本机执行。
    const out = await runOnClient({
      invocationId: body.invocationId,
      handler,
      params: bodyParams,
      cwd: body.cwd,
      signal: jobs.get(body.invocationId)?.ctl.signal,
    });
    if (out?.local) result = await device.invoke(handler, bodyParams);
    else if (out?.forwarded) result = shapeResult(handler, bodyParams, out.text, out.isError);
    else result = { kind: 'failure', isError: true, message: out?.failure || '调用方没有执行该工具' };
  } else {
    result = await device.invoke(handler, bodyParams);
  }

  const ms = Date.now() - t0;
  const kind = result?.kind || '?';
  const brief =
    kind === 'bash'
      ? `exit=${result.exitCode} ${ms}ms${result.stderr?.trim() ? ' stderr=' + JSON.stringify(result.stderr.trim().slice(0, 160)) : ''}`
      : kind === 'failure'
        ? `FAIL ${result.message}`
        : kind;
  const noisy = /^(worktree_|volume_)/.test(handler);
  const line = [`  ${handler || '?'} → ${brief}`, pbrief === '{}' ? '' : `params=${pbrief.slice(0, 240)}`];
  if (noisy) logOnce(`${handler}|${kind}`, ...line);
  else log(...line);
  return result;
}

// 从 query 里取毫秒数（客户端的 Ck 同款逻辑）
function msParam(url, key, fallback = 0) {
  try {
    const v = new URL(url, 'http://device').searchParams.get(key);
    if (v === null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(n, 60000)) : fallback;
  } catch {
    return fallback;
  }
}

async function once() {
  const tunnel = new Tunnel({
    url: TUNNEL_URL,
    token: entry.secret,
    deviceId: entry.deviceId,
    worktreeBase: root,
    log: (...a) => log('[tunnel]', ...a),
  });

  tunnel.onRequest = async (req) => {
    const url = req.path || '';
    const method = (req.method || 'GET').toUpperCase();

    // 云端把设备当机器服务用，会调 git 侧写接口
    if (url.startsWith('/v1/git/')) {
      let gbody = null;
      try {
        gbody = JSON.parse(req.body.toString('utf8') || 'null');
      } catch {}
      const out = handleGitRoute(method, url, gbody, root);
      if (out) {
        logOnce(`${method} ${url}`, `  · ${method} ${url} → 200`);
        return { status: 200, body: out };
      }
    }

    const pathname = url.split('?')[0];
    const parts = pathname.split('/').filter(Boolean); // ['v1','invocations', id?, 'cancel'?]

    if (parts[0] !== 'v1' || parts[1] !== 'invocations') {
      log(`  ! ${method} ${url} → 404（未实现）`, req.body?.length ? `body=${req.body.toString('utf8').slice(0, 200)}` : '');
      return { status: 404, body: JSON.stringify({ status: 404, body: { code: 'Vm.NotFound', message: 'Unknown path' } }) };
    }

    // 取消某条调用
    if (method === 'POST' && parts.length === 4 && parts[3] === 'cancel') {
      const job = jobs.get(parts[2]);
      if (!job) return { status: 404, body: JSON.stringify({ status: 404, body: UNKNOWN_INVOCATION }) };
      if (job.snapshot.status === 'running') {
        job.ctl.abort();
        aborters.get(parts[2])?.abort?.();
        log(`  ✕ 取消调用 ${parts[2]}`);
      }
      return { status: 200, body: JSON.stringify(job.snapshot.status === 'running' ? { status: 'cancelled' } : job.snapshot) };
    }

    // 取某条调用的结果（云端 wait 的落地方式）
    if (method === 'GET' && parts.length === 3) {
      const snap = await waitJob(parts[2], msParam(url, 'wait'));
      if (!snap) return { status: 404, body: JSON.stringify({ status: 404, body: UNKNOWN_INVOCATION }) };
      if (process.env.CAPY_DEBUG_STREAM) log(`  ↔ GET ${parts[2].slice(-6)} → ${snap.status}`);
      return { status: 200, body: JSON.stringify(snap) };
    }

    // 发起一条调用
    if (method === 'POST' && parts.length === 2) {
      let body;
      try {
        body = JSON.parse(req.body.toString('utf8') || '{}');
      } catch {
        return { status: 400, body: JSON.stringify({ code: 'Vm.InvalidRequest', message: 'Body is not a valid invocation request' }) };
      }
      if (!body.handler || !body.invocationId) {
        // 云端会周期性发空 invocation 做探测，别让它变成模型眼里的「执行失败」
        return { status: 200, body: JSON.stringify({ status: 'succeeded', result: { kind: 'noop' } }) };
      }
      // wait=0 表示「用 hold 当作等待上限」
      const waitMs = msParam(url, 'wait') || msParam(url, 'hold');
      startJob(body.invocationId, () => runInvocation(body));
      const snap = await waitJob(body.invocationId, waitMs);
      return { status: 200, body: JSON.stringify(snap || { status: 'running' }) };
    }

    return { status: 404, body: JSON.stringify({ status: 404, body: { code: 'Vm.NotFound', message: 'Unknown path' } }) };
  };

  await tunnel.connect();
  log('✓ 设备通道已建立，等待云端下发任务');

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (tunnel.closed || stop) {
        clearInterval(timer);
        try {
          tunnel.close();
        } catch {}
        resolve(tunnel);
      }
    }, 1000);
  });
}

// 重连时区分「网络抖一下」和「账号被挡在门外」：
// 后者重试再快也没用，只会一直刷 403，还平白加重风控。探测到就放慢节奏并说明原因。
// 重连时区分「网络抖一下」和「账号被挡在门外」：
// 后者重试再快也没用，只会一直刷 403，还平白加重风控。探测到就放慢节奏并说明原因。
let lastProbe = { at: 0, status: null };

async function probeAccount() {
  if (Date.now() - lastProbe.at < 60_000) return lastProbe.status;
  const { accountStatus } = await import('./lib/auth.js');
  const status = await accountStatus().catch(() => null);
  lastProbe = { at: Date.now(), status };
  return status;
}

// 重连节奏对齐官方客户端：1s 起，逐次翻倍，最长 30s。
// 固定 3 秒猛刷的后果很实际 —— 网络一断就是每 3 秒一次握手，
// 长时间挂在那里，对端看到的就是「这台设备在疯狂重连」。
let backoff = 1000;

for (;;) {
  if (stop) break;
  let retryMs = backoff;
  try {
    const t = await once();
    if (stop) break;
    // 4002 displaced：另一个连接用同一个设备身份连上来了，把我们顶下去。
    // 这台机器上通常就是 Capy 桌面客户端还开着；两边会一直互相顶，每 30 秒一轮。
    // 这种拉扯在服务端看就是「同一台设备疯狂抖」，绝不能再快速重连。
    if (t?.closeCode === 4002) {
      retryMs = 60_000;
      logOnce(
        'displaced',
        '✗ 设备身份被另一条连接顶掉了（4002 displaced）：同一台机器上还有程序在用同一个设备身份，' +
          '多半是 Capy 桌面客户端还开着。请退出它；想两个共存就单独给 relay 注册一个设备：node login.js enroll',
      );
      log('  60 秒后再试（避免两边互相顶）');
    } else {
      log('通道断开，', Math.round(retryMs / 1000), '秒后重连…');
    }
  } catch (err) {
    const st = await probeAccount();
    if (st?.suspended) {
      retryMs = 60_000;
      logOnce(
        'suspended',
        '✗ 账号被 Capy 暂停（capy/AccountSuspended）：登录本身是好的，是账号侧限制，' +
          '设备和隧道都会一直被拒。去 capy.ai 网页看提示或申诉，恢复后这个窗口会自动连上。',
      );
      log('  60 秒后再试一次（避免空刷）');
    } else if (st && st.ok === false && st.status === 403) {
      retryMs = 30_000;
      logOnce('blocked-403', `✗ 云端拒绝访问（403 ${st.tag || ''}）| 30 秒后重试`);
    } else {
      log('连接失败：', err.message, '|', Math.round(retryMs / 1000), '秒后重试');
    }
  }
  backoff = Math.min(backoff * 2, 30_000);
  await new Promise((r) => setTimeout(r, retryMs));
}
