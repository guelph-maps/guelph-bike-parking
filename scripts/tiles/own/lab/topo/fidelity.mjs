// node fidelity.mjs raw.pmtiles variant.pmtiles...  Rasterises landuse + water per tile (1 px = 4 units, tile area only)
// into a per-pixel bitmask of covering classes and compares with raw:
//   gap   = background shows where raw is covered, deep inside raw cover (raw cover eroded by 16 px = 64 units)
//   wrong = pixels whose class set differs from raw anywhere (shape error of any kind: gaps, overlaps, coarsening)
// Values in per-mille of the covered tile area, per level.
import { gunzipSync } from 'node:zlib';
import { decodeTile, tagsOf } from '../../../scripts/tiles/own/mvt.mjs';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
const N = 1024, S = 4096 / N, R = 16;
const bits = new Map(); const bitOf = (k) => { if (!bits.has(k)) bits.set(k, 1 << bits.size); return bits.get(k); };
function raster(tile) {
  const m = new Uint32Array(N * N);
  for (const l of tile.layers) if (l.name === 'landuse' || l.name === 'water') for (const f of l.features) {
    const bit = bitOf(l.name + ':' + tagsOf(l, f).class);
    const xsAt = Array.from({ length: N }, () => []);
    for (const p of f.parts) { const n = p.length / 2;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; let x0 = p[2 * i] / S, y0 = p[2 * i + 1] / S, x1 = p[2 * j] / S, y1 = p[2 * j + 1] / S;
        if (y0 === y1) continue; if (y0 > y1) [x0, y0, x1, y1] = [x1, y1, x0, y0];
        for (let y = Math.max(0, Math.ceil(y0 - 0.5)); y < N && y + 0.5 < y1; y++) xsAt[y].push(x0 + (y + 0.5 - y0) / (y1 - y0) * (x1 - x0)); } }
    for (let y = 0; y < N; y++) { const xs = xsAt[y].sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) { const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(N - 1, Math.floor(xs[k + 1] - 0.5)); for (let x = a; x <= b; x++) m[y * N + x] |= bit; } }
  }
  return m;
}
function interior(m) { let cur = new Uint8Array(N * N); for (let i = 0; i < N * N; i++) cur[i] = m[i] ? 1 : 0;
  for (let k = 0; k < R; k++) { const o = new Uint8Array(N * N); for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) { const i = y * N + x; o[i] = cur[i] & cur[i - 1] & cur[i + 1] & cur[i - N] & cur[i + N]; } cur = o; } return cur; }
const [rawFile, ...vars] = process.argv.slice(2);
const raw = new Map();
for (const [k, gz] of listTiles(rawFile).tiles) { const m = raster(decodeTile(gunzipSync(gz))); raw.set(k, [m, interior(m)]); }
for (const v of vars) {
  const s = {};
  for (const [k, gz] of listTiles(v).tiles) { const rr = raw.get(k); if (!rr) continue; const [rm, ri] = rr, z = k.split('/')[0];
    const m = raster(decodeTile(gunzipSync(gz))); const r = (s[z] ||= { gap: 0, inn: 0, wrong: 0, cov: 0 });
    for (let i = 0; i < N * N; i++) { if (rm[i]) r.cov++; if (ri[i]) { r.inn++; if (!m[i]) r.gap++; } if (rm[i] !== m[i]) r.wrong++; } }
  console.log(v.padEnd(20), Object.entries(s).filter(([z]) => z < 13 || process.env.ALL).map(([z, r]) => `L${z} gap ${(r.gap / r.inn * 1e3).toFixed(1).padStart(5)}‰ wrong ${(r.wrong / r.cov * 1e3).toFixed(1).padStart(5)}‰`).join(' | '));
}
