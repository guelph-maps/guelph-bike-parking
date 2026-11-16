// Rewrites a PMTiles file of MVT tiles as GBT payloads (scripts/tiles/own/gbt.mjs)
// and checks every tile decodes back to the same MVT (with ids kept) or the same
// features (ids dropped), using the browser decoder js/gbt.js.
//   node scripts/tiles/own/to-gbt.mjs in.pmtiles out.pmtiles [--ids]
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { statSync } from 'node:fs';
import { readArchive, writeArchive } from '../cull-pmtiles.mjs';
import { decodeTile, encodeTile } from './mvt.mjs';
import { encodeGbt } from './gbt.mjs';
import '../../../js/gbt.js';

const [input, output, ...flags] = process.argv.slice(2);
const ids = flags.includes('--ids');
const { header, metadata, tiles } = readArchive(input);
const out = new Map();
let decodeMs = 0, checked = 0;
for (const [k, gz] of tiles) {
  const raw = gunzipSync(gz);
  const tile = decodeTile(raw);
  const payload = encodeGbt(tile, { ids });
  out.set(k, payload);
  const body = inflateRawSync(payload.subarray(1));
  const t0 = performance.now();
  const mvt = globalThis.GBT.toMvt(body);
  decodeMs += performance.now() - t0;
  if (!ids) for (const l of tile.layers) for (const f of l.features) f.id = undefined;
  const expect = encodeTile(tile);
  if (Buffer.compare(Buffer.from(mvt), expect) !== 0) throw new Error(`tile ${k} does not round-trip`);
  checked++;
}
// Payloads are stored as they are (the decoder inflates them itself), and the tile
// type says "unknown" so nothing mistakes them for MVT.
const hdr = { ...header, tileCompression: 1, tileType: 0 };
writeArchive(output, hdr, metadata, out);
console.log(`${input} -> ${output}: ${checked} tiles round-trip, ${(statSync(input).size / 1e6).toFixed(3)} -> ${(statSync(output).size / 1e6).toFixed(3)} MB, toMvt ${decodeMs.toFixed(0)} ms total`);
