// 极简 CDP 客户端：连到 Capy 桌面客户端的页面，执行表达式并把结果打出来。
// 用法：node tools/cdp.mjs "<js 表达式>" [--await] [--raw]
// 说明：表达式返回值需要能 JSON 序列化；--await 表示等待 Promise。

const PORT = process.env.CAPY_CDP_PORT || 9333;

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP 目标列表请求失败: ${res.status}`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`WebSocket 连接失败: ${e.message || e.type}`));
  });
}

function send(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const expr = process.argv[2];
if (!expr) {
  console.error('缺少表达式');
  process.exit(1);
}
const waitPromise = process.argv.includes('--await');
const rawOutput = process.argv.includes('--raw');

const targets = await listTargets();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('没有找到页面目标，客户端可能没开窗口');

const ws = await connect(page.webSocketDebuggerUrl);
const result = await send(ws, 1, 'Runtime.evaluate', {
  expression: expr,
  awaitPromise: waitPromise,
  returnByValue: true,
  userGesture: true,
});
ws.close();

if (result.exceptionDetails) {
  const ex = result.exceptionDetails;
  console.error('执行异常:', ex.text, ex.exception?.description || '');
  process.exit(2);
}
const value = result.result?.value;
if (rawOutput) console.log(typeof value === 'string' ? value : JSON.stringify(value));
else console.log(JSON.stringify(value, null, 1));

// 可选：截图到 SHOT 指定路径，用于肉眼确认界面状态
if (process.env.SHOT) {
  const fs = await import('node:fs');
  const ws2 = await connect(page.webSocketDebuggerUrl);
  const shot = await send(ws2, 1, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
  ws2.close();
  console.error('screenshot ->', process.env.SHOT);
}
