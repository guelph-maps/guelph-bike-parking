// node worstgap.mjs raw.pmtiles variant.pmtiles level -> the 64x64 px (256-unit) blocks with most background-through-cover pixels, as lat/lng
import { gunzipSync } from 'node:zlib';
import { decodeTile } from '../../../scripts/tiles/own/mvt.mjs';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
const N = 1024, S = 4, R = 16;
function cover(tile) { const m = new Uint8Array(N * N);
  for (const l of tile.layers) if (l.name === 'landuse' || l.name === 'water') for (const f of l.features) {
    const xsAt = Array.from({ length: N }, () => []);
    for (const p of f.parts) { const n = p.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; let x0 = p[2 * i] / S, y0 = p[2 * i + 1] / S, x1 = p[2 * j] / S, y1 = p[2 * j + 1] / S;
      if (y0 === y1) continue; if (y0 > y1) [x0, y0, x1, y1] = [x1, y1, x0, y0];
      for (let y = Math.max(0, Math.ceil(y0 - 0.5)); y < N && y + 0.5 < y1; y++) xsAt[y].push(x0 + (y + 0.5 - y0) / (y1 - y0) * (x1 - x0)); } }
    for (let y = 0; y < N; y++) { const xs = xsAt[y].sort((a, b) => a - b); for (let k = 0; k + 1 < xs.length; k += 2) { const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(N - 1, Math.floor(xs[k + 1] - 0.5)); for (let x = a; x <= b; x++) m[y * N + x] = 1; } } }
  return m; }
function erode(m) { let cur = m; for (let k = 0; k < R; k++) { const o = new Uint8Array(N * N); for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) { const i = y * N + x; o[i] = cur[i] & cur[i - 1] & cur[i + 1] & cur[i - N] & cur[i + N]; } cur = o; } return cur; }
const [rawF, varF, Z] = process.argv.slice(2);
const raw = listTiles(rawF).tiles, vt = listTiles(varF).tiles; const blocks = [];
for (const [k, gz] of vt) { if (!k.startsWith(Z + '/')) continue; const [z, tx, ty] = k.split('/').map(Number);
  const ri = erode(cover(decodeTile(gunzipSync(raw.get(k))))), c = cover(decodeTile(gunzipSync(gz)));
  for (let by = 0; by < 16; by++) for (let bx = 0; bx < 16; bx++) { let g = 0; for (let y = by * 64; y < by * 64 + 64; y++) for (let x = bx * 64; x < bx * 64 + 64; x++) { const i = y * N + x; if (ri[i] && !c[i]) g++; }
    const fx = tx + (bx * 64 + 32) / N, fy = ty + (by * 64 + 32) / N, n = 2 ** z; const lng = fx / n * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * fy / n))) * 180 / Math.PI;
    blocks.push([g, lat.toFixed(4), lng.toFixed(4)]); } }
blocks.sort((a, b) => b[0] - a[0]); console.log(blocks.slice(0, 6).map((b) => b.join(' ')).join('\n'));
