import { trimPmtiles, report } from './trim.mjs';
const IN = process.env.IN || '../../ref/simp-safe.cut.pmtiles';
const tag = process.env.TAG || 'ss';
const REF = +(process.env.REF || 1104072);
const V = JSON.parse(process.env.RUNS);
for (const [name, o] of Object.entries(V)) {
  const t = Date.now();
  const r = trimPmtiles(IN, `out/${tag}-${name}.pmtiles`, o);
  console.log(report(name, r, REF), ((Date.now() - t) / 1000).toFixed(1) + 's');
  if (process.env.DETAIL) for (const [z, s] of Object.entries(r.stats)) for (const [n, l] of Object.entries(s.layers)) console.log(`   ${z} ${n.padEnd(15)} f ${l.fin}->${l.fout} v ${l.vin}->${l.vout} k-${l.keysDropped}`);
}
