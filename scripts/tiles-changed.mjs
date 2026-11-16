#!/usr/bin/env node
// Says whether two PMTiles files hold different tiles. Every build embeds the
// OpenStreetMap date in its metadata, so its hash (and file name) is new each
// time even when nothing in Guelph changed; this compares only the
// directories and the tile data, so a week with no visible change publishes
// nothing.
//
//   node scripts/tiles-changed.mjs old.pmtiles new.pmtiles   → prints "changed" or "same"
//
// A missing or unreadable old file counts as changed.

import { readFileSync } from 'node:fs';

function parts(path) {
  const b = readFileSync(path);
  if (b.toString('latin1', 0, 7) !== 'PMTiles' || b[7] !== 3) throw new Error(`${path}: not PMTiles v3`);
  const slice = (at) => {
    const offset = Number(b.readBigUInt64LE(at));
    const length = Number(b.readBigUInt64LE(at + 8));
    return b.subarray(offset, offset + length);
  };
  // Header offsets: 8 root directory, 40 leaf directories, 56 tile data.
  return [slice(8), slice(40), slice(56)];
}

const [oldPath, newPath] = process.argv.slice(2);
if (!newPath) {
  console.error('usage: tiles-changed.mjs old.pmtiles new.pmtiles');
  process.exit(2);
}
const fresh = parts(newPath);
let old;
try {
  old = parts(oldPath);
} catch {
  console.log('changed');
  process.exit(0);
}
console.log(fresh.every((p, i) => p.equals(old[i])) ? 'same' : 'changed');
