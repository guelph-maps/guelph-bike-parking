#!/usr/bin/env node
// Builds the cycling base map tiles for Guelph (build/guelph.pmtiles) from an
// OpenStreetMap extract with Planetiler and the custom schema in scripts/tiles/.
//
//   node scripts/build-tiles.mjs [input.osm.pbf] [-- extra planetiler args]
//
// Input: the first argument, else the file named in $OSM_DATA_DIR/ontario/latest.json
// (OSM_DATA_DIR defaults to ~/Code/.osm-data). Nothing is ever downloaded.
// Java:  $JAVA_HOME/bin/java, else `java` on PATH (Java 21+).
// Jar:   $PLANETILER_JAR, else build/planetiler.jar.
// JVM options: $PLANETILER_JAVA_OPTS (default -Xmx3g).
//
// Data © OpenStreetMap contributors, available under the ODbL.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cullPmtiles, outerRings } from './tiles/cull-pmtiles.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const OUTPUT = join(BUILD, 'guelph.pmtiles');
const SCHEMA = join(ROOT, 'scripts', 'tiles', 'schema.yml');

// Each zoom level covers the city boundary (saved by fetch-data.mjs) grown by
// its own margin. Every level is a full new set of tiles, so the close-up levels
// are most of the file: city + 2 km at level 14 is 1.16 MB, and 1 km would save
// only 0.07 MB while showing blank squares at the edge on a laptop. Zoomed out,
// a view spans far more ground, so the coarse levels reach further: with these
// margins a phone sees no blank square from any zoom centred on the city or its
// edge. Level 10 supports zooming out to 11.5 (minZoom in js/map.js), so narrow
// phones and small embeds can fit the whole city. The file is about 2.38 MB; one 2 km
// margin for levels 10-14 was 2.00 MB but left a blank corner zoomed out, and the
// old 5 km box was 3.07 MB. Level 11 at 6 km saves 0.06 MB but blanks phone edges.
const CITY = join(ROOT, 'data', 'guelph-boundary.geojson');
const MARGIN_KM = { 10: 8, 11: 8, 12: 6, 13: 4, 14: 2 };
const UNCUT = join(BUILD, 'guelph-uncut.pmtiles');

function fail(message) {
  console.error(`build-tiles: ${message}`);
  process.exit(1);
}

// The box around the city grown by the largest margin, for Planetiler's --bounds:
// it builds every level over this box and cullPmtiles trims each level after.
function buildBounds(geojsonPath, km) {
  const pts = outerRings(JSON.parse(readFileSync(geojsonPath, 'utf8'))).flat();
  if (!pts.length) fail(`${geojsonPath} has no polygon`);
  const lat0 = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
  const dx = km * 1000 / (111320 * Math.cos(lat0 * Math.PI / 180)), dy = km * 1000 / 110540;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs) - dx, Math.min(...ys) - dy, Math.max(...xs) + dx, Math.max(...ys) + dy]
    .map((v) => v.toFixed(4));
}

function resolveInput(arg) {
  if (arg) return resolve(arg);
  const dataDir = process.env.OSM_DATA_DIR || join(homedir(), 'Code', '.osm-data');
  const latest = join(dataDir, 'ontario', 'latest.json');
  if (!existsSync(latest)) fail(`no input given and ${latest} not found`);
  const { file } = JSON.parse(readFileSync(latest, 'utf8'));
  if (!file) fail(`${latest} has no "file" field`);
  return join(dataDir, 'ontario', file);
}

const dashdash = process.argv.indexOf('--');
const ownArgs = process.argv.slice(2, dashdash === -1 ? undefined : dashdash);
const extraArgs = dashdash === -1 ? [] : process.argv.slice(dashdash + 1);

const input = resolveInput(ownArgs[0]);
if (!existsSync(input)) fail(`input not found: ${input}`);

const jar = resolve(process.env.PLANETILER_JAR || join(BUILD, 'planetiler.jar'));
if (!existsSync(jar)) {
  fail(`Planetiler jar not found: ${jar}\n` +
    'Set PLANETILER_JAR, or download it to build/planetiler.jar from\n' +
    'https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar');
}

const java = process.env.JAVA_HOME
  ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : 'java';
const javaOpts = (process.env.PLANETILER_JAVA_OPTS || '-Xmx3g').split(/\s+/).filter(Boolean);

const tmpDir = join(BUILD, 'tmp');
mkdirSync(BUILD, { recursive: true });
if (!existsSync(CITY)) fail(`city boundary not found: ${CITY}`);
const bounds = buildBounds(CITY, Math.max(...Object.values(MARGIN_KM)));

const args = [
  ...javaOpts,
  '-jar', jar,
  'generate-custom',
  `--schema=${SCHEMA}`,
  `--osm_path=${input}`,
  `--output=${UNCUT}`,
  `--bounds=${bounds.join(',')}`,
  // Keep temp files and any downloads out of the repo's data/ folder.
  `--tmpdir=${tmpDir}`,
  `--download_dir=${join(BUILD, 'sources')}`,
  '--download=false',
  '--force',
  ...extraArgs,
];

console.log(`build-tiles: ${input} -> ${OUTPUT}`);
const started = Date.now();
const run = spawnSync(java, args, { stdio: 'inherit', cwd: ROOT });
const seconds = ((Date.now() - started) / 1000).toFixed(1);
rmSync(tmpDir, { recursive: true, force: true });

if (run.error) fail(`could not start ${java}: ${run.error.message}`);
if (run.status !== 0) fail(`planetiler exited with ${run.status ?? run.signal} after ${seconds}s`);
if (!existsSync(UNCUT)) fail(`planetiler finished but ${UNCUT} is missing`);

const margins = Object.fromEntries(Object.entries(MARGIN_KM).map(([z, km]) => [z, km * 1000]));
const kept = cullPmtiles(UNCUT, OUTPUT, JSON.parse(readFileSync(CITY, 'utf8')), margins);
rmSync(UNCUT, { force: true });
for (const [z, s] of Object.entries(kept)) {
  console.log(`build-tiles: level ${z}: city + ${MARGIN_KM[z]} km, ${s.tiles} tiles, ${(s.bytes / 1e6).toFixed(2)} MB`);
}

const mb = (statSync(OUTPUT).size / 1e6).toFixed(2);
console.log(`build-tiles: wrote ${OUTPUT} (${mb} MB) in ${seconds}s`);
