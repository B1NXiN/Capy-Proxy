// 模拟一个普通 OpenAI 客户端：拿 tool_calls、在本机执行、把结果回填，看能不能继续。
// 用法：node tools/sim-client.mjs "用 bash 执行 ls /d 看有哪些目录"
import { spawnSync } from 'node:child_process';

const BASE = process.env.CAPY_RELAY_URL || 'http://127.0.0.1:8787/v1';
const MODEL = process.env.CAPY_MODEL || 'particle/particle-1';
const STREAM = process.env.SIM_STREAM === '1';
const prompt = process.argv[2] || '用 bash 执行 ls /d 看有哪些目录，然后用一句话告诉我结果';
const MAX_ROUNDS = Number(process.env.SIM_ROUNDS || 6);

const tools = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: '在用户自己的电脑上执行 bash 命令',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的命令' }, timeoutSeconds: { type: 'number' } },
        required: ['command'],
      },
    },
  },
];

const messages = [{ role: 'user', content: prompt }];

function runLocal(command) {
  const shell = process.env.SIM_BASH || 'bash';
  const r = spawnSync(shell, ['-lc', command], { encoding: 'utf8', timeout: 120000 });
  const out = [r.stdout || '', r.stderr || ''].join('').trim();
  return { out: out || '(无输出)', code: r.status ?? 1 };
}

async function chat() {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, tools, stream: STREAM }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
  if (!STREAM) {
    const json = await res.json();
    return { json, ms: Date.now() - t0 };
  }
  // 极简 SSE 解析：拼出 content 和 tool_calls
  const raw = await res.text();
  let content = '';
  const calls = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const d = chunk.choices?.[0]?.delta || {};
    if (d.content) content += d.content;
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? 0;
      calls[i] = calls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].function.name += tc.function.name;
      if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
    }
  }
  return {
    json: {
      choices: [{ message: { role: 'assistant', content, tool_calls: calls.filter(Boolean) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
      usage: null,
    },
    ms: Date.now() - t0,
  };
}

for (let round = 1; round <= MAX_ROUNDS; round += 1) {
  const { json, ms } = await chat();
  const choice = json.choices?.[0];
  const msg = choice?.message || {};
  const calls = msg.tool_calls || [];
  console.log(`\n--- 第 ${round} 轮 (${ms}ms) finish=${choice?.finish_reason} tool_calls=${calls.length} ---`);
  if (msg.content) console.log('内容:', String(msg.content).slice(0, 600));

  if (!calls.length) {
    console.log('\n[完成] 最终回答：\n' + (msg.content || '(空)'));
    process.exit(0);
  }

  messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
  for (const call of calls) {
    let args = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {}
    console.log(`执行 [${call.function.name}] ${String(args.command || '').slice(0, 200)}`);
    const { out, code } = runLocal(args.command || '');
    console.log(`   → exit=${code} ${out.length} 字符`);
    messages.push({ role: 'tool', tool_call_id: call.id, content: out });
  }
}

console.log('\n[超限] 轮数用完仍未收敛');
process.exit(1);
