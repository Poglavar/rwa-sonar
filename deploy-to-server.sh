#!/usr/bin/env bash
# Deploys by having the SERVER pull origin/main and mirror its tree into the nginx
# docroot. Nothing is rsynced from the laptop, so what is live is exactly what is
# on origin/main.
#
# Why git-pull rather than a laptop rsync: rsync copies whatever is in the working
# directory, including gitignored files. That is how six .env files - one holding a
# live Cloudflare API token - ended up served with 200 from /var/www/zagreb.lol on
# 2026-08-19. Git physically cannot ship a gitignored file. The repo checkout also
# stays OUT of the docroot, so the repo's own .git is never web-reachable either.
#
# Refuses to run unless the local checkout IS origin/<branch> (clean, on it, pushed),
# so production always matches GitHub. DEPLOY_ALLOW_DIRTY=1 bypasses in an emergency.
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-do}"
REMOTE_REPO_DIR="${REMOTE_REPO_DIR:-/root/code/rwa-sonar}"
REMOTE_DOCROOT="${REMOTE_DOCROOT:-/var/www/rwasonar}"
CLONE_URL="${CLONE_URL:-git@github-personal:Poglavar/rwa-sonar.git}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://rwasonar.com}"
# main by default; DEPLOY_BRANCH=<name> deploys another pushed branch (the guards below still
# apply to it). Used for the hackathon branch, which stays unmerged until judging is over.
BRANCH="${DEPLOY_BRANCH:-main}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Cloudflare credentials (CF_ZONE_ID, CF_API_KEY) for the cache purge.
if [ -f "$SCRIPT_DIR/.env" ]; then
	set -a; source "$SCRIPT_DIR/.env"; set +a
fi
if [ -z "${CF_ZONE_ID:-}" ] || [ -z "${CF_API_KEY:-}" ]; then
	echo "CF_ZONE_ID and CF_API_KEY are required for the production cache purge." >&2
	exit 1
fi

if [[ "${DEPLOY_ALLOW_DIRTY:-}" != "1" ]]; then
	if ! git -C "$SCRIPT_DIR" diff --quiet || ! git -C "$SCRIPT_DIR" diff --cached --quiet; then
		echo "Uncommitted changes — commit and push to ${BRANCH} first (or DEPLOY_ALLOW_DIRTY=1)." >&2
		exit 1
	fi
	CUR_BRANCH="$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD)"
	if [[ "$CUR_BRANCH" != "$BRANCH" ]]; then
		echo "On branch '${CUR_BRANCH}' — deploys run from ${BRANCH} only (or DEPLOY_ALLOW_DIRTY=1)." >&2
		exit 1
	fi
	git -C "$SCRIPT_DIR" fetch origin "$BRANCH" --quiet
	if [[ "$(git -C "$SCRIPT_DIR" rev-parse HEAD)" != "$(git -C "$SCRIPT_DIR" rev-parse "origin/$BRANCH")" ]]; then
		echo "Local ${BRANCH} differs from origin/${BRANCH} — push or pull first." >&2
		exit 1
	fi
fi

echo "Deploying rwa-sonar — server pulls ${BRANCH} on ${REMOTE_HOST}"

DEPLOY_SHA=$(ssh "$REMOTE_HOST" "REMOTE_REPO_DIR='$REMOTE_REPO_DIR' REMOTE_DOCROOT='$REMOTE_DOCROOT' CLONE_URL='$CLONE_URL' BRANCH='$BRANCH' PUBLIC_BASE_URL='$PUBLIC_BASE_URL' bash -s" <<'EOF'
set -euo pipefail
if [ ! -d "$REMOTE_REPO_DIR/.git" ]; then
	mkdir -p "$(dirname "$REMOTE_REPO_DIR")"
	git clone --quiet "$CLONE_URL" "$REMOTE_REPO_DIR"
fi
cd "$REMOTE_REPO_DIR"
# The scheduled refresh rewrites the same retained raw snapshots and release artifacts. Hold its
# lock before reset so deployment builds one coherent release, rather than staging a moving mix.
exec 9>"$REMOTE_REPO_DIR/.refresh.lock"
flock 9
git fetch origin "$BRANCH" --quiet
# The tokenized-stocks jobs (stocks/refresh-on-server.sh, ecosystem.config.cjs) rewrite these
# job-owned files on the server. Tracked generated files are set aside before reset; ignored
# runtime files (the trade store/payload) survive `git clean -fd` in place. The next refresh run
# rebuilds them from the deployed code anyway. First deploy: committed seed files ship where present.
JOB_OWNED=(stocks-issuers.json stocks-tokens.json stocks-graph.json stocks-health.json stocks-collector-status.json stocks-review-queue.json
	stocks-afterhours.json stocks-changes.json stocks-defi-changes.json stocks-legal-templates.json stocks-trades.json
	stocks-change-journal.json
	stocks/data/universe.json stocks/data/onchain.json stocks/data/sponsor-apis.json
	stocks/data/reference-prices.json stocks/data/venues.json stocks/data/holders.json
	stocks/data/meteora.json stocks/data/defi-usage.json stocks/data/discovery-candidates.json
	stocks/data/identity-onchain.json stocks/data/mint-identities.json
	stocks/data/trades-24h.json stocks/data/history)
KEEP="$(mktemp -d)"
for p in "${JOB_OWNED[@]}"; do
	if [ -e "$p" ] && [ -n "$(git status --porcelain -- "$p")" ]; then
		mkdir -p "$KEEP/$(dirname "$p")" && cp -a "$p" "$KEEP/$p"
	fi
done
git reset --hard "origin/$BRANCH" --quiet
git clean -fd --quiet
if [ -n "$(ls -A "$KEEP")" ]; then
	cp -a "$KEEP/." "$REMOTE_REPO_DIR/"
	echo "kept job-written data over the committed copies: $(cd "$KEEP" && find . -type f | wc -l) file(s)" >&2
fi
rm -rf "$KEEP"
SHA="$(git rev-parse --short HEAD)"
# The API has its own dependencies (hono, pg); install them from the lockfile, dev deps excluded.
if [ -f api/package-lock.json ]; then
	(cd api && npm ci --omit=dev --no-audit --no-fund --loglevel=error >&2) && echo "api dependencies installed" >&2
fi
# Rebuild the catalogue from retained live raw inputs plus the freshly deployed curated dossiers.
# This creates issuer/token/funnel/health data before the API database load; no collector runs.
node stocks/build-release-artifacts.mjs --run --phase=base --base-url="$PUBLIC_BASE_URL" >&2
# Apply idempotent DDL only after the rebuilt token snapshot exists, then derive the queue from
# that database state before rendering review-aware public pages.
node stocks/load-db.mjs --run --ddl --only=tokens,snapshots >&2
node stocks/build-release-artifacts.mjs --run --phase=pre-review --base-url="$PUBLIC_BASE_URL" >&2
node stocks/build-review-queue.mjs --run >&2
node stocks/build-release-artifacts.mjs --run --phase=surfaces --base-url="$PUBLIC_BASE_URL" >&2

# Validate first and record hashes/timestamps for this local candidate. This does not claim that
# the mirror or public endpoint is live; publication below remains a separate operation.
node stocks/release-evidence.mjs --run --base-url="$PUBLIC_BASE_URL" >&2
mkdir -p "$REMOTE_DOCROOT"
RELEASE_EXCLUDES="$(mktemp)"
node stocks/lib/release-manifest.mjs --rsync-excludes > "$RELEASE_EXCLUDES"
# --delete removes files a previous deploy left behind. The excludes keep repo
# plumbing and dev-only payload out of a public docroot; .env and .git are listed
# even though git cannot ship the first and the checkout lives outside the docroot,
# because a docroot must never contain either whatever the source turns out to be.
rsync -a --delete \
	--exclude-from="$RELEASE_EXCLUDES" \
	--exclude '.env' \
	--exclude '.git' \
	--exclude '.gitignore' \
	--exclude '.claude' \
	--exclude '.DS_Store' \
	--exclude 'node_modules' \
	--exclude 'deploy-to-server.sh' \
	--exclude '*.md' \
	--exclude 'tmp' \
	--exclude '*.test.js' \
	--exclude 'stocks/data/raw' \
	--exclude 'db' \
	--exclude 'api' \
	--exclude 'logs' \
	--exclude '.last-*' \
	--exclude '*.tmp' \
	--exclude '.refresh.lock' \
	--exclude 'stocks-watchlist-changes.json' \
	--exclude 'ecosystem.config.cjs' \
	--exclude 'stocks/refresh-on-server.sh' \
	--exclude 'dev-server.mjs' \
	--exclude 'package.json' \
	--exclude 'package-lock.json' \
	--exclude 'placeholder-db.json' \
	"$REMOTE_REPO_DIR/" "$REMOTE_DOCROOT/"
rm -f "$RELEASE_EXCLUDES"
# Generated datasets and dossiers are deliberately outside the general mirror.  This shared
# publisher stages the entire manifest first, so a failed required artifact cannot replace the
# last complete public release.
node stocks/publish-release.mjs --run --source="$REMOTE_REPO_DIR" --destination="$REMOTE_DOCROOT" >&2
chmod -R u=rwX,go=rX "$REMOTE_DOCROOT"
# Verify the published bytes in the docroot too; this catches a future rsync exclude that silently
# drops generated artifacts even when their source build succeeded.
grep -Fq "${PUBLIC_BASE_URL}/issuers/xstocks-backed.html" "$REMOTE_DOCROOT/issuers/xstocks-backed.html"
grep -Fq "${PUBLIC_BASE_URL}/issuers/ondo-global-markets.html" "$REMOTE_DOCROOT/issuers/ondo-global-markets.html"
grep -Fq "${PUBLIC_BASE_URL}/cards/NVDAx.html" "$REMOTE_DOCROOT/cards/NVDAx.html"
grep -Fq "${PUBLIC_BASE_URL}/templates/" "$REMOTE_DOCROOT/templates/index.html"
grep -Fq 'id="globalSearch"' "$REMOTE_DOCROOT/stocks.html"
grep -Fq 'id="comparisonView"' "$REMOTE_DOCROOT/stocks.html"
test -s "$REMOTE_DOCROOT/cards/index.json"
test -s "$REMOTE_DOCROOT/protocols/index.json"
test -s "$REMOTE_DOCROOT/stocks-discovery.json"
# Publication is complete. Release the shared lock before restarting the scheduled refresh;
# otherwise its immediate run exits on our own lock instead of collecting with the new code.
flock -u 9
# The jobs, if registered: restart from the FILE so PM2 re-reads it, and kick a refresh so the
# docroot gets data built by the code just deployed within minutes rather than at the next cron.
if command -v pm2 >/dev/null && pm2 describe rwa-trades >/dev/null 2>&1; then
	# Non-fatal: the mirror above is already done, and a job mid-restart makes PM2 answer
	# "Process not found"; the file (not the name) is passed so PM2 re-reads it.
	# Remove the retired one-off source watcher before persisting the canonical process set.
	pm2 delete rwa-watch-first >/dev/null 2>&1 || true
	for app in rwa-trades rwa-watch rwa-sonar-api rwa-refresh rwa-watch-chain; do
		pm2 restart ecosystem.config.cjs --only "$app" --update-env >/dev/null 2>&1 \
			&& echo "restarted $app" >&2 || echo "WARNING: pm2 restart $app failed — check pm2 ls" >&2
	done
	pm2 save >/dev/null
fi
echo "$SHA"
EOF
)

echo "Deployed $DEPLOY_SHA to $REMOTE_DOCROOT"

echo "Purging Cloudflare cache for https://rwasonar.com/"
PURGE_RESPONSE="$(curl -fsS -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
	-H "Authorization: Bearer ${CF_API_KEY}" \
	-H "Content-Type: application/json" \
	--data '{"prefixes":["rwasonar.com/"]}')"
node -e 'const response = JSON.parse(process.argv[1]); if (!response.success) { console.error(`Cloudflare purge rejected: ${JSON.stringify(response.errors || [])}`); process.exit(1); }' "$PURGE_RESPONSE"
echo "Cloudflare cache purged."

# Check public response bytes, not just status: nginx's SPA fallback also returns 200 for a missing
# generated file, while only the real artifact carries its route-specific marker.
check_public() {
	local route="$1"
	local marker="$2"
	PUBLIC_CHECK="$(mktemp)"
	if ! curl -fsS -o "$PUBLIC_CHECK" "${PUBLIC_BASE_URL}/${route}" \
		|| ! grep -Fq "$marker" "$PUBLIC_CHECK"; then
		rm -f "$PUBLIC_CHECK"
		echo "Public release check failed for ${PUBLIC_BASE_URL}/${route}" >&2
		exit 1
	fi
	rm -f "$PUBLIC_CHECK"
}
check_public "issuers/xstocks-backed.html" "${PUBLIC_BASE_URL}/issuers/xstocks-backed.html"
check_public "issuers/ondo-global-markets.html" "${PUBLIC_BASE_URL}/issuers/ondo-global-markets.html"
check_public "cards/NVDAx.html" "${PUBLIC_BASE_URL}/cards/NVDAx.html"
check_public "templates/" "${PUBLIC_BASE_URL}/templates/"
check_public "protocols/" 'Protocol and market dossiers'
check_public "stocks.html?view=compare&compare=AAPL" 'id="comparisonView"'
check_public "stocks.html?view=assets&search=AAPL" 'id="globalSearch"'

PUBLIC_API_CHECK="$(mktemp)"
if ! curl -fsS -o "$PUBLIC_API_CHECK" "${PUBLIC_BASE_URL}/api/tokens?limit=1" \
	|| ! node -e 'const fs=require("node:fs"); const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (!Array.isArray(body.items) || body.items.length !== 1 || !(body.total > 0)) process.exit(1)' "$PUBLIC_API_CHECK"; then
	rm -f "$PUBLIC_API_CHECK"
	echo "Public release check failed for ${PUBLIC_BASE_URL}/api/tokens?limit=1" >&2
	exit 1
fi
rm -f "$PUBLIC_API_CHECK"
echo "Generated routes, comparison, search and API verified."

echo "Deploy complete."
