(function () {
  'use strict';

  var T = window.BIKE_PARKING_TYPES;
  var DATA_URL = 'data/bike-parking.geojson';
  var GUELPH = [43.5448, -80.2482];
  var CITY_BOUNDS = [[43.505, -80.300], [43.585, -80.185]];
  var fmt = new Intl.NumberFormat('en-CA');

  // ---- Options (URL parameters) ---------------------------------------------
  //   embed=1|0           compact embedded layout (auto-detected inside an iframe)
  //   lat, lng, zoom      initial view (default: fit all parking)
  //   types=stands,rack   only show these types
  //   covered=1           only show covered / indoor parking
  //   cluster=0           show every location, never group them
  //   legend=open|closed|0
  var params = new URLSearchParams(location.search);
  var inFrame = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();
  var embed = params.has('embed') ? params.get('embed') !== '0' : inFrame;
  var useCluster = params.get('cluster') !== '0';
  var smallScreen = window.matchMedia('(max-width: 640px)').matches;
  var legendMode = params.get('legend') || (embed || smallScreen ? 'closed' : 'open');

  var enabledTypes = {};
  var typeParam = params.get('types');
  var typeFilter = typeParam ? typeParam.split(',').map(function (s) { return s.trim(); }) : null;
  T.list.forEach(function (t) { enabledTypes[t.key] = !typeFilter || typeFilter.indexOf(t.key) !== -1; });
  var coveredOnly = params.get('covered') === '1';

  document.documentElement.classList.toggle('bp-embed', embed);

  // ---- Map -------------------------------------------------------------------
  var map = L.map('map', {
    zoomControl: false,
    scrollWheelZoom: !embed,
    zoomSnap: 0.5,
    minZoom: 11,
    maxZoom: 19
  });
  // Embedded maps shouldn't hijack page scrolling until someone interacts with them.
  if (embed) {
    map.on('click focus', function () { map.scrollWheelZoom.enable(); });
    map.getContainer().addEventListener('mouseleave', function () { map.scrollWheelZoom.disable(); });
  }

  var osmAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  var baseLayers = {
    'Street map': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: osmAttribution
    }),
    'Cycling map': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '<a href="https://www.cyclosm.org" target="_blank" rel="noopener">CyclOSM</a> | ' + osmAttribution
    })
  };
  (params.get('basemap') === 'cycle' ? baseLayers['Cycling map'] : baseLayers['Street map']).addTo(map);
  map.attributionControl.setPrefix(false);

  var initialView = readInitialView();
  if (initialView) map.setView(initialView.center, initialView.zoom);
  else map.fitBounds(CITY_BOUNDS);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  addLocateControl();
  L.control.layers(baseLayers, null, { position: 'bottomright' }).addTo(map);
  addTitleControl();

  // ---- Markers ---------------------------------------------------------------
  function markerIcon(type, capacity) {
    var badge = capacity == null
      ? '<span class="bp-badge bp-badge-unknown" title="Capacity not recorded">?</span>'
      : '<span class="bp-badge">' + capacity + '</span>';
    return L.divIcon({
      className: 'bp-marker-wrap',
      html: '<div class="bp-marker" style="--c:' + type.color + '">' + T.svg(type, 20) + badge + '</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      popupAnchor: [0, -16]
    });
  }

  function clusterIcon(cluster) {
    var children = cluster.getAllChildMarkers();
    var spaces = 0, unknown = 0;
    children.forEach(function (m) {
      if (m.options.capacity == null) unknown++;
      else spaces += m.options.capacity;
    });
    // Show total known spaces; fall back to the number of locations when none
    // of them has a count.
    var label = spaces ? fmt.format(spaces) : String(children.length);
    var unit = spaces ? (spaces === 1 && !unknown ? 'space' : 'spaces') : 'sites';
    var size = label.length >= 4 ? 54 : label.length === 3 ? 48 : 42;
    var title = children.length + ' locations' + (spaces ? ', ' + fmt.format(spaces) + (unknown ? '+' : '') + ' bike spaces' : '');
    return L.divIcon({
      className: 'bp-cluster-wrap',
      html: '<div class="bp-cluster" title="' + title + '" style="width:' + size + 'px;height:' + size + 'px">' +
        '<b>' + label + '</b><span>' + unit + '</span></div>',
      iconSize: [size, size]
    });
  }

  var layer = useCluster
    ? L.markerClusterGroup({
        iconCreateFunction: clusterIcon,
        showCoverageOnHover: false,
        maxClusterRadius: function (zoom) { return zoom <= 13 ? 70 : zoom <= 15 ? 55 : 40; },
        disableClusteringAtZoom: 18,
        spiderfyOnMaxZoom: true,
        chunkedLoading: true
      })
    : L.featureGroup();
  layer.addTo(map);

  var markers = [];
  var dataInfo = null;

  function isCovered(p) {
    return p.covered === 'yes' || p.indoor === 'yes' || p.type === 'shed' || p.type === 'building' || p.type === 'lockers';
  }

  function visible(m) {
    return enabledTypes[m.bpType.key] && (!coveredOnly || isCovered(m.bpProps));
  }

  function refresh() {
    var shown = markers.filter(visible);
    layer.clearLayers();
    if (layer.addLayers) layer.addLayers(shown);
    else shown.forEach(function (m) { layer.addLayer(m); });
    if (legend) legend.update(shown);
  }

  // ---- Popups ----------------------------------------------------------------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function link(href, text) {
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + text + '</a>';
  }

  function popupHtml(p, type, latlng) {
    var title = p.name || type.label;
    var chips = [];
    if (p.indoor === 'yes') chips.push(['Indoor', 'good']);
    else if (isCovered(p)) chips.push(['Covered', 'good']);
    else if (p.covered === 'no') chips.push(['Not covered', '']);
    if (p.fee === 'yes') chips.push(['Fee', 'warn']);
    else if (p.fee === 'no') chips.push(['Free', 'good']);
    if (p.access === 'private' || p.access === 'customers' || p.access === 'permit' || p.access === 'permissive') {
      chips.push([{ private: 'Private', customers: 'Customers only', permit: 'Permit needed', permissive: 'Permissive' }[p.access], 'warn']);
    }
    if (p.lit === 'yes') chips.push(['Lit at night', '']);
    if (p.surveillance && p.surveillance !== 'no') chips.push(['Surveillance', '']);
    if (p.cargo_bike === 'yes' || p.capacity_cargo) chips.push(['Cargo bikes' + (p.capacity_cargo ? ': ' + p.capacity_cargo : ''), 'good']);

    var html = '<div class="bp-popup">' +
      '<div class="bp-popup-head"><span class="bp-swatch" style="--c:' + type.color + '">' + T.svg(type, 18) + '</span>' +
      '<div><strong>' + esc(title) + '</strong>' +
      (p.name ? '<div class="bp-sub">' + esc(type.label) + '</div>' : '<div class="bp-sub">' + esc(type.hint) + '</div>') +
      '</div></div>';

    html += p.capacity != null
      ? '<p class="bp-cap"><b>' + p.capacity + '</b> bike space' + (p.capacity === 1 ? '' : 's') + '</p>'
      : '<p class="bp-cap bp-cap-unknown">Number of spaces not recorded</p>';

    if (chips.length) {
      html += '<ul class="bp-chips">' + chips.map(function (c) {
        return '<li class="' + c[1] + '">' + esc(c[0]) + '</li>';
      }).join('') + '</ul>';
    }
    if (p.description) html += '<p class="bp-desc">' + esc(p.description) + '</p>';
    if (p.operator) html += '<p class="bp-meta">Operator: ' + esc(p.operator) + '</p>';

    var ll = latlng.lat.toFixed(6) + ',' + latlng.lng.toFixed(6);
    var links = [link('https://www.google.com/maps/dir/?api=1&travelmode=bicycling&destination=' + ll, 'Directions')];
    if (p.mapillary) links.push(link('https://www.mapillary.com/app/?pKey=' + encodeURIComponent(p.mapillary), 'Photo'));
    if (p.website) links.push(link(p.website, 'Website'));
    links.push(link('https://www.openstreetmap.org/' + p.osm, 'Details / fix'));
    html += '<div class="bp-links">' + links.join('') + '</div></div>';
    return html;
  }

  // ---- Legend & filters ------------------------------------------------------
  var legend = null;

  var Legend = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      var el = L.DomUtil.create('div', 'bp-legend leaflet-bar');
      el.innerHTML =
        '<button type="button" class="bp-legend-toggle" aria-expanded="false" aria-controls="bp-legend-body">' +
          '<span class="bp-legend-title"><span class="bp-long">Bike parking</span><span class="bp-short">Key</span></span>' +
          '<span class="bp-legend-total"></span>' +
          '<span class="bp-chevron" aria-hidden="true"></span>' +
        '</button>' +
        '<div class="bp-legend-body" id="bp-legend-body">' +
          '<p class="bp-legend-help">Numbers show how many bikes fit. Green circles add up the spaces nearby; zoom in to see each spot.</p>' +
          '<ul class="bp-types"></ul>' +
          '<label class="bp-filter"><input type="checkbox" class="bp-covered"> Covered or indoor only</label>' +
          '<p class="bp-source"></p>' +
        '</div>';
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);

      var toggle = el.querySelector('.bp-legend-toggle');
      this._el = el;
      this.setOpen(legendMode === 'open');
      L.DomEvent.on(toggle, 'click', function () { this.setOpen(!this._open); }, this);

      var covered = el.querySelector('.bp-covered');
      covered.checked = coveredOnly;
      L.DomEvent.on(covered, 'change', function () { coveredOnly = covered.checked; refresh(); });
      return el;
    },
    setOpen: function (open) {
      this._open = open;
      this._el.classList.toggle('is-open', open);
      this._el.querySelector('.bp-legend-toggle').setAttribute('aria-expanded', open);
    },
    build: function (stats) {
      var ul = this._el.querySelector('.bp-types');
      ul.innerHTML = '';
      T.list.forEach(function (t) {
        var s = stats[t.key];
        if (!s) return;
        var li = L.DomUtil.create('li', '', ul);
        li.innerHTML =
          '<label title="' + esc(t.hint) + '">' +
            '<input type="checkbox"' + (enabledTypes[t.key] ? ' checked' : '') + '>' +
            '<span class="bp-swatch" style="--c:' + t.color + '">' + T.svg(t, 16) + '</span>' +
            '<span class="bp-type-label">' + esc(t.label) + '</span>' +
            '<span class="bp-type-count"></span>' +
          '</label>';
        li.dataset.type = t.key;
        L.DomEvent.on(li.querySelector('input'), 'change', function (e) {
          enabledTypes[t.key] = e.target.checked;
          refresh();
        });
      });
      if (dataInfo) {
        var updated = dataInfo.osm_base ? new Date(dataInfo.osm_base).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : null;
        this._el.querySelector('.bp-source').innerHTML =
          'Data: ' + link('https://www.openstreetmap.org/copyright', 'OpenStreetMap') +
          (updated ? ', ' + updated : '') + '. ' +
          link('https://www.openstreetmap.org/edit#map=17/' + GUELPH[0] + '/' + GUELPH[1], 'Add missing parking') +
          (embed ? '' : ' · <a href="embed.html">Embed this map</a>');
      }
    },
    update: function (shown) {
      var per = {}, spaces = 0;
      shown.forEach(function (m) {
        var k = m.bpType.key;
        per[k] = per[k] || { n: 0, spaces: 0 };
        per[k].n++;
        per[k].spaces += m.options.capacity || 0;
        spaces += m.options.capacity || 0;
      });
      this._el.querySelectorAll('.bp-types li').forEach(function (li) {
        var s = per[li.dataset.type];
        li.querySelector('.bp-type-count').textContent = s ? fmt.format(s.spaces || 0) : '–';
        li.querySelector('.bp-type-count').title = s ? s.n + ' locations, ' + s.spaces + ' known spaces' : '';
      });
      this._el.querySelector('.bp-legend-total').textContent = fmt.format(spaces) + ' spaces';
      this._el.querySelector('.bp-legend-total').title = shown.length + ' locations';
    }
  });

  if (legendMode !== '0') {
    legend = new Legend();
    legend.addTo(map);
  }

  // ---- Small controls ----------------------------------------------------------
  function addTitleControl() {
    var Title = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var el = L.DomUtil.create('div', 'bp-title');
        if (embed) {
          var fullParams = new URLSearchParams(location.search);
          fullParams.delete('embed');
          var full = location.pathname + (fullParams.toString() ? '?' + fullParams : '');
          el.innerHTML = '<a href="' + esc(full) + '" target="_blank" rel="noopener">Guelph bike parking <span aria-hidden="true">&#8599;</span></a>';
        } else {
          el.innerHTML = '<h1>Guelph Bike Parking</h1>';
        }
        L.DomEvent.disableClickPropagation(el);
        return el;
      }
    });
    new Title().addTo(map);
  }

  function addLocateControl() {
    var you = null;
    var Locate = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd: function () {
        var el = L.DomUtil.create('div', 'leaflet-bar');
        var btn = L.DomUtil.create('a', 'bp-locate', el);
        btn.href = '#';
        btn.title = 'Show my location';
        btn.setAttribute('role', 'button');
        btn.setAttribute('aria-label', 'Show my location');
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
        L.DomEvent.on(btn, 'click', function (e) {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          btn.classList.add('is-busy');
          map.locate({ setView: true, maxZoom: 17, enableHighAccuracy: true });
        });
        map.on('locationfound', function (e) {
          btn.classList.remove('is-busy');
          if (you) map.removeLayer(you);
          you = L.layerGroup([
            L.circle(e.latlng, { radius: e.accuracy, weight: 1, color: '#2563eb', fillOpacity: 0.08, interactive: false }),
            L.circleMarker(e.latlng, { radius: 7, weight: 3, color: '#fff', fillColor: '#2563eb', fillOpacity: 1 }).bindTooltip('You are here')
          ]).addTo(map);
        });
        map.on('locationerror', function () {
          btn.classList.remove('is-busy');
          window.alert('Your location is not available. Check that location access is allowed for this page.');
        });
        return el;
      }
    });
    new Locate().addTo(map);
  }

  // ---- View state --------------------------------------------------------------
  function readInitialView() {
    var lat = parseFloat(params.get('lat')), lng = parseFloat(params.get('lng')), z = parseFloat(params.get('zoom'));
    if (isFinite(lat) && isFinite(lng)) return { center: [lat, lng], zoom: isFinite(z) ? z : 16 };
    var m = location.hash.match(/^#(\d+(?:\.\d+)?)\/(-?\d+\.\d+)\/(-?\d+\.\d+)/);
    if (m) return { center: [+m[2], +m[3]], zoom: +m[1] };
    return null;
  }

  // Keep a shareable #zoom/lat/lng in the address bar (not when embedded).
  if (!embed && window.history && history.replaceState) {
    map.on('moveend', function () {
      var c = map.getCenter();
      history.replaceState(null, '', '#' + map.getZoom() + '/' + c.lat.toFixed(5) + '/' + c.lng.toFixed(5));
    });
  }

  // ---- Load data -------------------------------------------------------------
  var status = L.DomUtil.create('div', 'bp-status', map.getContainer());
  status.textContent = 'Loading bike parking…';

  fetch(DATA_URL)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (geojson) {
      dataInfo = geojson.metadata || null;
      var stats = {};
      geojson.features.forEach(function (f) {
        var p = f.properties;
        var type = T.resolve(p.type);
        var latlng = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
        var title = type.label + (p.capacity != null ? ', ' + p.capacity + ' spaces' : '');
        var m = L.marker(latlng, {
          icon: markerIcon(type, p.capacity),
          capacity: p.capacity,
          title: title,
          alt: title,
          keyboard: true
        });
        m.bpType = type;
        m.bpProps = p;
        m.bindPopup(function () { return popupHtml(p, type, latlng); }, { maxWidth: 280, minWidth: 220 });
        markers.push(m);
        stats[type.key] = (stats[type.key] || 0) + 1;
      });
      if (legend) legend.build(stats);
      refresh();
      status.remove();
    })
    .catch(function (err) {
      status.classList.add('is-error');
      status.textContent = 'Could not load bike parking data (' + err.message + ').';
    });
})();
