// PURE shaping for the Meteora pool layer (no network, no fs, no clock): pick the Meteora pools out
// of venues.json and map one DLMM / DAMM / DBC API response into the record data/meteora.json
// stores. Meteora's own API reports what DexScreener does not — pool type, bin step, the configured
// fee tiers, 24 h FEES (not just volume), the dynamic fee actually in force, and a bonding-curve
// pool's config — so this is the layer that turns "a meteora pair" into "a DLMM pool with a 80 bps
// bin step earning $33 of fees a day". Missing values stay null, never 0. Tested in ../meteora.test.js.

import { finiteOrNull, stringOrNull } from './venues.mjs';

/** DexScreener's dexIds that mean Meteora. `meteoradbc` is a Dynamic Bonding Curve launch pool. */
export const METEORA_DEX_IDS = ['meteora', 'meteoradbc'];

/**
 * The live keyless API hosts, probed 2026-09-16.
 *
 * The `*-api.meteora.ag` hosts every guide still names — `dlmm-api.meteora.ag/pair/<address>`,
 * `dammv2-api.meteora.ag/pools/<address>`, `dbc-api.meteora.ag/pools/<address>` — answer 404 for
 * EVERY path now, including `/pair/all` and their own roots, so they are not "our address is
 * unknown there", they are gone. The data API that replaced them is `<product>.datapi.meteora.ag`
 * and takes the pool address as a path segment: a pool of the wrong kind answers a JSON
 * `{"message":"Pool not found: ..."}` with HTTP 404, which is how the probe tells "not this kind"
 * from "the host is down". `?address=` is NOT a filter on the collection routes — they ignore it and
 * hand back page 1 of all 127k pools — so only the per-address route is usable.
 *
 * DAMM v1 has no datapi host (`damm-v1.datapi.meteora.ag` does not resolve a route); its legacy
 * `damm-api.meteora.ag/pools` still answers and DOES filter, but needs both `address` and `page`
 * (`page` missing is a 400 "missing field `page`", `address` missing a 400 "Address cannot be
 * empty"), and it returns an ARRAY — empty when the address is not one of its pools.
 */
export const METEORA_ENDPOINTS = {
    dlmm: (pair) => `https://dlmm.datapi.meteora.ag/pools/${pair}`,
    'damm-v2': (pair) => `https://damm-v2.datapi.meteora.ag/pools/${pair}`,
    'damm-v1': (pair) => `https://damm-api.meteora.ag/pools?address=${pair}&page=0&size=1`,
    dbc: (pair) => `https://dbc.datapi.meteora.ag/pools/${pair}`
};

/** Meteora's Dynamic Bonding Curve program — the owner of a DBC pool account on chain. */
export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

/**
 * Which endpoints to try for one pool, in order, from DexScreener's dexId.
 *
 * A `meteoradbc` pair is a bonding-curve pool, so DBC goes first — but not alone: a DBC pool that
 * has completed its curve MIGRATES to DAMM v2, so a pair DexScreener still labels `meteoradbc` can
 * legitimately answer on the DAMM v2 route, and that is one of the few honest signals of migration
 * available without decoding the account. Everything else is tried too, cheaply: a wrong-kind
 * address is one 404.
 */
export function endpointOrder(dexId) {
    const id = stringOrNull(dexId);
    if (id === 'meteoradbc') return ['dbc', 'damm-v2', 'dlmm', 'damm-v1'];
    return ['dlmm', 'damm-v2', 'damm-v1', 'dbc'];
}

/** snake_case → camelCase for one key. Leaves an already-camel or single-word key alone. */
export function camelKey(key) {
    return String(key).replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

/**
 * Deep snake→camel copy keeping only values that carry a fact: finite numbers, non-empty strings,
 * booleans and nested objects of the same. A null, a NaN, an empty string and an array are dropped
 * — nothing is coerced, so a field the source omits stays absent rather than becoming 0 or "".
 * Booleans are kept deliberately: a `migrated`/`is_completed` flag is exactly what a DBC response
 * would carry if it ever grew one, and dropping booleans would silently lose it.
 */
export function camelizeFinite(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        const name = camelKey(key);
        if (typeof raw === 'boolean') out[name] = raw;
        else if (typeof raw === 'number') {
            if (Number.isFinite(raw)) out[name] = raw;
        } else if (typeof raw === 'string') {
            if (raw.trim() !== '') out[name] = raw;
        } else if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
            const nested = camelizeFinite(raw);
            if (nested !== undefined && Object.keys(nested).length > 0) out[name] = nested;
        }
    }
    return out;
}

/**
 * The two token sides of a datapi pool, resolved against the mint we are tracking:
 * `{own, counter, ownIsX}`. `own` is null when neither side is the mint — a response/address
 * mismatch, which must not silently make the counter-asset's price our token's price.
 */
export function tokenSides(body, mint = null) {
    const x = body?.token_x ?? null;
    const y = body?.token_y ?? null;
    const target = stringOrNull(mint);
    if (target === null) return { own: null, counter: null, ownIsX: null };
    if (stringOrNull(x?.address) === target) return { own: x, counter: y, ownIsX: true };
    if (stringOrNull(y?.address) === target) return { own: y, counter: x, ownIsX: false };
    return { own: null, counter: null, ownIsX: null };
}

/**
 * The tracked token's price in the counter asset, from the pool's `current_price`.
 *
 * `current_price` is token_y per token_x (verified against two pools: MU-USDC reads 933.6 with MU
 * as token_x and MU at $934, and SOL-SPIDERBRAI reads 1,293,752 which is $97.51/$0.0000795). So it
 * is the price of OUR token only when our mint is token_x; on the other side it is inverted, and a
 * zero or absent price inverts to null rather than Infinity.
 */
function priceInCounter(body, ownIsX) {
    const price = finiteOrNull(body?.current_price);
    if (price === null || ownIsX === null) return null;
    if (ownIsX) return price;
    if (price === 0) return null;
    const inverted = 1 / price;
    return Number.isFinite(inverted) ? inverted : null;
}

/** The fields the two datapi shapes (DLMM, DAMM v2) report identically. */
function shapeDatapiCommon(body, mint) {
    const { own, counter, ownIsX } = tokenSides(body, mint);
    const config = body?.pool_config ?? null;
    return {
        poolName: stringOrNull(body?.name),
        baseFeePct: finiteOrNull(config?.base_fee_pct),
        maxFeePct: finiteOrNull(config?.max_fee_pct),
        protocolFeePct: finiteOrNull(config?.protocol_fee_pct),
        dynamicFeePct: finiteOrNull(body?.dynamic_fee_pct),
        fees24Usd: finiteOrNull(body?.fees?.['24h']),
        volume24Usd: finiteOrNull(body?.volume?.['24h']),
        liquidityUsd: finiteOrNull(body?.tvl),
        // The datapi's per-token `price` is in USD (SOL reads 97.5, USDC 0.9997), so this is a real
        // USD price rather than the quote-unit `current_price`, which is kept beside it.
        priceUsd: finiteOrNull(own?.price),
        priceQuote: priceInCounter(body, ownIsX),
        quoteSymbol: stringOrNull(counter?.symbol),
        quoteMint: stringOrNull(counter?.address),
        feeTvlRatio24: finiteOrNull(body?.fee_tvl_ratio?.['24h']),
        apr: finiteOrNull(body?.apr),
        apy: finiteOrNull(body?.apy),
        cumulativeVolumeUsd: finiteOrNull(body?.cumulative_metrics?.volume),
        cumulativeFeesUsd: finiteOrNull(body?.cumulative_metrics?.fees),
        createdAtMs: finiteOrNull(body?.created_at),
        holders: finiteOrNull(own?.holders),
        launchpad: stringOrNull(body?.launchpad),
        isBlacklisted: typeof body?.is_blacklisted === 'boolean' ? body.is_blacklisted : null
    };
}

/**
 * One `dlmm.datapi.meteora.ag/pools/<address>` body → the pool record's Meteora half.
 *
 * `binStep` is the DLMM's bin width in basis points — the one structural number DexScreener never
 * reports and the thing that decides how concentrated the liquidity can be.
 *
 * `maxFeePct` is passed through verbatim and reads **0 on all 21 tokenized-stock pools** while
 * `baseFeePct` is 0.01–10 (measured 2026-09-16). A cap below the base fee is impossible, so that 0
 * means "the source does not populate this", not "the fee is capped at nothing" — it is kept as the
 * source's own value rather than being turned into a null we invented, and the caller notes it.
 */
export function shapeDlmmPair(body, { mint = null } = {}) {
    if (body === null || typeof body !== 'object') return null;
    const address = stringOrNull(body.address);
    if (address === null) return null;
    return {
        poolType: 'dlmm',
        pairAddress: address,
        binStep: finiteOrNull(body.pool_config?.bin_step),
        ...shapeDatapiCommon(body, mint),
        curve: null
    };
}

/**
 * One DAMM body → the same record. Two sources answer for DAMM and their shapes are nothing alike,
 * so the shape itself picks the version:
 *
 * - **v2** (`damm-v2.datapi.meteora.ag/pools/<address>`) is the datapi shape, identical to DLMM's
 *   minus `bin_step` and plus a fee scheduler; `binStep` stays null because a constant-product pool
 *   has no bins.
 * - **v1** (`damm-api.meteora.ag/pools?address=…`) is the legacy shape: `pool_tvl`,
 *   `trading_volume`, `fee_volume`, `total_fee_pct` as STRINGS, and no per-token USD price at all,
 *   so `priceUsd`/`priceQuote` stay null rather than being derived from LP figures.
 *
 * Zero of the 22 tokenized-stock pools were DAMM on 2026-09-16 — every one is DLMM or DBC — but a
 * DBC pool migrates INTO DAMM v2 when its curve completes, so this path is how the section's one
 * bonding-curve pool will read once it graduates.
 */
export function shapeDammPool(body, { mint = null } = {}) {
    if (body === null || typeof body !== 'object') return null;

    const legacyAddress = stringOrNull(body.pool_address);
    if (legacyAddress !== null) {
        return {
            poolType: 'damm-v1',
            pairAddress: legacyAddress,
            binStep: null,
            poolName: stringOrNull(body.pool_name),
            baseFeePct: finiteOrNull(body.total_fee_pct),
            maxFeePct: null,
            protocolFeePct: null,
            dynamicFeePct: null,
            fees24Usd: finiteOrNull(body.fee_volume),
            volume24Usd: finiteOrNull(body.trading_volume),
            liquidityUsd: finiteOrNull(body.pool_tvl),
            priceUsd: null,
            priceQuote: null,
            quoteSymbol: null,
            quoteMint: null,
            feeTvlRatio24: null,
            apr: finiteOrNull(body.apr),
            apy: null,
            cumulativeVolumeUsd: finiteOrNull(body.accumulated_trading_volume),
            cumulativeFeesUsd: finiteOrNull(body.accumulated_fee_volume),
            // v1's created_at is in SECONDS where every datapi shape reports milliseconds.
            createdAtMs: finiteOrNull(body.created_at) === null ? null : finiteOrNull(body.created_at) * 1000,
            holders: null,
            launchpad: null,
            isBlacklisted: null,
            curve: null
        };
    }

    const address = stringOrNull(body.address);
    if (address === null) return null;
    return {
        poolType: 'damm-v2',
        pairAddress: address,
        binStep: null,
        ...shapeDatapiCommon(body, mint),
        curve: null
    };
}

/**
 * One `dbc.datapi.meteora.ag/pools/<address>` body → the record for a bonding-curve pool.
 *
 * What the endpoint returns is IDENTITY and config only: both tokens, both vaults, the creator, the
 * pool config address and `pool_config: {pool_type}`. There is no migration threshold, no curve
 * progress and no migrated flag anywhere on the host (`/pools/<a>/curve`, `/metrics`, `/ohlcv` and
 * the pool-config routes are all 404, and the collection route's items carry the same fields), so
 * every trading figure a DLMM pool reports stays null here rather than reading as zero activity.
 * `curve` is that body, snake→camel, plus the caller's `account` probe — and `curveState` is
 * explicitly null: decoding the 424-byte account layout by guessing would produce numbers that look
 * authoritative and are not.
 */
export function shapeDbcPool(body, { account = null, note = null } = {}) {
    if (body === null || typeof body !== 'object') return null;
    const address = stringOrNull(body.address);
    if (address === null) return null;
    const curve = camelizeFinite(body) ?? {};
    return {
        poolType: 'dbc',
        pairAddress: address,
        binStep: null,
        poolName: null,
        baseFeePct: null,
        maxFeePct: null,
        protocolFeePct: null,
        dynamicFeePct: null,
        fees24Usd: null,
        volume24Usd: null,
        liquidityUsd: null,
        priceUsd: null,
        priceQuote: null,
        quoteSymbol: null,
        quoteMint: null,
        feeTvlRatio24: null,
        apr: null,
        apy: null,
        cumulativeVolumeUsd: null,
        cumulativeFeesUsd: null,
        createdAtMs: finiteOrNull(body.created_at),
        holders: null,
        launchpad: null,
        isBlacklisted: null,
        curve: {
            ...curve,
            account: account === null || typeof account !== 'object' ? null : account,
            curveState: null,
            migrated: null,
            note: stringOrNull(note)
        }
    };
}

/**
 * Every Meteora pool in venues.json, one record per pair, with the DexScreener figures it came with
 * kept beside it so the two sources can be compared rather than one silently replacing the other.
 *
 * Takes the venues document or just its `items` array. Ranked by DexScreener 24 h volume with
 * unreported volumes last, ties on the pair address, so two runs over the same file produce the
 * same order. A pair with no address cannot be queried and is dropped.
 */
export function selectMeteoraPools(venuesItems) {
    const items = Array.isArray(venuesItems) ? venuesItems : (Array.isArray(venuesItems?.items) ? venuesItems.items : []);
    const pools = [];
    for (const item of items) {
        const mint = stringOrNull(item?.mint);
        if (mint === null) continue;
        for (const pair of Array.isArray(item?.dex) ? item.dex : []) {
            const dexId = stringOrNull(pair?.dexId);
            if (dexId === null || !METEORA_DEX_IDS.includes(dexId)) continue;
            const pairAddress = stringOrNull(pair?.pairAddress);
            if (pairAddress === null) continue;
            pools.push({
                mint,
                symbol: stringOrNull(item?.symbol),
                issuer: stringOrNull(item?.issuer),
                pairAddress,
                dexId,
                quoteSymbol: stringOrNull(pair?.quoteSymbol),
                dexscreener: {
                    liquidityUsd: finiteOrNull(pair?.liquidityUsd),
                    volume24Usd: finiteOrNull(pair?.volume24Usd),
                    txns24: finiteOrNull(pair?.txns24)
                }
            });
        }
    }
    pools.sort((a, b) => {
        const av = a.dexscreener.volume24Usd;
        const bv = b.dexscreener.volume24Usd;
        if (av !== bv) {
            if (av === null) return 1;
            if (bv === null) return -1;
            return bv - av;
        }
        return a.pairAddress < b.pairAddress ? -1 : a.pairAddress > b.pairAddress ? 1 : 0;
    });
    return pools;
}
