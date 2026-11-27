#!/usr/bin/env node
// Data formats: which pins (DATA_FORMAT) and which base map (MAP_FORMAT) an app can
// read. A change that would break an older app bumps one of them, and everything of
// that kind is then published under names carrying the format, so an app never
// reads data it can't understand, even while a phone still runs an older copy:
//
//   format 1 (as before)          format 2 and up
//   data/bike-parking.geojson     data/bike-parking.v2.geojson
//   tiles/tiles.json              tiles/tiles.v2.json
//   guelph.pmtiles (release file) guelph.v2.pmtiles
//
// Until OVERLAP_DAYS after the first app release of a new format, deploys also
// publish the newest data of the previous format under its names, for phones that
// haven't picked up the new app yet. js/formats.js is the app's copy of the two numbers; `check` keeps them equal.
//
//   node scripts/formats.mjs check                 the copies agree, the data files exist (CI)
//   node scripts/formats.mjs name <path> <kind> [format]  a path under that (or the working tree's) format
//   node scripts/formats.mjs format <kind> [ref]   the format number (of the app at ref)
//   node scripts/formats.mjs asset [format]        the release file name of the base map
//   node scripts/formats.mjs overlap <app-ref> <kind> [today]
//        prints the previous format if it is still to be published, else nothing

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OVERLAP_DAYS = 60;
export const FILES = { data: 'DATA_FORMAT', map: 'MAP_FORMAT' };
// The pin format's files in data/, each precached by sw.js.
export const DATA_FILES = ['bike-parking.geojson', 'guelph-boundary.geojson', 'cycle-routes.geojson'];

// Same rule as js/formats.js: format 1 keeps the plain name.
export function versioned(path, format) {
  return format <= 1 ? path : path.replace(/(\.[A-Za-z]+)$/, `.v${format}$1`);
}

// An app from before MAP_FORMAT existed reads map format 1.
export function readFormat(kind, ref) {
  let text;
  try {
    text = ref
      ? execFileSync('git', ['show', `${ref}:${FILES[kind]}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      : readFileSync(join(ROOT, FILES[kind]), 'utf8');
  } catch (err) {
    if (kind === 'map') return 1;
    throw err;
  }
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1) throw new Error(`${FILES[kind]} must hold a whole number from 1 up, not '${text.trim()}'`);
  return n;
}

export const tilesAsset = (format) => versioned('guelph.pmtiles', format);

// The previous format, while it's still to be published: for OVERLAP_DAYS from the
// day the new format was first released, so older apps get the full time however
// long the bump waited on main. That's the first v* tag, in version order, whose
// format file holds the new number. Before any release has it (beta) it's always
// published.
export function overlap(appRef, kind, today = new Date().toISOString().slice(0, 10)) {
  const format = readFormat(kind, appRef);
  if (format <= 1) return null;
  const tag = firstRelease(kind, format);
  if (!tag) return format - 1;
  const age = (Date.parse(today) - Date.parse(releaseDay(tag))) / 86400000;
  return age <= OVERLAP_DAYS ? format - 1 : null;
}

function firstRelease(kind, format) {
  const tags = git(['tag', '--list', 'v[0-9]*', '--sort=v:refname']).split('\n').filter(Boolean);
  const holds = (tag) => { try { return readFormat(kind, tag) === format; } catch { return false; } };
  return tags.find(holds) || null;
}

// The day its GitHub release was published, where gh can say (deploys have GH_TOKEN),
// else the tag's own date: a release made on GitHub has a lightweight tag, dated by
// its commit, which can be earlier. Either way only the date reaches stdout.
function releaseDay(tag) {
  try {
    const repo = process.env.GITHUB_REPOSITORY ? ['--repo', process.env.GITHUB_REPOSITORY] : [];
    const published = execFileSync('gh', ['release', 'view', tag, ...repo, '--json', 'publishedAt', '--jq', '.publishedAt // empty'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).trim();
    if (published) return published.slice(0, 10);
  } catch {}
  return git(['for-each-ref', '--format=%(creatordate:short)', `refs/tags/${tag}`]).trim();
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function check() {
  const problems = [];
  const app = readFileSync(join(ROOT, 'js', 'formats.js'), 'utf8');
  const formats = {};
  for (const kind of Object.keys(FILES)) {
    formats[kind] = readFormat(kind);
    const m = new RegExp(`${kind}:\\s*(\\d+)`).exec(app);
    if (!m || Number(m[1]) !== formats[kind]) problems.push(`js/formats.js says ${kind}: ${m ? m[1] : '?'}, ${FILES[kind]} says ${formats[kind]}`);
  }
  // Data written by fetch-data.mjs carries its format.
  const dataFormat = Number(readFileSync(join(ROOT, 'data', 'FORMAT'), 'utf8').trim());
  if (dataFormat !== formats.data) problems.push(`data/FORMAT is ${dataFormat} but DATA_FORMAT is ${formats.data}: run scripts/fetch-data.mjs`);
  // sw.js precaches each of them, so without one the app doesn't install.
  for (const name of DATA_FILES) {
    const path = `data/${versioned(name, formats.data)}`;
    if (!existsSync(join(ROOT, path))) problems.push(`${path} is missing: run scripts/fetch-data.mjs`);
  }
  // index.html names the pin files directly (preload, the no-script link).
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data\/([\w-]+)(\.v\d+)?\.geojson/g)) {
    const want = versioned(`data/${m[1]}.geojson`, formats.data);
    if (m[0] !== want) problems.push(`index.html names ${m[0]}, the app reads ${want}`);
  }
  for (const p of problems) console.error(`::error title=Data formats disagree::${p}`);
  if (problems.length) process.exit(1);
  console.log(`formats agree: data ${formats.data}, map ${formats.map}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'check') check();
  else if (cmd === 'format') console.log(readFormat(a, b));
  else if (cmd === 'name') console.log(versioned(a, c ? Number(c) : readFormat(b)));
  else if (cmd === 'asset') console.log(tilesAsset(a ? Number(a) : readFormat('map')));
  else if (cmd === 'overlap') { const f = overlap(a, b, c); if (f) console.log(f); }
  else { console.error('usage: formats.mjs check | format <kind> [ref] | name <path> <kind> [format] | asset [format] | overlap <app-ref> <kind> [today]'); process.exit(2); }
}
