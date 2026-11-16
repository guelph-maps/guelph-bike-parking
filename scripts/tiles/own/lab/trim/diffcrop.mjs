// node diffcrop.mjs a.png b.png out.png [cell]  -> crops of the cells with the most differing
// pixels: a | b | diff, side by side, at full resolution. Prints the cells.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [a, b, out, cellArg, nArg] = process.argv.slice(2);
const CELL = +(cellArg || 160), N = +(nArg || 3);
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const src = (f) => 'data:image/png;base64,' + readFileSync(f).toString('base64');
const cells = await page.evaluate(async ({ A, B, CELL, N }) => {
  const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = s; });
  const [ia, ib] = await Promise.all([load(A), load(B)]);
  const W = ia.width, H = ia.height;
  const get = (im) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, W, H).data; };
  const da = get(ia), db = get(ib);
  const gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL), cnt = new Array(gw * gh).fill(0);
  const diff = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    if (Math.abs(da[p] - db[p]) + Math.abs(da[p + 1] - db[p + 1]) + Math.abs(da[p + 2] - db[p + 2]) > 24) { diff[y * W + x] = 1; cnt[Math.floor(y / CELL) * gw + Math.floor(x / CELL)]++; }
  }
  const top = cnt.map((n, i) => [n, i]).filter((c) => c[0] > 0).sort((p, q) => q[0] - p[0]).slice(0, N);
  document.body.style.margin = 0;
  document.body.innerHTML = '';
  for (const [n, i] of top) {
    const cx = (i % gw) * CELL, cy = Math.floor(i / gw) * CELL;
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:6px;margin:4px;font:12px system-ui';
    for (const k of [0, 1, 2]) {
      const c = document.createElement('canvas'); c.width = CELL; c.height = CELL; c.style.cssText = `width:${CELL * 1.5}px;border:1px solid #999`;
      const g = c.getContext('2d');
      if (k < 2) g.drawImage(k ? ib : ia, cx, cy, CELL, CELL, 0, 0, CELL, CELL);
      else { g.drawImage(ia, cx, cy, CELL, CELL, 0, 0, CELL, CELL); g.fillStyle = 'rgba(255,255,255,.6)'; g.fillRect(0, 0, CELL, CELL); g.fillStyle = 'red';
        for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) if (diff[(cy + y) * W + cx + x]) g.fillRect(x, y, 1, 1); }
      row.appendChild(c);
    }
    const t = document.createElement('span'); t.textContent = `${n}px @ ${cx},${cy} (of ${W}x${H})`; row.appendChild(t);
    document.body.appendChild(row);
  }
  return top.map(([n, i]) => [n, (i % gw) * CELL, Math.floor(i / gw) * CELL]);
}, { A: src(a), B: src(b), CELL, N });
console.log(JSON.stringify(cells));
await page.screenshot({ path: out, fullPage: true });
await browser.close();
