# Own base-map pipeline — shared brief for experiment agents (2026-11-16)

Project: guelph-bike-parking, a phone-first bike-parking map of Guelph, Ontario. Leaflet + a MapLibre GL
layer (js/map.js, js/style.js, js/basemap.js) reading one vector PMTiles file that phones download whole
and keep offline, so **file size = download size**. Goal of the overall effort: a much smaller base map,
cheaper to draw, with no visible loss where people look.

## Where things are

- Worktree (served by the test web server, branch `tiles-own-pipeline`, DO NOT commit or push — the lead
  agent does git): `C:\Users\kk\Code\guelph-bike-parking-ownpipe`
- Reference files (copies, read-only) in `build/ref/`:
  - `hardcut.pmtiles` 1.74 MB — benchmark: levels 10–14, tiles touching the city border, current schema.
  - `simp-base.cut.pmtiles` 1.21 MB — same cut, top level 13 (Planetiler `--maxzoom=13`).
  - `simp-safe.cut.pmtiles` 1.10 MB — top level 13 + gentle per-layer simplification. **Best Planetiler-only result; beat this.**
  - `simp-safe.pmtiles` / `simp-base.pmtiles` — same builds before the hard cut (wider box).
  - `schema-safe.yml`, `schema-max13.yml`, `schema-base.yml` — the Planetiler schemas for those builds.
- Code you can import (dependency-free, ESM):
  - `scripts/tiles/own/mvt.mjs` — MVT decode/encode. `decodeTile(buf)` → `{layers:[{name,version,extent,keys,values,features:[{id,type,tags,parts}]}]}`,
    parts = Int32Array flat `[x0,y0,x1,y1,…]` absolute tile units; polygon rings without the closing point;
    type 1 point / 2 line / 3 polygon. `encodeTile(tile)` is the exact inverse (verified byte-identical on 2983 tiles).
    `tagsOf(layer, feat)`, `buildLayer(name, extent, features-with-props)`, `valueOf`, `encodeValue` helpers.
  - `scripts/tiles/cull-pmtiles.mjs` — `listTiles(file)` → `{header, tiles: Map "z/x/y" → gzipped bytes}`,
    `readArchive(file)` → `{header, metadata, tiles}`, `writeArchive(out, header, metadata, tilesMap)` (tiles must be gzipped,
    `zlib.gzipSync`), `cullPmtiles(in, out, cityGeojson, {zoom: marginMetres})` (margin 0 = the hard cut).
  - City border: `data/guelph-boundary.geojson`.
- Measurement scripts (originals in `C:\Users\kk\Code\guelph-bike-parking\build\measure\`, copy and adapt, don't edit in place):
  `layers.mjs` (bytes per layer per level), `simp-report.mjs` (size + vertex counts), `perf.mjs` (time-to-idle with 4× CPU
  throttle), `pr31-shots.mjs` (before/after screenshot sheets; env `V` variants JSON, `P` places JSON, `OUT` dir), `serve.mjs`
  (static server with Range: `node serve.mjs <root> <port>`). Their import paths point at another worktree; repoint them to
  `C:/Users/kk/Code/guelph-bike-parking-ownpipe/scripts/tiles/cull-pmtiles.mjs`.
- Experiments so far live in `build/own/exp-*.mjs`.

## Facts already measured (don't redo)

- ~90% of bytes are geometry. Buildings in a tile are one merged multipolygon feature (no attributes).
- In simp-safe.cut (1.10 MB): building 0.39 MB (all level 13), transportation 0.35, landuse 0.29, water+waterway+poi+place 0.07.
  Levels 10–12 together are about a quarter of the bytes; level 10 is mostly countryside (z10 tiles are ~28 km wide).
- Compressing several tiles together barely helps (deflate −0.5 %; brotli whole file −10 %, but phones can't natively
  decode brotli). Per-tile streams split into columns (counts / x / y / tags) save ~12 % in total. Second-difference
  prediction hurts. Building rings are already in spatial order (re-sorting saves nothing).
- MapLibre (vendored v5.24) scales every tile to an internal extent of 8192: an MVT layer `extent` up to 8192 is honoured,
  finer is rounded away. Smaller extents (1024, 2048) are honoured too.
- Leaflet zoom Z draws MapLibre zoom Z−1. Phones open the app at Leaflet zoom 12 → tile level 11. Leaflet 19 → GL 18, which
  stretches level-13 tiles 32×, so one level-13 unit (extent 4096) is 4 css px there (≈0.87 m on the ground; z14 unit ≈0.43 m).
- Planetiler: `JAVA_HOME=C:/Users/kk/Code/.tools/jre/jdk-21.0.13+9-jre`, jar `C:/Users/kk/Code/.tools/planetiler-0.10.2/planetiler.jar`,
  OSM extract `C:/Users/kk/Code/.osm-data/ontario/ontario-2026-11-15.osm.pbf`, ~45 s per build. Example command line in
  `C:\Users\kk\Code\guelph-bike-parking\build\measure\simp-runs4.sh` (use `--bounds=-80.40,43.44,-80.08,43.64`, then the hard cut
  with `cullPmtiles(..., {10:0,11:0,12:0,13:0,14:0})`). Use your OWN `--tmpdir` and output names (others build in parallel).
  Only per-layer `tile_post_process` tolerances work; global `--simplify_tolerance*` does nothing with this schema.

## Rules

- Report sizes in decimal MB (bytes/1e6), always on the same footing as the references: the same hard cut, the same level set
  (10–13 for top-level-13 builds). Report a figure against both 1.74 (benchmark) and 1.10 (Planetiler-only).
- Quality bar: screenshots of the same views against the reference: whole city at Leaflet zoom 12, edges at 14–15, downtown
  (43.5448, -80.2482) and houses at 17–19. Use `chromium.launch({ channel: 'msedge' })`, deviceScaleFactor 2.
  Run your own server on YOUR port (given in your task), rooted at the worktree; tile URLs in `V` are paths like
  `/build/own/<yourdir>/x.pmtiles`. The page is `http://localhost:<port>/?legend=closed#<leafletZoom>/<lat>/<lng>`;
  route `**/tiles/tiles.json` to `{url, bytes:1, date:'2026-11-15'}` as pr31-shots.mjs does.
- Git Bash rewrites arguments that start with `/`: prefix such commands with `MSYS_NO_PATHCONV=1`.
- Put everything you make under `build/own/<yourdir>/` (gitignored). Leave scripts there — the lead will commit what's kept.
- Dead ends are results. Measure, don't guess. Throw away what doesn't pay, but report it.
- Finish with a short report: a table of each variant (size MB, Δ vs 1.10, vertices if relevant, what it looks like), the
  paths of the best output .pmtiles and of screenshot sheets, and your honest recommendation.
