// PURE helpers for reading Pyth prices straight off Solana, with no key: the Pyth push oracle keeps
// one PriceUpdateV2 account per feed and shard at the PDA [shard u16 LE, 32-byte feed id], owned by
// the Pyth Solana Receiver. This file derives those addresses, decodes an account into a price with
// its confidence and Pyth's OWN publish time, matches a token to its tokenized-stock feed
// (Crypto.<SYMBOL>/USD), plans one bounded getMultipleAccounts read and shapes what
// stocks/fetch-pyth-onchain.mjs writes. No network and no clock. Tested in ../pyth-onchain.test.js.

import { findProgramAddress } from './solana-address.mjs';
import { CLOCK_SYSVAR, decodePriceUpdateV2 } from './lending-events.mjs';
import { premiumPct } from './pyth.mjs';
import { chunk, MAX_ACCOUNTS_PER_REQUEST } from './solana-rpc.mjs';

/** The Pyth push-oracle program whose PDAs hold the sponsored price-feed accounts. */
export const PYTH_PUSH_ORACLE_PROGRAM = 'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT';
/** The Pyth Solana Receiver, which owns every PriceUpdateV2 account. */
export const PYTH_RECEIVER_PROGRAM = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
/**
 * The shards read. On 2026-09-25 the US equity feeds were current on shard 1 and frozen on shard 0
 * (the accounts Loopscale reads), the xStocks token feeds existed on shard 0 only, and shards 2-9
 * held none of the feeds probed. Both are read, and the freshest valid one is shown.
 */
export const PYTH_SHARDS = [0, 1];
/** Pyth's public page per feed; a real feed answers 200 with its name, an unknown one 404 (checked 2026-09-25). */
export const PYTH_FEED_PAGE = 'https://app.pyth.com/explore/';
/** A token price older than the stock's by more than this is a stale reading, not a gap. */
export const GAP_TOLERANCE_S = 900;
/** The Jupiter price and the Pyth read must be this close for a premium to mean anything. */
export const PREMIUM_MAX_APART_S = 3600;

/**
 * The words each issuer's tokenized-stock feeds carry in their description ("APPLE XSTOCK / US
 * DOLLAR", "APPLE ONDO TOKENIZED STOCK / US DOLLAR"). A symbol match alone is not enough: the crypto
 * list also has Crypto.AMC/USD ("A MEME COIN"), Crypto.GMX/USD and Crypto.LION/USD, whose tickers
 * collide with the stock tokens AMC, GMx and LIon.
 */
const TOKEN_FEED_DESCRIPTIONS = {
    'xstocks-backed': /\bXSTOCK\b/,
    'ondo-global-markets': /\bONDO TOKENIZED STOCK\b/
};

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isoFromUnix(seconds) {
    return finite(seconds) === null ? null : new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function unixFromIso(iso) {
    const ms = Date.parse(typeof iso === 'string' ? iso : '');
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The push-oracle account for one feed on one shard. */
export function priceFeedAddress(feedIdHex, shard) {
    if (typeof feedIdHex !== 'string' || !/^[0-9a-f]{64}$/i.test(feedIdHex.replace(/^0x/, ''))) {
        throw new Error(`not a Pyth feed id (32 bytes of hex): ${feedIdHex}`);
    }
    if (!Number.isInteger(shard) || shard < 0 || shard > 0xffff) throw new Error(`Pyth shard must be a u16, got ${shard}`);
    const shardSeed = Buffer.alloc(2);
    shardSeed.writeUInt16LE(shard);
    return findProgramAddress([shardSeed, Buffer.from(feedIdHex.replace(/^0x/, ''), 'hex')], PYTH_PUSH_ORACLE_PROGRAM).address;
}

/** Pyth's public page for a feed symbol, e.g. …/explore/Equity.US.AAPL%2FUSD. */
export function feedPageUrl(symbol) {
    return typeof symbol === 'string' && symbol.trim() ? `${PYTH_FEED_PAGE}${encodeURIComponent(symbol.trim())}` : null;
}

/** The keyless crypto feed list indexed by symbol, first entry wins. */
export function indexTokenFeeds(feeds) {
    const index = new Map();
    for (const feed of Array.isArray(feeds) ? feeds : []) {
        const symbol = feed?.attributes?.symbol;
        if (typeof symbol === 'string' && symbol !== '' && !index.has(symbol)) index.set(symbol, feed);
    }
    return index;
}

/**
 * The token's own Pyth feed, or null: the EXACT symbol `Crypto.<SYMBOL>/USD` and a description that
 * names the token's issuer. Only xStocks and Ondo publish such feeds today.
 */
export function tokenFeedFor(token, index) {
    const symbol = typeof token?.symbol === 'string' ? token.symbol.trim() : '';
    const pattern = TOKEN_FEED_DESCRIPTIONS[token?.issuer];
    if (symbol === '' || !pattern || !(index instanceof Map)) return null;
    const feed = index.get(`Crypto.${symbol.toUpperCase()}/USD`) ?? null;
    return feed !== null && pattern.test(String(feed.attributes?.description ?? '')) && typeof feed.id === 'string' ? feed : null;
}

/**
 * One account as read: `{exists: false}` when the address holds nothing; otherwise the decoded
 * price, confidence and publish time. An account that is not a PriceUpdateV2, or that carries a
 * different feed than the one its address was derived for, keeps every price field null.
 */
export function readingFrom(account, expectedFeedId) {
    if (account === null || account === undefined) return { exists: false };
    const data = Array.isArray(account.data) ? account.data[0] : account.data;
    const decoded = account.owner === undefined || account.owner === PYTH_RECEIVER_PROGRAM ? decodePriceUpdateV2(data) : null;
    const expected = typeof expectedFeedId === 'string' ? expectedFeedId.replace(/^0x/, '').toLowerCase() : null;
    const empty = { exists: true, feedMismatch: false, verification: null, price: null, conf: null, expo: null, publishTime: null, publishedAt: null, postedSlot: null };
    if (decoded === null) return empty;
    if (expected !== null && decoded.feedId !== expected) return { ...empty, feedMismatch: true };
    return {
        exists: true,
        feedMismatch: false,
        verification: decoded.verification,
        price: finite(decoded.price),
        conf: finite(decoded.conf),
        expo: decoded.expo,
        publishTime: finite(decoded.publishTs),
        publishedAt: isoFromUnix(decoded.publishTs),
        postedSlot: finite(decoded.postedSlot)
    };
}

/** The reading with the newest publish time among those with a positive price, or null. */
export function freshestReading(readings) {
    let best = null;
    for (const r of Array.isArray(readings) ? readings : []) {
        if (!r?.exists || finite(r.price) === null || r.price <= 0 || finite(r.publishTime) === null) continue;
        if (best === null || r.publishTime > best.publishTime) best = r;
    }
    return best;
}

/**
 * The token's 24/7 Pyth price against the stock's latest Pyth price, in percent: what a lender that
 * values collateral at the token price sees while the stock market is closed. Only when the token
 * price is at least as recent as the stock's (within GAP_TOLERANCE_S); an older token price is a
 * stale reading, reported as `reason: 'token-older'` with no percentage.
 */
export function tokenStockGap(token, stock, { toleranceS = GAP_TOLERANCE_S } = {}) {
    if (finite(token?.price) === null || finite(stock?.price) === null || finite(token?.publishTime) === null || finite(stock?.publishTime) === null) return null;
    const apartSeconds = token.publishTime - stock.publishTime;
    if (apartSeconds < -toleranceS) return { comparable: false, pct: null, reason: 'token-older', apartSeconds };
    const pct = premiumPct(token.price, stock.price);
    return pct === null ? null : { comparable: true, pct, reason: null, apartSeconds };
}

/**
 * The token's premium over the stock's on-chain Pyth price, only when the Jupiter price (read at
 * `usdPriceReadAt`) and the Pyth read (`pythReadAt`, the chain clock) are within `maxApartS` of each
 * other; otherwise `reason: 'read-apart'` and no percentage — a Jupiter price from Sunday against a
 * Pyth price from Thursday measures the calendar, not the token.
 */
export function premiumOverPyth(usdPrice, usdPriceReadAt, stock, pythReadAt, { maxApartS = PREMIUM_MAX_APART_S } = {}) {
    if (finite(usdPrice) === null || finite(stock?.price) === null) return null;
    const a = unixFromIso(usdPriceReadAt);
    const b = unixFromIso(pythReadAt);
    if (a === null || b === null) return null;
    const apartSeconds = b - a;
    if (Math.abs(apartSeconds) > maxApartS) return { comparable: false, pct: null, reason: 'read-apart', apartSeconds };
    const pct = premiumPct(usdPrice, stock.price);
    return pct === null ? null : { comparable: true, pct, reason: null, apartSeconds };
}

/**
 * The run's one bounded read: the Clock sysvar (the chain's own "now") followed by every feed's
 * account on every shard, in getMultipleAccounts requests of at most 100 keys. More requests than
 * `maxRequests` is an error, never a silent truncation.
 */
export function planAccountReads(feeds, { shards = PYTH_SHARDS, maxRequests = 32 } = {}) {
    const slots = [];
    for (const feed of Array.isArray(feeds) ? feeds : []) {
        for (const shard of shards) slots.push({ feedId: feed.id, shard, address: priceFeedAddress(feed.id, shard) });
    }
    const requests = chunk([CLOCK_SYSVAR, ...slots.map((s) => s.address)], MAX_ACCOUNTS_PER_REQUEST);
    if (requests.length > maxRequests) {
        throw new Error(`${slots.length} Pyth accounts need ${requests.length} getMultipleAccounts requests, over the cap of ${maxRequests}`);
    }
    return { slots, requests };
}

/**
 * The file stocks/fetch-pyth-onchain.mjs writes, from the plan and the accounts read in the plan's
 * order (Clock first). `readAt` is the Clock sysvar's unix_timestamp — the chain's time for the
 * read — and every account keeps its own publish time; nothing here is our clock.
 */
export function buildPythOnchain({ feeds, plan, accounts, slots, tokens, inputs }) {
    if (!Array.isArray(accounts) || accounts.length !== plan.slots.length + 1) {
        throw new Error(`expected ${plan.slots.length + 1} accounts (Clock first), got ${accounts?.length}`);
    }
    const clock = accounts[0];
    const clockData = clock ? Buffer.from(Array.isArray(clock.data) ? clock.data[0] : clock.data, 'base64') : null;
    const clockUnix = clockData && clockData.length >= 40 ? Number(clockData.readBigInt64LE(32)) : null;
    if (clockUnix === null) throw new Error('Clock sysvar could not be read: no chain time for this read');

    const byFeed = new Map();
    plan.slots.forEach((slot, i) => {
        const list = byFeed.get(slot.feedId) ?? [];
        list.push({ shard: slot.shard, address: slot.address, ...readingFrom(accounts[i + 1], slot.feedId) });
        byFeed.set(slot.feedId, list);
    });
    const outFeeds = feeds.map((feed) => ({
        id: feed.id, symbol: feed.symbol, kind: feed.kind, schedule: feed.schedule ?? null,
        accounts: byFeed.get(feed.id) ?? []
    }));
    const found = outFeeds.flatMap((f) => f.accounts).filter((a) => a.exists);
    return {
        schema: 'rwa-sonar/pyth-onchain@1',
        note: 'Pyth push-oracle PriceUpdateV2 accounts read directly from Solana (no key). publishTime is Pyth\'s own; readAt is the chain\'s Clock sysvar at the read.',
        readAt: isoFromUnix(clockUnix),
        readSlot: finite(slots?.[0]) ?? null,
        program: PYTH_PUSH_ORACLE_PROGRAM,
        receiver: PYTH_RECEIVER_PROGRAM,
        shards: [...new Set(plan.slots.map((s) => s.shard))],
        inputs: inputs ?? {},
        counts: {
            feeds: outFeeds.length,
            stockFeeds: outFeeds.filter((f) => f.kind === 'stock').length,
            tokenFeeds: outFeeds.filter((f) => f.kind === 'token').length,
            accountsRead: plan.slots.length,
            accountsFound: found.length,
            feedMismatches: found.filter((a) => a.feedMismatch).length,
            feedsWithPrice: outFeeds.filter((f) => freshestReading(f.accounts) !== null).length,
            requests: plan.requests.length
        },
        feeds: outFeeds,
        tokens: Array.isArray(tokens) ? tokens : []
    };
}
