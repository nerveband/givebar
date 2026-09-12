#!/usr/bin/env bash
# Deploy Givebar to the wavedepth host as the manually managed `givebar` container.
#
# In order:
#   1. rsync this checkout to /etc/dokploy/applications/givebar/code
#   2. snapshot the live database with VACUUM INTO (WAL-safe) into data/backups
#   3. docker build a fresh image tagged with the git short SHA
#   4. replace the running container with the same bind mounts and env
#   5. wait for /api/state to answer, or roll back to the previous image
#
# nginx-rc proxies givebar.wavedepth.com to 127.0.0.1:3333 (Cloudflare in front).
# Secrets stay on the host under private/ as mode-600 files: the Fundraising
# token, the Brevo SMTP key, and the read-only Umami database URL that feeds
# the Stats page (CAIR-Georgia website). Nothing is printed.
#
# Usage: scripts/deploy-wavedepth.sh [ssh-target]      (default root@172.245.248.17)
#        SSH="ssh -F ~/.ssh/config" scripts/deploy-wavedepth.sh isla-production
# Never run this during the live appeal.
set -euo pipefail

TARGET="${1:-root@172.245.248.17}"
SSH="${SSH:-ssh}"
APP_DIR="/etc/dokploy/applications/givebar"
cd "$(git rev-parse --show-toplevel)"
TAG="givebar:$(git rev-parse --short HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean; commit first so the deployed tag matches a commit." >&2
  exit 1
fi

REMOTE_LIB=$(cat <<'EOF'
APP_DIR=/etc/dokploy/applications/givebar
UMAMI_NETWORK=wd-umami-analytics_default
UMAMI_WEBSITE_ID=22e2b8d7-39c9-4434-b91d-8a1b8fae91d3
ensure_smtp_key() {
  if [ ! -s "$APP_DIR/private/brevo-smtp-key" ]; then
    docker inspect givebar --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^BREVO_SMTP_KEY=//p' | head -1 > "$APP_DIR/private/brevo-smtp-key"
    chmod 600 "$APP_DIR/private/brevo-smtp-key"
  fi
  [ -s "$APP_DIR/private/brevo-smtp-key" ] || { echo "private/brevo-smtp-key is missing on the host" >&2; exit 1; }
}
run_container() {
  docker rm -f givebar >/dev/null 2>&1 || true
  docker run -d --name givebar --restart unless-stopped \
    -p 127.0.0.1:3333:3000 \
    -e NODE_ENV=production -e PORT=3000 -e HOST=0.0.0.0 -e GIVEBAR_DB_PATH=/app/data/givebar.sqlite \
    -e GIVEBAR_FUNDRAISING_TOKEN_FILE=/run/secrets/givebar-fundraising-token \
    -e BREVO_SMTP_USER=info@wavedepth.com -e BREVO_SMTP_KEY="$(cat "$APP_DIR/private/brevo-smtp-key")" \
    -e GIVEBAR_UMAMI_DATABASE_URL="$(cat "$APP_DIR/private/umami-database-url" 2>/dev/null || true)" \
    -e GIVEBAR_UMAMI_WEBSITE_ID="$UMAMI_WEBSITE_ID" \
    -v "$APP_DIR/data:/app/data" \
    -v "$APP_DIR/private/fundraising-token:/run/secrets/givebar-fundraising-token:ro" \
    "$1" >/dev/null
  # Stats reads the Umami database over its private network; the container stays on the default bridge for nginx-rc.
  docker network connect "$UMAMI_NETWORK" givebar 2>/dev/null || true
}
healthy() {
  for _ in $(seq 1 25); do
    curl -fsS -m 3 "http://127.0.0.1:3333/api/state?role=stage" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
EOF
)

PREVIOUS="$($SSH "$TARGET" "docker inspect givebar --format '{{.Config.Image}}' 2>/dev/null || true")"

echo "==> Syncing code to $TARGET:$APP_DIR/code"
rsync -az --delete -e "$SSH" --exclude .git --exclude node_modules --exclude data --exclude '*.sqlite*' ./ "$TARGET:$APP_DIR/code/"

# The pre-deploy snapshot is the way back if the new image cannot open the database; when a
# container is running, a failed snapshot stops the deploy before anything is touched.
if [ -n "$PREVIOUS" ]; then
  echo "==> Snapshotting the live database"
  $SSH "$TARGET" "docker exec givebar bun -e \"const {Database}=require('bun:sqlite');require('fs').mkdirSync('/app/data/backups',{recursive:true});const n='/app/data/backups/givebar-pre-deploy-'+new Date().toISOString().replace(/[-:.]/g,'').slice(0,18)+'.sqlite';new Database('/app/data/givebar.sqlite').exec(\\\"VACUUM INTO '\\\"+n+\\\"'\\\");console.log(n)\"" \
    || { echo "Pre-deploy snapshot failed; nothing was changed." >&2; exit 1; }
else
  echo "==> No running container: first deploy, no snapshot and no rollback target"
fi

# Secrets are checked before the old container is removed, so a missing key never leaves the site down.
$SSH "$TARGET" "$REMOTE_LIB; ensure_smtp_key"

echo "==> Building $TAG"
$SSH "$TARGET" "cd $APP_DIR/code && docker build -q -t $TAG . >/dev/null"

echo "==> Replacing the container (previous image: ${PREVIOUS:-none})"
if $SSH "$TARGET" "$REMOTE_LIB; run_container $TAG; healthy"; then
  echo "Deployed $TAG. Public check: HTTP $(curl -s -o /dev/null -w '%{http_code}' -m 8 'https://givebar.wavedepth.com/api/state?role=stage')"
  exit 0
fi

if [ -z "$PREVIOUS" ]; then
  echo "Health check failed on a first deploy; inspect 'docker logs givebar' on the host." >&2
  exit 1
fi
echo "Health check failed; rolling back to $PREVIOUS" >&2
if $SSH "$TARGET" "$REMOTE_LIB; run_container $PREVIOUS; healthy"; then
  echo "Rolled back to $PREVIOUS. If the new image upgraded the schema, restore the pre-deploy snapshot from Team and backups." >&2
else
  echo "Rollback did not come up either; restore the pre-deploy snapshot by hand (README, Recovery)." >&2
fi
exit 1
