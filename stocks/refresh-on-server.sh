#!/usr/bin/env bash
# Six-hourly refresh of the tokenized-stocks data, run ON the server by PM2 (app `rwa-refresh`
# in ecosystem.config.cjs) from the repo clone /root/code/rwa-sonar: re-fetches what the
# keyless and keyed APIs report, rebuilds the graded database, health, closed-market view, snapshot,
# change log and complete generated dossiers, then stages and installs the outputs into the nginx docroot and verifies the
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
START_ISO=$(date -u +%FT%TZ)

exec 9>"$LOCK"
if ! flock -n 9; then
    echo "[$(date -u +%FT%TZ)] another refresh holds $LOCK — exiting"
    exit 0
fi

fail() {
    local ended duration
    ended=$(date -u +%FT%TZ)
    duration=$(( $(date -u +%s) - START ))
    echo "[$ended] FAILED: $1"
    node -e 'const fs=require("fs");const [path,start,end,duration,reason]=process.argv.slice(1);fs.writeFileSync(path,JSON.stringify({refreshStatus:"failed",lastRunStartedAt:start,lastRunEndedAt:end,durationSec:Number(duration),failures:1,failureReasons:[reason]})+"\n")' \
        "$STATS" "$START_ISO" "$ended" "$duration" "$1"
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
# Issuer registries run first because a newly found address is only admitted when identity evidence
# corroborates the search result. A failed sponsor refresh leaves the previous cache available; it
# never makes a search tag sufficient by itself.
soft "sponsors"   node stocks/fetch-sponsor-apis.mjs --run
step "universe";  node stocks/fetch-universe.mjs --run
step "onchain";   node stocks/fetch-onchain.mjs --run
step "mint identities (seed)"; node stocks/build-mint-identities.mjs --run
step "identity chain"; node stocks/fetch-onchain.mjs --run --in=stocks/data/mint-identities.json --out=stocks/data/identity-onchain.json
step "mint identities (final)"; node stocks/build-mint-identities.mjs --run
# The free tier is 10,000 calls/month. 250 ticker calls + at most one coin-list call per day is
# 7,530 calls in a 30-day month / 7,781 in a 31-day month, leaving room for retries and manual use.
# The 250 are split in two tiers (fetch-venues --priority-coins, default 40 %): 100 coins are
# refreshed every day (saved watches, then the busiest by exchange volume and DEX liquidity) and 150
# rotate oldest/unseen first through the rest. With 1,169 mapped coins (2026-09-24) that is 1,069
# tail coins, each refreshed about every 7.1 days. The run logs "coingecko tiers:" with the live
# numbers and venues.json records them in source.coingecko.tiers; cards date exchange data by cexFetchedAt.
if [ "$(date -u +%H)" = "00" ]; then
    soft "coingecko venues (daily, quota-capped)" node stocks/fetch-venues.mjs --run --only-cex --coin-limit=250
fi
# DexScreener still refreshes on-chain pools, liquidity, volume and transaction counts every run.
step "venues";    node stocks/fetch-venues.mjs --run --only-dex --force
step "holders";   node stocks/fetch-holders.mjs --run
# Issuer inventory for the xStocks public float (flows.html); a failed read keeps the previous file.
soft "xstocks float" node stocks/fetch-xstocks-float.mjs --run
step "prices";    node stocks/fetch-reference-prices.mjs --run --force
# Pyth prices read straight from Solana's push-oracle accounts, keyless: the stock feed ids from the
# reference prices just written, plus each xStocks/Ondo token's own feed, on shards 0 and 1, in one
# bounded getMultipleAccounts pass (6 requests of 100 keys, with the Clock sysvar). For the cards'
# "Pyth on this token"; a failed read keeps the previous stocks/data/pyth-onchain.json.
soft "pyth on-chain" node stocks/fetch-pyth-onchain.mjs --run
soft "meteora"    node stocks/fetch-meteora.mjs --run --fresh
# What lenders do when the US market is closed (stocks/build-closed-market.mjs in the surfaces
# phase): Kamino's keyless hourly price history for the Monday gap (16 small calls), and Jupiter
# keyless quotes for the Solana depth that moves each lender-accepted token 5 % and 10 % (~31
# tokens, about 4-5 minutes, paced for the ~60/min limit). Each run samples the session it falls in,
# so the six-hourly schedule builds weekday, overnight and weekend depth over time.
soft "lender price history" node stocks/fetch-lender-price-history.mjs --run
soft "solana depth" node stocks/fetch-solana-depth.mjs --run

# 2. Seed DeFi collection with the catalogue just rebuilt from this run's universe/on-chain inputs.
# fetch-defi-usage reads stocks-tokens.json to decide which exact mints to inspect. The complete
# base phase below deliberately rebuilds it again after that fetch, so published profiles include
# the newest DeFi input rather than this temporary collector seed.
step "catalogue seed for DeFi"; node stocks/build-stocks-db.mjs --run
DEFI_USAGE_FRESH=1
step "defi usage"
if ! node stocks/fetch-defi-usage.mjs --run; then
    SOFT_FAILURES+=("defi usage")
    DEFI_USAGE_FRESH=0
    echo "[$(date -u +%FT%TZ)] WARN step 'defi usage' failed — continuing with what was fetched"
fi
# Rebuild graph/health/discovery as well as issuer/token/funnel after the DeFi collector. This
# second build is intentional: it turns the fresh protocol observations into public profiles.
step "base release artifacts"; node stocks/build-release-artifacts.mjs --run --phase=base --base-url="$BASE_URL"
step "snapshot";   node stocks/snapshot.mjs --run
step "changes";    node stocks/build-changes.mjs --run
step "public change journal"; node stocks/build-change-journal.mjs --run
# Protocol history is genuinely daily, not a six-hour series repeatedly overwriting the same day.
# Never freeze a stale defi-usage.json after its fetch failed: the next successful midnight then
# compares with the last genuine observation instead of erasing a change or inventing removals.
if [ "$(date -u +%H)" = "00" ]; then
    # Which programs hold each tracked mint (stocks/fetch-defi-footprint.mjs): finds integrations the
    # protocol registries don't list. Bounded; a failed read is never a removal.
    soft "DeFi footprint" node stocks/fetch-defi-footprint.mjs --run --budget=250 --resolve-budget=15
    if [ "$DEFI_USAGE_FRESH" -eq 1 ]; then
        step "DeFi daily snapshot"; node stocks/snapshot-defi.mjs --run
        step "DeFi daily changes";  node stocks/build-defi-changes.mjs --run
    else
        echo "[$(date -u +%FT%TZ)] WARN skipping DeFi daily snapshot because its source refresh failed"
    fi
fi
step "legal templates before review"; node stocks/build-release-artifacts.mjs --run --phase=pre-review --base-url="$BASE_URL"
step "collector status"; node stocks/build-collector-status.mjs --run
# The same data into schema `sonar` of the geodata database, so it can be grouped and joined.
# --ddl is idempotent; the trade table accumulates past the 24 h window the JSON keeps. No --only,
# so every step runs, the claims and what-if loads included (a new step is picked up here for
# free; a --only list here would have to be edited every time one is added).
step "db";         node stocks/load-db.mjs --run --ddl
step "evidence review queue"; node stocks/build-review-queue.mjs --run
# When the newest first-seen mints were created (a bounded getSignaturesForAddress pass, cached for
# good), so the latest-events feed says "created" or leaves out old tokens the catalogue only just
# found. A failed pass only leaves those rows worded "first seen".
soft "mint creation times" node stocks/fetch-mint-created.mjs --run --budget=30
# Rebuild the public legal surfaces after the database-backed queue exists, so every P0 item is
# visibly propagated to inherited conclusions and token cards in the same refresh.
step "complete release surfaces"; node stocks/build-release-artifacts.mjs --run --phase=surfaces --base-url="$BASE_URL"
# Watch changes are a daily signal for the morning digest. Re-running every six hours would move
# the baseline after the digest and could consume an event before the next morning. The first
# post-deploy run may create the file once so later stats assembly always has a baseline payload.
if [ "$(date -u +%H)" = "00" ] || [ ! -f stocks-watchlist-changes.json ] || [ "${RWA_WATCHLIST_CHECK:-0}" = "1" ]; then
    step "saved watches (daily)"; node stocks/build-watchlist-changes.mjs --run
fi

# 3. Validate all links/semantic joins and record local hashes before publication, then stage every
# artifact. A required build/validation/copy failure retains the last complete generated set.
step "record validated release evidence"; node stocks/release-evidence.mjs --run --base-url="$BASE_URL"
step "stage and publish complete release"; node stocks/publish-release.mjs --run --source="$REPO" --destination="$DOCROOT"
chmod -R u=rwX,go=rX "$DOCROOT/cards" "$DOCROOT/templates" "$DOCROOT/issuers" "$DOCROOT/protocols" "$DOCROOT/stocks/data/history"
# The landing hero and pitch carry build-time counts (stocks/build-static-snapshot.mjs, run in the
# surfaces phase above). They are ordinary site files that only a deploy's rsync would otherwise
# copy, so install them here, each by an atomic rename, to keep the published counts current.
step "static page snapshots"
# Every hand-written page carries build-time counts and a head block (og image hash, JSON-LD)
# written by stocks/build-site-seo.mjs, so all of them are installed, each by an atomic rename.
for page in $(node stocks/build-site-seo.mjs --list-pages); do
    mkdir -p "$DOCROOT/$(dirname "$page")"
    install -m 0644 "$page" "$DOCROOT/$page.next-$$" && mv -f "$DOCROOT/$page.next-$$" "$DOCROOT/$page"
done

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
    printf '{"refreshStatus":"partial","lastRunStartedAt":"%s","lastRunEndedAt":"%s","durationSec":%s,"failures":%s,"failureReasons":["%s"],"failedSteps":"%s","builtAt":"%s","cards":%s,"warning":%s,"defiChanges":%s,"watchChanges":%s,"noticeLines":%s}\n' \
        "$START_ISO" "$(date -u +%FT%TZ)" "$DURATION" "${#SOFT_FAILURES[@]}" "$FAILED_STEPS" "$FAILED_STEPS" "$LOCAL_BUILT" "$CARDS" "$WARN" "$DEFI_CHANGES" "$WATCH_CHANGES" "$NOTICE_LINES" > "$STATS"
    echo "[$(date -u +%FT%TZ)] refresh PARTIAL: step(s) failed: $FAILED_STEPS — site updated with what was fetched; builtAt=$LOCAL_BUILT cards=$CARDS"
    exit 1
fi
printf '{"refreshStatus":"ok","lastRunStartedAt":"%s","lastRunEndedAt":"%s","durationSec":%s,"failures":0,"failureReasons":[],"builtAt":"%s","cards":%s,"warning":%s,"defiChanges":%s,"watchChanges":%s,"noticeLines":%s}\n' \
    "$START_ISO" "$(date -u +%FT%TZ)" "$DURATION" "$LOCAL_BUILT" "$CARDS" "$WARN" "$DEFI_CHANGES" "$WATCH_CHANGES" "$NOTICE_LINES" > "$STATS"
echo "[$(date -u +%FT%TZ)] refresh done: builtAt=$LOCAL_BUILT cards=$CARDS warning=$WARN durationSec=$DURATION"
