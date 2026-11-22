#!/usr/bin/env node
// 命令行登录：不依赖 Capy 桌面客户端
//
//   node login.js start you@example.com   发验证码到邮箱
//   node login.js verify 123456           校验验证码，保存会话
//   node login.js enroll                  注册本机为执行设备（拿设备令牌）
//   node login.js status                  看当前登录与设备状态
//   node login.js logout                  清掉本地会话
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startLogin, finishLogin, enrollDevice, adoptDevice, whoAmI, loadAuth, loadDevice, clearAuth, getJwt, saveAuth, authFile, deviceFile, DATA_DIR } from './lib/auth.js';

const [, , cmd, ...rest] = process.argv;

// ---------- 半自动登录：借浏览器完成 SSO，把 Clerk 会话接过来 ----------
const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

async function cdp(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('连不上浏览器调试端口'));
  });
  try {
    return await new Promise((resolve, reject) => {
      ws.onmessage = (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.id !== 1) return;
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

// Network.getAllCookies 只能挂在具体页面会话上，浏览器级别的 ws 调不到
async function pageTarget(port) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const pages = (list || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const hit = pages.find((t) => /(^|\.)capy\.ai$/.test(new URL(t.url).hostname));
  return hit || pages[0] || null;
}

async function readClerkCookie(port) {
  const page = await pageTarget(port);
  if (!page) return null;
  const all = await cdp(page.webSocketDebuggerUrl, 'Network.getAllCookies');
  const cookies = all?.cookies || [];
  const client = cookies.find((c) => c.name === '__client' && /clerk\.capy\.ai$/.test(c.domain) && c.value);
  if (!client) return null;
  const uat = cookies.find((c) => c.name === '__client_uat' && /(^|\.)capy\.ai$/.test(c.domain) && c.value);
  return { client: client.value, uat: uat?.value || null, page };
}

// 让浏览器自己退出，避免它在后台继续轮换 cookie
async function closeBrowser(port) {
  try {
    const page = await pageTarget(port);
    if (page) await cdp(page.webSocketDebuggerUrl, 'Browser.close');
  } catch {}
}

async function waitClerkCookie(port, timeoutMs = 300000) {
  const started = Date.now();
  let lastNote = 0;
  while (Date.now() - started < timeoutMs) {
    try {
      const got = await readClerkCookie(port);
      if (got) return got;
      if (Date.now() - lastNote > 10000) {
        lastNote = Date.now();
        const left = Math.round((timeoutMs - (Date.now() - started)) / 1000);
        process.stdout.write(`\r等待登录… 剩余 ${left}s   `);
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1200));
  }
  const err = new Error('等待登录超时（5 分钟）');
  err.code = 'login_timeout';
  throw err;
}

// 用浏览器里的 __client cookie 换 Clerk 会话 → JWT → 落盘
async function completeFromCookie(got) {
  const authMod = await import('./lib/auth.js');
  const jar = { __client: got.client };
  if (got.uat) jar.__client_uat = got.uat;

  const clientRes = await authMod.clerkGet(jar, '/v1/client');
  const client = clientRes?.response || clientRes;
  const sessions = client?.sessions || [];
  const active = sessions.find((s) => s.status === 'active') || sessions[0];
  if (!active?.id) {
    throw new Error('浏览器已登录，但没拿到有效会话。请重试，或在窗口里确认已进入 Capy 主界面。');
  }

  const tok = await authMod.clerkPost(jar, `/v1/client/sessions/${active.id}/tokens`);
  const jwt = tok?.jwt;
  if (!jwt) throw new Error('会话有效但换不到 token');

  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  const email =
    active?.user?.primary_email_address?.email_address ||
    active?.user?.email_addresses?.[0]?.email_address ||
    null;
  saveAuth({
    email,
    jar,
    sessionId: active.id,
    userId: claims.sub || null,
    jwt,
    jwtExp: claims.exp || null,
    via: 'browser-sso',
  });

  console.log('✓ 登录成功:', email || claims.sub);
  const me = await whoAmI().catch(() => null);
  if (me?.orgId) {
    saveAuth({ orgId: me.orgId });
    console.log('  组织 ID:', me.orgId);
  }
  if (loadDevice()?.deviceId) {
    console.log('  设备已绑定:', loadDevice().deviceId);
  } else {
    console.log('  ⚠ 还没有设备身份：运行 node login.js adopt');
  }
  console.log('');
  console.log('现在可以启动： .\\start.bat');
}

function launchBrowser(port, profile) {
  const exe = findBrowser();
  if (!exe) throw new Error('没有找到 Edge / Chrome，请先安装其中一个');
  fs.mkdirSync(profile, { recursive: true });
  console.log('打开浏览器窗口（独立配置，不影响你平时的浏览器）…');
  return spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      'https://capy.ai/sign-in',
    ],
    { stdio: 'ignore' },
  );
}

async function browserLogin() {
  const port = 9444;
  const profile = path.join(DATA_DIR, 'browser-profile');
  const child = launchBrowser(port, profile);

  console.log('请在窗口里点「微软登录」并完成登录，完成后这里会自动继续。');
  const got = await waitClerkCookie(port);
  process.stdout.write('\r' + ' '.repeat(40) + '\r');
  console.log('✓ 已捕获登录会话');

  // 先关浏览器再换 token：避免它在后台轮换 cookie，导致手上的失效
  try {
    child.kill();
  } catch {}
  await closeBrowser(port);

  await completeFromCookie(got);
}

// 复用已经开着（且已登录）的调试浏览器
async function fromBrowser(portArg) {
  const port = Number(portArg) || 9444;
  let got;
  try {
    got = await readClerkCookie(port);
  } catch (e) {
    throw new Error(`连不上 ${port} 端口的浏览器：${e.message}`);
  }
  if (!got) throw new Error('这个浏览器里还没有 Capy 登录会话，请先在窗口里完成登录');
  console.log('✓ 已从浏览器读到登录会话');
  await closeBrowser(port);
  await completeFromCookie(got);
}

// 一次跑完：输邮箱 → 收码 → 输码 → 自动注册设备
async function interactive() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const email = (await rl.question('Capy 账号邮箱: ')).trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('邮箱格式不对');
    const r = await startLogin(email);
    console.log(`验证码已发送（${r.status || 'needs_first_factor'}）`);
    const code = (await rl.question('邮箱收到的 6 位验证码: ')).trim();
    const auth = await finishLogin(code);
    console.log('✓ 登录成功:', auth.email || auth.userId);
    const me = await whoAmI().catch(() => null);
    if (me?.orgId) {
      saveAuth({ orgId: me.orgId });
      console.log('  组织 ID:', me.orgId);
    }
    if (loadDevice()?.deviceId) {
      console.log('✓ 设备已绑定:', loadDevice().deviceId);
    } else {
      const dev = await enrollDevice();
      console.log('✓ 设备已注册:', dev.deviceId, '|', dev.name);
    }
    console.log('');
    console.log('现在可以启动： .\\start.bat   （或 node device-worker.js + node server.js）');
  } finally {
    rl.close();
  }
}

function fmt(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

async function status() {
  const auth = loadAuth();
  const dev = loadDevice();
  console.log('会话文件:', authFile());
  if (!auth) {
    console.log('登录状态: 未登录（运行 node login.js start <邮箱>）');
  } else {
    console.log('登录账号:', auth.email || auth.userId);
    console.log('保存时间:', fmt(auth.updatedAt));
    let live = '可用';
    try {
      const jwt = await getJwt({ force: true });
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
      const left = claims.exp ? claims.exp - Math.floor(Date.now() / 1000) : null;
      live = `可换到新 token（有效期 ${left}s）`;
    } catch (e) {
      live = `不可用：${e.message}`;
    }
    console.log('会话状态:', live);
  }
  console.log('设备文件:', deviceFile());
  if (!dev) {
    console.log('设备状态: 未注册（运行 node login.js enroll）');
  } else {
    console.log('设备状态: 已注册');
    console.log('  设备 ID:', dev.deviceId);
    console.log('  组织 ID:', dev.orgId);
    console.log('  设备名  :', dev.name, `(${dev.hostname}, ${dev.os}/${dev.arch})`);
    console.log('  注册时间:', fmt(dev.enrolledAt));
    console.log('  令牌    :', `${String(dev.token).slice(0, 10)}…（共 ${String(dev.token).length} 字符）`);
  }
}

async function main() {
  if (cmd === 'browser' || cmd === 'sso') {
    await browserLogin();
    return;
  }

  if (cmd === 'from-browser') {
    await fromBrowser(rest[0]);
    return;
  }

  if (cmd === 'login' || cmd === 'go') {
    await interactive();
    return;
  }

  if (cmd === 'start') {
    const email = rest[0];
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      console.error('用法: node login.js start you@example.com');
      process.exit(2);
    }
    const r = await startLogin(email);
    console.log(`验证码已发送到 ${r.email}`);
    console.log(`登录状态: ${r.status || 'needs_first_factor'}｜支持的方式: ${r.supported.join(', ') || 'email_code'}`);
    console.log('');
    console.log('收到 6 位验证码后执行： node login.js verify <验证码>');
    return;
  }

  if (cmd === 'verify') {
    const code = rest[0];
    if (!code) {
      console.error('用法: node login.js verify 123456');
      process.exit(2);
    }
    const auth = await finishLogin(code);
    console.log('登录成功:', auth.email || auth.userId);
    try {
      const me = await whoAmI();
      if (me.orgId) {
        const { saveAuth } = await import('./lib/auth.js');
        saveAuth({ orgId: me.orgId });
        console.log('组织 ID:', me.orgId);
      }
    } catch (e) {
      console.log('（读取组织信息失败，稍后可重试）', e.message);
    }
    console.log('');
    console.log('下一步： node login.js enroll   注册本机为执行设备');
    return;
  }

  if (cmd === 'enroll') {
    const nameArg = rest.indexOf('--name');
    const name = nameArg >= 0 ? rest[nameArg + 1] : null;
    const dev = await enrollDevice({ name });
    console.log('设备注册成功');
    console.log('  设备 ID:', dev.deviceId);
    console.log('  组织 ID:', dev.orgId);
    console.log('  设备名  :', dev.name);
    console.log('');
    console.log('现在可以启动： node device-worker.js    （设备执行端）');
    console.log('              node server.js           （OpenAI 兼容端点）');
    return;
  }

  if (cmd === 'adopt') {
    const dev = await adoptDevice();
    console.log('已接管这台机器的设备身份');
    console.log('  设备 ID:', dev.deviceId);
    console.log('  组织 ID:', dev.orgId);
    console.log('');
    console.log('之后可以完全关掉桌面客户端，执行设备端： node device-worker.js');
    return;
  }

  if (cmd === 'logout') {
    clearAuth();
    console.log('已清除本地登录会话（设备注册信息保留）');
    return;
  }

  if (cmd === 'status' || !cmd) {
    await status();
    return;
  }

  console.log(`未知命令: ${cmd}`);
  console.log('可用命令: browser（浏览器 SSO 登录）| login（邮箱验证码，交互式）| start <邮箱> | verify <验证码> | adopt | status | logout');
  process.exit(2);
}

main().catch((err) => {
  console.error(`错误: ${err.message}`);
  if (err.code) console.error(`代码: ${err.code}`);
  process.exit(1);
});
