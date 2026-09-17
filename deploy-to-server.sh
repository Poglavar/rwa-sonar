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
# main by default; DEPLOY_BRANCH=<name> deploys another pushed branch (the guards below still
# apply to it). Used for the hackathon branch, which stays unmerged until judging is over.
BRANCH="${DEPLOY_BRANCH:-main}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Cloudflare credentials (CF_ZONE_ID, CF_API_KEY) for the cache purge.
if [ -f "$SCRIPT_DIR/.env" ]; then
	set -a; source "$SCRIPT_DIR/.env"; set +a
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

DEPLOY_SHA="$(ssh "$REMOTE_HOST" "REMOTE_REPO_DIR='$REMOTE_REPO_DIR' REMOTE_DOCROOT='$REMOTE_DOCROOT' CLONE_URL='$CLONE_URL' BRANCH='$BRANCH' bash -s" <<'EOF'
set -euo pipefail
if [ ! -d "$REMOTE_REPO_DIR/.git" ]; then
	mkdir -p "$(dirname "$REMOTE_REPO_DIR")"
	git clone --quiet "$CLONE_URL" "$REMOTE_REPO_DIR"
fi
cd "$REMOTE_REPO_DIR"
git fetch origin "$BRANCH" --quiet
# The tokenized-stocks jobs (stocks/refresh-on-server.sh, ecosystem.config.cjs) rewrite these
# TRACKED files on the server. A reset would put the committed, older data back in front of
# fresher job output, so they are set aside and restored; the next refresh run rebuilds them
# from the deployed code anyway. First deploy: nothing exists yet, the committed files ship.
JOB_OWNED=(stocks-issuers.json stocks-tokens.json stocks-graph.json stocks-health.json
	stocks-afterhours.json stocks-changes.json stocks-trades.json
	stocks/data/universe.json stocks/data/onchain.json stocks/data/sponsor-apis.json
	stocks/data/reference-prices.json stocks/data/venues.json stocks/data/holders.json
	stocks/data/meteora.json stocks/data/trades-24h.json stocks/data/history)
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
mkdir -p "$REMOTE_DOCROOT"
# --delete removes files a previous deploy left behind. The excludes keep repo
# plumbing and dev-only payload out of a public docroot; .env and .git are listed
# even though git cannot ship the first and the checkout lives outside the docroot,
# because a docroot must never contain either whatever the source turns out to be.
rsync -a --delete \
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
	--exclude '.last-refresh-stats.json' \
	--exclude '.refresh.lock' \
	--exclude 'ecosystem.config.cjs' \
	--exclude 'stocks/refresh-on-server.sh' \
	"$REMOTE_REPO_DIR/" "$REMOTE_DOCROOT/"
chmod -R u=rwX,go=rX "$REMOTE_DOCROOT"
# The jobs, if registered: restart from the FILE so PM2 re-reads it, and kick a refresh so the
# docroot gets data built by the code just deployed within minutes rather than at the next cron.
if command -v pm2 >/dev/null && pm2 describe rwa-trades >/dev/null 2>&1; then
	# Non-fatal: the mirror above is already done, and a job mid-restart makes PM2 answer
	# "Process not found"; the file (not the name) is passed so PM2 re-reads it.
	for app in rwa-trades rwa-refresh; do
		pm2 restart ecosystem.config.cjs --only "$app" --update-env >/dev/null 2>&1 \
			&& echo "restarted $app" >&2 || echo "WARNING: pm2 restart $app failed — check pm2 ls" >&2
	done
fi
echo "$SHA"
EOF
)"

echo "Deployed $DEPLOY_SHA to $REMOTE_DOCROOT"

if [ -n "${CF_ZONE_ID:-}" ] && [ -n "${CF_API_KEY:-}" ]; then
	echo "Purging Cloudflare cache for https://rwasonar.com/"
	curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
		-H "Authorization: Bearer ${CF_API_KEY}" \
		-H "Content-Type: application/json" \
		--data '{"prefixes":["https://rwasonar.com/"]}' >/dev/null && echo "Cloudflare cache purged."
else
	echo "CF_ZONE_ID/CF_API_KEY not set — skipping cache purge."
fi

echo "Deploy complete."
