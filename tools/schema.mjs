// 打印指定 handler 的定义片段
import fs from 'node:fs';

const s = fs.readFileSync('D:/agent/_work/asar/out/main/main.js', 'utf8');
for (const name of process.argv.slice(2)) {
  let i = s.indexOf(`name: "${name}"`);
  if (i < 0) {
    console.log(`=== ${name} 未找到`);
    continue;
  }
  console.log(`\n===== ${name} @${i} =====`);
  console.log(s.slice(Math.max(0, i - 1100), i + 260).replace(/\s+/g, ' '));
}
