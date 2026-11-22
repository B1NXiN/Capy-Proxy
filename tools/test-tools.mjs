// 工具映射层的单测：不连云端，纯函数级验证。
// 跑法：node tools/test-tools.mjs
import {
  LIMITS,
  FORWARDABLE,
  parseClientTools,
  parseToolChoice,
  forwardableHandlers,
  matchClientTool,
  toolKindOf,
  buildToolArguments,
  shapeResult,
  hashHex,
} from '../lib/oaitools.js';

let pass = 0;
const fails = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `期望 ${b}，实际 ${a}`);
}

// ---------- 1. 解析调用方声明的工具 ----------
const nested = parseClientTools([
  { type: 'function', function: { name: 'run_shell_command', description: 'Run a shell command', parameters: { properties: { cmd: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read_file', parameters: { properties: { file_path: { type: 'string' } } } } },
]);
eq('解析嵌套 function 结构', nested.map((t) => t.name), ['run_shell_command', 'read_file']);

const flat = parseClientTools([{ name: 'write_file', parameters: { properties: { path: { type: 'string' } } } }]);
eq('解析扁平结构', flat.map((t) => t.name), ['write_file']);

eq('非法输入返回空数组', parseClientTools(null).length, 0);
eq('缺 name 的条目被跳过', parseClientTools([{ type: 'function', function: {} }]).length, 0);

// ---------- 2. handler → 语义 ----------
eq('bash 属于命令类', toolKindOf('bash'), 'run');
eq('read 与 file_read 同类', [toolKindOf('read'), toolKindOf('file_read')], ['read', 'read']);
eq('worktree_ensure 不外抛', toolKindOf('worktree_ensure'), null);
check('FORWARDABLE 不含内部工具', !FORWARDABLE.includes('worktree_ensure') && !FORWARDABLE.includes('git_facts'));

// ---------- 3. 工具名匹配 ----------
const phoneTools = parseClientTools([
  { type: 'function', function: { name: 'execute_command', parameters: { properties: { command: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read_file', parameters: { properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'write_file', parameters: { properties: { path: { type: 'string' }, content: { type: 'string' } } } } },
  { type: 'function', function: { name: 'apply_patch', parameters: { properties: { patch: { type: 'string' } } } } },
]);
eq('命令类精确命中', matchClientTool('run', phoneTools)?.name, 'execute_command');
eq('读文件精确命中', matchClientTool('read', phoneTools)?.name, 'read_file');
eq('写文件精确命中', matchClientTool('write', phoneTools)?.name, 'write_file');
eq('打补丁精确命中', matchClientTool('patch', phoneTools)?.name, 'apply_patch');
eq('没有编辑工具时不乱认', matchClientTool('edit', phoneTools), null);

const odd = parseClientTools([
  { type: 'function', function: { name: 'run_shell_command', parameters: null } },
  { type: 'function', function: { name: 'device_exec', parameters: null } },
]);
eq('别名命中 run_shell_command', matchClientTool('run', odd)?.name, 'run_shell_command');

const onlyExec = parseClientTools([{ type: 'function', function: { name: 'device_exec' } }]);
eq('关键词兜底命中 device_exec', matchClientTool('run', onlyExec)?.name, 'device_exec');

// 排除词优先：write_file 里带 file，不能被当成本文件
eq('write_file 不会被误认成读', matchClientTool('read', parseClientTools([{ type: 'function', function: { name: 'write_file' } }])), null);
eq('read_file 不会被误认成写', matchClientTool('write', parseClientTools([{ type: 'function', function: { name: 'read_file' } }])), null);

// ---------- 4. 参数翻译 ----------
const cmdTool = phoneTools[0];
eq('命令参数按 schema 键名（cmd）', buildToolArguments('bash', { command: 'ls -la' }, parseClientTools([{ type: 'function', function: { name: 'execute_command', parameters: { properties: { cmd: {} } } } }])[0]), { cmd: 'ls -la' });
eq('命令参数默认 command 键', buildToolArguments('bash', { command: 'pwd' }, cmdTool), { command: 'pwd' });

const readTool = { name: 'read_file', params: { properties: { file_path: {}, offset: {}, limit: {} } } };
eq('读参数映射 file_path', buildToolArguments('read', { path: '/sdcard/a.txt', offset: 3, limit: 20 }, readTool), {
  file_path: '/sdcard/a.txt',
  offset: 3,
  limit: 20,
});

const writeTool = { name: 'write_file', params: { properties: { path: {}, content: {} } } };
eq('写参数映射 path/content', buildToolArguments('file_write', { path: 'a.txt', content: 'hi' }, writeTool), {
  path: 'a.txt',
  content: 'hi',
});

const editTool = { name: 'edit_file', params: { properties: { path: {}, old_string: {}, new_string: {} } } };
eq('编辑参数映射 old/new', buildToolArguments('edit', { path: 'a.txt', oldString: 'x', newString: 'y' }, editTool), {
  path: 'a.txt',
  old_string: 'x',
  new_string: 'y',
});

eq('无 schema 时用约定键名', buildToolArguments('apply_patch', { patch: 'diff --git a b' }, null), { patch: 'diff --git a b' });

// ---------- 5. tool_choice ----------
eq('缺省按 auto', parseToolChoice(undefined), { mode: 'auto', name: null });
eq('none', parseToolChoice('none'), { mode: 'none', name: null });
eq('required', parseToolChoice('required'), { mode: 'required', name: null });
eq('指定函数', parseToolChoice({ type: 'function', function: { name: 'read_file' } }), { mode: 'function', name: 'read_file' });

// ---------- 6. 哪些能外抛 ----------
eq('scope 缺失时退回只抛 bash', forwardableHandlers(null), ['bash']);
eq('tool_choice=none 一个都不抛', forwardableHandlers({ clientTools: phoneTools, choice: { mode: 'none' } }), []);
eq('只声明命令工具时只抛 bash', forwardableHandlers({ clientTools: [cmdTool], choice: { mode: 'auto' } }), ['bash']);
const all4 = forwardableHandlers({ clientTools: phoneTools, choice: { mode: 'auto' } });
check('声明文件工具后读/写/补丁都能抛', ['bash', 'read', 'file_read', 'file_write', 'apply_patch'].every((h) => all4.includes(h)), all4.join(','));
eq('指定 read_file 时只抛读类', forwardableHandlers({ clientTools: phoneTools, choice: { mode: 'function', name: 'read_file' } }), ['read', 'file_read']);

// ---------- 7. 结果整形 ----------
const rb = shapeResult('bash', { command: 'ls' }, 'a\nb', false);
check('bash 结果含 stdout/exitCode', rb.kind === 'bash' && rb.stdout === 'a\nb' && rb.exitCode === 0);
const rbf = shapeResult('bash', {}, 'boom', true);
check('失败命令 stdout 与 exitCode 都体现', rbf.exitCode === 1 && rbf.isError === true);

const rr = shapeResult('read', { path: 'a' }, 'line1\nline2', false);
check('read 结果含 content/totalLines', rr.kind === 'read' && rr.content === 'line1\nline2' && rr.totalLines === 2);

const rfw = shapeResult('file_write', { path: 'a.txt', content: 'hi' }, 'ok', false);
check('写文件结果含 sha/bytes', rfw.kind === 'written' && rfw.bytes === 2 && rfw.sha === hashHex('hi'));

const rfr = shapeResult('file_read', { path: 'a.txt' }, 'hello', false);
check('读文件结果含 path/content.text', rfr.kind === 'read' && rfr.path === 'a.txt' && rfr.content.text === 'hello');

const rmiss = shapeResult('file_read', { path: 'nope' }, 'No such file or directory', true);
eq('读不到时回报 missing', rmiss.kind, 'missing');

const rwErr = shapeResult('file_write', { path: 'x' }, 'permission denied', true);
eq('写入失败是 failure', rwErr.kind, 'failure');

const re = shapeResult('edit', { path: 'a' }, 'ok', false);
check('编辑结果合法', re.kind === 'edit' && re.replacements === 1);

const rp = shapeResult('apply_patch', {}, 'applied', false);
eq('补丁按命令结果回报', rp.kind, 'bash');

// ---------- 8. 上限 ----------
eq('单轮调用上限 16', LIMITS.maxToolCalls, 16);
eq('工具定义上限 256', LIMITS.maxTools, 256);
eq('prompt 上限 200 万整数', LIMITS.maxPromptChars, 2_000_000);

// ---------- 汇总 ----------
console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项：\n- ' + fails.join('\n- '));
  process.exit(1);
}
