(function () {
  'use strict';

  var T = window.BIKE_PARKING_TYPES;
  var DATA_URL = 'data/bike-parking.geojson';
  var BOUNDARY_URL = 'data/guelph-boundary.geojson';
  var ROUTES_URL = 'data/cycle-routes.geojson';
  var REPO_URL = 'https://github.com/guelph-maps/guelph-bike-parking';
  var SEARCH_BBOX = '-80.335,43.475,-80.140,43.605'; // west,south,east,north
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
  //   basemap=street      start on OpenStreetMap's street map (online only)
  //   routes=1            show signed cycling routes on top
  //   search=0            hide the address search box
  var params = new URLSearchParams(location.search);
  var inFrame = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();
  if (location.hostname === 'guelph.bike' && !inFrame) {
    var counter = document.createElement('script');
    counter.dataset.goatcounter = 'https://osm-guelph.goatcounter.com/count';
    counter.dataset.goatcounterSettings = '{"path":"/guelph-bike-parking/"}';
    counter.async = true;
    counter.integrity = 'sha384-atnOLvQb9t+jTSipvd75X2yginT4PjVbqDdlJAmxMm+wYElFmeR6EmLP5bYeoRVQ';
    counter.crossOrigin = 'anonymous';
    counter.src = 'https://gc.zgo.at/count.v5.js';
    document.head.appendChild(counter);
  }
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
  // "Bike map" is ours (js/basemap.js, js/style.js) and works offline; the
  // street map is OpenStreetMap's own tiles, kept only as you browse.
  var bikeMap = L.maplibreGL({ style: window.bikeStyle(BikeBasemap.url), attribution: osmAttribution });
  var streetMap = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, crossOrigin: 'anonymous', attribution: osmAttribution
  });
  var baseLayers = { 'Bike map': bikeMap, 'Street map': streetMap };
  (params.get('basemap') === 'street' ? streetMap : bikeMap).addTo(map);
  map.attributionControl.setPrefix(false);

  // Save the whole map on the device, except inside other sites' pages (each
  // embedding site would keep its own copy) or when the phone asks to save data.
  var saveData = navigator.connection && navigator.connection.saveData;
  BikeBasemap.start({ autoSave: !embed && !saveData });
  BikeBasemap.onChange(function (s) {
    if (s.status === 'unavailable' && map.hasLayer(bikeMap)) {
      map.removeLayer(bikeMap);
      streetMap.addTo(map);
    }
  });

  var overlays = { 'Cycling routes': routesLayer() };
  if (params.get('routes') === '1') overlays['Cycling routes'].addTo(map);

  var initialView = readInitialView();
  if (initialView) map.setView(initialView.center, initialView.zoom);
  else map.fitBounds(CITY_BOUNDS);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  addLocateControl();
  addFullscreenControl();
  var layersControl = L.control.layers(baseLayers, overlays, { position: 'bottomright' }).addTo(map);
  addTitleControl();
  if (params.get('search') !== '0') addSearchControl();

  // ---- Markers ---------------------------------------------------------------
  // A roof in the pin's colour, resting on the circle so the pin reads as a
  // little house. The viewBox is in the pin's own pixels, peak over its centre.
  var ROOF = '<svg class="bp-roof" viewBox="-2 -9 38 19" width="38" height="19" aria-hidden="true">' +
    '<path d="M1.5 8L17-5l15.5 13"/><path d="M1.5 8L17-5l15.5 13"/></svg>';

  function markerIcon(type, capacity, covered, stack, title) {
    var badge = capacity == null
      ? '<span class="bp-badge bp-badge-unknown" title="Capacity not recorded">?</span>'
      : '<span class="bp-badge">' + fmt.format(capacity) + '</span>';
    return L.divIcon({
      className: 'bp-marker-wrap',
      html: '<div class="bp-marker' + (stack ? ' bp-stack' : '') + '" style="--c:' + type.color + '"' +
        (title ? ' title="' + title + '"' : '') + '>' + (covered ? ROOF : '') + T.svg(type, 20) + badge + '</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      // Open the popup above the roof rather than over it.
      popupAnchor: [0, covered ? -24 : -16]
    });
  }

  function plural(n, word) { return fmt.format(n) + ' ' + word + (n === 1 ? '' : 's'); }

  function clusterIcon(cluster) {
    var children = cluster.getAllChildMarkers();
    var spaces = 0, counted = 0, covered = true, groups = {}, order = [];
    children.forEach(function (m) {
      var k = m.bpType.key;
      if (!groups[k]) { groups[k] = { type: m.bpType, sites: 0, spaces: 0 }; order.push(k); }
      groups[k].sites++;
      // Spots without a recorded count are left out of the totals.
      if (m.options.capacity != null) { spaces += m.options.capacity; groups[k].spaces += m.options.capacity; counted++; }
      if (!isCovered(m.bpProps)) covered = false;
    });
    // Biggest share first, "type not recorded" last.
    order.sort(function (a, b) {
      return (a === 'unknown') - (b === 'unknown') || groups[b].sites - groups[a].sites;
    });
    var title = esc(plural(children.length, 'location') + (counted ? ', ' + plural(spaces, 'bike space') : '') + ': ' +
      order.map(function (k) {
        var g = groups[k];
        return g.type.label + ' ×' + g.sites + (g.spaces ? ' (' + fmt.format(g.spaces) + ')' : '');
      }).join(', '));

    // All the same kind (spots whose type isn't recorded go along with
    // anything): draw it as that type's pin, stacked, with the spaces added up.
    var known = order.filter(function (k) { return k !== 'unknown'; });
    if (known.length <= 1) {
      return markerIcon(groups[order[0]].type, counted ? spaces : null, covered, true, title);
    }

    // Mixed: colour by the share of each type.
    var at = 0, stops = order.map(function (k) {
      var from = at;
      at += groups[k].sites / children.length * 100;
      return groups[k].type.color + ' ' + from + '% ' + at + '%';
    });
    var gradient = 'conic-gradient(' + stops.join(',') + ')';
    // Covered parking is what people most often look for, so if the group has
    // a shelter, bike room or lockers, show that icon instead of a plain "P".
    var shelter = groups.building || groups.shed || groups.lockers;

    // Close up, a pin-sized stack with a split-colour body, so it doesn't
    // cover the single pins around it.
    if ((cluster._zoom != null ? cluster._zoom : map.getZoom()) >= 15) {
      return L.divIcon({
        className: 'bp-marker-wrap',
        html: '<div class="bp-marker bp-stack bp-mixed" title="' + title + '" style="--c:' + groups[order[0]].type.color +
          ';background:' + gradient + '">' + (covered ? ROOF : '') + T.svg(shelter ? shelter.type : T.resolve('other'), 20) +
          (counted ? '<span class="bp-badge">' + fmt.format(spaces) + '</span>'
            : '<span class="bp-badge bp-badge-unknown" title="Capacity not recorded">?</span>') + '</div>',
        iconSize: [34, 34],
        iconAnchor: [17, 17]
      });
    }

    // Further out, the total spaces with a ring showing the mix.
    var label = counted ? fmt.format(spaces) : String(children.length);
    var unit = counted ? (spaces === 1 ? 'space' : 'spaces') : 'sites';
    var size = 36 + 5 * label.length;
    return L.divIcon({
      className: 'bp-cluster-wrap',
      html: '<div class="bp-cluster" title="' + title + '" style="width:' + size + 'px;height:' + size + 'px;' +
        'background:' + gradient + '">' + (covered ? ROOF : '') +
        '<div class="bp-cluster-core"><b>' + label + '</b><span>' + unit + '</span></div></div>',
      iconSize: [size, size]
    });
  }

  var layer = useCluster
    ? L.markerClusterGroup({
        iconCreateFunction: clusterIcon,
        showCoverageOnHover: false,
        // People use this to check whether a destination has parking, then to
        // find the rack once they're there. So only group heavily at city
        // scale; from neighbourhood zoom on, merge just the pins that would sit
        // on top of each other (icons are 34px), so a strip mall shows each rack.
        maxClusterRadius: function (zoom) { return zoom <= 12 ? 60 : zoom === 13 ? 45 : zoom === 14 ? 34 : 18; },
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

  var OWNER_TYPES = {
    public: 'Public', government: 'Government', private: 'Private business', business: 'Private business',
    community: 'Community', religious: 'Place of worship', university: 'University', school: 'School'
  };

  function popupHtml(p, type, latlng) {
    var title = p.name || type.label;
    var chips = [];
    if (p.indoor === 'yes') chips.push(['Indoor', 'good']);
    else if (isCovered(p)) chips.push(['Covered', 'good']);
    else if (p.covered === 'no') chips.push(['Not covered', '']);
    if (p.fee === 'yes') chips.push(['Fee', 'warn']);
    else if (p.fee === 'no') chips.push(['Free', 'good']);
    if (p.access === 'customers' || p.access === 'permit' || p.access === 'permissive') {
      chips.push([{ customers: 'Customers only', permit: 'Permit needed', permissive: 'Permissive' }[p.access], 'warn']);
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
    if (p.street) html += '<p class="bp-meta">' + esc((p.housenumber ? p.housenumber + ' ' : '') + p.street) + '</p>';
    if (p.description) html += '<p class="bp-desc">' + esc(p.description) + '</p>';
    var owner = p.operator || OWNER_TYPES[p.operator_type];
    if (owner) {
      var ownerType = p.operator && OWNER_TYPES[p.operator_type];
      html += '<p class="bp-meta">Owner: ' + esc(owner) + (ownerType ? ' (' + esc(ownerType.toLowerCase()) + ')' : '') + '</p>';
    }
    if (p.opening_hours) html += '<p class="bp-meta">Hours: ' + esc(p.opening_hours) + '</p>';

    var ll = latlng.lat.toFixed(6) + ',' + latlng.lng.toFixed(6);
    var links = [link('https://www.google.com/maps/dir/?api=1&travelmode=bicycling&destination=' + ll, 'Directions')];
    if (p.mapillary) links.push(link('https://www.mapillary.com/app/?pKey=' + encodeURIComponent(p.mapillary), 'Photo'));
    else if (p.panoramax) links.push(link('https://api.panoramax.xyz/?focus=pic&pic=' + encodeURIComponent(p.panoramax), 'Photo'));
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
          '<span class="bp-legend-filtered" hidden>Filtered</span>' +
          '<span class="bp-legend-total"></span>' +
          '<span class="bp-chevron" aria-hidden="true"></span>' +
        '</button>' +
        '<div class="bp-legend-body" id="bp-legend-body">' +
          '<div class="bp-legend-help">' +
            '<p><span><span class="bp-key-badge">8</span></span><span>how many bikes fit (<b>?</b> = not recorded yet)</span></p>' +
            '<p><span class="bp-key-roof"><span class="bp-marker" style="--c:' + T.list[0].color + '">' + ROOF +
              T.svg(T.list[0], 14) + '</span></span><span>covered or indoor</span></p>' +
            '<p><span class="bp-key-stack"><span class="bp-marker" style="--c:' + T.list[0].color + '">' + T.svg(T.list[0], 14) + '</span></span>' +
              '<span>several spots of one type, spaces added up</span></p>' +
            '<p><span><span class="bp-key-cluster"><b>42</b></span></span><span>mixed types nearby, colours show the mix; zoom in for each spot</span></p>' +
          '</div>' +
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
          '<a href="#" class="bp-about-link">About &amp; corrections</a>' +
          (embed ? '' : ' · <a href="embed.html">Embed this map</a>');
        L.DomEvent.on(this._el.querySelector('.bp-about-link'), 'click', function (e) {
          L.DomEvent.preventDefault(e);
          showAbout();
        });
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
        li.querySelector('.bp-type-count').title = s ? plural(s.n, 'location') + ', ' + plural(s.spaces, 'known space') : '';
      });
      // Make it obvious when the totals (and the map) leave some parking out.
      var filtered = coveredOnly || T.list.some(function (t) { return !enabledTypes[t.key]; });
      this._el.querySelector('.bp-legend-filtered').hidden = !filtered;
      this._el.querySelector('.bp-legend-total').textContent = fmt.format(spaces) + ' spaces';
      this._el.querySelector('.bp-legend-total').title = plural(shown.length, 'location');
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
          el.innerHTML = '<h1>Guelph Bike Parking</h1>' +
            '<button type="button" class="bp-about-btn" title="About this map" aria-label="About this map">i</button>' +
            '<button type="button" class="bp-menu-btn" title="More" aria-label="More" aria-haspopup="true" aria-expanded="false">' +
              '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>' +
              '<span class="bp-menu-dot" hidden></span></button>' +
            '<div class="bp-menu" hidden></div>';
          L.DomEvent.on(el.querySelector('.bp-about-btn'), 'click', showAbout);
          setUpMenu(el);
        }
        L.DomEvent.disableClickPropagation(el);
        L.DomEvent.disableScrollPropagation(el);
        return el;
      }
    });
    new Title().addTo(map);
  }

  // The ⋮ menu: which release this is, and a way to start fresh.
  function setUpMenu(el) {
    var btn = el.querySelector('.bp-menu-btn');
    var box = el.querySelector('.bp-menu');
    function open() {
      renderMenu(box);
      box.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      el.classList.add('is-menu-open');
      checkForUpdate();
    }
    function close() {
      box.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      el.classList.remove('is-menu-open');
    }
    btn.addEventListener('click', function () { if (box.hidden) open(); else close(); });
    box.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      act.disabled = true;
      if (act.dataset.act === 'clear') {
        act.textContent = 'Clearing…';
        clearCacheAndReload();
      } else {
        act.textContent = 'Updating…';
        location.reload(); // the new release already controls the page
      }
    });
    document.addEventListener('pointerdown', function (e) { if (!box.hidden && !el.contains(e.target)) close(); }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !box.hidden) { close(); btn.focus(); }
    });
  }

  function addFullscreenControl() {
    var root = document.documentElement;
    var request = root.requestFullscreen || root.webkitRequestFullscreen;
    // Hidden where unsupported (iPhone Safari) or blocked (iframe without allow="fullscreen").
    if (!request || !(document.fullscreenEnabled || document.webkitFullscreenEnabled)) return;
    var current = function () { return document.fullscreenElement || document.webkitFullscreenElement; };
    var exit = function () { (document.exitFullscreen || document.webkitExitFullscreen).call(document); };

    var Fullscreen = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd: function () {
        var el = L.DomUtil.create('div', 'leaflet-bar');
        var btn = L.DomUtil.create('a', 'bp-fullscreen', el);
        btn.href = '#';
        btn.setAttribute('role', 'button');
        var sync = function () {
          var on = !!current();
          btn.title = on ? 'Exit full screen' : 'Full screen';
          btn.setAttribute('aria-label', btn.title);
          btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="' +
            (on ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5') +
            '" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          map.invalidateSize();
        };
        sync();
        document.addEventListener('fullscreenchange', sync);
        document.addEventListener('webkitfullscreenchange', sync);
        L.DomEvent.on(btn, 'click', function (e) {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          if (current()) exit();
          else request.call(root);
        });
        return el;
      }
    });
    new Fullscreen().addTo(map);
  }

  // Address / place search: parking names first, then places from Photon (OSM).
  function addSearchControl() {
    var pin = null;
    var Search = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var el = L.DomUtil.create('div', 'bp-search');
        el.innerHTML =
          '<form role="search">' +
            '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>' +
            '<input type="search" placeholder="Search address or place" aria-label="Search address or place" ' +
              'autocomplete="off" enterkeyhint="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="bp-results">' +
          '</form>' +
          '<ul class="bp-results" id="bp-results" role="listbox" hidden></ul>' +
          '<div class="bp-no-results" aria-hidden="true" hidden>No matches in Guelph</div>' +
          '<div class="bp-search-status" role="status" aria-live="polite"></div>';
        L.DomEvent.disableClickPropagation(el);
        L.DomEvent.disableScrollPropagation(el);

        var form = el.querySelector('form');
        var input = el.querySelector('input');
        var list = el.querySelector('.bp-results');
        var noResults = el.querySelector('.bp-no-results');
        var status = el.querySelector('.bp-search-status');
        var results = [];
        var active = -1;
        var timer = null;
        var pending = null;

        function close() {
          list.hidden = true;
          noResults.hidden = true;
          input.setAttribute('aria-expanded', 'false');
          input.removeAttribute('aria-activedescendant');
          status.textContent = '';
          active = -1;
        }

        function render() {
          list.innerHTML = '';
          results.forEach(function (r, i) {
            var li = L.DomUtil.create('li', i === active ? 'is-active' : '', list);
            li.id = 'bp-result-' + i;
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', String(i === active));
            li.innerHTML = '<b>' + esc(r.label) + '</b>' + (r.detail ? '<span>' + esc(r.detail) + '</span>' : '');
            L.DomEvent.on(li, 'click', function () { choose(r); });
          });
          list.hidden = !results.length;
          noResults.hidden = results.length > 0 || input.value.trim().length < 3;
          input.setAttribute('aria-expanded', String(!list.hidden));
          if (active >= 0) input.setAttribute('aria-activedescendant', 'bp-result-' + active);
          else input.removeAttribute('aria-activedescendant');
          status.textContent = results.length
            ? results.length + (results.length === 1 ? ' suggestion available' : ' suggestions available')
            : input.value.trim().length >= 3 ? 'No matches in Guelph' : '';
        }

        function choose(r) {
          close();
          input.value = r.label;
          input.blur();
          if (pin) { map.removeLayer(pin); pin = null; }
          if (r.marker) {
            if (layer.zoomToShowLayer) layer.zoomToShowLayer(r.marker, function () { r.marker.openPopup(); });
            else { map.setView(r.marker.getLatLng(), 18); r.marker.openPopup(); }
            return;
          }
          pin = L.circleMarker(r.latlng, { radius: 8, weight: 3, color: '#fff', fillColor: '#dc2626', fillOpacity: 1 })
            .bindTooltip(esc(r.label), { permanent: true, direction: 'top', offset: [0, -8] })
            .addTo(map);
          map.setView(r.latlng, 17);
        }

        function localMatches(q) {
          q = q.toLowerCase();
          return markers.filter(visible).filter(function (m) {
            var p = m.bpProps;
            return (p.name && p.name.toLowerCase().indexOf(q) !== -1) ||
              (p.street && ((p.housenumber || '') + ' ' + p.street).toLowerCase().indexOf(q) !== -1);
          }).slice(0, 3).map(function (m) {
            return {
              label: m.bpProps.name || ((m.bpProps.housenumber || '') + ' ' + m.bpProps.street).trim(),
              detail: m.bpType.label + (m.options.capacity != null ? ' · ' + m.options.capacity + ' spaces' : ''),
              marker: m
            };
          });
        }

        function placeLabel(p) {
          var street = [p.housenumber, p.street].filter(Boolean).join(' ');
          var label = p.name || street || p.city || 'Unnamed place';
          var detail = [p.name ? street : '', p.district || p.locality || '', p.city].filter(Boolean).join(', ');
          return { label: label, detail: detail };
        }

        function search(q) {
          var local = localMatches(q);
          if (pending) pending.abort();
          pending = window.AbortController ? new AbortController() : null;
          var url = 'https://photon.komoot.io/api/?limit=5&lang=en&bbox=' + SEARCH_BBOX + '&q=' + encodeURIComponent(q) +
            '&lat=' + GUELPH[0] + '&lon=' + GUELPH[1];
          fetch(url, pending ? { signal: pending.signal } : {})
            .then(function (r) { return r.json(); })
            .then(function (json) {
              var seen = {};
              var places = (json.features || []).map(function (f) {
                var l = placeLabel(f.properties);
                return { label: l.label, detail: l.detail, latlng: L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]) };
              }).filter(function (r) {
                var key = r.label + '|' + r.detail;
                return seen[key] ? false : (seen[key] = true);
              });
              results = local.concat(places).slice(0, 7);
              active = results.length ? 0 : -1;
              render();
            })
            .catch(function (err) {
              if (err.name === 'AbortError') return;
              results = local;
              render();
            });
          results = local;
          render();
        }

        L.DomEvent.on(input, 'input', function () {
          clearTimeout(timer);
          var q = input.value.trim();
          if (q.length < 3) { results = []; close(); return; }
          timer = setTimeout(function () { search(q); }, 250);
        });
        L.DomEvent.on(input, 'keydown', function (e) {
          if (list.hidden && e.key !== 'Escape') return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
            render();
          } else if (e.key === 'Escape') {
            close();
            if (!list.hidden || !input.value) input.blur();
          }
        });
        L.DomEvent.on(form, 'submit', function (e) {
          L.DomEvent.preventDefault(e);
          if (results[active]) choose(results[active]);
          else if (results[0]) choose(results[0]);
        });
        L.DomEvent.on(input, 'focus', function () { if (results.length) render(); });
        map.on('click', close);
        return el;
      }
    });
    new Search().addTo(map);
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

  // Signed cycling routes from OpenStreetMap (route=bicycle relations), loaded
  // the first time the overlay is switched on.
  function routesLayer() {
    var NETWORKS = {
      ncn: ['#dc2626', 'National route'],
      rcn: ['#9333ea', 'Regional route'],
      lcn: ['#2563eb', 'Local route']
    };
    var routes = L.geoJSON(null, {
      style: function (f) {
        return { color: (NETWORKS[f.properties.network] || NETWORKS.lcn)[0], weight: 5, opacity: 0.6, lineCap: 'round' };
      },
      onEachFeature: function (f, l) {
        var p = f.properties;
        var kind = (NETWORKS[p.network] || NETWORKS.lcn)[1];
        l.bindPopup('<div class="bp-popup"><strong>' + esc(p.name || p.ref || 'Cycling route') + '</strong>' +
          '<div class="bp-sub">' + kind + (p.ref && p.name ? ' · ' + esc(p.ref) : '') + '</div>' +
          '<div class="bp-links">' + (p.website ? link(p.website, 'Website') : '') +
          link('https://www.openstreetmap.org/' + p.osm, 'Details / fix') + '</div></div>');
      }
    });
    var loaded = false;
    routes.on('add', function () {
      if (loaded) return;
      loaded = true;
      fetch(ROUTES_URL)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (geojson) { if (geojson) routes.addData(geojson); })
        .catch(function () { loaded = false; });
    });
    return routes;
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

  // ---- About ---------------------------------------------------------------------
  var about = null;

  function showAbout() {
    if (!about) {
      about = document.createElement('dialog');
      about.className = 'bp-about';
      about.setAttribute('aria-labelledby', 'bp-about-title');
      document.body.appendChild(about);
      about.addEventListener('click', function (e) {
        if (e.target === about || e.target.closest('.bp-about-close')) about.close();
      });
    }
    var spaces = 0;
    markers.forEach(function (m) { spaces += m.options.capacity || 0; });
    var updated = dataInfo && dataInfo.osm_base
      ? new Date(dataInfo.osm_base).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'unknown';
    about.innerHTML =
      '<div class="bp-about-inner">' +
        '<button type="button" class="bp-about-close" aria-label="Close">&times;</button>' +
        '<h2 id="bp-about-title">About this map</h2>' +
        '<p>Where to lock your bike in Guelph. Each icon shows the kind of rack, and the number shows how many bikes it holds.</p>' +
        '<p><b>' + fmt.format(markers.length) + '</b> locations and <b>' + fmt.format(spaces) + '</b> counted spaces inside city limits. ' +
          'Data last updated ' + esc(updated) + '.</p>' +
        '<h3>Where the data comes from</h3>' +
        '<p>Everything on this map comes from ' + link('https://www.openstreetmap.org/about', 'OpenStreetMap') +
          ', the free map anyone can edit. The map checks for changes every week.</p>' +
        '<h3>Something missing or wrong?</h3>' +
        '<p>Tap the spot and choose <b>Details / fix</b> to correct it in OpenStreetMap, or ' +
          link('https://www.openstreetmap.org/edit#map=17/' + map.getCenter().lat.toFixed(5) + '/' + map.getCenter().lng.toFixed(5), 'add new parking') +
          '. Not a mapper? ' + link(REPO_URL + '/issues/new?title=' + encodeURIComponent('Bike parking correction'), 'Report it here') +
          '. Adding the number of spaces helps most.</p>' +
        '<h3>Using it without signal</h3>' +
        '<div class="bp-offline-box"></div>' +
        '<p class="bp-about-foot">Map data &copy; OpenStreetMap contributors (ODbL). ' +
          (embed ? '' : '<a href="embed.html">Embed this map</a> · ') + link(REPO_URL, 'Source code') + '</p>' +
      '</div>';
    renderOfflineBox(BikeBasemap.state());
    if (about.showModal) about.showModal();
    else about.setAttribute('open', '');
  }

  function renderOfflineBox(s) {
    var box = about && about.querySelector('.bp-offline-box');
    if (!box) return;
    function mb(bytes) { return bytes ? ' (' + Math.max(1, Math.round(bytes / 1048576)) + ' MB)' : ''; }
    function day(d) {
      return d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    }
    var size = s.info ? mb(s.info.bytes) : '';
    var html;
    if (s.status === 'downloading') {
      html = '<p>Saving the map… ' + Math.round(s.progress * 100) + '%</p>' +
        '<progress max="1" value="' + s.progress + '"></progress>';
    } else if (s.status === 'saved') {
      html = '<p>The whole Guelph map is saved on this device' + mb(s.saved && s.saved.bytes) +
        (s.saved && s.saved.date ? ', street data from ' + day(s.saved.date) : '') +
        ', so it works with no signal.</p>' +
        '<button type="button" class="bp-link-btn" data-act="remove">Remove saved map</button>';
    } else if (s.status === 'outdated') {
      html = '<p>A saved map is on this device' + (s.saved && s.saved.date ? ' (street data from ' + day(s.saved.date) + ')' : '') +
        '. A newer one is available.</p><button type="button" data-act="save">Update saved map' + size + '</button>';
    } else if (s.status === 'online') {
      html = '<p>Save the whole Guelph map on this device so it works with no signal. Parking data is always kept.</p>' +
        '<button type="button" data-act="save">Save map for offline' + size + '</button>';
    } else if (s.status === 'unavailable') {
      html = '<p>The bike map can’t be reached right now, so you’re seeing the street map.</p>';
    } else {
      html = '<p>Checking for a saved map…</p>';
    }
    if (s.error && s.status !== 'unavailable') html += '<p class="bp-offline-error">Last attempt failed: ' + esc(s.error) + '. Try again on Wi-Fi.</p>';
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var installed = navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    if (ios && !installed && !embed) {
      html += '<p class="bp-offline-hint">On iPhone and iPad, tap Share → <b>Add to Home Screen</b>. Otherwise Safari clears the saved map after about a week without a visit.</p>';
    }
    box.innerHTML = html;
    var btn = box.querySelector('[data-act]');
    if (btn) btn.addEventListener('click', function () {
      if (btn.dataset.act === 'save') {
        // Ask the browser not to clear the map when storage runs low.
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
        BikeBasemap.save();
      } else {
        BikeBasemap.remove();
      }
    });
  }
  BikeBasemap.onChange(function (s) { if (about && about.open) renderOfflineBox(s); });

  // ---- Offline -----------------------------------------------------------------
  // The service worker keeps the app, the data and viewed map tiles, so the map
  // still opens with no signal. Tell people when they're seeing a saved copy.
  var sw = 'serviceWorker' in navigator && location.protocol !== 'file:' ? navigator.serviceWorker : null;
  var swReg = sw ? sw.register('sw.js').catch(function () { return null; /* the map works without it */ }) : Promise.resolve(null);

  var offlineNote = L.DomUtil.create('div', 'bp-offline', map.getContainer());
  offlineNote.setAttribute('role', 'status');
  function syncOnline() {
    offlineNote.textContent = navigator.onLine ? '' : 'Offline: showing the saved map';
    offlineNote.hidden = navigator.onLine;
  }
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  syncOnline();

  // ---- Moving to guelph.bike -----------------------------------------------------
  // GitHub redirects the old address once the domain is set, but anyone who has
  // been here opens the app from the service worker and never sees that redirect,
  // and a redirected sw.js can't update them. So the old copy moves itself as soon
  // as the new site answers over HTTPS. Until then this fails and nothing happens.
  if (location.hostname === 'guelph-maps.github.io') {
    fetch('https://guelph.bike/manifest.webmanifest', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) return;
      location.replace('https://guelph.bike' + location.pathname.replace(/^\/guelph-bike-parking/, '') + location.search + location.hash);
    }).catch(function () {});
  }

  // ---- Release and cache ---------------------------------------------------------
  // Each deploy stamps sw.js with the app's release. A new one installs in the
  // background and takes over at once (skipWaiting), but this page keeps
  // running the code it opened with, so the menu offers a reload.
  var release = { loaded: null, newer: null };
  var lastCheck = 0;

  function askRelease(worker) {
    return new Promise(function (resolve) {
      if (!worker) return resolve(null);
      var channel = new MessageChannel();
      var t = setTimeout(function () { resolve(null); }, 3000); // releases before the menu don't answer
      channel.port1.onmessage = function (e) { clearTimeout(t); resolve(e.data); };
      worker.postMessage({ type: 'version' }, [channel.port2]);
    });
  }

  if (sw) {
    var hadController = !!sw.controller;
    askRelease(sw.controller).then(function (b) { if (b) { release.loaded = b; syncMenu(); } });
    sw.addEventListener('controllerchange', function () {
      askRelease(sw.controller).then(function (b) {
        // On a first visit the page came from the network, so it is this release.
        if (!hadController && !release.loaded) release.loaded = b;
        else if (b && b !== release.loaded) release.newer = b;
        hadController = true;
        syncMenu();
      });
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkForUpdate(); });
  }

  function checkForUpdate() {
    if (!navigator.onLine || Date.now() - lastCheck < 5 * 60000) return;
    lastCheck = Date.now();
    swReg.then(function (reg) { return reg && reg.update(); }).catch(function () {});
  }

  // Drops the app, the data, the street tiles and the saved bike map, then
  // reloads from the network; the fresh service worker saves it all again.
  function clearCacheAndReload() {
    var ours = /^(app-|data-v|tiles-v|basemap-v)/; // other github.io sites share this origin
    swReg.then(function (reg) { return reg && reg.unregister(); })
      .then(function () { return window.caches ? caches.keys() : []; })
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return ours.test(k); }).map(function (k) { return caches.delete(k); }));
      })
      .catch(function () {})
      .then(function () { location.reload(); });
  }

  function releaseLabel(b) {
    if (!b) return 'Version unknown';
    if (b === '__BUILD__') return 'Development copy';
    var m = /^([0-9a-f]+)-(\d+)$/.exec(b); // commit-count, from the deploy workflow
    return m ? 'Version ' + m[2] + ' (' + m[1].slice(0, 7) + ')' : 'Version ' + b;
  }

  function renderMenu(box) {
    var s = BikeBasemap.state();
    var bytes = (s.saved && s.saved.bytes) || (s.info && s.info.bytes);
    var html = '<p class="bp-menu-version">' + esc(releaseLabel(release.loaded)) + '</p>';
    if (release.newer) html += '<p class="bp-menu-new"><span>New</span> ' + esc(releaseLabel(release.newer)) + ' is ready</p>';
    html += '<div class="bp-menu-actions">' +
      (release.newer ? '<button type="button" data-act="update">Update now</button>' : '') +
      '<button type="button" data-act="clear"' + (navigator.onLine ? '' : ' disabled') + '>Clear cache &amp; reload</button>' +
      '</div><p class="bp-menu-hint">' + (navigator.onLine
        ? 'Clearing downloads the app and the bike map again' + (bytes ? ' (about ' + Math.max(1, Math.round(bytes / 1048576)) + ' MB)' : '') + '.'
        : 'Clearing needs a connection.') + '</p>';
    box.innerHTML = html;
  }

  function syncMenu() {
    var el = document.querySelector('.bp-title');
    var box = el && el.querySelector('.bp-menu');
    if (!box) return;
    el.querySelector('.bp-menu-dot').hidden = !release.newer;
    var btn = el.querySelector('.bp-menu-btn');
    btn.title = release.newer ? 'More: a new version is ready' : 'More';
    btn.setAttribute('aria-label', btn.title);
    if (!box.hidden) renderMenu(box);
  }
  window.addEventListener('online', syncMenu);
  window.addEventListener('offline', syncMenu);

  // ---- Load data -------------------------------------------------------------
  fetch(BOUNDARY_URL)
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (geojson) {
      if (!geojson) return;
      var boundary = L.geoJSON(geojson, {
        interactive: false,
        style: { color: '#0f766e', weight: 2.5, opacity: 0.7, dashArray: '8 6', fill: false }
      });
      boundary.addTo(map).bringToBack();
      layersControl.addOverlay(boundary, 'City boundary');
    })
    .catch(function () { /* the boundary is decoration; the map works without it */ });

  var status = L.DomUtil.create('div', 'bp-status', map.getContainer());
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
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
        // Private parking (staff-only cages, residents' rooms) isn't somewhere
        // a visitor can park, so leave it off the map and out of the totals.
        if (p.access === 'private' || p.access === 'no') return;
        var type = T.resolve(p.type);
        var latlng = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
        var title = type.label + (p.capacity != null ? ', ' + plural(p.capacity, 'space') : '') +
          (p.indoor === 'yes' ? ', indoor' : isCovered(p) ? ', covered' : '');
        var m = L.marker(latlng, {
          icon: markerIcon(type, p.capacity, isCovered(p)),
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
