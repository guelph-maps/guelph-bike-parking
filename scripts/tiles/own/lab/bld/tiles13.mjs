// List level-13 tiles in a pmtiles file, with building-layer stats.
import { gunzipSync } from 'node:zlib';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
import { decodeTile } from '../../../scripts/tiles/own/mvt.mjs';
const { tiles } = listTiles(process.argv[2]);
const out = [];
for (const [k, gz] of tiles) if (k.startsWith('13/')) out.push(k);
console.log(JSON.stringify(out));
