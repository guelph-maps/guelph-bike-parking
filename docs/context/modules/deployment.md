---
sourcePaths:
  - ".github/workflows/deploy.yml"
  - ".github/workflows/data-refresh.yml"
  - ".github/workflows/tiles.yml"
  - "scripts/build-site.sh"
  - "scripts/delta-summary.mjs"
  - "scripts/get-tiles.sh"
  - "scripts/get-live-tiles.sh"
  - "scripts/tiles-changed.mjs"
  - "scripts/mark-beta.mjs"
  - "scripts/publish-beta.sh"
  - "DATA_FORMAT"
  - "MAP_FORMAT"
  - "js/formats.js"
  - "scripts/formats.mjs"
  - ".github/workflows/formats.yml"
  - "data/FORMAT"
lastRefreshedCommit: 65b96c9ca19f9ba7d0c4086cb913fe54eff66f1b
confidence: high
confidenceReason: "Read the current deploy workflows and release scripts, including passphrase-based beta key handling and release-triggered production selection."
---

# Deployment

## Purpose

The repository keeps the map data in git and uses GitHub Actions to publish a beta build from `main` and a production build only from release-tagged app/data combinations. The deployment pipeline validates missing refs, format compatibility, and the PMTiles base-map asset before it changes a live site, and beta publish now authenticates with a passphrase-protected SSH deploy key.

## Source paths

The module covers the GitHub Pages deployment workflows, the beta/production release logic, the build scripts that assemble the site, and the format guardrails that prevent incompatible app/data releases. Generated site output and vendored assets are excluded.

## Key files and public entry points

- [deploy.yml](../../../.github/workflows/deploy.yml): Beta publishes from `main`; production only runs on `v*` and `data-*` tags; beta push uses `ssh-agent` with `BETA_DEPLOY_KEY` and `BETA_DEPLOY_KEY_PASSPHRASE`. Run by hand from `main` with a `pr` number, it puts that pull request on beta instead (`beta-pr-build`, `beta-pr-publish`), optionally with a base map built from the pull request (`tiles`).
- [data-refresh.yml](../../../.github/workflows/data-refresh.yml): Weekly automation fetches fresh OSM data and opens or updates a PR against `main`.
- [tiles.yml](../../../.github/workflows/tiles.yml): Weekly (Mondays) and manual workflow builds a draft `data-*` release with the new PMTiles asset, replaces older drafts it made (picked by `scripts/old-drafts.jq`, tested in `tests/old-drafts.spec.js`), and updates beta; a scheduled week whose tiles match the last file (`scripts/tiles-changed.mjs`) publishes nothing.
- [build-site.sh](../../../scripts/build-site.sh): Validates app/data refs and `DATA_FORMAT` / `data/FORMAT`, then assembles `_site` from the selected app and data tags.
- [get-tiles.sh](../../../scripts/get-tiles.sh): Downloads the relevant `guelph.pmtiles` release asset for beta or production.
- [get-live-tiles.sh](../../../scripts/get-live-tiles.sh): Downloads the PMTiles file a site serves now (one per map format it serves), so the deploy keeps it beside the new one for pages still streaming it; failures only warn.
- [mark-beta.mjs](../../../scripts/mark-beta.mjs): Marks a built site as beta before pushing it to the beta Pages repository.
- [publish-beta.sh](../../../scripts/publish-beta.sh): Checks the built site has a map manifest (`tiles/tiles.json`, or `tiles.vN.json` after a map format bump), pushes it to the beta Pages repository with the deploy key, and waits for beta.guelph.bike to answer. Both beta paths use it.
- [DATA_FORMAT](../../../DATA_FORMAT): App compatibility contract used by the deployment preflight.
- [data/FORMAT](../../../data/FORMAT): Data compatibility marker used alongside the app format.

## Dependencies

- Internal: [Parking data](../modules/parking-data.md), [Basemap tiles](../modules/basemap-tiles.md), [Offline support](../modules/offline-support.md), and the [Map application](../modules/map-application.md) are all part of the release pipeline.
- External: GitHub Actions, GitHub Pages, GitHub Releases, Node.js 22, Java 21, Planetiler, and the published PMTiles asset.
- Dependents: The pipeline publishes the [Map application](../modules/map-application.md) and the packaged site to both beta and production hosts.

## Data flow / important invariants

- Merges to `main` update the beta site; production changes only happen from release tags.
- A production release needs both an app tag such as `v0.1.0` and a data tag such as `data-2026-11-09`, and the workflow exits early if either is missing.
- On release-triggered production runs, a `v*` tag selects itself as the app; data always defaults to the newest `data-*` tag by name, even when an older data release triggered the run, so publishing an old draft can't roll data back. Workflow inputs override either side for deliberate rollbacks.
- `DATA_FORMAT` and `data/FORMAT` must match exactly. A mismatch aborts the deploy and leaves the site on the last known-good release.
- `MAP_FORMAT` picks the base map file (`guelph.pmtiles` for 1, `guelph.v2.pmtiles` for 2, ...); production refuses an app whose map format has no published file.
- From format 2, pins and the tiles manifest are published under versioned names (`data/bike-parking.v2.geojson`, `tiles/tiles.v2.json`) and the app (`js/formats.js`) only reads its own, so cached older apps never see newer data. For 60 days after a bump, deploys also publish the previous format's newest data under its names (`scripts/formats.mjs overlap`).
- Pull requests that bump a format need the `breaking-data` label and a `Breaking-data: <kind> <old> -> <new>` trailer on the bumping commit (`.github/workflows/formats.yml`).
- Beta requires the tiles manifest for its map format (`tiles/tiles.json`, `tiles/tiles.v2.json`, ...) inside the built site before it pushes to the beta repo, so the deploy fails clearly if the basemap is missing.
- `scripts/get-tiles.sh` downloads the newest matching `guelph.pmtiles` asset for the data tag; production refuses to deploy if none exists.
- Weekly drafts pin the data tag to the build commit, so publishing releases out of order cannot change the parking data selected by later app releases.
- Weekly tile builds are safe for phones because `js/basemap.js` replaces a saved base map once it is 30 days behind, when the site rolls back, or on Android Wi-Fi. Publish weekly drafts only after an app release newer than v0.1.1 is live; older apps re-download the map (about 2.4 MB) on every file change.
- Beta publish exits early when either deploy secret is missing or when `BETA_DEPLOY_KEY` is unencrypted.

## Gotchas and non-obvious behaviour

- GitHub Pages hosts one site per repository, so the beta build is pushed to a separate repository while production remains in the main repository.
- A successful `ssh-add` is not enough for beta deploy success: GitHub still rejects pushes if the public deploy key in `Coehill/guelph-bike-parking-beta` does not match the private key secret or lacks write access.
- The beta deploy is intentionally a preview of `main`, not a production release; it has no special release tag and is not meant to be a stable live environment.
- A pull request on beta lasts until the next push to `main` or the next tile build, which both redeploy `main`. The pull request's code runs only in `beta-pr-build`, which never sees the deploy key; `beta-pr-publish` pushes the uploaded site with the dispatched ref's own `publish-beta.sh`. Pull requests from forks are refused because `beta-pr-build` holds a `contents: write` token (needed to list draft releases).
- With `tiles` set, nothing goes into a data release: the pull request's base map exists only on beta, so `main`'s next beta deploy and production are unaffected.
- Data-only changes remain in git and do not trigger a new app cache name; the service worker version stamp is derived from the app ref, so app releases are the only thing that forces a fresh app download.
- Production uses the newest published `guelph.pmtiles` up to the selected data tag and fails early if there is none. The weekly build never uploads to a published release: scheduled runs warn and skip, and manual runs fail.
- Each deploy keeps the live map file under the name its `tiles.json` gives (`scripts/get-live-tiles.sh` → `build/previous/`), so pages still streaming it keep their tiles.
