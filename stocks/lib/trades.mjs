// PURE decode and bucketing for the live tape (MODEL.md §12): turn one `getTransaction`
// jsonParsed result into one trade on one sampled pool, roll a list of trades into the 24 hourly
// buckets the replay animates, and shape the published `stocks-trades.json`. No network, no fs, no
// clock of its own — every function that needs "now" takes it — so the same file runs inside the
// collector and as a browser ES module on live.html. Unit-tested in stocks/trades.test.js.

/** The quote assets whose USD value is known without a price lookup, and the one that needs one. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/** Every transaction on these pools carries compute-budget instructions; they identify nothing. */
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

/**
 * Per-dex vault owners that are NOT the pool address.
 *
 * Most pools here own their own vaults, so `owner === pairAddress` finds both legs of a swap. Some
 * AMMs instead park every pool's vaults under one program authority PDA: Raydium's CP-Swap does,
 * with the single authority below, which is why the DKNG/ALLINU pool — the section's largest by 24 h
 * volume — decoded nothing at all on the first two runs (19 transactions fetched, 0 trades).
 *
 * The cost of using it is that the authority is SHARED: it owns the vaults of every CP-Swap pool, so
 * a transaction hitting two of them puts both pools' legs under one owner. `decodeTrade` therefore
 * only accepts an alias match when exactly ONE authority-owned account moved the mint, and marks
 * what it produced `decodeVia: 'shared-authority'` so a consumer can tell the two paths apart.
 *
 * Only add an address here that can be cited from the program's own documentation or verified
 * on-chain. This one is Raydium CP-Swap's `authority` PDA, observed owning both vaults of the
 * DKNG/ALLINU and other CPMM pools (2026-09-16).
 */
export const POOL_AUTHORITY_ALIASES = {
    raydium: ['GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL']
};

export const HOUR_MS = 3600000;
export const WINDOW_HOURS = 24;

/**
 * How far a decoded price may sit from the pool's own reference price before the trade is treated as
 * an artefact rather than a print.
 *
 * A transaction that swaps through the SAME pool twice — in and back out — leaves a token delta that
 * nets to almost nothing while both quote legs land in full, so `quoteAmount / size` explodes. That
 * is how a real NVDAx row came out as "buy 0.0082 @ $60,799.88" against a share worth ~$180. The
 * number is arithmetically correct and economically meaningless, and it fed stored `priceUsd` and
 * every hourly volume built from it. 25% is wide enough to pass a genuine large print moving the
 * pool (these are thin pools) and narrow enough that a netted round trip cannot hide in it.
 */
export const SUSPECT_PRICE_TOLERANCE = 0.25;

/**
 * A finite number, or null. Never turns null/''/'abc' into 0.
 *
 * Third copy of this guard (lib/venues.mjs and lib/grade.mjs have the others) and deliberately
 * local, because this file must import nothing at all to stay loadable as a browser module. It
 * earns its keep here twice over: a token balance of zero comes back as `uiAmount: null` with
 * `uiAmountString: "0"` (measured on the SPYx pool, 2026-09-16), so a truthiness check would drop a
 * real zero, and `Number(null)` would invent one where the field is genuinely absent.
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
 * Sum that stays null when nothing summable was seen, so an hour in which no trade could be priced
 * reports "not measured" rather than $0 of volume.
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

/** ISO to whole seconds, matching lib/io.mjs `ts()` so every timestamp in the repo reads alike. */
export function isoSeconds(ms) {
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A chain timestamp is the SOURCE's own instant, so `blockTime` is used verbatim and a transaction
 * that has none gets `time: null` — never the collector's clock, which would quantise every trade
 * to the polling interval and look exactly like real per-trade data.
 */
export function timeFromBlockTime(blockTime) {
    const seconds = finiteOrNull(blockTime);
    return seconds === null ? null : isoSeconds(seconds * 1000);
}

/** Milliseconds for an ISO string or a number of milliseconds; null when neither parses. */
export function msOf(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/**
 * USD per unit of the pool's quote asset.
 *
 * DexScreener reports `priceUsd` (USD per base token) and `priceNative` (quote tokens per base
 * token) for the same pool, so their ratio is USD per QUOTE token — the SOL price implied by that
 * very pool, which is what a SOL-quoted trade must be converted at. USDC and USDT are taken as 1.
 * Anything else — and these pools do quote in other things, the largest by volume quotes in a
 * memecoin — returns **null**, so its trades carry a size and a price in quote units and no USD
 * figure at all. Inventing a rate there would put a fabricated dollar volume in the totals.
 */
export function quoteUsdRate({ quoteMint, priceUsd, priceNative } = {}) {
    const mint = stringOrNull(quoteMint);
    if (mint === USDC_MINT || mint === USDT_MINT) return 1;
    if (mint !== WSOL_MINT) return null;
    const usd = finiteOrNull(priceUsd);
    const native = finiteOrNull(priceNative);
    if (usd === null || native === null || native === 0) return null;
    const rate = usd / native;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Every DEX pair in `venues.json` as a pool record, unranked. A pair with no address is dropped. */
function poolRecords(venues) {
    const pools = [];
    for (const item of Array.isArray(venues?.items) ? venues.items : []) {
        const mint = stringOrNull(item?.mint);
        if (mint === null) continue;
        for (const pair of Array.isArray(item?.dex) ? item.dex : []) {
            const pairAddress = stringOrNull(pair?.pairAddress);
            if (pairAddress === null) continue;
            pools.push({
                pair: pairAddress,
                mint,
                symbol: stringOrNull(item?.symbol),
                dex: stringOrNull(pair?.dexId),
                quoteMint: stringOrNull(pair?.quoteMint),
                quoteSymbol: stringOrNull(pair?.quoteSymbol),
                volume24Usd: finiteOrNull(pair?.volume24Usd)
            });
        }
    }
    return pools;
}

/** 24 h volume descending with unreported volumes last, ties on the pair address. */
function byVolumeThenPair(a, b) {
    if (a.volume24Usd !== b.volume24Usd) {
        if (a.volume24Usd === null) return 1;
        if (b.volume24Usd === null) return -1;
        return b.volume24Usd - a.volume24Usd;
    }
    return a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0;
}

/**
 * A `--pin=a,b --pin=c` list → `['a','b','c']`: comma-split, trimmed, blanks and repeats dropped,
 * order kept. Takes one string or the list of every occurrence of the flag.
 */
export function parsePinList(value) {
    const entries = Array.isArray(value) ? value : [value];
    const out = [];
    for (const entry of entries) {
        if (typeof entry !== 'string') continue;
        for (const part of entry.split(',')) {
            const address = part.trim();
            if (address !== '' && !out.includes(address)) out.push(address);
        }
    }
    return out;
}

/**
 * Pinned pair addresses → `{pinned, unknown}`: the pool record for each address that venues.json
 * actually lists, and the addresses it does not. An unknown address is REPORTED rather than
 * ignored: a typo in a pin would otherwise look exactly like a pool that is being sampled, and the
 * collector would run for hours producing no tape for it.
 */
export function resolvePins(venues, pin = []) {
    const byPair = new Map(poolRecords(venues).map((pool) => [pool.pair, pool]));
    const pinned = [];
    const unknown = [];
    for (const address of parsePinList(pin)) {
        const pool = byPair.get(address);
        if (pool === undefined) unknown.push(address);
        else pinned.push(pool);
    }
    return { pinned, unknown };
}

/**
 * The pools to sample, from `venues.json`: every DEX pair flattened out of `items[].dex[]`, ranked
 * by 24 h volume with unreported volumes last, cut to `limit`. Ties break on the pair address so
 * two runs over the same file pick the same pools. A pair with no address cannot be queried and is
 * dropped. The rank is re-derived on every run, so a pool that goes quiet drops out by itself.
 *
 * `pin` names pair addresses that must be sampled WHATEVER their volume, appended after the top
 * `limit` — so the result is limit + pins pools, not the top pool displaced by a pin. That is the
 * only way a pool the ranking will never reach can get a tape at all: the section's one Dynamic
 * Bonding Curve pool (TSMon) reports no liquidity and $0 of 24 h volume, so it sits at the very
 * bottom of the rank and would never be sampled, yet whether anything trades on it is exactly the
 * question worth asking of a bonding-curve launch. A pin already inside the top `limit` is not
 * duplicated, and an address venues.json does not list is silently absent here — call `resolvePins`
 * to see it (the collector does, and refuses to start).
 */
export function selectPools(venues, limit = 15, { pin = [] } = {}) {
    const ranked = poolRecords(venues).sort(byVolumeThenPair);
    const top = ranked.slice(0, Math.max(0, limit));
    const inTop = new Set(top.map((pool) => pool.pair));
    const { pinned } = resolvePins(venues, pin);
    return [...top, ...pinned.filter((pool) => !inTop.has(pool.pair))];
}

/**
 * The same list, started from `offset`.
 *
 * The pools are ranked by volume every run, but a budget of 120 over 15 pools does not divide
 * evenly once some pools have fewer new signatures than their share, and whoever comes first takes
 * the remainder. Rotating the start by the run counter moves that advantage round the list instead
 * of giving it to the same two or three pools every single run. It changes only WHO gets the
 * leftovers — the ranking itself is untouched.
 */
export function rotatePools(pools, offset = 0) {
    const list = Array.isArray(pools) ? pools : [];
    if (list.length === 0) return [];
    const size = list.length;
    const start = ((Math.trunc(finiteOrNull(offset) ?? 0) % size) + size) % size;
    return [...list.slice(start), ...list.slice(0, start)];
}

/**
 * One `getSignaturesForAddress` page → `{ok, failed}`.
 *
 * A signature with an `err` is a transaction that reverted: it changed no balance, so there is
 * nothing in it to decode and fetching it would spend a request to learn that. They are not noise
 * to be dropped either — on a hot pool most of them are losing arbitrage bots, and their share is
 * the one honest measure of how much of the "activity" on a pool never happened. So they are
 * counted and never fetched. Measured on the SPYx Raydium pool, 2026-09-16: 6 of the newest 50.
 */
export function partitionSignatures(signatures, { pair = null } = {}) {
    const ok = [];
    const failed = [];
    for (const entry of Array.isArray(signatures) ? signatures : []) {
        const sig = stringOrNull(entry?.signature) ?? stringOrNull(entry?.sig);
        if (sig === null) continue;
        const record = { sig, pair: stringOrNull(pair), blockTime: finiteOrNull(entry?.blockTime), slot: finiteOrNull(entry?.slot) };
        if (entry?.err === null || entry?.err === undefined) ok.push(record);
        else failed.push(record);
    }
    return { ok, failed };
}

/**
 * Which signatures this run should spend its transaction budget on.
 *
 * Three rules, all of them about not wasting requests. Signatures already known (stored as a trade
 * or already found undecodable) are skipped. So is anything whose `blockTime` is already outside the
 * window, because storing it would prune it in the same breath. What is left is taken OLDEST FIRST,
 * so a budget-limited run extends the block of trades it already has rather than scattering holes
 * through the window.
 *
 * Oldest-first is applied PER POOL, round-robin across pools, not globally. Globally, one quiet pool
 * whose 50 signatures span twenty hours would be older than every trade on a pool doing 50
 * signatures every two minutes, and would swallow the whole budget — the busiest pools, which are
 * the point of the tape, would never be sampled at all.
 *
 * `pairOrder` fixes which pool the round-robin starts from, and therefore which pools get the
 * remainder when the budget does not divide evenly. The caller rotates it per run so the same busy
 * pools do not always take the extra requests; without it the order is the order the candidates
 * arrived in, never an alphabetical sort, which would quietly favour whichever pool addresses
 * happen to sort first.
 */
export function selectSignaturesToFetch(candidates, { now = Date.now(), budget = 120, windowHours = WINDOW_HOURS, known = [], pairOrder = null } = {}) {
    const nowMs = msOf(now);
    if (nowMs === null) throw new Error(`selectSignaturesToFetch needs a usable "now", got ${JSON.stringify(now)}`);
    const cutoff = nowMs - windowHours * HOUR_MS;
    const seen = known instanceof Set ? known : new Set(Array.isArray(known) ? known : []);

    const queues = new Map();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const sig = stringOrNull(candidate?.sig) ?? stringOrNull(candidate?.signature);
        if (sig === null || seen.has(sig)) continue;
        const blockTime = finiteOrNull(candidate?.blockTime);
        if (blockTime !== null && blockTime * 1000 < cutoff) continue;
        const pair = stringOrNull(candidate?.pair) ?? '';
        if (!queues.has(pair)) queues.set(pair, []);
        queues.get(pair).push({ ...candidate, sig, pair: stringOrNull(candidate?.pair), blockTime });
    }

    for (const queue of queues.values()) {
        queue.sort((a, b) => {
            // A signature with no blockTime cannot be placed in time, so it goes last.
            const at = a.blockTime ?? Infinity;
            const bt = b.blockTime ?? Infinity;
            if (at !== bt) return at - bt;
            return a.sig < b.sig ? -1 : 1;
        });
    }

    const limit = budget === null ? Infinity : Math.max(0, budget);
    const requested = Array.isArray(pairOrder) ? pairOrder.map((pair) => stringOrNull(pair) ?? '') : [];
    const pairs = [...new Set([...requested, ...queues.keys()])].filter((pair) => queues.has(pair));
    const chosen = [];
    let exhausted = false;
    while (chosen.length < limit && !exhausted) {
        exhausted = true;
        for (const pair of pairs) {
            if (chosen.length >= limit) break;
            const queue = queues.get(pair);
            if (queue.length === 0) continue;
            chosen.push(queue.shift());
            exhausted = false;
        }
    }
    return chosen;
}

/** The raw integer amount as a BigInt, or null when the field is not a plain integer string. */
function rawAmount(balance) {
    const amount = balance?.uiTokenAmount?.amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return null;
    return BigInt(amount);
}

/** The decimal amount the response states, preferring the string form over the float. */
function uiAmount(balance) {
    const block = balance?.uiTokenAmount;
    if (block === null || block === undefined) return null;
    return finiteOrNull(block.uiAmountString) ?? finiteOrNull(block.uiAmount);
}

function decimalsOf(balance) {
    const decimals = finiteOrNull(balance?.uiTokenAmount?.decimals);
    return decimals === null || decimals < 0 ? null : Math.round(decimals);
}

/** Pre and post are paired by account index; only if that is missing do we fall back to the key. */
function balanceKey(balance) {
    const index = finiteOrNull(balance?.accountIndex);
    if (index !== null) return `i${index}`;
    return `k${balance?.owner ?? ''}|${balance?.mint ?? ''}`;
}

/**
 * Per (owner, mint) balance changes across one transaction: `post − pre`, with an account present
 * only in `pre` counting as `−pre` and one only in `post` as `+post` (real: a swap that opens the
 * buyer's token account has more post entries than pre). Only movements are returned — a balance
 * that did not change is not a movement, and the caller's "no pool delta ⇒ undecodable" test
 * depends on that.
 *
 * Each side is read from the RAW INTEGER `amount` and divided by `10**decimals` rather than
 * differencing the two `uiAmount` floats. Same number, two things gained: the zero test is exact,
 * so float residue cannot invent a movement and inflate `routed`; and the float is measurably
 * lossy — one real balance on this pool reported `uiAmount: 17852175.049329627` against
 * `uiAmountString: "17852175.049329628"` (2026-09-16). A balance whose amount cannot be read at all
 * is skipped, which surfaces as an undecodable transaction rather than as a fabricated delta.
 */
export function tokenBalanceDeltas(meta) {
    const pre = new Map();
    const post = new Map();
    for (const balance of Array.isArray(meta?.preTokenBalances) ? meta.preTokenBalances : []) pre.set(balanceKey(balance), balance);
    for (const balance of Array.isArray(meta?.postTokenBalances) ? meta.postTokenBalances : []) post.set(balanceKey(balance), balance);

    const groups = new Map();
    for (const key of new Set([...pre.keys(), ...post.keys()])) {
        const before = pre.get(key) ?? null;
        const after = post.get(key) ?? null;
        const ref = after ?? before;
        const mint = stringOrNull(ref?.mint);
        if (mint === null) continue;
        const owner = stringOrNull(ref?.owner);
        const decimals = decimalsOf(after) ?? decimalsOf(before);

        let delta = null;
        const rawBefore = before === null ? 0n : rawAmount(before);
        const rawAfter = after === null ? 0n : rawAmount(after);
        if (rawBefore !== null && rawAfter !== null && decimals !== null) {
            const moved = rawAfter - rawBefore;
            if (moved === 0n) continue;
            delta = Number(moved) / 10 ** decimals;
        } else {
            // Only when the response withheld the raw amount: difference what it did give.
            const uiBefore = before === null ? 0 : uiAmount(before);
            const uiAfter = after === null ? 0 : uiAmount(after);
            if (uiBefore === null || uiAfter === null) continue;
            delta = uiAfter - uiBefore;
            if (delta === 0) continue;
        }

        const groupKey = `${owner ?? ''}|${mint}`;
        const group = groups.get(groupKey);
        // `accounts` is how many token accounts of this owner moved this mint. It is 1 for a pool's
        // own vault, and the ambiguity signal for a SHARED authority owning several pools' vaults.
        if (group === undefined) groups.set(groupKey, { owner, mint, delta, decimals, accounts: 1 });
        else {
            group.delta += delta;
            group.accounts += 1;
        }
    }

    return [...groups.values()]
        .filter((group) => group.delta !== 0)
        .sort((a, b) => {
            if (a.mint !== b.mint) return a.mint < b.mint ? -1 : 1;
            return (a.owner ?? '') < (b.owner ?? '') ? -1 : (a.owner ?? '') > (b.owner ?? '') ? 1 : 0;
        });
}

/** accountKeys[0] is the fee payer; jsonParsed gives objects, older shapes a bare string. */
function feePayerOf(tx) {
    const first = tx?.transaction?.message?.accountKeys?.[0];
    if (typeof first === 'string') return stringOrNull(first);
    return stringOrNull(first?.pubkey);
}

/**
 * The distinct TOP-LEVEL program ids, compute budget excluded. Note what this is not: on these
 * pools the swap is almost always CPI'd into the AMM by an aggregator, so the AMM's own program id
 * does NOT appear here — what appears is the router that was used. That is the useful fact (who
 * routed it), but it must not be read as "which AMM executed it".
 */
export function topLevelPrograms(tx) {
    const instructions = tx?.transaction?.message?.instructions;
    const ids = new Set();
    for (const instruction of Array.isArray(instructions) ? instructions : []) {
        const id = stringOrNull(instruction?.programId);
        if (id === null || id === COMPUTE_BUDGET_PROGRAM) continue;
        ids.add(id);
    }
    return [...ids].sort();
}

/**
 * Every instruction in the transaction, top-level and inner alike, as `{programId, accounts}`.
 * The AMM's own instruction is almost always an INNER one here, because an aggregator CPI's into it
 * — so a check that only read `message.instructions` would see nothing of the swap itself.
 */
export function allInstructions(tx) {
    const out = [];
    const top = tx?.transaction?.message?.instructions;
    for (const instruction of Array.isArray(top) ? top : []) {
        out.push({ programId: stringOrNull(instruction?.programId), accounts: Array.isArray(instruction?.accounts) ? instruction.accounts : [] });
    }
    const inner = tx?.meta?.innerInstructions;
    for (const group of Array.isArray(inner) ? inner : []) {
        for (const instruction of Array.isArray(group?.instructions) ? group.instructions : []) {
            out.push({ programId: stringOrNull(instruction?.programId), accounts: Array.isArray(instruction?.accounts) ? instruction.accounts : [] });
        }
    }
    return out;
}

/**
 * The largest number of times any ONE program was invoked with this pool among its accounts.
 *
 * Two invocations of the same program naming the same pool is the structural signature of a round
 * trip through it: swap in, swap back. This deliberately does not consult a table of AMM program
 * ids — a hardcoded list would be one stale address away from silently failing, and the repeated
 * program here IS the pool's dex program by construction, since it is the program being handed the
 * pool account. `accounts` is only present on jsonParsed instructions the RPC could not decode
 * further, which is exactly the case for an AMM instruction, so this reads what is actually there.
 */
export function poolInvocationCount(tx, pair) {
    const pool = stringOrNull(pair);
    if (pool === null) return 0;
    const byProgram = new Map();
    for (const { programId, accounts } of allInstructions(tx)) {
        if (programId === null || programId === COMPUTE_BUDGET_PROGRAM) continue;
        if (!accounts.includes(pool)) continue;
        byProgram.set(programId, (byProgram.get(programId) ?? 0) + 1);
    }
    let most = 0;
    for (const count of byProgram.values()) most = Math.max(most, count);
    return most;
}

/**
 * Is the decoded price too far from the pool's own reference to be a print? A missing price or a
 * missing reference means "cannot judge", which is NOT the same as "suspect" — a pool we have no
 * reference for must not have every one of its trades greyed out.
 */
export function priceOutOfBand(priceQuote, refPriceQuote, tolerance = SUSPECT_PRICE_TOLERANCE) {
    const price = finiteOrNull(priceQuote);
    const reference = finiteOrNull(refPriceQuote);
    if (price === null || reference === null || reference === 0) return false;
    return Math.abs(price / reference - 1) > tolerance;
}

/**
 * One transaction → one trade on one pool, or null when it is not a swap of the tracked mint.
 *
 * The pool's OWN balance changes are the trade: the pool gaining the token means someone sold it
 * into the pool (`side: 'sell'`), losing it means someone bought. Reading the taker's side instead
 * would be wrong for a routed swap, where the taker may never hold either asset. A transaction that
 * touches the pool but moves none of the tracked mint returns null and the caller counts it
 * `undecodable` rather than dropping it silently. That is not an edge case:
 * `getSignaturesForAddress` returns every transaction that MENTIONS the address, and arbitrage bots
 * routinely list several pools among their accounts while trading through only some of them. One
 * such transaction was verified on the BROS pool (2026-09-16): its SOL and BROS vaults were
 * byte-identical before and after while other pools' moved. A pool that was mentioned and not
 * traded against must not become a trade of size zero.
 *
 * `pool` is `{pair, mint, symbol, dex, quoteMint, quoteSymbol, quoteUsdRate}`. A pool whose quote
 * leg cannot be found, or whose `quoteUsdRate` is null, still yields a trade — with `quoteAmount`
 * or `priceUsd` null. A missing number stays missing: the DKNG/ALLINU pool quotes in a memecoin and
 * has no USD reference at all, and its trades must carry a size and a quote price and no dollars.
 *
 * `decodeVia` records WHICH rule found the pool: `'pool-vault'` when the pool owns its vaults,
 * `'shared-authority'` when they were found under this dex's program authority
 * (POOL_AUTHORITY_ALIASES) instead. The second is a weaker attribution and is labelled so a
 * consumer can weigh it, or drop it, rather than having to trust both equally.
 */
export function decodeTrade(tx, pool, { signature = null } = {}) {
    const pair = stringOrNull(pool?.pair);
    const mint = stringOrNull(pool?.mint);
    if (pair === null || mint === null) return null;
    if (tx === null || typeof tx !== 'object') return null;

    const deltas = tokenBalanceDeltas(tx.meta);
    const quoteMint = stringOrNull(pool?.quoteMint);

    let poolToken = deltas.find((delta) => delta.owner === pair && delta.mint === mint) ?? null;
    let poolQuote = quoteMint === null ? null : deltas.find((delta) => delta.owner === pair && delta.mint === quoteMint) ?? null;
    let decodeVia = 'pool-vault';
    let authority = null;

    if (poolToken === null) {
        // Fall back to this dex's shared vault authority. Accepted only when exactly one of its
        // accounts moved the mint: with two, the authority is holding two pools' vaults of the same
        // token and there is no way to tell from balances alone which pool traded, so the two would
        // be summed into one fictitious trade. Better to report nothing than the wrong size.
        const aliases = POOL_AUTHORITY_ALIASES[stringOrNull(pool?.dex) ?? ''] ?? [];
        for (const alias of aliases) {
            const candidate = deltas.find((delta) => delta.owner === alias && delta.mint === mint) ?? null;
            if (candidate === null || candidate.accounts !== 1) continue;
            poolToken = candidate;
            authority = alias;
            decodeVia = 'shared-authority';
            const quoteLeg = quoteMint === null ? null : deltas.find((delta) => delta.owner === alias && delta.mint === quoteMint) ?? null;
            poolQuote = quoteLeg !== null && quoteLeg.accounts === 1 ? quoteLeg : null;
            break;
        }
    }
    if (poolToken === null) return null;

    // More than two mints under the shared authority means more than one pool of that dex was
    // touched, i.e. the swap was routed through several of them. (The all-mints rule below already
    // catches every such case, since those mints are a subset; this states the intent explicitly so
    // it cannot regress if that rule is ever narrowed.)
    const authorityMints = authority === null
        ? 0
        : new Set(deltas.filter((delta) => delta.owner === authority).map((delta) => delta.mint)).size;

    const tokenDelta = poolToken.delta;
    const quoteDelta = poolQuote === null ? null : poolQuote.delta;
    const size = Math.abs(tokenDelta);
    const quoteAmount = quoteDelta === null ? null : Math.abs(quoteDelta);
    const priceQuote = quoteAmount === null ? null : quoteAmount / size;
    const rate = finiteOrNull(pool?.quoteUsdRate);
    const priceUsd = priceQuote === null || rate === null ? null : priceQuote * rate;

    return {
        sig: stringOrNull(tx.transaction?.signatures?.[0]) ?? stringOrNull(signature),
        time: timeFromBlockTime(tx.blockTime),
        mint,
        symbol: stringOrNull(pool?.symbol),
        dex: stringOrNull(pool?.dex),
        pair,
        side: tokenDelta > 0 ? 'sell' : 'buy',
        size,
        quoteAmount,
        quoteSymbol: stringOrNull(pool?.quoteSymbol),
        priceQuote,
        priceUsd,
        feePayer: feePayerOf(tx),
        // More than two mints moved means the swap was one hop of a route or an arbitrage cycle,
        // not a plain two-sided trade against this pool.
        routed: new Set(deltas.map((delta) => delta.mint)).size > 2 || authorityMints > 2,
        programs: topLevelPrograms(tx),
        decodeVia,
        // Kept, not dropped — the transaction is real and the page shows it greyed — but a suspect
        // row's price is an artefact of netting, so `tradeVolumeUsd` refuses to value it and it
        // reaches no volume total or price statistic.
        suspect: priceOutOfBand(priceQuote, pool?.refPriceQuote) || poolInvocationCount(tx, pair) > 1
            ? 'round-trip'
            : null
    };
}

/**
 * One trade's USD volume: size × price. Null unless the trade was actually priced in USD — and null
 * for a `suspect` trade whatever its price says, which is the single choke point that keeps a netted
 * round trip's exploded price out of every hourly bucket, every total and every price statistic.
 */
export function tradeVolumeUsd(trade) {
    if (stringOrNull(trade?.suspect) !== null) return null;
    const size = finiteOrNull(trade?.size);
    const priceUsd = finiteOrNull(trade?.priceUsd);
    if (size === null || priceUsd === null) return null;
    return size * priceUsd;
}

/** The start of the hour containing `ms`. */
export function hourStartMs(ms) {
    return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * The `hours` hourly buckets ending with the hour that contains `now`, each
 * `{hourStart, byDex: {[dexId]: {trades, volumeUsd, buys, sells, traders}}}`.
 *
 * Every hour in the window is present even when nothing was collected in it — that is what lets the
 * page hatch the hours it has no data for instead of drawing them as zero activity. `traders` is
 * DISTINCT fee payers in that hour on that venue, so it is not additive across hours and is
 * recounted per bucket rather than summed. `volumeUsd` stays null for an hour whose trades could
 * not be priced.
 */
export function hourlyBuckets(trades, { now = Date.now(), hours = WINDOW_HOURS } = {}) {
    const nowMs = msOf(now);
    if (nowMs === null) throw new Error(`hourlyBuckets needs a usable "now", got ${JSON.stringify(now)}`);
    const end = hourStartMs(nowMs);
    const buckets = [];
    const slots = new Map();
    for (let i = hours - 1; i >= 0; i -= 1) {
        const startMs = end - i * HOUR_MS;
        const bucket = { hourStart: isoSeconds(startMs), byDex: {} };
        buckets.push(bucket);
        slots.set(startMs, { bucket, traders: new Map() });
    }

    for (const trade of Array.isArray(trades) ? trades : []) {
        const ms = msOf(trade?.time);
        if (ms === null) continue;
        const slot = slots.get(hourStartMs(ms));
        if (slot === undefined) continue;
        const dex = stringOrNull(trade?.dex) ?? 'unknown';
        let row = slot.bucket.byDex[dex];
        if (row === undefined) {
            row = { trades: 0, volumeUsd: null, buys: 0, sells: 0, traders: 0 };
            slot.bucket.byDex[dex] = row;
            slot.traders.set(dex, new Set());
        }
        row.trades += 1;
        if (trade?.side === 'buy') row.buys += 1;
        else if (trade?.side === 'sell') row.sells += 1;
        const volume = tradeVolumeUsd(trade);
        if (volume !== null) row.volumeUsd = (row.volumeUsd ?? 0) + volume;
        const payer = stringOrNull(trade?.feePayer);
        if (payer !== null) slot.traders.get(dex).add(payer);
    }

    for (const slot of slots.values()) {
        for (const [dex, payers] of slot.traders) slot.bucket.byDex[dex].traders = payers.size;
    }
    return buckets;
}

/**
 * `{trades, volumeUsd, traders, failedShare}` over the whole window. `failedShare` is
 * Σ failedTx / Σ signaturesSeen across the sampled pools — the share of recent transactions on
 * these pools that reverted, which on a hot pool is mostly losing arbitrage bots. It is null, not
 * 0, when no signatures were seen at all.
 */
export function totalsFor(trades, pools = []) {
    const list = Array.isArray(trades) ? trades : [];
    const payers = new Set();
    for (const trade of list) {
        const payer = stringOrNull(trade?.feePayer);
        if (payer !== null) payers.add(payer);
    }
    const seen = sumOrNull((Array.isArray(pools) ? pools : []).map((pool) => pool?.signaturesSeen));
    const failed = sumOrNull((Array.isArray(pools) ? pools : []).map((pool) => pool?.failedTx));
    return {
        trades: list.length,
        volumeUsd: sumOrNull(list.map((trade) => tradeVolumeUsd(trade))),
        traders: payers.size,
        failedShare: seen === null || seen === 0 ? null : (failed ?? 0) / seen,
        // Counted, not hidden: these rows are in `trades` and out of `volumeUsd`, and a reader is
        // entitled to know how many of the window's prints were not valued.
        suspect: list.filter((trade) => stringOrNull(trade?.suspect) !== null).length
    };
}

/** Newest first; a trade with no `time` sorts last, and equal times break on signature. */
export function sortTradesNewestFirst(trades) {
    return [...trades].sort((a, b) => {
        const at = msOf(a?.time);
        const bt = msOf(b?.time);
        if (at !== bt) {
            if (at === null) return 1;
            if (bt === null) return -1;
            return bt - at;
        }
        const as = a?.sig ?? '';
        const bs = b?.sig ?? '';
        return as < bs ? -1 : as > bs ? 1 : 0;
    });
}

/**
 * Re-apply the price band to a trade already in the store, for `--republish`.
 *
 * Only the price half of the test can be redone here: the structural half reads the transaction's
 * instructions, which the store does not keep. So an existing flag is KEPT rather than recomputed
 * away — a trade flagged for a reason we can no longer see must not be silently cleared.
 */
export function reflagSuspect(trade, refPriceQuote, tolerance = SUSPECT_PRICE_TOLERANCE) {
    const existing = stringOrNull(trade?.suspect);
    const outOfBand = priceOutOfBand(trade?.priceQuote, refPriceQuote, tolerance);
    return { ...trade, suspect: outOfBand ? 'round-trip' : existing };
}

/**
 * The rolling store: dedupe by signature, drop what fell out of the window, newest first.
 *
 * A trade is kept on its own `time`; one whose transaction carried no `blockTime` is kept on
 * `seenAt`, the collector's own observation instant, held in a SEPARATE field so an invented
 * instant can never be mistaken for the chain's. Re-decoding a signature we already hold replaces
 * it (the newer decode may have a quote rate the older run lacked) while keeping its first
 * `seenAt`. Returns `{trades, added, replaced, pruned}` so a run can report what it actually did.
 */
export function mergeTrades(existing, incoming, { now = Date.now(), seenAt = null, windowHours = WINDOW_HOURS } = {}) {
    const nowMs = msOf(now);
    if (nowMs === null) throw new Error(`mergeTrades needs a usable "now", got ${JSON.stringify(now)}`);
    const seenAtIso = seenAt === null ? isoSeconds(nowMs) : seenAt;
    const cutoff = nowMs - windowHours * HOUR_MS;

    const bySig = new Map();
    let added = 0;
    let replaced = 0;
    for (const trade of Array.isArray(existing) ? existing : []) {
        const sig = stringOrNull(trade?.sig);
        if (sig === null) continue;
        bySig.set(sig, { ...trade, seenAt: trade.seenAt ?? seenAtIso });
    }
    for (const trade of Array.isArray(incoming) ? incoming : []) {
        const sig = stringOrNull(trade?.sig);
        if (sig === null) continue;
        const previous = bySig.get(sig);
        if (previous === undefined) added += 1;
        else replaced += 1;
        bySig.set(sig, { ...trade, seenAt: previous?.seenAt ?? trade.seenAt ?? seenAtIso });
    }

    const kept = [];
    let pruned = 0;
    for (const trade of bySig.values()) {
        const at = msOf(trade.time) ?? msOf(trade.seenAt);
        if (at === null || at < cutoff) {
            pruned += 1;
            continue;
        }
        kept.push(trade);
    }
    return { trades: sortTradesNewestFirst(kept), added, replaced, pruned };
}

/**
 * The same rolling rule for the signatures that were fetched and turned out not to be trades. They
 * are remembered so the next run does not spend its transaction budget re-fetching them; without
 * this, a pool's add-liquidity transactions would be re-read on every single run forever.
 */
export function mergeSeenSignatures(existing, incoming, { now = Date.now(), windowHours = WINDOW_HOURS } = {}) {
    const nowMs = msOf(now);
    if (nowMs === null) throw new Error(`mergeSeenSignatures needs a usable "now", got ${JSON.stringify(now)}`);
    const cutoff = nowMs - windowHours * HOUR_MS;
    const bySig = new Map();
    for (const record of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
        const sig = stringOrNull(record?.sig);
        if (sig === null) continue;
        if (!bySig.has(sig)) bySig.set(sig, { sig, seenAt: record.seenAt ?? isoSeconds(nowMs), pair: stringOrNull(record?.pair), reason: stringOrNull(record?.reason) });
    }
    const kept = [];
    for (const record of bySig.values()) {
        const at = msOf(record.seenAt);
        if (at === null || at < cutoff) continue;
        kept.push(record);
    }
    return kept.sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
}

/**
 * The published `stocks-trades.json` (MODEL.md §12.2). Built here, in the pure layer, so the page's
 * sample fixture and the real file are the same shape by construction. `seenAt` is dropped: it is
 * the collector's bookkeeping, not part of the trade.
 */
export function buildPayload({ generatedAt, collectingSince = null, pools = [], trades = [], now = null, hours = WINDOW_HOURS } = {}) {
    const nowMs = msOf(now) ?? msOf(generatedAt);
    if (nowMs === null) throw new Error('buildPayload needs `now` or `generatedAt`');
    const ordered = sortTradesNewestFirst(Array.isArray(trades) ? trades : []);
    const published = ordered.map(({ seenAt, ...trade }) => trade);
    return {
        generatedAt: generatedAt ?? isoSeconds(nowMs),
        collectingSince,
        pools: Array.isArray(pools) ? pools : [],
        trades: published,
        hourly: hourlyBuckets(published, { now: nowMs, hours }),
        totals: totalsFor(published, pools)
    };
}
