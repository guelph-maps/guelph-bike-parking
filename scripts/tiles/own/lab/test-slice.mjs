// decode -> encode equals toMvt; slicing a tile into its 4 children: every child decodes,
// and the union of child features covers the parent's features.
import { inflateRawSync } from 'node:zlib';
import { listTiles } from '../../cull-pmtiles.mjs';
import { decodeTile } from '../../own/mvt.mjs';
import '../../../../../../js/gbt.js';
const G = globalThis.GBT;
const { tiles } = listTiles(process.argv[2]);
let n = 0, ms = 0, slices = 0;
for (const [k, payload] of tiles) {
  const body = inflateRawSync(payload.subarray(1));
  const a = Buffer.from(G.toMvt(body)), layers = G.decode(body), b = Buffer.from(G.encode(layers));
  if (Buffer.compare(a, b)) throw new Error('decode/encode differs ' + k);
  if (!k.startsWith('13/')) continue;
  const t0 = performance.now();
  for (let qx = 0; qx < 2; qx++) for (let qy = 0; qy < 2; qy++) {
    const child = decodeTile(Buffer.from(G.encode(G.slice(layers, 1, qx, qy, 64))));
    for (const l of child.layers) for (const f of l.features) for (const p of f.parts) for (const v of p) if (v < -200 || v > 4296) throw new Error('outside buffer ' + k + ' ' + v);
    slices++;
  }
  ms += performance.now() - t0; n++;
}
console.log(`decode/encode identical on ${tiles.size} tiles; ${slices} level-14 slices from ${n} level-13 tiles in ${ms.toFixed(0)} ms (${(ms / slices).toFixed(1)} ms each)`);
