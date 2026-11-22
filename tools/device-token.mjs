// 解密本机 Capy 客户端保存的设备凭据（仅用于本机自建 device worker）
// Windows: Chromium OSCrypt = DPAPI(masterKey) + AES-256-GCM(v10 前缀密文)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const USER_DATA = process.env.CAPY_USER_DATA || path.join(process.env.APPDATA || '', 'Capy');

function dpapiUnprotect(b64) {
  const ps = `$b=[Convert]::FromBase64String('${b64}');` +
    `Add-Type -AssemblyName System.Security;` +
    `$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');` +
    `[Convert]::ToBase64String($p)`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
  });
  return Buffer.from(out.trim(), 'base64');
}

export function masterKey() {
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'Local State'), 'utf8'));
  const raw = Buffer.from(state.os_crypt.encrypted_key, 'base64');
  const body = raw.subarray(raw.subarray(0, 5).toString() === 'DPAPI' ? 5 : 0);
  return dpapiUnprotect(body.toString('base64'));
}

export function decryptV10(key, buf) {
  // v10 | 12B nonce | ciphertext | 16B tag
  const nonce = buf.subarray(3, 15);
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(15, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

export function readCredentials() {
  const p = path.join(USER_DATA, 'device-credentials.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const key = masterKey();
  const out = {};
  for (const [orgId, entry] of Object.entries(j.orgs || {})) {
    const plain = decryptV10(key, Buffer.from(entry.ciphertext, 'base64')).toString('utf8');
    out[orgId] = { userId: entry.userId, deviceId: entry.deviceId, secret: plain };
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const all = readCredentials();
  for (const [orgId, v] of Object.entries(all)) {
    let shape = 'unknown';
    try {
      const j = JSON.parse(v.secret);
      shape = 'json keys=' + Object.keys(j).join(',');
      const masked = {};
      for (const [k, val] of Object.entries(j)) masked[k] = typeof val === 'string' ? `${val.slice(0, 6)}…(${val.length})` : typeof val;
      console.log(orgId, '|', v.deviceId, '|', shape);
      console.log('   ', JSON.stringify(masked));
    } catch {
      console.log(orgId, '|', v.deviceId, '| 明文', `${v.secret.slice(0, 6)}…(${v.secret.length})`, '| 非 JSON');
    }
  }
}
