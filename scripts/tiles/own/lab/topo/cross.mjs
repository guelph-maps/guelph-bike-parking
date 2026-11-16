// node cross.mjs file.pmtiles [layer] -> per level: features whose rings cross themselves or each other (proper crossings)
import { gunzipSync } from 'node:zlib';
import { decodeTile, tagsOf } from '../../../scripts/tiles/own/mvt.mjs';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
export function featureCrossings(parts) {
  const segs = [];
  for (const p of parts) { const n = p.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; segs.push([p[2 * i], p[2 * i + 1], p[2 * j], p[2 * j + 1]]); } }
  const G = 256, cells = new Map();
  segs.forEach((s, i) => { const x0 = Math.floor(Math.min(s[0], s[2]) / G), x1 = Math.floor(Math.max(s[0], s[2]) / G), y0 = Math.floor(Math.min(s[1], s[3]) / G), y1 = Math.floor(Math.max(s[1], s[3]) / G);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x * 100000 + y; let c = cells.get(k); if (!c) cells.set(k, c = []); c.push(i); } });
  const o = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  const seen = new Set(); let n = 0;
  for (const c of cells.values()) for (let a = 0; a < c.length; a++) for (let b = a + 1; b < c.length; b++) {
    const i = c[a], j = c[b], key = i * 1e7 + j; if (seen.has(key)) continue; seen.add(key);
    const [p, q] = [segs[i], segs[j]];
    const d1 = o(p[0], p[1], p[2], p[3], q[0], q[1]), d2 = o(p[0], p[1], p[2], p[3], q[2], q[3]), d3 = o(q[0], q[1], q[2], q[3], p[0], p[1]), d4 = o(q[0], q[1], q[2], q[3], p[2], p[3]);
    if (d1 * d2 < 0 && d3 * d4 < 0) n++;
  }
  return n;
}
if (process.argv[1].endsWith('cross.mjs')) {
  const layer = process.argv[3] || 'landuse';
  const { tiles } = listTiles(process.argv[2]); const s = {};
  for (const [k, gz] of tiles) { const z = k.split('/')[0];
    for (const l of decodeTile(gunzipSync(gz)).layers) if (l.name === layer) for (const f of l.features) { const n = featureCrossings(f.parts); const r = (s[z] ||= { feats: 0, x: 0 }); if (n) { r.feats++; r.x += n; } } }
  console.log(process.argv[2], JSON.stringify(s));
}
