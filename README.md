# Guelph Bike Parking Map

A full-screen, mobile-friendly map of bicycle parking in Guelph, Ontario. Each location
shows an icon for the type of rack (stands, wheel bender, shelter, lockers, …), a badge
with the number of bike spaces, and a little roof when it's covered. Nearby locations
are grouped and their spaces added up: spots of one type show as a stacked pin of that
type, mixed ones in the colours of the types they contain. Private parking
(`access=private`) is left off. The map can be embedded in other websites, such as
GCAT's, with an `<iframe>`. It works with no signal: the whole city's bike map is
saved on the device (about 3 MB).

Live at **https://guelph.bike/**

- **Map:** `index.html`: our own cycling base map, address search, filter by rack type or
  covered, city boundary, optional cycling-route overlay, "my location", full-screen
  button, About panel, ⋮ menu with the version (and a dot when a newer one is ready)
  and "Clear cache & reload"
- **Embed code generator:** `embed.html`
- **Data:** generated into `data/` from [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL)

## Embedding

Open `embed.html` on the published site to choose options and copy the code. The
basic version:

```html
<iframe src="https://guelph.bike/"
        title="Map of bike parking in Guelph"
        width="100%" height="500" style="border:0;max-width:100%;"
        loading="lazy" allow="geolocation; fullscreen" allowfullscreen></iframe>
```

Inside an iframe the map switches to a compact layout on its own: the key starts
collapsed, scroll-wheel zoom waits for a click so it doesn't take over page scrolling,
and a link opens the full map in a new tab. `allow="geolocation; fullscreen"` lets the
"my location" and full-screen buttons work.

URL parameters:

| Parameter | Effect |
| --- | --- |
| `lat`, `lng`, `zoom` | Starting view, e.g. `?lat=43.5446&lng=-80.2489&zoom=16` |
| `types` | Only these types, comma-separated: `stands`, `wave`, `rack`, `bollard`, `wall_loops`, `ground_slots`, `shed`, `lockers`, `building`, `two-tier`, `other`, `unknown` |
| `covered=1` | Only covered or indoor parking |
| `cluster=0` | Show every location instead of grouping |
| `legend` | `open`, `closed` or `0` (hidden) |
| `basemap=street` | Start with OpenStreetMap's street map instead of the bike map (online only) |
| `routes=1` | Show signed cycling routes from OpenStreetMap on top |
| `search=0` | Hide the address search box |
| `embed` | `1` forces the compact layout, `0` turns it off inside an iframe |

## Data

The map reads static GeoJSON files, so it loads fast and doesn't depend on the
Overpass API being up while people use it. `scripts/fetch-data.mjs` downloads bike
parking from the Overpass API and the city boundary from Nominatim, keeps only parking
inside city limits, and writes `data/bike-parking.geojson` and
`data/guelph-boundary.geojson`, plus signed cycling routes (`route=bicycle` relations,
clipped to the map area) in `data/cycle-routes.geojson`. The deploy workflow runs it on every deploy and every
Monday, so the published map stays current. If Overpass is down, the deploy uses the
copy committed in `data/` and the run ends red, so a failed refresh doesn't look like a
fresh map; refresh that copy now and then by running the script and committing the result.

Address search uses [Photon](https://photon.komoot.io) (OpenStreetMap data) and also
matches parking names.

The best way to fix wrong or missing parking is to edit OpenStreetMap: every popup
has a "Details / fix" link. The tags the map uses:

- `amenity=bicycle_parking`
- `bicycle_parking=*` → icon (`stands`, `wave`, `rack`, `wall_loops`, `bollard`, `shed`, `lockers`, …)
- `capacity=*` → number on the badge (`?` when missing)
- `covered`, `indoor`, `fee`, `access`, `lit`, `operator`, `name`, `mapillary`, `panoramax`

The map is only as good as these tags, so if a rack's `capacity` or type is wrong, fix it in OSM.

## Bike base map

The default base map is ours: vector tiles of Guelph and its surroundings in one
[PMTiles](https://docs.protomaps.com/pmtiles/) file, drawn by
[MapLibre GL](https://maplibre.org) underneath Leaflet. All of Guelph at every zoom is
about 3 MB, so the app saves the whole file on the device (`js/basemap.js`) and the map
works with no signal anywhere in the city. It's styled for cycling (`js/style.js`):

- solid blue: cycleways and paths designated for bikes; dashed blue: bikes allowed;
  dashed brown: unpaved
- blue road edges: painted bike lanes (thicker for separated tracks); dashed blue line on
  a road: shared lane
- orange dots: dismount; faint grey: footpaths without bike access
- bike shops, repair stands, drinking water and toilets

The tiles are built with [Planetiler](https://github.com/onthegomap/planetiler) and the
custom schema in `scripts/tiles/schema.yml`, which keeps only what the style draws
(each layer's classes and attributes are described in its comments; test cases in
`schema.spec.yml`). The deploy workflow builds
them once a month from Geofabrik's Ontario extract, caches the result for other deploys,
and keeps last month's file if a build fails. `scripts/publish-tiles.mjs` copies the file
into the site under a content-hashed name and writes `tiles/tiles.json`; phones that have
an older copy download the new one in the background and switch on the next visit.

To build locally (Java 21+ and the
[Planetiler jar](https://github.com/onthegomap/planetiler/releases)):

```sh
PLANETILER_JAR=path/to/planetiler.jar node scripts/build-tiles.mjs [ontario.osm.pbf]
node scripts/publish-tiles.mjs        # → tiles/ for the local server
java -jar path/to/planetiler.jar verify scripts/tiles/schema.yml   # schema tests
```

Without an argument, `build-tiles.mjs` reads the Ontario extract named in
`$OSM_DATA_DIR/ontario/latest.json` (default `~/Code/.osm-data`). It takes about a minute.

## Running locally

Use a static file server that supports HTTP range requests (the map streams tiles from
the PMTiles file before it's saved), for example:

```sh
npx http-server -c-1 .
# open http://localhost:8080
```

Python's `http.server` doesn't support range requests, so the bike map only shows up
there once the whole file has been saved.

Opening `index.html` straight from disk won't work, because browsers block loading
the data file from `file://`.

## Deploying

`.github/workflows/deploy.yml` publishes the site to GitHub Pages on every push to
the default branch, every Monday, and on demand (Actions → Deploy map to GitHub Pages → Run workflow).
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Every library is vendored in `vendor/`, byte-identical to its npm release, so the map
loads nothing from third-party CDNs: Leaflet 1.9.4, Leaflet.markercluster 1.5.3,
MapLibre GL 5.24.0 (the last line with a plain-script build; 6.x is ES modules only),
@maplibre/maplibre-gl-leaflet 0.1.4, PMTiles 4.5.0, and Noto Sans glyphs (Latin and
punctuation ranges) from [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets).

## Offline

Guelph's mobile signal is patchy, so the map is built to work without it. `sw.js` is a
service worker that:

- precaches the app (HTML, CSS, JS, vendored libraries, fonts, icons) per release. The
  deploy workflow stamps the last commit to the app into the cache name, so each release
  replaces the old copy, and a deploy that only refreshes the data isn't a release;
- serves the parking data, city boundary and cycling routes from cache at once and
  refreshes them in the background ("stale-while-revalidate");
- keeps OpenStreetMap street-map tiles as you browse, cache-first, capped at about
  3,000 tiles (~50 MB). OpenStreetMap's tile policy doesn't allow downloading them in bulk.

The bike base map file is saved by the page itself (Cache API), automatically on the
full site, unless the browser asks to save data. Embedded maps stream tiles instead, since
each embedding site would keep its own copy. The About panel shows whether the map is
saved, with buttons to save, update or remove it; saving also asks the browser to keep
the data when storage runs low.

Nothing waits on the network when a saved copy exists, because a weak connection hangs
where no connection fails fast. When the browser reports being offline, the map says
it's showing the saved copy. `manifest.webmanifest` makes the map installable as an app.
On iPhone that matters: Safari clears a site's saved data after about a week without a
visit unless it's added to the home screen.

## Credits

- Map data © OpenStreetMap contributors, ODbL
- Street map tiles: OpenStreetMap
- Search: [Photon](https://photon.komoot.io) by Komoot
- [Leaflet](https://leafletjs.com) (BSD-2-Clause), [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) (MIT),
  [MapLibre GL JS](https://maplibre.org) (BSD-3-Clause), [maplibre-gl-leaflet](https://github.com/maplibre/maplibre-gl-leaflet) (ISC),
  [PMTiles](https://github.com/protomaps/PMTiles) (BSD-3-Clause), [Planetiler](https://github.com/onthegomap/planetiler) (Apache-2.0, build only),
  Noto Sans (SIL Open Font License)
