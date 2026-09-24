// PURE helpers for the venue layer (no network, no fs, no clock): shape one DexScreener pair and
// one CoinGecko ticker into the record `data/venues.json` stores, index the CoinGecko coin list by
// Solana mint, and aggregate venues by name and by issuer. Every sum keeps "missing" as null
// instead of letting it become a plausible-looking 0. Unit-tested in stocks/venues.test.js.

/**
 * A finite number, or null. Never turns null/''/'abc' into 0, which `Number()` would.
 *
 * This is the same function as `toFiniteNumber` in lib/grade.mjs, and `sumOrNull` below is the same
 * as its private `sumFinite`. Kept local deliberately: grade.mjs is the grading model, downstream of
 * this file, so importing from it would invert the layering for a seven-line parser. They are ES
 * modules, so neither shadows the other — but if a shared numeric helper ever lands in lib/io.mjs,
 * BOTH copies should collapse into it.
 */
export function finiteOrNull(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/** A non-empty string, or null. */
export function stringOrNull(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Sum that stays null when nothing summable was seen. A venue with no liquidity figure at all must
 * not report $0 liquidity — that reads as "measured and empty" rather than "not reported".
 */
export function sumOrNull(values) {
    let total = null;
    for (const value of values) {
        const num = finiteOrNull(value);
        if (num === null) continue;
        total = total === null ? num : total + num;
    }
    return total;
}

/**
 * One DexScreener pair → `{dexId, pairAddress, quoteSymbol, priceUsd, liquidityUsd, volume24Usd,
 * txns24, url}`.
 *
 * `priceUsd` arrives as a STRING ("334.17"), so it is parsed rather than trusted; an absent or
 * unparseable price stays null, which is what keeps a pool out of the cross-venue spread instead of
 * anchoring it at $0.
 *
 * `txns24` is `txns.h24.buys + sells` — the trade COUNT on that pool, which is the only per-trade
 * figure either source reports and the input to the wash-trading tell (MODEL.md §11.1). A pair
 * whose response carries no `txns.h24` at all keeps it null: a pool nobody traded on and a pool
 * whose counts were not reported must not read the same.
 *
 * `quoteSymbol` is the COUNTER-asset: normally `quoteToken.symbol`, but the endpoint can also
 * return a pair in which the queried mint is itself the quote side, and dropping those would lose
 * real venues, so the base symbol is used instead. A pair naming the mint on neither side is a
 * response mismatch and returns null, as does one on another chain or with no dex/pair identity.
 *
 * `quoteMint` is that same counter-asset's address — `quoteToken.address`, or `baseToken.address`
 * on the flipped pair, so the two counter-asset fields always describe ONE asset. The trade
 * collector (MODEL.md §12.2) matches it against the pool's token balances to find the quote leg of
 * a swap, so a `quoteMint` that named the tracked mint itself would divide a delta by itself and
 * report every trade at a price of 1.
 */
export function shapeDexPair(pair, mint = null) {
    if (pair === null || typeof pair !== 'object') return null;
    const chainId = stringOrNull(pair.chainId);
    if (chainId !== null && chainId !== 'solana') return null;

    const dexId = stringOrNull(pair.dexId);
    const pairAddress = stringOrNull(pair.pairAddress);
    if (dexId === null || pairAddress === null) return null;

    const baseAddress = stringOrNull(pair.baseToken?.address);
    const quoteAddress = stringOrNull(pair.quoteToken?.address);
    let quoteSymbol = stringOrNull(pair.quoteToken?.symbol);
    let quoteMint = quoteAddress;
    if (mint !== null && mint !== '') {
        if (baseAddress === mint) {
            // normal case: the mint is the base, the counter-asset is the quote token
        } else if (quoteAddress === mint) {
            quoteSymbol = stringOrNull(pair.baseToken?.symbol);
            quoteMint = baseAddress;
        } else {
            return null;
        }
    }

    return {
        dexId,
        pairAddress,
        quoteSymbol,
        quoteMint,
        priceUsd: finiteOrNull(pair.priceUsd),
        liquidityUsd: finiteOrNull(pair.liquidity?.usd),
        volume24Usd: finiteOrNull(pair.volume?.h24),
        txns24: sumOrNull([pair.txns?.h24?.buys, pair.txns?.h24?.sells]),
        url: stringOrNull(pair.url)
    };
}

/**
 * One CoinGecko ticker → `{market, marketId, base, target, priceUsd, volume24Usd, trustScore, url,
 * lastTradedAt}`. `priceUsd` is `converted_last.usd` — CoinGecko's own USD conversion of the last
 * trade, so it is comparable with a DEX pool's `priceUsd`; `last` is in the target currency and is
 * not. `volume24Usd` is `converted_volume.usd` (the 24 h volume CoinGecko itself
 * converts); `volume` is in base units and is not comparable across tokens. A ticker with no
 * market name cannot be aggregated and returns null. `is_anomaly` / `is_stale` are NOT filtered —
 * this layer reports what the source says.
 */
export function shapeTicker(ticker) {
    if (ticker === null || typeof ticker !== 'object') return null;
    const market = stringOrNull(ticker.market?.name);
    if (market === null) return null;
    return {
        market,
        marketId: stringOrNull(ticker.market?.identifier),
        base: stringOrNull(ticker.base),
        target: stringOrNull(ticker.target),
        priceUsd: finiteOrNull(ticker.converted_last?.usd),
        volume24Usd: finiteOrNull(ticker.converted_volume?.usd),
        trustScore: stringOrNull(ticker.trust_score),
        url: stringOrNull(ticker.trade_url),
        lastTradedAt: stringOrNull(ticker.last_traded_at)
    };
}

/**
 * CoinGecko `coins/list?include_platform=true` → `{ byAddress: Map<mint, coinId>, duplicates }`.
 *
 * Two coin entries can claim the same Solana address (a relisting, a wrapped duplicate). A
 * first-wins index would then depend on the order the 21k-entry list happens to arrive in, so the
 * lexicographically smallest id wins and every collision is reported instead of vanishing.
 */
export function indexSolanaCoinIds(coins) {
    const candidates = new Map();
    for (const coin of Array.isArray(coins) ? coins : []) {
        const id = stringOrNull(coin?.id);
        const address = stringOrNull(coin?.platforms?.solana);
        if (id === null || address === null) continue;
        const existing = candidates.get(address);
        if (existing === undefined) candidates.set(address, [id]);
        else if (!existing.includes(id)) existing.push(id);
    }

    const byAddress = new Map();
    const duplicates = [];
    for (const [address, ids] of candidates) {
        const sorted = [...ids].sort();
        byAddress.set(address, sorted[0]);
        if (sorted.length > 1) duplicates.push({ address, ids: sorted, chosen: sorted[0] });
    }
    duplicates.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    return { byAddress, duplicates };
}

/**
 * Pick the CoinGecko ids that have gone longest without a successful collection. One CoinGecko
 * id can map to more than one mint, so the quota is applied to unique ids, not universe rows.
 * Unseen ids sort first; ties are deterministic. This makes a fixed daily request budget rotate
 * across the whole universe instead of refreshing the same alphabetical prefix forever.
 */
export function selectCoinIdsForRefresh(coinIdByMint, previousItems, limit) {
    const previousByMint = new Map(
        (Array.isArray(previousItems) ? previousItems : [])
            .filter((item) => typeof item?.mint === 'string' && item.mint !== '')
            .map((item) => [item.mint, item])
    );
    const oldestById = new Map();
    for (const [mint, coinId] of coinIdByMint instanceof Map ? coinIdByMint : []) {
        if (typeof coinId !== 'string' || coinId === '') continue;
        const previous = previousByMint.get(mint);
        const sameMapping = previous?.coingeckoId === coinId;
        const parsed = sameMapping && typeof previous?.cexFetchedAt === 'string'
            ? Date.parse(previous.cexFetchedAt)
            : Number.NaN;
        const fetchedMs = Number.isFinite(parsed) ? parsed : null;
        const existing = oldestById.get(coinId);
        if (existing === undefined || fetchedMs === null || (existing !== null && fetchedMs < existing)) {
            oldestById.set(coinId, fetchedMs);
        }
    }

    const ordered = [...oldestById].sort(([aId, aMs], [bId, bMs]) => {
        if (aMs === null && bMs !== null) return -1;
        if (aMs !== null && bMs === null) return 1;
        if (aMs !== bMs) return aMs - bMs;
        return aId < bId ? -1 : aId > bId ? 1 : 0;
    }).map(([id]) => id);
    return limit === null ? ordered : ordered.slice(0, limit);
}

/** Ids ranked by a positive finite measure, largest first, ties by id. Null and 0 never rank. */
function rankedIds(measureById) {
    return [...measureById]
        .filter(([, value]) => value !== null && value > 0)
        .sort(([aId, a], [bId, b]) => (b - a) || (aId < bId ? -1 : aId > bId ? 1 : 0))
        .map(([id]) => id);
}

/**
 * The daily CoinGecko plan in two tiers (MODEL.md §11). The PRIORITY tier is refreshed every day:
 * the coins behind a saved watch first, then the busiest coins, taken alternately from two
 * rankings — last known exchange 24 h volume (Σ cex[].volume24Usd) and DEX pool liquidity
 * (Σ dex[].liquidityUsd, refreshed every six hours). The two measures are not comparable, so
 * neither is converted into the other: alternating keeps one from crowding out the other. The TAIL
 * is every other mapped coin, oldest/unseen first (selectCoinIdsForRefresh), and shares what is
 * left of the daily budget.
 *
 * Only a record whose `coingeckoId` equals today's mapping lends its figures; a coin with no
 * measured activity never enters the priority tier on a missing number.
 *
 * Returns `{ ordered, priority, tail, watched, intervals }` where `ordered` is priority then tail
 * (the input planCoinIdRefresh expects) and `intervals` is the expected days between refreshes per
 * tier: 1 for the priority tier, tail size ÷ remaining daily budget for the tail (null when the
 * budget leaves nothing for the tail, which the caller must refuse).
 */
export function planCexTiers(coinIdByMint, previousItems, { dailyBudget = null, priorityCount = 0, watchedMints = [] } = {}) {
    const mapping = coinIdByMint instanceof Map ? coinIdByMint : new Map();
    const previousByMint = new Map(
        (Array.isArray(previousItems) ? previousItems : [])
            .filter((item) => typeof item?.mint === 'string' && item.mint !== '')
            .map((item) => [item.mint, item])
    );
    const cexVolume = new Map();
    const dexLiquidity = new Map();
    for (const [mint, coinId] of mapping) {
        if (typeof coinId !== 'string' || coinId === '') continue;
        const previous = previousByMint.get(mint);
        const same = previous?.coingeckoId === coinId;
        const volume = same ? sumOrNull((Array.isArray(previous.cex) ? previous.cex : []).map((t) => t?.volume24Usd)) : null;
        // DEX liquidity is a property of the mint and is fresh whatever the CoinGecko mapping says.
        const liquidity = sumOrNull((Array.isArray(previous?.dex) ? previous.dex : []).map((p) => p?.liquidityUsd));
        // One coin id normally maps to one mint; if several, the busiest mint speaks for the coin.
        cexVolume.set(coinId, Math.max(cexVolume.get(coinId) ?? -Infinity, volume ?? -Infinity));
        dexLiquidity.set(coinId, Math.max(dexLiquidity.get(coinId) ?? -Infinity, liquidity ?? -Infinity));
    }
    const finite = (map) => new Map([...map].map(([id, value]) => [id, Number.isFinite(value) ? value : null]));

    const limit = Number.isInteger(priorityCount) && priorityCount > 0 ? priorityCount : 0;
    const priority = [];
    const add = (id) => {
        if (priority.length < limit && id !== undefined && !priority.includes(id)) priority.push(id);
    };
    const watched = [...new Set((Array.isArray(watchedMints) ? watchedMints : [])
        .map((mint) => mapping.get(mint))
        .filter((id) => typeof id === 'string' && id !== ''))].sort();
    for (const id of watched) add(id);
    const byCex = rankedIds(finite(cexVolume));
    const byDex = rankedIds(finite(dexLiquidity));
    for (let i = 0; priority.length < limit && (i < byCex.length || i < byDex.length); i += 1) {
        add(byCex[i]);
        add(byDex[i]);
    }

    const inPriority = new Set(priority);
    const tail = selectCoinIdsForRefresh(mapping, previousItems, null).filter((id) => !inPriority.has(id));
    const tailBudget = dailyBudget === null ? null : dailyBudget - priority.length;
    return {
        ordered: [...priority, ...tail],
        priority,
        tail,
        watched: watched.filter((id) => inPriority.has(id)),
        intervals: {
            priorityDays: priority.length > 0 ? 1 : null,
            tailDays: tail.length === 0 ? null
                : tailBudget === null ? 1
                    : tailBudget > 0 ? tail.length / tailBudget : null
        }
    };
}

/**
 * The mints a saved watch (sonar.stock_watchlist rows) points at, for the priority tier: a token or
 * protocol-market watch names its mint; a comparison watch names an underlying ticker and the
 * issuers selected for it (lib/watchlists.mjs reads it the same way). An issuer watch is left out:
 * one issuer can hold hundreds of mints, and its busy ones already rank by volume.
 */
export function watchedMintsFromWatches(watches, universeItems) {
    const items = Array.isArray(universeItems) ? universeItems : [];
    const mints = new Set();
    for (const watch of Array.isArray(watches) ? watches : []) {
        const type = watch?.watch_type ?? 'comparison';
        if (type === 'token' || type === 'protocol-market') {
            const mint = stringOrNull(watch?.target?.mint);
            if (mint !== null) mints.add(mint);
        } else if (type === 'comparison') {
            const ticker = stringOrNull(watch?.underlying_ticker);
            const issuers = new Set(Array.isArray(watch?.issuer_slugs) ? watch.issuer_slugs : []);
            for (const item of items) {
                if (ticker !== null && item?.underlyingTicker === ticker && issuers.has(item?.issuer) && stringOrNull(item?.mint) !== null) {
                    mints.add(item.mint);
                }
            }
        }
    }
    return [...mints].sort();
}

/** Apply a per-day request ceiling to an already oldest-first list. */
export function planCoinIdRefresh(orderedCoinIds, attemptedIds, completedIds, limit) {
    const ordered = [...new Set(Array.isArray(orderedCoinIds) ? orderedCoinIds : [])];
    if (limit === null) return { coinIds: ordered, newCoinIds: ordered };
    const attempted = attemptedIds instanceof Set ? attemptedIds : new Set(attemptedIds ?? []);
    const completed = completedIds instanceof Set ? completedIds : new Set(completedIds ?? []);
    const alreadyCompleted = ordered.filter((id) => completed.has(id));
    const remainingBudget = Math.max(0, limit - attempted.size);
    const newCoinIds = ordered.filter((id) => !attempted.has(id)).slice(0, remainingBudget);
    return { coinIds: [...alreadyCompleted, ...newCoinIds], newCoinIds };
}

/** Descending by `key` with nulls last, then by venue name ascending, so ties are deterministic. */
export function sortVenues(venues, key = 'volume24Usd') {
    return [...venues].sort((a, b) => {
        const av = finiteOrNull(a?.[key]);
        const bv = finiteOrNull(b?.[key]);
        if (av !== bv) {
            if (av === null) return 1;
            if (bv === null) return -1;
            return bv - av;
        }
        return a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0;
    });
}

/** The first `limit` venues once sorted by `key`. */
export function topVenues(venues, limit = 10, key = 'volume24Usd') {
    return sortVenues(venues, key).slice(0, limit);
}

/** Σ liquidity and Σ volume by venue name over one kind of entry. */
function totalsByVenue(rows, kind) {
    const groups = new Map();
    for (const { mint, venue, liquidityUsd, volume24Usd } of rows) {
        if (venue === null) continue;
        let group = groups.get(venue);
        if (group === undefined) {
            group = { venue, kind, liquidity: [], volume: [], mints: new Set(), entries: 0 };
            groups.set(venue, group);
        }
        group.liquidity.push(liquidityUsd);
        group.volume.push(volume24Usd);
        group.entries += 1;
        if (mint !== null) group.mints.add(mint);
    }
    return [...groups.values()].map((group) => ({
        venue: group.venue,
        kind: group.kind,
        liquidityUsd: sumOrNull(group.liquidity),
        volume24Usd: sumOrNull(group.volume),
        mints: group.mints.size,
        entries: group.entries
    }));
}

/** Flatten venues.json items into one row per DEX pair and one per CoinGecko ticker. */
function venueRows(items) {
    const dex = [];
    const cex = [];
    for (const item of Array.isArray(items) ? items : []) {
        const mint = stringOrNull(item?.mint);
        for (const pair of Array.isArray(item?.dex) ? item.dex : []) {
            dex.push({ mint, venue: stringOrNull(pair?.dexId), liquidityUsd: pair?.liquidityUsd, volume24Usd: pair?.volume24Usd });
        }
        for (const ticker of Array.isArray(item?.cex) ? item.cex : []) {
            cex.push({ mint, venue: stringOrNull(ticker?.market), liquidityUsd: null, volume24Usd: ticker?.volume24Usd });
        }
    }
    return { dex, cex };
}

/**
 * All venues across the given items, aggregated by name:
 * `{ dex: [{venue, kind:'dex', liquidityUsd, volume24Usd, mints, entries}], cex: [...] }`.
 * DEX totals are sorted by Σ liquidity (the deeper measure DexScreener reports), CoinGecko markets
 * by Σ 24 h volume, which is the only figure a ticker carries.
 */
export function aggregateVenues(items) {
    const rows = venueRows(items);
    return {
        dex: sortVenues(totalsByVenue(rows.dex, 'dex'), 'liquidityUsd'),
        cex: sortVenues(totalsByVenue(rows.cex, 'cex'), 'volume24Usd')
    };
}

/**
 * One row per issuer: token counts, Σ liquidity / Σ volume, every venue it trades on, and its top
 * venue. `topVenue` ranks by Σ 24 h volume — the one figure both a DEX pair and a CoinGecko ticker
 * report, so the comparison is apples to apples — falling back to Σ liquidity when no venue has a
 * volume figure. `topDexVenue` (by Σ liquidity) and `topCexVenue` (by Σ volume) are kept separate
 * for consumers that must not mix the two measures, e.g. graph edge weights.
 */
export function aggregateByIssuer(items) {
    const byIssuer = new Map();
    for (const item of Array.isArray(items) ? items : []) {
        const issuer = stringOrNull(item?.issuer) ?? 'unknown';
        let group = byIssuer.get(issuer);
        if (group === undefined) {
            group = { issuer, items: [] };
            byIssuer.set(issuer, group);
        }
        group.items.push(item);
    }

    const rows = [...byIssuer.values()].map(({ issuer, items: own }) => {
        const venues = aggregateVenues(own);
        const all = [...venues.dex, ...venues.cex];
        const byVolume = sortVenues(all, 'volume24Usd');
        const topByVolume = byVolume.find((v) => finiteOrNull(v.volume24Usd) !== null) ?? null;
        const topByLiquidity = sortVenues(all, 'liquidityUsd').find((v) => finiteOrNull(v.liquidityUsd) !== null) ?? null;
        return {
            issuer,
            tokens: own.length,
            tokensWithDex: own.filter((i) => Array.isArray(i?.dex) && i.dex.length > 0).length,
            tokensWithCex: own.filter((i) => Array.isArray(i?.cex) && i.cex.length > 0).length,
            dexLiquidityUsd: sumOrNull(venues.dex.map((v) => v.liquidityUsd)),
            dexVolume24Usd: sumOrNull(venues.dex.map((v) => v.volume24Usd)),
            cexVolume24Usd: sumOrNull(venues.cex.map((v) => v.volume24Usd)),
            venues: byVolume,
            topVenue: topByVolume ?? topByLiquidity,
            topDexVenue: venues.dex.find((v) => finiteOrNull(v.liquidityUsd) !== null) ?? venues.dex[0] ?? null,
            topCexVenue: venues.cex[0] ?? null
        };
    });

    return rows.sort((a, b) => (a.issuer < b.issuer ? -1 : a.issuer > b.issuer ? 1 : 0));
}
