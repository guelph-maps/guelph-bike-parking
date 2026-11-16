// node pixdiff.mjs a.png b.png out.png -> counts differing pixels (any channel > 8) and writes a diff mask (red = differs)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [a, b, out] = process.argv.slice(2);
const br = await chromium.launch({ channel: 'msedge' }); const p = await br.newPage();
const r = await p.evaluate(async ([A, B]) => {
  const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/png;base64,' + s; });
  const [ia, ib] = await Promise.all([load(A), load(B)]); const w = ia.width, h = ia.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, w, h); g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, w, h);
  let n = 0; const o = g.createImageData(w, h);
  for (let i = 0; i < da.data.length; i += 4) { const d = Math.max(Math.abs(da.data[i] - db.data[i]), Math.abs(da.data[i + 1] - db.data[i + 1]), Math.abs(da.data[i + 2] - db.data[i + 2]));
    if (d > 8) { n++; o.data[i] = 255; o.data[i + 3] = 255; } else { o.data[i] = o.data[i + 1] = o.data[i + 2] = 255; o.data[i + 3] = 255; } }
  g.putImageData(o, 0, 0); return { n, total: w * h, url: c.toDataURL() };
}, [readFileSync(a).toString('base64'), readFileSync(b).toString('base64')]);
if (out) (await import('node:fs')).writeFileSync(out, Buffer.from(r.url.split(',')[1], 'base64'));
console.log(a, b, 'differing px', r.n, 'of', r.total); await br.close();
