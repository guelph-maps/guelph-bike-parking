// node drop.mjs in out 10[,11]  -> copy without those levels
import { readArchive, writeArchive } from '../../../scripts/tiles/cull-pmtiles.mjs';
const [i, o, lv] = process.argv.slice(2); const drop = lv.split(',');
const { header, metadata, tiles } = readArchive(i);
for (const k of [...tiles.keys()]) if (drop.includes(k.split('/')[0])) tiles.delete(k);
console.log(writeArchive(o, header, metadata, tiles));
