// Time-to-idle of the base map under 4x CPU throttling: phone opening the app (default view,
// Leaflet zoom 12 -> level 11) and a first draw at Leaflet 17, plus zoom steps 15..18.
// Also sums the time spent turning GBT payloads into MVT on the main thread.
//   node scripts/tiles/own/tools/perf.mjs /build/ref/a.pmtiles /build/own/b.pmtiles ...   (RUNS=5)
import { chromium, devices } from 'playwright';
const files = process.argv.slice(2);
const RUNS = +(process.env.RUNS || 5), lat = 43.52, lng = -80.266;
const PORT = process.env.PORT || 8765;
const browser = await chromium.launch({ channel: 'msedge' });
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const waitIdle = (page) => page.waitForFunction(() => { const m = window.__map; if (!m) return false; for (const k in m._layers) if (m._layers[k].getMaplibreMap) { const g = m._layers[k].getMaplibreMap(); return g && g.loaded() && g.areTilesLoaded(); } return false; }, null, { timeout: 120000, polling: 50 });
async function open(tiles, hash) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.route('**/tiles/tiles*.json', x => x.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: tiles, bytes: 1, date: '2026-11-15' }) }));
  await page.addInitScript(() => {
    let realL; Object.defineProperty(window, 'L', { configurable: true, get: () => realL, set: x => { realL = x; if (x && x.Map && !x.__h) { x.__h = 1; x.Map.addInitHook(function () { window.__map = this; }); } } });
    window.__gbt = 0; let realG; Object.defineProperty(window, 'GBT', { configurable: true, get: () => realG, set: g => { const t = g.toMvt; g.toMvt = (b) => { const s = performance.now(); const r = t(b); window.__gbt += performance.now() - s; return r; }; realG = g; } });
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/?legend=closed${hash}`);
  await waitIdle(page);
  return { ctx, page, ms: Date.now() - t0 };
}
for (const tiles of files) {
  const opens = [], firsts = [], steps = [], dec = [];
  for (let r = 0; r < RUNS; r++) {
    let o = await open(tiles, '');
    opens.push(o.ms); dec.push(await o.page.evaluate(() => window.__gbt)); await o.ctx.close();
    o = await open(tiles, `#17/${lat}/${lng}`);
    firsts.push(o.ms);
    steps.push(await o.page.evaluate(async ([lat, lng]) => {
      const m = window.__map; let g; for (const k in m._layers) if (m._layers[k].getMaplibreMap) g = m._layers[k].getMaplibreMap();
      const idle = () => new Promise(res => { const t = performance.now(); g.once('idle', () => res(performance.now() - t)); });
      const out = [];
      for (const z of [15, 16, 17, 18]) { const p = idle(); m.setView([lat, lng], z, { animate: false }); out.push(Math.round(await p)); }
      return out;
    }, [lat, lng]));
    await o.ctx.close();
  }
  console.log(tiles.padEnd(36), 'open', med(opens), 'ms (decode', Math.round(med(dec)), 'ms)  first z17', med(firsts), 'ms  zoom 15/16/17/18:', [0, 1, 2, 3].map(i => med(steps.map(s => s[i]))).join('/'), '  opens:', opens.join(','));
}
await browser.close();
