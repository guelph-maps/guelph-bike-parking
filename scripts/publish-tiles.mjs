#!/usr/bin/env node
// Copies a base map file into a site folder under a name that changes whenever
// its content does, and writes tiles.json next to it for js/basemap.js:
// { "url", "bytes", "date" }. Phones keep the whole file, so a new name is how
// they learn there's a newer map.
//
// A file in build/previous/ (scripts/get-live-tiles.sh) is kept beside it too, by name.
//
//   node scripts/publish-tiles.mjs [out-dir] [format]     (default: tiles/, MAP_FORMAT)
//
// Each map format has its own input (build/guelph.pmtiles, build/guelph.v2.pmtiles)
// and its own manifest (tiles.json, tiles.v2.json; scripts/formats.mjs), so the
// deploy can publish the previous format next to the current one for older apps.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFormat, tilesAsset, versioned } from './formats.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] || join(ROOT, 'tiles'));
const format = process.argv[3] ? Number(process.argv[3]) : readFormat('map');
const input = join(ROOT, 'build', tilesAsset(format));
const manifest = versioned('tiles.json', format);

const bytes = readFileSync(input);
const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const name = `guelph-${hash}.pmtiles`;

// The OSM data date, from the archive's JSON metadata (PMTiles v3 header).
function dataDate() {
  try {
    const offset = Number(bytes.readBigUInt64LE(24));
    const length = Number(bytes.readBigUInt64LE(32));
    let json = bytes.subarray(offset, offset + length);
    if (bytes[97] === 2) json = gunzipSync(json);
    const meta = JSON.parse(json);
    return (meta['planetiler:osm:osmosisreplicationtime'] || '').slice(0, 10) || null;
  } catch {
    return null;
  }
}

// The file the site serves now (scripts/get-live-tiles.sh), kept under the name
// the site gave it so pages still streaming it don't lose their tiles. tiles.json
// doesn't mention it, so nothing new starts on it, and the next deploy drops it.
let previous = null;
try {
  const dir = join(ROOT, 'build', 'previous');
  const oldName = readdirSync(dir).find((f) => /^guelph-[0-9a-f]+\.pmtiles$/.test(f));
  if (oldName && oldName !== name) previous = { name: oldName, bytes: readFileSync(join(dir, oldName)) };
} catch {}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, name), bytes);
if (previous) {
  writeFileSync(join(outDir, previous.name), previous.bytes);
  console.log(`Kept the previous ${previous.name} for pages still streaming it`);
}
const info = { url: name, bytes: bytes.length, date: dataDate() };
writeFileSync(join(outDir, manifest), JSON.stringify(info) + '\n');
// Drop map files no manifest names any more (another format's stays), except the
// previous file kept above.
const named = new Set(readdirSync(outDir).filter((f) => /^tiles(\.v\d+)?\.json$/.test(f))
  .map((f) => { try { return JSON.parse(readFileSync(join(outDir, f), 'utf8')).url; } catch { return null; } }));
if (previous) named.add(previous.name);
for (const f of readdirSync(outDir)) if (/^guelph-.*\.pmtiles$/.test(f) && !named.has(f)) rmSync(join(outDir, f));
console.log(`Published ${name} as map format ${format} (${manifest}, ${(bytes.length / 1048576).toFixed(2)} MB, data ${info.date}) to ${outDir}`);
