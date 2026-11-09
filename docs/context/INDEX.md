# Codebase Context

Guelph Bike Parking is a mobile-friendly, offline-capable bicycle parking map for Guelph, Ontario. The site uses vanilla HTML, CSS, and browser JavaScript with Leaflet, MapLibre GL, and PMTiles; Node.js scripts generate OpenStreetMap GeoJSON and vector tiles, while a service worker and GitHub Actions deploys support offline use and a release-gated beta/production site. The repository has no package manifest: browser libraries are vendored, and the scripts use Node.js built-ins.

## Key commands

- Run locally: `npx http-server -c-1 .`
- Refresh parking data: `node scripts/fetch-data.mjs data`
- Build tiles: `PLANETILER_JAR=path/to/planetiler.jar node scripts/build-tiles.mjs [ontario.osm.pbf]`
- Publish tiles: `node scripts/publish-tiles.mjs`
- Release guardrail: every published `data-*` release must include `guelph.pmtiles`; otherwise `scripts/get-tiles.sh` fails in the production workflow before Pages deploys.
- Verify tile schema: `java -jar path/to/planetiler.jar verify scripts/tiles/schema.yml`
- Manual deploy: `gh workflow run deploy.yml --ref main`

## Modules

| Module | Source paths | Context file | Purpose |
| --- | --- | --- | --- |
| Map application | `index.html`, `js/{basemap,style,types,map}.js`, `css/map.css`, `icons/`, `manifest.webmanifest`, `favicon.svg` | [map-application](modules/map-application.md) | Renders and operates the standalone parking map. |
| Embed generator | `embed.html`, `js/embed.js` | [embed-generator](modules/embed-generator.md) | Builds configurable iframe previews and embed code. |
| Parking data | `scripts/fetch-data.mjs`, `data/FORMAT` | [parking-data](modules/parking-data.md) | Fetches and transforms parking, boundary, and route data, while keeping the source dataset in git. |
| Basemap tiles | `scripts/build-tiles.mjs`, `scripts/publish-tiles.mjs`, `scripts/tiles/` | [basemap-tiles](modules/basemap-tiles.md) | Builds and publishes the PMTiles cycling basemap. |
| Offline support | `sw.js` | [offline-support](modules/offline-support.md) | Caches app files, data, and visited street-map tiles. |
| Deployment | `.github/workflows/*.yml`, `scripts/build-site.sh`, `scripts/delta-summary.mjs`, `scripts/get-tiles.sh`, `scripts/mark-beta.mjs`, `DATA_FORMAT`, `data/FORMAT` | [deployment](modules/deployment.md) | Publishes beta from `main`, production from release tags, and validates app/data compatibility. |

Last refreshed at commit: a8b2eba04cd7bb3eb2bf5cc1c7fcb5f19652f88f
