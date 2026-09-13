#!/usr/bin/env bash
# Publish reports/out/ to the password-protected share link (here.now, mounted on share.wavedepth.com).
#
#   reports/publish.sh                 # re-publish; keeps the existing password
#   reports/publish.sh --password X    # set (or change) the viewer password
#
# The mount path (share_mount) and, after the first run, the here.now slug (share_slug) live in reports/report.config.json; the here.now key lives in
# ~/.herenow/credentials. The password is never written to the repo.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PASSWORD=""
while [ $# -gt 0 ]; do case "$1" in --password) PASSWORD="$2"; shift 2 ;; *) echo "unknown option $1" >&2; exit 2 ;; esac; done

SLUG=$(jq -r .share_slug reports/report.config.json)
MOUNT=$(jq -r .share_mount reports/report.config.json)   # at most 30 characters (here.now limit)
BASE=$(jq -r .output_basename reports/report.config.json)
TITLE=$(jq -r .event_name reports/report.config.json)
PUBLISH="$HOME/.config/skillshare/skills/here-now/scripts/publish.sh"
KEY=$(cat "$HOME/.herenow/credentials")

SITE=$(mktemp -d)
trap 'rm -rf "$SITE"' EXIT
cp reports/out/site/*.html "$SITE/"
cp "reports/out/$BASE.xlsx" "reports/out/$BASE.pdf" "$SITE/"

if [ -n "$SLUG" ]; then
  OUT=$("$PUBLISH" "$SITE" --slug "$SLUG" --mount "$MOUNT" --title "$TITLE · Donor Report" --client claude-code --overwrite 2>&1)
else
  # First publish: here.now assigns the slug; remember it in the config so later runs update in place.
  OUT=$("$PUBLISH" "$SITE" --mount "$MOUNT" --title "$TITLE · Donor Report" --client claude-code 2>&1)
  SLUG=$(printf "%s\n" "$OUT" | sed -n "s/^publish_result.slug=//p" | tail -1)
  [ -n "$SLUG" ] || { printf "%s\n" "$OUT" >&2; echo "could not read the new slug" >&2; exit 1; }
  jq --arg s "$SLUG" ".share_slug = \$s" reports/report.config.json > reports/report.config.json.tmp && mv reports/report.config.json.tmp reports/report.config.json
fi
URL=$(printf "%s\n" "$OUT" | grep -m1 "^https://share.wavedepth.com" || printf "%s\n" "$OUT" | tail -1)

if [ -n "$PASSWORD" ]; then
  curl -sS -f -X PATCH "https://here.now/api/v1/publish/$SLUG/metadata" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg p "$PASSWORD" '{password:$p}')" >/dev/null
  echo "password set"
fi
echo "$URL"
