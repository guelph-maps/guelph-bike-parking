#!/usr/bin/env bash
# Downloads the base map a site is serving right now into build/previous/, under the
# name its tiles.json gives, so the next deploy can keep it next to the new one
# (scripts/publish-tiles.mjs). Pages already streaming it ask for that exact name.
# A page that's streaming tiles holds on to the file it started with; if that file
# vanished on deploy, the rest of its tiles would 404 until a reload. Each deploy
# keeps only the live file and the new one, so an old file stays until the next
# new map, about a week with the weekly build.
#
# After a map format bump the site serves one file per format, each named by its own
# manifest (tiles.json, tiles.v2.json, ...; scripts/formats.mjs), and each is kept.
#
#   scripts/get-live-tiles.sh https://beta.guelph.bike
#
# Anything that goes wrong only means no previous file: a warning, not a failure.
set -uo pipefail

site=${1%/}
rm -rf build/previous
mkdir -p build/previous

current=$(node scripts/formats.mjs format map 2>/dev/null || echo 1)

# keep <manifest> <warn>: saves the file that manifest names. Only the current
# format's manifest warns when it's missing; an older one may simply have ended.
keep() {
  local manifest=$1 warn=$2 info url bytes file got
  info=$(curl -sSfL --max-time 30 "$site/tiles/$manifest") || {
    [ "$warn" = yes ] && echo "::warning title=No live base map::Couldn't read $site/tiles/$manifest; deploying without the previous file."
    return 0
  }
  read -r url bytes < <(node -e '
    const i = JSON.parse(process.argv[1]);
    if (/^guelph-[0-9a-f]+\.pmtiles$/.test(i.url)) console.log(i.url, i.bytes || 0);
  ' "$info")
  if [ -z "${url:-}" ]; then
    echo "::warning title=No live base map::$site/tiles/$manifest names no tile file."
    return 0
  fi

  # No --compressed: Pages gzips .pmtiles, and the copy must be the plain bytes.
  file="build/previous/$url"
  if ! curl -sSfL --max-time 120 -o "$file" "$site/tiles/$url"; then
    echo "::warning title=No live base map::Couldn't download $site/tiles/$url."
    rm -f "$file"
    return 0
  fi
  got=$(wc -c < "$file")
  if [ "$bytes" != 0 ] && [ "$got" != "$bytes" ]; then
    echo "::warning title=No live base map::$url is $got bytes, $manifest says $bytes."
    rm -f "$file"
    return 0
  fi
  echo "Keeping the live $url ($got bytes, from $manifest) next to the new file"
}

for format in $(seq 1 "$current"); do
  manifest=tiles.json
  [ "$format" -gt 1 ] && manifest="tiles.v$format.json"
  warn=no
  [ "$format" = "$current" ] && warn=yes
  keep "$manifest" "$warn"
done
exit 0
