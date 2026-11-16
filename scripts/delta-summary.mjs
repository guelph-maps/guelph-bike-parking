#!/usr/bin/env node
// Compares two copies of the map data and writes what changed, for the weekly
// data refresh pull request: title.txt and body.md. Writes nothing if the data
// is the same, because the timestamps in its metadata don't count as a change.
//
//   node scripts/delta-summary.mjs <old-dir> <new-dir> <out-dir>

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [oldDir, newDir, outDir] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: delta-summary.mjs <old-dir> <new-dir> <out-dir>');
  process.exit(2);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USER_AGENT = 'guelph-bike-parking (https://github.com/guelph-maps/guelph-bike-parking)';
const OSM = 'https://www.openstreetmap.org';
const MAX_SMALL_CHANGES = 30;
const MILESTONE_STEP = 100;
const MILESTONE_NEAR = 25;

// js/types.js is a browser script, so it's run here with a stand-in window.
const browser = {};
new Function('window', readFileSync(join(ROOT, 'js', 'types.js'), 'utf8'))(browser);
const types = browser.BIKE_PARKING_TYPES;

const read = (dir, name) => {
  const file = join(dir, `${name}.geojson`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { features: [] };
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byOsm = (geojson) => new Map(geojson.features.map((f) => [f.properties.osm, f]));
const spaces = (geojson) => geojson.features.reduce((sum, f) => sum + (f.properties.capacity || 0), 0);
const fmt = (n) => n.toLocaleString('en-CA');
const count = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const link = (text, osm) => `[${text}](${OSM}/${osm})`;

const oldRacks = read(oldDir, 'bike-parking');
const newRacks = read(newDir, 'bike-parking');
const oldById = byOsm(oldRacks);
const newById = byOsm(newRacks);

const added = newRacks.features.filter((f) => !oldById.has(f.properties.osm));
const removed = oldRacks.features.filter((f) => !newById.has(f.properties.osm));
const changed = newRacks.features.filter((f) => {
  const before = oldById.get(f.properties.osm);
  return before && !same(before, f);
});

// "business" and the like say what kind of operator it is, not who.
function rackName(p) {
  const who = p.name || (/^(business|private|public|yes)$/i.test(p.operator || '') ? '' : p.operator);
  return types.resolve(p.type).label + (who ? `, ${who}` : '');
}

function describeChange(before, after) {
  const a = before.properties;
  const b = after.properties;
  const notes = [];
  if (!same(before.geometry, after.geometry)) notes.push('moved');
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'osm' || same(a[key], b[key])) continue;
    if (key === 'covered') {
      if (b.covered === undefined) notes.push('no longer says whether it is covered');
      else notes.push(b.covered === 'no' ? 'now marked as not covered' : 'now marked as covered');
    } else if (key === 'capacity') {
      notes.push(b.capacity === undefined ? 'no longer says how many it holds' : `now holds ${fmt(b.capacity)}` +
        (a.capacity === undefined ? '' : ` (was ${fmt(a.capacity)})`));
    } else if (key === 'type') {
      const label = types.resolve(b.type).label;
      const was = types.resolve(a.type).label;
      notes.push(label === was ? `type changed from \`${a.type}\` to \`${b.type}\`` : `now a ${label} (was ${was})`);
    } else {
      notes.push(`${key} changed from ${a[key] ?? 'nothing'} to ${b[key] ?? 'nothing'}`);
    }
  }
  return notes.join(', ');
}

function routeChanges() {
  const before = byOsm(read(oldDir, 'cycle-routes'));
  const after = byOsm(read(newDir, 'cycle-routes'));
  const name = (f) => {
    const n = f.properties.name || 'Unnamed';
    return /\broute$/i.test(n) ? n : `${n} route`; // not "Signed Bicycle Route route"
  };
  const lines = [];
  for (const [id, f] of after) {
    if (!before.has(id)) lines.push(`${link(name(f), id)}: new.`);
    else if (!same(before.get(id), f)) lines.push(`${link(name(f), id)}: redrawn.`);
  }
  for (const [id, f] of before) if (!after.has(id)) lines.push(`${link(name(f), id)}: removed.`);
  return lines;
}

// Racks stay features until the body is written, which adds their changeset comment.
const smallChanges = [...changed, ...routeChanges()];
if (!same(read(oldDir, 'guelph-boundary').features, read(newDir, 'guelph-boundary').features)) {
  smallChanges.push('The city boundary changed.');
}

if (!added.length && !removed.length && !smallChanges.length) {
  console.log('No changes to the map data.');
  process.exit(0);
}

async function osmApi(path) {
  const res = await fetch(`https://api.openstreetmap.org/api/0.6/${path}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Who last edited each rack and in which changeset, so people can be credited
// and say why. It's a nicety, so if OpenStreetMap doesn't answer the summary
// goes out without names or comments.
async function lastEdits(features) {
  const edits = new Map();
  for (const kind of ['node', 'way', 'relation']) {
    const ids = features.map((f) => f.properties.osm).filter((id) => id.startsWith(`${kind}/`)).map((id) => id.split('/')[1]);
    if (!ids.length) continue;
    try {
      for (const e of (await osmApi(`${kind}s.json?${kind}s=${ids.join(',')}`)).elements) {
        edits.set(`${kind}/${e.id}`, { user: e.user, changeset: e.changeset });
      }
    } catch (err) {
      console.warn(`Couldn't look up who edited these ${kind}s: ${err.message}`);
    }
  }
  return edits;
}

async function changesetComments(ids) {
  const comments = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    try {
      const json = await osmApi(`changesets.json?changesets=${unique.slice(i, i + 100).join(',')}`);
      for (const c of json.changesets) comments.set(c.id, c.tags?.comment || '');
    } catch (err) {
      console.warn(`Couldn't look up changeset comments: ${err.message}`);
    }
  }
  return comments;
}

// A bare @name on GitHub notifies whoever holds that login, and OSM names aren't
// GitHub logins, so an @ inside a name gets a zero-width space after it.
function mapper(name) {
  const text = name.replace(/[|[\]]/g, '\\$&').replace(/@/g, '@\u200b');
  return `[${text}](${OSM}/user/${encodeURIComponent(name)})`;
}

// A changeset comment is free text: kept to one line, with nothing in it that
// would break a table, format the text or notify someone on GitHub.
function quote(text) {
  const line = text.replace(/\s+/g, ' ').trim();
  const short = line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
  return short.replace(/[\\`*_[\]<>|#~]/g, '\\$&').replace(/@/g, '@\u200b');
}

const edits = await lastEdits([...added, ...removed, ...changed]);
const comments = await changesetComments([...edits.values()].map((e) => e.changeset));
const editorOf = (f) => edits.get(f.properties.osm)?.user;
// The comment as plain text; blank when there's none or OpenStreetMap didn't answer.
function commentOf(f) {
  const id = edits.get(f.properties.osm)?.changeset;
  const text = id && comments.get(id);
  return text ? quote(text) : '';
}

const spaceChange = spaces(newRacks) - spaces(oldRacks);
function title() {
  if (removed.length) return `${count(removed.length, 'rack')} removed` + (added.length ? `, ${fmt(added.length)} new` : '');
  if (!added.length) return count(smallChanges.length, 'small change');
  if (!spaceChange) return count(added.length, 'new rack');
  const more = spaceChange > 0 ? 'more' : 'fewer';
  return `${count(added.length, 'new rack')}, ${fmt(Math.abs(spaceChange))} ${more} ${Math.abs(spaceChange) === 1 ? 'space' : 'spaces'}`;
}

// Racks with the same comment sit together, groups in the order they were made
// (oldest changeset first), racks without one last; otherwise by OSM id.
function byComment(features) {
  const changesetOf = (f) => edits.get(f.properties.osm)?.changeset ?? Infinity;
  const first = new Map();
  for (const f of features) {
    const text = commentOf(f);
    if (text) first.set(text, Math.min(first.get(text) ?? Infinity, changesetOf(f)));
  }
  const group = (f) => (commentOf(f) ? first.get(commentOf(f)) : Infinity);
  return [...features].sort((a, b) => group(a) - group(b) || commentOf(a).localeCompare(commentOf(b)));
}

// The ditto, between dashes as Russian typesetting writes it, stands for the
// comment in the row above.
const DITTO = '⸻″⸻';

function rackTable(features, heading, who) {
  let previous = '';
  const rows = byComment(features).map((f) => {
    const p = f.properties;
    const text = commentOf(f);
    const comment = text && text === previous ? DITTO : text;
    previous = text;
    return `| ${link(rackName(p), p.osm)} | ${p.capacity ?? '?'} | ${editorOf(f) ? mapper(editorOf(f)) : ''} | ${comment} |`;
  });
  return [`**${heading}**`, '', `| Rack | Spaces | ${who} | Changeset comment |`, '|---|---:|---|---|', ...rows, ''];
}

// Values people have started using that the map has no pin for.
const knownTypes = new Set(oldRacks.features.map((f) => f.properties.type));
const unpinned = [...added, ...changed].filter((f) => {
  const raw = f.properties.type;
  return raw && raw !== 'other' && !knownTypes.has(raw) && types.resolve(raw).key === 'other';
});

function milestone() {
  const before = oldRacks.features.length;
  const now = newRacks.features.length;
  const passed = Math.floor(now / MILESTONE_STEP) * MILESTONE_STEP;
  if (passed > before) return `Reached ${fmt(passed)} racks.`;
  const next = passed + MILESTONE_STEP;
  return next - now <= MILESTONE_NEAR ? `${count(next - now, 'rack')} to go until ${fmt(next)}.` : null;
}

function since() {
  const date = oldRacks.metadata?.osm_base;
  if (!date) return '';
  return `Since ${new Date(date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' })}: `;
}

const thanks = new Map();
for (const f of [...added, ...changed]) {
  const name = editorOf(f);
  if (name) thanks.set(name, (thanks.get(name) || 0) + 1);
}
const thanked = [...thanks].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => `${mapper(name)} (${n})`);
const thanksLine = thanked.length > 1 ? `${thanked.slice(0, -1).join(', ')} and ${thanked.at(-1)}` : thanked[0];

function smallChangeLine(item) {
  if (typeof item === 'string') return item;
  const comment = commentOf(item);
  return `${link(rackName(item.properties), item.properties.osm)}: ${describeChange(oldById.get(item.properties.osm), item)}.` +
    (comment ? ` — ${comment}` : '');
}

const big = removed.length >= 10 || removed.length >= oldRacks.features.length * 0.05;
const shown = smallChanges.slice(0, MAX_SMALL_CHANGES);
const hidden = smallChanges.length - shown.length;
const next = milestone();

const body = [
  `### ${title()}`,
  '',
  `${since()}${fmt(oldRacks.features.length)} → ${fmt(newRacks.features.length)} racks, ${fmt(spaces(oldRacks))} → ${fmt(spaces(newRacks))} spaces`,
  '',
  ...(big ? [`**Warning: ${count(removed.length, 'rack')} removed. Check these before merging.**`, ''] : []),
  ...(removed.length ? rackTable(removed, 'Removed racks', 'Last edited by') : []),
  ...(added.length ? rackTable(added, 'New racks', 'Mapped by') : []),
  ...(unpinned.length ? [
    '**Worth a look**',
    '',
    ...unpinned.map((f) => `- ${link('This rack', f.properties.osm)} is tagged \`${f.properties.type}\`, which has no pin, so it shows as "Other".`),
    '',
  ] : []),
  ...(shown.length ? ['**Small changes**', '', ...shown.map((item) => `- ${smallChangeLine(item)}`), ...(hidden ? [`- And ${fmt(hidden)} more.`] : []), ''] : []),
  ...(thanksLine ? [`**Thanks to** ${thanksLine}.`, ''] : []),
  ...(next ? [next, ''] : []),
  'Merging updates beta. Publish a data release to put it live.',
  '',
].join('\n');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'title.txt'), `${title()}\n`);
writeFileSync(join(outDir, 'body.md'), body);
console.log(title());
