// 实验：不同模型 / 不同 workspace 下，线程到底能不能拿到 bash 这类工具
import { session, call, listEvents, createJam, followJam, archiveJam, ulid } from '../lib/capy.js';
import { randomUUID } from 'node:crypto';

const PROMPT = '看一下这台机器 D 盘还剩多少空间。直接执行命令查，不要问我，查到就直接告诉我数字。';

async function trial({ model, workspace, label }) {
  const s = await session();
  const jamId = `jam_${ulid()}`;
  const body = {
    jamId,
    requestId: `probe_${randomUUID()}`,
    message: PROMPT,
    model: { modelId: model, reasoningMode: 'medium' },
    device: { deviceId: s.deviceId, workspace },
    title: `probe ${label}`.slice(0, 60),
  };
  try {
    await call(`/orgs/${s.orgId}/jams`, { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    return { label, model, error: `建线程失败 ${err.status}: ${err.message}` };
  }

  const result = await followJam({ jamId, timeoutMs: 150000 });
  const events = await listEvents(jamId, 500);
  const tools = [];
  for (const e of events) {
    if (e.kind === 'assistant' && Array.isArray(e.payload?.blocks)) {
      for (const b of e.payload.blocks) if (b.type === 'tool_use') tools.push(b.toolName);
    }
  }
  const jam = await call(`/orgs/${s.orgId}/jams/${jamId}`).catch(() => null);
  archiveJam(jamId).catch(() => {});
  return {
    label,
    model,
    workspace: workspace.kind,
    status: result.status,
    tools: [...new Set(tools)].join(', ') || '(无)',
    err: result.error?.message,
    worktree: jam?.preview ? '(preview) ' + jam.preview.slice(0, 90) : null,
    text: (result.text || '').replace(/\s+/g, ' ').slice(0, 160),
  };
}

const which = process.argv[2] || 'models';
const trials =
  which === 'models'
    ? [
        { label: 'particle', model: 'particle/particle-1', workspace: { kind: 'worktree' } },
        { label: 'deepseek-ads', model: 'deepseek/deepseek-v4.1-flash-ads', workspace: { kind: 'worktree' } },
      ]
    : [
        { label: 'linked-root', model: 'particle/particle-1', workspace: { kind: 'linked', root: 'D:\\agent', roots: ['D:\\agent'] } },
        { label: 'worktree-root', model: 'particle/particle-1', workspace: { kind: 'worktree', startFromOrigin: false } },
      ];

for (const t of trials) {
  console.log('\n>>> 试跑', t.label);
  const r = await trial(t);
  console.log(JSON.stringify(r, null, 1));
}
