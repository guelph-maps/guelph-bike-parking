#!/usr/bin/env bash
# Downloads the base map a site is serving right now into build/previous/, under the
# name its tiles.json gives, so the next deploy can keep it next to the new one
# (scripts/publish-tiles.mjs). Pages already streaming it ask for that exact name.
# A page that's streaming tiles holds on to the file it started with; if that file
# vanished on deploy, the rest of its tiles would 404 until a reload. Each deploy
# keeps only the live file and the new one, so an old file stays until the next
# new map, about a week with the weekly build.
#
#   scripts/get-live-tiles.sh https://beta.guelph.bike
#
# Anything that goes wrong only means no previous file: a warning, not a failure.
set -uo pipefail

site=${1%/}
rm -rf build/previous
mkdir -p build/previous

info=$(curl -sSfL --max-time 30 "$site/tiles/tiles.json") || {
  echo "::warning title=No live base map::Couldn't read $site/tiles/tiles.json; deploying without the previous file."
  exit 0
}
read -r url bytes < <(node -e '
  const i = JSON.parse(process.argv[1]);
  if (/^guelph-[0-9a-f]+\.pmtiles$/.test(i.url)) console.log(i.url, i.bytes || 0);
' "$info")
if [ -z "${url:-}" ]; then
  echo "::warning title=No live base map::$site/tiles/tiles.json names no tile file."
  exit 0
fi

# No --compressed: Pages gzips .pmtiles, and the copy must be the plain bytes.
file="build/previous/$url"
if ! curl -sSfL --max-time 120 -o "$file" "$site/tiles/$url"; then
  echo "::warning title=No live base map::Couldn't download $site/tiles/$url."
  rm -f "$file"
  exit 0
fi
got=$(wc -c < "$file")
if [ "$bytes" != 0 ] && [ "$got" != "$bytes" ]; then
  echo "::warning title=No live base map::$url is $got bytes, tiles.json says $bytes."
  rm -f "$file"
  exit 0
fi
echo "Keeping the live $url ($got bytes) next to the new file"
