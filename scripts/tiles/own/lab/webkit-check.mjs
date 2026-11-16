// GBT in WebKit (streamed, then from the saved copy), and fast pan/zoom in Chromium: no holes.
import { webkit, chromium, devices } from 'playwright';
const T = '/build/own/gbt/new-hardcut-trim.pmtiles', B = 'http://localhost:8765/';
const route = (page) => page.route('**/tiles/tiles.json', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: T, bytes: 881347, date: '2026-11-15' }) }));
const hook = () => { let realL; Object.defineProperty(window, 'L', { configurable: true, get: () => realL, set: x => { realL = x; if (x && x.Map && !x.__h) { x.__h = 1; x.Map.addInitHook(function () { window.__map = this; }); } } }); };
const idle = (page) => page.waitForFunction(() => { const m = window.__map; if (!m) return false; for (const k in m._layers) if (m._layers[k].getMaplibreMap) { const g = m._layers[k].getMaplibreMap(); return g && g.loaded() && g.areTilesLoaded(); } return false; }, null, { timeout: 60000, polling: 100 });
{
  const br = await webkit.launch();
  const ctx = await br.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage(); page.on('pageerror', e => console.log('webkit pageerror', e.message));
  await route(page); await page.addInitScript(hook);
  await page.goto(B + '?legend=closed#18/43.5205/-80.229'); await idle(page); await page.waitForTimeout(1500);
  await page.screenshot({ path: 'build/own/sheets/webkit-stream-18.png' });
  await page.waitForFunction(() => window.BikeBasemap && window.BikeBasemap.state().status === 'saved', null, { timeout: 60000 });
  console.log('webkit: streamed view drawn, file saved');
  await page.goto('about:blank'); await page.goto(B + '?legend=closed#12/43.545/-80.245'); await idle(page); await page.waitForTimeout(1500);
  console.log('webkit after reload: status', await page.evaluate(() => window.BikeBasemap.state().status));
  await page.screenshot({ path: 'build/own/sheets/webkit-saved-12.png' });
  await page.goto('about:blank'); await page.goto(B + '?legend=closed#19/43.5448/-80.2482'); console.log('webkit 19: status', await page.evaluate(() => window.BikeBasemap.state().status), 'saved bytes', await page.evaluate(() => window.BikeBasemap.state().saved && window.BikeBasemap.state().saved.bytes)); await idle(page); await page.waitForTimeout(1500);
  await page.screenshot({ path: 'build/own/sheets/webkit-saved-19.png' });
  await br.close();
}
{
  const br = await chromium.launch({ channel: 'msedge' });
  const shot = async (stress) => {
    const ctx = await br.newContext({ viewport: { width: 760, height: 560 }, serviceWorkers: 'block' });
    const page = await ctx.newPage(); await route(page); await page.addInitScript(hook);
    await page.route('**/data/*.geojson', r => r.request().url().includes('boundary') ? r.continue() : r.fulfill({ contentType: 'application/json', body: '{"type":"FeatureCollection","features":[]}' }));
    await page.goto(B + '?legend=closed#16/43.54/-80.25'); await idle(page);
    if (stress) await page.evaluate(async () => { const m = window.__map; for (let i = 0; i < 40; i++) { m.setView([43.54 + (i % 7) * 0.002, -80.25 + (i % 5) * 0.003], 16 + (i % 4), { animate: false }); await new Promise(r => setTimeout(r, 30)); } m.setView([43.5448, -80.2482], 18, { animate: false }); });
    else await page.evaluate(() => window.__map.setView([43.5448, -80.2482], 18, { animate: false }));
    await page.waitForTimeout(500); await idle(page); await page.waitForTimeout(1500);
    const png = await page.screenshot(); await ctx.close(); return png;
  };
  const a = await shot(false), b = await shot(true);
  (await import('node:fs')).writeFileSync('build/own/sheets/stress-calm.png', a); (await import('node:fs')).writeFileSync('build/own/sheets/stress-after.png', b);
  const page = await br.newPage();
  const n = await page.evaluate(async ([a, b]) => { const load = s => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + s; }); const [x, y] = [await load(a), await load(b)]; const c = new OffscreenCanvas(x.width, x.height), g = c.getContext('2d'); g.drawImage(x, 0, 0); const d1 = g.getImageData(0, 0, c.width, c.height).data; g.drawImage(y, 0, 0); const d2 = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d1.length; i += 4) if (Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2]) > 24) n++; return n; }, [a.toString('base64'), b.toString('base64')]);
  console.log('chromium: pixels differing after 40 fast pan/zoom steps vs a calm load:', n);
  await br.close();
}
