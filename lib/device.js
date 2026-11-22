// 本地执行器：把 Capy 云端下发的 handler 调用翻译成这台机器上的真实操作
// 协议见 lib/tunnel.js；每个 handler 的 schema 是从客户端 main.js 里对齐来的
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const fail = (message) => ({ kind: 'failure', message, isError: true });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- Git / bash 定位 ----------
// 只按「用户自己的环境」找，顺序是：
//   1. 环境变量 CAPY_BASH（显式指定，优先）
//   2. 系统安装的 Git for Windows（Program Files / 用户级安装）
//   3. PATH 里的 git —— 用它自己的 --exec-path 推出配套的 bash
//   4. PATH 里的 bash（跳过 WSL 的 System32\bash.exe）
// 不假设任何第三方客户端、IDE 或便携版的存在，也不写死某台机器上的路径。
let bashPath = null;
let bashChecked = false;
let bashVia = null;
let gitPath = null;
let gitChecked = false;

const isWin = () => process.platform === 'win32';

function exists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

function firstExisting(list) {
  for (const p of list) if (exists(p)) return p;
  return null;
}

function whichAll(name) {
  try {
    const out = execFileSync(isWin() ? 'where' : 'which', isWin() ? [name] : ['-a', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// 标准安装位置（含 per-user 安装）
function gitRoots() {
  const roots = ['C:/Program Files/Git', 'C:/Program Files (x86)/Git'];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git'));
  if (process.env.ProgramW6432) roots.push(path.join(process.env.ProgramW6432, 'Git'));
  return roots;
}

// 从 git.exe 反推安装根目录：<root>/cmd/git.exe、<root>/bin/git.exe、<root>/mingw64/bin/git.exe
function rootOfGit(exe) {
  const dir = path.dirname(exe);
  if (/[\\/]mingw64[\\/]bin$/i.test(dir)) return path.dirname(path.dirname(dir));
  if (/[\\/](bin|cmd)$/i.test(dir)) return path.dirname(dir);
  return null;
}

function bashNearGit(exe) {
  const out = [];
  const root = rootOfGit(exe);
  if (root) out.push(path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe'));
  try {
    const ep = execFileSync(exe, ['--exec-path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (ep) {
      // <root>/mingw64/libexec/git-core → <root>
      const r = path.resolve(ep, '..', '..', '..');
      out.push(path.join(r, 'bin', 'bash.exe'), path.join(r, 'usr', 'bin', 'bash.exe'));
    }
  } catch {}
  return out;
}

export function findGit() {
  if (gitChecked) return gitPath;
  gitChecked = true;
  if (!isWin()) {
    gitPath = whichAll('git')[0] || null;
    return gitPath;
  }
  const standard = [];
  for (const r of gitRoots()) standard.push(path.join(r, 'cmd', 'git.exe'), path.join(r, 'bin', 'git.exe'));
  gitPath = firstExisting(standard) || whichAll('git').find((p) => exists(p)) || null;
  return gitPath;
}

export function findBash() {
  if (bashChecked) return bashPath;
  bashChecked = true;

  const explicit = process.env.CAPY_BASH;
  if (exists(explicit)) {
    bashVia = 'env:CAPY_BASH';
    return (bashPath = explicit);
  }

  if (!isWin()) {
    bashVia = 'system';
    return (bashPath = firstExisting(['/bin/bash', '/usr/bin/bash', '/bin/sh']));
  }

  // 1) 系统安装的 Git for Windows
  const standard = [];
  for (const r of gitRoots()) standard.push(path.join(r, 'bin', 'bash.exe'), path.join(r, 'usr', 'bin', 'bash.exe'));
  const std = firstExisting(standard);
  if (std) {
    bashVia = 'git-windows';
    return (bashPath = std);
  }

  // 2) PATH 里的 git，用与它配套的那份 bash
  const g = findGit();
  if (g) {
    const near = firstExisting(bashNearGit(g));
    if (near) {
      bashVia = 'path:git';
      return (bashPath = near);
    }
  }

  // 3) PATH 里的 bash。/Windows/System32/bash.exe 是 WSL 入口，进去是 Linux，路径对不上，跳过
  for (const p of whichAll('bash')) {
    if (/[\\/]System32[\\/]bash\.exe$/i.test(p)) continue;
    if (exists(p)) {
      bashVia = 'path:bash';
      return (bashPath = p);
    }
  }

  bashVia = null;
  return (bashPath = null);
}

// 给 /health 用：找到的 bash 以及它是怎么找到的
export function bashInfo() {
  const p = findBash();
  return { path: p, via: bashVia };
}

const LIMIT = 300_000;
const clip = (s) => (s.length > LIMIT ? s.slice(0, LIMIT) + `\n…（输出超过 ${LIMIT} 字符已截断）` : s);

// 部分便携版 Git（某些 IDE / 客户端自带的，目录结构不全）在 login shell 启动时会打一行
// "/etc/msystem: line 26: /etc/msystem.d/MSYS: No such file or directory"。
// 官方安装版没有这个问题；这行对命令结果毫无影响，去掉，免得模型误以为环境坏了。
function cleanStderr(s) {
  return s.replace(/^\/etc\/msystem(?:\.d\/\w+)?: line \d+: .*No such file or directory\r?\n?/gm, '');
}

function runBash({ command, timeoutSeconds }, cwd) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const bash = findBash();
    if (!bash) return resolve(fail('这台机器上没有 Git Bash，无法执行命令'));
    let child;
    try {
      child = spawn(bash, ['-lc', command], {
        cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
        windowsHide: true,
        env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' },
      });
    } catch (err) {
      return resolve(fail(`启动失败: ${err.message}`));
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        try {
          child.kill();
        } catch {}
      },
      Math.max(1, timeoutSeconds || 180) * 1000,
    );
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(fail(`执行失败: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        kind: 'bash',
        stdout: clip(stdout),
        stderr: clip(cleanStderr(stderr)),
        exitCode: typeof code === 'number' ? code : 1,
        durationMs: Date.now() - t0,
        timedOut,
        isError: timedOut || code !== 0,
        startedAt,
      });
    });
  });
}

// ---------- 文件 ----------
function resolvePath(p, root) {
  if (!p) throw new Error('缺少 path');
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  return abs;
}

async function readFile({ path: p, offset = 1, limit, maxChars = 20000 }, root) {
  const abs = resolvePath(p, root);
  try {
    const buf = await fsp.readFile(abs);
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    const total = lines.length;
    const from = Math.max(0, (offset || 1) - 1);
    const to = limit ? from + limit : total;
    let content = lines.slice(from, to).join('\n');
    if (content.length > maxChars) content = content.slice(0, maxChars) + `\n... (line truncated to ${maxChars} chars)`;
    return { kind: 'read', content, offset: offset || 1, totalLines: total, isError: false };
  } catch (err) {
    if (err.code === 'ENOENT') return fail(`File not found: ${p}`);
    if (err.code === 'EISDIR') return fail(`${p} 是目录，不是文件`);
    return fail(`读取失败: ${err.message}`);
  }
}

async function fileRead({ path: p }, root) {
  const abs = resolvePath(p, root);
  try {
    const buf = await fsp.readFile(abs);
    return { kind: 'read', path: abs, content: { text: buf.toString('utf8') }, sha: sha256(buf), isError: false };
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: 'missing', isError: false };
    return fail(`读取失败: ${err.message}`);
  }
}

async function fileWrite({ path: p, content = '', baseSha }, root) {
  const abs = resolvePath(p, root);
  if (baseSha !== undefined && baseSha !== null) {
    let cur = null;
    try {
      cur = sha256(await fsp.readFile(abs));
    } catch {}
    if (cur !== baseSha) return { kind: 'conflict', currentSha: cur, isError: false };
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const buf = Buffer.from(content, 'utf8');
  await fsp.writeFile(abs, buf);
  return { kind: 'written', sha: sha256(buf), bytes: buf.length, isError: false };
}

async function edit({ path: p, oldString, newString = '', replaceAll = false }, root) {
  if (oldString === newString) return fail('oldString 与 newString 相同');
  const abs = resolvePath(p, root);
  let text;
  try {
    text = await fsp.readFile(abs, 'utf8');
  } catch (err) {
    return fail(err.code === 'ENOENT' ? `File not found: ${p}` : `读取失败: ${err.message}`);
  }
  const parts = text.split(oldString);
  const hits = parts.length - 1;
  if (hits === 0) return fail('没有找到要替换的内容');
  if (hits > 1 && !replaceAll) return fail(`匹配到 ${hits} 处，需要更精确的 oldString 或 replaceAll`);
  const next = parts.join(newString);
  await fsp.writeFile(abs, next);
  return { kind: 'edit', path: abs, replacements: hits, isError: false };
}

// ---------- Git ----------
function gitExe() {
  return findGit() || 'git';
}

function git(args, cwd) {
  try {
    return execFileSync(gitExe(), args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  } catch (err) {
    return err.stdout?.toString?.() ?? '';
  }
}

function gitFacts({ dir, base }, root) {
  const cwd = dir ? resolvePath(dir, root) : root;
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) || '').trim() || 'HEAD';
  const dirty = (git(['status', '--porcelain'], cwd) || '').trim().length > 0;
  let ahead = 0;
  if (base) {
    const n = (git(['rev-list', '--count', `${base}..HEAD`], cwd) || '').trim();
    ahead = Number(n) || 0;
  }
  const localBranches = (git(['branch', '--format=%(refname:short)'], cwd) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { kind: 'git_facts', branch, base, dirty, ahead, localBranches, isError: false };
}

// ---------- 工作区 ----------
// 云端拿 created 判断「是新建的」还是「已经存在、去读它的快照」。
// 总回 false 会让它以为 worktree 早就存在、反复去要快照，于是卡死在准备阶段。
async function worktreeEnsure({ root: r }, ctx) {
  const abs = r || ctx.root;
  const existed = fs.existsSync(path.join(abs, '.git'));
  await fsp.mkdir(abs, { recursive: true });
  if (!existed) {
    // 准备成一个可用的 git 工作区，后续 capture / diff 才有东西可读
    try {
      execFileSync(gitExe(), ['init', '-q'], { cwd: abs, stdio: 'ignore', timeout: 20000 });
      execFileSync(gitExe(), ['-c', 'user.name=capy', '-c', 'user.email=capy@local', 'commit', '-q', '--allow-empty', '-m', 'init'], {
        cwd: abs,
        stdio: 'ignore',
        timeout: 20000,
      });
    } catch {}
  }
  ctx.root = abs;
  return { root: abs, created: !existed, checkouts: [] };
}

async function worktreeList({ roots = [] }, ctx) {
  return { kind: 'worktree_list', entries: [], dirtySkipped: false };
}

// ---------- 主表 ----------
export function createDevice({ root, log = () => {} }) {
  const ctx = { root: root || path.join(os.homedir(), '.capy', 'worktrees') };

  const table = {
    bash: (p) => runBash(p, ctx.root),
    read: (p) => readFile(p, ctx.root),
    file_read: (p) => fileRead(p, ctx.root),
    file_write: (p) => fileWrite(p, ctx.root),
    edit: (p) => edit(p, ctx.root),
    apply_patch: (p) => runBash({ command: `git apply - <<'PATCH'\n${p.patch || ''}\nPATCH`, timeoutSeconds: 60 }, ctx.root),
    git_facts: (p) => gitFacts(p, ctx.root),
    worktree_ensure: (p) => worktreeEnsure(p, ctx),
    worktree_list: (p) => worktreeList(p, ctx),

    // 命令是同步跑的，没有后台 operation 可查
    bash_output: () => ({ kind: 'not-running' }),

    // 云端会问一次监听端口，本机不代理端口，如实回空
    ports: () => ({ kind: 'ports', ports: [] }),

    // 云盘 / drive：这台机器不挂载，如实回「没有」
    volume_prepare: (p) => ({
      kind: 'volume_prepare',
      root: p.root || ctx.root,
      mounts: [],
      landing: false,
      checkpoints: false,
      bundleBatches: false,
      legacyRootExists: false,
      held: [],
      kept: [],
    }),
    volume_probe: (p) => ({
      kind: 'volume_probe',
      mounts: (p.mounts || []).map((m) => ({ mountPath: m.mountPath, state: 'stale' })),
    }),
    volume_landed: (p) => ({
      kind: 'volume_landed',
      // 本机不接管云端网盘：直接回报「已是最新」，云端就不会一直重推文件
      mounts: (p.mounts || []).map((m) => ({ mountPath: m.mountPath, current: true })),
      landing: false,
      checkpoints: false,
      directories: [],
      unretained: [],
      handback: false,
    }),
    drive_status: () => fail('这台机器没有挂载 Capy Drive'),
  };

  return {
    get root() {
      return ctx.root;
    },
    set root(v) {
      ctx.root = v;
    },
    async invoke(handler, params = {}) {
      const fn = table[handler];
      if (!fn) {
        log('未实现的 handler:', handler);
        return fail(`handler "${handler}" 在这台机器上没有实现`);
      }
      try {
        return await fn(params);
      } catch (err) {
        log('handler 出错', handler, err.message);
        return fail(`${handler}: ${err.message}`);
      }
    },
  };
}
