// Capy device tunnel 客户端（自建执行载体用）
//
// 协议来源：Capy 客户端 app.asar 里的 out/main/main.js（sne / Nw / ene / tne）。
// 帧分两种：
//   - 文本帧：JSON 控制帧（hello / session-config / ready / open / response / close / reset / credit / ping / pong）
//   - 二进制帧：4 字节大端 streamId + 1..65536 字节负载
//
// 对端会按下面的规则校验我们发的东西，违反任意一条就会被判协议违规并断开：
//   · 数据帧 streamId 不能是 0，块长度 1..65536，不能为空
//   · 流 id 有奇偶归属（device 侧开奇数流，gateway 侧开偶数流）
//   · 发送必须落在两条窗口内：连接级 2MB、单流 256KB
//   · 必须先发 response 才能发数据，发过 close 之后不能再发
//   · credit 的 bytes ≥ 1 且不能把窗口补爆
//   · 控制帧序列化后不能超过 65536 字节
import os from 'node:os';

const CHUNK = 65536;
const STREAM_WINDOW = 262144; // 单流窗口（客户端 _re = 262144）
const TOTAL_WINDOW = 2097152; // 连接级窗口（客户端 Tre = 2097152）
const MAX_STREAMS = 256;

export class Tunnel {
  constructor({ url, token, deviceId, worktreeBase, clientVersion = '0.1.0', log = () => {} }) {
    this.url = url;
    this.token = token;
    this.deviceId = deviceId;
    this.worktreeBase = worktreeBase || '';
    this.clientVersion = clientVersion;
    this.log = log;
    this.ws = null;
    this.streams = new Map();
    this.nextId = 1; // device 侧主动开流用奇数（本程序目前只做响应方，保留）
    this.budget = TOTAL_WINDOW;
    this.waiters = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = '';
    this.pingTimer = null;
    this.onRequest = null; // async (req) => {status, headers, body}
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: { authorization: `Bearer ${this.token}` } });
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('tunnel 连接失败')));
      ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
      ws.addEventListener('close', (ev) => {
        this.closed = true;
        this.closeCode = ev.code;
        this.closeReason = ev.reason || '';
        this.#stopHeartbeat();
        this.#wakeAll();
        this.log('tunnel 关闭', ev.code, this.closeReason);
      });
    });

    this.#control({
      type: 'hello',
      contractVersion: 2,
      deviceId: this.deviceId,
      hostname: os.hostname(),
      os: process.platform === 'win32' ? 'win32' : process.platform,
      workspaces: [],
      worktreeBase: this.worktreeBase,
      clientVersion: this.clientVersion,
      drive: false,
    });
    // 客户端每 10 秒主动 ping（协议里的 Hne = 1e4）。
    // 只被动回 pong 的话，对端等不到心跳会按空闲超时踢人，
    // 表现就是「连上几十秒 → 莫名断开 → 重连」。
    this.#startHeartbeat();
    return this;
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === 1) this.#control({ type: 'ping' });
    }, 10000);
    this.pingTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  #send(frame) {
    if (this.ws?.readyState === 1) this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  #control(frame) {
    const s = JSON.stringify(frame);
    if (Buffer.byteLength(s) > 65536) throw new Error(`控制帧超限: ${frame.type}`);
    this.#send(s);
  }

  // ---------- 接收 ----------
  #onMessage(data) {
    if (typeof data === 'string') return this.#onControl(data);
    const buf = Buffer.from(data);
    if (buf.length < 5) return; // 4 字节 id + 至少 1 字节负载，否则是截断帧
    const streamId = buf.readUInt32BE(0);
    const payload = buf.subarray(4);
    if (streamId === 0 || payload.length === 0) return; // 协议禁止的两种帧，直接丢

    const st = this.streams.get(streamId);
    if (!st) {
      // 已关闭流的尾巴：把字节还给连接级窗口就行，不要让它把总窗口吃掉
      this.#control({ type: 'credit', streamId: 0, bytes: payload.length });
      return;
    }

    // 单流接收上限 256KB（对方 sendWindow 的初始值）。超过就按协议 reset。
    // 注意 received 记的是「已收未确认」的量：下面每块都会立即确认并清零，
    // 所以这里只会在单帧本身超限时触发，不会把正常的长流误判成溢出。
    st.received += payload.length;
    if (st.received > STREAM_WINDOW) {
      this.#control({ type: 'reset', streamId, reason: 'overflow' });
      this.#control({ type: 'credit', streamId: 0, bytes: payload.length });
      if (st.resolveBody && !st.bodyClosed) {
        st.bodyClosed = true;
        st.resolveBody(Buffer.concat(st.inbound));
      }
      this.#releaseStream(st);
      return;
    }

    const ack = st.received;
    st.received = 0;
    // 消费即归还，两条都要发：
    //   流级 —— 不回的话对方发满 256KB 就再也发不动（大响应/长流式卡死的根因）
    //   连接级 —— 不回的话总窗口越用越少
    this.#control({ type: 'credit', streamId, bytes: ack });
    this.#control({ type: 'credit', streamId: 0, bytes: ack });
    st.inbound.push(payload);
    st.onData?.(payload);
  }

  #onControl(text) {
    let f;
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    switch (f.type) {
      case 'ping':
        return this.#control({ type: 'pong' });
      case 'pong':
        return;
      case 'session-config': {
        if (this.backingId !== f.backingId) {
          this.backingId = f.backingId;
          this.log('会话已建立 backingId=' + f.backingId);
        }
        // 原版顺序是 session-config → workspaces-changed → ready，
        // 我们只有空工作区，报一次空列表并 ready，避免对端一直等设备自报状态。
        this.#control({ type: 'workspaces-changed', workspaces: [] });
        return this.#control({ type: 'ready' });
      }
      case 'credit': {
        const n = Number(f.bytes);
        if (!Number.isInteger(n) || n < 1) return;
        if (f.streamId === 0) {
          this.budget = Math.min(TOTAL_WINDOW, this.budget + n);
        } else {
          const st = this.streams.get(f.streamId);
          if (st) st.window = Math.min(STREAM_WINDOW, st.window + n);
        }
        // 就算这条流不认识，也要叫醒别的等待者
        return this.#flushWaiters();
      }
      case 'open':
        return this.#handleOpen(f);
      case 'reset': {
        const st = this.streams.get(f.streamId);
        if (!st) return;
        this.#releaseStream(st);
        if (st.resolveBody && !st.bodyClosed) {
          st.bodyClosed = true;
          st.resolveBody(Buffer.concat(st.inbound));
        }
        return;
      }
      case 'close': {
        const st = this.streams.get(f.streamId);
        if (!st) return;
        // close 只表示「对方不再发数据」，不影响我们继续回 response。
        // 我们自己也已经 close 过，这条流就可以收摊了。
        st.remoteClosed = true;
        if (st.resolveBody && !st.bodyClosed) {
          st.bodyClosed = true;
          st.resolveBody(Buffer.concat(st.inbound));
        }
        if (st.localClosed) this.#releaseStream(st);
        return;
      }
      default: {
        // 对端会周期性发我们不处理的控制帧（checkpoint / drive / push-report 等）。
        // 以前每来一帧就打一行，看着像在疯狂刷屏，改成同类 60 秒最多一条。
        this.unhandled ||= new Map();
        const key = String(f.type || '?');
        const now = Date.now();
        if ((this.unhandled.get(key) || 0) < now - 60_000) {
          this.unhandled.set(key, now);
          this.log('未处理的控制帧:', key, text.slice(0, 160));
        }
        return;
      }
    }
  }

  // ---------- 处理对端开的流 ----------
  async #handleOpen(f) {
    if (!Number.isInteger(f.streamId) || f.streamId < 1) return;
    // 协议规定 device 侧只接偶数流（对方是 gateway，开偶数）。
    // 真收到奇数也不拒 —— 拒了就是整条链路全哑，宽容处理顶多留一行日志。
    if (f.streamId % 2 !== 0) {
      this.unhandled ||= new Map();
      if ((this.unhandled.get('odd-open') || 0) < Date.now() - 60000) {
        this.unhandled.set('odd-open', Date.now());
        this.log('! open 用了奇数 streamId=' + f.streamId + '（协议约定对方走偶数），仍按普通流处理');
      }
    }
    if (this.streams.size >= MAX_STREAMS) {
      this.log('! 并发流超过上限，拒绝 open: stream=' + f.streamId);
      return;
    }
    const st = {
      id: f.streamId,
      kind: f.kind,
      method: f.method,
      path: f.path,
      headers: f.headers || {},
      inbound: [],
      received: 0,
      window: STREAM_WINDOW,
      localClosed: false,
      remoteClosed: false,
      responded: false,
      dead: false,
      bodyClosed: false,
      resolveBody: null,
      openedAt: Date.now(),
    };
    this.streams.set(f.streamId, st);

    const wantsBody = !/^(GET|HEAD|OPTIONS)$/i.test(f.method || 'GET');
    const body = await new Promise((resolve) => {
      st.resolveBody = resolve;
      if (!wantsBody) {
        st.bodyClosed = true;
        return resolve(Buffer.alloc(0));
      }
      // 对端发完 body 会发 close；拿不到就 1.5 秒后按已收到的处理
      setTimeout(() => {
        if (!st.bodyClosed) {
          st.bodyClosed = true;
          resolve(Buffer.concat(st.inbound));
        }
      }, 1500).unref?.();
    });

    const req = { method: f.method, path: f.path, headers: st.headers, body };
    let out;
    const t0 = Date.now();
    try {
      out = await this.onRequest(req);
    } catch (err) {
      out = {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ error: err.message })),
      };
    }
    this.#respond(f.streamId, out, Math.max(0, Date.now() - t0));
  }

  // ---------- 发送 ----------
  #respond(streamId, out, serviceMs = 0) {
    const st = this.streams.get(streamId);
    if (!st) return; // 已经被 reset 掉了
    if (st.responded || st.localClosed) return; // 重复响应同样算违规
    st.responded = true;

    if (process.env.CAPY_DEBUG_STREAM) {
      this.log(
        `  ⟶ response stream=${streamId} ${st.method} ${st.path} status=${out.status || 200} ` +
          `after ${Date.now() - st.openedAt}ms remoteClosed=${st.remoteClosed}`,
      );
    }

    this.#control({
      type: 'response',
      streamId,
      status: out.status || 200,
      headers: { 'content-type': 'application/json', ...(out.headers || {}) },
      serviceMs,
      sinceOpenMs: Date.now() - st.openedAt,
    });

    const body = Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body ?? '');
    if (body.length) this.#writeStream(st, body);
    else this.#closeLocal(st);
  }

  #closeLocal(st) {
    if (st.localClosed) return;
    st.localClosed = true;
    this.#control({ type: 'close', streamId: st.id });
    if (st.remoteClosed) return this.#releaseStream(st);
    // 对端不一定回 close：给个台阶，30 秒后收摊，别让流表只增不减
    setTimeout(() => this.#releaseStream(st), 30_000).unref?.();
  }

  async #writeStream(st, body) {
    let off = 0;
    while (off < body.length) {
      // 两条窗口都得有位置：连接级 2MB、这条流 256KB。
      // 只等连接级、无视流级，就是之前大响应被对方 reset 的原因。
      while (!this.closed && !st.dead && st.window <= 0) await this.#waitWindow(st);
      while (!this.closed && !st.dead && this.budget <= 0) await this.#waitWindow(st);
      if (this.closed || st.dead || st.localClosed) return;

      const n = Math.min(CHUNK, body.length - off, st.window, this.budget);
      if (n <= 0) {
        await this.#waitWindow(st);
        continue;
      }
      const chunk = body.subarray(off, off + n);
      const frame = Buffer.alloc(4 + chunk.length);
      frame.writeUInt32BE(st.id, 0);
      chunk.copy(frame, 4);
      this.ws.send(frame);
      st.window -= n;
      this.budget -= n;
      off += n;
    }
    if (!this.closed && !st.dead && !st.localClosed) this.#closeLocal(st);
  }

  #releaseStream(st) {
    st.dead = true;
    if (this.streams.get(st.id) === st) this.streams.delete(st.id);
    // 流没了，正等这条流窗口的写入者不要继续等
    this.#flushWaiters();
  }

  #waitWindow(st) {
    if (this.closed || st.dead) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ st, resolve }));
  }

  #flushWaiters() {
    if (!this.waiters.length) return;
    const rest = [];
    for (const w of this.waiters) {
      const alive = !this.closed && !w.st.dead && !w.st.localClosed && this.streams.get(w.st.id) === w.st;
      if (!alive) {
        // 流已经没了 / 连接断了：叫醒它，让它自己走退出分支
        w.resolve();
        continue;
      }
      if (w.st.window > 0 && this.budget > 0) w.resolve();
      else rest.push(w);
    }
    this.waiters = rest;
  }

  #wakeAll() {
    const list = this.waiters;
    this.waiters = [];
    for (const w of list) {
      try {
        w.resolve();
      } catch {}
    }
  }

  close() {
    this.#stopHeartbeat();
    this.#wakeAll();
    this.ws?.close();
  }
}
