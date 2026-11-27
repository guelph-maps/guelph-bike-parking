// Encoder for "GBT", our own tile payload: the same features as an MVT tile, laid
// out in columns (one stream per kind of number) so gzip can find patterns that
// MVT's interleaved varints hide. js/gbt.js turns a payload back into MVT bytes in
// the browser, so MapLibre sees ordinary vector tiles.
//
// Payload = 1 byte format version (0x47 'G' + version, now 0x48), then:
//   varint layerCount, then per layer the header
//     name, extent, version, keys[], values[] (raw MVT Value messages), featureCount, flags (1 = ids)
//   then the byte length of each of the 8 streams, then, for all layers in order, each stream in turn (so like numbers sit together):
//     ids (if flagged, delta-zigzag) | types | tag counts | tags | part counts | point counts | x deltas | y deltas
//   Coordinates are deltas from the previous point of the same layer (not reset per feature).
//   Polygon rings carry no closing point, as in MVT.
//
// The payload itself is not compressed: the PMTiles file gzips each tile (to-gbt.mjs),
// so the browser's pmtiles library unzips it on its well-tried path (with its own
// fallback where DecompressionStream is missing) before js/gbt.js sees it.
//
// encodeGbt(tile, { ids: false }) drops feature ids (the style uses none).

// Version 1: the body is no longer deflated inside the payload (version 0 was), so a
// version-0 file saved by an early test build passes through undecoded instead of
// being read as garbage.
export const MAGIC = 0x48;

class Bytes {
  constructor() { this.a = []; }
  v(n) { while (n >= 0x80) { this.a.push((n % 128) | 0x80); n = Math.floor(n / 128); } this.a.push(n); }
  z(n) { this.v(n < 0 ? -2 * n - 1 : 2 * n); }
  str(s) { const b = Buffer.from(s); this.v(b.length); for (const x of b) this.a.push(x); }
  buf(b) { this.v(b.length); for (const x of b) this.a.push(x); }
  out() { return Buffer.from(this.a); }
}

export function encodeGbt(tile, opts = {}) {
  const keepIds = opts.ids !== false;
  const layers = tile.layers.filter((l) => l.features.length);
  const head = new Bytes();
  head.v(layers.length);
  const S = ['ids', 'types', 'ntags', 'tags', 'nparts', 'npts', 'x', 'y'];
  const streams = Object.fromEntries(S.map((k) => [k, new Bytes()]));
  for (const l of layers) {
    const ids = keepIds && l.features.every((f) => f.id !== undefined);
    head.str(l.name); head.v(l.extent); head.v(l.version);
    head.v(l.keys.length); for (const k of l.keys) head.str(k);
    head.v(l.values.length); for (const v of l.values) head.buf(v);
    head.v(l.features.length); head.v(ids ? 1 : 0);
    let lastId = 0, px = 0, py = 0;
    for (const f of l.features) {
      if (ids) { streams.ids.z(f.id - lastId); lastId = f.id; }
      streams.types.v(f.type);
      streams.ntags.v(f.tags.length / 2);
      for (const t of f.tags) streams.tags.v(t);
      streams.nparts.v(f.parts.length);
      for (const p of f.parts) {
        streams.npts.v(p.length / 2);
        for (let i = 0; i < p.length; i += 2) {
          streams.x.z(p[i] - px); streams.y.z(p[i + 1] - py);
          px = p[i]; py = p[i + 1];
        }
      }
    }
  }
  const outs = S.map((k) => streams[k].out());
  for (const o of outs) head.v(o.length);
  return Buffer.concat([Buffer.from([MAGIC]), head.out(), ...outs]);
}
