// Screenshot sheets: N variants side by side per place. env V = [{key,label,tiles}], P = [{key,label,z,lat,lng}], OUT dir.
// Server: node C:/Users/kk/Code/guelph-bike-parking/build/measure/serve.mjs <worktree> 8773
import { chromium } from 'file:///C:/Users/kk/Code/guelph-bike-parking/node_modules/playwright/index.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:8773/';
const OUT = process.env.OUT || 'shots';
mkdirSync(OUT, { recursive: true });
const variants = JSON.parse(process.env.V), places = JSON.parse(process.env.P);
const W = +(process.env.W || 560), H = +(process.env.H || 480);
const browser = await chromium.launch({ channel: 'msedge' });
const shots = [];
for (const place of places) for (const v of variants) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.route('**/tiles/tiles.json', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ url: v.tiles, bytes: 1, date: '2026-11-15' }) }));
  await page.goto(`${BASE}?legend=closed#${place.z}/${place.lat}/${place.lng}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2500);
  const file = `${OUT}/${place.key}-${v.key}.png`;
  await page.screenshot({ path: file });
  shots.push({ place, v, file });
  await ctx.close();
}
const sheet = await browser.newPage({ viewport: { width: (W + 16) * variants.length + 16, height: H + 80 }, deviceScaleFactor: 1 });
for (const place of places) {
  const imgs = shots.filter(s => s.place === place).map(s =>
    `<figure><figcaption>${s.v.label}</figcaption><img src="data:image/png;base64,${readFileSync(s.file).toString('base64')}"></figure>`).join('');
  await sheet.setContent(`<style>body{margin:0;font:600 16px system-ui;background:#fff}
    .row{display:flex;gap:16px;padding:12px 16px 16px}figure{margin:0}img{width:${W}px;border:1px solid #ccc;display:block}
    figcaption{margin:0 0 6px}</style><div style="padding:8px 16px 0;font:700 18px system-ui">${place.label}</div><div class="row">${imgs}</div>`);
  await sheet.screenshot({ path: `${OUT}/sheet-${place.key}.png`, fullPage: true });
}
await browser.close();
console.log('done');
