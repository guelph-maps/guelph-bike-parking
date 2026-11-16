// Dump the building layer of level-13 tiles: {"13/x/y": {extent, rings:[[x0,y0,...],...]}} (rings in MVT order).
// usage: node dump.mjs in.pmtiles out.json [layer=building] [zoom=13]
import { gunzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
import { decodeTile } from '../../../scripts/tiles/own/mvt.mjs';
const [inp, out, layer = 'building', zoom = '13'] = process.argv.slice(2);
const { tiles } = listTiles(inp);
const res = {};
for (const [k, gz] of tiles) {
  if (!k.startsWith(zoom + '/')) continue;
  const l = decodeTile(gunzipSync(gz)).layers.find(l => l.name === layer); if (!l) continue;
  const rings = []; for (const f of l.features) for (const p of f.parts) rings.push(Array.from(p));
  res[k] = { extent: l.extent, rings };
}
writeFileSync(out, JSON.stringify(res));
