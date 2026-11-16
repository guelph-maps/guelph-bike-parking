// How much does compressing several tiles together save over per-tile gzip?
import { gunzipSync, gzipSync, deflateRawSync, brotliCompressSync, constants } from 'node:zlib';
import { listTiles } from '../../cull-pmtiles.mjs';
const file = process.argv[2];
const { tiles } = listTiles(file);
const raw = [...tiles].map(([k, gz]) => [k, gunzipSync(gz)]);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const br = (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24 } }).length;
const MB = (n) => (n / 1e6).toFixed(3);
const stored = sum([...tiles.values()].map(b => b.length));
console.log(file, 'stored gzip', MB(stored), ' raw', MB(sum(raw.map(r => r[1].length))));
console.log(' per-tile deflate-raw 9', MB(sum(raw.map(r => deflateRawSync(r[1], { level: 9 }).length))));
console.log(' per-tile brotli 11    ', MB(sum(raw.map(r => br(r[1])))));
for (const blockZ of [12, 11, 10]) {
  const groups = new Map();
  for (const [k, b] of raw) { const [z, x, y] = k.split('/').map(Number); const s = Math.max(0, z - blockZ); const key = z <= blockZ ? `z${z}` : `${z}/${x >> s}/${y >> s}`; (groups.get(key) || groups.set(key, []).get(key)).push(b); }
  const g = [...groups.values()].map(a => Buffer.concat(a));
  console.log(` blocks of level ${blockZ} (${g.length}) deflate`, MB(sum(g.map(b => deflateRawSync(b, { level: 9 }).length))), ' brotli', MB(sum(g.map(br))));
}
const all = Buffer.concat(raw.map(r => r[1]));
console.log(' whole file deflate', MB(deflateRawSync(all, { level: 9 }).length), ' brotli', MB(br(all)));
