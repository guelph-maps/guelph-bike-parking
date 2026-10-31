(function () {
  'use strict';

  var T = window.BIKE_PARKING_TYPES;
  var DATA_URL = 'data/bike-parking.geojson';
  var BOUNDARY_URL = 'data/guelph-boundary.geojson';
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
  //   basemap=cycle       start on the CyclOSM base map
  //   routes=1            show signed cycling routes on top
  //   search=0            hide the address search box
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

  var overlays = {
    'Cycling routes': L.tileLayer('https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png', {
      maxZoom: 19,
      opacity: 0.8,
      attribution: 'Routes: <a href="https://cycling.waymarkedtrails.org" target="_blank" rel="noopener">Waymarked Trails</a>'
    })
  };
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
  var ROOF = '<svg class="bp-roof" viewBox="0 0 26 11" width="26" height="11" aria-hidden="true">' +
    '<path d="M3 9l10-6.5L23 9" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M3 9l10-6.5L23 9" fill="none" stroke="#0f172a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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
      popupAnchor: [0, -16]
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
            '<p><span class="bp-key-roof">' + ROOF + '</span><span>covered or indoor</span></p>' +
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
        li.querySelector('.bp-type-count').title = s ? s.n + ' locations, ' + s.spaces + ' known spaces' : '';
      });
      // Make it obvious when the totals (and the map) leave some parking out.
      var filtered = coveredOnly || T.list.some(function (t) { return !enabledTypes[t.key]; });
      this._el.querySelector('.bp-legend-filtered').hidden = !filtered;
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
          el.innerHTML = '<h1>Guelph Bike Parking</h1>' +
            '<button type="button" class="bp-about-btn" title="About this map" aria-label="About this map">i</button>';
          L.DomEvent.on(el.querySelector('.bp-about-btn'), 'click', showAbout);
        }
        L.DomEvent.disableClickPropagation(el);
        return el;
      }
    });
    new Title().addTo(map);
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
              'autocomplete="off" enterkeyhint="search" role="combobox" aria-expanded="false" aria-controls="bp-results">' +
          '</form>' +
          '<ul class="bp-results" id="bp-results" role="listbox" hidden></ul>';
        L.DomEvent.disableClickPropagation(el);
        L.DomEvent.disableScrollPropagation(el);

        var form = el.querySelector('form');
        var input = el.querySelector('input');
        var list = el.querySelector('.bp-results');
        var results = [];
        var active = -1;
        var timer = null;
        var pending = null;

        function close() {
          list.hidden = true;
          input.setAttribute('aria-expanded', 'false');
          active = -1;
        }

        function render() {
          list.innerHTML = '';
          results.forEach(function (r, i) {
            var li = L.DomUtil.create('li', i === active ? 'is-active' : '', list);
            li.setAttribute('role', 'option');
            li.innerHTML = '<b>' + esc(r.label) + '</b>' + (r.detail ? '<span>' + esc(r.detail) + '</span>' : '');
            L.DomEvent.on(li, 'click', function () { choose(r); });
          });
          if (!results.length && input.value.trim().length >= 3) {
            list.innerHTML = '<li class="bp-empty">No matches in Guelph</li>';
          }
          list.hidden = !list.children.length;
          input.setAttribute('aria-expanded', String(!list.hidden));
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
        '<p class="bp-about-foot">Map data &copy; OpenStreetMap contributors (ODbL). ' +
          (embed ? '' : '<a href="embed.html">Embed this map</a> · ') + link(REPO_URL, 'Source code') + '</p>' +
      '</div>';
    if (about.showModal) about.showModal();
    else about.setAttribute('open', '');
  }

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
        var title = type.label + (p.capacity != null ? ', ' + p.capacity + ' spaces' : '');
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
