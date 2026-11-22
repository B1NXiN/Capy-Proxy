// 读取本机 Capy 客户端保存的设备凭据（Windows: DPAPI + Chromium OSCrypt）
// 只在本机解密、只用于本机的设备通道，不写日志、不外传。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const USER_DATA = process.env.CAPY_USER_DATA || path.join(process.env.APPDATA || '', 'Capy');

function dpapiUnprotect(b64) {
  const ps =
    `$b=[Convert]::FromBase64String('${b64}');` +
    'Add-Type -AssemblyName System.Security;' +
    `$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');` +
    '[Convert]::ToBase64String($p)';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
  });
  return Buffer.from(out.trim(), 'base64');
}

function masterKey() {
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'Local State'), 'utf8'));
  const raw = Buffer.from(state.os_crypt.encrypted_key, 'base64');
  const body = raw.subarray(raw.subarray(0, 5).toString() === 'DPAPI' ? 5 : 0);
  return dpapiUnprotect(body.toString('base64'));
}

function decryptV10(key, buf) {
  if (buf.subarray(0, 3).toString() !== 'v10') throw new Error('凭据格式不是 v10，无法解密');
  const nonce = buf.subarray(3, 15);
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(15, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

export function readCredentials() {
  const p = path.join(USER_DATA, 'device-credentials.json');
  if (!fs.existsSync(p)) {
    const err = new Error('没有找到设备凭据：请先在这台机器上登录一次 Capy 桌面客户端');
    err.code = 'no_credentials';
    throw err;
  }
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const key = masterKey();
  const out = {};
  for (const [orgId, entry] of Object.entries(j.orgs || {})) {
    out[orgId] = {
      userId: entry.userId,
      deviceId: entry.deviceId,
      secret: decryptV10(key, Buffer.from(entry.ciphertext, 'base64')).toString('utf8'),
    };
  }
  return out;
}
