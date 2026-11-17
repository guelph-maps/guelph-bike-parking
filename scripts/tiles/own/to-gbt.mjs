// Rewrites a PMTiles file of MVT tiles as GBT payloads (scripts/tiles/own/gbt.mjs)
// and checks every tile decodes back to the same MVT (with ids kept) or the same
// features (ids dropped), using the browser decoder js/gbt.js.
//   node scripts/tiles/own/to-gbt.mjs in.pmtiles out.pmtiles [--ids]
// or toGbtArchive(in, out, { ids }) from a script.
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, writeArchive } from '../cull-pmtiles.mjs';
import { decodeTile, encodeTile } from './mvt.mjs';
import { encodeGbt } from './gbt.mjs';
import '../../../js/gbt.js';

export function toGbtArchive(input, output, opts = {}) {
  const ids = !!opts.ids;
  const { header, metadata, tiles } = readArchive(input);
  const out = new Map(), levels = {};
  for (const [k, gz] of tiles) {
    const tile = decodeTile(gunzipSync(gz));
    const payload = encodeGbt(tile, { ids });
    out.set(k, payload);
    // check: the browser decoder gives back the same features
    const mvt = globalThis.GBT.toMvt(inflateRawSync(payload.subarray(1)));
    if (!ids) for (const l of tile.layers) for (const f of l.features) f.id = undefined;
    if (Buffer.compare(Buffer.from(mvt), encodeTile(tile)) !== 0) throw new Error(`tile ${k} does not round-trip`);
    const z = k.split('/')[0];
    levels[z] = (levels[z] || 0) + payload.length;
  }
  // Payloads are stored as they are (the decoder inflates them itself), and the tile
  // type says "unknown" so nothing mistakes them for MVT.
  writeArchive(output, { ...header, tileCompression: 1, tileType: 0 }, metadata, out);
  return { tiles: out.size, levels };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [input, output, ...flags] = process.argv.slice(2);
  const r = toGbtArchive(input, output, { ids: flags.includes('--ids') });
  console.log(`${input} -> ${output}: ${r.tiles} tiles round-trip, ${(statSync(input).size / 1e6).toFixed(3)} -> ${(statSync(output).size / 1e6).toFixed(3)} MB`);
}
