// realtime 网关：订阅一轮 jam，拿到逐字增量。
//
// 为什么要这个：HTTP 的 /jams/{id}/events 只在回合结束才多出一条 assistant 事件，
// 轮询它最多只能「憋完再吐」。真正的 token 流在 realtime websocket 上：
//   → {type:'auth', token}
//   → {type:'subscribe', scopes:['jam:<id>']}
//   ← {type:'delta', jamId, delta:{type:'llm-event', event:{type:'text-delta'|'reasoning-delta', text}}}
// 协议来自客户端 bundle（Realtime.ClientMessage / LLM.Event.*）。
import { getJwt } from './auth.js';

const DEFAULT_URL = process.env.CAPY_REALTIME_URL || 'wss://realtime-production.cloud.capy.ai/realtime';

// 从一段可能还没传完的 JSON 里读出某个字符串字段当前的值。
// tool-input-delta 的 text 是 JSON 片段，拼到一半就解析会报错，所以自己扫。
function readJsonStringField(src, field) {
  const key = `"${field}"`;
  for (let at = src.indexOf(key); at >= 0; at = src.indexOf(key, at + 1)) {
    let i = at + key.length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== ':') continue;
    i++;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '"') continue;

    let out = '';
    let j = i + 1;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '"') return out;
      if (ch === '\\') {
        const nx = src[j + 1];
        if (nx === undefined) return out; // 转义符还没传完
        if (nx === 'u') {
          const hex = src.slice(j + 2, j + 6);
          if (hex.length < 4) return out;
          out += String.fromCharCode(parseInt(hex, 16));
          j += 6;
          continue;
        }
        const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
        out += map[nx] ?? nx;
        j += 2;
        continue;
      }
      out += ch;
      j++;
    }
    return out; // 字符串还没结束，返回当前已有的部分
  }
  return null;
}

async function openSocket(url, headers) {
  if (typeof WebSocket !== 'undefined') return new WebSocket(url, { headers });
  const { default: WS } = await import('ws');
  return new WS(url, { headers });
}

/**
 * 订阅一轮 jam 的实时增量。
 * @param {object} opts
 * @param {string} opts.jamId
 * @param {(text:string)=>void} [opts.onText]        可见正文增量
 * @param {(text:string)=>void} [opts.onReasoning]   思考（reasoning）增量
 * @param {(info:object)=>void} [opts.onTool]        工具调用阶段变化
 * @param {(info:object)=>void} [opts.onEnd]         回合结束
 * @param {(err:Error)=>void}   [opts.onError]
 * @param {()=>boolean}         [opts.shouldStop]
 * @param {(msg:string,...a:any[])=>void} [opts.log]
 */
export function openJamStream({ jamId, onText, onReasoning, onTool, onEnd, onError, shouldStop, log = () => {} }) {
  let ws = null;
  let closed = false;
  let authed = false;
  let ended = false;
  let authTimer = null;
  // message_user 的正文是 tool-input-delta 里的 JSON 片段，按字段增量解出来
  const toolJson = new Map();
  const toolEmitted = new Map();

  const send = (obj) => {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch {}
  };

  const auth = async (force = false) => {
    try {
      const t0 = Date.now();
      const jwt = await getJwt({ force });
      if (closed) return;
      send({ type: 'auth', token: jwt });
      authed = true;
      send({ type: 'subscribe', scopes: [`jam:${jamId}`] });
      log('realtime: subscribed jam', jamId, `| 取 token ${Date.now() - t0}ms`);
    } catch (err) {
      log('realtime: 鉴权失败', err.message);
      onError?.(err);
    }
  };

  const handleLlmEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'reasoning-delta':
        if (ev.text) onReasoning?.(ev.text);
        break;
      case 'text-delta':
        if (ev.text) onText?.(ev.text);
        break;
      case 'tool-input-start':
        toolJson.set(ev.id, '');
        toolEmitted.set(ev.id, '');
        onTool?.({ phase: 'forming', name: ev.name, id: ev.id });
        break;
      case 'tool-input-delta': {
        const key = ev.id;
        const buf = (toolJson.get(key) || '') + (ev.text || '');
        toolJson.set(key, buf);
        // 只把「说给用户看的那句」当正文；其它工具（bash/read…）不算回复
        if (ev.name === 'message_user') {
          const cur = readJsonStringField(buf, 'text');
          const already = toolEmitted.get(key) || '';
          if (typeof cur === 'string' && cur.length > already.length && cur.startsWith(already)) {
            toolEmitted.set(key, cur);
            onText?.(cur.slice(already.length));
          }
        }
        break;
      }
      case 'tool-call':
        onTool?.({ phase: 'running', name: ev.name, id: ev.id });
        // 兜底：工具入参完整了，把可能没解析出来的正文补上
        if (ev.name === 'message_user') {
          let text = null;
          try {
            text = typeof ev.input === 'string' ? JSON.parse(ev.input)?.text : ev.input?.text;
          } catch {}
          const already = toolEmitted.get(ev.id) || '';
          if (typeof text === 'string' && text.length > already.length && text.startsWith(already)) {
            toolEmitted.set(ev.id, text);
            onText?.(text.slice(already.length));
          }
        }
        break;
      case 'tool-result':
        onTool?.({ phase: 'done', id: ev.id });
        break;
      case 'finish':
        onEnd?.({ reason: ev.reason || 'stop' });
        ended = true;
        break;
      default:
        break;
    }
  };

  const handleDelta = (d) => {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'llm-event') return handleLlmEvent(d.event);
    if (d.type === 'turn-start') return onTool?.({ phase: 'turn-start' });
    if (d.type === 'turn-end') return onEnd?.({ outcome: d.outcome || 'settled' });
    if (d.type === 'run-end') return onEnd?.({ outcome: 'run-end', status: d.status });
    if (d.type === 'tool-activity' || d.type === 'run-start' || d.type === 'compaction-start') return;
  };

  const start = async () => {
    const t0 = Date.now();
    try {
      ws = await openSocket(DEFAULT_URL, { origin: 'https://capy.ai' });
    } catch (err) {
      onError?.(err);
      return;
    }
    ws.onopen = () => {
      if (closed) return ws.close?.();
      log('realtime: 连上网关', `${Date.now() - t0}ms`);
      auth();
      // JWT 只有 60 秒；长回合里续一次，避免中途被踢
      authTimer = setInterval(() => {
        if (ended || closed) return;
        auth(true);
      }, 45_000);
      authTimer.unref?.();
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'delta') return handleDelta(msg.delta);
      if (msg.type === 'subscribed') return log('realtime: 订阅确认');
      if (msg.type === 'error') {
        log('realtime: 网关报错', JSON.stringify(msg).slice(0, 200));
        return onError?.(new Error(msg.message || 'realtime error'));
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (!closed && !ended && !shouldStop?.()) log('realtime: 连接断开（会退回轮询补偿）');
    };
  };

  start();

  return {
    close() {
      closed = true;
      if (authTimer) clearInterval(authTimer);
      try {
        ws?.close?.();
      } catch {}
    },
    get authed() {
      return authed;
    },
  };
}
