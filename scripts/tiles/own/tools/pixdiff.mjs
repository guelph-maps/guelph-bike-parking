// Screenshots the same views with two or more tile files and counts differing pixels against the first.
//   node scripts/tiles/own/tools/pixdiff.mjs /build/ref/a.pmtiles /build/own/b.pmtiles   (OUT=dir to keep PNGs)
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const files = process.argv.slice(2);
const PORT = process.env.PORT || 8765, OUT = process.env.OUT;
if (OUT) mkdirSync(OUT, { recursive: true });
const views = JSON.parse(process.env.P || 'null') || [
  { key: 'city12', z: 12, lat: 43.545, lng: -80.245 }, { key: 'ne14', z: 14, lat: 43.592, lng: -80.215 },
  { key: 'south15', z: 15, lat: 43.487, lng: -80.215 }, { key: 'down17', z: 17, lat: 43.5448, lng: -80.2482 },
  { key: 'down19', z: 19, lat: 43.5448, lng: -80.2482 }, { key: 'houses18', z: 18, lat: 43.5205, lng: -80.229 },
];
const browser = await chromium.launch({ channel: 'msedge' });
const shots = {};
for (const f of files) for (const v of views) {
  const ctx = await browser.newContext({ viewport: { width: 760, height: 560 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.route('**/tiles/tiles.json', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: f, bytes: 1, date: '2026-11-15' }) }));
  // no bike-parking markers: only the base map
  await page.route('**/data/*.geojson', r => r.request().url().includes('boundary') ? r.continue() : r.fulfill({ contentType: 'application/json', body: '{"type":"FeatureCollection","features":[]}' }));
  await page.goto(`http://localhost:${PORT}/?legend=closed#${v.z}/${v.lat}/${v.lng}`);
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(2500);
  const png = await page.screenshot();
  shots[f + v.key] = png;
  if (OUT) writeFileSync(`${OUT}/${v.key}-${f.split('/').pop().replace('.pmtiles', '')}.png`, png);
  await ctx.close();
}
// decode PNGs in the browser and diff
const page = await browser.newPage();
for (const f of files.slice(1)) {
  const res = [];
  for (const v of views) {
    const n = await page.evaluate(async ([a, b]) => {
      const load = (s) => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + s; });
      const [ia, ib] = [await load(a), await load(b)];
      const c = new OffscreenCanvas(ia.width, ia.height), g = c.getContext('2d');
      g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, c.width, c.height).data;
      g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) n++;
      return n;
    }, [shots[files[0] + v.key].toString('base64'), shots[f + v.key].toString('base64')]);
    res.push(`${v.key} ${n}`);
  }
  console.log(f, 'pixels differing from', files[0] + ':', res.join('  '));
}
await browser.close();
