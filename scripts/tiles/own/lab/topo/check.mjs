// node check.mjs base.pmtiles out.pmtiles [handled layers] -> asserts every other layer's bytes are identical, tile by tile
import { gunzipSync } from 'node:zlib';
import { fields } from '../../../scripts/tiles/own/mvt.mjs';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
const handled = (process.argv[4] || 'landuse,water').split(',');
const layersOf = (gz) => { const m = new Map(); for (const [f, l] of fields(gunzipSync(gz))) if (f === 3) { let name = ''; for (const [g, v] of fields(l)) if (g === 1) { name = v.toString(); break; } m.set(name, Buffer.from(l)); } return m; };
const a = listTiles(process.argv[2]).tiles, b = listTiles(process.argv[3]).tiles;
let bad = 0, n = 0;
if (a.size !== b.size) { console.log('tile count differs', a.size, b.size); bad++; }
for (const [k, gz] of a) { const la = layersOf(gz), lb = layersOf(b.get(k));
  const oa = [...la.keys()].filter((x) => !handled.includes(x)), ob = [...lb.keys()].filter((x) => !handled.includes(x));
  if (oa.join() !== ob.join()) { console.log(k, 'layer order', oa, ob); bad++; }
  for (const name of oa) { n++; if (!la.get(name).equals(lb.get(name) || Buffer.alloc(0))) { console.log(k, name, 'differs'); bad++; } } }
console.log(process.argv[3], bad ? `FAILED (${bad})` : `ok: ${n} layer instances identical`);
