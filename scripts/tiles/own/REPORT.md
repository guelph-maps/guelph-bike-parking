# Our own base-map tile pipeline: results (2026-11-16)

Ontario extract of 2026-11-15. Sizes in decimal MB. Unless a row says otherwise, every size is on the
benchmark's footing: tiles touching the city border (hard cut), levels 10–13 (10–14 for the benchmark).

## What's worth shipping

**0.88 MB, down from 1.74 MB for the benchmark (−49%) and 1.10 MB for the best Planetiler-only build (−20%).**
It draws as fast as the benchmark at the edge (Leaflet 14) and faster everywhere else we timed; close up (Leaflet 17–18) it is clearly faster. Screenshots differ from the 1.10 MB build only in label
placement and the dash phase of a few dashed paths.

On this branch's real settings (PR 31's margins per level, no level 10) the file is **1.17 MB**; PR 31's own
build is 2.20 MB. Without level 10, which the map never draws, the hard-cut figure is 0.79 MB.

The pieces, in build order (`scripts/build-tiles.mjs`):

1. **Planetiler stops at level 13** with gentle simplification. These are the 1.10 MB settings, now in the
   schema.
2. **`_minzoom` puts back today's zoom behaviour.** Features that used to start at 14 are stored at level
   13 with a `_minzoom: 14` tag: steps, driveways, parking aisles, sidewalk crossings and labels for parks
   under 3 ha. The browser drops them from level-13 tiles and keeps them in deeper ones, so the
   level-13 build needs none of the style tweaks it used to.
3. **`trim.mjs`** evaluates `js/style.js` and:
   - drops features and attributes nothing draws;
   - merges features the style can't tell apart;
   - cuts each feature's margin beyond the tile edge down to what its drawn width needs;
   - puts levels 11–12 on a 2048 grid.

   It must be re-run when the style changes, and the build does that.
4. **GBT, our own tile layout (`gbt.mjs`, `js/gbt.js`).** It holds the same features in columns (counts,
   tags, x deltas, y deltas), deflated, without feature ids. It is stored in PMTiles, so range streaming and
   the offline copy work as before.
5. **Close-up tiles are cut in the browser.** MapLibre is told the tiles go to level 15, and each deeper
   tile is cut from its stored level-13 ancestor. MapLibre then handles a quarter or a sixteenth of the
   data per close-up tile, so close views draw faster than even the 1.74 MB benchmark.
6. **The tiles are made in MapLibre's workers.** `importScriptInWorkers` loads `js/gbt.js` there. The
   page's thread only hands out stored bytes (`pmtiles-raw://`), so inflating, cutting and re-encoding
   never block it.

### Draw time

Phone viewport (iPhone 13), CPU slowed 4×, median of 7 runs (9 for the edge and houses rows, re-run in reverse order), base map alone (`lab/bench.mjs`). An empty
tile file takes ~470 ms (style, workers, glyphs, shaders), so the tiles' own share is what's left above that.

| view | empty file | benchmark 1.74 | Planetiler-only 1.10 | **own 0.88** |
|---|---|---|---|---|
| phone opening, whole city (Leaflet 12) | 478 | 506 | 510 | **494** |
| north-east edge (Leaflet 14) | 471 | 612 | 625 | **612** |
| downtown (Leaflet 17) | 467 | 596 | 680 | **572** |
| houses (Leaflet 18) | 469 | 563 | 655 | **507** |

Whole app with its markers, phone, 4× (`lab/perf2.mjs`, median of 5):

| | open (Leaflet 12) | first draw at 17 | zoom to 18 |
|---|---|---|---|
| benchmark 1.74 | 1187 ms | 1202 ms | 786 ms |
| Planetiler-only 1.10 | 1102 ms | 1228 ms | 854 ms |
| own 0.88 | 1114 ms | 1145 ms | 721 ms |

Vertices in the file: benchmark 689k, Planetiler-only 472k, own 446k.

## Every idea tried

| idea | size | Δ vs 1.10 | verdict and what it looks like |
|---|---|---|---|
| Decode → re-encode calibration | 1.104 | 0 | byte-identical on 2983 tiles (3 files) |
| GBT columns, ids kept | 0.993 | −10% | lossless; pixel-identical in 6 views |
| GBT, no feature ids | 0.974 | −12% | pixel-identical (the style reads no ids) |
| Schema at 13 + `_minzoom` | 0.976 | −12% | same zoom behaviour as the level-14 schema |
| + trim (prune, merge, buffer, grid 2048 on 11–12) | **0.881** | **−20%** | dash phase on a few paths; else identical |
| … without level 10 (PR 31 never draws it) | 0.790 | −28% | — |
| Cut tiles to level 15 in the browser | ±0 | | houses at 18: the tiles' share of the draw goes from 186 ms (1.10) and 94 ms (benchmark) to 38 ms; only label placement moves |
| … to level 16 | ±0 | | slower downtown (more tiles); kept 15 |
| Make the tiles in workers, not on the page | ±0 | | same pixels; 15–60 ms faster; page thread free |
| Compress tiles in blocks / whole file (deflate) | | −0.5% | dead end: the bytes are coordinate entropy |
| … with brotli, whole file | | −10% | phones can't decode brotli natively; a JS decoder would eat the win |
| Adaptive arithmetic coding of coordinates (ideal) | | −6% of coordinates | dead end for the CPU and the code it costs |
| Second-difference prediction | | +9% | dead end: simplified lines don't curve smoothly |
| Spatially re-sorting buildings | | 0 | already in spatial order |
| Line starts as back-references + chaining | | −1% | 17% of starts reuse a vertex; not worth it |
| Square buildings on the level-13 grid | | −2% | grid rounding has already broken the right angles |
| **Squared buildings from full-precision OSM, custom stream** | | −5% to −7% | **next step**: 312–340 kB vs 389 kB **and 4× more precise** (today p99 1.65 m, max 7.5 m off true footprints; F35 max 0.50 m); not built in JS yet |
| Squared buildings, plain MVT / extent 8192 | | +6% to +16% | dead end in MVT |
| Landuse with shared borders (topology), MVT | | −1.7% to −5% | sealed, no gaps, but at equal bytes coarser than raising Planetiler's tolerance; dead end |
| Landuse arcs stored once (custom format) | | +7% vs MVT | dead end: junctions and arc references eat the 3% saving |
| Clip fills to an 8-unit buffer | | −1.2% | subsumed by trim's buffer step |
| Clip outer tiles to city + smooth margin | | −5.7% (11–13) | not recommended: loses the Guelph Lake side at 14, hairlines on the cut |
| Level 13 buildings at extent 2048 | | −5.7% | not recommended: a 1.7 m grid skews houses at 19 |
| Level 11 at 1024 | | −0.5% | invisible; optional |
| Cross-level sharing (lower levels as refinements of 13) | ≤ −27% est. | | not built: opening at Leaflet 12 would need all of level 13 (0.7 MB before the first map on a first visit) plus ~100+ ms of phone CPU |
| Pre-computed label placement / tessellation | | | not possible without forking MapLibre: its worker only takes MVT/MLT |

## Caveats

- **Trim reads the style.** A saved file only matches the style it was built against. Releases already
  give each tile file a new name, but a style change now needs a tile rebuild.
- **The browser cut depends on `js/gbt.js`.** It only applies to files of tile type 0, which are ours;
  plain MVT files still pass straight through.
- **The cut tiles have their own label placement.** Labels move as they do between any two tilings, and
  one or two park names that collided before now fit.
- **The timings come from desktop Edge with CPU throttling,** not from a real phone. WebKit (Playwright)
  draws GBT both streamed and from the saved copy, and `npm run test:webkit` passes.
- **Fast panning and zooming leave no holes.** After 40 instant jumps between Leaflet 16 and 19, the
  final view has the same geometry as a calm load; only label positions differ.
- **Old app code meeting the new file draws a blank map.** A phone still running a cached `basemap.js`
  would stream GBT payloads as if they were MVT. Before shipping, publish the GBT file under a manifest
  name the old code doesn't read (e.g. `tiles/tiles-gbt.json`), or bump the service worker so new code
  arrives first.
- **Building detail matches the 1.10 MB build, not the 1.74 MB benchmark.** Gentle simplification moves
  building corners: p99 1.65 m, max 7.5 m from true footprints. That is the price of the 1.10 settings,
  and the squared-building stream (next step) would more than win it back.

## Where the code is

`scripts/tiles/own/`:

- `mvt.mjs`: MVT codec
- `gbt.mjs`: GBT encoder
- `to-gbt.mjs`: converts a file and checks the round trip
- `trim.mjs`, `style-eval.mjs`, `verify.mjs`: the trim step
- `calibrate.mjs`: the decode → re-encode check

The decoder, cutter and protocol handlers are in `js/gbt.js`. `lab/` holds the experiments, benchmarks and
the agents' landuse and building work (`lab/topo`, `lab/bld`, with Python for the full-precision buildings).
