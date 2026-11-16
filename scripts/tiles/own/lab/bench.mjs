// Draw time of the base map alone (build/own/bench.html) under 4x CPU throttling, phone viewport.
//   node build/own/bench.mjs /build/ref/a.pmtiles /build/own/b.pmtiles   (RUNS=7, VIEWS='open,houses' STYLE=/js/style.js)
import { chromium, devices } from 'playwright';
const files = process.argv.slice(2).map(a => a.split('@'));  // file@slice[@w for worker]
const RUNS = +(process.env.RUNS || 7), PORT = process.env.PORT || 8765;
const VIEWS = { open: [11, 43.545, -80.245], edge: [13, 43.592, -80.215], down: [16, 43.5448, -80.2482], houses: [17, 43.5205, -80.229] };
const want = (process.env.VIEWS || 'open,edge,down,houses').split(',');
const styles = (process.env.STYLE || '/js/style.js').split(',');
const browser = await chromium.launch({ channel: 'msedge' });
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const rows = [];
for (const v of want) {
  for (let fi = 0; fi < files.length; fi++) {
    const [f, sl, w] = files[fi], style = styles[Math.min(fi, styles.length - 1)];
    const t = [], d = [];
    for (let r = 0; r < RUNS; r++) {
      const ctx = await browser.newContext({ ...devices['iPhone 13'] });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const [z, lat, lng] = VIEWS[v];
      await page.goto(`http://localhost:${PORT}/scripts/tiles/own/lab/bench.html?tiles=${f}&z=${z}&lat=${lat}&lng=${lng}&style=${style}&slice=${sl || 0}&worker=${w ? 1 : 0}`);
      await page.waitForFunction(() => window.__idle, null, { timeout: 120000, polling: 50 });
      t.push(await page.evaluate(() => window.__idle)); d.push(await page.evaluate(() => window.__dec));
      await ctx.close();
    }
    rows.push(`${v.padEnd(7)} ${(f + (sl ? '@' + sl : '') + (w ? '@w' : '')).padEnd(44)} ${String(Math.round(med(t))).padStart(5)} ms  (protocol ${Math.round(med(d))} ms)  runs ${t.map(Math.round).join(',')}`);
    console.log(rows[rows.length - 1]);
  }
}
await browser.close();
