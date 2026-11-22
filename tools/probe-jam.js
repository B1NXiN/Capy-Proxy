// 诊断：建线程后逐秒观察事件与状态，不归档
import * as capy from '../lib/capy.js';

const prompt = process.argv[2] || '只回一个字：好';
const model = process.argv[3] || null;
const ms = Number(process.argv[4] || 20000);

const { jamId } = await capy.createJam({ prompt, model, title: 'probe' });
console.log('jamId', jamId, 'model', model);
const t0 = Date.now();
let last = -1;
while (Date.now() - t0 < ms) {
  await new Promise((r) => setTimeout(r, 700));
  const [evs, jam] = await Promise.all([capy.listEvents(jamId).catch(() => []), capy.getJam(jamId).catch(() => null)]);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (evs.length !== last) {
    last = evs.length;
    console.log(`[${secs}s] events=${evs.length} status=${jam?.status} runStatus=${jam?.runStatus} served=${jam?.servedModel?.modelId || '-'}`);
    for (const e of evs.slice(-3)) console.log('   *', e.kind, JSON.stringify(e.payload).slice(0, 260));
  } else {
    process.stdout.write(`\r[${secs}s] events=${evs.length} status=${jam?.status} runStatus=${jam?.runStatus}   `);
  }
}
const jam = await capy.getJam(jamId);
console.log('\n最终:', jam?.status, jam?.runStatus, '| served', jam?.servedModel?.modelId || null);
const evs = await capy.listEvents(jamId);
for (const e of evs) console.log('  -', e.kind, JSON.stringify(e.payload).slice(0, 300));
