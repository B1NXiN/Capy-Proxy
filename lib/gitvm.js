// 设备端的 git 侧写接口（云端会调 /v1/git/*）
//
// 云端把设备当成一台「机器服务」，每个响应都是 { status, body } 信封：
//   { "status": 200, "body": { ... } }
// 注意 body 必须是「对象」，不是字符串化的 JSON —— 否则云端取 body 时拿到的是字符串，
// 校验会报 invalid snapshot: Missing key at ["status"]。
//
// 我们这个执行端不接管用户的 git 仓库，所以这份状态是「本机没有任何受管仓库」的空快照：
// repos 为空、没有待上传的 overlay。这样云端不会去等一个永远不来的快照。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findGit } from './device.js';

const EPOCH = `e${Date.now().toString(36)}`;
let seq = 0;
const touched = new Map(); // repo -> { repo, branch, head, dirtyPaths }

function git(args, cwd) {
  try {
    return execFileSync(findGit() || 'git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
  } catch {
    return '';
  }
}

function inspect(root) {
  const repo = path.resolve(root);
  if (!fs.existsSync(path.join(repo, '.git'))) return null;
  const head = git(['rev-parse', 'HEAD'], repo) || null;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo) || null;
  const tree = head ? git(['rev-parse', 'HEAD^{tree}'], repo) || null : null;
  const dirtyPaths = (git(['status', '--porcelain'], repo) || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .slice(0, 500);
  return { repo, branch, head, tree, upstream: null, dirtyPaths };
}

function state() {
  return { epoch: EPOCH, seq, repos: Array.from(touched.values()) };
}

function capture(body, root) {
  const wanted = Array.isArray(body?.repos) && body.repos.length ? body.repos : [root];
  for (const r of wanted) {
    if (typeof r !== 'string' || !r) continue;
    const info = inspect(r);
    if (info) touched.set(info.repo, info);
  }
  seq += 1;
  return state();
}

const envelope = (payload) => JSON.stringify({ status: 'succeeded', ...payload });
const failure = (code, message) => JSON.stringify({ status: 'failed', code, message });

// 返回 null 表示这个路径不归我们管；返回字符串即最终 HTTP body
export function handleGitRoute(method, rawPath, body, root) {
  let url;
  try {
    url = new URL(rawPath, 'http://device');
  } catch {
    return null;
  }
  if (!url.pathname.startsWith('/v1/git/')) return null;
  const name = url.pathname.slice('/v1/git/'.length);

  switch (name) {
    case 'state':
      return envelope(state());
    case 'events':
      // 没有新事件：让云端立刻拿到空批次，不要让它等到超时
      return envelope({ epoch: EPOCH, events: [] });
    case 'capture':
      return envelope(capture(body, root));
    case 'log':
      return envelope({ entries: [] });
    case 'diff':
    case 'patch':
      return envelope({ from: '', to: '', entries: [], truncated: false });
    case 'files':
      return envelope({ entries: [], truncated: false });
    case 'blob':
      return failure('Vm.NotFound', 'Unknown repo, object, or unresolvable pair');
    case 'resolve':
    case 'merge-base':
      return failure('Vm.NotFound', 'Unknown repo, object, or unresolvable pair');
    default:
      return null;
  }
}
