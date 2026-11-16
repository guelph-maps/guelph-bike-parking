// Turns our own compact tile payload ("GBT", written by scripts/tiles/own/gbt.mjs)
// back into Mapbox Vector Tile bytes, so MapLibre draws it as usual.
// GBT.toMvt(inflatedBody) -> Uint8Array. GBT.inflate(payload) -> Promise of the body.
(function (root) {
  'use strict';

  var MAGIC = 0x47;

  function Reader(buf, pos) { this.b = buf; this.p = pos || 0; }
  Reader.prototype.v = function () {
    var b = this.b, v = 0, s = 1, c;
    do { c = b[this.p++]; v += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
    return v;
  };
  Reader.prototype.z = function () { var n = this.v(); return n % 2 ? -(n + 1) / 2 : n / 2; };
  Reader.prototype.bytes = function () { var n = this.v(); var out = this.b.subarray(this.p, this.p + n); this.p += n; return out; };

  // Growable protobuf writer.
  function Writer(size) { this.b = new Uint8Array(size || 1024); this.p = 0; }
  Writer.prototype.room = function (n) {
    if (this.p + n <= this.b.length) return;
    var nb = new Uint8Array(Math.max(this.b.length * 2, this.p + n));
    nb.set(this.b.subarray(0, this.p));
    this.b = nb;
  };
  Writer.prototype.v = function (n) {
    this.room(10);
    var b = this.b;
    while (n >= 0x80) { b[this.p++] = (n % 128) | 0x80; n = Math.floor(n / 128); }
    b[this.p++] = n;
  };
  Writer.prototype.raw = function (src) { this.room(src.length); this.b.set(src, this.p); this.p += src.length; };
  Writer.prototype.out = function () { return this.b.subarray(0, this.p); };
  Writer.prototype.copy = function () { return this.b.slice(0, this.p); };

  function varintLen(n) { var l = 1; while (n >= 0x80) { n = Math.floor(n / 128); l++; } return l; }
  var zig = function (n) { return n < 0 ? -2 * n - 1 : 2 * n; };

  var td = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

  function toMvt(body) {
    var r = new Reader(body, 0);
    var nLayers = r.v(), layers = [];
    for (var i = 0; i < nLayers; i++) {
      var L = { name: r.bytes(), extent: r.v(), version: r.v(), keys: [], values: [] };
      var nk = r.v(); for (var k = 0; k < nk; k++) L.keys.push(r.bytes());
      var nv = r.v(); for (k = 0; k < nv; k++) L.values.push(r.bytes());
      L.n = r.v(); L.ids = r.v() & 1;
      layers.push(L);
    }
    var lens = []; for (i = 0; i < 8; i++) lens.push(r.v());
    var S = [], pos = r.p;
    for (i = 0; i < 8; i++) { S.push(new Reader(body, pos)); pos += lens[i]; }
    var ids = S[0], types = S[1], ntags = S[2], tags = S[3], nparts = S[4], npts = S[5], xs = S[6], ys = S[7];

    var out = new Writer(body.length * 2 + 1024);
    var feat = new Writer(256), geom = new Writer(1024), tagw = new Writer(64);
    for (i = 0; i < layers.length; i++) {
      L = layers[i];
      var layer = new Writer(body.length + 256);
      layer.v(10); layer.v(L.name.length); layer.raw(L.name);
      var lastId = 0, px = 0, py = 0;
      for (var f = 0; f < L.n; f++) {
        var id = 0;
        if (L.ids) { lastId += ids.z(); id = lastId; }
        var type = types.v();
        tagw.p = 0;
        var nt = ntags.v() * 2;
        for (k = 0; k < nt; k++) tagw.v(tags.v());
        // Geometry commands, cursor reset per feature as MVT requires.
        geom.p = 0;
        var cx = 0, cy = 0, np = nparts.v();
        if (type === 1) {
          // points: one MoveTo with every point of every part
          var pts = [];
          for (var p = 0; p < np; p++) {
            var n = npts.v();
            for (var q = 0; q < n; q++) { px += xs.z(); py += ys.z(); pts.push(px, py); }
          }
          geom.v(((pts.length / 2) << 3) | 1);
          for (q = 0; q < pts.length; q += 2) { geom.v(zig(pts[q] - cx)); geom.v(zig(pts[q + 1] - cy)); cx = pts[q]; cy = pts[q + 1]; }
        } else {
          for (p = 0; p < np; p++) {
            n = npts.v();
            px += xs.z(); py += ys.z();
            geom.v(9); geom.v(zig(px - cx)); geom.v(zig(py - cy)); cx = px; cy = py;
            if (n > 1) {
              geom.v(((n - 1) << 3) | 2);
              for (q = 1; q < n; q++) {
                px += xs.z(); py += ys.z();
                geom.v(zig(px - cx)); geom.v(zig(py - cy)); cx = px; cy = py;
              }
            }
            if (type === 3) geom.v(15);
          }
        }
        // Feature message: id, tags, type, geometry (field order as Planetiler writes it)
        feat.p = 0;
        if (L.ids) { feat.v(8); feat.v(id); }
        if (tagw.p) { feat.v(18); feat.v(tagw.p); feat.raw(tagw.out()); }
        feat.v(24); feat.v(type);
        if (geom.p) { feat.v(34); feat.v(geom.p); feat.raw(geom.out()); }
        layer.v(18); layer.v(feat.p); layer.raw(feat.out());
      }
      for (k = 0; k < L.keys.length; k++) { layer.v(26); layer.v(L.keys[k].length); layer.raw(L.keys[k]); }
      for (k = 0; k < L.values.length; k++) { layer.v(34); layer.v(L.values[k].length); layer.raw(L.values[k]); }
      layer.v(40); layer.v(L.extent);
      layer.v(120); layer.v(L.version);
      out.v(26); out.v(layer.p); out.raw(layer.out());
    }
    return out.copy(); // its own ArrayBuffer, so MapLibre can hand it to a worker as it is
  }

  async function inflate(payload) {
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([payload.subarray(1)]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function isGbt(data) { return data && data.length > 0 && data[0] === MAGIC; }

  root.GBT = { toMvt: toMvt, inflate: inflate, isGbt: isGbt, varintLen: varintLen };
})(typeof self !== 'undefined' ? self : globalThis);
