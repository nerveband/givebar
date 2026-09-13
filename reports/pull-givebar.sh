#!/usr/bin/env bash
# Take a WAL-safe VACUUM INTO snapshot of the live Givebar database on the wavedepth host and
# copy it to reports/data/givebar-prod.sqlite. The SSH key comes from Secret Gate (ssh-agent only).
#
#   reports/pull-givebar.sh
#
# Never copies givebar.sqlite by hand; the snapshot is a consistent VACUUM INTO copy.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
ITEM="wavedepth Dokploy Server - 172.245.248.17"
HOST="root@172.245.248.17"
OUT="reports/data/givebar-prod.sqlite"
mkdir -p reports/data

SNAP='docker exec givebar bun -e "const {Database}=require(\"bun:sqlite\");const n=\"/app/data/backups/report-snapshot-\"+new Date().toISOString().replace(/[-:.]/g,\"\").slice(0,15)+\".sqlite\";new Database(\"/app/data/givebar.sqlite\").exec(\"VACUUM INTO \x27\"+n+\"\x27\");console.log(n)"'
REMOTE="$SNAP && base64 -w0 \$(ls -t /etc/dokploy/applications/givebar/data/backups/report-snapshot-*.sqlite | head -1)"

secret-gate ssh --item "$ITEM" --host "$HOST" --command "$REMOTE" \
  | jq -r '.data.stdout' > reports/data/.snapshot.txt
sed -n 1p reports/data/.snapshot.txt
sed -n 2p reports/data/.snapshot.txt | base64 -d > "$OUT"
rm -f reports/data/.snapshot.txt
chmod 600 "$OUT"
echo "wrote $OUT ($(stat -c %s "$OUT") bytes)"
