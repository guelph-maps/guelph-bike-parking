// Buildings: how many rings are orthogonal (all corners ~90°), and what would encoding
// them as start + angle + edge lengths cost against plain coordinate deltas?
import { gunzipSync, deflateRawSync } from 'node:zlib';
import { listTiles } from '../../cull-pmtiles.mjs';
import { decodeTile } from '../../own/mvt.mjs';
const [file, zoom, tolArg] = process.argv.slice(2);
const TOL = +(tolArg || 0.7); // max distance (tile units) a corner may move to become square
const { tiles } = listTiles(file);
const zig = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
function vbytes(arr) { const o = []; for (let v of arr) { v = Math.round(v); while (v >= 128) { o.push((v & 127) | 128); v = Math.floor(v / 128); } o.push(v); } return Buffer.from(o); }
const D = (b) => deflateRawSync(b, { level: 9 }).length;
let rings = 0, orth = 0, rect = 0, pts = 0, genericB = 0, orthB = 0, n4 = 0;
const ASTEP = Math.PI / 2 / 1024;
for (const [k, gz] of tiles) {
  if (!k.startsWith(zoom + '/')) continue;
  const t = decodeTile(gunzipSync(gz));
  const l = t.layers.find(l => l.name === 'building'); if (!l) continue;
  const gx = [], gy = [], gc = [];       // generic streams
  const ox = [], oy = [], oc = [], oa = [], ol = []; // orth streams
  let px = 0, py = 0, qx = 0, qy = 0;
  // polygons = outer ring + following holes (negative area); optionally sort polygons spatially
  const polys = [];
  for (const f of l.features) for (const p of f.parts) {
    let a = 0; const n = p.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1]; }
    if (a > 0 || !polys.length) polys.push([p]); else polys[polys.length - 1].push(p);
  }
  const key = (p) => { let x = Math.max(0, p[0] + 512) >> 3, y = Math.max(0, p[1] + 512) >> 3; let d = 0; for (let s = 1 << 10; s > 0; s >>= 1) { const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0; d += s * s * ((3 * rx) ^ ry); if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } const t = x; x = y; y = t; } } return d; };
  if (process.env.DBG) console.log(polys.length, polys.slice(0,5).map(q=>key(q[0])));
  if (process.env.SORT) polys.sort((a, b) => key(a[0]) - key(b[0]));
  for (const poly of polys) for (const p of poly) {
    rings++; const n = p.length / 2; pts += n; if (n === 4) n4++;
    gc.push(n);
    for (let i = 0; i < p.length; i += 2) { gx.push(zig(p[i] - px)); gy.push(zig(p[i + 1] - py)); px = p[i]; py = p[i + 1]; }
    // angle of longest edge
    let best = 0, ang = 0;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; const dx = p[2 * j] - p[2 * i], dy = p[2 * j + 1] - p[2 * i + 1]; const L = dx * dx + dy * dy; if (L > best) { best = L; ang = Math.atan2(dy, dx); } }
    ang = ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    const qa = Math.round(ang / ASTEP); ang = qa * ASTEP;
    const c = Math.cos(ang), s = Math.sin(ang);
    // rotate into building frame
    const u = [], v = [];
    for (let i = 0; i < n; i++) { u.push(p[2 * i] * c + p[2 * i + 1] * s); v.push(-p[2 * i] * s + p[2 * i + 1] * c); }
    // each edge must be along u or along v, alternating
    let ok = n % 2 === 0 && n >= 4, startAxis = -1;
    if (ok) {
      for (const sa of [0, 1]) {
        let good = true;
        for (let i = 0; i < n && good; i++) { const j = (i + 1) % n; const axis = (i + sa) % 2; const off = axis === 0 ? Math.abs(v[j] - v[i]) : Math.abs(u[j] - u[i]); if (off > TOL) good = false; }
        if (good) { startAxis = sa; break; }
      }
      ok = startAxis >= 0;
    }
    if (ok) {
      orth++; if (n === 4) rect++;
      oc.push(n * 2 + startAxis); oa.push(qa);
      ox.push(zig(p[0] - qx)); oy.push(zig(p[1] - qy)); qx = p[0]; qy = p[1];
      // n-2 free lengths (last two closing edges implied), in tile units
      for (let i = 0; i < n - 2; i++) { const j = (i + 1) % n; const axis = (i + startAxis) % 2; ol.push(zig(Math.round(axis === 0 ? u[j] - u[i] : v[j] - v[i]))); }
    } else {
      oc.push(n * 2 + 0 /* generic flag via separate count */);
      oa.push(4095);
      for (let i = 0; i < p.length; i += 2) { ox.push(zig(p[i] - qx)); oy.push(zig(p[i + 1] - qy)); qx = p[i]; qy = p[i + 1]; }
    }
  }
  genericB += D(Buffer.concat([vbytes(gc), vbytes(gx), vbytes(gy)]));
  orthB += D(Buffer.concat([vbytes(oc), vbytes(oa), vbytes(ox), vbytes(oy), vbytes(ol)]));
}
console.log(`${file} z${zoom} tol ${TOL}: rings ${rings}, points ${pts} (${(pts / rings).toFixed(2)}/ring), 4-pt ${(100 * n4 / rings).toFixed(0)}%, orthogonal ${(100 * orth / rings).toFixed(0)}% (rect ${(100 * rect / rings).toFixed(0)}%)`);
console.log(`  generic columns ${(genericB / 1e3).toFixed(0)} kB   orth coding ${(orthB / 1e3).toFixed(0)} kB  (${(100 * (1 - orthB / genericB)).toFixed(0)}% less)`);
