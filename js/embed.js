(function () {
  'use strict';

  var VIEWS = {
    city: null,
    downtown: { lat: 43.5446, lng: -80.2489, zoom: 16 },
    uofg: { lat: 43.5320, lng: -80.2262, zoom: 16 }
  };
  var base = new URL('./', location.href).href;
  var form = document.getElementById('opts');
  var preview = document.getElementById('preview');
  var code = document.getElementById('code');

  function mapUrl() {
    var f = form.elements;
    var q = new URLSearchParams();
    if (f.legend.value !== 'closed') q.set('legend', f.legend.value);
    if (!f.cluster.checked) q.set('cluster', '0');
    if (f.covered.checked) q.set('covered', '1');
    if (f.street.checked) q.set('basemap', 'street');
    if (f.routes.checked) q.set('routes', '1');
    if (!f.search.checked) q.set('search', '0');
    var v = VIEWS[form.querySelector('[name=view]:checked').value];
    if (v) { q.set('lat', v.lat); q.set('lng', v.lng); q.set('zoom', v.zoom); }
    var s = q.toString();
    return base + (s ? '?' + s : '');
  }

  function update() {
    var f = form.elements;
    var h = Math.max(250, Math.min(1200, parseInt(f.height.value, 10) || 500));
    var url = mapUrl();
    var width = f.responsive.checked ? '100%' : '800';
    var html = '<iframe src="' + url + '" title="Map of bike parking in Guelph" ' +
      'width="' + width + '" height="' + h + '" style="border:0;max-width:100%;" ' +
      'loading="lazy" allow="geolocation; fullscreen" allowfullscreen ' +
      'referrerpolicy="strict-origin-when-cross-origin"></iframe>';
    code.value = html;
    preview.style.height = h + 'px';
    if (preview.getAttribute('src') !== url) preview.setAttribute('src', url);
  }

  form.addEventListener('input', update);
  form.addEventListener('change', update);
  document.getElementById('copy').addEventListener('click', function () {
    var btn = this;
    function done() { btn.textContent = 'Copied!'; setTimeout(function () { btn.textContent = 'Copy code'; }, 1500); }
    if (navigator.clipboard) navigator.clipboard.writeText(code.value).then(done, function () { code.select(); });
    else { code.select(); document.execCommand('copy'); done(); }
  });
  update();
})();