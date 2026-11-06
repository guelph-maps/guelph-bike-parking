#!/usr/bin/env bash
# Downloads the base map into build/guelph.pmtiles from the data releases, where it's
# kept as a release file because it isn't committed.
#
#   scripts/get-tiles.sh <data-tag>   the live site: newest published file up to that tag
#   scripts/get-tiles.sh              beta: newest file of all, so a draft can be tried out
#
# A data release without a tile file keeps using the one before it.
set -euo pipefail

data_tag=${1:-}
filter='.tag_name | startswith("data-")'
if [ -n "$data_tag" ]; then filter="$filter and (.draft | not) and .tag_name <= \"$data_tag\""; fi

asset=$(gh api "repos/$GITHUB_REPOSITORY/releases?per_page=100" --jq "
  [.[] | select($filter) | select(any(.assets[]; .name == \"guelph.pmtiles\"))]
  | sort_by(.tag_name) | last | .assets[]? | select(.name == \"guelph.pmtiles\") | .id")

if [ -z "$asset" ]; then
  # The live site must never lose its base map; beta can do without.
  if [ -n "$data_tag" ]; then
    echo "::error title=No base map::No data release up to $data_tag has guelph.pmtiles."
    exit 1
  fi
  echo "::warning title=No base map::No data release has guelph.pmtiles yet."
  exit 0
fi

mkdir -p build
gh api -H 'Accept: application/octet-stream' "repos/$GITHUB_REPOSITORY/releases/assets/$asset" > build/guelph.pmtiles
