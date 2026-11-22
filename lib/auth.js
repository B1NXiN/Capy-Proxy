// 自持登录：邮箱验证码登录 Clerk，换 JWT；用 JWT 注册设备，拿设备令牌。
// 全程不需要 Capy 桌面客户端运行。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.CAPY_RELAY_DATA || path.join(HERE, '..', 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const PENDING_FILE = path.join(DATA_DIR, 'login-pending.json');
const DEVICE_FILE = path.join(DATA_DIR, 'device.json');

const CLERK = process.env.CAPY_CLERK_BASE || 'https://clerk.capy.ai';
const APP_BASE = process.env.CAPY_APP_BASE || 'https://api.capy.ai/app';
const CLERK_JS = '5.50.0';

// /app 侧要带客户端标识，否则广告版免费模型会被拒
const APP_HEADERS = {
  'x-capy-client-surface': 'desktop',
  'x-capy-client-features': 'message-edit,visual,ads-models',
};

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return data;
}

// ---------- cookie jar ----------
function absorb(jar, res) {
  const list = res.headers.getSetCookie?.() ?? [];
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i < 1) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!value || /max-age=0\b/i.test(c)) delete jar[name];
    else jar[name] = value;
  }
  return jar;
}

function jarHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function clerkCall(jar, pathname, { method = 'POST', form, json } = {}) {
  const url = new URL(CLERK + pathname);
  url.searchParams.set('_clerk_js_version', CLERK_JS);
  const headers = {
    origin: 'https://capy.ai',
    referer: 'https://capy.ai/',
    accept: 'application/json',
  };
  if (jarHeader(jar)) headers.cookie = jarHeader(jar);
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(url, { method, headers, body });
  absorb(jar, res);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok || data?.errors?.length) {
    const err = new Error(data?.errors?.[0]?.message || `Clerk ${method} ${pathname} → ${res.status}`);
    err.code = data?.errors?.[0]?.code || `clerk_${res.status}`;
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

// 给外部（浏览器登录流程）复用的 Clerk 调用
export async function clerkGet(jar, pathname) {
  return clerkCall(jar, pathname, { method: 'GET' });
}

export async function clerkPost(jar, pathname, form) {
  return clerkCall(jar, pathname, { method: 'POST', form });
}

async function appCall(jwt, pathname, { method = 'GET', body } = {}) {  const res = await fetch(`${APP_BASE}${pathname}`, {
    method,
    headers: {
      ...APP_HEADERS,
      authorization: `Bearer ${jwt}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `${method} ${pathname} → ${res.status}`);
    err.code = data?.code || `app_${res.status}`;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- 本地会话 ----------
export function loadAuth() {
  const a = readJson(AUTH_FILE);
  if (!a?.jar || !a?.sessionId) return null;
  return a;
}

export function saveAuth(patch) {
  const cur = loadAuth() || {};
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  writeJson(AUTH_FILE, next);
  return next;
}

export function clearAuth() {
  try {
    fs.unlinkSync(AUTH_FILE);
  } catch {}
}

let jwtCache = { jwt: null, at: 0 };

// 用保存的 cookie 换一个新的 session token（Clerk 的 JWT 只有 60 秒）
export async function getJwt({ force = false } = {}) {
  if (!force && jwtCache.jwt && Date.now() - jwtCache.at < 45_000) return jwtCache.jwt;
  const auth = loadAuth();
  if (!auth) {
    const err = new Error('还没有登录：先运行 node login.js 完成一次登录');
    err.code = 'no_auth';
    throw err;
  }
  const jar = { ...auth.jar };
  const data = await clerkCall(jar, `/v1/client/sessions/${auth.sessionId}/tokens`);
  const jwt = data?.jwt;
  if (!jwt) {
    const err = new Error('登录会话已失效，需要重新运行 node login.js');
    err.code = 'session_expired';
    throw err;
  }
  // cookie 可能被轮换，落盘保留最新
  if (JSON.stringify(jar) !== JSON.stringify(auth.jar)) saveAuth({ jar });
  jwtCache = { jwt, at: Date.now() };
  return jwt;
}

export function jwtClaims(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// ---------- 步骤 1：发验证码 ----------
export async function startLogin(email) {
  const jar = {};
  const client = await clerkCall(jar, '/v1/client', { method: 'POST' });
  const signIn = await clerkCall(jar, '/v1/client/sign_ins', { form: { identifier: email } });

  const supported = (signIn?.supported_first_factors || []).map((f) => f.strategy);
  const response = signIn?.response || signIn;
  const status = response?.status || signIn?.status;

  writeJson(PENDING_FILE, {
    email,
    jar,
    signInId: response?.id || signIn?.id || null,
    supported,
    clientId: client?.response?.id || client?.id || null,
    at: Date.now(),
  });

  return { email, status, supported, signInId: response?.id || null };
}

// ---------- 步骤 2：校验验证码，拿会话 ----------
export async function finishLogin(code) {
  const pending = readJson(PENDING_FILE);
  if (!pending) {
    const err = new Error('没有待完成的登录：先执行 node login.js start <邮箱>');
    err.code = 'no_pending';
    throw err;
  }
  const jar = pending.jar || {};
  const data = await clerkCall(jar, '/v1/client/sign_ins/attempt_first_factor', {
    form: { strategy: 'email_code', code: String(code).trim() },
  });

  const si = data?.response || data?.sign_in || data;
  const status = si?.status;
  const sessionId =
    si?.created_session_id || si?.createdSessionId || data?.client?.last_active_session_id || null;

  if (status !== 'complete' || !sessionId) {
    const err = new Error(`登录未完成（status=${status || '未知'}），请重新获取验证码`);
    err.code = 'incomplete';
    err.payload = { status, supported: si?.supported_first_factors?.map((f) => f.strategy) };
    throw err;
  }

  // 换一次 JWT，确认链路通
  const tok = await clerkCall(jar, `/v1/client/sessions/${sessionId}/tokens`);
  const jwt = tok?.jwt;
  if (!jwt) throw new Error('拿到了会话但换不到 token');

  const claims = jwtClaims(jwt);
  const auth = saveAuth({
    email: pending.email,
    jar,
    sessionId,
    userId: claims.sub || null,
    jwt,
    jwtExp: claims.exp || null,
  });
  jwtCache = { jwt, at: Date.now() };
  try {
    fs.unlinkSync(PENDING_FILE);
  } catch {}
  return auth;
}

// ---------- 步骤 3：注册设备 ----------
function osName() {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

export async function enrollDevice({ name } = {}) {
  const jwt = await getJwt();
  const host = os.hostname();
  const body = {
    name: name || `capy-relay@${host}`,
    hostname: host,
    os: osName(),
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  };
  const res = await appCall(jwt, '/devices/enroll', { method: 'POST', body });
  const deviceId = res?.device?.id || res?.deviceId;
  const token = res?.token;
  const orgId = res?.orgId || res?.device?.orgId;
  if (!deviceId || !token) {
    throw new Error(`注册设备返回不完整：${JSON.stringify(res).slice(0, 200)}`);
  }
  const saved = writeJson(DEVICE_FILE, {
    orgId,
    deviceId,
    token,
    name: body.name,
    hostname: host,
    os: body.os,
    arch: body.arch,
    enrolledAt: new Date().toISOString(),
  });
  return saved;
}

export function loadDevice() {
  return readJson(DEVICE_FILE);
}

export function deviceFile() {
  return DEVICE_FILE;
}

// 一次性接管：把桌面客户端已注册的设备身份复制到 data/device.json
// 之后客户端可以永久不再启动，设备通道由 device-worker.js 自己维持
export async function adoptDevice() {
  const { readCredentials } = await import('./credentials.js');
  const creds = readCredentials();
  const [orgId, entry] = Object.entries(creds)[0] || [];
  if (!entry?.deviceId) {
    const err = new Error('没有找到可接管的设备身份：这台机器上还没有登录过 Capy 客户端');
    err.code = 'no_credentials';
    throw err;
  }
  const dev = writeJson(DEVICE_FILE, {
    orgId,
    deviceId: entry.deviceId,
    token: entry.secret,
    name: `capy-relay@${os.hostname()}`,
    hostname: os.hostname(),
    os: osName(),
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    source: 'adopted-from-desktop',
    adoptedAt: new Date().toISOString(),
  });
  return dev;
}

// 设备身份：优先用自己注册的，没有才回退桌面客户端保存的凭据
export async function resolveDeviceIdentity() {
  const dev = loadDevice();
  if (dev?.deviceId && dev?.token) {
    let orgId = dev.orgId;
    if (!orgId) {
      const me = await whoAmI().catch(() => null);
      orgId = me?.orgId || null;
      if (orgId) writeJson(DEVICE_FILE, { ...dev, orgId });
    }
    return { orgId, deviceId: dev.deviceId, secret: dev.token, source: 'login', name: dev.name };
  }
  const { readCredentials } = await import('./credentials.js');
  const creds = readCredentials();
  const [orgId, entry] = Object.entries(creds)[0] || [];
  if (!entry) {
    const err = new Error('没有可用的设备身份：运行 node login.js 登录并 enroll，或先在这台机器上登录一次 Capy 客户端');
    err.code = 'no_credentials';
    throw err;
  }
  return { orgId, deviceId: entry.deviceId, secret: entry.secret, source: 'desktop-credentials' };
}

export function authFile() {
  return AUTH_FILE;
}

// 账号在 Capy 侧的状态：登录（Clerk）和账号（Capy app）是两件事。
// 登录会话有效、JWT 也能换，但 app 层可能返回 403 capy/AccountSuspended，
// 这时候所有业务接口（含设备隧道握手）都会被拒，重连再多次也没用。
export async function accountStatus() {
  try {
    const jwt = await getJwt();
    const res = await fetch(`${APP_BASE}/me`, {
      headers: { ...APP_HEADERS, authorization: `Bearer ${jwt}`, accept: 'application/json' },
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    let tag = null;
    try {
      tag = JSON.parse(text)?._tag || null;
    } catch {}
    return { ok: false, status: res.status, tag, suspended: tag === 'capy/AccountSuspended' };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code || null };
  }
}

// ---------- 组织信息 ----------
export async function whoAmI() {
  const jwt = await getJwt();
  const me = await appCall(jwt, '/me').catch(() => null);
  let orgId = me?.orgId || me?.organization?.id || me?.orgs?.[0]?.id || null;
  if (!orgId) {
    const orgs = await appCall(jwt, '/orgs').catch(() => null);
    const arr = Array.isArray(orgs) ? orgs : orgs?.items || orgs?.orgs || [];
    orgId = arr[0]?.id || null;
  }
  const claims = jwtClaims(jwt);
  return { me, orgId, userId: claims.sub || me?.userId || null, claims };
}
