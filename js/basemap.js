// The bike base map: our own vector tiles of Guelph (scripts/build-tiles.mjs),
// drawn by MapLibre underneath Leaflet. The whole tile file is kept on the
// device, so the map works with no signal. Until it's saved, tiles stream from
// the site in small pieces (HTTP range requests).
//
// tiles/tiles.json names the current file: { "url", "bytes", "date" }. A new
// release gets a new file name, downloaded in the background and used from
// the next visit on, so one session never mixes two versions.
(function () {
  'use strict';

  var INFO_URL = 'tiles/tiles.json';
  var CACHE = 'basemap-v1';
  var KEY = 'guelph'; // what the style's pmtiles:// URL points at

  var listeners = [];
  var state = { status: 'checking', saved: null, info: null, progress: 0, error: null };

  function set(patch) {
    for (var k in patch) state[k] = patch[k];
    listeners.forEach(function (fn) { fn(state); });
  }

  function abs(url) { return new URL(url, location.href).href; }

  function timeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timed out')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  // { url, bytes, date, blob } for the copy on this device, or null.
  function savedCopy() {
    if (!window.caches) return Promise.resolve(null);
    return caches.open(CACHE).then(function (cache) {
      return cache.keys().then(function (keys) {
        if (!keys.length) return null;
        return cache.match(keys[0]).then(function (res) {
          return res.blob().then(function (blob) {
            return { url: keys[0].url, bytes: blob.size, date: res.headers.get('X-Map-Date'), blob: blob };
          });
        });
      });
    }).catch(function () { return null; });
  }

  function fetchInfo() {
    return timeout(fetch(INFO_URL, { cache: 'no-cache' }), 8000).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (info) {
      info.url = abs(new URL(info.url, abs(INFO_URL)).href);
      return info;
    });
  }

  // Range requests straight from the site, never through the browser's HTTP
  // cache. GitHub Pages gzips .pmtiles; once the whole file is in that cache
  // gzipped, phones answer a range with a slice of the gzip stream, which
  // can't be decoded, so the bike map stays blank until the file is saved.
  // pmtiles already does this for Chrome on Windows; this extends it to all.
  function streamingSource(url) {
    var source = new pmtiles.FetchSource(url);
    source.chromeWindowsNoCache = true; // read by getBytes: fetch with cache 'no-store'
    return source;
  }

  // A pmtiles Source that waits until we know where the tiles come from.
  var resolveSource, rejectSource;
  var inner = new Promise(function (res, rej) { resolveSource = res; rejectSource = rej; });
  inner.catch(function () {});
  // Set once the file this page is streaming has been saved: the same bytes,
  // so later tiles can come from the device if the signal drops mid-ride.
  var savedSource = null;
  var streamingUrl = null;
  var lazySource = {
    getKey: function () { return KEY; },
    getBytes: function (offset, length, signal, etag) {
      return inner.then(function (s) { return (savedSource || s).getBytes(offset, length, signal, etag); });
    }
  };

  var protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  protocol.add(new pmtiles.PMTiles(lazySource));

  var started = false;
  function start(opts) {
    if (started) return;
    started = true;
    savedCopy().then(function (saved) {
      if (saved) {
        resolveSource(new pmtiles.FileSource(new File([saved.blob], saved.url)));
        set({ status: 'saved', saved: { url: saved.url, bytes: saved.bytes, date: saved.date } });
      }
      return fetchInfo().then(function (info) {
        if (!saved) {
          streamingUrl = info.url;
          resolveSource(streamingSource(info.url));
        }
        var current = saved && saved.url === info.url;
        set({ info: info, status: current ? 'saved' : saved ? 'outdated' : 'online' });
        if (!current && opts.autoSave) save();
      }, function (err) {
        if (saved) return;
        rejectSource(err);
        set({ status: 'unavailable', error: err.message });
      });
    });
  }

  // Download the whole file into the cache, with progress, then drop old copies.
  var saving = null;
  function save() {
    if (saving || !state.info || !window.caches) return saving;
    var info = state.info;
    set({ status: 'downloading', progress: 0, error: null });
    // 'no-store': the copy goes into our own cache below, and a gzipped copy
    // left in the browser's HTTP cache breaks the range requests (see streamingSource).
    saving = fetch(info.url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var total = +res.headers.get('Content-Length') || info.bytes || 0;
      if (!res.body || !total) return res.blob();
      var reader = res.body.getReader();
      var chunks = [], got = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return new Blob(chunks);
          chunks.push(r.value);
          got += r.value.length;
          set({ progress: Math.min(1, got / total) });
          return pump();
        });
      }
      return pump();
    }).then(function (blob) {
      if (info.bytes && blob.size !== info.bytes) throw new Error('incomplete download');
      return caches.open(CACHE).then(function (cache) {
        return cache.put(info.url, new Response(blob, {
          headers: { 'Content-Type': 'application/octet-stream', 'X-Map-Date': info.date || '' }
        })).then(function () {
          return cache.keys().then(function (keys) {
            return Promise.all(keys.filter(function (k) { return k.url !== info.url; }).map(function (k) { return cache.delete(k); }));
          });
        });
      }).then(function () {
        if (info.url === streamingUrl) savedSource = new pmtiles.FileSource(new File([blob], info.url));
        set({ status: 'saved', saved: { url: info.url, bytes: blob.size, date: info.date } });
      });
    }).catch(function (err) {
      set({ status: state.saved ? 'outdated' : 'online', error: err.message });
    }).then(function () { saving = null; });
    return saving;
  }

  function remove() {
    return caches.delete(CACHE).then(function () {
      set({ status: state.info ? 'online' : 'unavailable', saved: null });
    });
  }

  window.BikeBasemap = {
    url: 'pmtiles://' + KEY,
    start: start, // { autoSave: bool }
    save: save,
    remove: remove,
    state: function () { return state; },
    onChange: function (fn) { listeners.push(fn); fn(state); },
    ready: inner
  };
})();
