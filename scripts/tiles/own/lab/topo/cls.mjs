import { gunzipSync } from 'node:zlib';
import { decodeTile, tagsOf } from '../../../scripts/tiles/own/mvt.mjs';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
import { ringArea } from './topo.mjs';
const Z = process.argv[2];
for (const f of process.argv.slice(3)) {
  const { tiles } = listTiles(f); const o = {};
  for (const [k, gz] of tiles) { if (!k.startsWith(Z + '/')) continue;
    for (const l of decodeTile(gunzipSync(gz)).layers) if (l.name === 'landuse') for (const ft of l.features) {
      const c = tagsOf(l, ft).class; const r = (o[c] ||= [0, 0]); for (const p of ft.parts) { const a = ringArea(p); if (a > 0) { r[0]++; r[1] += a; } else r[1] += a; } } }
  console.log(f, Object.entries(o).map(([c, [n, a]]) => `${c}:${n}/${(a / 1e6).toFixed(2)}`).join(' '));
}
