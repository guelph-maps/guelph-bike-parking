import { gunzipSync } from 'node:zlib';
import { listTiles } from '../../../scripts/tiles/cull-pmtiles.mjs';
import { decodeTile, tagsOf } from '../../../scripts/tiles/own/mvt.mjs';
const { tiles } = listTiles(process.argv[2]);
const s = {};
for (const [k, gz] of tiles) {
  const z = k.split('/')[0];
  for (const l of decodeTile(gunzipSync(gz)).layers) {
    const r = (s[z + ' ' + l.name] ||= { n: 0, ids: 0, ext: new Set(), keys: {}, cls: {}, types: {}, v: 0 });
    r.ext.add(l.extent);
    for (const f of l.features) {
      r.n++; if (f.id !== undefined) r.ids++;
      r.types[f.type] = (r.types[f.type] || 0) + 1;
      for (const p of f.parts) r.v += p.length / 2;
      const t = tagsOf(l, f);
      for (const kk of Object.keys(t)) r.keys[kk] = (r.keys[kk] || 0) + 1;
      if (t.class !== undefined) r.cls[t.class] = (r.cls[t.class] || 0) + 1;
    }
  }
}
for (const [k, r] of Object.entries(s).sort()) console.log(k, 'n', r.n, 'v', r.v, 'ids', r.ids, 'ext', [...r.ext], 'types', JSON.stringify(r.types), '\n   keys', JSON.stringify(r.keys), '\n   cls', JSON.stringify(r.cls));
