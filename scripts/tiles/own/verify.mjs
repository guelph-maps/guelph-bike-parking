// Invariants: per level and layer, total line length and polygon area inside the tile
// square [0,E]^2 (in 4096 units), counting only features some style layer draws.
// Prune, merge and buffer should leave both unchanged; quantize nearly so.
import { gunzipSync } from 'node:zlib';
import { listTiles } from '../cull-pmtiles.mjs';
import { decodeTile, tagsOf } from './mvt.mjs';
import { loadStyle, activeLayers, drawSignature } from './style-eval.mjs';
const [refFile, outFile] = process.argv.slice(2);
const style = loadStyle('../../../js/style.js');
function clipSeg(ax, ay, bx, by, E) { // Liang-Barsky, returns clipped length
  let t0 = 0, t1 = 1; const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax], [dx, E - ax], [-dy, ay], [dy, E - ay]]) {
    if (p === 0) { if (q < 0) return 0; continue; }
    const t = q / p; if (p < 0) { if (t > t1) return 0; if (t > t0) t0 = t; } else { if (t < t0) return 0; if (t < t1) t1 = t; }
  }
  return Math.hypot(dx, dy) * (t1 - t0);
}
function clipRingRect(r, E) {
  let pts = []; for (let i = 0; i < r.length; i += 2) pts.push([r[i], r[i + 1]]);
  for (const [ax, sgn, b] of [[0, 1, 0], [0, -1, E], [1, 1, 0], [1, -1, E]]) {
    const o = []; const inn = (p) => sgn * (p[ax] - b) >= 0;
    for (let i = 0; i < pts.length; i++) { const c = pts[i], p = pts[(i + pts.length - 1) % pts.length];
      if (inn(c)) { if (!inn(p)) o.push(ix(p, c)); o.push(c); } else if (inn(p)) o.push(ix(p, c)); }
    function ix(p, c) { const t = (b - p[ax]) / (c[ax] - p[ax]); return [p[0] + (c[0] - p[0]) * t, p[1] + (c[1] - p[1]) * t]; }
    pts = o; if (!pts.length) return 0;
  }
  let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}
function measure(file, filterVisible) {
  const { tiles } = listTiles(file); const top = Math.max(...[...tiles.keys()].map(k => +k.split('/')[0]));
  const m = {};
  for (const [k, gz] of tiles) {
    const z = +k.split('/')[0];
    const zs = []; for (let q = z; q <= (z >= top ? 18 : z + 0.999); q += 0.25) zs.push(q);
    for (const l of decodeTile(gunzipSync(gz)).layers) {
      const act = activeLayers(style, l.name, z, z >= top ? 99 : z + 1);
      const sc = 4096 / l.extent; const r = (m[z + ' ' + l.name] ||= { len: 0, area: 0, pts: 0, n: 0 });
      for (const f of l.features) {
        if (filterVisible && !drawSignature(act, tagsOf(l, f), f.type, zs).length) continue;
        r.n++;
        for (const p of f.parts) {
          if (f.type === 1) { for (let i = 0; i < p.length; i += 2) if (p[i] >= 0 && p[i] < l.extent && p[i + 1] >= 0 && p[i + 1] < l.extent) r.pts++; }
          else if (f.type === 2) { for (let i = 2; i < p.length; i += 2) r.len += sc * clipSeg(p[i - 2], p[i - 1], p[i], p[i + 1], l.extent); }
          else r.area += sc * sc * clipRingRect(p, l.extent);
        }
      }
    }
  }
  return m;
}
const a = measure(refFile, true), b = measure(outFile, false);
for (const k of Object.keys(a).sort()) {
  const x = a[k], y = b[k] || { len: 0, area: 0, pts: 0, n: 0 };
  const d = (u, v) => u === 0 && v === 0 ? '   =   ' : ((v - u) / (u || 1) * 100).toFixed(3).padStart(7) + '%';
  console.log(k.padEnd(18), 'visible feats', String(x.n).padStart(5), '->', String(y.n).padStart(5), ' len', d(x.len, y.len), ' area', d(x.area, y.area), ' pts', x.pts, '->', y.pts);
}
