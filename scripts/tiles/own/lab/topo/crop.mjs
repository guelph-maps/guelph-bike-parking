// node crop.mjs out.png x y w h img1 label1 img2 label2 ...  (x,y,w,h in image px) -> side-by-side crop sheet, 1:1 pixels
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [out, x, y, w, h, ...rest] = process.argv.slice(2);
const items = []; for (let i = 0; i < rest.length; i += 2) items.push([rest[i], rest[i + 1]]);
const b = await chromium.launch({ channel: 'msedge' });
const p = await b.newPage({ viewport: { width: (+w + 12) * items.length + 12, height: +h + 50 } });
await p.setContent(`<style>body{margin:0;font:600 15px system-ui}.r{display:flex;gap:12px;padding:6px 12px}figure{margin:0}div{width:${w}px;height:${h}px;overflow:hidden;outline:1px solid #ccc}img{margin:${-y}px 0 0 ${-x}px}</style><div class="r" style="width:auto;height:auto;overflow:visible;outline:0">${items.map(([f, l]) => `<figure><figcaption>${l}</figcaption><div><img src="data:image/png;base64,${readFileSync(f).toString('base64')}"></div></figure>`).join('')}</div>`);
await p.screenshot({ path: out, fullPage: true }); await b.close();
