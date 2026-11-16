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

  // ---- Features in memory, for cutting a stored tile into smaller ones -------

  // GBT body -> layers of features with absolute coordinates.
  function decode(body) {
    var r = new Reader(body, 0);
    var nLayers = r.v(), layers = [];
    for (var i = 0; i < nLayers; i++) {
      var L = { name: r.bytes(), extent: r.v(), version: r.v(), keys: [], values: [], features: [] };
      var nk = r.v(); for (var k = 0; k < nk; k++) L.keys.push(r.bytes());
      var nv = r.v(); for (k = 0; k < nv; k++) L.values.push(r.bytes());
      L.n = r.v(); L.ids = r.v() & 1;
      layers.push(L);
    }
    var lens = []; for (i = 0; i < 8; i++) lens.push(r.v());
    var S = [], pos = r.p;
    for (i = 0; i < 8; i++) { S.push(new Reader(body, pos)); pos += lens[i]; }
    for (i = 0; i < layers.length; i++) {
      L = layers[i];
      var lastId = 0, px = 0, py = 0;
      for (var f = 0; f < L.n; f++) {
        var feat = { id: 0, type: 0, tags: null, parts: [] };
        if (L.ids) { lastId += S[0].z(); feat.id = lastId; }
        feat.type = S[1].v();
        var nt = S[2].v() * 2, tags = new Array(nt);
        for (k = 0; k < nt; k++) tags[k] = S[3].v();
        feat.tags = tags;
        var np = S[4].v();
        for (var p = 0; p < np; p++) {
          var n = S[5].v(), a = new Int32Array(n * 2);
          for (var q = 0; q < n * 2; q += 2) { px += S[6].z(); py += S[7].z(); a[q] = px; a[q + 1] = py; }
          feat.parts.push(a);
        }
        L.features.push(feat);
      }
    }
    return layers;
  }

  // Layers of features -> MVT bytes.
  function encode(layers) {
    var out = new Writer(65536), layer = new Writer(65536), feat = new Writer(256), geom = new Writer(1024), tagw = new Writer(64);
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      if (!L.features.length) continue;
      layer.p = 0;
      layer.v(10); layer.v(L.name.length); layer.raw(L.name);
      for (var f = 0; f < L.features.length; f++) {
        var F = L.features[f], type = F.type, parts = F.parts, k, q;
        geom.p = 0;
        var cx = 0, cy = 0;
        if (type === 1) {
          var n = 0; for (k = 0; k < parts.length; k++) n += parts[k].length / 2;
          geom.v((n << 3) | 1);
          for (k = 0; k < parts.length; k++) for (q = 0; q < parts[k].length; q += 2) {
            geom.v(zig(parts[k][q] - cx)); geom.v(zig(parts[k][q + 1] - cy)); cx = parts[k][q]; cy = parts[k][q + 1];
          }
        } else {
          for (k = 0; k < parts.length; k++) {
            var a = parts[k], m = a.length / 2;
            geom.v(9); geom.v(zig(a[0] - cx)); geom.v(zig(a[1] - cy)); cx = a[0]; cy = a[1];
            if (m > 1) {
              geom.v(((m - 1) << 3) | 2);
              for (q = 2; q < a.length; q += 2) { geom.v(zig(a[q] - cx)); geom.v(zig(a[q + 1] - cy)); cx = a[q]; cy = a[q + 1]; }
            }
            if (type === 3) geom.v(15);
          }
        }
        if (!geom.p) continue;
        tagw.p = 0;
        for (k = 0; k < F.tags.length; k++) tagw.v(F.tags[k]);
        feat.p = 0;
        if (L.ids) { feat.v(8); feat.v(F.id); }
        if (tagw.p) { feat.v(18); feat.v(tagw.p); feat.raw(tagw.out()); }
        feat.v(24); feat.v(type);
        feat.v(34); feat.v(geom.p); feat.raw(geom.out());
        layer.v(18); layer.v(feat.p); layer.raw(feat.out());
      }
      for (k = 0; k < L.keys.length; k++) { layer.v(26); layer.v(L.keys[k].length); layer.raw(L.keys[k]); }
      for (k = 0; k < L.values.length; k++) { layer.v(34); layer.v(L.values[k].length); layer.raw(L.values[k]); }
      layer.v(40); layer.v(L.extent);
      layer.v(120); layer.v(L.version);
      out.v(26); out.v(layer.p); out.raw(layer.out());
    }
    return out.copy();
  }

  // Polyline clipped to a box: zero or more pieces (Liang-Barsky per segment).
  function clipLine(a, x0, y0, x1, y1, out) {
    var cur = null;
    for (var i = 0; i + 3 < a.length; i += 2) {
      var ax = a[i], ay = a[i + 1], bx = a[i + 2], by = a[i + 3];
      var t0 = 0, t1 = 1, dx = bx - ax, dy = by - ay, ok = true;
      var P = [-dx, dx, -dy, dy], Q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
      for (var k = 0; k < 4 && ok; k++) {
        if (P[k] === 0) { if (Q[k] < 0) ok = false; }
        else {
          var t = Q[k] / P[k];
          if (P[k] < 0) { if (t > t1) ok = false; else if (t > t0) t0 = t; }
          else { if (t < t0) ok = false; else if (t < t1) t1 = t; }
        }
      }
      if (!ok) { if (cur) { out.push(cur); cur = null; } continue; }
      var sx = ax + t0 * dx, sy = ay + t0 * dy, ex = ax + t1 * dx, ey = ay + t1 * dy;
      if (!cur) cur = [sx, sy];
      cur.push(ex, ey);
      if (t1 < 1) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  // Ring clipped to a box (Sutherland-Hodgman); null once fewer than 3 points remain.
  function clipRing(a, x0, y0, x1, y1) {
    var pts = Array.prototype.slice.call(a);
    for (var e = 0; e < 4; e++) {
      var n = pts.length / 2;
      if (n < 3) return null;
      var out = [];
      var inside = function (x, y) { return e === 0 ? x >= x0 : e === 1 ? x <= x1 : e === 2 ? y >= y0 : y <= y1; };
      var cross = function (ax, ay, bx, by) {
        var t = e === 0 ? (x0 - ax) / (bx - ax) : e === 1 ? (x1 - ax) / (bx - ax) : e === 2 ? (y0 - ay) / (by - ay) : (y1 - ay) / (by - ay);
        out.push(ax + t * (bx - ax), ay + t * (by - ay));
      };
      var all = true;
      for (var i = 0; i < n && all; i++) if (!inside(pts[2 * i], pts[2 * i + 1])) all = false;
      if (all) continue;
      for (i = 0; i < n; i++) {
        var j = (i + 1) % n, ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
        var ain = inside(ax, ay), bin = inside(bx, by);
        if (ain) { out.push(ax, ay); if (!bin) cross(ax, ay, bx, by); }
        else if (bin) cross(ax, ay, bx, by);
      }
      pts = out;
    }
    return pts.length >= 6 ? pts : null;
  }

  // Cut a stored tile's layers down to one of its descendants, `dz` levels deeper,
  // `qx`/`qy` its position inside the stored tile (0 .. 2^dz - 1). Coordinates are
  // scaled up by 2^dz, so nothing is rounded except new points on the cut edges.
  function slice(layers, dz, qx, qy, buffer) {
    var s = 1 << dz, out = [];
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i], E = L.extent, size = E / s, b = buffer / s;
      var x0 = qx * size - b, y0 = qy * size - b, x1 = (qx + 1) * size + b, y1 = (qy + 1) * size + b;
      var ox = qx * size, oy = qy * size;
      var feats = [];
      for (var f = 0; f < L.features.length; f++) {
        var F = L.features[f], parts = [], k, q, a;
        // quick reject on the bounding box
        var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (k = 0; k < F.parts.length; k++) { a = F.parts[k]; for (q = 0; q < a.length; q += 2) { if (a[q] < minx) minx = a[q]; if (a[q] > maxx) maxx = a[q]; if (a[q + 1] < miny) miny = a[q + 1]; if (a[q + 1] > maxy) maxy = a[q + 1]; } }
        if (maxx < x0 || minx > x1 || maxy < y0 || miny > y1) continue;
        var whole = minx >= x0 && maxx <= x1 && miny >= y0 && maxy <= y1;
        var pieces = [];
        if (whole) pieces = F.parts;
        else if (F.type === 1) {
          for (k = 0; k < F.parts.length; k++) { a = F.parts[k]; if (a[0] >= x0 && a[0] <= x1 && a[1] >= y0 && a[1] <= y1) pieces.push(a); }
        } else if (F.type === 2) {
          for (k = 0; k < F.parts.length; k++) clipLine(F.parts[k], x0, y0, x1, y1, pieces);
        } else {
          // keep holes with their outer ring: a dropped outer ring drops its holes
          var keepHoles = false;
          for (k = 0; k < F.parts.length; k++) {
            a = F.parts[k];
            var area = 0, m = a.length / 2;
            for (q = 0; q < m; q++) { var r2 = (q + 1) % m; area += a[2 * q] * a[2 * r2 + 1] - a[2 * r2] * a[2 * q + 1]; }
            if (area > 0) { var c = clipRing(a, x0, y0, x1, y1); keepHoles = !!c; if (c) pieces.push(c); }
            else if (keepHoles) { c = clipRing(a, x0, y0, x1, y1); if (c) pieces.push(c); }
          }
        }
        for (k = 0; k < pieces.length; k++) {
          a = pieces[k];
          var o = [], lx = NaN, ly = NaN;
          for (q = 0; q < a.length; q += 2) {
            var X = Math.round((a[q] - ox) * s), Y = Math.round((a[q + 1] - oy) * s);
            if (X === lx && Y === ly) continue;
            o.push(X, Y); lx = X; ly = Y;
          }
          if (F.type === 3 && o.length > 2 && o[0] === o[o.length - 2] && o[1] === o[o.length - 1]) o.length -= 2;
          if (F.type === 1 ? o.length >= 2 : F.type === 2 ? o.length >= 4 : o.length >= 6) parts.push(o);
        }
        if (parts.length) feats.push({ id: F.id, type: F.type, tags: F.tags, parts: parts });
      }
      out.push({ name: L.name, extent: E, version: L.version, keys: L.keys, values: L.values, ids: L.ids, features: feats });
    }
    return out;
  }

  // Features tagged _minzoom (stored at the top level for closer views only) are
  // dropped below that zoom, and the tag itself never reaches MapLibre.
  var MINZOOM = '_minzoom';
  function intValue(v) {
    var r = new Reader(v, 1), n = r.v();
    return v[0] === 0x30 ? (n % 2 ? -(n + 1) / 2 : n / 2) : n; // sint64 is zigzag; int64/uint64 plain
  }
  function keyIndex(L, name) {
    outer: for (var k = 0; k < L.keys.length; k++) {
      var b = L.keys[k];
      if (b.length !== name.length) continue;
      for (var i = 0; i < b.length; i++) if (b[i] !== name.charCodeAt(i)) continue outer;
      return k;
    }
    return -1;
  }
  function applyMinzoom(layers, z) {
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i], ki = keyIndex(L, MINZOOM);
      if (ki < 0) continue;
      L.features = L.features.filter(function (F) {
        for (var t = 0; t < F.tags.length; t += 2) {
          if (F.tags[t] !== ki) continue;
          if (intValue(L.values[F.tags[t + 1]]) > z) return false;
          F.tags = F.tags.slice(0, t).concat(F.tags.slice(t + 2));
          break;
        }
        return true;
      });
    }
    return layers;
  }
  function hasMinzoom(body) {
    // cheap check before taking the slower decode/encode path
    for (var i = 0; i + MINZOOM.length <= body.length; i++) {
      if (body[i] !== 95) continue; // '_'
      for (var k = 1; k < MINZOOM.length && body[i + k] === MINZOOM.charCodeAt(k); k++);
      if (k === MINZOOM.length) return true;
    }
    return false;
  }

  async function inflate(payload) {
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([payload.subarray(1)]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function isGbt(data) { return data && data.length > 0 && data[0] === MAGIC; }

  // One vector tile (MVT bytes) for z/x/y of a GBT file whose top level is `top`,
  // from getRaw(z, x, y, shared) -> stored payload (or null); `shared` fetches are
  // used by several tiles, so they must not be cancelled with the one that asked. Past the top level the tile is
  // cut from its stored ancestor, so MapLibre works on a quarter of the data per
  // tile at each level deeper. Decoded ancestors are kept in `cache` (a Map).
  async function makeTile(getRaw, cache, cacheKey, top, z, x, y) {
    if (z > top) {
      var dz = z - top, px = x >> dz, py = y >> dz, id = cacheKey + '/' + px + '/' + py;
      var p = cache.get(id);
      if (p) { cache.delete(id); cache.set(id, p); }
      else {
        p = getRaw(top, px, py, true).then(async function (raw) { return isGbt(raw) ? decode(await inflate(raw)) : null; });
        p.catch(function () { cache.delete(id); });
        cache.set(id, p);
        if (cache.size > 8) cache.delete(cache.keys().next().value);
      }
      var layers = await p;
      if (!layers) return new Uint8Array(0);
      var mask = (1 << dz) - 1;
      return encode(applyMinzoom(slice(layers, dz, x & mask, y & mask, 64), z));
    }
    var raw = await getRaw(z, x, y);
    if (!isGbt(raw)) return raw;
    var body = await inflate(raw);
    return hasMinzoom(body) ? encode(applyMinzoom(decode(body), z)) : toMvt(body);
  }

  var TILE_URL = /^pmtiles:\/\/(.+?)(?:@(\d+))?\/(\d+)\/(\d+)\/(\d+)$/;

  // MapLibre protocol handlers on top of a pmtiles.Protocol `pm`, for the page:
  //   pmtiles://key            TileJSON; for a GBT file (tile type 0) the tile URLs
  //                            carry its top level (pmtiles://key@13/{z}/{x}/{y}) and
  //                            maxzoom becomes opts.sliceTo, so MapLibre asks for
  //                            deeper tiles than the file has.
  //   pmtiles://key[@top]/z/x/y  a vector tile, made on the page (used only when the
  //                            workers don't have the handler from installWorkers)
  //   pmtiles-raw://key/z/x/y  the stored bytes, for the workers' handler
  function protocols(pm, opts) {
    var sliceTo = (opts && opts.sliceTo) || 0, cache = new Map();
    function raw(key, z, x, y, abort) {
      return pm.tilev4({ url: 'pmtiles://' + key + '/' + z + '/' + x + '/' + y, type: 'arrayBuffer' }, abort || new AbortController())
        .then(function (res) { return res && res.data instanceof Uint8Array ? res.data : null; });
    }
    return {
      pmtiles: async function (params, abort) {
        var m = TILE_URL.exec(params.url);
        if (!m) {
          var res = await pm.tilev4(params, abort);
          if (params.type === 'json' && res && res.data) {
            var key = params.url.substr(10), archive = pm.get(key);
            var header = archive && await archive.getHeader();
            if (header && header.tileType === 0 && sliceTo > res.data.maxzoom) {
              res.data.tiles = ['pmtiles://' + key + '@' + res.data.maxzoom + '/{z}/{x}/{y}'];
              res.data.maxzoom = sliceTo;
            }
          }
          return res;
        }
        var top = m[2] === undefined ? Infinity : +m[2];
        return { data: await makeTile(function (z, x, y, shared) { return raw(m[1], z, x, y, shared ? null : abort); }, cache, m[1], top, +m[3], +m[4], +m[5]) };
      },
      'pmtiles-raw': async function (params, abort) {
        var m = /^pmtiles-raw:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url);
        var data = await raw(m[1], +m[2], +m[3], +m[4], abort);
        return { data: data ? data.slice() : new Uint8Array(0) };
      }
    };
  }

  // In a MapLibre worker (loaded with maplibregl.importScriptInWorkers): make the
  // vector tiles here, off the page's thread, asking the page only for stored bytes.
  if (typeof importScripts === 'function' && typeof root.addProtocol === 'function' && typeof root.makeRequest === 'function') {
    var workerCache = new Map();
    root.addProtocol('pmtiles', async function (params, abort) {
      var m = TILE_URL.exec(params.url);
      var top = m[2] === undefined ? Infinity : +m[2];
      var data = await makeTile(function (z, x, y, shared) {
        return root.makeRequest({ url: 'pmtiles-raw://' + m[1] + '/' + z + '/' + x + '/' + y, type: 'arrayBuffer' }, shared || !abort ? new AbortController() : abort)
          .then(function (res) { return res && res.data ? new Uint8Array(res.data) : null; });
      }, workerCache, m[1], top, +m[3], +m[4], +m[5]);
      return { data: data };
    });
  }

  root.GBT = { toMvt: toMvt, inflate: inflate, isGbt: isGbt, protocols: protocols, makeTile: makeTile, applyMinzoom: applyMinzoom, decode: decode, encode: encode, slice: slice };
})(typeof self !== 'undefined' ? self : globalThis);
