import { gunzipSync } from 'node:zlib';
import { decodeTile } from '../../../scripts/tiles/own/mvt.mjs';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
import { ringArea } from './topo.mjs';
const lname = process.argv[3] || 'water', Z = process.argv[4] || '10';
const { tiles } = listTiles(process.argv[2]);
const hist = {};
for (const [k, gz] of tiles) { if (!k.startsWith(Z + '/')) continue;
  for (const l of decodeTile(gunzipSync(gz)).layers) if (l.name === lname) for (const f of l.features) for (const p of f.parts) {
    const a = ringArea(p); const b = a < 0 ? 'hole' : a < 256 ? '<256' : a < 1024 ? '<1024' : a < 4096 ? '<4096' : 'big'; hist[b] = (hist[b] || 0) + 1; } }
console.log(process.argv[2], hist);
