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

# tiles.json, or tiles.v2.json and up after a map format bump (scripts/formats.mjs). The
# site may be a pull request's, built before or after a bump, so any of them will do.
if ! find "$site/tiles" -maxdepth 1 -name 'tiles*.json' -size +0 2>/dev/null | grep -q .; then
  echo "::error title=Missing beta base map::Beta deploy needs tiles/tiles.json (tiles.vN.json from map format 2). Build tiles and publish a data release with the map file first."
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
