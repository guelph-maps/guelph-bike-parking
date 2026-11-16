// Replace the level-13 building layer of a base pmtiles with rings from a variant JSON; report sizes.
// usage: node splice.mjs variant.json out.pmtiles [base=../../ref/simp-safe.cut.pmtiles]
//   variant: {"13/x/y": {extent, rings:[[x,y,...],...]}}; rings in MVT order, outer positive shoelace (y down).
// Prints: building layer gzip bytes (layer alone, as layers.mjs counts), file MB, delta vs base.
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { readArchive, writeArchive } from '../../../scripts/tiles/cull-pmtiles.mjs';
import { decodeTile, encodeTile } from '../../../scripts/tiles/own/mvt.mjs';
const [vf, out, base = '../../ref/simp-safe.cut.pmtiles'] = process.argv.slice(2);
const v = JSON.parse(readFileSync(vf, 'utf8'));
const { header, metadata, tiles } = readArchive(base);
let layerGz = 0, baseLayerGz = 0, nTiles = 0;
const ntiles = new Map();
for (const [k, gz] of tiles) {
  const t = decodeTile(gunzipSync(gz));
  const i = t.layers.findIndex(l => l.name === 'building');
  if (i >= 0) baseLayerGz += gzipSync(encodeTile({ layers: [t.layers[i]] })).length;
  if (k.startsWith('13/') && v[k]) {
    const nl = { name: 'building', version: 2, extent: v[k].extent, keys: [], values: [],
      features: v[k].rings.length ? [{ type: 3, tags: [], parts: v[k].rings.map(r => Int32Array.from(r)) }] : [] };
    if (i >= 0) t.layers[i] = nl; else t.layers.splice(1, 0, nl);
    nTiles++;
    layerGz += gzipSync(encodeTile({ layers: [nl] })).length;
    ntiles.set(k, gzipSync(encodeTile(t), { level: 9 }));
  } else ntiles.set(k, gz);
}
writeArchive(out, header, metadata, ntiles);
const a = statSync(base).size, b = statSync(out).size;
console.log(`${vf}: building gz ${(layerGz / 1e3).toFixed(1)} kB (base ${(baseLayerGz / 1e3).toFixed(1)}), file ${(b / 1e6).toFixed(3)} MB (base ${(a / 1e6).toFixed(3)}, ${b - a >= 0 ? '+' : ''}${((b - a) / 1e3).toFixed(1)} kB), ${nTiles} tiles`);
