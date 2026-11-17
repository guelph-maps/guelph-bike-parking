#!/usr/bin/env bash
# Puts the site together in _site from an app version and a data version. Run from
# the repository root, after scripts/get-tiles.sh.
#
#   scripts/build-site.sh <app-ref> <data-ref> [<released YYYY-MM-DD>]
#
# An app ref that's a release tag (v0.1.0) stamps that version; anything else is a
# development build, stamped with the next patch and its last commit to the app.
# The production workflow passes the day the GitHub release was published; without
# it the date comes from git.
set -euo pipefail

app_ref=$1
data_ref=$2
built=${3:-}
if [ -n "$built" ] && ! [[ "$built" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "::error title=Bad release date::Expected YYYY-MM-DD, got '$built'."
  exit 1
fi
app="index.html embed.html favicon.svg manifest.webmanifest sw.js icons vendor css js"

# Fail fast with clear messages when requested refs or format files are missing.
if ! git rev-parse --verify --quiet "$app_ref^{commit}" >/dev/null; then
  echo "::error title=Missing app ref::Can't find app ref '$app_ref'."
  exit 1
fi
if ! git rev-parse --verify --quiet "$data_ref^{commit}" >/dev/null; then
  echo "::error title=Missing data ref::Can't find data ref '$data_ref'."
  exit 1
fi
if ! git cat-file -e "$app_ref:DATA_FORMAT" 2>/dev/null; then
  echo "::error title=Missing app format::'$app_ref' doesn't contain DATA_FORMAT."
  exit 1
fi
if ! git cat-file -e "$data_ref:data/FORMAT" 2>/dev/null; then
  echo "::error title=Missing data format::'$data_ref' doesn't contain data/FORMAT."
  exit 1
fi

# Data released for a newer app can't be published on an older one, or the other
# way round. A failed check leaves the site as it is.
app_format=$(git show "$app_ref:DATA_FORMAT")
data_format=$(git show "$data_ref:data/FORMAT")
if [ "$app_format" != "$data_format" ]; then
  echo "::error title=Data format mismatch::$app_ref reads format $app_format, but $data_ref is format $data_format."
  exit 1
fi

if [[ "$app_ref" =~ ^v[0-9] ]]; then
  stamp=${app_ref#v}
  # On a tag-triggered run, checkout can swap an annotated tag for a lightweight
  # one, whose date is the commit's; hence the published date above, when given.
  [ -n "$built" ] || built=$(git for-each-ref --format='%(creatordate:short)' "refs/tags/$app_ref")
else
  # A new cache name per release, so phones pick up the new app files. Only commits
  # to the app count: a data refresh must leave sw.js byte-identical, or every phone
  # downloads the app again and is told there's a new version.
  last=$(git tag --list 'v*' --sort=-v:refname | head -1)
  next=$(echo "${last#v}" | awk -F. 'NF == 3 { print $1 "." $2 "." $3 + 1 }')
  stamp="${next:-next}-dev.$(git log -1 --format=%h --abbrev=7 "$app_ref" -- $app)"
  [ -n "$built" ] || built=$(git log -1 --format=%cs "$app_ref" -- $app)
fi
# A ref that isn't a tag (a branch named v-something) falls back to its commit.
[ -n "$built" ] || built=$(git log -1 --format=%cs "$app_ref")

rm -rf _site
mkdir _site
git archive "$app_ref" $app | tar -x -C _site
git archive "$data_ref" data | tar -x -C _site
rm _site/data/FORMAT
sed -i "s/__BUILD__/$stamp/; s/__BUILT__/$built/" _site/sw.js

# The base map in the format this app reads (scripts/get-tiles.sh fetched it).
# Without tiles the map falls back to OpenStreetMap's street map.
map_format=$(node scripts/formats.mjs format map "$app_ref")
map_file=build/$(node scripts/formats.mjs asset "$map_format")
if [ -f "$map_file" ]; then node scripts/publish-tiles.mjs _site/tiles "$map_format"; fi

# For a while after a format bump (scripts/formats.mjs), phones still running the
# previous app keep getting data they can read, under the old format's names.
old_data=$(node scripts/formats.mjs overlap "$app_ref" data)
if [ -n "$old_data" ]; then
  old_ref=""
  for tag in $(git tag --list 'data-*' --sort=-v:refname); do
    if [ "$(git show "$tag:data/FORMAT" 2>/dev/null)" = "$old_data" ]; then old_ref=$tag; break; fi
  done
  if [ -n "$old_ref" ]; then
    git archive "$old_ref" data | tar -x -C _site --wildcards 'data/*.geojson'
    echo "Also published pins in format $old_data from $old_ref, for older apps"
  else
    echo "::warning title=No old-format pins::No data release has pin format $old_data; older apps will find no pins."
  fi
fi
old_map=$(node scripts/formats.mjs overlap "$app_ref" map)
if [ -n "$old_map" ]; then
  if [ -f "build/$(node scripts/formats.mjs asset "$old_map")" ]; then
    node scripts/publish-tiles.mjs _site/tiles "$old_map"
  else
    echo "::warning title=No old-format map::No base map in format $old_map was fetched; older apps fall back to the street map."
  fi
fi
touch _site/.nojekyll
echo "Built $stamp with the data from $data_ref"
