// Screenshots of variants against the first (reference) variant, with a pixel diff.
// env V = [{key,label,tiles}], P = [{key,label,z,lat,lng,w?,h?}], OUT = dir.
// Prints differing-pixel counts; writes OUT/<place>.png sheets (ref | variant | diff ...).
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8771/';
const OUT = process.env.OUT || 'shots';
mkdirSync(OUT, { recursive: true });
const variants = JSON.parse(process.env.V);
const places = JSON.parse(process.env.P);
const SCALE = +(process.env.SHEET_SCALE || 0.5);

const browser = await chromium.launch({ channel: 'msedge' });
const shots = [];
for (const place of places) {
  for (const v of variants) {
    const ctx = await browser.newContext({ viewport: { width: place.w || 760, height: place.h || 560 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.route('**/tiles/tiles.json', (r) => r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ url: v.tiles, bytes: 1, date: '2026-11-15' }) }));
    await page.goto(`${BASE}?legend=closed#${place.z}/${place.lat}/${place.lng}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(+(process.env.WAIT || 2500));
    if (process.env.NOPINS) await page.addStyleTag({ content: '.leaflet-marker-pane,.leaflet-shadow-pane,.leaflet-control-container,.leaflet-overlay-pane svg{display:none!important}' });
    const file = `${OUT}/${place.key}-${v.key}.png`;
    await page.screenshot({ path: file });
    shots.push({ place, v, file });
    await ctx.close();
  }
}

const sheet = await browser.newPage({ deviceScaleFactor: 1 });
for (const place of places) {
  const row = shots.filter((s) => s.place === place);
  const imgs = row.map((s) => 'data:image/png;base64,' + readFileSync(s.file).toString('base64'));
  const res = await sheet.evaluate(async ({ imgs, labels, scale, title }) => {
    const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
    const els = await Promise.all(imgs.map(load));
    const W = els[0].width, H = els[0].height;
    const data = els.map((im) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, W, H); });
    document.body.innerHTML = `<style>body{margin:0;font:600 16px system-ui;background:#fff}.r{display:flex;flex-wrap:wrap;gap:10px;padding:8px}figure{margin:0}figcaption{margin:2px 0 4px}img,canvas{display:block;border:1px solid #bbb;width:${W * scale}px}</style><h3 style="margin:8px">${title}</h3><div class="r"></div>`;
    const r = document.querySelector('.r');
    const counts = [];
    els.forEach((im, i) => {
      const fig = document.createElement('figure');
      fig.innerHTML = `<figcaption>${labels[i]}</figcaption>`;
      fig.appendChild(im); r.appendChild(fig);
      if (i === 0) return;
      // diff image: differing pixels in red over a faded reference
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d'); const out = g.createImageData(W, H);
      let n = 0;
      const a = data[0].data, b = data[i].data;
      for (let p = 0; p < a.length; p += 4) {
        const d = Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
        if (d > 24) { n++; out.data[p] = 255; out.data[p + 1] = 0; out.data[p + 2] = 0; out.data[p + 3] = 255; }
        else { const l = (a[p] + a[p + 1] + a[p + 2]) / 3; out.data[p] = out.data[p + 1] = out.data[p + 2] = 200 + l / 5; out.data[p + 3] = 255; }
      }
      g.putImageData(out, 0, 0);
      counts.push(n);
      const f2 = document.createElement('figure');
      f2.innerHTML = `<figcaption>diff: ${n} px (${(n / (W * H) * 100).toFixed(2)}%)</figcaption>`;
      f2.appendChild(c); r.appendChild(f2);
    });
    return counts;
  }, { imgs, labels: row.map((s) => s.v.label), scale: SCALE, title: place.label });
  console.log(place.key.padEnd(14), row.slice(1).map((s, i) => `${s.v.key}:${res[i]}`).join('  '));
  await sheet.screenshot({ path: `${OUT}/${place.key}.png`, fullPage: true });
}
await browser.close();
