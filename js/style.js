// MapLibre style for our Guelph tiles (layers: scripts/tiles/schema.yml).
// A quiet, warm base so that anything you can ride stands out in blue:
//   solid blue        cycleways and paths designated for bikes
//   dashed blue       paths where bikes are allowed
//   dashed brown      unpaved paths where bikes are allowed
//   blue road edges   painted bike lanes, on the side they're on (thicker for separated tracks)
//   faint blue edges  paved shoulders
//   dashed blue line  shared lanes (sharrows)
//   orange dots       dismount sections
//   faint grey        footpaths without bike access
(function () {
  'use strict';

  var BLUE = '#2563eb';
  var BROWN = '#8a5a2b';
  var ROAD_CASE = '#c9c2b6';
  var base = new URL('.', location.href).href;

  function zoomWidth(stops) {
    return ['interpolate', ['exponential', 1.6], ['zoom']].concat(stops);
  }
  function is(key, values) {
    return ['in', ['get', key], ['literal', [].concat(values)]];
  }
  function has(key) { return ['has', key]; }
  function not(expr) { return ['!', expr]; }

  var MAJOR = ['motorway', 'trunk', 'primary', 'secondary'];
  var ROADS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'pedestrian'];
  var PATHS = ['cycleway', 'path', 'footway', 'bridleway', 'track', 'steps'];

  // Road width per class, in px at z12 / z14 / z18.
  var ROAD_WIDTH = {
    motorway: [1.6, 4, 16], trunk: [1.6, 4, 16], primary: [1.4, 3.6, 15], secondary: [1.2, 3.2, 14],
    tertiary: [1, 2.8, 13], minor: [0.6, 2, 11], pedestrian: [0.5, 1.6, 9], service: [0.3, 1, 6]
  };
  // Anything "extra" around a road (casing, bike edges) scales by this at z12 / z14 / z18.
  var EXTRA_SCALE = [0.3, 1, 3];
  // f(road width, extra scale) per class, at each of z12 / z14 / z18; half the z12 value at z10.
  function byRoadClass(f) {
    var stops = [0, 1, 2].map(function (i) {
      var m = ['match', ['get', 'class']];
      Object.keys(ROAD_WIDTH).forEach(function (c) { m.push(c, f(ROAD_WIDTH[c][i], EXTRA_SCALE[i])); });
      m.push(f([0.5, 1.5, 8][i], EXTRA_SCALE[i]));
      return m;
    });
    return zoomWidth([10, ['*', 0.5, stops[0]], 12, stops[0], 14, stops[1], 18, stops[2]]);
  }
  function roadWidth(extra) {
    return byRoadClass(function (w, k) { return w + extra * k; });
  }

  // Bike infrastructure on one side of a road: a blue edge just outside the road fill, on the
  // left or right of the line's direction (bike_left / bike_right in the tiles). Edge width at z14.
  var SIDE_KINDS = ['track', 'lane', 'shoulder'];
  function sideEdge(key) {
    return ['match', ['get', key], 'track', 2.25, 'shoulder', 1, 1.5];
  }
  function sideOffset(key, sign) {
    return byRoadClass(function (w, k) { return ['*', sign, ['+', w / 2, ['*', k / 2, sideEdge(key)]]]; });
  }
  function sideWidth(key) {
    return zoomWidth([10, ['*', 0.15, sideEdge(key)], 12, ['*', 0.3, sideEdge(key)], 14, sideEdge(key), 18, ['*', 3, sideEdge(key)]]);
  }
  // Tiles from before bike_left / bike_right carry only bike_lane, for both edges at once.
  var noSides = ['all', not(has('bike_left')), not(has('bike_right'))];

  var ROAD_FILL = ['match', ['get', 'class'],
    'motorway', '#f2b88a', 'trunk', '#f2b88a', 'primary', '#f8d892', 'secondary', '#fbe9b5',
    '#ffffff'];

  function roadLayers(prefix, filter, casingColor, dash) {
    var cas = {
      id: prefix + '-casing', type: 'line', source: 'guelph', 'source-layer': 'transportation',
      filter: ['all', is('class', ROADS), filter],
      layout: { 'line-join': 'round', 'line-cap': dash ? 'butt' : 'round' },
      paint: { 'line-color': casingColor, 'line-width': roadWidth(1.5) }
    };
    if (dash) cas.paint['line-dasharray'] = dash;
    function side(key, sign) {
      return {
        id: prefix + '-bike-' + key.slice(5), type: 'line', source: 'guelph', 'source-layer': 'transportation', minzoom: 12,
        filter: ['all', is('class', ROADS), filter, is(key, SIDE_KINDS)],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': BLUE,
          'line-opacity': ['match', ['get', key], 'track', 1, 'shoulder', 0.45, 0.7],
          'line-width': sideWidth(key),
          'line-offset': sideOffset(key, sign)
        }
      };
    }
    return [
      cas,
      // Older tiles: painted lanes and separated tracks as a blue edge on both sides, in place of the grey casing.
      {
        id: prefix + '-bike-lane', type: 'line', source: 'guelph', 'source-layer': 'transportation', minzoom: 12,
        filter: ['all', is('class', ROADS), filter, noSides, ['==', ['get', 'bike_lane'], 'lane']],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': BLUE, 'line-opacity': 0.7, 'line-width': roadWidth(3) }
      },
      {
        id: prefix + '-bike-track', type: 'line', source: 'guelph', 'source-layer': 'transportation', minzoom: 12,
        filter: ['all', is('class', ROADS), filter, noSides, ['==', ['get', 'bike_lane'], 'track']],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': BLUE, 'line-width': roadWidth(4.5) }
      },
      {
        id: prefix + '-fill', type: 'line', source: 'guelph', 'source-layer': 'transportation',
        filter: ['all', is('class', ROADS), filter],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ROAD_FILL, 'line-width': roadWidth(0) }
      },
      side('bike_left', -1),
      side('bike_right', 1),
      {
        id: prefix + '-bike-shared', type: 'line', source: 'guelph', 'source-layer': 'transportation', minzoom: 13,
        filter: ['all', is('class', ROADS), filter, ['any',
          ['==', ['get', 'bike_left'], 'shared'], ['==', ['get', 'bike_right'], 'shared'],
          ['all', noSides, ['==', ['get', 'bike_lane'], 'shared']]]],
        paint: { 'line-color': BLUE, 'line-opacity': 0.8, 'line-width': zoomWidth([13, 1, 18, 3]), 'line-dasharray': [2, 2] }
      }
    ];
  }

  var bikeOk = is('bicycle', ['designated', 'yes']);
  var unpaved = ['==', ['get', 'surface'], 'unpaved'];

  function pathLayers(prefix, filter) {
    var paths = ['all', is('class', PATHS), filter];
    return [
      // Footpaths without bike access: present, but faint.
      {
        id: prefix + '-foot', type: 'line', source: 'guelph', 'source-layer': 'transportation', minzoom: 13,
        filter: ['all', paths, not(bikeOk), ['!=', ['get', 'bicycle'], 'dismount']],
        paint: { 'line-color': '#9ca3af', 'line-width': zoomWidth([13, 0.6, 18, 2]), 'line-dasharray': [1.5, 1.5] }
      },
      {
        id: prefix + '-dismount', type: 'line', source: 'guelph', 'source-layer': 'transportation', minzoom: 13,
        filter: ['all', paths, ['==', ['get', 'bicycle'], 'dismount']],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#ea580c', 'line-width': zoomWidth([13, 1.5, 18, 4]), 'line-dasharray': [0.1, 2] }
      },
      // White halo so bike paths read over parks and fields.
      {
        id: prefix + '-bike-halo', type: 'line', source: 'guelph', 'source-layer': 'transportation', minzoom: 12,
        filter: ['all', paths, bikeOk],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.8, 'line-width': zoomWidth([12, 2.5, 14, 4, 18, 9]) }
      },
      {
        id: prefix + '-bike-designated', type: 'line', source: 'guelph', 'source-layer': 'transportation', minzoom: 12,
        filter: ['all', paths, ['==', ['get', 'bicycle'], 'designated'], not(unpaved)],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': BLUE, 'line-width': zoomWidth([12, 1.2, 14, 2.2, 18, 5]) }
      },
      {
        id: prefix + '-bike-allowed', type: 'line', source: 'guelph', 'source-layer': 'transportation', minzoom: 12,
        filter: ['all', paths, ['==', ['get', 'bicycle'], 'yes'], not(unpaved)],
        paint: { 'line-color': BLUE, 'line-width': zoomWidth([12, 1, 14, 1.8, 18, 4]), 'line-dasharray': [3, 1.5] }
      },
      {
        id: prefix + '-bike-unpaved', type: 'line', source: 'guelph', 'source-layer': 'transportation', minzoom: 12,
        filter: ['all', paths, bikeOk, unpaved],
        paint: { 'line-color': BROWN, 'line-width': zoomWidth([12, 1, 14, 1.8, 18, 4]), 'line-dasharray': [3, 1.5] }
      }
    ];
  }

  var bridge = ['==', ['get', 'bridge'], true];
  var tunnel = ['==', ['get', 'tunnel'], true];
  var ground = ['all', not(bridge), not(tunnel)];

  function landuse(id, classes, color, minzoom) {
    return {
      id: 'landuse-' + id, type: 'fill', source: 'guelph', 'source-layer': 'landuse', minzoom: minzoom || 0,
      filter: is('class', classes), paint: { 'fill-color': color }
    };
  }

  function label(id, sourceLayer, filter, opts) {
    return {
      id: id, type: 'symbol', source: 'guelph', 'source-layer': sourceLayer,
      minzoom: opts.minzoom || 0, maxzoom: opts.maxzoom || 24,
      filter: filter,
      layout: Object.assign({
        'text-field': ['get', 'name'],
        'text-font': [opts.font || 'Noto Sans Regular'],
        'text-size': opts.size,
        'text-max-width': 8
      }, opts.layout || {}),
      paint: Object.assign({ 'text-color': opts.color || '#334155', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.4 }, opts.paint || {})
    };
  }

  function poi(cls, color, minzoom, radius) {
    return {
      id: 'poi-' + cls, type: 'circle', source: 'guelph', 'source-layer': 'poi', minzoom: minzoom,
      filter: ['==', ['get', 'class'], cls],
      paint: {
        'circle-color': color, 'circle-radius': zoomWidth([minzoom, radius * 0.7, 18, radius * 1.5]),
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5
      }
    };
  }

  window.bikeStyle = function (tilesUrl) {
    return {
      version: 8,
      glyphs: base + 'vendor/fonts/{fontstack}/{range}.pbf',
      sources: {
        guelph: {
          type: 'vector', url: tilesUrl,
          attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>'
        }
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#f4f2ed' } },

        landuse('residential', 'residential', '#ece8e1'),
        landuse('farmland', 'farmland', '#eef0dc'),
        landuse('industrial', 'industrial', '#e7e2e8'),
        landuse('commercial', 'commercial', '#f1e4e1'),
        landuse('campus', ['university', 'school'], '#f1e8d5'),
        landuse('hospital', 'hospital', '#f4e0df'),
        landuse('grass', ['grass', 'recreation_ground', 'golf_course'], '#dcedce'),
        landuse('scrub', 'scrub', '#d5e4c2'),
        landuse('wetland', 'wetland', '#d2e5dc'),
        landuse('wood', 'wood', '#bfd9ab'),
        landuse('park', ['park', 'garden'], '#cde8c0'),
        landuse('cemetery', 'cemetery', '#d3dfcb'),
        landuse('pitch', ['pitch', 'playground'], '#c4e4c4', 12),

        { id: 'water', type: 'fill', source: 'guelph', 'source-layer': 'water', paint: { 'fill-color': '#a8d2eb' } },
        {
          id: 'waterway', type: 'line', source: 'guelph', 'source-layer': 'waterway',
          filter: not(tunnel),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#a8d2eb',
            'line-width': zoomWidth([
              10, ['match', ['get', 'class'], 'river', 1, 0.3],
              14, ['match', ['get', 'class'], 'river', 3, 1.2],
              18, ['match', ['get', 'class'], 'river', 10, 3]
            ])
          }
        },

        {
          id: 'building', type: 'fill', source: 'guelph', 'source-layer': 'building', minzoom: 13,
          paint: {
            'fill-color': '#ddd7cd',
            'fill-outline-color': '#cbc3b6',
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 15, 1]
          }
        }
      ]
        // Tunnels underneath, then ground level, then bridges on top.
        .concat(roadLayers('tunnel', tunnel, '#d9d4cb', [0.6, 0.4]))
        .concat(pathLayers('tunnel-path', tunnel))
        .concat(roadLayers('road', ground, ROAD_CASE))
        .concat(pathLayers('path', ground))
        .concat([
          {
            id: 'rail', type: 'line', source: 'guelph', 'source-layer': 'transportation',
            filter: ['==', ['get', 'class'], 'rail'],
            paint: { 'line-color': '#9a958d', 'line-width': zoomWidth([10, 0.6, 14, 1.4, 18, 3]) }
          },
          {
            id: 'rail-ties', type: 'line', source: 'guelph', 'source-layer': 'transportation', minzoom: 13,
            filter: ['all', ['==', ['get', 'class'], 'rail'], not(['==', ['get', 'service'], true])],
            paint: { 'line-color': '#9a958d', 'line-width': zoomWidth([13, 3, 18, 7]), 'line-dasharray': [0.15, 2.5] }
          }
        ])
        .concat(roadLayers('bridge', bridge, '#a8a197'))
        .concat(pathLayers('bridge-path', bridge))
        .concat([
          // Labels
          label('waterway-name', 'waterway', ['==', ['get', 'class'], 'river'], {
            minzoom: 13, size: 12, font: 'Noto Sans Italic', color: '#2f6f9f',
            layout: { 'symbol-placement': 'line', 'symbol-spacing': 400 }
          }),
          label('park-name', 'poi', ['==', ['get', 'class'], 'park'], {
            minzoom: 13, size: 11, font: 'Noto Sans Italic', color: '#3f6b35'
          }),
          label('path-name', 'transportation', ['all', is('class', PATHS), bikeOk], {
            minzoom: 14, size: 11, font: 'Noto Sans Italic', color: '#1d4ed8',
            layout: { 'symbol-placement': 'line', 'symbol-spacing': 300 }
          }),
          label('road-name-minor', 'transportation', is('class', ['tertiary', 'minor', 'service', 'pedestrian']), {
            minzoom: 15, size: zoomWidth([15, 10, 18, 13]),
            layout: { 'symbol-placement': 'line', 'text-rotation-alignment': 'map' }
          }),
          label('road-name-major', 'transportation', is('class', MAJOR), {
            minzoom: 13, size: zoomWidth([13, 10.5, 18, 14]), font: 'Noto Sans Medium',
            layout: { 'symbol-placement': 'line', 'text-rotation-alignment': 'map' }
          }),

          poi('drinking_water', '#0ea5e9', 15, 4),
          poi('toilets', '#64748b', 15, 4),
          poi('bicycle_repair_station', '#ea580c', 14, 5),
          poi('bicycle_shop', '#7c3aed', 13, 5.5),
          label('poi-bike-name', 'poi', is('class', ['bicycle_shop', 'bicycle_repair_station']), {
            minzoom: 15, size: 11, font: 'Noto Sans Medium', color: '#5b21b6',
            layout: {
              'text-field': ['coalesce', ['get', 'name'],
                ['match', ['get', 'class'], 'bicycle_repair_station', 'Bike repair stand', 'Bike shop']],
              'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-optional': true
            }
          }),
          label('poi-other-name', 'poi', is('class', ['drinking_water', 'toilets']), {
            minzoom: 17, size: 10, color: '#475569',
            layout: {
              'text-field': ['match', ['get', 'class'], 'drinking_water', 'Water', 'Toilets'],
              'text-anchor': 'left', 'text-offset': [0.8, 0], 'text-optional': true
            }
          }),

          label('place-neighbourhood', 'place', ['>=', ['get', 'rank'], 3], {
            minzoom: 12, size: zoomWidth([12, 10, 16, 13]), font: 'Noto Sans Medium', color: '#6b6359',
            layout: { 'text-transform': 'uppercase', 'text-letter-spacing': 0.08 }
          }),
          label('place-city', 'place', ['<=', ['get', 'rank'], 2], {
            maxzoom: 14, size: zoomWidth([10, 13, 13, 18]), font: 'Noto Sans Medium', color: '#1f2937'
          })
        ])
    };
  };
})();
