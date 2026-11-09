---
sourcePaths:
  - ".github/workflows/deploy.yml"
  - ".github/workflows/data-refresh.yml"
  - ".github/workflows/tiles.yml"
  - "scripts/build-site.sh"
  - "scripts/delta-summary.mjs"
  - "scripts/get-tiles.sh"
  - "scripts/mark-beta.mjs"
  - "DATA_FORMAT"
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

- [deploy.yml](../../../.github/workflows/deploy.yml): Beta publishes from `main`; production only runs on `v*` and `data-*` tags; beta push uses `ssh-agent` with `BETA_DEPLOY_KEY` and `BETA_DEPLOY_KEY_PASSPHRASE`.
- [data-refresh.yml](../../../.github/workflows/data-refresh.yml): Weekly automation fetches fresh OSM data and opens or updates a PR against `main`.
- [tiles.yml](../../../.github/workflows/tiles.yml): Manual workflow builds a draft `data-*` release and pushes the new PMTiles asset into the beta path.
- [build-site.sh](../../../scripts/build-site.sh): Validates app/data refs and `DATA_FORMAT` / `data/FORMAT`, then assembles `_site` from the selected app and data tags.
- [get-tiles.sh](../../../scripts/get-tiles.sh): Downloads the relevant `guelph.pmtiles` release asset for beta or production.
- [mark-beta.mjs](../../../scripts/mark-beta.mjs): Marks a built site as beta before pushing it to the beta Pages repository.
- [DATA_FORMAT](../../../DATA_FORMAT): App compatibility contract used by the deployment preflight.
- [data/FORMAT](../../../data/FORMAT): Data compatibility marker used alongside the app format.

## Dependencies

- Internal: [Parking data](../modules/parking-data.md), [Basemap tiles](../modules/basemap-tiles.md), [Offline support](../modules/offline-support.md), and the [Map application](../modules/map-application.md) are all part of the release pipeline.
- External: GitHub Actions, GitHub Pages, GitHub Releases, Node.js 22, Java 21, Planetiler, and the published PMTiles asset.
- Dependents: The pipeline publishes the [Map application](../modules/map-application.md) and the packaged site to both beta and production hosts.

## Data flow / important invariants

- Merges to `main` update the beta site; production changes only happen from release tags.
- A production release needs both an app tag such as `v0.1.0` and a data tag such as `data-2026-11-09`, and the workflow exits early if either is missing.
- On release-triggered production runs, the triggering tag is selected by default for its side (`v*` sets app, `data-*` sets data), while the other side falls back to the latest matching tag unless overridden by workflow inputs.
- `DATA_FORMAT` and `data/FORMAT` must match exactly. A mismatch aborts the deploy and leaves the site on the last known-good release.
- Beta requires `tiles/tiles.json` inside the built site before it pushes to the beta repo, so the deploy fails clearly if the basemap is missing.
- `scripts/get-tiles.sh` downloads the newest matching `guelph.pmtiles` asset for the data tag; production refuses to deploy if none exists.
- Beta publish exits early when either deploy secret is missing or when `BETA_DEPLOY_KEY` is unencrypted.

## Gotchas and non-obvious behaviour

- GitHub Pages hosts one site per repository, so the beta build is pushed to a separate repository while production remains in the main repository.
- A successful `ssh-add` is not enough for beta deploy success: GitHub still rejects pushes if the public deploy key in `Coehill/guelph-bike-parking-beta` does not match the private key secret or lacks write access.
- The beta deploy is intentionally a preview of `main`, not a production release; it has no special release tag and is not meant to be a stable live environment.
- Data-only changes remain in git and do not trigger a new app cache name; the service worker version stamp is derived from the app ref, so app releases are the only thing that forces a fresh app download.
- Production fails early if the selected `data-*` release lacks `guelph.pmtiles` in its asset list. The release pipeline expects a non-draft `data-*` tag with that asset, so any new base-map release must upload the file before publishing the tag.
- Duplicate same-day `data-*` tags are a release-time trap: if a stale draft and a published release share the same tag name, the workflow can resolve the wrong one. In that case, upload the asset to the published release and remove the stale draft so future deploys stay deterministic.
