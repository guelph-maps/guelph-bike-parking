// Decode -> encode every tile of a PMTiles file and check the bytes come back identical.
//   node scripts/tiles/own/tools/calibrate.mjs file.pmtiles
import { gunzipSync } from 'node:zlib';
import { listTiles } from '../../cull-pmtiles.mjs';
import { decodeTile, encodeTile } from '../mvt.mjs';

const { tiles } = listTiles(process.argv[2]);
let same = 0, diff = 0, features = 0;
for (const [k, gz] of tiles) {
  const raw = gunzipSync(gz);
  const t = decodeTile(raw);
  features += t.layers.reduce((s, l) => s + l.features.length, 0);
  const again = encodeTile(t);
  if (Buffer.compare(raw, again) === 0) same++;
  else { diff++; if (diff < 4) console.log('differs', k, raw.length, again.length); }
}
console.log(`${process.argv[2]}: ${same} tiles identical, ${diff} differ, ${features} features`);
