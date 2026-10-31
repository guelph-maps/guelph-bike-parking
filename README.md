# Guelph Bike Parking Map

A mobile-friendly map of bicycle parking in Guelph, Ontario. Each location shows an
icon for the type of rack (stands, wheel bender, shelter, lockers, …) and a badge with
the number of bike spaces. Nearby locations are grouped into circles that add up
their spaces. The map can be embedded in other websites, such as GCAT's, with an `<iframe>`.

- **Map:** `index.html`
- **Embed code generator:** `embed.html`
- **Data:** `data/bike-parking.geojson`, from [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL)

## Embedding

Open `embed.html` on the published site to choose options and copy the code. The
basic version:

```html
<iframe src="https://guelph-maps.github.io/guelph-bike-parking/"
        title="Map of bike parking in Guelph"
        width="100%" height="500" style="border:0;max-width:100%;"
        loading="lazy" allow="geolocation"></iframe>
```

Inside an iframe the map switches to a compact layout on its own: the key starts
collapsed, scroll-wheel zoom waits for a click so it doesn't take over page scrolling,
and a link opens the full map in a new tab. `allow="geolocation"` lets the
"my location" button work.

URL parameters:

| Parameter | Effect |
| --- | --- |
| `lat`, `lng`, `zoom` | Starting view, e.g. `?lat=43.5446&lng=-80.2489&zoom=16` |
| `types` | Only these types, comma-separated: `stands`, `rack`, `bollard`, `wall_loops`, `ground_slots`, `shed`, `lockers`, `building`, `two-tier`, `other`, `unknown` |
| `covered=1` | Only covered or indoor parking |
| `cluster=0` | Show every location instead of grouping |
| `legend` | `open`, `closed` or `0` (hidden) |
| `basemap=cycle` | Start with the CyclOSM cycling base map |
| `embed` | `1` forces the compact layout, `0` turns it off inside an iframe |

## Data

The map reads a static GeoJSON file, so it loads fast and doesn't depend on the
Overpass API being up. To refresh it:

```sh
node scripts/fetch-data.mjs
```

The **Update bike parking data** GitHub Action runs this every Monday, commits any
changes and redeploys the site. The query covers a bounding box around the city
(`BBOX` in `scripts/fetch-data.mjs`).

The best way to fix wrong or missing parking is to edit OpenStreetMap: every popup
has a "Details / fix" link. The tags the map uses:

- `amenity=bicycle_parking`
- `bicycle_parking=*` → icon (`stands`, `rack`, `wall_loops`, `bollard`, `shed`, `lockers`, …)
- `capacity=*` → number on the badge (`?` when missing)
- `covered`, `indoor`, `fee`, `access`, `lit`, `operator`, `name`, `mapillary`

Many Guelph locations have no `capacity` yet. Adding it in OSM makes the map more useful.

## Running locally

Any static file server works, for example:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` straight from disk won't work, because browsers block loading
the data file from `file://`.

## Deploying

`.github/workflows/deploy.yml` publishes the site to GitHub Pages on every push to
`main`. One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Leaflet 1.9.4 and Leaflet.markercluster 1.5.3 are vendored in `vendor/` so the map
doesn't depend on a third-party CDN.

## Credits

- Map data © OpenStreetMap contributors, ODbL
- Base map tiles: OpenStreetMap and [CyclOSM](https://www.cyclosm.org)
- [Leaflet](https://leafletjs.com) (BSD-2-Clause), [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) (MIT)
