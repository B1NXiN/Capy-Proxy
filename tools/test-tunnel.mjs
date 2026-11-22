// 协议一致性自测：起一个假 gateway，按 Capy 服务端的校验规则对 Tunnel 逐条打分。
// 只用于开发验证，不参与运行。用法：node tools/test-tunnel.mjs
import { WebSocketServer } from 'ws';
import { Tunnel } from '../lib/tunnel.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BODY = Buffer.alloc(500 * 1024, 0x61); // 500KB，必然超过单流 256KB 窗口

let ctrl = []; // 收到的控制帧
let dataFrames = []; // { streamId, len }

const wss = new WebSocketServer({ port: 0, path: '/tunnel' });
await new Promise((r) => wss.once('listening', r));
const port = wss.address().port;

let peer = null;
wss.on('connection', (ws) => {
  peer = ws;
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.from(data);
      dataFrames.push({ streamId: buf.readUInt32BE(0), len: buf.length - 4 });
      return;
    }
    ctrl.push(JSON.parse(data.toString()));
  });
});

const tunnel = new Tunnel({
  url: `ws://127.0.0.1:${port}/tunnel`,
  token: 'test',
  deviceId: 'device_test',
});
let seenBodyLen = 0;
tunnel.onRequest = async (req) => {
  if (req.path === '/empty') {
    seenBodyLen = req.body.length;
    return { status: 204, headers: {}, body: Buffer.alloc(0) };
  }
  return { status: 200, headers: {}, body: BODY };
};

await tunnel.connect();
await sleep(300);

// ---- 握手 ----
check('发出 hello', ctrl.some((f) => f.type === 'hello'));
check('hello 里带 contractVersion=2', ctrl.find((f) => f.type === 'hello')?.contractVersion === 2);

ctrl = [];
peer.send(JSON.stringify({ type: 'session-config', backingId: 'bk_1' }));
await sleep(300);
check('收到 session-config 后回 workspaces-changed', ctrl.some((f) => f.type === 'workspaces-changed'));
check('收到 session-config 后回 ready', ctrl.some((f) => f.type === 'ready'));
const order = ctrl.map((f) => f.type);
check('顺序是 workspaces-changed → ready', order.indexOf('workspaces-changed') < order.indexOf('ready'));

// ---- 一轮 invocation ----
ctrl = [];
dataFrames = [];
const reqBody = Buffer.from(JSON.stringify({ handler: 'bash', invocationId: 'inv_1', params: { command: 'pwd' } }));
peer.send(
  JSON.stringify({
    type: 'open',
    streamId: 2,
    kind: 'invoke',
    method: 'POST',
    path: '/v1/invocations',
    headers: { 'content-type': 'application/json' },
  }),
);
const frame = Buffer.alloc(4 + reqBody.length);
frame.writeUInt32BE(2, 0);
reqBody.copy(frame, 4);
peer.send(frame, { binary: true });
peer.send(JSON.stringify({ type: 'close', streamId: 2 }));
await sleep(600);

const resp = ctrl.find((f) => f.type === 'response');
check('回了 response', !!resp);
check('response 带 serviceMs', typeof resp?.serviceMs === 'number');
check('response 带 sinceOpenMs', typeof resp?.sinceOpenMs === 'number');
check('response 状态码 200', resp?.status === 200);

const credits = ctrl.filter((f) => f.type === 'credit');
check(
  '收数据后回了两条 credit（流级 + 连接级）',
  credits.some((f) => f.streamId === 2) && credits.some((f) => f.streamId === 0),
  JSON.stringify(credits),
);

// ---- 窗口控制：500KB 响应必须停在 256KB，等 credit ----
const sentBytes = dataFrames.reduce((a, f) => a + f.len, 0);
check('数据帧每片不超过 65536', dataFrames.every((f) => f.len <= 65536), `最大 ${Math.max(...dataFrames.map((f) => f.len))}`);
check('数据帧 streamId 正确', dataFrames.every((f) => f.streamId === 2));
check('发满单流窗口就停下等 credit', sentBytes === 262144, `已发 ${sentBytes}`);
check('停住时还没有发 close', !ctrl.some((f) => f.type === 'close'));

// 补窗口，应该继续发完
ctrl = [];
dataFrames = [];
peer.send(JSON.stringify({ type: 'credit', streamId: 2, bytes: 262144 }));
peer.send(JSON.stringify({ type: 'credit', streamId: 0, bytes: 262144 }));
await sleep(600);
const restBytes = dataFrames.reduce((a, f) => a + f.len, 0);
check('给 credit 后把剩下的一次发完', restBytes === BODY.length - 262144, `续发 ${restBytes}`);
check('发完回 close', ctrl.some((f) => f.type === 'close' && f.streamId === 2));

// ---- 大请求体：靠 credit 归还才能收完，不能卡在 256KB ----
ctrl = [];
dataFrames = [];
const bigReq = Buffer.alloc(400 * 1024, 0x62);
peer.send(JSON.stringify({ type: 'open', streamId: 4, kind: 'invoke', method: 'POST', path: '/empty', headers: {} }));
for (let off = 0; off < bigReq.length; off += 65536) {
  const part = bigReq.subarray(off, Math.min(off + 65536, bigReq.length));
  const f = Buffer.alloc(4 + part.length);
  f.writeUInt32BE(4, 0);
  part.copy(f, 4);
  peer.send(f, { binary: true });
}
peer.send(JSON.stringify({ type: 'close', streamId: 4 }));
await sleep(800);
check('400KB 请求体完整收到', seenBodyLen === bigReq.length, `收到 ${seenBodyLen}`);
check('空响应只发 response + close，不发数据帧', dataFrames.length === 0 && ctrl.filter((f) => f.type === 'close').length === 1);

// ---- 违规输入：不该把连接搞崩，也不该继续憋着 ----
ctrl = [];
dataFrames = [];
peer.send(Buffer.from([0, 0, 0, 0, 0x41]), { binary: true }); // streamId 0
peer.send(Buffer.alloc(4), { binary: true }); // 空负载
await sleep(250);
check('对 streamId=0 / 空数据帧不回应（只是丢弃）', ctrl.length === 0, JSON.stringify(ctrl));

// 奇偶不对的 open：不拒绝（拒了整条链路会哑），但仍要正常处理
ctrl = [];
peer.send(JSON.stringify({ type: 'open', streamId: 3, kind: 'invoke', method: 'GET', path: '/x', headers: {} }));
await sleep(300);
check('奇数 streamId 的 open 仍然正常响应', ctrl.some((f) => f.type === 'response' && f.streamId === 3));

// ---- 心跳 ----
ctrl = [];
console.log('  … 等 11 秒看心跳');
await sleep(11_000);
check('每 10 秒主动 ping', ctrl.some((f) => f.type === 'ping'));
peer.send(JSON.stringify({ type: 'ping' }));
await sleep(200);
check('收到对端 ping 回 pong', ctrl.some((f) => f.type === 'pong'));

// ---- 收尾 ----
tunnel.close();
await sleep(200);
wss.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
