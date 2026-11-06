#!/usr/bin/env bash
# Puts the site together in _site from an app version and a data version. Run from
# the repository root, after scripts/get-tiles.sh.
#
#   scripts/build-site.sh <app-ref> <data-ref>
#
# An app ref that's a release tag (v19.0.0) stamps that version; anything else is a
# development build, stamped with the next patch and its last commit to the app.
set -euo pipefail

app_ref=$1
data_ref=$2
app="index.html embed.html favicon.svg manifest.webmanifest sw.js icons vendor css js"

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
else
  # A new cache name per release, so phones pick up the new app files. Only commits
  # to the app count: a data refresh must leave sw.js byte-identical, or every phone
  # downloads the app again and is told there's a new version.
  last=$(git tag --list 'v*' --sort=-v:refname | head -1)
  next=$(echo "${last#v}" | awk -F. 'NF == 3 { print $1 "." $2 "." $3 + 1 }')
  stamp="${next:-next}-dev.$(git log -1 --format=%h --abbrev=7 "$app_ref" -- $app)"
fi

rm -rf _site
mkdir _site
git archive "$app_ref" $app | tar -x -C _site
git archive "$data_ref" data | tar -x -C _site
rm _site/data/FORMAT
sed -i "s/__BUILD__/$stamp/" _site/sw.js
# Without tiles the map falls back to OpenStreetMap's street map.
if [ -f build/guelph.pmtiles ]; then node scripts/publish-tiles.mjs _site/tiles; fi
touch _site/.nojekyll
echo "Built $stamp with the data from $data_ref"
