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
# Refuses to run unless the local checkout IS origin/main (clean, on main, pushed),
# so production always matches GitHub. DEPLOY_ALLOW_DIRTY=1 bypasses in an emergency.
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-do}"
REMOTE_REPO_DIR="${REMOTE_REPO_DIR:-/root/code/rwa-sonar}"
REMOTE_DOCROOT="${REMOTE_DOCROOT:-/var/www/rwasonar}"
CLONE_URL="${CLONE_URL:-git@github-personal:Poglavar/rwa-sonar.git}"
BRANCH="main"

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
git reset --hard "origin/$BRANCH" --quiet
git clean -fd --quiet
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
	"$REMOTE_REPO_DIR/" "$REMOTE_DOCROOT/"
chmod -R u=rwX,go=rX "$REMOTE_DOCROOT"
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
