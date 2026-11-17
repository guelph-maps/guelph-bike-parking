# Checks and benchmarks for the base map pipeline

Run from the repository root. The browser ones expect `node scripts/tiles/own/tools/serve.mjs . 8765`
(a static server with range requests) and Microsoft Edge for Playwright.

- `calibrate.mjs file.pmtiles`: decode → re-encode gives the same bytes.
- `test-slice.mjs file.pmtiles`: GBT decode/encode is exact; cutting tiles stays within the margin.
- `verify.mjs`: line length and polygon area per level and layer, before and after trim.
- `bench.mjs /path/a.pmtiles /path/b.pmtiles@15@w`: base-map-only draw time, phone, CPU 4× slower
  (`@15` cuts tiles to level 15, `@w` makes them in the workers). `bench.html` is its page.
- `perf.mjs /path/a.pmtiles …`: whole-app timing: opening, first draw at 17, zoom steps.
- `pixdiff.mjs /path/a.pmtiles /path/b.pmtiles`: screenshots of six views, pixels differing from the first.
