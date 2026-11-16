// Ideal code length of GBT streams under simple adaptive context models (what an
// arithmetic coder would reach), against deflate of the same streams.
import { gunzipSync, deflateRawSync } from 'node:zlib';
import { listTiles } from '../../cull-pmtiles.mjs';
import { decodeTile } from '../../own/mvt.mjs';
const { tiles } = listTiles(process.argv[2]);
const zig = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
// adaptive binary model: p(1) = c1/(c0+c1), counts start 0.4/0.4 (KT-ish), halve at 1024
class Bit { constructor() { this.c = [0.4, 0.4]; } cost(b) { const p = this.c[b] / (this.c[0] + this.c[1]); this.c[b]++; if (this.c[0] + this.c[1] > 255) { this.c[0] /= 2; this.c[1] /= 2; } return -Math.log2(p); } }
class Ctx { constructor() { this.m = new Map(); } get(k) { let b = this.m.get(k); if (!b) this.m.set(k, b = new Bit()); return b; } }
// Exp-Golomb style: bucket k (unary, adaptive per ctx) then k mantissa bits (top 2 adaptive per (ctx,k), rest adaptive per bit pos)
function costValue(ctx, key, v) {
  let k = 0; while ((v + 1) >> (k + 1)) k++;
  let bits = 0;
  for (let i = 0; i < k; i++) bits += ctx.get(key + '|u' + i).cost(1);
  bits += ctx.get(key + '|u' + k).cost(0);
  const m = v + 1 - (1 << k);
  for (let i = k - 1; i >= 0; i--) { const b = (m >> i) & 1; bits += ctx.get(key + '|m' + k + '|' + (k - 1 - i < 2 ? (k - 1 - i) + ':' + (m >> (i + 1)) : 'p' + i)).cost(b); }
  return bits;
}
const bucket = (v) => { let k = 0; while ((v + 1) >> (k + 1)) k++; return Math.min(k, 12); };
let defl = 0, ideal = 0, idealBy = {};
for (const [, gz] of tiles) {
  const t = decodeTile(gunzipSync(gz));
  const ctx = new Ctx();
  for (const l of t.layers) {
    let px = 0, py = 0, prevBx = 0, prevBy = 0;
    const vals = [];
    for (const f of l.features) for (const p of f.parts) {
      for (let i = 0; i < p.length; i += 2) {
        const dx = zig(p[i] - px), dy = zig(p[i + 1] - py); px = p[i]; py = p[i + 1];
        const first = i === 0 ? 'M' : 'L';
        const c = costValue(ctx, `${l.name}x${first}${prevBx}`, dx) + costValue(ctx, `${l.name}y${first}${prevBy}|${bucket(dx)}`, dy);
        ideal += c; idealBy[l.name] = (idealBy[l.name] || 0) + c;
        if (i) { prevBx = bucket(dx); prevBy = bucket(dy); }
        vals.push(dx, dy);
      }
    }
    // deflate of x then y varints for the same layer
    const xs = [], ys = []; for (let i = 0; i < vals.length; i += 2) { xs.push(vals[i]); ys.push(vals[i + 1]); }
    const vb = (a) => { const o = []; for (let v of a) { while (v >= 128) { o.push((v & 127) | 128); v = Math.floor(v / 128); } o.push(v); } return Buffer.from(o); };
    defl += deflateRawSync(Buffer.concat([vb(xs), vb(ys)]), { level: 9 }).length * 8;
  }
}
console.log(process.argv[2], 'coordinates: deflate', (defl / 8e6).toFixed(3), 'MB   adaptive model', (ideal / 8e6).toFixed(3), 'MB', `(${(100 * (1 - ideal / defl)).toFixed(0)}% less)`);
console.log('  by layer (model):', Object.entries(idealBy).map(([k, v]) => `${k} ${(v / 8e3).toFixed(0)}k`).join('  '));
