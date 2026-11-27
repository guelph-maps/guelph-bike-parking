# The base map pipeline

## Why

Phones download the whole bike base map and keep it for offline use, so its file size is
what every visitor pays, and every phone redraws it on every pan and zoom. Planetiler's own
settings were exhausted at 1.10 MB: stronger simplification visibly damaged the map. This
pipeline goes past Planetiler with steps it can't do, to get a smaller file that is also
cheaper to draw, with no visible loss where people look.

Measured on 2026-11-16 (Ontario extract of 2026-11-15), tiles touching the city border:

| | file | close-up draw (Leaflet 18) |
|---|---|---|
| Planetiler, top level 14 (before) | 1.74 MB | 563 ms |
| Planetiler alone, best settings | 1.10 MB | 655 ms |
| **this pipeline** | **0.88 MB** | **507 ms** |

With the per-level margins the site actually uses, the file is 1.17 MB (was 2.20 MB).

## How it works

```
OpenStreetMap ──Planetiler──▶ MVT, levels 11–13 ──trim──▶ MVT ──GBT──▶ guelph.v2.pmtiles
                                                                            │
 phone: MapLibre ◀── MVT, levels 11–15 ◀── js/gbt.js in MapLibre's workers ◀─┘
```

1. **Planetiler stops at level 13** (`scripts/tiles/schema.yml`). A level-13 tile, stretched,
   still places a point within about 0.9 m, enough for houses at the closest zoom.
2. **Close-up features keep their zoom.** Steps, driveways, parking aisles, sidewalk crossings
   and labels of small parks used to start at level 14. They are stored at 13 with a
   `_minzoom: 14` tag; the browser leaves them out of level-13 tiles, so the map shows them
   from the same zoom as before and the style is unchanged. Only features that would have
   started at 14 get the tag (a street that also carries `service=driveway` doesn't), and
   the build fails if a tile below level 13 holds one, since the browser would hide it there.
3. **Trim** (`scripts/tiles/own/trim.mjs`) reads `js/style.js` and:
   - drops every feature and attribute that no style layer draws;
   - merges features the style can't tell apart;
   - cuts each feature's overlap beyond the tile edge to what its drawn width needs;
   - puts levels 11–12 on a coarser grid.

   Because it reads the style, tiles must be rebuilt after a style change.
4. **Our own tile layout, GBT** (`scripts/tiles/own/gbt.mjs`). It holds the same features,
   stored as separate columns of numbers, each tile gzipped by the PMTiles file as
   Planetiler's tiles were, without the feature ids the style never reads. The file is still PMTiles, so streaming before it's saved, and the saved
   offline copy, work as before.
5. **The phone makes the vector tiles** (`js/gbt.js`). MapLibre's workers turn GBT back into
   ordinary vector tiles, off the page's thread. MapLibre is told the tiles go to level 15,
   and each deeper tile is cut from its stored level-13 ancestor. Close-up views then work on
   a quarter or a sixteenth of the data, which is why they draw faster than before even
   though the file is smaller.
6. **Map format 2.** Apps from before this pipeline can't read GBT, so the file is published
   as map format 2 (`guelph.v2.pmtiles`, `tiles/tiles.v2.json`). Old apps keep the last
   format-1 map for 60 days (README, "Breaking data changes").

## Technical details

### Files

| File | What it does |
|---|---|
| `scripts/build-tiles.mjs` | Planetiler, per-level margins, trim, GBT, in that order |
| `scripts/tiles/own/mvt.mjs` | MVT decoder/encoder; decode → encode gives Planetiler's exact bytes |
| `scripts/tiles/cull-pmtiles.mjs` | PMTiles reading, culling and writing |
| `scripts/tiles/own/trim.mjs`, `style-eval.mjs` | the trim step and its evaluation of `js/style.js` |
| `scripts/tiles/own/gbt.mjs`, `to-gbt.mjs` | GBT encoder; checks every tile decodes back to the same features |
| `js/gbt.js` | GBT → MVT, tile cutting, `_minzoom`, the MapLibre protocol handlers (page and workers) |
| `scripts/tiles/own/tools/` | the checks and benchmarks behind the numbers here |

### The GBT payload

One byte `0x48` (format version 1), then:
- the layer count, and per layer its name, extent, version, key and value tables (raw MVT
  values), feature count and an "ids kept" flag;
- the byte length of each of eight streams;
- the streams themselves, each holding all layers in order: ids, geometry types, tag counts,
  tags, part counts, point counts, x deltas, y deltas.

Coordinates are zigzag varint deltas that run on across features within a layer. Polygon rings
carry no closing point, as in MVT. The PMTiles header says tile type 0 ("unknown"), so nothing
mistakes a payload for MVT, and `js/gbt.js` only cuts tiles in files of that type.

Each payload is gzipped by the container (tile compression 2, as in Planetiler's MVT files),
not inside the payload. The pmtiles library then unzips it the way it unzipped format-1 tiles:
with `DecompressionStream('gzip')`, or its bundled inflate on phones without one (iOS before
16.4). Version 0 (`0x47`) deflated inside the payload and inflated it with
`DecompressionStream('deflate-raw')`, which Chrome before 103 lacks, so those phones would have
shown a blank map. Gzip adds 18 bytes a tile, 1.3 kB for the whole file.

### How the browser handles requests

- `pmtiles://guelph`: the TileJSON request, answered on the page. For a GBT file the tile URL
  carries the stored top level (`pmtiles://guelph@13/{z}/{x}/{y}`) and `maxzoom` becomes 15.
- `pmtiles://guelph@13/z/x/y`: answered in a worker.
  - At z ≤ 13 the stored tile (unzipped by pmtiles on the page) is re-encoded as MVT.
  - Deeper, the decoded ancestor is cut: clipped to the tile plus a 64-unit margin and scaled
    up, so nothing is rounded except new points on the cut edges.
  - Each worker keeps its last 8 decoded ancestors. An ancestor fetch isn't cancelled along
    with the tile that first asked for it.
- `pmtiles-raw://guelph/z/x/y`: the stored bytes, served by the page from the streamed or
  saved file.

### Draw time

Phone viewport (iPhone 13), CPU slowed 4×, base map alone, median of 7–9 runs
(`tools/bench.mjs`). An empty file takes ~470 ms (style, workers, glyphs, shaders).

| view | before 1.74 MB | Planetiler-only 1.10 MB | this 0.88 MB |
|---|---|---|---|
| opening, whole city (Leaflet 12) | 506 | 510 | 494 |
| edge (Leaflet 14) | 612 | 625 | 612 |
| downtown (Leaflet 17) | 596 | 680 | 572 |
| houses (Leaflet 18) | 563 | 655 | 507 |

Whole app with markers (`tools/perf.mjs`): opening 1114 ms (before: 1187), first draw at
Leaflet 17 1145 ms (1202), zooming to 18 721 ms (786).

### What changes on screen

- Against the 1.10 MB Planetiler-only build, only two things differ: label placement (cut
  tiles place labels as any tiling does) and the dash phase of a few dashed paths.
- Building corners match that build. Against true footprints they are off by up to 7.5 m
  (99% within 1.65 m), against less for the old 1.74 MB file.

Checked:
- screenshots of the whole city, the edges, downtown and houses;
- WebKit, both streamed and from the saved copy;
- 40 instant pan/zoom jumps, which leave no holes.

### Ideas measured and dropped

| idea | result |
|---|---|
| Compressing tiles together, or the whole file | deflate −0.5%; brotli −10%, but phones can't decode brotli natively |
| Arithmetic coding of coordinates | −6% of the coordinate bytes at best; not worth the code and CPU |
| Predicting the next point from the last two | 9% bigger: simplified lines don't curve smoothly |
| Re-sorting buildings, line starts as back-references | 0% and −1% |
| Landuse with shared borders (topology) | no gaps, but at equal bytes coarser than Planetiler's own tolerance |
| Squaring buildings in plain MVT | bigger |
| Clipping the outer tiles to the city shape | loses the Guelph Lake side at zoom 14 |
| Level-13 buildings on a 2048 grid | a 1.7 m grid would skew houses up close |
| Lower levels stored as refinements of level 13 | could save up to ~0.27 MB, but opening the map would first need all of level 13 |
| Pre-computed label placement | MapLibre's workers only accept vector tiles |

**Next step worth doing.** Store buildings as squared shapes (start, angle, edge lengths) from
full-precision OSM in a stream of their own. That measured 312–340 kB instead of 389 kB, and
about 4× more precise (corners within 0.5 m).

The experiments, the agents' landuse and building work, and their scripts are on the
`tiles-own-pipeline-lab` branch, under `scripts/tiles/own/lab/`.
