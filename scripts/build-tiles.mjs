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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const OUTPUT = join(BUILD, 'guelph.pmtiles');
const SCHEMA = join(ROOT, 'scripts', 'tiles', 'schema.yml');

// west, south, east, north: Guelph city limits plus a margin.
const BOUNDS = [-80.40, 43.44, -80.08, 43.64];

function fail(message) {
  console.error(`build-tiles: ${message}`);
  process.exit(1);
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

const args = [
  ...javaOpts,
  '-jar', jar,
  'generate-custom',
  `--schema=${SCHEMA}`,
  `--osm_path=${input}`,
  `--output=${OUTPUT}`,
  `--bounds=${BOUNDS.join(',')}`,
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
