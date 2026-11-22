// 从打包的 main.js 里提取设备 handler 清单（名称 + capability + 是否只读）
import fs from 'node:fs';

const src = process.argv[2] || 'D:/agent/_work/asar/out/main/main.js';
const s = fs.readFileSync(src, 'utf8');
const re = /name:\s*"([a-z0-9_]+)",\s*params:\s*[A-Za-z0-9_$]+,\s*result:\s*[^,]+,\s*readOnly:\s*(!0|!1),\s*capability:\s*"([a-z]+)"/g;
let m;
const rows = [];
while ((m = re.exec(s))) rows.push([m[1], m[3], m[2] === '!0' ? 'ro' : 'rw']);
console.log('共', rows.length, '个 handler');
const byCap = {};
for (const [n, c, r] of rows) (byCap[c] ??= []).push(r === 'ro' ? n + '*' : n);
for (const [c, list] of Object.entries(byCap)) console.log(`\n[${c}] ${list.join(', ')}`);
