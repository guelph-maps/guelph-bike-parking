// Loads js/style.js in Node and evaluates the subset of MapLibre expressions it uses,
// so trim.mjs can ask "which style layers draw this feature at the zooms this tile
// level serves, how wide, and which attributes do they read?".
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadStyle(stylePath) {
  const win = {};
  const ctx = { window: win, location: { href: 'http://localhost/' }, URL };
  vm.runInNewContext(readFileSync(stylePath, 'utf8'), ctx);
  return JSON.parse(JSON.stringify(win.bikeStyle('pmtiles://x')));
}

const OPS = new Set(['get', 'has', '!', 'all', 'any', 'in', 'literal', '==', '!=', '>=', '<=', '<', '>',
  'match', 'interpolate', 'zoom', '*', '+', '-', '/', 'coalesce', 'case', 'step', 'to-string', 'concat', 'geometry-type']);

export const isExpr = (v) => Array.isArray(v) && typeof v[0] === 'string' && OPS.has(v[0]);

function cmp(op, a, b) {
  if (a === null || b === null || a === undefined || b === undefined || typeof a !== typeof b) return false;
  return op === '>=' ? a >= b : op === '<=' ? a <= b : op === '<' ? a < b : a > b;
}

// ctx: { props, zoom, gtype }
export function evaluate(e, ctx) {
  if (!isExpr(e)) return e;
  const [op, ...a] = e;
  const ev = (x) => evaluate(x, ctx);
  switch (op) {
    case 'literal': return a[0];
    case 'get': { const v = ctx.props[a[0]]; return v === undefined ? null : v; }
    case 'has': return a[0] in ctx.props;
    case '!': return !ev(a[0]);
    case 'all': return a.every((x) => ev(x));
    case 'any': return a.some((x) => ev(x));
    case 'in': { const n = ev(a[0]), h = ev(a[1]); return Array.isArray(h) ? h.includes(n) : typeof h === 'string' ? h.includes(n) : false; }
    case '==': return ev(a[0]) === ev(a[1]);
    case '!=': return ev(a[0]) !== ev(a[1]);
    case '>=': case '<=': case '<': case '>': return cmp(op, ev(a[0]), ev(a[1]));
    case 'zoom': return ctx.zoom;
    case 'geometry-type': return ['', 'Point', 'LineString', 'Polygon'][ctx.gtype];
    case '*': return a.reduce((p, x) => p * ev(x), 1);
    case '+': return a.reduce((p, x) => p + ev(x), 0);
    case '-': return a.length === 1 ? -ev(a[0]) : ev(a[0]) - ev(a[1]);
    case '/': return ev(a[0]) / ev(a[1]);
    case 'coalesce': { for (const x of a) { const v = ev(x); if (v !== null && v !== undefined) return v; } return null; }
    case 'to-string': { const v = ev(a[0]); return v === null ? '' : String(v); }
    case 'concat': return a.map((x) => { const v = ev(x); return v === null ? '' : String(v); }).join('');
    case 'case': {
      for (let i = 0; i + 1 < a.length; i += 2) if (ev(a[i])) return ev(a[i + 1]);
      return ev(a[a.length - 1]);
    }
    case 'match': {
      const v = ev(a[0]);
      for (let i = 1; i + 1 < a.length; i += 2) {
        const lab = a[i];
        if (Array.isArray(lab) ? lab.includes(v) : lab === v) return ev(a[i + 1]);
      }
      return ev(a[a.length - 1]);
    }
    case 'step': {
      const x = ev(a[0]);
      let out = ev(a[1]);
      for (let i = 2; i + 1 < a.length; i += 2) if (x >= a[i]) out = ev(a[i + 1]);
      return out;
    }
    case 'interpolate': {
      const [kind, input, ...stops] = a;
      const x = ev(input);
      const base = kind[0] === 'exponential' ? kind[1] : 1;
      if (x <= stops[0]) return ev(stops[1]);
      for (let i = 0; i + 2 < stops.length; i += 2) {
        const z0 = stops[i], z1 = stops[i + 2];
        if (x <= z1) {
          const d = z1 - z0, p = x - z0;
          const t = base === 1 ? p / d : (Math.pow(base, p) - 1) / (Math.pow(base, d) - 1);
          const v0 = ev(stops[i + 1]), v1 = ev(stops[i + 3]);
          return v0 + (v1 - v0) * t;
        }
      }
      return ev(stops[stops.length - 1]);
    }
  }
  throw new Error('unsupported expression ' + op);
}

// Attribute names an expression reads.
export function reads(e, out = new Set()) {
  if (!Array.isArray(e)) return out;
  if (isExpr(e) && (e[0] === 'get' || e[0] === 'has') && typeof e[1] === 'string') out.add(e[1]);
  if (isExpr(e) && e[0] === 'literal') return out;
  for (const x of e) reads(x, out);
  return out;
}

// Style layers that use `sourceLayer` and are drawn somewhere in GL zooms [zmin, zmax).
export function activeLayers(style, sourceLayer, zmin, zmax) {
  return style.layers.filter((l) => l['source-layer'] === sourceLayer
    && (l.minzoom ?? 0) < zmax && (l.maxzoom ?? 24) > zmin
    && (l.layout?.visibility ?? 'visible') !== 'none');
}

const GEOM_OK = { fill: [3], line: [2, 3], circle: [1], symbol: [1, 2, 3], 'fill-extrusion': [3], heatmap: [1] };

// What the active layers do with one feature, sampled at `zooms`: a list of
// { layer, ... evaluated props } for the layers that draw it. Two property sets
// that give the same signature look the same.
export function drawSignature(layers, props, gtype, zooms) {
  const sig = [];
  for (const l of layers) {
    if (!GEOM_OK[l.type]?.includes(gtype)) continue;
    const zs = zooms.filter((z) => z >= (l.minzoom ?? 0) && z < (l.maxzoom ?? 24));
    if (!zs.length) continue;
    const ctx = { props, zoom: zs[0], gtype };
    if (l.filter && !evaluate(l.filter, ctx)) continue;
    if (l.type === 'symbol' && l.layout?.['text-field'] !== undefined) {
      const t = evaluate(l.layout['text-field'], ctx);
      if (t === null || t === '') continue;
    }
    const vals = {};
    for (const group of ['paint', 'layout']) {
      for (const [k, v] of Object.entries(l[group] || {})) {
        if (!isExpr(v)) { if (k === 'line-width') vals[k] = zs.map(() => v); continue; }
        vals[k] = zs.map((z) => evaluate(v, { props, zoom: z, gtype }));
      }
    }
    sig.push({ id: l.id, type: l.type, layout: l.layout || {}, dashed: !!l.paint?.['line-dasharray'], vals, zs });
  }
  return sig;
}
