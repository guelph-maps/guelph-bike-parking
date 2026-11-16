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
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const OUTPUT = join(BUILD, 'guelph.pmtiles');
const SCHEMA = join(ROOT, 'scripts', 'tiles', 'schema.yml');

// Tiles cover the city boundary (saved by fetch-data.mjs) grown by this much.
// Every zoom level is a full new set of tiles, so the close-up levels are most of
// the file: a 5 km margin box cost 3.07 MB, the city plus 2 km costs 2.00 MB and
// looks the same around the edge. 1 km leaves blank squares near Guelph Lake.
// The coarsest level (10) still reaches the neighbouring towns: its tiles are
// about 28 km across, so the few that touch the city carry them.
const CITY = join(ROOT, 'data', 'guelph-boundary.geojson');
const MARGIN_METRES = 2000;
const AREA = join(BUILD, 'guelph-area.poly');

function fail(message) {
  console.error(`build-tiles: ${message}`);
  process.exit(1);
}

// Writes the city boundary grown by `metres` as an Osmosis .poly for Planetiler's
// --polygon, which keeps every tile touching any of the file's sections. So the
// boundary, a rectangle along each edge and a circle at each corner together
// make the grown shape, without a geometry library.
function writeAreaPoly(geojsonPath, metres, out) {
  const gj = JSON.parse(readFileSync(geojsonPath, 'utf8'));
  const geoms = (gj.type === 'FeatureCollection' ? gj.features.map((f) => f.geometry)
    : [gj.type === 'Feature' ? gj.geometry : gj]).filter(Boolean);
  const rings = geoms.flatMap((g) => g.type === 'Polygon' ? [g.coordinates[0]]
    : g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : []);
  if (!rings.length) fail(`${geojsonPath} has no polygon`);

  // Local flat metres around the boundary's middle latitude; fine at city scale.
  const pts = rings.flat();
  const lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const mx = 111320 * Math.cos(lat0 * Math.PI / 180), my = 110540;
  const toM = ([x, y]) => [x * mx, y * my];
  const toDeg = ([x, y]) => [x / mx, y / my];

  const sections = [...rings];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = toM(ring[i]), b = toM(ring[i + 1]);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / len * metres, ny = (b[0] - a[0]) / len * metres;
      sections.push([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny],
        [a[0] - nx, a[1] - ny], [a[0] + nx, a[1] + ny]].map(toDeg));
      const circle = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16 * 2 * Math.PI;
        circle.push(toDeg([a[0] + metres * Math.cos(t), a[1] + metres * Math.sin(t)]));
      }
      sections.push(circle);
    }
  }
  const lines = ['guelph-area'];
  sections.forEach((s, i) => {
    lines.push(String(i + 1), ...s.map(([x, y]) => `   ${x.toFixed(7)}   ${y.toFixed(7)}`), 'END');
  });
  lines.push('END', '');
  writeFileSync(out, lines.join('\n'));
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
writeAreaPoly(CITY, MARGIN_METRES, AREA);

const args = [
  ...javaOpts,
  '-jar', jar,
  'generate-custom',
  `--schema=${SCHEMA}`,
  `--osm_path=${input}`,
  `--output=${OUTPUT}`,
  `--polygon=${AREA}`,
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
if (!existsSync(OUTPUT)) fail(`planetiler finished but ${OUTPUT} is missing`);

const mb = (statSync(OUTPUT).size / 1024 / 1024).toFixed(2);
console.log(`build-tiles: wrote ${OUTPUT} (${mb} MB) in ${seconds}s`);
