// Offline support. Guelph's mobile signal is patchy, and a weak connection is
// worse than none because requests hang, so nothing here waits on the network
// when a saved copy exists:
//   - the app itself: precached per release, served from cache
//   - parking data: served from cache at once, refreshed in the background
//   - the bike base map: one file the page saves itself (js/basemap.js)
//   - street map tiles: kept as you browse (capped), served from cache first
// scripts/build-site.sh replaces __BUILD__ with the app's version, so each
// release gets a fresh app cache; data and tiles carry over between releases,
// and a deploy that only refreshes them isn't a release.

var BUILD = '__BUILD__';
var APP_CACHE = 'app-' + BUILD;
var DATA_CACHE = 'data-v1';
var TILE_CACHE = 'tiles-v1';
var MAX_TILES = 3000; // ~50 MB of raster tiles
var NETWORK_TIMEOUT = 4000;

var APP_FILES = [
  './',
  'index.html',
  'css/map.css',
  'js/types.js',
  'js/basemap.js',
  'js/style.js',
  'js/map.js',
  'favicon.svg',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet.markercluster/MarkerCluster.css',
  'vendor/leaflet.markercluster/leaflet.markercluster.js',
  'vendor/maplibre-gl/maplibre-gl.css',
  'vendor/maplibre-gl/maplibre-gl.js',
  'vendor/maplibre-gl-leaflet/leaflet-maplibre-gl.js',
  'vendor/pmtiles/pmtiles.js'
].concat(['Regular', 'Medium', 'Italic'].reduce(function (all, weight) {
  return all.concat(['0-255', '256-511', '8192-8447'].map(function (range) {
    return 'vendor/fonts/Noto Sans ' + weight + '/' + range + '.pbf';
  }));
}, []));
var DATA_FILES = ['data/bike-parking.geojson', 'data/guelph-boundary.geojson', 'data/cycle-routes.geojson'];

var TILE_HOSTS = /(^|\.)(tile\.openstreetmap\.org)$/;

self.addEventListener('install', function (event) {
  event.waitUntil(Promise.all([
    caches.open(APP_CACHE).then(function (cache) {
      // 'reload' skips the HTTP cache so a release never precaches stale files.
      return cache.addAll(APP_FILES.map(function (u) { return new Request(u, { cache: 'reload' }); }));
    }),
    caches.open(DATA_CACHE).then(function (cache) {
      return Promise.all(DATA_FILES.map(function (u) {
        return cache.match(u).then(function (hit) { return hit || cache.add(new Request(u, { cache: 'reload' })); });
      }).concat(
        // Which bike map file is current; optional, so a missing one doesn't block installing.
        cache.add(new Request('tiles/tiles.json', { cache: 'reload' })).catch(function () {})
      ));
    })
  ]).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k.indexOf('app-') === 0 && k !== APP_CACHE;
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// The page asks which release this is, to show it and spot a newer one.
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'version' && event.ports[0]) event.ports[0].postMessage(BUILD);
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (TILE_HOSTS.test(url.hostname)) {
    event.respondWith(tile(event, req));
    return;
  }
  if (url.origin !== self.location.origin) return; // search etc. go straight to the network

  if (/\.pmtiles$/.test(url.pathname)) return; // range requests; js/basemap.js keeps the file
  if (/\/data\/[^/]+\.geojson$|\/tiles\/tiles\.json$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, req));
    return;
  }
  if (req.mode === 'navigate') {
    // ?embed=1&lat=… are all the same page.
    event.respondWith(caches.match(req, { cacheName: APP_CACHE, ignoreSearch: true }).then(function (hit) {
      return hit || fetch(req);
    }));
    return;
  }
  event.respondWith(caches.match(req, { cacheName: APP_CACHE }).then(function (hit) {
    return hit || fetch(req);
  }));
});

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

function staleWhileRevalidate(event, req) {
  return caches.open(DATA_CACHE).then(function (cache) {
    var key = req.url.split('?')[0];
    return cache.match(key).then(function (hit) {
      var update = fetch(req, { cache: 'no-cache' }).then(function (res) {
        if (res.ok) return cache.put(key, res.clone()).then(function () { return res; });
        return res;
      });
      if (hit) {
        event.waitUntil(update.catch(function () {}));
        return hit;
      }
      return withTimeout(update, NETWORK_TIMEOUT * 3);
    });
  });
}

function tile(event, req) {
  return caches.open(TILE_CACHE).then(function (cache) {
    return cache.match(req.url).then(function (hit) {
      if (hit) return hit;
      return withTimeout(fetch(req), NETWORK_TIMEOUT * 2).then(function (res) {
        if (res.ok && res.type === 'cors') {
          event.waitUntil(cache.put(req.url, res.clone()).then(function () { return trim(cache); }));
        }
        return res;
      });
    });
  });
}

var trimming = null;
function trim(cache) {
  // keys() lists entries oldest first; drop the oldest beyond the cap.
  trimming = trimming || cache.keys().then(function (keys) {
    var extra = keys.length - MAX_TILES;
    return extra > 0 ? Promise.all(keys.slice(0, extra + 200).map(function (k) { return cache.delete(k); })) : null;
  }).then(function () { trimming = null; }, function () { trimming = null; });
  return trimming;
}
