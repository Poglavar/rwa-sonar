#!/usr/bin/env bash
# Six-hourly refresh of the tokenized-stocks data, run ON the server by PM2 (app `rwa-refresh`
# in ecosystem.config.cjs) from the repo clone /root/code/rwa-sonar: re-fetches what the
# keyless and keyed APIs report, rebuilds the graded database, health, after-hours, snapshot,
# change log, legal-template dossiers and cards, then installs the outputs into the nginx docroot and verifies the
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
[ -f .env ] || fail ".env missing in $REPO (SOLANA_RPC_URL, PYTH_API_KEY)"
# The sonar database load is part of the refresh, so a missing DATABASE_URL is as fatal as a
# missing .env — never a silently skipped step. `grep -q` never prints the value.
grep -qE '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL=' .env \
    || fail "DATABASE_URL missing from $REPO/.env (needed by stocks/load-db.mjs)"

step() { echo "[$(date -u +%FT%TZ)] ── $*"; }

# A third-party API answering 500 (Tessera's did on 2026-09-18 and took the whole refresh, cards
# included, down with it) is that vendor's problem for an hour, not a reason to publish nothing.
# `soft` runs a step, records its failure and lets the run go on; the run still exits non-zero
# at the end so the failure reaches the monitor (a run with a failed step is not a success).
SOFT_FAILURES=()
soft() {
    local label=$1; shift
    step "$label"
    if ! "$@"; then
        SOFT_FAILURES+=("$label")
        echo "[$(date -u +%FT%TZ)] WARN step '$label' failed — continuing with what was fetched"
    fi
}

# 1. Fetch. Universe/onchain/sponsors/holders checkpoint per day, so they refetch once a day and
#    reuse their checkpoint on the other runs. CoinGecko gets one quota-capped rotating pass in
#    the midnight-UTC refresh; DexScreener and prices remain fresh every six hours.
step "universe";  node stocks/fetch-universe.mjs --run
step "onchain";   node stocks/fetch-onchain.mjs --run
soft "sponsors"   node stocks/fetch-sponsor-apis.mjs --run
# The free tier is 10,000 calls/month. 250 ticker calls + at most one coin-list call per day is
# 7,530 calls in a 30-day month / 7,781 in a 31-day month, leaving room for retries and manual use.
# Oldest/unseen-first selection rotates through the full universe in roughly two days.
if [ "$(date -u +%H)" = "00" ]; then
    soft "coingecko venues (daily, quota-capped)" node stocks/fetch-venues.mjs --run --only-cex --coin-limit=250
fi
# DexScreener still refreshes on-chain pools, liquidity, volume and transaction counts every run.
step "venues";    node stocks/fetch-venues.mjs --run --only-dex --force
step "holders";   node stocks/fetch-holders.mjs --run
step "prices";    node stocks/fetch-reference-prices.mjs --run --force
soft "meteora"    node stocks/fetch-meteora.mjs --run --fresh

# 2. Build, in dependency order.
step "build";      node stocks/build-stocks-db.mjs --run
DEFI_USAGE_FRESH=1
step "defi usage"
if ! node stocks/fetch-defi-usage.mjs --run; then
    SOFT_FAILURES+=("defi usage")
    DEFI_USAGE_FRESH=0
    echo "[$(date -u +%FT%TZ)] WARN step 'defi usage' failed — continuing with what was fetched"
fi
step "graph";      node stocks/build-graph.mjs --run
step "health";     node stocks/build-health.mjs --run
step "afterhours"; node stocks/build-afterhours.mjs --run
step "snapshot";   node stocks/snapshot.mjs --run
step "changes";    node stocks/build-changes.mjs --run
# Protocol history is genuinely daily, not a six-hour series repeatedly overwriting the same day.
# Never freeze a stale defi-usage.json after its fetch failed: the next successful midnight then
# compares with the last genuine observation instead of erasing a change or inventing removals.
if [ "$(date -u +%H)" = "00" ]; then
    if [ "$DEFI_USAGE_FRESH" -eq 1 ]; then
        step "DeFi daily snapshot"; node stocks/snapshot-defi.mjs --run
        step "DeFi daily changes";  node stocks/build-defi-changes.mjs --run
    else
        echo "[$(date -u +%FT%TZ)] WARN skipping DeFi daily snapshot because its source refresh failed"
    fi
fi
step "legal templates"; node stocks/build-legal-templates.mjs --run --base-url="$BASE_URL" --out-dir=templates
step "cards";      node stocks/build-cards.mjs --run --base-url="$BASE_URL" --out-dir=cards
step "collector status"; node stocks/build-collector-status.mjs --run
# The same data into schema `sonar` of the geodata database, so it can be grouped and joined.
# --ddl is idempotent; the trade table accumulates past the 24 h window the JSON keeps. No --only,
# so every step runs, the claims and what-if loads included (a new step is picked up here for
# free; a --only list here would have to be edited every time one is added).
step "db";         node stocks/load-db.mjs --run --ddl
# Watch changes are a daily signal for the morning digest. Re-running every six hours would move
# the baseline after the digest and could consume an event before the next morning. The first
# post-deploy run may create the file once so later stats assembly always has a baseline payload.
if [ "$(date -u +%H)" = "00" ] || [ ! -f stocks-watchlist-changes.json ]; then
    step "saved watches (daily)"; node stocks/build-watchlist-changes.mjs --run
fi

# 3. Install into the docroot. Only the job-owned files: the pages themselves come from deploys.
step "install into $DOCROOT"
for f in stocks-issuers.json stocks-tokens.json stocks-graph.json stocks-health.json stocks-collector-status.json \
         stocks-afterhours.json stocks-changes.json stocks-defi-changes.json stocks-legal-templates.json; do
    install -m 644 "$f" "$DOCROOT/$f"
done
mkdir -p "$DOCROOT/stocks/data/history" "$DOCROOT/cards" "$DOCROOT/templates"
for f in stocks/data/venues.json stocks/data/holders.json stocks/data/meteora.json \
         stocks/data/reference-prices.json stocks/data/events.json stocks/data/defi-usage.json; do
    install -m 644 "$f" "$DOCROOT/$f"
done
rsync -a --delete stocks/data/history/ "$DOCROOT/stocks/data/history/"
rsync -a --delete cards/ "$DOCROOT/cards/"
rsync -a --delete templates/ "$DOCROOT/templates/"
chmod -R u=rwX,go=rX "$DOCROOT/cards" "$DOCROOT/templates" "$DOCROOT/stocks/data/history"

# 4. Prune raw checkpoints older than 3 days (gitignored, never served).
find stocks/data/raw -type f -mtime +3 -delete 2>/dev/null || true

# 5. Verify from the artifact: the PUBLIC tokens file must carry the builtAt just built.
LOCAL_BUILT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('stocks-tokens.json','utf8')).builtAt)")
PUBLIC_BUILT=$(curl -fsS "$BASE_URL/stocks-tokens.json?cb=$START" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).builtAt))") || fail "public stocks-tokens.json fetch"
[ "$LOCAL_BUILT" = "$PUBLIC_BUILT" ] || fail "public builtAt=$PUBLIC_BUILT, expected $LOCAL_BUILT"
CARDS=$(ls cards/*.html | wc -l | tr -d ' ')
WARN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('stocks-health.json','utf8')).counts.warning)")
DEFI_CHANGES=$(node -e "const d=JSON.parse(require('fs').readFileSync('stocks-defi-changes.json','utf8'));console.log(d.latest?.events?.length||0)")
WATCH_CHANGES=$(node -e "const d=JSON.parse(require('fs').readFileSync('stocks-watchlist-changes.json','utf8'));console.log(d.materialChanges||0)")
NOTICE_LINES=$(node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('stocks-changes.json','utf8'));const d=JSON.parse(fs.readFileSync('stocks-defi-changes.json','utf8'));const w=JSON.parse(fs.readFileSync('stocks-watchlist-changes.json','utf8'));const compact=x=>x.length<=4?x:[x[0],...x.slice(1,3),x.at(-1)];const lines=[...compact(c.latest?.noticeLines||[]),...compact(d.latest?.noticeLines||[]),...compact(w.noticeLines||[])];process.stdout.write(JSON.stringify(lines))")

DURATION=$(( $(date -u +%s) - START ))
if [ ${#SOFT_FAILURES[@]} -gt 0 ]; then
    FAILED_STEPS=$(IFS=,; echo "${SOFT_FAILURES[*]}")
    printf '{"refreshStatus":"partial","failedSteps":"%s","lastRunEndedAt":"%s","builtAt":"%s","cards":%s,"warning":%s,"defiChanges":%s,"watchChanges":%s,"noticeLines":%s,"durationSec":%s}\n' \
        "$FAILED_STEPS" "$(date -u +%FT%TZ)" "$LOCAL_BUILT" "$CARDS" "$WARN" "$DEFI_CHANGES" "$WATCH_CHANGES" "$NOTICE_LINES" "$DURATION" > "$STATS"
    echo "[$(date -u +%FT%TZ)] refresh PARTIAL: step(s) failed: $FAILED_STEPS — site updated with what was fetched; builtAt=$LOCAL_BUILT cards=$CARDS"
    exit 1
fi
printf '{"refreshStatus":"ok","lastRunEndedAt":"%s","builtAt":"%s","cards":%s,"warning":%s,"defiChanges":%s,"watchChanges":%s,"noticeLines":%s,"durationSec":%s}\n' \
    "$(date -u +%FT%TZ)" "$LOCAL_BUILT" "$CARDS" "$WARN" "$DEFI_CHANGES" "$WATCH_CHANGES" "$NOTICE_LINES" "$DURATION" > "$STATS"
echo "[$(date -u +%FT%TZ)] refresh done: builtAt=$LOCAL_BUILT cards=$CARDS warning=$WARN durationSec=$DURATION"
