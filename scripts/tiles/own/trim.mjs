// Post-processes a vector PMTiles file into a smaller one that is still plain MVT
// (nothing extra for a phone to decode). Every step is optional:
//
//   prune      drop features no style layer can draw at the zooms a tile level serves,
//              and attributes that change nothing drawn there (js/style.js is evaluated)
//   dropIds    drop feature ids (the style never reads them)
//   merge      merge features whose (pruned) attributes are identical into one
//              multi-geometry, join lines end to end, and order transportation by class
//              so bigger roads draw over smaller ones where they cross. { keepLabelled: true }
//              leaves features a label is drawn from alone and in place, so labels land where they did
//   buffer     clip each feature to what it needs beyond the tile edge: half its widest
//              drawn line width plus antialiasing, fillPx for fills; features a line
//              label can follow keep the original buffer (keepDashed: dashed lines too, so
//              dash phase inside the tile stays as it was)
//   quantize   { level: extent | { layer: extent } } coarser coordinate grid per level (or per layer)
//   collinear  drop points exactly on the straight line between their neighbours
//
// node trim.mjs in.pmtiles out.pmtiles recommended
// node trim.mjs in.pmtiles out.pmtiles '{"prune":true,"merge":true,"quantize":{"10":1024}}'
// or import { trimPmtiles } and call trimPmtiles(input, output, options) -> stats.
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readArchive, writeArchive } from '../cull-pmtiles.mjs';
import { decodeTile, encodeTile, tagsOf, buildLayer } from './mvt.mjs';
import { loadStyle, activeLayers, drawSignature } from './style-eval.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TILE_PX = 512; // MapLibre draws a vector tile 512 css px wide at its own zoom
const MAX_GL_ZOOM = 18; // Leaflet 19

// Draw order inside the transportation layer (later draws on top).
const CLASS_RANK = ['path', 'footway', 'bridleway', 'track', 'steps', 'cycleway', 'rail', 'service', 'pedestrian',
  'minor', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];

// What the 2026-11-16 measurements recommend (see the report): invisible on screenshots
// apart from dash phase on lines crossing tile edges. Level 10 (drawn only between map
// zoom 11.5 and 12, js/map.js) wasn't measured, so it keeps full precision.
export const RECOMMENDED = {
  prune: true, dropIds: true, merge: { keepLabelled: true }, buffer: {}, collinear: true,
  quantize: { 11: 2048, 12: 2048 },
};

// ---- geometry helpers -------------------------------------------------------

const f = (pl, x, y) => pl[0] * x + pl[1] * y + pl[2];

// Exact mode: no new vertices. Keep inside vertices and the outside vertices next to
// them; the chord that replaces a run of outside vertices lies wholly outside the
// half-plane, so everything inside it is unchanged (no rounding jogs at tile edges).
function clipRingExact(r, pl) {
  const n = r.length / 2, inn = [];
  for (let i = 0; i < n; i++) inn.push(f(pl, r[2 * i], r[2 * i + 1]) >= 0);
  const out = [];
  for (let i = 0; i < n; i++) if (inn[i] || inn[(i + n - 1) % n] || inn[(i + 1) % n]) out.push(r[2 * i], r[2 * i + 1]);
  return out;
}
function clipLineExact(l, pl) {
  const n = l.length / 2, inn = [];
  for (let i = 0; i < n; i++) inn.push(f(pl, l[2 * i], l[2 * i + 1]) >= 0);
  const pieces = [];
  let cur = null;
  for (let i = 0; i + 1 < n; i++) {
    if (inn[i] || inn[i + 1]) {
      if (!cur) { cur = [l[2 * i], l[2 * i + 1]]; pieces.push(cur); }
      cur.push(l[2 * i + 2], l[2 * i + 3]);
    } else cur = null;
  }
  return pieces;
}

function clipRing(r, pl) {
  const out = [], n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;
    const cx = r[2 * i], cy = r[2 * i + 1], px = r[2 * j], py = r[2 * j + 1];
    const fc = f(pl, cx, cy), fp = f(pl, px, py);
    if (fc >= 0) {
      if (fp < 0) { const t = fp / (fp - fc); out.push(px + (cx - px) * t, py + (cy - py) * t); }
      out.push(cx, cy);
    } else if (fp >= 0) { const t = fp / (fp - fc); out.push(px + (cx - px) * t, py + (cy - py) * t); }
  }
  return out;
}

function clipLine(l, pl) {
  const pieces = [];
  let cur = [];
  const n = l.length / 2;
  for (let i = 0; i < n; i++) {
    const cx = l[2 * i], cy = l[2 * i + 1], fc = f(pl, cx, cy);
    if (i > 0) {
      const px = l[2 * i - 2], py = l[2 * i - 1], fp = f(pl, px, py);
      if ((fp >= 0) !== (fc >= 0)) {
        const t = fp / (fp - fc), ix = px + (cx - px) * t, iy = py + (cy - py) * t;
        if (fp >= 0) { cur.push(ix, iy); pieces.push(cur); cur = []; } else cur.push(ix, iy);
      }
    }
    if (fc >= 0) cur.push(cx, cy);
  }
  if (cur.length) pieces.push(cur);
  return pieces.filter((p) => p.length >= 4);
}

function bbox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
  }
  return [x0, y0, x1, y1];
}
const boxInside = (b, pl) => f(pl, b[0], b[1]) >= 0 && f(pl, b[2], b[1]) >= 0 && f(pl, b[0], b[3]) >= 0 && f(pl, b[2], b[3]) >= 0;
const boxOutside = (b, pl) => f(pl, b[0], b[1]) < 0 && f(pl, b[2], b[1]) < 0 && f(pl, b[0], b[3]) < 0 && f(pl, b[2], b[3]) < 0;

function area2(r) {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a;
}

// Snap to the grid (scale s, round), drop repeated and (optionally) collinear points.
function snap(p, s, ring, collinear) {
  const o = [];
  for (let i = 0; i < p.length; i += 2) {
    const x = Math.round(p[i] * s), y = Math.round(p[i + 1] * s);
    const k = o.length;
    if (k && o[k - 2] === x && o[k - 1] === y) continue;
    o.push(x, y);
  }
  if (ring) while (o.length >= 4 && o[0] === o[o.length - 2] && o[1] === o[o.length - 1]) o.length -= 2;
  if (!collinear) return o;
  // straight-through points only (cross = 0, dot > 0), repeated until stable
  let changed = true, q = o;
  while (changed && q.length >= 6) {
    changed = false;
    const n = q.length / 2, keep = [];
    for (let i = 0; i < n; i++) {
      if (!ring && (i === 0 || i === n - 1)) { keep.push(q[2 * i], q[2 * i + 1]); continue; }
      const a = (i + n - 1) % n, b = (i + 1) % n;
      const ax = q[2 * i] - q[2 * a], ay = q[2 * i + 1] - q[2 * a + 1], bx = q[2 * b] - q[2 * i], by = q[2 * b + 1] - q[2 * i + 1];
      if (ax * by - ay * bx === 0 && ax * bx + ay * by > 0) { changed = true; continue; }
      keep.push(q[2 * i], q[2 * i + 1]);
    }
    q = keep;
  }
  return q;
}

// Join line parts that meet end to end (only where exactly two ends meet).
function joinLines(parts) {
  let ps = parts.map((p) => Array.from(p));
  for (;;) {
    const ends = new Map();
    const key = (x, y) => x + ',' + y;
    ps.forEach((p, i) => {
      for (const [atStart, x, y] of [[true, p[0], p[1]], [false, p[p.length - 2], p[p.length - 1]]]) {
        const k = key(x, y);
        (ends.get(k) || ends.set(k, []).get(k)).push({ i, atStart });
      }
    });
    const used = new Set();
    let joined = 0;
    for (const list of ends.values()) {
      if (list.length !== 2) continue;
      const [a, b] = list;
      if (a.i === b.i || used.has(a.i) || used.has(b.i)) continue;
      let pa = ps[a.i], pb = ps[b.i];
      // orient so pa ends where pb starts
      if (a.atStart) pa = rev(pa);
      if (!b.atStart) pb = rev(pb);
      ps[a.i] = pa.concat(pb.slice(2));
      ps[b.i] = null;
      used.add(a.i); used.add(b.i);
      joined++;
    }
    ps = ps.filter(Boolean);
    if (!joined) return ps;
  }
}
function rev(p) { const o = []; for (let i = p.length - 2; i >= 0; i -= 2) o.push(p[i], p[i + 1]); return o; }

// ---- the whole step -------------------------------------------------------------

export function trimPmtiles(input, output, opts = {}) {
  const { header, metadata, tiles } = readArchive(input);
  const top = header.maxZoom;
  const style = opts.prune || opts.buffer || opts.merge?.keepLabelled ? loadStyle(opts.style || join(ROOT, 'js', 'style.js')) : null;

  const zoomsOf = (L) => {
    const hi = L >= top ? MAX_GL_ZOOM : L + 0.999;
    const zs = [];
    for (let z = L; z <= hi + 1e-9; z += 0.125) zs.push(+z.toFixed(3));
    if (zs[zs.length - 1] < hi) zs.push(hi);
    return zs;
  };
  const activeCache = new Map();
  const active = (name, L) => {
    const k = name + '@' + L;
    if (!activeCache.has(k)) activeCache.set(k, activeLayers(style, name, L, L >= top ? 99 : L + 1));
    return activeCache.get(k);
  };

  const stats = {};
  const out = new Map();
  for (const [k, gz] of tiles) {
    const [z, x, y] = k.split('/').map(Number);
    const st = (stats[z] ||= { tiles: 0, inBytes: 0, outBytes: 0, layers: {} });
    st.tiles++;
    st.inBytes += gz.length;
    const tile = decodeTile(gunzipSync(gz));
    const q = opts.quantize?.[z];
    const zooms = zoomsOf(z);

    const layersOut = [];
    for (const layer of tile.layers) {
      const newExtent = typeof q === 'object' ? q[layer.name] : q;
      const E = layer.extent, s = newExtent ? newExtent / E : 1;
      const ls = (st.layers[layer.name] ||= { fin: 0, fout: 0, vin: 0, vout: 0, keysDropped: 0 });
      const act = style ? active(layer.name, z) : null;
      const feats = [];
      for (const feat of layer.features) {
        ls.fin++;
        for (const p of feat.parts) ls.vin += p.length / 2;
        let props = tagsOf(layer, feat);
        let sig = null;
        if (style) sig = drawSignature(act, props, feat.type, zooms);
        if (opts.prune) {
          if (!sig.length) continue;
          const ref = JSON.stringify(sig);
          for (const key of Object.keys(props)) {
            if (key.startsWith('_')) continue; // for the decoder (js/gbt.js), not the style
            const trial = { ...props };
            delete trial[key];
            if (JSON.stringify(drawSignature(act, trial, feat.type, zooms)) === ref) { props = trial; ls.keysDropped++; }
          }
        }

        // planes this feature is clipped to
        const planes = [];
        if (opts.buffer && feat.type !== 1) {
          const b = opts.buffer;
          let units;
          if (feat.type === 3 && !sig.some((l) => l.type === 'line')) units = (b.fillPx ?? 2) * E / TILE_PX;
          else if (sig.some((l) => l.type === 'symbol' && l.layout['symbol-placement'] === 'line')) units = Infinity;
          else if (b.keepDashed && sig.some((l) => l.dashed)) units = Infinity;
          else {
            units = 0;
            for (const l of sig) {
              if (l.type !== 'line') continue;
              const w = l.vals['line-width'] || l.zs.map(() => 1);
              l.zs.forEach((zz, i) => {
                const px = (w[i] ?? 1) / 2 + (b.lineAAPx ?? 1);
                units = Math.max(units, px * E / (TILE_PX * 2 ** (zz - z)));
              });
            }
            if (!units) units = (b.fillPx ?? 2) * E / TILE_PX;
          }
          units = Math.ceil(units + (b.extraPx ?? 0) * E / TILE_PX);
          const exact = b.mode !== 'cut';
          if (units < (b.max ?? 64)) for (const pl of [[1, 0, units], [-1, 0, E + units], [0, 1, units], [0, -1, E + units]]) planes.push({ pl, exact });
        }

        let parts;
        if (feat.type === 1) {
          parts = feat.parts.map((p) => snap(Array.from(p), s, false, false)).filter((p) => p.length);
        } else if (feat.type === 2) {
          parts = [];
          for (const p0 of feat.parts) {
            let pieces = [p0];
            for (const { pl, exact } of planes) {
              const next = [];
              for (const p of pieces) {
                const bb = bbox(p);
                if (boxInside(bb, pl)) next.push(p);
                else if (!boxOutside(bb, pl)) next.push(...(exact ? clipLineExact(p, pl) : clipLine(p, pl)));
              }
              pieces = next;
            }
            for (const p of pieces) { const q = snap(p, s, false, opts.collinear); if (q.length >= 4) parts.push(q); }
          }
        } else {
          parts = [];
          let outerKept = false;
          for (const p0 of feat.parts) {
            const a0 = area2(p0);
            if (a0 === 0) continue;
            const isOuter = a0 > 0;
            if (!isOuter && !outerKept) continue;
            let r = p0;
            for (const { pl, exact } of planes) {
              if (r.length < 6) break;
              const bb = bbox(r);
              if (boxInside(bb, pl)) continue;
              if (boxOutside(bb, pl)) { r = []; break; }
              r = exact ? clipRingExact(r, pl) : clipRing(r, pl);
            }
            let q = r.length >= 6 ? snap(r, s, true, opts.collinear) : [];
            if (q.length >= 6) {
              const a1 = area2(q);
              if (a1 === 0 || Math.sign(a1) !== Math.sign(a0) || Math.abs(a1) < 2 * (opts.minRingArea ?? 0)) q = [];
            }
            if (q.length >= 6) { parts.push(q); if (isOuter) outerKept = true; }
            else if (isOuter) outerKept = false;
          }
        }
        if (!parts.length) continue;
        const labelled = !!sig && sig.some((l) => l.type === 'symbol');
        feats.push({ id: opts.dropIds ? undefined : feat.id, type: feat.type, props, parts, labelled });
      }

      let list = feats;
      if (opts.merge) {
        const groups = new Map();
        for (const ft of feats) {
          if (ft.type === 1 || (opts.merge.keepLabelled && ft.labelled)) { groups.set(Symbol(), ft); continue; }
          const key = ft.type + JSON.stringify(Object.entries(ft.props).sort());
          const g = groups.get(key);
          if (g) g.parts.push(...ft.parts);
          else groups.set(key, { ...ft, id: undefined, parts: ft.parts.slice() });
        }
        list = [...groups.values()];
        for (const g of list) if (g.type === 2 && g.parts.length > 1) g.parts = joinLines(g.parts);
        if (layer.name === 'transportation') {
          // Sort by class. With keepLabelled, labelled features keep their slots (their order
          // sets label priority); the others are sorted into the remaining slots.
          const rank = (ft) => CLASS_RANK.indexOf(ft.props.class) * 4 + (ft.props.tunnel ? 0 : ft.props.bridge ? 2 : 1);
          const movable = (ft) => !(opts.merge.keepLabelled && ft.labelled);
          const sorted = list.filter(movable).map((ft, i) => [ft, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((a) => a[0]);
          let k = 0;
          list = list.map((ft) => (movable(ft) ? sorted[k++] : ft));
        }
      }
      for (const ft of list) { ls.fout++; for (const p of ft.parts) ls.vout += p.length / 2; ft.parts = ft.parts.map((p) => Int32Array.from(p)); }
      if (list.length) layersOut.push(buildLayer(layer.name, newExtent || E, list));
    }
    const raw = encodeTile({ layers: layersOut });
    const g = gzipSync(raw, { level: 9 });
    st.outBytes += g.length;
    out.set(k, g);
  }
  const bytes = writeArchive(output, header, metadata, out);
  return { bytes, stats };
}

export function report(name, res, ref) {
  const zs = Object.keys(res.stats).sort((a, b) => a - b);
  const per = zs.map((z) => `${z}:${(res.stats[z].outBytes / 1e3).toFixed(1)}`).join(' ');
  return `${name.padEnd(28)} ${(res.bytes / 1e6).toFixed(3)} MB  Δ ${(((res.bytes - ref) / ref) * 100).toFixed(1).padStart(5)}%  [kB/level ${per}]`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [input, output, json] = process.argv.slice(2);
  if (!input || !output) { console.error('usage: node trim.mjs in.pmtiles out.pmtiles [options-json]'); process.exit(1); }
  const res = trimPmtiles(input, output, !json ? {} : json === 'recommended' ? RECOMMENDED : JSON.parse(json));
  for (const [z, s] of Object.entries(res.stats)) {
    console.log(`level ${z}: ${s.tiles} tiles ${(s.inBytes / 1e3).toFixed(1)} -> ${(s.outBytes / 1e3).toFixed(1)} kB`);
    for (const [n, l] of Object.entries(s.layers)) console.log(`   ${n.padEnd(15)} features ${l.fin} -> ${l.fout}  vertices ${l.vin} -> ${l.vout}  attrs dropped ${l.keysDropped}`);
  }
  console.log(`wrote ${output} ${(res.bytes / 1e6).toFixed(3)} MB`);
}
