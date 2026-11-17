// Mapbox Vector Tile (MVT 2.1) decoder and encoder, dependency-free.
//
// decodeTile(bytes) -> { layers: [{ name, version, extent, keys, values, features }] }
//   feature: { id, type, tags: [keyIndex, valueIndex, ...], parts: [Int32Array [x0, y0, x1, y1, ...]] }
//   type: 1 point, 2 line, 3 polygon. Coordinates are absolute tile units.
//   Polygon parts are rings without the repeated closing point (ClosePath is implied).
//   values are the raw protobuf Value messages (Buffers), so re-encoding is exact;
//   valueOf(buf) reads one.
// encodeTile(tile) -> Buffer, the inverse. decode -> encode of a Planetiler tile gives
// the same bytes (checked by scripts/tiles/own/calibrate.mjs).
//
// Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1

export function* fields(buf) {
  let i = 0;
  const varint = () => {
    let v = 0, s = 1, b;
    do { b = buf[i++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80);
    return v;
  };
  while (i < buf.length) {
    const key = varint(), f = Math.floor(key / 8), t = key & 7;
    if (t === 2) { const len = varint(); yield [f, buf.subarray(i, i + len), t]; i += len; }
    else if (t === 0) yield [f, varint(), t];
    else if (t === 5) { yield [f, buf.subarray(i, i + 4), t]; i += 4; }
    else if (t === 1) { yield [f, buf.subarray(i, i + 8), t]; i += 8; }
    else throw new Error('wire type ' + t);
  }
}

function packedVarints(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let v = 0, s = 1, b;
    do { b = buf[i++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80);
    out.push(v);
  }
  return out;
}

const unzig = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);
const zig = (n) => (n < 0 ? -2 * n - 1 : 2 * n);

export function decodeGeometry(cmds, type) {
  const parts = [];
  let x = 0, y = 0, cur = null, i = 0;
  while (i < cmds.length) {
    const c = cmds[i++], id = c & 7, count = c >>> 3;
    if (id === 1) {
      for (let k = 0; k < count; k++) {
        x += unzig(cmds[i++]); y += unzig(cmds[i++]);
        cur = [x, y];
        parts.push(cur);
      }
    } else if (id === 2) {
      for (let k = 0; k < count; k++) {
        x += unzig(cmds[i++]); y += unzig(cmds[i++]);
        cur.push(x, y);
      }
    } else if (id === 7) {
      // ring closes back to its first point; nothing to store
    } else throw new Error('command ' + id);
  }
  return parts.map((p) => Int32Array.from(p));
}

export function encodeGeometry(parts, type) {
  const out = [];
  let x = 0, y = 0;
  if (type === 1) {
    // MultiPoint: one MoveTo with every point.
    out.push((parts.length << 3) | 1);
    for (const p of parts) { out.push(zig(p[0] - x), zig(p[1] - y)); x = p[0]; y = p[1]; }
    return out;
  }
  for (const p of parts) {
    out.push((1 << 3) | 1, zig(p[0] - x), zig(p[1] - y));
    x = p[0]; y = p[1];
    const n = p.length / 2 - 1;
    if (n > 0) {
      out.push((n << 3) | 2);
      for (let k = 2; k < p.length; k += 2) { out.push(zig(p[k] - x), zig(p[k + 1] - y)); x = p[k]; y = p[k + 1]; }
    }
    if (type === 3) out.push((1 << 3) | 7);
  }
  return out;
}

export function decodeTile(buf) {
  const layers = [];
  for (const [f, layerBuf] of fields(buf)) {
    if (f !== 3) continue;
    const layer = { name: '', version: 1, extent: 4096, keys: [], values: [], features: [] };
    for (const [g, v] of fields(layerBuf)) {
      if (g === 1) layer.name = v.toString();
      else if (g === 15) layer.version = v;
      else if (g === 5) layer.extent = v;
      else if (g === 3) layer.keys.push(v.toString());
      else if (g === 4) layer.values.push(Buffer.from(v));
      else if (g === 2) {
        const feat = { id: undefined, type: 0, tags: [], parts: [] };
        let geom = null;
        for (const [h, w] of fields(v)) {
          if (h === 1) feat.id = w;
          else if (h === 2) feat.tags = packedVarints(w);
          else if (h === 3) feat.type = w;
          else if (h === 4) geom = packedVarints(w);
        }
        feat.parts = geom ? decodeGeometry(geom, feat.type) : [];
        layer.features.push(feat);
      }
    }
    layers.push(layer);
  }
  return { layers };
}

export function valueOf(buf) {
  for (const [f, v, t] of fields(buf)) {
    if (f === 1) return v.toString();
    if (f === 2) return v.readFloatLE(0);
    if (f === 3) return v.readDoubleLE(0);
    if (f === 4 || f === 5) return v;
    if (f === 6) return unzig(v);
    if (f === 7) return !!v;
  }
  return null;
}

export function encodeValue(v) {
  const w = new Writer();
  if (typeof v === 'string') w.bytes(1, Buffer.from(v));
  else if (typeof v === 'boolean') w.varintField(7, v ? 1 : 0);
  else if (Number.isInteger(v)) { if (v >= 0) w.varintField(5, v); else w.varintField(6, zig(v)); }
  else { const b = Buffer.alloc(8); b.writeDoubleLE(v); w.raw(3, 1, b); }
  return w.finish();
}

class Writer {
  constructor() { this.chunks = []; this.cur = []; }
  varint(v) {
    const c = this.cur;
    while (v >= 0x80) { c.push((v % 128) | 0x80); v = Math.floor(v / 128); }
    c.push(v);
  }
  flush() { if (this.cur.length) { this.chunks.push(Buffer.from(this.cur)); this.cur = []; } }
  varintField(f, v) { this.varint(f * 8); this.varint(v); }
  bytes(f, b) { this.varint(f * 8 + 2); this.varint(b.length); this.flush(); this.chunks.push(b); }
  raw(f, t, b) { this.varint(f * 8 + t); this.flush(); this.chunks.push(b); }
  packed(f, arr) {
    if (!arr.length) return;
    const inner = new Writer();
    for (const v of arr) inner.varint(v);
    this.bytes(f, inner.finish());
  }
  finish() { this.flush(); return Buffer.concat(this.chunks); }
}

export function encodeTile(tile) {
  const w = new Writer();
  for (const layer of tile.layers) {
    if (!layer.features.length) continue;
    const l = new Writer();
    l.bytes(1, Buffer.from(layer.name));
    for (const feat of layer.features) {
      const fw = new Writer();
      if (feat.id !== undefined) fw.varintField(1, feat.id);
      fw.packed(2, feat.tags);
      fw.varintField(3, feat.type);
      fw.packed(4, encodeGeometry(feat.parts, feat.type));
      l.bytes(2, fw.finish());
    }
    for (const k of layer.keys) l.bytes(3, Buffer.from(k));
    for (const v of layer.values) l.bytes(4, v);
    l.varintField(5, layer.extent);
    l.varintField(15, layer.version);
    w.bytes(3, l.finish());
  }
  return w.finish();
}

// Tags of a feature as a plain object.
export function tagsOf(layer, feat) {
  const o = {};
  for (let i = 0; i < feat.tags.length; i += 2) o[layer.keys[feat.tags[i]]] = valueOf(layer.values[feat.tags[i + 1]]);
  return o;
}

// Rebuilds a layer's key/value tables from features carrying plain-object `props`.
export function buildLayer(name, extent, features) {
  const keys = [], values = [], kIdx = new Map(), vIdx = new Map();
  const out = [];
  for (const f of features) {
    const tags = [];
    for (const [k, v] of Object.entries(f.props || {})) {
      if (v === undefined || v === null) continue;
      if (!kIdx.has(k)) { kIdx.set(k, keys.length); keys.push(k); }
      const vk = typeof v + ':' + v;
      if (!vIdx.has(vk)) { vIdx.set(vk, values.length); values.push(encodeValue(v)); }
      tags.push(kIdx.get(k), vIdx.get(vk));
    }
    out.push({ id: f.id, type: f.type, tags, parts: f.parts });
  }
  return { name, version: 2, extent, keys, values, features: out };
}
