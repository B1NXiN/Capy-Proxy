// 应用内 API 客户端：从桌面客户端取 Clerk 令牌，直接调用 api.capy.ai/app。
// 用法：node tools/app-api.mjs events <jamId>
//      node tools/app-api.mjs create [prompt]
//      node tools/app-api.mjs me

const PORT = process.env.CAPY_CDP_PORT || 9333;
const BASE = 'https://api.capy.ai/app';
const ORG = process.env.CAPY_ORG_ID;
const DEVICE = process.env.CAPY_DEVICE_ID;

let cached = { token: '', exp: 0 };

export async function token() {
  const now = Date.now() / 1000;
  if (cached.token && cached.exp - 15 > now) return cached.token;
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('桌面客户端没有可用窗口');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('连不上客户端调试端口'));
  });
  const value = await new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      if (m.error) return reject(new Error(m.error.message));
      if (m.result?.exceptionDetails) return reject(new Error(m.result.exceptionDetails.text));
      resolve(m.result.result.value);
    };
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: 'window.capyDesktop.session.token()', awaitPromise: true, returnByValue: true },
      }),
    );
  });
  ws.close();
  if (typeof value !== 'string') throw new Error('取不到会话令牌，客户端可能已退出登录');
  const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
  cached = { token: value, exp: payload.exp };
  return value;
}

export async function call(path, init = {}) {
  const jwt = await token();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = typeof body === 'object' ? JSON.stringify(body).slice(0, 300) : String(body).slice(0, 200);
    throw new Error(`HTTP ${res.status} ${path} -> ${msg}`);
  }
  return body;
}

if (process.argv[1] && process.argv[1].endsWith('app-api.mjs')) {
  const cmd = process.argv[2];
  if (cmd === 'me') console.log(JSON.stringify(await call('/me'), null, 1).slice(0, 1200));
  if (cmd === 'events') {
    const d = await call(`/orgs/${ORG}/jams/${process.argv[3]}/events?limit=500`);
    const items = d.items || d;
    console.log('events', items.length);
    for (const e of items.slice(-8)) console.log(' -', e.kind, JSON.stringify(e.payload).slice(0, 160));
  }
  if (cmd === 'create') {
    const text = process.argv[3] || '只回复两个字：收到';
    const body = {
      requestId: `relay_${Date.now()}`,
      message: text,
      device: { deviceId: DEVICE, workspace: { kind: 'linked', root: 'D:/agent' } },
    };
    console.log('POST', JSON.stringify(body));
    const r = await call(`/orgs/${ORG}/jams`, { method: 'POST', body: JSON.stringify(body) });
    console.log(JSON.stringify(r).slice(0, 800));
  }
}
