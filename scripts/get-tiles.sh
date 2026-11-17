#!/usr/bin/env bash
# Downloads the base map from the data releases, where it's kept as a release file
# because it isn't committed. Each map format has its own file name (guelph.pmtiles
# for format 1, guelph.v2.pmtiles for 2, ...; scripts/formats.mjs), saved as
# build/<that name>.
#
#   scripts/get-tiles.sh <data-tag> [format]   the live site: newest published file up to that tag
#   scripts/get-tiles.sh "" [format]           beta: newest file of all, so a draft can be tried out
#
# The format defaults to MAP_FORMAT. A data release without a tile file of that
# format keeps using the one before it.
set -euo pipefail

data_tag=${1:-}
format=${2:-$(node scripts/formats.mjs format map)}
name=$(node scripts/formats.mjs asset "$format")
if [ -n "$data_tag" ]; then
  asset=$(gh api "repos/$GITHUB_REPOSITORY/releases?per_page=100" --jq "
    [.[]
      | select(.tag_name | startswith(\"data-\"))
      | select(.draft == false)
      | select(.tag_name <= \"$data_tag\")
      | select(any(.assets[]; .name == \"$name\"))]
    | sort_by(.created_at) | last | .assets[]? | select(.name == \"$name\") | .id")
else
  asset=$(gh api "repos/$GITHUB_REPOSITORY/releases?per_page=100" --jq "
    [.[]
      | select(.tag_name | startswith(\"data-\"))
      | select(any(.assets[]; .name == \"$name\"))]
    | sort_by(.created_at) | last | .assets[]? | select(.name == \"$name\") | .id")
fi

if [ -z "$asset" ]; then
  # The live site must never lose its base map; beta can do without.
  if [ -n "$data_tag" ]; then
    echo "::error title=No base map::No data release up to $data_tag has $name."
    exit 1
  fi
  echo "::warning title=No base map::No data release has $name yet."
  exit 0
fi

mkdir -p build
gh api -H 'Accept: application/octet-stream' "repos/$GITHUB_REPOSITORY/releases/assets/$asset" > "build/$name"
