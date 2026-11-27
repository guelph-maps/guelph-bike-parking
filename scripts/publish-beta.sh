#!/usr/bin/env bash
# Pushes a built beta site to beta.guelph.bike and waits until the site answers.
# Pages hosts one site per repository, so beta lives in a repository of its own,
# Coehill/guelph-bike-parking-beta, that only ever holds the latest build.
#
#   BETA_DEPLOY_KEY=... BETA_DEPLOY_KEY_PASSPHRASE=... \
#     scripts/publish-beta.sh <site-dir> <commit message>
#
# The key must be passphrase-protected; its public half is a write-enabled deploy
# key on the beta repository.
set -euo pipefail

site=$1
message=$2

# The manifest of the map format the built site reads, from its own js/formats.js
# (tiles.json for 1, tiles.v2.json for 2, ...; scripts/formats.mjs), so a site whose
# format has no base map yet fails here instead of going up without one. This runs
# from the dispatched ref while the site may be a pull request's, so the working
# tree's formats don't count. A site built before map formats reads tiles.json.
map=1
if [ -f "$site/js/formats.js" ]; then
  map=$(sed -nE 's/.*[{ ,]map: *([0-9]+).*/\1/p' "$site/js/formats.js" | head -1)
  if [ -z "$map" ]; then
    echo "::error title=Unknown map format::Couldn't read the map format from $site/js/formats.js."
    exit 1
  fi
fi
manifest=tiles.json
[ "$map" -gt 1 ] && manifest="tiles.v$map.json"
if [ ! -s "$site/tiles/$manifest" ]; then
  echo "::error title=Missing beta base map::This site reads map format $map, so beta needs tiles/$manifest. Build tiles and publish a data release with the map file first."
  exit 1
fi

if [ -z "${BETA_DEPLOY_KEY:-}" ] || [ -z "${BETA_DEPLOY_KEY_PASSPHRASE:-}" ]; then
  echo "::error title=Missing beta key secret::Set BETA_DEPLOY_KEY and BETA_DEPLOY_KEY_PASSPHRASE in Actions secrets."
  exit 1
fi
key="$RUNNER_TEMP/beta-key"
printf '%s\n' "$BETA_DEPLOY_KEY" > "$key"
chmod 600 "$key"
if ssh-keygen -y -P "" -f "$key" >/dev/null 2>&1; then
  echo "::error title=Unencrypted deploy key::BETA_DEPLOY_KEY must be protected with a passphrase."
  exit 1
fi
askpass="$RUNNER_TEMP/beta-askpass"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$BETA_DEPLOY_KEY_PASSPHRASE"' > "$askpass"
chmod 700 "$askpass"
eval "$(ssh-agent -s)"
trap 'ssh-agent -k >/dev/null 2>&1; rm -f "$key" "$askpass"' EXIT
DISPLAY=:0 SSH_ASKPASS="$askpass" SSH_ASKPASS_REQUIRE=force \
  setsid -w ssh-add "$key" < /dev/null

(
  cd "$site"
  git init -q -b main
  git add -A
  git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit -q -m "$message"
  GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
    git push -f git@github.com:Coehill/guelph-bike-parking-beta.git main
)

for i in $(seq 1 20); do
  if curl -fsSL --max-time 10 https://beta.guelph.bike/ | grep -q 'Guelph Bike Parking Map'; then
    exit 0
  fi
  sleep 10
done
echo "::error title=Beta site check failed::The beta site did not serve the expected app HTML."
exit 1
