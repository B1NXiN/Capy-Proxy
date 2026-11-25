#!/usr/bin/env node
// start.bat 的前置步骤：检查登录 → 需要时弹菜单登录 → 确认本机设备身份。
// 只做「准备好」，不负责起服务；起服务仍由 start.bat 完成。
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAuth, loadDevice, getJwt, whoAmI, saveAuth } from './lib/auth.js';
import { bashInfo } from './lib/device.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
})();

const say = (s = '') => console.log(s);
const ok = (s) => console.log('   [OK] ' + s);
const warn = (s) => console.log('   [!]  ' + s);
const bad = (s) => console.log('   [X]  ' + s);

// /health 里那几个英文标识，在这里翻成人话
const VIA_TEXT = {
  'env:CAPY_BASH': '手动指定',
  'git-windows': 'Git for Windows',
  'path:git': 'PATH 里的 git',
  'path:bash': 'PATH 里的 bash',
  system: '系统自带',
};

// ---------- 小工具 ----------
function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: HERE, stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code === 0 ? 0 : 1));
  });
}

// stdin 只在这一个提问期间被 readline 占用，问完立刻释放，好让子进程（登录脚本）接管输入。
// 返回 null 表示输入流已经关闭（Ctrl+C / 管道 EOF），调用方据此当成「退出」。
async function ask(promptText) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      rl.once('close', () => done(null));
      rl.question(promptText).then((v) => done(String(v).trim()), () => done(null));
    });
  } finally {
    rl.close();
  }
}

// ---------- 登录状态 ----------
async function checkAuth() {
  const auth = loadAuth();
  if (!auth) return { state: 'none' };
  try {
    await getJwt({ force: true }); // 用 cookie 换一次新 token，能换到就是活的
    return { state: 'ok', auth };
  } catch (e) {
    return { state: 'expired', auth, error: e };
  }
}

async function loginMenu() {
  for (;;) {
    say('');
    say('   请选择：');
    say('');
    say('     1  打开浏览器登录   窗口里登进 capy.ai，登录完成后自动继续（推荐）');
    say('     0  退出');
    say('');
    const a = await ask('   输入 1 / 0 后回车： ');

    if (a === null) return false; // 输入流关闭，当作退出
    if (a === '') continue; // 空回车，重新显示菜单
    if (a === '0' || a.toLowerCase() === 'q') return false;

    if (a === '1') {
      say('');
      const code = await runNode(['login.js', 'browser']);
      if (code === 0) return true;
      bad('登录没有完成（窗口被关掉或等待超时），可以再试一次。');
      continue;
    }

    warn('请输入 1 或 0。');
  }
}

// ---------- 设备身份 ----------
async function ensureDevice(orgId) {
  const dev = loadDevice();
  const usable = Boolean(dev?.deviceId && dev?.token);
  const sameOrg = !orgId || !dev?.orgId || dev.orgId === orgId;

  if (usable && sameOrg) {
    ok('执行设备：' + String(dev.deviceId).slice(0, 26) + '…（本机）');
    return true;
  }

  if (usable && !sameOrg) warn('已有设备身份属于另一个组织（换过账号？），重新注册…');
  else warn('这台机器还没有设备身份，用当前登录态直接注册一台…');

  // 首选：登录态自己注册，不需要 Capy 客户端（arch 枚举要用 x86_64，见 lib/auth.js）
  let code = await runNode(['login.js', 'enroll']);
  if (code === 0) return true;

  warn('自己注册没成功，改为尝试接管本机客户端已注册的设备…');
  code = await runNode(['login.js', 'adopt']);
  if (code === 0) return true;

  bad('这台机器拿不到设备身份。');
  say('');
  say('   先确认登录态有效： node login.js status');
  say('   仍然不行就重登一次： node login.js browser --fresh');
  return false;
}

// ---------- 端口占用（重复双击 start.bat 时直接说清楚，别让它 EADDRINUSE 崩掉） ----------
function portBusy(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    return out
      .split(/\r?\n/)
      .some((l) => new RegExp(`[:.]${port}\\s`).test(l) && /LISTENING/i.test(l));
  } catch {
    return false;
  }
}

// ---------- 主流程 ----------
async function prepare({ relogin = false } = {}) {
  const port = Number(CONFIG.port) || 8787;
  if (portBusy(port)) {
    say('');
    warn(`端口 ${port} 已经被占用：这台机器上已经有一个 capy-relay 在跑。`);
    say('       要么关掉那个窗口（连同最小化的 capy-device 窗口）再来，');
    say('       要么改 config.json 里的 port 用另一个端口。');
    return 1;
  }

  say('');
  say('   ---- 账号 ----');

  let st = await checkAuth();

  if (st.state === 'ok' && !relogin) {
    ok('已登录：' + (st.auth.email || st.auth.userId || '（未知账号）'));
  } else {
    if (st.state === 'expired') warn('本地登录会话已过期，需要重新登录');
    else if (st.state === 'ok' && relogin) warn('按要求重新登录');
    else say('   这台机器还没有登录过 Capy 账号。');

    const done = await loginMenu();
    if (!done) {
      say('');
      say('   已取消，未启动服务。');
      return 1;
    }

    st = await checkAuth();
    if (st.state !== 'ok') {
      bad('登录没有成功。');
      return 1;
    }
    ok('已登录：' + (st.auth.email || st.auth.userId || '（未知账号）'));
  }

  // 服务端建线程需要组织 ID，缺了就现取一次
  let orgId = st.auth.orgId || null;
  if (!orgId) {
    const me = await whoAmI().catch(() => null);
    if (me?.orgId) {
      saveAuth({ orgId: me.orgId });
      orgId = me.orgId;
    }
  }
  if (orgId) say('   组织 ID：' + orgId);

  say('');
  say('   ---- 执行设备 ----');
  if (!(await ensureDevice(orgId))) return 1;

  say('');
  say('   ---- 本机环境 ----');
  const shell = bashInfo();
  if (shell.path) ok('命令执行：可用（' + (VIA_TEXT[shell.via] || shell.via) + '）');
  else {
    warn('没有找到 Git Bash：它只能读写文件，不能执行命令。');
    say('       装一个 Git for Windows 就好： https://git-scm.com/download/win');
  }

  say('');
  return 0;
}

const args = process.argv.slice(2);
const relogin = args.some((a) => /^(-r|--relogin|login|switch|relogin)$/i.test(a));

prepare({ relogin })
  .then((code) => process.exit(code))
  .catch((err) => {
    bad(err.message);
    process.exit(1);
  });
