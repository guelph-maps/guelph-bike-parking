// Line pieces often start on a vertex already sent (junctions, merged pieces). Cost of the
// coordinate streams with: plain deltas | back-references for repeated starts | + chaining
// pieces inside a feature (reorder/reverse so each starts where the previous ended).
import { gunzipSync, deflateRawSync } from 'node:zlib';
import { listTiles } from '../../cull-pmtiles.mjs';
import { decodeTile } from '../../own/mvt.mjs';
const { tiles } = listTiles(process.argv[2]);
const LAYERS = (process.env.L || 'transportation,waterway').split(',');
const zig = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const vb = (a) => { const o = []; for (let v of a) { while (v >= 128) { o.push((v & 127) | 128); v = Math.floor(v / 128); } o.push(v); } return Buffer.from(o); };
const D = (b) => deflateRawSync(b, { level: 9 }).length;
function chain(parts) {
  const left = parts.slice(), out = [];
  let cur = left.shift(); out.push(cur);
  while (left.length) {
    const ex = cur[cur.length - 2], ey = cur[cur.length - 1];
    let best = -1, rev = false, bd = Infinity;
    for (let i = 0; i < left.length; i++) {
      const p = left[i];
      const d1 = Math.abs(p[0] - ex) + Math.abs(p[1] - ey), d2 = Math.abs(p[p.length - 2] - ex) + Math.abs(p[p.length - 1] - ey);
      if (d1 < bd) { bd = d1; best = i; rev = false; } if (d2 < bd) { bd = d2; best = i; rev = true; }
      if (bd === 0) break;
    }
    let p = left.splice(best, 1)[0];
    if (rev) { const r = new Int32Array(p.length); for (let i = 0; i < p.length; i += 2) { r[i] = p[p.length - 2 - i]; r[i + 1] = p[p.length - 1 - i]; } p = r; }
    out.push(p); cur = p;
  }
  return out;
}
const tot = { plain: 0, refs: 0, chain: 0, chainrefs: 0 };
let starts = 0, hits = 0;
for (const [, gz] of tiles) {
  const t = decodeTile(gunzipSync(gz));
  for (const l of t.layers) {
    if (!LAYERS.includes(l.name)) continue;
    for (const mode of Object.keys(tot)) {
      const xs = [], ys = [], flags = [], refs = [], n = [];
      const seen = new Map(); let ord = 0, px = 0, py = 0;
      for (const f of l.features) {
        const parts = mode.startsWith('chain') && f.type === 2 && f.parts.length > 1 ? chain(f.parts) : f.parts;
        for (const p of parts) {
          n.push(p.length / 2);
          for (let i = 0; i < p.length; i += 2) {
            const key = p[i] * 65536 + p[i + 1];
            if (i === 0 && mode.endsWith('refs')) {
              const s = seen.get(key);
              if (mode === 'refs') { starts++; if (s !== undefined) hits++; }
              if (s !== undefined) { flags.push(1); refs.push(ord - s); px = p[i]; py = p[i + 1]; seen.set(key, ord++); continue; }
              flags.push(0);
            }
            xs.push(zig(p[i] - px)); ys.push(zig(p[i + 1] - py)); px = p[i]; py = p[i + 1];
            seen.set(key, ord++);
          }
        }
      }
      tot[mode] += D(Buffer.concat([vb(n), vb(flags), vb(refs), vb(xs), vb(ys)]));
    }
  }
}
console.log(process.argv[2], LAYERS.join('+'), Object.entries(tot).map(([k, v]) => `${k} ${(v / 1e3).toFixed(1)}k`).join('  '), ` starts on a seen vertex: ${(100 * hits / starts).toFixed(0)}%`);
