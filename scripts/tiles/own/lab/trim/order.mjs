import { gunzipSync } from 'node:zlib';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
import { decodeTile, tagsOf } from '../../../scripts/tiles/own/mvt.mjs';
const { tiles } = listTiles(process.argv[2]);
const k = process.argv[3]; const ln = process.argv[4] || 'transportation';
const l = decodeTile(gunzipSync(tiles.get(k))).layers.find(l => l.name === ln);
let prev = '', run = 0, out = [];
for (const f of l.features) { const t = tagsOf(l, f); const c = t.class + (t.bridge ? '/b' : '') + (t.tunnel ? '/t' : ''); if (c === prev) run++; else { if (prev) out.push(prev + 'x' + run); prev = c; run = 1; } }
out.push(prev + 'x' + run); console.log(out.join(' '));
console.log(l.features.slice(0,3).map(f=>[f.id, JSON.stringify(tagsOf(l,f)), f.parts.length]));
