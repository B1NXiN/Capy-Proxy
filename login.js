#!/usr/bin/env node
// 登录只有一条路：打开浏览器 → 你在 capy.ai 上自己登录 → 我们把登录 cookie 接过来。
// 不再自己实现邮箱验证码，也不限定登录方式：微软、谷歌、邮箱码，网页上怎么登都行。
//
//   node login.js                 打开浏览器登录（默认）
//   node login.js browser        同上；加 --fresh 先清掉旧的浏览器配置
//   node login.js cookie "<串>"  把浏览器 DevTools 里复制的 cookie 粘进来
//   node login.js attach [端口]  从已经开着调试端口的浏览器里读（默认 9444）
//   node login.js status         看登录与设备状态
//   node login.js logout         清掉本地登录态
//   node login.js adopt          接管桌面客户端的设备身份
//   node login.js enroll         注册一台新设备
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  DATA_DIR,
  loginWithCookies,
  parseCookieString,
  enrollDevice,
  adoptDevice,
  loadAuth,
  loadDevice,
  clearAuth,
  getJwt,
  authFile,
  deviceFile,
} from './lib/auth.js';

const [, , cmd, ...rest] = process.argv;

const LOGIN_URL = process.env.CAPY_LOGIN_URL || 'https://capy.ai';
const PROFILE = path.join(DATA_DIR, 'browser-profile');
const DEFAULT_PORT = Number(process.env.CAPY_DEBUG_PORT) || 9444;
const WAIT_MS = Number(process.env.CAPY_LOGIN_TIMEOUT) || 5 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 找浏览器 ----------
const BROWSER_CANDIDATES = [
  process.env.CAPY_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean);

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

// ---------- 极简 CDP：一问一答 ----------
async function cdp(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('连浏览器调试端口超时')), 8000);
    ws.onopen = () => {
      clearTimeout(t);
      res();
    };
    ws.onerror = () => {
      clearTimeout(t);
      rej(new Error('连不上浏览器调试端口'));
    };
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
  const list = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(4000),
  }).then((r) => r.json());
  const pages = (list || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const hit = pages.find((t) => {
    try {
      return /(^|\.)capy\.ai$/.test(new URL(t.url).hostname);
    } catch {
      return false;
    }
  });
  return hit || pages[0] || null;
}

// 从浏览器里把 Clerk 的 cookie 捞出来
// 注意：__client 在“打开登录页”那一下就种下了（匿名追踪用），不代表已登录。
// 真正登录成功的标志是 __session，或 __client_uat 从 "0" 变成时间戳。
async function readCookies(port) {
  const page = await pageTarget(port);
  if (!page) return null;
  const all = await cdp(page.webSocketDebuggerUrl, 'Network.getAllCookies');
  const cookies = all?.cookies || [];
  const client = cookies.find((c) => c.name === '__client' && /(^|\.)clerk\.capy\.ai$/.test(c.domain) && c.value);
  if (!client) return null;
  const uat = cookies.find((c) => c.name === '__client_uat' && /(^|\.)capy\.ai$/.test(c.domain) && c.value);
  const session = cookies.find((c) => c.name === '__session' && /(^|\.)capy\.ai$/.test(c.domain) && c.value);
  const uatValue = uat?.value || null;
  const signedIn = Boolean(session?.value) || Boolean(uatValue && uatValue !== '0');
  return { client: client.value, uat: uatValue, signedIn };
}

async function closeBrowser(port) {
  try {
    const page = await pageTarget(port);
    if (page) await cdp(page.webSocketDebuggerUrl, 'Browser.close');
  } catch {}
}

// 让浏览器自己退出，避免它在后台继续轮换 cookie
async function shutdown(child, port) {
  await closeBrowser(port);
  try {
    child?.kill();
  } catch {}
}

// 实际调试端口可能不是我们要的那个（端口被占时浏览器会换一个），以 DevToolsActivePort 为准
async function activePort(fallback, tries = 20) {
  const file = path.join(PROFILE, 'DevToolsActivePort');
  for (let i = 0; i < tries; i++) {
    try {
      const first = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
      if (/^\d+$/.test(first)) return Number(first);
    } catch {}
    await sleep(250);
  }
  return fallback;
}

function launchBrowser(port) {
  const exe = findBrowser();
  if (!exe) {
    throw new Error('没有找到 Edge / Chrome。装一个就行，或用 CAPY_BROWSER 指定浏览器路径');
  }
  fs.mkdirSync(PROFILE, { recursive: true });
  // 上一次留下的端口文件会骗到我们，先删掉
  try {
    fs.rmSync(path.join(PROFILE, 'DevToolsActivePort'), { force: true });
  } catch {}
  return spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      LOGIN_URL,
    ],
    { stdio: 'ignore' },
  );
}

// 等到“真的登录成功”为止：光是看到 cookie 不算，还要能换到 token
async function waitForCookies(port, child) {
  const started = Date.now();
  let lastNote = 0;
  let deadAt = 0;
  let lastErr = null;
  let firstFailAt = 0;
  let warnedStale = false;
  child?.once('exit', () => {
    deadAt = Date.now();
  });

  while (Date.now() - started < WAIT_MS) {
    let got = null;
    try {
      got = await readCookies(port);
    } catch {}

    // cookie 出现了只说明“页面种了匿名 cookie”，还得确认会话真的有效
    if (got?.signedIn) {
      try {
        const result = await loginWithCookies({ __client: got.client, __client_uat: got.uat }, { via: 'browser' });
        return { cookies: got, result };
      } catch (e) {
        if (e.code !== 'no_active_session' && e.code !== 'no_jwt') throw e;
        // cookie 还没同步到 Clerk 后端，继续等，别急着关浏览器
        lastErr = e;
        if (!firstFailAt) firstFailAt = Date.now();
        // 有旧登录痕迹但换不到 token：提示一句，但不打断——人可能正在输入密码
        if (!warnedStale && Date.now() - firstFailAt > 20000) {
          warnedStale = true;
          process.stdout.write(process.stdout.isTTY ? '\x1b[2K\r' : '');
          console.log('  （浏览器里有份旧的登录 cookie 已失效，重新登一次就会覆盖它；一直卡住就用 --fresh）');
        }
      }
    }

    // 窗口被关掉就尽快失败；但如果只是这个配置目录被另一个窗口占着，
    // 那个窗口仍然可能持有登录态，所以再多等 3 秒
    if (deadAt && Date.now() - deadAt > 3000) {
      throw new Error('浏览器窗口被关掉了，登录没有完成（也可能这个配置目录已被另一个窗口占用）');
    }
    if (Date.now() - lastNote > 5000) {
      lastNote = Date.now();
      const left = Math.round((WAIT_MS - (Date.now() - started)) / 1000);
      if (process.stdout.isTTY) process.stdout.write(`\r  等待你在浏览器里登录… 剩余 ${left}s   `);
    }
    await sleep(1200);
  }
  const err = new Error(
    lastErr
      ? `等待登录超时（${Math.round(WAIT_MS / 1000)} 秒）：cookie 拿到了但会话没生效，${lastErr.message}`
      : `等待登录超时（${Math.round(WAIT_MS / 1000)} 秒）：浏览器里看起来还没完成登录`,
  );
  err.code = 'login_timeout';
  throw err;
}

// ---------- 拿到 cookie 之后：换会话、落盘、报状态 ----------
function announce(r) {
  console.log('✓ 登录成功：' + (r.email || r.userId || '（未知账号）'));
  if (r.orgId) console.log('  组织 ID：' + r.orgId);

  const dev = loadDevice();
  if (dev?.deviceId) {
    console.log('  执行设备：' + String(dev.deviceId).slice(0, 26) + '…（本机）');
  } else {
    console.log('');
    console.log('  还没有执行设备身份，接着运行： node login.js adopt');
  }

  console.log('');
  console.log('下一步： .\\start.bat');
  return 0;
}

async function finish(cookies, via) {
  return announce(await loginWithCookies(cookies, { via }));
}

// ---------- 方式一：开浏览器，你自己登 ----------
async function browserLogin({ fresh = false } = {}) {
  if (fresh) {
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true });
      console.log('已清掉旧的浏览器配置：' + PROFILE);
    } catch (e) {
      console.log('清配置失败（不影响继续）：' + e.message);
    }
  }

  const child = launchBrowser(DEFAULT_PORT);
  const port = await activePort(DEFAULT_PORT);

  console.log('');
  console.log('  打开了一个独立浏览器窗口（不影响你平时用的浏览器）。');
  console.log('  地址：' + LOGIN_URL);
  console.log('');
  console.log('  在里面用你惯用的方式登录就行 —— 微软、谷歌、邮箱验证码都可以，网页让你怎么登就怎么登。');
  console.log('  登进 Capy 主界面后这里会自动继续，不用回来敲任何东西。');
  console.log('');

  let hit;
  try {
    hit = await waitForCookies(port, child);
  } catch (e) {
    await shutdown(child, port);
    throw e;
  }
  process.stdout.write(process.stdout.isTTY ? '\x1b[2K\r' : '');
  // 会话已经验证过（能换到 token），这时候再关浏览器，避免它在后台继续轮换 cookie
  await shutdown(child, port);
  return announce(hit.result);
}

// ---------- 方式二：直接粘 cookie ----------
async function cookieLogin(raw) {
  if (!raw) {
    console.error('用法: node login.js cookie "__client=eyJ...; __client_uat=..."');
    console.error('');
    console.error('取法：在已经登录 capy.ai 的浏览器里按 F12 → Application → Cookies');
    console.error('      → https://clerk.capy.ai 复制 __client，再复制 capy.ai 的 __client_uat');
    process.exit(2);
  }
  // 只粘了一个值（没有 name=）时，当成 __client
  if (!raw.includes('=')) raw = `__client=${raw}`;
  const jar = parseCookieString(raw);
  if (!jar.__client) {
    console.error('这串里没有 __client，没法换会话。');
    process.exit(2);
  }
  console.log('✓ 已解析 cookie：' + Object.keys(jar).join(', '));
  return finish(jar, 'cookie');
}

// ---------- 方式三：接管一个已经开着调试端口的浏览器 ----------
async function attachLogin(portArg) {
  const port = Number(portArg) || DEFAULT_PORT;
  let got;
  try {
    got = await readCookies(port);
  } catch (e) {
    throw new Error(`连不上 ${port} 端口的浏览器：${e.message}`);
  }
  if (!got) throw new Error('这个浏览器里还没有 Capy 登录态，请先在窗口里登录');
  if (!got.signedIn) {
    throw new Error('这个浏览器只种了匿名 cookie（__client），登录还没完成，请在窗口里把账号登进去');
  }
  console.log('✓ 已从浏览器读到登录 cookie');
  await closeBrowser(port);
  return finish({ __client: got.client, __client_uat: got.uat }, 'attach');
}

// ---------- 其他命令 ----------
function fmt(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

async function status() {
  const auth = loadAuth();
  const dev = loadDevice();
  console.log('会话文件：' + authFile());
  if (!auth) {
    console.log('登录状态：未登录（运行 node login.js，在浏览器里登录一次）');
  } else {
    console.log('登录账号：' + (auth.email || auth.userId || '（未知）'));
    console.log('登录方式：' + (auth.via || 'browser'));
    console.log('保存时间：' + fmt(auth.updatedAt));
    let live = '可用';
    try {
      const jwt = await getJwt({ force: true });
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
      const left = claims.exp ? claims.exp - Math.floor(Date.now() / 1000) : null;
      live = `可换到新 token（本次有效期 ${left}s）`;
    } catch (e) {
      live = `不可用：${e.message}`;
    }
    console.log('会话状态：' + live);
  }
  console.log('设备文件：' + deviceFile());
  if (!dev) {
    console.log('设备状态：未注册（运行 node login.js adopt）');
  } else {
    console.log('设备状态：已注册');
    console.log('  设备 ID：' + dev.deviceId);
    console.log('  组织 ID：' + dev.orgId);
    console.log('  设备名  ：' + dev.name + `（${dev.hostname}, ${dev.os}/${dev.arch}）`);
    console.log('  注册时间：' + fmt(dev.enrolledAt));
    console.log('  令牌    ：' + String(dev.token).slice(0, 10) + `…（共 ${String(dev.token).length} 字符）`);
  }
}

function help() {
  console.log('用法: node login.js [命令]');
  console.log('');
  console.log('  （不带命令）      打开浏览器登录');
  console.log('  browser [--fresh] 打开浏览器登录；--fresh 先清掉旧的浏览器配置');
  console.log('  cookie "<串>"     粘贴 DevTools 里复制的 cookie');
  console.log('  attach [端口]     从一个已经开着调试端口的浏览器里读（默认 9444）');
  console.log('  status            看登录与设备状态');
  console.log('  enroll [--name]   用登录态注册一台新设备（不需要客户端）');
  console.log('  adopt             接管桌面客户端残留的旧设备身份（一般不需要）');
  console.log('  logout            清掉本地登录态（设备信息保留）');
}

async function main() {
  if (!cmd || cmd === 'browser' || cmd === 'login' || cmd === 'go') {
    return browserLogin({ fresh: rest.includes('--fresh') || rest.includes('-f') });
  }

  if (cmd === 'cookie') return cookieLogin(rest.join(' ').trim());

  if (cmd === 'attach' || cmd === 'from-browser') return attachLogin(rest[0]);

  if (cmd === 'adopt') {
    const dev = await adoptDevice();
    console.log('已接管这台机器的设备身份');
    console.log('  设备 ID：' + dev.deviceId);
    console.log('  组织 ID：' + dev.orgId);
    console.log('');
    console.log('之后可以完全关掉桌面客户端，执行设备端： node device-worker.js');
    return 0;
  }

  if (cmd === 'enroll') {
    const i = rest.indexOf('--name');
    const dev = await enrollDevice({ name: i >= 0 ? rest[i + 1] : null });
    console.log('设备注册成功');
    console.log('  设备 ID：' + dev.deviceId);
    console.log('  组织 ID：' + dev.orgId);
    console.log('  设备名  ：' + dev.name);
    console.log('');
    console.log('现在可以启动： node device-worker.js   （设备执行端）');
    console.log('              node server.js          （OpenAI 兼容端点）');
    return 0;
  }

  if (cmd === 'logout') {
    clearAuth();
    console.log('已清除本地登录态（设备信息保留）');
    console.log('浏览器配置还在 data/browser-profile；想连它一起清掉： node login.js browser --fresh');
    return 0;
  }

  if (cmd === 'status' || cmd === '-v' || cmd === '--status') {
    await status();
    return 0;
  }

  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    help();
    return 0;
  }

  console.error(`未知命令：${cmd}`);
  console.error('');
  help();
  process.exit(2);
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error('');
    console.error('错误：' + err.message);
    if (err.code) console.error('代码：' + err.code);
    if (err.code === 'no_credentials') {
      console.error('');
      console.error('本机没有可接管的客户端设备身份，直接用登录态注册一台： node login.js enroll');
    }
    if (err.code === 'no_active_session' || err.code === 'no_client_cookie') {
      console.error('');
      console.error('浏览器里还没真正登进去（只看到匿名 cookie 也算没登）。');
      console.error('重来一次： node login.js browser    旧登录态有干扰就加 --fresh');
    }
    process.exit(1);
  });
