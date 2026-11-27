#!/usr/bin/env node
// Downloads bicycle parking and signed cycling routes in Guelph, Ontario from
// OpenStreetMap (via the Overpass API) plus the city boundary (via Nominatim),
// and writes the trimmed GeoJSON files used by the map.
//
//   node scripts/fetch-data.mjs [output-dir]
//
// Data © OpenStreetMap contributors, available under the ODbL.

import { copyFile, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_FILES, readFormat, versioned } from './formats.mjs';

const OUT_DIR = process.argv[2] || 'data';
// File names carry the pin format from 2 up (scripts/formats.mjs), so an older app
// never reads data it can't understand.
const FORMAT = readFormat('data');
const out = (name) => join(OUT_DIR, versioned(name, FORMAT));
const DATA_NAMES = /^(bike-parking|guelph-boundary|cycle-routes)(\.v\d+)?\.geojson$/;
const USER_AGENT = 'guelph-bike-parking (https://github.com/guelph-maps/guelph-bike-parking)';

// OSM relation for the City of Guelph boundary.
const BOUNDARY_URL = 'https://nominatim.openstreetmap.org/lookup?osm_ids=R7486148' +
  '&format=geojson&polygon_geojson=1&polygon_threshold=0.0001';

// south, west, north, east — covers the City of Guelph limits.
const BBOX = [43.475, -80.335, 43.605, -80.140];

// Routes are clipped to the base map's extent (west, south, east north in
// scripts/tiles: -80.40, 43.44, -80.08, 43.64), so long trails stay small.
const MAP_BBOX = [43.44, -80.40, 43.64, -80.08];

// overpass-api.de answers 502 at once when its queue is full, while the two servers
// behind it often still work, so they get asked directly. Under load even a trivial
// query waits 30 s or more there. The other two either answer quickly or hang, so
// they get less time, leaving more rounds for the servers most likely to answer.
const ENDPOINTS = [
  { url: 'https://overpass-api.de/api/interpreter', ms: 190_000 },
  { url: 'https://lz4.overpass-api.de/api/interpreter', ms: 190_000 },
  { url: 'https://z.overpass-api.de/api/interpreter', ms: 190_000 },
  { url: 'https://overpass.kumi.systems/api/interpreter', ms: 45_000 },
  { url: 'https://overpass.private.coffee/api/interpreter', ms: 45_000 },
];

// Keep going round the servers until this runs out.
const BUDGET_MS = 600_000;

const QUERY = `[out:json][timeout:180];
nwr["amenity"="bicycle_parking"](${BBOX.join(',')});
out center tags;`;

// Tags copied through to the map, renamed where it makes the client simpler.
const KEEP = {
  name: 'name',
  description: 'description',
  operator: 'operator',
  access: 'access',
  covered: 'covered',
  indoor: 'indoor',
  fee: 'fee',
  lit: 'lit',
  surveillance: 'surveillance',
  colour: 'colour',
  cargo_bike: 'cargo_bike',
  'capacity:cargo_bike': 'capacity_cargo',
  website: 'website',
  'addr:housenumber': 'housenumber',
  'addr:street': 'street',
  'operator:type': 'operator_type',
  opening_hours: 'opening_hours',
  mapillary: 'mapillary',
  panoramax: 'panoramax',
  check_date: 'check_date',
  'survey:date': 'survey_date',
};

const ROUTES_QUERY = `[out:json][timeout:180];
relation["route"="bicycle"](${BBOX.join(',')});
out geom(${MAP_BBOX.join(',')});`;

async function fetchOverpass(query = QUERY) {
  const deadline = Date.now() + BUDGET_MS;
  let lastError;
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    for (const { url, ms } of ENDPOINTS) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(Math.min(ms, left)),
        });
        if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
        const json = await res.json();
        if (!Array.isArray(json.elements)) throw new Error(`${url} → unexpected response`);
        // A query that dies partway still answers 200, with what it had so far.
        if (json.remark) throw new Error(`${url} → ${json.remark}`);
        if (!json.elements.length) throw new Error(`${url} → no results`);
        console.log(`Overpass answered in ${Math.round((Date.now() - started) / 1000)} s (${url}, attempt ${attempt})`);
        return json;
      } catch (err) {
        lastError = err;
        console.warn(`Overpass request failed after ${Math.round((Date.now() - started) / 1000)} s (${url}, attempt ${attempt}): ${err.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
  throw lastError;
}

function parseCapacity(value) {
  if (value == null) return null;
  const n = parseInt(String(value).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toFeature(el) {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;

  const tags = el.tags || {};
  const props = {
    osm: `${el.type}/${el.id}`,
    type: tags.bicycle_parking || 'unknown',
    capacity: parseCapacity(tags.capacity),
  };
  for (const [tag, key] of Object.entries(KEEP)) {
    if (tags[tag] != null && tags[tag] !== '') props[key] = tags[tag];
  }
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [+lon.toFixed(7), +lat.toFixed(7)] },
    properties: props,
  };
}

async function fetchBoundary() {
  try {
    const res = await fetch(BOUNDARY_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const geometry = json.features?.[0]?.geometry;
    if (!geometry || !/Polygon$/.test(geometry.type)) throw new Error('no polygon in response');
    return geometry;
  } catch (err) {
    // Possibly the previous format's, on the run that bumps it; written below
    // under the new name.
    const found = await existing('guelph-boundary');
    const saved = found && await readFile(join(OUT_DIR, found.file), 'utf8').catch(() => null);
    if (saved) {
      console.warn(`City boundary unavailable, using the existing file: ${err.message}`);
      return JSON.parse(saved).features[0].geometry;
    }
    console.warn(`City boundary unavailable, keeping everything in the bounding box: ${err.message}`);
    return null;
  }
}

// Ray casting; `rings` is a GeoJSON polygon (outer ring + holes).
function inPolygon([x, y], rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function inBoundary(point, geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((rings) => inPolygon(point, rings));
}

// Each route becomes one MultiLineString of its member ways, clipped to the map.
function toRoute(rel) {
  const tags = rel.tags || {};
  const lines = (rel.members || [])
    .filter((m) => m.type === 'way' && Array.isArray(m.geometry))
    .flatMap((m) => splitAtGaps(m.geometry))
    .filter((line) => line.length >= 2);
  if (!lines.length) return null;
  const props = { osm: `relation/${rel.id}`, network: tags.network || 'lcn' };
  for (const key of ['name', 'ref', 'colour', 'operator', 'website']) if (tags[key]) props[key] = tags[key];
  return { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: lines }, properties: props };
}

// Clipped geometry marks points outside the clip box as null; split there.
function splitAtGaps(points) {
  const out = [[]];
  for (const p of points) {
    if (p && p.lat != null) out[out.length - 1].push([+p.lon.toFixed(6), +p.lat.toFixed(6)]);
    else if (out[out.length - 1].length) out.push([]);
  }
  return out;
}

// One feature per line: still compact, but a refresh's diff shows each rack or
// route that changed instead of one rewritten line.
function geojsonText({ features, ...rest }) {
  return JSON.stringify(rest).slice(0, -1) + ',"features":[\n' +
    features.map((f) => JSON.stringify(f)).join(',\n') + '\n]}\n';
}

async function writeRoutes() {
  try {
    const json = await fetchOverpass(ROUTES_QUERY);
    const features = json.elements.map(toRoute).filter(Boolean)
      .sort((a, b) => a.properties.osm.localeCompare(b.properties.osm));
    if (!features.length) throw new Error('no routes with geometry in the response');
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(out('cycle-routes.geojson'), geojsonText({
      type: 'FeatureCollection',
      metadata: { source: 'OpenStreetMap contributors', license: 'ODbL-1.0', osm_base: json.osm3s?.timestamp_osm_base ?? null },
      features,
    }));
    console.log(`Wrote ${features.length} cycling routes to ${OUT_DIR}/`);
  } catch (err) {
    console.warn(`Cycling routes unavailable, keeping the existing file: ${err.message}`);
    await carryOver('cycle-routes');
  }
}

// On the run that bumps the format, "the existing file" has the old format's name,
// and the cleanup below would delete it, leaving no routes file at all: the service
// worker precaches every data file, so the new app couldn't install. The newest
// older file moves to the new name instead, to be replaced on the next good run.
async function carryOver(name) {
  const found = await existing(name);
  if (found?.format === FORMAT) return;
  const target = out(`${name}.geojson`);
  if (!found) {
    console.warn(`::warning title=No ${name} file::There is no ${name} file in any format; the app won't install until one is fetched.`);
    return;
  }
  await copyFile(join(OUT_DIR, found.file), target);
  console.warn(`::warning title=Old ${name} kept::Copied ${found.file} (pin format ${found.format}) to ${target}; fetch again before releasing format ${FORMAT}.`);
}

// The saved file of that name in the current format, else in the newest older one:
// { file, format }, or null.
async function existing(name) {
  const pattern = new RegExp(`^${name}(?:\\.v(\\d+))?\\.geojson$`);
  return (await readdir(OUT_DIR).catch(() => []))
    .map((file) => { const m = pattern.exec(file); return { file, format: m ? Number(m[1] || 1) : 0 }; })
    .filter(({ format }) => format && format <= FORMAT)
    .sort((a, b) => b.format - a.format)[0] || null;
}

const [data, boundary] = await Promise.all([fetchOverpass(), fetchBoundary(), writeRoutes()]);
const features = data.elements
  .map(toFeature)
  .filter(Boolean)
  .filter((f) => !boundary || inBoundary(f.geometry.coordinates, boundary))
  .sort((a, b) => a.properties.osm.localeCompare(b.properties.osm));

const geojson = {
  type: 'FeatureCollection',
  metadata: {
    source: 'OpenStreetMap contributors',
    license: 'ODbL-1.0',
    osm_base: data.osm3s?.timestamp_osm_base ?? null,
    generated: new Date().toISOString(),
    bbox: BBOX,
  },
  features,
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(out('bike-parking.geojson'), geojsonText(geojson));
// Which app this data is for: the deploy refuses a mismatch (scripts/build-site.sh).
await copyFile(new URL('../DATA_FORMAT', import.meta.url), join(OUT_DIR, 'FORMAT'));
if (boundary) {
  const boundaryGeojson = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: boundary, properties: { name: 'City of Guelph' } }],
  };
  await writeFile(out('guelph-boundary.geojson'), geojsonText(boundaryGeojson));
}
// After a format bump, the files under the old format's names go: the deploy
// publishes old-format data from the last data release of that format.
const current = new Set(DATA_FILES.map((n) => versioned(n, FORMAT)));
for (const f of await readdir(OUT_DIR)) {
  if (DATA_NAMES.test(f) && !current.has(f)) await rm(join(OUT_DIR, f));
}

const spaces = features.reduce((sum, f) => sum + (f.properties.capacity || 0), 0);
console.log(`Wrote ${features.length} locations (${spaces} known spaces) to ${OUT_DIR}/`);
