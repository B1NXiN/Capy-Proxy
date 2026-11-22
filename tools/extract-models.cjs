// 从客户端渲染包里提取模型目录，生成 models.json。
// 客户端升级后重跑一次即可更新。
const fs = require('node:fs');
const path = require('node:path');

const dir =
  process.argv[2] ||
  process.env.CAPY_ASSETS ||
  path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'Programs', 'Capy', 'resources', 'renderer', 'assets');
const outFile = process.argv[3] || path.join(__dirname, '..', 'models.json');

let best = null;
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!s.includes('particle/particle-1')) continue;
  if (!best || s.length > best.s.length) best = { f, s };
}
if (!best) {
  console.error('没找到含模型目录的构建文件');
  process.exit(1);
}

const re = /\{id:`([^`]+)`,name:`([^`]+)`,provider:`([^`]+)`[^}]*?limits:\{context:([0-9.e]+),output:([0-9.e]+)\}(?:,pricing:\{input:([0-9.e]+),output:([0-9.e]+))?/g;
const map = new Map();
let m;
while ((m = re.exec(best.s))) {
  const [, id, name, provider, ctx, out, pin, pout] = m;
  map.set(id, {
    id,
    name,
    provider,
    context: Math.round(Number(ctx)),
    maxOutput: Math.round(Number(out)),
    free: Number(pin ?? 0) === 0 && Number(pout ?? 0) === 0,
  });
}

const list = [...map.values()].sort((a, b) => Number(b.free) - Number(a.free) || a.name.localeCompare(b.name));
fs.writeFileSync(outFile, JSON.stringify(list, null, 1));
console.log(`从 ${best.f} 提取到 ${list.length} 个模型，其中免费 ${list.filter((x) => x.free).length} 个：`);
console.log(list.filter((x) => x.free).map((x) => `${x.id} (${x.name})`).join('\n'));
