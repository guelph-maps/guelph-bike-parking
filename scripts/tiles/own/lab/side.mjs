import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [a, b, out] = process.argv.slice(2);
const br = await chromium.launch({ channel: 'msedge' }); const p = await br.newPage({ viewport: { width: 1540, height: 580 } });
await p.setContent(`<body style="margin:0;display:flex;gap:20px"><img src="data:image/png;base64,${readFileSync(a).toString('base64')}"><img src="data:image/png;base64,${readFileSync(b).toString('base64')}">`);
await p.screenshot({ path: out }); await br.close();
