// Real outstanding supply ("public float") for xStocks: pure arithmetic for
// stocks/fetch-xstocks-float.mjs. Raw on-chain supply overstates what the public holds, because the
// Base Prospectus defines de-activation as a transfer back to the wallet the Tokenizer holds for the
// Issuer, not a burn — redeemed xStocks return to issuer inventory and stay in `supply`. So
//   public float = mint supply − balances of the issuer-attributed wallets
// computed in RAW base units (BigInt), so the Token-2022 scaled-UI multiplier cancels until display.
// No network, no disk: stocks/xstocks-float.test.js covers it.

/**
 * The issuer-attributed wallets. Each one is cited in the xStocks dossier
 * (stocks/data/issuers/xstocks-backed.json) — `dossierCitations` finds the field paths, and the
 * collector refuses to run if an address is no longer cited, so this list cannot drift from the
 * research. Attribution is from on-chain behaviour documented there; the chain cannot prove that
 * S7vYFF… is "the wallet held by the Tokenizer on behalf of the Issuer".
 */
export const XSTOCKS_ISSUER_WALLETS = [
    { address: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS', role: 'treasury',
        basis: 'Receives every mintTo from the xStocks mint authority, receives every redemption sweep, pays redemption proceeds, and is the scaled-UI (rebase) authority on every xStocks mint.' },
    { address: 'CgyuW2dWDJzWW2H1XTjPRkbg9Y41dW2Fjj69KWsiir8C', role: 'redemption-address',
        basis: 'Holders send xStocks here to redeem; it only ever sweeps them on to the treasury (tokens in transit).' },
    { address: '7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj', role: 'mint-authority',
        basis: 'The single mint authority on all xStocks mints (a plain funded wallet).' },
    { address: '2f6LxotGVZ3KzvAN3NjJwJSM32WJEkt6uBGEA5YKGEqK', role: 'sweep-fee-payer',
        basis: 'Fee payer of the redemption-address sweeps into the treasury.' },
    { address: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs', role: 'freeze-pause-vault',
        basis: 'Squads v4 vault holding the freeze and pause authority on all xStocks mints.' },
    { address: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq', role: 'permanent-delegate-vault',
        basis: 'Squads v4 vault holding the permanent-delegate and transfer-hook authority on all xStocks mints.' },
    // Added 2026-09-24 from the xStocks dossier finding: stocked only by treasury transfers, and the
    // issuer's own proof-of-reserves "circulating" figure excludes its balances (95 of 97 zero-
    // circulating mints have supply = treasury + this wallet). Operator not identified.
    { address: '9U76mo3WuP28s4kYJ9CMH1CiQh6Ph3r5Zg5awZM5vMQd', role: 'issuer-inventory',
        basis: 'Stocked only by transfers from the treasury; sells xStocks against USDC in two-party order-tagged swaps; its balances are excluded from the issuer\'s own circulating figure.' }
];

export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const isRaw = (value) => typeof value === 'string' && /^\d+$/.test(value);

/** Every JSON path in `dossier` whose string value contains `address`. */
export function dossierCitations(dossier, addresses) {
    const out = Object.fromEntries(addresses.map((a) => [a, []]));
    const walk = (node, path) => {
        if (typeof node === 'string') {
            for (const a of addresses) if (node.includes(a)) out[a].push(path);
        } else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
        else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    };
    walk(dossier, '');
    return out;
}

/**
 * Supply, decimals and the scaled-UI multiplier IN FORCE at `nowSeconds` from one jsonParsed mint
 * account (a scheduled newMultiplier counts once its effective timestamp has passed). Null fields,
 * never zeros, when the account does not say.
 */
export function mintFacts(account, nowSeconds) {
    const info = account?.data?.parsed?.type === 'mint' ? account.data.parsed.info : null;
    if (!info) return { supplyRaw: null, decimals: null, uiMultiplier: null };
    const scaled = (info.extensions ?? []).find((e) => e?.extension === 'scaledUiAmountConfig')?.state ?? null;
    let uiMultiplier = '1';
    if (scaled) {
        const due = Number(scaled.newMultiplierEffectiveTimestamp);
        uiMultiplier = Number.isFinite(due) && due > 0 && due <= nowSeconds ? String(scaled.newMultiplier) : String(scaled.multiplier);
        if (!Number.isFinite(Number(uiMultiplier))) uiMultiplier = null;
    }
    return {
        supplyRaw: isRaw(info.supply) ? info.supply : null,
        decimals: Number.isInteger(info.decimals) ? info.decimals : null,
        uiMultiplier
    };
}

/**
 * Sum issuer-wallet balances per mint (raw, BigInt), keeping the per-wallet split.
 * `byWallet` is { address: [{mint, amount}] } from getTokenAccountsByOwner; only mints in `mints`
 * count. A wallet can hold several token accounts for one mint (the treasury does), so all add up.
 */
export function sumInventory(byWallet, mints) {
    const out = new Map();
    for (const [wallet, accounts] of Object.entries(byWallet)) {
        for (const account of accounts ?? []) {
            if (!mints.has(account?.mint) || !isRaw(account.amount)) continue;
            const amount = BigInt(account.amount);
            if (amount === 0n) continue;
            const row = out.get(account.mint) ?? { total: 0n, byWallet: {} };
            row.total += amount;
            row.byWallet[wallet] = String(BigInt(row.byWallet[wallet] ?? '0') + amount);
            out.set(account.mint, row);
        }
    }
    return out;
}

/** base-unit string → token units (Number), scaled by the multiplier when asked. */
export function toUnits(raw, decimals, multiplier = '1') {
    if (!isRaw(raw) || !Number.isInteger(decimals)) return null;
    const m = Number(multiplier);
    if (!Number.isFinite(m)) return null;
    return (Number(raw) / 10 ** decimals) * m;
}

/**
 * One float row per mint. `status`:
 *   ok                 supply and inventory read; float = supply − inventory
 *   no-supply          the mint account could not be read: every derived figure is null
 *   inconsistent-read  inventory exceeded supply (the reads straddled issuance or redemption): null
 * inventorySharePct is null when supply is zero (0/0 is not 0 %).
 */
export function floatRow({ mint, symbol, facts, inventory }) {
    const base = { mint, symbol: symbol ?? null, decimals: facts.decimals, uiMultiplier: facts.uiMultiplier, supplyRaw: facts.supplyRaw };
    const inv = inventory?.total ?? 0n;
    const byWallet = inventory?.byWallet ?? {};
    if (facts.supplyRaw === null || facts.decimals === null) {
        return { ...base, inventoryRaw: String(inv), floatRaw: null, inventorySharePct: null, byWallet, status: 'no-supply' };
    }
    const supply = BigInt(facts.supplyRaw);
    if (inv > supply) {
        return { ...base, inventoryRaw: String(inv), floatRaw: null, inventorySharePct: null, byWallet, status: 'inconsistent-read' };
    }
    const share = supply === 0n ? null : Number((inv * 1000000n) / supply) / 10000;
    return { ...base, inventoryRaw: String(inv), floatRaw: String(supply - inv), inventorySharePct: share, byWallet, status: 'ok' };
}

/**
 * The comparison baseline for "change since the previous read": the latest read from an EARLIER
 * UTC day. A second run on the same day keeps the baseline it already had.
 */
export function rollPrevious(existing, readAt) {
    if (!existing?.readAt || !Array.isArray(existing.items)) return existing?.previous ?? null;
    if (existing.readAt.slice(0, 10) < readAt.slice(0, 10)) {
        return {
            readAt: existing.readAt,
            floats: Object.fromEntries(existing.items.filter((i) => i.status === 'ok').map((i) => [i.mint, i.floatRaw]))
        };
    }
    return existing.previous ?? null;
}

/**
 * Aggregate USD for one read, priced with `priceOf(mint)` (a displayed-unit USD price or null).
 * Unpriced mints are counted and left out of the dollar sums, which are therefore lower bounds and
 * say so via `unpricedMints`.
 */
export function aggregate(items, priceOf) {
    const sum = { supplyUsd: 0, inventoryUsd: 0, floatUsd: 0, pricedMints: 0, unpricedMints: 0, inconsistentMints: 0, mints: items.length };
    for (const item of items) {
        if (item.status === 'inconsistent-read') { sum.inconsistentMints += 1; continue; }
        if (item.status !== 'ok' || item.supplyRaw === '0') continue;
        const price = priceOf(item.mint);
        if (!(typeof price === 'number' && Number.isFinite(price) && price > 0)) { sum.unpricedMints += 1; continue; }
        sum.pricedMints += 1;
        sum.supplyUsd += toUnits(item.supplyRaw, item.decimals, item.uiMultiplier) * price;
        sum.inventoryUsd += toUnits(item.inventoryRaw, item.decimals, item.uiMultiplier) * price;
        sum.floatUsd += toUnits(item.floatRaw, item.decimals, item.uiMultiplier) * price;
    }
    sum.inventorySharePct = sum.supplyUsd > 0 ? (sum.inventoryUsd / sum.supplyUsd) * 100 : null;
    for (const k of ['supplyUsd', 'inventoryUsd', 'floatUsd']) sum[k] = Math.round(sum[k]);
    if (sum.inventorySharePct !== null) sum.inventorySharePct = Math.round(sum.inventorySharePct * 100) / 100;
    return sum;
}

/** Keep one history row per UTC day (the day's latest read), newest last, at most `keep` days. */
export function pushHistory(history, row, keep = 60) {
    const byDate = new Map((Array.isArray(history) ? history : []).map((r) => [r.date, r]));
    byDate.set(row.date, row);
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-keep);
}

/** The compact per-token record the static cards show (stocks/lib/cards.mjs `floatItem`), or null. */
export function cardFloatItem(floatFile, mint) {
    const item = (floatFile?.items ?? []).find((i) => i.mint === mint);
    if (!item || item.status !== 'ok') return null;
    const floatUi = toUnits(item.floatRaw, item.decimals, item.uiMultiplier);
    return floatUi === null ? null : { floatUi, inventorySharePct: item.inventorySharePct, readAt: floatFile.readAt ?? null };
}
