// Bytes (payload) and features per layer per level of a GBT or MVT PMTiles file.
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { listTiles } from '../../cull-pmtiles.mjs';
import { decodeTile } from '../../own/mvt.mjs';
import '../../../../js/gbt.js';
const { tiles } = listTiles(process.argv[2]);
const rows = {}, bytes = {}, count = {};
for (const [k, b] of tiles) {
  const z = k.split('/')[0];
  bytes[z] = (bytes[z] || 0) + b.length; count[z] = (count[z] || 0) + 1;
  const mvt = b[0] === 0x47 ? Buffer.from(globalThis.GBT.toMvt(inflateRawSync(b.subarray(1)))) : gunzipSync(b);
  for (const l of decodeTile(mvt).layers) { const r = (rows[l.name] ||= {}); const v = l.features.reduce((s, f) => s + f.parts.reduce((t, p) => t + p.length / 2, 0), 0); r[z] = (r[z] || 0) + v; }
}
const zs = Object.keys(bytes).sort();
console.log(process.argv[2]); console.log(' level  tiles  MB', zs.map(z => `\n  ${z}  ${count[z]}  ${(bytes[z] / 1e6).toFixed(3)}`).join(''));
console.log(' vertices per layer:', zs.join(' / '));
for (const [n, r] of Object.entries(rows)) console.log('  ', n.padEnd(15), zs.map(z => String(r[z] || 0).padStart(7)).join(''));
