#!/usr/bin/env bash
# Six-hourly refresh of the tokenized-stocks data, run ON the server by PM2 (app `rwa-refresh`
# in ecosystem.config.cjs) from the repo clone /root/code/rwa-sonar: re-fetches what the
# keyless and keyed APIs report, rebuilds the graded database, health, after-hours, snapshot,
# change log and cards, then installs the outputs into the nginx docroot and verifies the
# PUBLIC builtAt matches what was just built. A deploy never has to run this: the docroot copy
# of every job-owned file is what people see, and the live tape (`rwa-trades`) publishes itself.
# Keys come from the clone's .env (never printed). flock makes a slow run and a cron overlap
# harmless: the second invocation exits at once.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
DOCROOT="${RWA_DOCROOT:-/var/www/rwasonar}"
BASE_URL="${RWA_BASE_URL:-https://rwasonar.com}"
STATS="$REPO/.last-refresh-stats.json"
LOCK="$REPO/.refresh.lock"
START=$(date -u +%s)

exec 9>"$LOCK"
if ! flock -n 9; then
    echo "[$(date -u +%FT%TZ)] another refresh holds $LOCK — exiting"
    exit 0
fi

fail() {
    echo "[$(date -u +%FT%TZ)] FAILED: $1"
    printf '{"refreshStatus":"failed","lastRunEndedAt":"%s","error":"%s"}\n' "$(date -u +%FT%TZ)" "$1" > "$STATS"
    exit 1
}
trap 'fail "unexpected error at line $LINENO"' ERR

[ -d "$DOCROOT" ] || fail "docroot $DOCROOT missing"
[ -f .env ] || fail ".env missing in $REPO (SOLANA_RPC_URL, COINGECKO_API_KEY, PYTH_API_KEY)"
# The sonar database load is part of the refresh, so a missing DATABASE_URL is as fatal as a
# missing .env — never a silently skipped step. `grep -q` never prints the value.
grep -qE '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL=' .env \
    || fail "DATABASE_URL missing from $REPO/.env (needed by stocks/load-db.mjs)"

step() { echo "[$(date -u +%FT%TZ)] ── $*"; }

# 1. Fetch. Universe/onchain/sponsors/holders checkpoint per day, so they refetch once a day and
#    reuse their checkpoint on the other runs; venues and prices are cheap and forced every run.
step "universe";  node stocks/fetch-universe.mjs --run
step "onchain";   node stocks/fetch-onchain.mjs --run
step "sponsors";  node stocks/fetch-sponsor-apis.mjs --run
step "venues";    node stocks/fetch-venues.mjs --run --force
step "holders";   node stocks/fetch-holders.mjs --run
step "prices";    node stocks/fetch-reference-prices.mjs --run --force
step "meteora";   node stocks/fetch-meteora.mjs --run --fresh

# 2. Build, in dependency order.
step "build";      node stocks/build-stocks-db.mjs --run
step "graph";      node stocks/build-graph.mjs --run
step "health";     node stocks/build-health.mjs --run
step "afterhours"; node stocks/build-afterhours.mjs --run
step "snapshot";   node stocks/snapshot.mjs --run
step "changes";    node stocks/build-changes.mjs --run
step "cards";      node stocks/build-cards.mjs --run --base-url="$BASE_URL" --out-dir=cards
# The same data into schema `sonar` of the geodata database, so it can be grouped and joined.
# --ddl is idempotent; the trade table accumulates past the 24 h window the JSON keeps. No --only,
# so every step runs, the claims and what-if loads included (a new step is picked up here for
# free; a --only list here would have to be edited every time one is added).
step "db";         node stocks/load-db.mjs --run --ddl

# 3. Install into the docroot. Only the job-owned files: the pages themselves come from deploys.
step "install into $DOCROOT"
for f in stocks-issuers.json stocks-tokens.json stocks-graph.json stocks-health.json \
         stocks-afterhours.json stocks-changes.json; do
    install -m 644 "$f" "$DOCROOT/$f"
done
mkdir -p "$DOCROOT/stocks/data/history" "$DOCROOT/cards"
for f in stocks/data/venues.json stocks/data/holders.json stocks/data/meteora.json \
         stocks/data/reference-prices.json stocks/data/events.json; do
    install -m 644 "$f" "$DOCROOT/$f"
done
rsync -a --delete stocks/data/history/ "$DOCROOT/stocks/data/history/"
rsync -a --delete cards/ "$DOCROOT/cards/"
chmod -R u=rwX,go=rX "$DOCROOT/cards" "$DOCROOT/stocks/data/history"

# 4. Prune raw checkpoints older than 3 days (gitignored, never served).
find stocks/data/raw -type f -mtime +3 -delete 2>/dev/null || true

# 5. Verify from the artifact: the PUBLIC tokens file must carry the builtAt just built.
LOCAL_BUILT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('stocks-tokens.json','utf8')).builtAt)")
PUBLIC_BUILT=$(curl -fsS "$BASE_URL/stocks-tokens.json?cb=$START" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).builtAt))") || fail "public stocks-tokens.json fetch"
[ "$LOCAL_BUILT" = "$PUBLIC_BUILT" ] || fail "public builtAt=$PUBLIC_BUILT, expected $LOCAL_BUILT"
CARDS=$(ls cards/*.html | wc -l | tr -d ' ')
WARN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('stocks-health.json','utf8')).counts.warning)")

DURATION=$(( $(date -u +%s) - START ))
printf '{"refreshStatus":"ok","lastRunEndedAt":"%s","builtAt":"%s","cards":%s,"warning":%s,"durationSec":%s}\n' \
    "$(date -u +%FT%TZ)" "$LOCAL_BUILT" "$CARDS" "$WARN" "$DURATION" > "$STATS"
echo "[$(date -u +%FT%TZ)] refresh done: builtAt=$LOCAL_BUILT cards=$CARDS warning=$WARN durationSec=$DURATION"
