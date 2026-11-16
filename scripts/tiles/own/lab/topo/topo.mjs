// Shared-border (topological) simplification of polygon layers in a PMTiles file.
//
//   node topo.mjs <raw.pmtiles> <base.pmtiles> <out.pmtiles> [options]
//
// raw   - a build whose polygon layers are (near) unsimplified (schema-raw.yml).
// base  - the build whose other layers are kept byte for byte (e.g. simp-safe.cut.pmtiles).
//         Only tiles present in base are written; their landuse/water layers are replaced.
// options (per-level lists are "10:24,11:24,12:16,13:1"):
//   --tol      Douglas-Peucker tolerance in tile units (extent 4096) per level   [10:16,11:16,12:16,13:1]
//   --wtol     tolerance for arcs used by water (arcs shared with landuse take the smaller) [= --tol]
//   --clip     clip polygons to the tile plus this buffer (tile units; Planetiler's is 64)     [no clip]
//   --grid     snap vertices to this grid (tile units) before building topology  [1]
//   --minscale scale Planetiler's merge_polygons min_area (landuse 4 px², water 1 px², level 13 0.25 px²),
//              applied to outer rings after simplification; holes go once smaller than tol²   [1]
//   --no-rescue let isolated rings collapse (default: keep them at least as a quadrilateral)
//   --no-fix    skip the crossing repair (default: put back original vertices until no ring of a feature crosses)
//   --no-edge   don't split segments at the tile edges (default: do, so neighbouring tiles agree there)
//   --layers   polygon layers handled together in one topology                    [landuse,water]
//   --algo     dp | vw (Visvalingam-Whyatt, tolerance = sqrt of effective area*2)  [dp]
//   --stats    print per-level stats (shared-vertex share, custom-format potential)
//
// Per tile and level: snap, split segments at the tile edges (so neighbouring tiles agree
// where a border leaves the tile), find junctions TopoJSON-style (a vertex whose neighbours
// differ between the rings passing through it, or a vertex on the tile edge / clip box),
// cut rings into arcs at junctions, store each arc once (canonical direction), simplify each
// arc once with its endpoints fixed, rebuild the rings from the shared simplified arcs, drop
// rings that collapse or flip, and drop holes whose outer ring went.

import { gunzipSync, gzipSync } from 'node:zlib';
import { decodeTile, encodeTile } from '../../../scripts/tiles/own/mvt.mjs';
import { readArchive, writeArchive } from '../../../scripts/tiles/cull-pmtiles.mjs';

// ---------- geometry helpers ----------

export function ringArea(r) { // shoelace on flat [x0,y0,...] without closing point; >0 = MVT exterior (y down, clockwise)
  let a = 0;
  const n = r.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
  return a / 2;
}

function dpKeep(xs, ys, lo, hi, tol2, keep) {
  const stack = [lo, hi];
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    if (b - a < 2) continue;
    const ax = xs[a], ay = ys[a], dx = xs[b] - ax, dy = ys[b] - ay, L2 = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      let px = xs[i] - ax, py = ys[i] - ay, d2;
      if (L2 === 0) d2 = px * px + py * py;
      else {
        let t = (px * dx + py * dy) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - t * dx, qy = py - t * dy;
        d2 = qx * qx + qy * qy;
      }
      if (d2 > best) { best = d2; bi = i; }
    }
    if (best > tol2) { keep[bi] = 1; stack.push(a, bi, bi, b); }
  }
}

// Simplify an open polyline (arrays of x, y), endpoints kept. Closed arcs (first == last) are
// split at the vertex farthest from the start first.
export function simplifyDP(xs, ys, tol, rescue = true) {
  const n = xs.length;
  if (n <= 2 || tol <= 0) return [xs, ys, xs.map((_, i) => i)];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = tol * tol;
  if (xs[0] === xs[n - 1] && ys[0] === ys[n - 1]) {
    let far = 1, fd = -1;
    for (let i = 1; i < n - 1; i++) { const d = (xs[i] - xs[0]) ** 2 + (ys[i] - ys[0]) ** 2; if (d > fd) { fd = d; far = i; } }
    keep[far] = 1;
    dpKeep(xs, ys, 0, far, tol2, keep);
    dpKeep(xs, ys, far, n - 1, tol2, keep);
    // a closed arc (a ring of its own) keeps at least a quadrilateral: the farthest point from
    // the chord on each side, so small ponds and fields shrink to a quad instead of vanishing
    let kept = 0;
    for (let i = 0; i < n; i++) kept += keep[i];
    if (kept < 4 && rescue) {
      const cx = xs[far] - xs[0], cy = ys[far] - ys[0];
      for (const [lo, hi] of [[1, far], [far + 1, n - 1]]) {
        let bi = -1, bd = 0;
        for (let i = lo; i < hi; i++) { const d = Math.abs((xs[i] - xs[0]) * cy - (ys[i] - ys[0]) * cx); if (d > bd) { bd = d; bi = i; } }
        if (bi >= 0) keep[bi] = 1;
      }
    }
  } else dpKeep(xs, ys, 0, n - 1, tol2, keep);
  const ox = [], oy = [], idx = [];
  for (let i = 0; i < n; i++) if (keep[i]) { ox.push(xs[i]); oy.push(ys[i]); idx.push(i); }
  return [ox, oy, idx];
}

// Visvalingam-Whyatt: remove the vertex with the smallest triangle area until all are >= minArea.
export function simplifyVW(xs, ys, tol) {
  const n = xs.length;
  if (n <= 3 || tol <= 0) return [xs, ys, xs.map((_, i) => i)];
  const minA = tol * tol; // triangle area*2 threshold comparable to DP tol (base*height ~ tol*segment)
  const prev = new Int32Array(n), next = new Int32Array(n), area = new Float64Array(n), alive = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) { prev[i] = i - 1; next[i] = i + 1; }
  const tri = (i) => Math.abs((xs[prev[i]] - xs[i]) * (ys[next[i]] - ys[i]) - (xs[next[i]] - xs[i]) * (ys[prev[i]] - ys[i]));
  // simple binary heap of [area, index]
  const heap = [];
  const push = (a, i) => { heap.push([a, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  const closed = xs[0] === xs[n - 1] && ys[0] === ys[n - 1];
  let count = n;
  for (let i = 1; i < n - 1; i++) { area[i] = tri(i); push(area[i], i); }
  while (heap.length) {
    const [a, i] = pop();
    if (!alive[i] || a !== area[i]) continue;
    if (a >= minA) break;
    if (count <= (closed ? 4 : 2)) break;
    alive[i] = 0; count--;
    const p = prev[i], q = next[i];
    next[p] = q; prev[q] = p;
    if (p > 0) { area[p] = Math.max(tri(p), a); push(area[p], p); }
    if (q < n - 1) { area[q] = Math.max(tri(q), a); push(area[q], q); }
  }
  const ox = [], oy = [], idx = [];
  for (let i = 0; i < n; i++) if (alive[i]) { ox.push(xs[i]); oy.push(ys[i]); idx.push(i); }
  return [ox, oy, idx];
}

// Sutherland-Hodgman clip of one ring to the square [lo, hi]^2 (fine for fills: MapLibre only needs
// a little buffer beyond the tile edge for fill antialiasing).
export function clipRing(r, lo, hi) {
  let pts = [];
  for (let i = 0; i < r.length; i += 2) pts.push([r[i], r[i + 1]]);
  const edges = [[0, lo, 1], [0, hi, -1], [1, lo, 1], [1, hi, -1]]; // [axis, value, inside sign]
  for (const [ax, v, sg] of edges) {
    if (!pts.length) break;
    const out = [], ins = (p) => (p[ax] - v) * sg >= 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], ia = ins(a), ib = ins(b);
      if (ia) out.push(a);
      if (ia !== ib) {
        const t = (v - a[ax]) / (b[ax] - a[ax]);
        const q = ax === 0 ? [v, Math.round(a[1] + t * (b[1] - a[1]))] : [Math.round(a[0] + t * (b[0] - a[0])), v];
        out.push(q);
      }
    }
    pts = out;
  }
  const o = [];
  for (const [x, y] of pts) { const m = o.length; if (m && o[m - 2] === x && o[m - 1] === y) continue; o.push(x, y); }
  while (o.length >= 4 && o[0] === o[o.length - 2] && o[1] === o[o.length - 1]) o.length -= 2;
  return Int32Array.from(o);
}

// ---------- topology ----------

const K = (x, y) => (x + 32768) * 65536 + (y + 32768); // numeric vertex key

// rings: array of flat Int32Array/arrays (no closing point). Returns { arcs: [[xs, ys]], refs: per ring [[arcId, reversed]...] }
export function buildTopology(rings, E, splitEdges = true) {
  // 1. clean rings: drop consecutive duplicates; split segments crossing tile edges
  const R = [];
  const edges = splitEdges ? [0, E] : [];
  for (const r of rings) {
    const xs = [], ys = [];
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const x = r[2 * i], y = r[2 * i + 1];
      const j = (i + 1) % n, x2 = r[2 * j], y2 = r[2 * j + 1];
      if (xs.length && xs[xs.length - 1] === x && ys[ys.length - 1] === y) { /* dup */ } else { xs.push(x); ys.push(y); }
      // edge crossings, computed from the canonical (sorted) segment so both rings agree
      const pts = [];
      let ax = x, ay = y, bx = x2, by = y2, flip = false;
      if (ax > bx || (ax === bx && ay > by)) { [ax, ay, bx, by] = [bx, by, ax, ay]; flip = true; }
      for (const e of edges) {
        if ((ax < e && bx > e) || (ax > e && bx < e)) { const t = (e - ax) / (bx - ax); pts.push([t, e, Math.round(ay + t * (by - ay))]); }
        if ((ay < e && by > e) || (ay > e && by < e)) { const t = (e - ay) / (by - ay); pts.push([t, Math.round(ax + t * (bx - ax)), e]); }
      }
      if (pts.length) {
        pts.sort((p, q) => p[0] - q[0]);
        if (flip) pts.reverse();
        for (const [, px, py] of pts) {
          if (xs[xs.length - 1] === px && ys[ys.length - 1] === py) continue;
          if (px === x2 && py === y2) continue;
          xs.push(px); ys.push(py);
        }
      }
    }
    while (xs.length > 1 && xs[0] === xs[xs.length - 1] && ys[0] === ys[ys.length - 1]) { xs.pop(); ys.pop(); }
    R.push([xs, ys]);
  }
  // 2. junctions
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [xs, ys] of R) for (let i = 0; i < xs.length; i++) {
    if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i];
  }
  const nb = new Map(); // key -> neighbour signature (first seen); junction set
  const junction = new Set();
  for (const [xs, ys] of R) {
    const n = xs.length;
    const seenHere = new Set();
    for (let i = 0; i < n; i++) {
      const k = K(xs[i], ys[i]);
      const p = (i + n - 1) % n, q = (i + 1) % n;
      const a = K(xs[p], ys[p]), b = K(xs[q], ys[q]);
      const sig = a < b ? a + '|' + b : b + '|' + a;
      const x = xs[i], y = ys[i];
      if (x === 0 || x === E || y === 0 || y === E || x === minX || x === maxX || y === minY || y === maxY) junction.add(k);
      if (seenHere.has(k)) junction.add(k);
      seenHere.add(k);
      const s = nb.get(k);
      if (s === undefined) nb.set(k, sig);
      else if (s !== sig) junction.add(k);
    }
  }
  // 3. cut rings into arcs, dedupe
  const arcIndex = new Map();
  const arcs = [], uses = [];
  const refs = [];
  const addArc = (axs, ays) => {
    const n = axs.length;
    let rev = false;
    const fx = axs[0], fy = ays[0], lx = axs[n - 1], ly = ays[n - 1];
    if (fx > lx || (fx === lx && fy > ly)) rev = true;
    else if (fx === lx && fy === ly && n > 2) {
      const sx = axs[1], sy = ays[1], tx = axs[n - 2], ty = ays[n - 2];
      if (sx > tx || (sx === tx && sy > ty)) rev = true;
    }
    const cx = rev ? axs.slice().reverse() : axs, cy = rev ? ays.slice().reverse() : ays;
    let key = '';
    for (let i = 0; i < n; i++) key += cx[i] + ',' + cy[i] + ';';
    let id = arcIndex.get(key);
    if (id === undefined) { id = arcs.length; arcIndex.set(key, id); arcs.push([cx, cy]); uses.push(0); }
    uses[id]++;
    return [id, rev];
  };
  for (const [xs, ys] of R) {
    const n = xs.length;
    if (n < 3) { refs.push(null); continue; }
    let start = -1;
    for (let i = 0; i < n; i++) if (junction.has(K(xs[i], ys[i]))) { start = i; break; }
    const rr = [];
    if (start < 0) {
      // closed ring with no junction: anchor at the smallest vertex
      let m = 0;
      for (let i = 1; i < n; i++) if (xs[i] < xs[m] || (xs[i] === xs[m] && ys[i] < ys[m])) m = i;
      const axs = [], ays = [];
      for (let k = 0; k <= n; k++) { axs.push(xs[(m + k) % n]); ays.push(ys[(m + k) % n]); }
      rr.push(addArc(axs, ays));
    } else {
      let axs = [xs[start]], ays = [ys[start]];
      for (let k = 1; k <= n; k++) {
        const i = (start + k) % n;
        axs.push(xs[i]); ays.push(ys[i]);
        if (k === n || junction.has(K(xs[i], ys[i]))) { rr.push(addArc(axs, ays)); axs = [xs[i]]; ays = [ys[i]]; }
      }
    }
    refs.push(rr);
  }
  return { arcs, uses, refs, R };
}

// Rebuild a ring (flat array) from simplified arcs.
function assemble(rr, sarcs) {
  const out = [];
  for (const [id, rev] of rr) {
    const [xs, ys] = sarcs[id];
    const n = xs.length;
    for (let k = 0; k < n - 1; k++) { // drop each arc's last point (it is the next arc's first)
      const i = rev ? n - 1 - k : k;
      const x = xs[i], y = ys[i];
      const m = out.length;
      if (m && out[m - 2] === x && out[m - 1] === y) continue;
      out.push(x, y);
    }
  }
  while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return out;
}

// ---------- custom format estimate ----------

class VW { constructor() { this.b = []; } u(v) { while (v >= 0x80) { this.b.push((v & 0x7f) | 0x80); v >>>= 7; } this.b.push(v); } s(v) { this.u(v < 0 ? -2 * v - 1 : 2 * v); } }

// arcs stored once, rings as arc references; tags as in MVT (key/value indices)
function customBytes(sarcs, feats) {
  const w = new VW();
  w.u(sarcs.length);
  let px = 0, py = 0;
  for (const [xs, ys] of sarcs) {
    const cont = xs[0] === px && ys[0] === py; // starts where the previous arc ended: first point implied
    w.u(xs.length * 2 + (cont ? 1 : 0));
    for (let i = cont ? 1 : 0; i < xs.length; i++) { w.s(xs[i] - px); w.s(ys[i] - py); px = xs[i]; py = ys[i]; }
  }
  for (const f of feats) {
    w.u(f.layer); w.u(f.tags.length); for (const t of f.tags) w.u(t);
    w.u(f.rings.length);
    let last = 0;
    for (const rr of f.rings) { w.u(rr.length); for (const [id, rev] of rr) { const v = rev ? -(id + 1) : id + 1; w.s(v - last); last = v; } }
  }
  return Buffer.from(w.b);
}

// ---------- validity: rings of one feature must not cross ----------

// Segments (arcId * 65536 + segment index) that take part in a proper crossing among the given arcs.
export function crossingArcs(ids, sarcs) {
  const segs = [];
  for (const id of ids) { const [xs, ys] = sarcs[id]; for (let i = 0; i + 1 < xs.length; i++) segs.push([xs[i], ys[i], xs[i + 1], ys[i + 1], id, i]); }
  const G = 128, cells = new Map();
  segs.forEach((g, i) => {
    const x0 = Math.floor(Math.min(g[0], g[2]) / G), x1 = Math.floor(Math.max(g[0], g[2]) / G);
    const y0 = Math.floor(Math.min(g[1], g[3]) / G), y1 = Math.floor(Math.max(g[1], g[3]) / G);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = (x + 1000) * 10000 + y + 1000; let c = cells.get(k); if (!c) cells.set(k, (c = [])); c.push(i); }
  });
  const o = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  const bad = new Set();
  for (const c of cells.values()) for (let a = 0; a < c.length; a++) for (let b = a + 1; b < c.length; b++) {
    const p = segs[c[a]], q = segs[c[b]];
    const d1 = o(p[0], p[1], p[2], p[3], q[0], q[1]), d2 = o(p[0], p[1], p[2], p[3], q[2], q[3]);
    if (d1 * d2 >= 0) continue;
    const d3 = o(q[0], q[1], q[2], q[3], p[0], p[1]), d4 = o(q[0], q[1], q[2], q[3], p[2], p[3]);
    if (d3 * d4 < 0) { bad.add(p[4] * 65536 + p[5]); bad.add(q[4] * 65536 + q[5]); }
  }
  return bad;
}

// ---------- per tile ----------

export function processTile(raw, opts, z, stats) {
  const E0 = 4096;
  const layers = raw.layers.filter((l) => opts.layers.includes(l.name));
  const tol = opts.tol[z] ?? 0, grid = opts.grid[z] ?? 1;
  // Planetiler's merge_polygons min_area (px^2 at 256 px = 256 tile units^2), applied after simplification
  const minAreaOf = (name) => (opts.minscale ?? 1) * 256 * (z >= 13 ? 0.25 : name === 'water' ? 1 : 4);
  const simplify = opts.algo === 'vw' ? simplifyVW : simplifyDP;
  // collect rings
  const rings = [], owner = []; // owner: [layerIdx, featIdx, partIdx]
  layers.forEach((l, li) => {
    if (l.extent !== E0) throw new Error('extent ' + l.extent);
    l.features.forEach((f, fi) => {
      if (f.type !== 3) return;
      f.parts.forEach((p, pi) => {
        let r = p;
        if (opts.clip !== undefined) r = clipRing(r, -opts.clip, E0 + opts.clip);
        if (grid > 1) { r = new Int32Array(p.length); for (let i = 0; i < p.length; i++) r[i] = Math.round(p[i] / grid) * grid; }
        rings.push(r); owner.push([li, fi, pi]);
      });
    });
  });
  const { arcs, uses, refs } = buildTopology(rings, E0, !opts.noEdge);
  // simplify every arc once; where rings of one feature now cross, put back the original vertex
  // farthest from each offending simplified segment (a local DP step), until nothing crosses
  const arcTol = new Float64Array(arcs.length).fill(Infinity);
  owner.forEach(([li], i) => { if (!refs[i]) return; const t = layers[li].name === 'water' && opts.wtol[z] !== undefined ? opts.wtol[z] : tol; for (const [id] of refs[i]) if (t < arcTol[id]) arcTol[id] = t; });
  const sarcs = arcs.map(([xs, ys], id) => simplify(xs, ys, arcTol[id] === Infinity ? tol : arcTol[id], !opts.noRescue));
  const featArcs = new Map();
  owner.forEach(([li, fi], i) => { if (!refs[i]) return; const k = li * 1e6 + fi; let s = featArcs.get(k); if (!s) featArcs.set(k, (s = new Set())); for (const [id] of refs[i]) s.add(id); });
  let fixes = 0, unresolved = 0;
  for (let iter = 0; iter < (opts.noFix ? 0 : 64); iter++) {
    const bad = new Set();
    for (const ids of featArcs.values()) for (const b of crossingArcs(ids, sarcs)) bad.add(b);
    if (!bad.size) break;
    const add = new Map();
    for (const b of bad) {
      const id = Math.floor(b / 65536), k = b % 65536, [ox, oy] = arcs[id], idx = sarcs[id][2];
      const a = idx[k], c = idx[k + 1];
      if (c - a < 2) continue;
      const dx = ox[c] - ox[a], dy = oy[c] - oy[a];
      let best = a + 1, bd = -1;
      for (let i = a + 1; i < c; i++) { const d = Math.abs((ox[i] - ox[a]) * dy - (oy[i] - oy[a]) * dx); if (d > bd) { bd = d; best = i; } }
      let s = add.get(id); if (!s) add.set(id, (s = new Set())); s.add(best);
    }
    if (!add.size) { unresolved = bad.size; break; }
    for (const [id, ins] of add) {
      const [ox, oy] = arcs[id];
      const idx = [...new Set([...sarcs[id][2], ...ins])].sort((p, q) => p - q);
      sarcs[id] = [idx.map((i) => ox[i]), idx.map((i) => oy[i]), idx];
      fixes += ins.size;
    }
    if (iter === 63) unresolved = bad.size;
  }
  // rebuild
  const newParts = layers.map((l) => l.features.map(() => []));
    let ringsIn = 0, ringsOut = 0;
  const custFeats = new Map();
  for (let i = 0; i < rings.length; i++) {
    const [li, fi, pi] = owner[i];
    const f = layers[li].features[fi];
    const full = ringArea(f.parts[pi]), orig = ringArea(rings[i]); // before / after the optional clip
    const exterior = full > 0;
    ringsIn++;
    if (!refs[i]) { newParts[li][fi].push({ exterior, ok: false }); continue; }
    const r = assemble(refs[i], sarcs);
    const a = ringArea(r);
    // min area judged on the whole ring: a big polygon whose in-tile sliver is small must stay
    const thr = exterior ? Math.max(minAreaOf(layers[li].name), 0.5) : Math.max(tol * tol, 0.5);
    const ok = r.length >= 6 && Math.sign(a) === Math.sign(full) && Math.abs(a) >= 0.5 && Math.abs(a) * Math.abs(full / (orig || 1)) >= thr; // holes: gone once smaller than the tolerance, as a JTS ring collapse would
    newParts[li][fi].push({ r, exterior, ok, ref: refs[i] });
  }
  const out = [];
  layers.forEach((l, li) => {
    const feats = [];
    l.features.forEach((f, fi) => {
      if (f.type !== 3) { feats.push(f); return; }
      const parts = [], rr = [];
      let outerOk = false;
      for (const p of newParts[li][fi]) {
        if (p.exterior) outerOk = p.ok;
        if (p.ok && (p.exterior || outerOk)) { parts.push(Int32Array.from(p.r)); rr.push(p.ref); ringsOut++; }
      }
      if (parts.length) { feats.push({ ...f, parts }); custFeats.set(li + ":" + feats.length, { layer: li, tags: f.tags, rings: rr }); }
    });
    out.push({ ...l, features: feats });
  });
  if (stats) {
    const s = (stats[z] ||= { tiles: 0, vin: 0, vout: 0, vShared: 0, arcs: 0, arcVerts: 0, arcVertsOnce: 0, mvt: 0, custom: 0, ringsIn: 0, ringsOut: 0 });
    s.tiles++; s.ringsIn += ringsIn; s.ringsOut += ringsOut; s.fixes = (s.fixes || 0) + fixes; s.unresolved = (s.unresolved || 0) + unresolved;
    for (const r of rings) s.vin += r.length / 2;
    arcs.forEach(([xs], id) => { const inner = xs.length - 1; if (uses[id] > 1) s.vShared += inner * uses[id]; });
    s.arcs += arcs.length;
    for (const l of out) for (const f of l.features) for (const p of f.parts) s.vout += p.length / 2;
    // custom-format potential: gzip(arcs once + refs) vs gzip(the MVT layers we write)
    // arcs numbered and oriented in order of first use, so arc deltas follow the ring traversal
    const remap = new Map(), flip = new Map(), keptArcs = [];
    for (const f of custFeats.values()) for (const rr of f.rings) for (const [id, rev] of rr) if (!remap.has(id)) {
      remap.set(id, keptArcs.length); flip.set(id, rev);
      const [xs, ys] = sarcs[id];
      keptArcs.push(rev ? [xs.slice().reverse(), ys.slice().reverse()] : [xs, ys]);
    }
    const cf = [...custFeats.values()].map((f) => ({ ...f, rings: f.rings.map((rr) => rr.map(([id, rev]) => [remap.get(id), rev !== flip.get(id)])) }));
    const tables = Buffer.concat(out.flatMap((l) => [...l.keys.map((k) => Buffer.from(k)), ...l.values]));
    for (const f of custFeats.values()) for (const rr of f.rings) for (const [id] of rr) s.refPts = (s.refPts || 0) + sarcs[id][0].length - 1;
    for (const id of remap.keys()) s.onePts = (s.onePts || 0) + sarcs[id][0].length - 1;
    s.custom += gzipSync(Buffer.concat([customBytes(keptArcs, cf), tables])).length;
    // same format with every arc reference given its own copy (no sharing): isolates the arcs-once effect
    const dupArcs = [];
    const cfd = [...custFeats.values()].map((f) => ({ ...f, rings: f.rings.map((rr) => rr.map(([id, rev]) => {
      const [xs, ys] = sarcs[id]; dupArcs.push(rev ? [xs.slice().reverse(), ys.slice().reverse()] : [xs, ys]); return [dupArcs.length - 1, false]; })) }));
    s.customDup = (s.customDup || 0) + gzipSync(Buffer.concat([customBytes(dupArcs, cfd), tables])).length;
    s.mvt += gzipSync(encodeTile({ layers: out })).length;
  }
  return out;
}

// ---------- whole file ----------

export function parseLevels(s, def) {
  const o = { ...def };
  if (s) for (const kv of s.split(',')) { const [k, v] = kv.split(':'); if (v === undefined) { for (const z of [10, 11, 12, 13, 14]) o[z] = +k; } else o[+k] = +v; }
  return o;
}

export function run(rawFile, baseFile, outFile, opts) {
  const raw = readArchive(rawFile), base = readArchive(baseFile);
  const outTiles = new Map();
  const stats = opts.stats ? {} : null;
  for (const [key, gz] of base.tiles) {
    const z = +key.split('/')[0];
    const bt = decodeTile(gunzipSync(gz));
    const rgz = raw.tiles.get(key);
    const rt = rgz ? decodeTile(gunzipSync(rgz)) : { layers: [] };
    if (opts.identity) { outTiles.set(key, gzipSync(encodeTile(bt))); continue; }
    const newLayers = processTile(rt, opts, z, stats);
    const byName = new Map(newLayers.map((l) => [l.name, l]));
    // keep base layer order; replace handled layers in place, add missing handled ones at their raw position
    const layers = [];
    for (const l of bt.layers) {
      if (opts.layers.includes(l.name)) { if (byName.has(l.name)) { layers.push(byName.get(l.name)); byName.delete(l.name); } }
      else layers.push(l);
    }
    for (const l of byName.values()) if (l.features.length) {
      // insert in schema order: before the first base layer that comes after it in raw order
      const order = rt.layers.map((x) => x.name);
      const idx = layers.findIndex((x) => order.indexOf(x.name) > order.indexOf(l.name));
      if (idx < 0) layers.push(l); else layers.splice(idx, 0, l);
    }
    outTiles.set(key, gzipSync(encodeTile({ layers })));
  }
  writeArchive(outFile, base.header, base.metadata, outTiles);
  return stats;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('topo.mjs')) {
  const [rawFile, baseFile, outFile, ...rest] = process.argv.slice(2);
  const arg = (n) => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : undefined; };
  const opts = {
    tol: parseLevels(arg('tol'), { 10: 16, 11: 16, 12: 16, 13: 1 }),
    grid: parseLevels(arg('grid'), {}),
    wtol: parseLevels(arg('wtol'), {}),
    clip: arg('clip') !== undefined ? +arg('clip') : undefined,
    minscale: +(arg('minscale') || 1),
    identity: rest.includes('--identity'),
    noRescue: rest.includes('--no-rescue'), noFix: rest.includes('--no-fix'), noEdge: rest.includes('--no-edge'),
    layers: (arg('layers') || 'landuse,water').split(','),
    algo: arg('algo') || 'dp',
    stats: rest.includes('--stats'),
  };
  const t0 = Date.now();
  const stats = run(rawFile, baseFile, outFile, opts);
  const { statSync } = await import('node:fs');
  console.log(`${outFile} ${(statSync(outFile).size / 1e6).toFixed(4)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (stats) {
    console.log('lvl tiles  verts-in verts-out shared%   arcs  rings in/out   mvt-gz  custom-gz  saving  (custom without sharing)');
    const T = { mvt: 0, custom: 0, dup: 0 };
    for (const [z, s] of Object.entries(stats)) {
      T.mvt += s.mvt; T.custom += s.custom; T.dup += s.customDup;
      console.log(z.padStart(3), String(s.tiles).padStart(5), String(s.vin).padStart(9), String(s.vout).padStart(9),
        (100 * s.vShared / s.vin).toFixed(1).padStart(7), String(s.arcs).padStart(6), `${s.ringsIn}/${s.ringsOut}`.padStart(13),
        String(s.mvt).padStart(8), String(s.custom).padStart(10), ((1 - s.custom / s.mvt) * 100).toFixed(1).padStart(6) + '%', String(s.customDup).padStart(8),
        ' dup verts after simplification', (100 * (1 - s.onePts / s.refPts)).toFixed(1) + '%', ' vertices put back', s.fixes, s.unresolved ? 'UNRESOLVED ' + s.unresolved : '');
    }
    console.log('all', ' '.repeat(57), String(T.mvt).padStart(8), String(T.custom).padStart(10), ((1 - T.custom / T.mvt) * 100).toFixed(1).padStart(6) + '%', String(T.dup).padStart(8));
  }
}
