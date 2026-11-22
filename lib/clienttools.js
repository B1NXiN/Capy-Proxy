// 工具外抛中枢：设备端把 invocation 挂在这里，等调用方（客户端）执行完再回填。
//
// 时序：
//   Capy 云端产出 tool_use(bash)
//     → 设备端收到 invocation，调用 hold() 挂起，不再本机执行
//     → relay 在事件流里看到这个 tool_use，claim() 绑定 toolCallId，回 tool_calls
//     → 客户端执行命令，把结果放进下一轮 messages（role=tool）
//     → relay 调 settle()，设备端拿到结果，回灌云端，jam 继续
import { randomUUID } from 'node:crypto';

const DEFAULT_WAIT_MS = Number(process.env.CAPY_CLIENT_TOOL_WAIT_MS || 300000);

export function createHub({ log = () => {} } = {}) {
  const byInvocation = new Map();
  const byToolCall = new Map();
  // 已经用过的 toolCallId。云端事件是按时间读的，同一段命令重复出现时
  // 很容易又匹配到上一轮那条老 tool_use，认领时必须把它排除掉。
  const usedToolCalls = new Set();

  function sweep() {
    const now = Date.now();
    for (const [id, rec] of byInvocation) {
      if (now - rec.createdAt > DEFAULT_WAIT_MS) {
        finish(rec, { ok: false, error: '调用方没有在时限内执行该工具' });
      }
    }
  }
  const timer = setInterval(sweep, 5000);
  timer.unref?.();

  function finish(rec, payload) {
    if (rec.done) return;
    rec.done = true;
    byInvocation.delete(rec.invocationId);
    if (rec.toolCallId) {
      byToolCall.delete(rec.toolCallId);
      usedToolCalls.add(rec.toolCallId);
    }
    try {
      rec.reply(payload);
    } catch {}
  }

  // 设备端调用：挂起，等调用方的结果
  // 如果已经知道对应的 toolCallId（服务端核对过事件流），直接绑定
  function hold({ invocationId, handler, params, cwd, toolCallId, jamId, args }, reply) {
    const rec = {
      invocationId,
      handler,
      params,
      args: args || null,
      cwd,
      createdAt: Date.now(),
      toolCallId: toolCallId || null,
      jamId: jamId || null,
      reply,
      done: false,
    };
    byInvocation.set(invocationId, rec);
    if (toolCallId) byToolCall.set(toolCallId, rec);
    log('挂起', invocationId, handler, toolCallId ? `→ ${toolCallId}` : '(待认领)');
    return rec;
  }

  // relay 调用：把事件流里的 tool_use 和设备端的挂起项对上
  // 同一个 jam 内工具调用是串行的，所以按 handler 取最早未绑定的一条即可
  function claim({ jamId, toolCallId, handler }) {
    for (const rec of byInvocation.values()) {
      if (rec.done || rec.toolCallId) continue;
      if (handler && rec.handler !== handler) continue;
      rec.toolCallId = toolCallId;
      rec.jamId = jamId;
      byToolCall.set(toolCallId, rec);
      log('认领', toolCallId, '→', rec.invocationId, handler);
      return rec;
    }
    return null;
  }

  function find(toolCallId) {
    return byToolCall.get(toolCallId) || null;
  }

  function wasUsed(toolCallId) {
    return usedToolCalls.has(toolCallId);
  }

  // 调用方回填结果。注意：命令本身失败（非零退出）也是「执行成功」，
  // 只是 isError 为真；ok=false 专指「这条调用没被执行」。
  function settle(toolCallId, result) {
    const rec = byToolCall.get(toolCallId);
    if (!rec) return false;
    finish(rec, { ok: true, text: result?.text ?? '', isError: !!result?.isError });
    return true;
  }

  function fail(toolCallId, message) {
    const rec = byToolCall.get(toolCallId);
    if (!rec) return false;
    finish(rec, { ok: false, error: message });
    return true;
  }

  // 设备端那条长连接断了（网关超时 / 进程退出），把挂起项清掉
  function drop(invocationId, reason = '调用方连接已断开') {
    const rec = byInvocation.get(invocationId);
    if (!rec) return false;
    finish(rec, { ok: false, error: reason });
    return true;
  }

  function pendingCount() {
    return byInvocation.size;
  }

  function listPending() {
    return [...byInvocation.values()].map((r) => ({
      invocationId: r.invocationId,
      handler: r.handler,
      toolCallId: r.toolCallId,
      jamId: r.jamId,
      args: r.args,
      createdAt: r.createdAt,
      waitingMs: Date.now() - r.createdAt,
    }));
  }

  return { hold, claim, find, wasUsed, settle, fail, drop, pendingCount, listPending, close: () => clearInterval(timer) };
}

export const newId = () => randomUUID().replace(/-/g, '').slice(0, 20);
