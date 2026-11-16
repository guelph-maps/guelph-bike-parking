// Bytes per layer per zoom level (uncompressed MVT, plus gzip share) for a pmtiles file.
import { gunzipSync, gzipSync } from 'node:zlib';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
function* fields(buf) {
  let i = 0;
  const varint = () => { let v = 0, s = 1, b; do { b = buf[i++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80); return v; };
  while (i < buf.length) {
    const key = varint(), f = Math.floor(key / 8), t = key & 7;
    if (t === 2) { const len = varint(); yield [f, buf.subarray(i, i + len)]; i += len; }
    else if (t === 0) { yield [f, varint()]; }
    else if (t === 5) { i += 4; } else if (t === 1) { i += 8; } else throw new Error('wire ' + t);
  }
}
const { tiles } = listTiles(process.argv[2]);
const out = {}; const zip = {}; let total = 0;
for (const [k, gz] of tiles) {
  const z = k.split('/')[0]; const raw = gunzipSync(gz);
  for (const [f, layer] of fields(raw)) if (f === 3) {
    let name = '', n = 0;
    for (const [g, v] of fields(layer)) { if (g === 1) name = v.toString(); if (g === 2) n++; }
    const r = (out[name] ||= {}); r[z] = (r[z] || 0) + layer.length;
    (zip[name] ||= 0); zip[name] += gzipSync(layer).length;
    r.n = (r.n || 0) + n;
  }
  total += gz.length;
}
const zs = ['10', '11', '12', '13', '14'];
console.log('layer'.padEnd(16), zs.map(z => ('z' + z).padStart(7)).join(''), '  raw MB  ~gzip MB  features');
for (const [name, r] of Object.entries(out).sort((a, b) => zip[b[0]] - zip[a[0]])) {
  const sum = zs.reduce((s, z) => s + (r[z] || 0), 0);
  console.log(name.padEnd(16), zs.map(z => ((r[z] || 0) / 1e3).toFixed(0).padStart(7)).join(''), (sum / 1e6).toFixed(2).padStart(8), (zip[name] / 1e6).toFixed(2).padStart(8), String(r.n).padStart(9));
}
console.log('(z columns in KB raw)  file tiles gzip total', (total / 1e6).toFixed(2), 'MB');
