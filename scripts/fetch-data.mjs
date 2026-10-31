#!/usr/bin/env node
// Downloads bicycle parking in Guelph, Ontario from OpenStreetMap (via the
// Overpass API) plus the city boundary (via Nominatim), and writes the trimmed
// GeoJSON files used by the map.
//
//   node scripts/fetch-data.mjs [output-dir]
//
// Data © OpenStreetMap contributors, available under the ODbL.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT_DIR = process.argv[2] || 'data';
const USER_AGENT = 'guelph-bike-parking (https://github.com/guelph-maps/guelph-bike-parking)';

// OSM relation for the City of Guelph boundary.
const BOUNDARY_URL = 'https://nominatim.openstreetmap.org/lookup?osm_ids=R7486148' +
  '&format=geojson&polygon_geojson=1&polygon_threshold=0.0001';

// south, west, north, east — covers the City of Guelph limits.
const BBOX = [43.475, -80.335, 43.605, -80.140];

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const QUERY = `[out:json][timeout:45];
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

async function fetchOverpass() {
  let lastError;
  // Two rounds over the mirrors; a healthy server answers this query in seconds.
  for (let attempt = 1; attempt <= 2; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: new URLSearchParams({ data: QUERY }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
        const json = await res.json();
        if (!Array.isArray(json.elements)) throw new Error(`${url} → unexpected response`);
        return json;
      } catch (err) {
        lastError = err;
        console.warn(`Overpass request failed (${url}, attempt ${attempt}): ${err.message}`);
        await new Promise((r) => setTimeout(r, 2000));
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

const [data, boundary] = await Promise.all([fetchOverpass(), fetchBoundary()]);
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
await writeFile(join(OUT_DIR, 'bike-parking.geojson'), JSON.stringify(geojson) + '\n');
if (boundary) {
  const boundaryGeojson = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: boundary, properties: { name: 'City of Guelph' } }],
  };
  await writeFile(join(OUT_DIR, 'guelph-boundary.geojson'), JSON.stringify(boundaryGeojson) + '\n');
}

const spaces = features.reduce((sum, f) => sum + (f.properties.capacity || 0), 0);
console.log(`Wrote ${features.length} locations (${spaces} known spaces) to ${OUT_DIR}/`);
