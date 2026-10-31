#!/usr/bin/env node
// Downloads bicycle parking in Guelph, Ontario from OpenStreetMap (via the
// Overpass API) and writes a trimmed GeoJSON file used by the map.
//
//   node scripts/fetch-data.mjs [output-path]
//
// Data © OpenStreetMap contributors, available under the ODbL.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'data/bike-parking.geojson';

// south, west, north, east — covers the City of Guelph limits.
const BBOX = [43.475, -80.335, 43.605, -80.140];

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const QUERY = `[out:json][timeout:90];
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
  mapillary: 'mapillary',
  panoramax: 'panoramax',
  check_date: 'check_date',
  'survey:date': 'survey_date',
};

async function fetchOverpass() {
  let lastError;
  for (const url of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'guelph-bike-parking (https://github.com/guelph-maps/guelph-bike-parking)',
          },
          body: new URLSearchParams({ data: QUERY }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
        const json = await res.json();
        if (!Array.isArray(json.elements)) throw new Error(`${url} → unexpected response`);
        return json;
      } catch (err) {
        lastError = err;
        console.warn(`Overpass request failed (${url}, attempt ${attempt}): ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
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

const data = await fetchOverpass();
const features = data.elements
  .map(toFeature)
  .filter(Boolean)
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

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(geojson, null, 1) + '\n');

const spaces = features.reduce((sum, f) => sum + (f.properties.capacity || 0), 0);
console.log(`Wrote ${features.length} locations (${spaces} known spaces) to ${OUT}`);
