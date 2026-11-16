// Before/after pairs for PR 31: margin-box tiles vs the PR's city + 2 km build.
// Same OSM extract for both, so only the covered area differs.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8765/';
const OUT = process.env.OUT || 'build/measure/pr31';
mkdirSync(OUT, { recursive: true });

const variants = process.env.V ? JSON.parse(process.env.V) : [
  { key: 'before', label: 'Before: 5 km margin box (3.07 MB)', tiles: '/build/measure/guelph14.pmtiles' },
  { key: 'after', label: 'After: city + 2 km (2.00 MB)', tiles: '/build/measure/pr31-after.pmtiles' },
];
const places = process.env.P ? JSON.parse(process.env.P) : [
  { key: 'z11', label: 'Zoomed all the way out (zoom 11, the app\'s limit)', z: 11, lat: 43.545, lng: -80.245 },
  { key: 'z12', label: 'Whole city (zoom 12)', z: 12, lat: 43.545, lng: -80.245 },
  { key: 'northeast', label: 'North-east edge toward Guelph Lake (zoom 14)', z: 14, lat: 43.592, lng: -80.215 },
  { key: 'south', label: 'South edge by the Hanlon and Hwy 6 (zoom 15)', z: 15, lat: 43.487, lng: -80.215 },
];

const browser = await chromium.launch({ channel: 'msedge' });
const shots = [];
for (const place of places) {
  for (const v of variants) {
    const ctx = await browser.newContext({ viewport: { width: 760, height: 560 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.route('**/tiles/tiles.json', r => r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ url: v.tiles, bytes: 1, date: '2026-11-15' }) }));
    await page.goto(`${BASE}?legend=closed#${place.z}/${place.lat}/${place.lng}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
    const file = `${OUT}/${place.key}-${v.key}.png`;
    await page.screenshot({ path: file });
    shots.push({ place, v, file });
    await ctx.close();
  }
}

// One sheet per place: before and after side by side.
const sheet = await browser.newPage({ viewport: { width: 2340, height: 640 }, deviceScaleFactor: 1 });
for (const place of places) {
  const imgs = shots.filter(s => s.place === place).map(s =>
    `<figure><figcaption>${s.v.label}</figcaption><img src="data:image/png;base64,${readFileSync(s.file).toString('base64')}"></figure>`).join('');
  await sheet.setContent(`<style>body{margin:0;font:600 20px system-ui;background:#fff}
    .row{display:flex;gap:16px;padding:12px 16px 16px}figure{margin:0}img{width:760px;border:1px solid #ccc;display:block}
    figcaption{margin:0 0 6px}</style><div class="row">${imgs}</div>`);
  await sheet.screenshot({ path: `${OUT}/sheet-${place.key}.png`, fullPage: true });
}
await browser.close();
console.log('done');
