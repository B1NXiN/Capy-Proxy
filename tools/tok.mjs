// 抓取某个标识符的定义
import fs from 'node:fs';

const s = fs.readFileSync('D:/agent/_work/asar/out/main/main.js', 'utf8');
const [name, spanArg] = process.argv.slice(2);
const span = Number(spanArg || 700);
const re = new RegExp(`[,;]\\s*(?:var |let )?${name}\\s*=\\s*`);
const m = re.exec(s);
if (!m) {
  console.log(`${name} 未找到`);
  process.exit(0);
}
console.log(`===== ${name} @${m.index} =====`);
console.log(s.slice(m.index, m.index + span).replace(/\s+/g, ' '));
