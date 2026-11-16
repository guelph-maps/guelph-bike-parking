// Side-by-side screenshot sheets. env V = [{key,label,tiles}], P = [{key,label,z,lat,lng}], OUT dir, W/H viewport.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
const BASE = 'http://localhost:8772/';
const OUT = process.env.OUT || 'build/own/topo/shots';
mkdirSync(OUT, { recursive: true });
const variants = JSON.parse(process.env.V), places = JSON.parse(process.env.P);
const W = +(process.env.W || 640), H = +(process.env.H || 520);
const browser = await chromium.launch({ channel: 'msedge' });
const shots = [];
for (const place of places) for (const v of variants) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.route('**/tiles/tiles.json', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: v.tiles, bytes: 1, date: '2026-11-15' }) }));
  await page.goto(`${BASE}?legend=closed#${place.z}/${place.lat}/${place.lng}`);
  await page.waitForLoadState('networkidle');
  if (process.env.HIDE) await page.addStyleTag({ content: '.leaflet-marker-pane,.leaflet-shadow-pane,.leaflet-control-container,.leaflet-tooltip-pane,header,.search,.layers{display:none!important}' });
  await page.waitForTimeout(2500);
  const file = `${OUT}/${place.key}-${v.key}.png`;
  await page.screenshot({ path: file });
  shots.push({ place, v, file });
  await ctx.close();
}
const sheet = await browser.newPage({ viewport: { width: (process.env.C ? JSON.parse(process.env.C)[2] * 2 + 16 : W + 16) * variants.length + 16, height: H + 80 }, deviceScaleFactor: 1 });
for (const place of places) {
  const imgs = shots.filter(s => s.place === place).map(s =>
    process.env.C ? (() => { const [cx, cy, cw, ch] = JSON.parse(process.env.C); return `<figure><figcaption>${s.v.label}</figcaption><div style="width:${cw * 2}px;height:${ch * 2}px;overflow:hidden;border:1px solid #ccc"><img style="width:${W * 2}px;max-width:none;border:0;margin:${-cy * 2}px 0 0 ${-cx * 2}px" src="data:image/png;base64,${readFileSync(s.file).toString('base64')}"></div></figure>`; })() :
    `<figure><figcaption>${s.v.label}</figcaption><img src="data:image/png;base64,${readFileSync(s.file).toString('base64')}"></figure>`).join('');
  await sheet.setContent(`<style>body{margin:0;font:600 18px system-ui;background:#fff}h1{font-size:18px;margin:10px 16px 0}
    .row{display:flex;gap:16px;padding:8px 16px 16px}figure{margin:0}img{width:${W}px;border:1px solid #ccc;display:block}
    figcaption{margin:0 0 6px}</style><h1>${place.label}</h1><div class="row">${imgs}</div>`);
  await sheet.screenshot({ path: `${OUT}/sheet-${place.key}.png`, fullPage: true });
}
await browser.close();
console.log('done');
