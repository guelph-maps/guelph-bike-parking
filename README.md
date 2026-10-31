# Guelph Bike Parking Map

A full-screen, mobile-friendly map of bicycle parking in Guelph, Ontario. Each location
shows an icon for the type of rack (stands, wheel bender, shelter, lockers, …), a badge
with the number of bike spaces, and a little roof when it's covered. Nearby locations
are grouped into circles that add up their spaces. The map can be embedded in other
websites, such as GCAT's, with an `<iframe>`.

Live at **https://guelph-maps.github.io/guelph-bike-parking/**

- **Map:** `index.html`: address search, filter by rack type or covered, city boundary,
  optional cycling-route overlay, "my location", full-screen button, About panel
- **Embed code generator:** `embed.html`
- **Data:** generated into `data/` from [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL)

## Embedding

Open `embed.html` on the published site to choose options and copy the code. The
basic version:

```html
<iframe src="https://guelph-maps.github.io/guelph-bike-parking/"
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
| `types` | Only these types, comma-separated: `stands`, `rack`, `bollard`, `wall_loops`, `ground_slots`, `shed`, `lockers`, `building`, `two-tier`, `other`, `unknown` |
| `covered=1` | Only covered or indoor parking |
| `cluster=0` | Show every location instead of grouping |
| `legend` | `open`, `closed` or `0` (hidden) |
| `basemap=cycle` | Start with the CyclOSM cycling base map |
| `routes=1` | Show signed cycling routes (Waymarked Trails) on top |
| `search=0` | Hide the address search box |
| `embed` | `1` forces the compact layout, `0` turns it off inside an iframe |

## Data

The map reads static GeoJSON files, so it loads fast and doesn't depend on the
Overpass API being up while people use it. `scripts/fetch-data.mjs` downloads bike
parking from the Overpass API and the city boundary from Nominatim, keeps only parking
inside city limits, and writes `data/bike-parking.geojson` and
`data/guelph-boundary.geojson`. The deploy workflow runs it on every deploy and every
Monday, so the published map stays current; `data/` isn't committed.

Address search uses [Photon](https://photon.komoot.io) (OpenStreetMap data) and also
matches parking names.

The best way to fix wrong or missing parking is to edit OpenStreetMap: every popup
has a "Details / fix" link. The tags the map uses:

- `amenity=bicycle_parking`
- `bicycle_parking=*` → icon (`stands`, `rack`, `wall_loops`, `bollard`, `shed`, `lockers`, …)
- `capacity=*` → number on the badge (`?` when missing)
- `covered`, `indoor`, `fee`, `access`, `lit`, `operator`, `name`, `mapillary`

Many Guelph locations have no `capacity` yet. Adding it in OSM makes the map more useful.

## Running locally

Download the data once, then use any static file server:

```sh
node scripts/fetch-data.mjs
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` straight from disk won't work, because browsers block loading
the data file from `file://`.

## Deploying

`.github/workflows/deploy.yml` publishes the site to GitHub Pages on every push to
the default branch, every Monday, and on demand (Actions → Deploy map to GitHub Pages → Run workflow).
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Leaflet 1.9.4 and Leaflet.markercluster 1.5.3 load from unpkg, pinned with
subresource integrity hashes.

## Credits

- Map data © OpenStreetMap contributors, ODbL
- Base map tiles: OpenStreetMap and [CyclOSM](https://www.cyclosm.org); cycling routes: [Waymarked Trails](https://cycling.waymarkedtrails.org)
- Search: [Photon](https://photon.komoot.io) by Komoot
- [Leaflet](https://leafletjs.com) (BSD-2-Clause), [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) (MIT)
