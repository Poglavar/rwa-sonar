// Each token's share of all the tokenized shares of its underlying on Solana, counted on what
// investors hold: the outstanding supply (minted, multiplier applied, minus the issuer's own
// wallets), not the minted total, which counts issuer inventory (AAPLx: ~76 % of its mints sit in
// xStocks' treasury). Pure; build-cards.mjs feeds it every token and the card shows the result.

/** Owner labels that mean "the issuer's own wallet" (stocks/lib/holders.mjs). */
export const ISSUER_HELD_LABELS = new Set(['issuer-authority', 'issuer-inventory', 'burn-address']);
/** Instruments whose token unit is not one share of the underlying, so shares cannot be summed. */
export const NOT_SHARE_UNITS = new Set(['leveraged', 'private-company']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * One token's outstanding supply in underlying units, and how it was derived:
 * `float` — the issuer's published float (xStocks: supply minus its inventory wallets, read on chain);
 * `labelled` — supply minus the top-20 holders labelled as issuer wallets;
 * null when the supply is unknown (never guessed as 0).
 */
export function outstandingOf({ supplyUi, top20 = null, publicFloat = null }) {
    const floatUi = num(publicFloat?.floatUi);
    if (floatUi !== null) return { units: floatUi, basis: 'float' };
    const supply = num(supplyUi);
    if (supply === null) return null;
    const held = (Array.isArray(top20) ? top20 : [])
        .filter((row) => ISSUER_HELD_LABELS.has(row?.ownerLabel))
        .reduce((sum, row) => sum + (num(row.sharePct) ?? 0), 0);
    return { units: Math.max(0, supply * (1 - Math.min(held, 100) / 100)), basis: 'labelled', issuerHeldPct: held };
}

/**
 * The share of every eligible token among the tokens of the same underlying on Solana:
 * `Map(mint → {ticker, units, totalUnits, sharePct, tokens, others:[{symbol, units}]})`.
 * `rows` are `{mint, symbol, underlyingTicker, instrumentType, outstanding}` (outstanding from
 * outstandingOf, or null). A ticker with any token of unknown supply gets no shares at all: a
 * share of an incomplete total would be wrong, not approximate.
 */
export function solanaShares(rows) {
    const byTicker = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const ticker = typeof row?.underlyingTicker === 'string' && row.underlyingTicker.trim() ? row.underlyingTicker.trim() : null;
        if (ticker === null || NOT_SHARE_UNITS.has(row.instrumentType)) continue;
        if (!byTicker.has(ticker)) byTicker.set(ticker, []);
        byTicker.get(ticker).push(row);
    }
    const out = new Map();
    for (const [ticker, group] of byTicker) {
        if (group.some((row) => row.outstanding === null || row.outstanding === undefined)) continue;
        const total = group.reduce((sum, row) => sum + row.outstanding.units, 0);
        if (!(total > 0)) continue;
        for (const row of group) {
            out.set(row.mint, {
                ticker,
                units: row.outstanding.units,
                basis: row.outstanding.basis,
                totalUnits: total,
                sharePct: (row.outstanding.units / total) * 100,
                tokens: group.length,
                others: group.filter((other) => other.mint !== row.mint)
                    .map((other) => ({ symbol: other.symbol, units: other.outstanding.units }))
                    .sort((a, b) => b.units - a.units)
            });
        }
    }
    return out;
}
