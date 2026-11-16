// node verts.mjs file.pmtiles [layers]  -> vertices and gzip-estimated bytes per level for the given layers
import { gunzipSync, gzipSync } from 'node:zlib';
import { decodeTile, encodeTile } from '../../../scripts/tiles/own/mvt.mjs';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
const layers = (process.argv[3] || 'landuse,water').split(',');
const { tiles } = listTiles(process.argv[2]);
const s = {};
for (const [k, gz] of tiles) {
  const z = k.split('/')[0], t = decodeTile(gunzipSync(gz));
  for (const l of t.layers) if (layers.includes(l.name)) {
    const r = ((s[l.name] ||= {})[z] ||= { v: 0, f: 0, rings: 0, gz: 0 });
    r.f += l.features.length; r.gz += gzipSync(encodeTile({ layers: [l] })).length;
    for (const f of l.features) { r.rings += f.parts.length; for (const p of f.parts) r.v += p.length / 2; }
  }
}
for (const [n, zs] of Object.entries(s)) for (const [z, r] of Object.entries(zs)) console.log(n.padEnd(8), z, 'verts', String(r.v).padStart(7), 'rings', String(r.rings).padStart(5), 'gzKB', (r.gz / 1e3).toFixed(1));
