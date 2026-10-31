#!/usr/bin/env node
// Copies build/guelph.pmtiles into a site folder under a name that changes
// whenever its content does, and writes tiles.json next to it for
// js/basemap.js: { "url", "bytes", "date" }. Phones keep the whole file, so a
// new name is how they learn there's a newer map.
//
//   node scripts/publish-tiles.mjs [out-dir]     (default: tiles/)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = join(ROOT, 'build', 'guelph.pmtiles');
const outDir = resolve(process.argv[2] || join(ROOT, 'tiles'));

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

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (/^guelph-.*\.pmtiles$/.test(f) && f !== name) rmSync(join(outDir, f));
writeFileSync(join(outDir, name), bytes);
const info = { url: name, bytes: bytes.length, date: dataDate() };
writeFileSync(join(outDir, 'tiles.json'), JSON.stringify(info) + '\n');
console.log(`Published ${name} (${(bytes.length / 1048576).toFixed(2)} MB, data ${info.date}) to ${outDir}`);
