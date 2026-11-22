// 工具映射层：把 Capy 固定的一套 handler 翻译成调用方认识的「标准函数工具」。
//
// 为什么需要翻译：
//   Capy 的模型只认自己那套工具（bash / read / file_write / edit / ...），
//   工具清单在云端，请求里没有字段能改（createJam 不带 tools）。
//   而调用方（手机 harness、IDE 插件、new-api 下游）声明的是自己的函数名和 schema。
//   所以我们两头各做一半：上游按 Capy 的 handler 接，下游按调用方的名字发，
//   中间这张表负责对名字、对参数形状、把结果整形成云端期望的样子。
//
import { createHash } from 'node:crypto';

// 三条硬边界（改代码前先看这里）：
//   1. 调用方声明的新工具模型永远看不到，只可能走这五种语义。
//   2. tool_choice 只能事后校验，没法真的强制上游。
//   3. 参数 schema 以 Capy 的为准，我们只做键名映射，不做完整 JSON Schema 校验。

// Capy handler → 语义类别。不在表里的（worktree_* / volume_* / git_* / ports ...）
// 属于内部工具，永远不外抛。
const KIND_OF = {
  bash: 'run',
  read: 'read',
  file_read: 'read',
  file_write: 'write',
  edit: 'edit',
  apply_patch: 'patch',
};

// 可以外抛给调用方执行的 handler
export const FORWARDABLE = Object.keys(KIND_OF);

// 每类语义能接受的客户端工具名（先精确命中，再走关键词兜底）
const ALIASES = {
  run: [
    'execute_command',
    'run_command',
    'run_shell_command',
    'run_terminal_cmd',
    'shell_exec',
    'execute_bash',
    'terminal',
    'shell',
    'bash',
    'exec',
    'command',
    'execute',
    'run',
  ],
  read: ['read_file', 'file_read', 'view_file', 'read_text_file', 'open_file', 'cat', 'read', 'view'],
  write: ['write_file', 'file_write', 'create_file', 'write_to_file', 'save_file', 'write_file_content', 'write'],
  edit: ['edit_file', 'replace_in_file', 'str_replace_editor', 'str_replace', 'edit', 'modify_file'],
  patch: ['apply_patch', 'patch_file', 'patch'],
};

// 名字兜底用的关键词。顺序有意义：先排除，再命中。
const KEYWORDS = {
  run: { hit: /(exec|command|shell|bash|terminal)/, miss: /(read|write|edit|patch|list|glob|search)/ },
  read: { hit: /(read|cat|view|open|load|head|tail)/, miss: /(write|save|create|edit|patch|replace|delete|remove)/ },
  write: { hit: /(write|save|create|put|append)/, miss: /(read|edit|patch|replace|delete|remove|list)/ },
  edit: { hit: /(edit|replace|modify|update|str_replace)/, miss: /(read|write|create|delete|remove|list)/ },
  patch: { hit: /(patch|diff)/, miss: /(read|write|create|delete|remove|list)/ },
};

// 参数键名的候选。按顺序取客户端 schema 里真实存在的那个。
const ARG_KEYS = {
  command: ['command', 'cmd', 'shell_command', 'script', 'input', 'code', 'command_line'],
  path: ['path', 'file_path', 'filepath', 'filename', 'file', 'target_file', 'absolute_path'],
  content: ['content', 'text', 'file_text', 'contents', 'new_content', 'data'],
  old: ['old_string', 'oldString', 'old_text', 'oldText', 'find', 'search', 'pattern'],
  new: ['new_string', 'newString', 'new_text', 'newText', 'replace', 'replacement', 'replace_with'],
  patch: ['patch', 'diff', 'patch_text', 'input'],
  offset: ['offset', 'start_line', 'startLine', 'from'],
  limit: ['limit', 'lines', 'num_lines', 'numLines', 'count', 'to'],
};

export const LIMITS = {
  maxToolCalls: 16, // 一次响应最多 16 个调用
  maxTools: 256, // 一次请求最多 256 个工具定义
  maxPromptChars: 2_000_000, // 拼出来的 prompt 上限
};

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

// ---------- 请求侧 ----------

// ---------- 请求侧 ----------

// tool_choice：auto / none / required / {type:'function',function:{name}}
export function parseToolChoice(raw) {
  if (raw == null || raw === 'auto') return { mode: 'auto', name: null };
  if (raw === 'none') return { mode: 'none', name: null };
  if (raw === 'required') return { mode: 'required', name: null };
  if (typeof raw === 'object') {
    if (raw.type === 'function' && typeof raw.function?.name === 'string') {
      return { mode: 'function', name: raw.function.name };
    }
    if (raw.type === 'auto' || raw.type === 'none' || raw.type === 'required') {
      return { mode: raw.type, name: null };
    }
  }
  return { mode: 'auto', name: null };
}

// 这一轮真正能交给调用方的 handler。
//   tool_choice=none  → 一个都不交（模型真要调就本机跑）
//   指定函数          → 只交名字对得上的那一类
//   调用方没声明      → 不交，保持本机执行（老行为）
// scope 缺失时退回老行为：只外抛 bash。
export function forwardableHandlers(scope) {
  if (!scope) return ['bash'];
  if (scope.choice?.mode === 'none') return [];
  if (scope.choice?.mode === 'function') {
    return FORWARDABLE.filter((h) => {
      const mapped = matchClientTool(toolKindOf(h), scope.clientTools);
      return mapped && mapped.name === scope.choice.name;
    });
  }
  return FORWARDABLE.filter((h) => !!matchClientTool(toolKindOf(h), scope.clientTools));
}

export function toolKindOf(handler) {
  return KIND_OF[handler] || null;
}

export function isForwardable(handler) {
  return Object.hasOwn(KIND_OF, handler);
}

// 把请求里的 tools 数组规范化。容错：也接受 {name, parameters} 这种非嵌套写法。
export function parseClientTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    const fn = t?.function || t;
    const name = fn?.name;
    if (typeof name !== 'string' || !name) continue;
    out.push({
      name,
      description: typeof fn.description === 'string' ? fn.description : '',
      params: fn.parameters || fn.input_schema || null,
    });
  }
  return out;
}

// 在客户端声明的工具里找到能承接这类语义的那一个。
export function matchClientTool(kind, clientTools) {
  if (!kind || !Array.isArray(clientTools) || !clientTools.length) return null;
  const list = ALIASES[kind] || [];

  // 1. 精确命中别名
  for (const want of list) {
    const hit = clientTools.find((t) => norm(t.name) === want);
    if (hit) return hit;
  }

  // 2. 按关键词兜底（名字优先，再看描述）
  const kw = KEYWORDS[kind];
  if (!kw) return null;
  for (const t of clientTools) {
    const n = norm(t.name);
    if (kw.miss && kw.miss.test(n)) continue;
    if (kw.hit.test(n)) return t;
  }
  for (const t of clientTools) {
    const d = norm(t.description);
    if (!d) continue;
    if (kw.miss && kw.miss.test(d)) continue;
    if (kw.hit.test(d)) return t;
  }
  return null;
}

function props(tool) {
  const p = tool?.params;
  if (!p || typeof p !== 'object') return null;
  if (p.properties && typeof p.properties === 'object') return p.properties;
  return null;
}

function pickKey(properties, candidates, fallback) {
  if (!properties) return fallback;
  for (const c of candidates) {
    if (Object.hasOwn(properties, c)) return c;
  }
  // 客户端 schema 是 strict 的话，多塞键会被拒，只回它认识的那个
  return fallback;
}

// 把 Capy 的 args 翻成客户端 schema 认得的形状。
// 客户端没给 schema 时用约定俗成的键名。
export function buildToolArguments(handler, args = {}, tool = null) {
  const kind = toolKindOf(handler);
  if (!kind) return args || {};
  const p = props(tool);

  if (kind === 'run') {
    const cmd = args?.command ?? args?.cmd ?? args?.script ?? '';
    const key = pickKey(p, ARG_KEYS.command, 'command');
    return { [key]: String(cmd) };
  }

  if (kind === 'read') {
    const key = pickKey(p, ARG_KEYS.path, 'path');
    const out = { [key]: String(args?.path ?? args?.file_path ?? '') };
    if (typeof args?.offset === 'number') {
      out[pickKey(p, ARG_KEYS.offset, 'offset')] = args.offset;
    }
    if (typeof args?.limit === 'number') {
      out[pickKey(p, ARG_KEYS.limit, 'limit')] = args.limit;
    }
    return out;
  }

  if (kind === 'write') {
    return {
      [pickKey(p, ARG_KEYS.path, 'path')]: String(args?.path ?? args?.file_path ?? ''),
      [pickKey(p, ARG_KEYS.content, 'content')]: String(args?.content ?? ''),
    };
  }

  if (kind === 'edit') {
    return {
      [pickKey(p, ARG_KEYS.path, 'path')]: String(args?.path ?? args?.file_path ?? ''),
      [pickKey(p, ARG_KEYS.old, 'old_string')]: String(args?.oldString ?? args?.old_string ?? ''),
      [pickKey(p, ARG_KEYS.new, 'new_string')]: String(args?.newString ?? args?.new_string ?? ''),
    };
  }

  if (kind === 'patch') {
    const key = pickKey(p, ARG_KEYS.patch, 'patch');
    return { [key]: String(args?.patch ?? args?.diff ?? '') };
  }

  return args || {};
}

// ---------- 结果侧 ----------
// 调用方只回一段文本（加一个是否失败）。云端要的是各 handler 自己的结构，
// 这里照着 lib/device.js 里本机执行的返回形状拼，别自创字段。

export function shapeResult(handler, args, text, isError = false) {
  const body = String(text ?? '');
  const kind = toolKindOf(handler);

  if (kind === 'run' || kind === 'patch') {
    return {
      kind: 'bash',
      stdout: body,
      stderr: isError ? body : '',
      exitCode: isError ? 1 : 0,
      durationMs: 0,
      timedOut: false,
      isError: !!isError,
      executedOn: 'client',
    };
  }

  if (handler === 'read') {
    return {
      kind: 'read',
      content: body,
      offset: 1,
      totalLines: body ? body.split(/\r?\n/).length : 0,
      isError: !!isError,
    };
  }

  if (handler === 'file_read') {
    if (isError && /not found|no such file|missing/i.test(body)) {
      return { kind: 'missing', isError: false };
    }
    return {
      kind: 'read',
      path: String(args?.path ?? args?.file_path ?? ''),
      content: { text: body },
      sha: hashHex(body),
      isError: !!isError,
    };
  }

  if (handler === 'file_write') {
    const content = typeof args?.content === 'string' ? args.content : body;
    if (isError) return { kind: 'failure', isError: true, message: body || '写入失败' };
    return {
      kind: 'written',
      sha: hashHex(content),
      bytes: Buffer.byteLength(content, 'utf8'),
      isError: false,
      executedOn: 'client',
    };
  }

  if (handler === 'edit') {
    if (isError) return { kind: 'failure', isError: true, message: body || '编辑失败' };
    return {
      kind: 'edit',
      path: String(args?.path ?? args?.file_path ?? ''),
      replacements: 1,
      isError: false,
      executedOn: 'client',
    };
  }

  return { kind: 'bash', stdout: body, stderr: isError ? body : '', exitCode: isError ? 1 : 0, isError: !!isError };
}

// 单独导出，测试会用
export function hashHex(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}
