// node gaps.mjs raw.pmtiles variant.pmtiles... -> per level: background pixels that show through inside the
// raw land cover (union of landuse + water), i.e. gaps/slivers opened between neighbouring polygons.
// Raster: 1 px = 4 tile units (1024 x 1024 per tile, tile area only). Interior = raw coverage eroded by R px,
// so differences along the outer edge of the cover are not counted.
import { gunzipSync } from 'node:zlib';
import { decodeTile } from '../../../scripts/tiles/own/mvt.mjs';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
const N = 1024, S = 4096 / N, R = +(process.env.R || 2);
const LAYERS = (process.env.L || 'landuse,water').split(',');
function cover(tile) {
  const m = new Uint8Array(N * N);
  for (const l of tile.layers) if (LAYERS.includes(l.name)) for (const f of l.features) {
    const fm = new Uint8Array(N * N); // even-odd per feature
    const xsAt = Array.from({ length: N }, () => []);
    for (const p of f.parts) { const n = p.length / 2;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; let x0 = p[2 * i] / S, y0 = p[2 * i + 1] / S, x1 = p[2 * j] / S, y1 = p[2 * j + 1] / S;
        if (y0 === y1) continue; if (y0 > y1) [x0, y0, x1, y1] = [x1, y1, x0, y0];
        for (let y = Math.max(0, Math.ceil(y0 - 0.5)); y < N && y + 0.5 < y1; y++) { const yc = y + 0.5; if (yc < y0) continue; xsAt[y].push(x0 + (yc - y0) / (y1 - y0) * (x1 - x0)); } } }
    for (let y = 0; y < N; y++) { const xs = xsAt[y].sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) { const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(N - 1, Math.floor(xs[k + 1] - 0.5)); for (let x = a; x <= b; x++) m[y * N + x] = 1; } }
  }
  return m;
}
function erode(m, r) { let cur = m; for (let k = 0; k < r; k++) { const o = new Uint8Array(N * N);
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) { const i = y * N + x; o[i] = cur[i] & cur[i - 1] & cur[i + 1] & cur[i - N] & cur[i + N]; } cur = o; } return cur; }
const [rawFile, ...vars] = process.argv.slice(2);
const raw = listTiles(rawFile).tiles;
const rawInt = new Map();
for (const [k, gz] of raw) rawInt.set(k, erode(cover(decodeTile(gunzipSync(gz))), R));
for (const v of vars) {
  const t = listTiles(v).tiles, s = {};
  for (const [k, gz] of t) { const ri = rawInt.get(k); if (!ri) continue; const z = k.split('/')[0];
    const c = cover(decodeTile(gunzipSync(gz))); let gap = 0, inn = 0; for (let i = 0; i < N * N; i++) if (ri[i]) { inn++; if (!c[i]) gap++; }
    const r = (s[z] ||= [0, 0]); r[0] += gap; r[1] += inn; }
  console.log(v.padEnd(22), Object.entries(s).map(([z, [g, n]]) => `L${z} ${(g / n * 1e4).toFixed(1)}‱`).join('  '));
}
