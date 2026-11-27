// Which pins and which base map this app can read (DATA_FORMAT and MAP_FORMAT;
// `node scripts/formats.mjs check` keeps these equal to them). Files of a newer
// format are published under names carrying it, so this copy of the app never
// fetches data it can't understand: format 1 keeps the plain name, 2 and up add
// ".v2" before the extension (data/bike-parking.v2.geojson, tiles/tiles.v2.json).
// Loaded by the page and by sw.js.
(function (root) {
  'use strict';

  var formats = { data: 1, map: 1 };

  function versioned(path, kind) {
    var n = formats[kind];
    return n <= 1 ? path : path.replace(/(\.[A-Za-z]+)$/, '.v' + n + '$1');
  }

  root.BikeFormats = { formats: formats, versioned: versioned };
})(typeof self !== 'undefined' ? self : this);
