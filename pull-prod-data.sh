#!/usr/bin/env bash
# Copies prod's job-owned runtime data (the release manifest's files: stocks-tokens.json, the cards,
# stocks/data/venues.json…) from the live release on the server into this checkout, so a local page
# shows what rwasonar.com shows. None of it is tracked in git any more; the prod jobs write it. The
# curated inputs (RELEASE_CURATED) are skipped: git is their source. With --db it also merges the
# sonar tables into the local database with sync-tables (tables-used.md; the personal-watch tables
# are never copied). Read-only on the server.
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-do}"
REMOTE_DOCROOT="${REMOTE_DOCROOT:-/var/www/rwasonar}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

usage() {
	cat <<'TXT'
pull-prod-data.sh — copy prod's job-owned data into this checkout

USAGE
  ./pull-prod-data.sh --run [--db] [--dry-run]

  --run       Copy the files (without it this help is printed and nothing runs).
  --db        Also merge the sonar tables into the local database (sync-tables).
  --dry-run   List what would be copied, change nothing.

Existing local files are overwritten with prod's; nothing local is deleted.
TXT
}

RUN=0; DB=0; DRY=0
for arg in "$@"; do
	case "$arg" in
		--run) RUN=1 ;;
		--db) DB=1 ;;
		--dry-run) DRY=1 ;;
		*) usage; exit 1 ;;
	esac
done
[ "$RUN" = 1 ] || { usage; exit 0; }

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

cd "$ROOT"
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
node --input-type=module -e "
import { RELEASE_ARTIFACTS, RELEASE_CURATED } from './stocks/lib/release-manifest.mjs';
process.stdout.write(RELEASE_ARTIFACTS.filter((p) => !RELEASE_CURATED.includes(p)).join('\n') + '\n');
" > "$LIST"
log "copying $(wc -l < "$LIST" | tr -d ' ') job-owned path(s) from ${REMOTE_HOST}:${REMOTE_DOCROOT} (the live release)"
# -L: the docroot's files are symlinks into the current release generation.
# A dry run itemizes each file instead: macOS's openrsync reports 0 in --dry-run --stats.
if [ "$DRY" = 1 ]; then
	CHANGES="$(rsync -a -L -r --files-from="$LIST" --dry-run -i "${REMOTE_HOST}:${REMOTE_DOCROOT}/" "$ROOT/" | grep -E '^[<>c.][fdL]' | grep -v '^\.' || true)"
	log "would copy $(printf '%s' "$CHANGES" | grep -c . || true) file(s); first ones:"
	printf '%s\n' "$CHANGES" | head -10
else
	rsync -a -L -r --files-from="$LIST" --stats "${REMOTE_HOST}:${REMOTE_DOCROOT}/" "$ROOT/" | grep -E 'Number of (regular )?files transferred|Total transferred file size' || true
fi
if [ "$DRY" = 0 ]; then
	log "catalogue built at $(node -e "console.log(require('./stocks-tokens.json').builtAt ?? 'unknown')")"
fi

if [ "$DB" = 1 ]; then
	if [ "$DRY" = 1 ]; then
		log "--dry-run: skipping sync-tables"
	else
		log "merging the sonar tables into the local database (sync-tables)"
		sync-tables
	fi
fi
log "done"
