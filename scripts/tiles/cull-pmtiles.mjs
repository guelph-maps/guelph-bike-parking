// Keeps, at each zoom level, only the tiles within that level's margin of an area,
// and writes the result as a new PMTiles (v3) file. Planetiler's --bounds and
// --polygon cover every zoom level with one area; this lets the coarse levels
// reach further than the detailed ones. Tile bytes are copied untouched.
//
// Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

const HEADER = 127;
const ROOT_MAX = 16384 - HEADER; // clients read the first 16 KiB in one request

// ---- PMTiles reading -------------------------------------------------------

function readHeader(buf) {
  if (buf.toString('latin1', 0, 7) !== 'PMTiles' || buf[7] !== 3) throw new Error('not a PMTiles v3 file');
  const u64 = (o) => Number(buf.readBigUInt64LE(o));
  return {
    rootOffset: u64(8), rootLength: u64(16), metadataOffset: u64(24), metadataLength: u64(32),
    leafOffset: u64(40), leafLength: u64(48), dataOffset: u64(56), dataLength: u64(64),
    internalCompression: buf[97], tileCompression: buf[98], tileType: buf[99],
    minZoom: buf[100], maxZoom: buf[101],
    rest: buf.subarray(102, HEADER), // bounds and centre, copied as they are
  };
}

function decompress(buf, compression) {
  if (compression === 1) return buf;
  if (compression === 2) return gunzipSync(buf);
  throw new Error(`unsupported internal compression ${compression}`);
}

function compress(buf, compression) {
  return compression === 1 ? buf : gzipSync(buf, { level: 9 });
}

function readVarint(buf, pos) {
  let value = 0, shift = 1, b;
  do {
    b = buf[pos.i++];
    value += (b & 0x7f) * shift;
    shift *= 128;
  } while (b & 0x80);
  return value;
}

function parseDirectory(buf) {
  const pos = { i: 0 };
  const n = readVarint(buf, pos);
  const entries = Array.from({ length: n }, () => ({}));
  let id = 0;
  for (const e of entries) { id += readVarint(buf, pos); e.tileId = id; }
  for (const e of entries) e.runLength = readVarint(buf, pos);
  for (const e of entries) e.length = readVarint(buf, pos);
  entries.forEach((e, i) => {
    const v = readVarint(buf, pos);
    e.offset = v === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : v - 1;
  });
  return entries;
}

// Every addressed tile as { tileId, offset, length }, offsets relative to tile data.
function readTiles(buf, h) {
  const tiles = [];
  const walk = (offset, length) => {
    for (const e of parseDirectory(decompress(buf.subarray(offset, offset + length), h.internalCompression))) {
      if (e.runLength === 0) walk(h.leafOffset + e.offset, e.length);
      else for (let k = 0; k < e.runLength; k++) tiles.push({ tileId: e.tileId + k, offset: e.offset, length: e.length });
    }
  };
  walk(h.rootOffset, h.rootLength);
  return tiles.sort((a, b) => a.tileId - b.tileId);
}

// ---- Tile ids (Hilbert order within each zoom) ------------------------------

function rotate(n, xy, rx, ry) {
  if (ry === 0) {
    if (rx === 1) { xy[0] = n - 1 - xy[0]; xy[1] = n - 1 - xy[1]; }
    [xy[0], xy[1]] = [xy[1], xy[0]];
  }
}

export function tileIdToZxy(id) {
  let acc = 0;
  for (let z = 0; z < 27; z++) {
    const count = 4 ** z;
    if (acc + count > id) {
      let t = id - acc;
      const xy = [0, 0];
      for (let s = 1; s < 2 ** z; s *= 2) {
        const rx = 1 & Math.floor(t / 2), ry = 1 & (t ^ rx);
        rotate(s, xy, rx, ry);
        xy[0] += s * rx; xy[1] += s * ry;
        t = Math.floor(t / 4);
      }
      return [z, xy[0], xy[1]];
    }
    acc += count;
  }
  throw new Error(`tile id ${id} out of range`);
}

export function zxyToTileId(z, x, y) {
  let d = 0;
  const xy = [x, y];
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = (xy[0] & s) > 0 ? 1 : 0, ry = (xy[1] & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    rotate(s, xy, rx, ry);
  }
  return (4 ** z - 1) / 3 + d;
}

// ---- PMTiles writing -------------------------------------------------------

function writeVarint(out, value) {
  while (value >= 0x80) { out.push((value % 128) | 0x80); value = Math.floor(value / 128); }
  out.push(value);
}

function serializeDirectory(entries, compression) {
  const out = [];
  writeVarint(out, entries.length);
  let last = 0;
  for (const e of entries) { writeVarint(out, e.tileId - last); last = e.tileId; }
  for (const e of entries) writeVarint(out, e.runLength);
  for (const e of entries) writeVarint(out, e.length);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    writeVarint(out, i > 0 && e.offset === prev.offset + prev.length ? 0 : e.offset + 1);
  });
  return compress(Buffer.from(out), compression);
}

// Root directory, plus leaf directories once the root no longer fits in 16 KiB.
function buildDirectories(entries, compression) {
  let root = serializeDirectory(entries, compression);
  if (root.length <= ROOT_MAX) return { root, leaves: Buffer.alloc(0) };
  for (let size = 4096; ; size *= 2) {
    const leafBufs = [], rootEntries = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += size) {
      const leaf = serializeDirectory(entries.slice(i, i + size), compression);
      rootEntries.push({ tileId: entries[i].tileId, runLength: 0, offset, length: leaf.length });
      leafBufs.push(leaf);
      offset += leaf.length;
    }
    root = serializeDirectory(rootEntries, compression);
    if (root.length <= ROOT_MAX) return { root, leaves: Buffer.concat(leafBufs) };
  }
}

function writeHeader(h, f) {
  const buf = Buffer.alloc(HEADER);
  buf.write('PMTiles', 0, 'latin1');
  buf[7] = 3;
  [f.rootOffset, f.rootLength, f.metadataOffset, f.metadataLength, f.leafOffset, f.leafLength,
    f.dataOffset, f.dataLength, f.addressed, f.entries, f.contents]
    .forEach((v, i) => buf.writeBigUInt64LE(BigInt(v), 8 + i * 8));
  buf[96] = 1; // clustered
  buf[97] = h.internalCompression;
  buf[98] = h.tileCompression;
  buf[99] = h.tileType;
  buf[100] = f.minZoom;
  buf[101] = f.maxZoom;
  h.rest.copy(buf, 102);
  return buf;
}

// ---- Which tiles to keep ---------------------------------------------------

// Rings of a GeoJSON Polygon / MultiPolygon / Feature / FeatureCollection, outer rings only.
export function outerRings(gj) {
  const geoms = gj.type === 'FeatureCollection' ? gj.features.map((f) => f.geometry)
    : [gj.type === 'Feature' ? gj.geometry : gj];
  return geoms.filter(Boolean).flatMap((g) => g.type === 'Polygon' ? [g.coordinates[0]]
    : g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : []);
}

function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lat = (t) => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) * 180 / Math.PI;
  return { west: x / n * 360 - 180, east: (x + 1) / n * 360 - 180, north: lat(y), south: lat(y + 1) };
}

function pointSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function segmentHitsRect(a, b, r) {
  // Liang-Barsky clip of segment a-b against the rectangle.
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - r.x0], [dx, r.x1 - a[0]], [-dy, a[1] - r.y0], [dy, r.y1 - a[1]]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

function insideRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Distance in metres from a tile to the area (0 when they overlap), on a flat
// projection around the area's middle latitude; fine at city scale.
function makeDistance(rings) {
  const pts = rings.flat();
  const lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const mx = 111320 * Math.cos(lat0 * Math.PI / 180), my = 110540;
  const toM = ([x, y]) => [x * mx, y * my];
  const mRings = rings.map((r) => r.map(toM));
  return (z, x, y) => {
    const b = tileBounds(z, x, y);
    const r = { x0: b.west * mx, x1: b.east * mx, y0: b.south * my, y1: b.north * my };
    const corners = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
    if (mRings.some((ring) => insideRing(corners[0], ring))) return 0;
    let best = Infinity;
    for (const ring of mRings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i], c = ring[i + 1];
        if (segmentHitsRect(a, c, r)) return 0;
        best = Math.min(best, ...corners.map((p) => pointSegment(p, a, c)),
          ...[a, c].map((p) => Math.hypot(Math.max(r.x0 - p[0], 0, p[0] - r.x1), Math.max(r.y0 - p[1], 0, p[1] - r.y1))));
      }
    }
    return best;
  };
}

// ---- The whole step ----------------------------------------------------------

// marginByZoom: { [zoom]: metres }. Tiles at zooms not listed are dropped.
// Returns per-zoom tile counts and byte sizes of what was kept.
export function cullPmtiles(input, output, areaGeojson, marginByZoom) {
  const buf = readFileSync(input);
  const h = readHeader(buf);
  const rings = outerRings(areaGeojson);
  if (!rings.length) throw new Error('area has no polygon');
  const distance = makeDistance(rings);

  const kept = readTiles(buf, h).filter((t) => {
    const [z, x, y] = tileIdToZxy(t.tileId);
    t.z = z;
    return z in marginByZoom && distance(z, x, y) <= marginByZoom[z];
  });
  if (!kept.length) throw new Error('no tiles left');

  // Tile data in tile-id order, each distinct tile stored once.
  const newOffset = new Map(), parts = [];
  let dataLength = 0;
  for (const t of kept) {
    if (!newOffset.has(t.offset)) {
      newOffset.set(t.offset, dataLength);
      parts.push(buf.subarray(h.dataOffset + t.offset, h.dataOffset + t.offset + t.length));
      dataLength += t.length;
    }
  }
  const entries = [];
  for (const t of kept) {
    const offset = newOffset.get(t.offset), last = entries[entries.length - 1];
    if (last && last.offset === offset && last.tileId + last.runLength === t.tileId) last.runLength++;
    else entries.push({ tileId: t.tileId, runLength: 1, offset, length: t.length });
  }

  const { root, leaves } = buildDirectories(entries, h.internalCompression);
  const metadata = buf.subarray(h.metadataOffset, h.metadataOffset + h.metadataLength);
  const f = {
    rootOffset: HEADER, rootLength: root.length,
    metadataOffset: HEADER + root.length, metadataLength: metadata.length,
    leafOffset: HEADER + root.length + metadata.length, leafLength: leaves.length,
    dataOffset: HEADER + root.length + metadata.length + leaves.length, dataLength,
    addressed: kept.length, entries: entries.length, contents: newOffset.size,
    minZoom: Math.min(...kept.map((t) => t.z)), maxZoom: Math.max(...kept.map((t) => t.z)),
  };
  writeFileSync(output, Buffer.concat([writeHeader(h, f), root, metadata, leaves, ...parts]));

  const stats = {};
  for (const t of kept) {
    const s = (stats[t.z] ||= { tiles: 0, bytes: 0 });
    s.tiles++;
    s.bytes += t.length;
  }
  return stats;
}

// Every tile in a PMTiles file as a Map of "z/x/y" to its (still compressed) bytes.
export function listTiles(file) {
  const buf = readFileSync(file);
  const h = readHeader(buf);
  const out = new Map();
  for (const t of readTiles(buf, h)) {
    out.set(tileIdToZxy(t.tileId).join('/'), buf.subarray(h.dataOffset + t.offset, h.dataOffset + t.offset + t.length));
  }
  return { header: h, tiles: out };
}
