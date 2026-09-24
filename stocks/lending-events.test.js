// Unit tests for stocks/lib/lending-events.mjs — the lending watcher's decisions: which accounts it
// watches, which transactions a bounded run reads and how far each checkpoint moves, how price
// observations become freeze episodes, and the SQL that stores them. The freeze tests run on real
// data: KLend observations decoded from fixtures/lending/transactions.sample.json, the Jupiter Lend
// QQQx cache's signatures around its two 2026-09 gaps (fixtures/lending/jl-cache-qqqx-signatures.sample.json),
// and the Pyth accounts Loopscale prices xStocks from (fixtures/lending/accounts.sample.json).

import { readFileSync } from 'node:fs';

import { decodeLendingTransaction } from './lib/lending-decode.mjs';
import {
    BACKFILL_FROM, JL_CACHE_MAX_GAP_S, SCOPE_CONFIGURATION, TRADE_PRICE_FILL_SQL, advanceCheckpoints, applyCacheSignatures,
    applyPythReading, applyReserveObservation, applyScopeResume, buildFreezeSql, buildLiquidationSql, buildScanSql,
    buildWatchList, completedCut, decodePriceUpdateV2, dueForListing, freezeRow, isoFromUnix, jupiterGapCause, liquidationRow,
    obligationOwner, ongoingCacheEpisode, pendingOldestFirst, reservesByScopeEntry, selectBatch, unixFromIso, usEquitySchedule
} from './lib/lending-events.mjs';
import { base58Encode } from './lib/solana-address.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const TX = read('./fixtures/lending/transactions.sample.json').transactions;
const CACHE_SIGS = read('./fixtures/lending/jl-cache-qqqx-signatures.sample.json').signatures;
const ACCOUNTS = read('./fixtures/lending/accounts.sample.json').accounts;
const RESEARCH = read('./data/protocol-market-research.json');
const DEFI = read('./data/defi-usage.json');
const TOKENS = read('../stocks-tokens.json').tokens;

const QQQX = 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ';
const QQQX_RESERVE = '2jerdAXR8r2B6z3P7P6VgSiePQX7wqcpbEqdDbm8mgeB';
const SENTORA_QQQX_RESERVE = 'w6diwHyXhRzmhRWwnz3jQPqTt35qFbBDcQP7T2VdgSm';
const QQQX_CACHE = 'DLuv79r7JPgdF2C266h1kuX8DPhg2amDtaTqz9Zm25w1';
const META = { protocol: 'kamino', marketId: 'kamino:xstocks-pool', mint: QQQX, symbol: 'QQQx', reserve: QQQX_RESERVE };
const STOCKS = new Map(TOKENS.map((t) => [t.mint, t.symbol]));

function staleQqqx() {
    return decodeLendingTransaction(TX['kamino-stale-qqqx'], { stockMints: STOCKS }).observations.find((o) => o.reserve === QQQX_RESERVE);
}

function obs(at, fields = {}) {
    return { reserve: QQQX_RESERVE, name: 'QQQx', price: 723.5764, stale: false, ageS: null, maxAgeS: null, signature: `sig-${at}`, at, ...fields };
}

describe('the watch list', () => {
    const watch = buildWatchList({ research: RESEARCH, defiUsage: DEFI, tokens: TOKENS });
    const count = (role) => watch.accounts.filter((a) => a.role === role).length;

    test('every lending market that holds a tracked stock, from the oracle research and the DeFi collector', () => {
        expect(count('kamino-reserve')).toBe(16);
        expect(count('scope-config')).toBe(1);
        expect(count('jl-vault')).toBe(8);
        expect(count('jl-cache')).toBe(4);
        expect(count('nest-config')).toBe(22);
        expect(count('loopscale-loan')).toBeGreaterThanOrEqual(12);
        expect(count('pyth-price')).toBe(4);
        expect(watch.accounts.find((a) => a.account === SCOPE_CONFIGURATION)).toMatchObject({ protocol: 'kamino', role: 'scope-config' });
        expect(watch.reserves[SENTORA_QQQX_RESERVE]).toMatchObject({ marketId: 'kamino:sentora-xstocks-market', mint: QQQX, symbol: 'QQQx' });
        expect(watch.marketByAddress['5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua']).toBe('kamino:xstocks-pool');
        expect(watch.stableMints.EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v).toBe('USDC');
    });

    test('a Scope entry names every reserve whose price chain uses it (both QQQx markets for ChainlinkX 280)', () => {
        expect(reservesByScopeEntry(watch.reserves).get(280).sort()).toEqual([QQQX_RESERVE, SENTORA_QQQX_RESERVE].sort());
    });

    test('only catalogued mints are watched', () => {
        const none = buildWatchList({ research: RESEARCH, defiUsage: DEFI, tokens: [] });
        expect(none.accounts).toEqual([]);
    });
});

describe('which accounts a run lists', () => {
    const now = Date.parse('2026-09-24T18:00:00Z');
    test('Kamino, Scope and Jupiter Lend every run; the quiet Nest and Loopscale accounts every 6 h; account reads never', () => {
        expect(dueForListing('kamino-reserve', '2026-09-24T17:30:00Z', now)).toBe(true);
        expect(dueForListing('jl-cache', '2026-09-24T17:59:00Z', now)).toBe(true);
        expect(dueForListing('nest-config', '2026-09-24T17:00:00Z', now)).toBe(false);
        expect(dueForListing('nest-config', '2026-09-24T12:03:00Z', now)).toBe(true);
        expect(dueForListing('loopscale-loan', null, now)).toBe(true);
        expect(dueForListing('pyth-price', null, now)).toBe(false);
    });
});

describe('which transactions a run reads', () => {
    const s = (signature, slot, blockTime = slot) => ({ signature, slot, blockTime, err: null });
    const pending = new Map([
        ['A', pendingOldestFirst([s('a3', 30), s('a1', 10), s('x', 20)])],
        ['B', pendingOldestFirst([s('x', 20), s('b2', 20), s('b4', 40)])]
    ]);

    test('one entry per transaction, oldest slot first, never splitting a slot at the budget', () => {
        const { batch, cutSlot, backlog } = selectBatch(pending, { budget: 2 });
        expect(batch.map((e) => e.signature)).toEqual(['a1', 'b2', 'x']);
        expect(batch.find((e) => e.signature === 'x').accounts).toEqual(['A', 'B']);
        expect(cutSlot).toBe(20);
        expect(backlog).toBe(2);
    });

    test('each checkpoint moves to its own newest signature at or before the cut, and no further', () => {
        const cps = advanceCheckpoints(pending, 20);
        expect(cps.get('A')).toMatchObject({ signature: 'x', slot: 20, consumed: 2 });
        expect(cps.get('B')).toMatchObject({ signature: 'x', consumed: 2 });
        expect(advanceCheckpoints(pending, 5).size).toBe(0);
    });

    test('a read that fails part-way keeps only whole slots', () => {
        const { batch } = selectBatch(pending, { budget: 10 });
        expect(completedCut(batch, new Set(['a1', 'b2']))).toBe(10);
        expect(completedCut(batch, new Set(['a1', 'b2', 'x', 'a3']))).toBe(30);
        expect(completedCut(batch, new Set())).toBeNull();
    });
});

describe('Kamino freeze episodes from KLend refresh logs', () => {
    test('a stale observation opens an episode at the price\'s own last update: block time − age', () => {
        const stale = staleQqqx();
        const { state, emit } = applyReserveObservation(null, stale, META);
        expect(emit).toEqual([]);
        expect(isoFromUnix(state.open.startedTs)).toBe('2026-09-19T17:28:45Z');
        expect(state.open).toMatchObject({ startBasis: 'price-age', staleObservations: 1, observation: 'kamino-refresh-log' });
    });

    test('more stale sightings extend it; the first fresh one ends it', () => {
        let { state } = applyReserveObservation(null, staleQqqx(), META);
        ({ state } = applyReserveObservation(state, obs('2026-09-21T13:39:54Z', { stale: true, ageS: 159669, maxAgeS: 300 }), META));
        expect(state.open.staleObservations).toBe(2);
        expect(isoFromUnix(state.open.startedTs)).toBe('2026-09-19T17:28:45Z');
        const done = applyReserveObservation(state, obs('2026-09-21T13:50:00Z'), META);
        expect(done.state.open).toBeNull();
        expect(freezeRow(done.emit[0])).toMatchObject({
            startedAt: '2026-09-19T17:28:45Z', endedAt: '2026-09-21T13:50:00Z', lastSeenStaleAt: '2026-09-21T13:39:54Z', staleObservations: 2
        });
    });

    test('a Scope resume between the last stale and the first fresh sighting names the cause and is the end', () => {
        const resume = decodeLendingTransaction(TX['scope-resume-qqqx']).scopeResumes[0];
        let { state } = applyReserveObservation(null, staleQqqx(), META);
        ({ state } = applyReserveObservation(state, obs('2026-09-21T13:39:54Z', { stale: true, ageS: 159669 }), META));
        ({ state } = applyScopeResume(state, resume, META));
        const { emit } = applyReserveObservation(state, obs('2026-09-21T14:20:00Z'), META);
        expect(freezeRow(emit[0])).toMatchObject({
            startedAt: '2026-09-19T17:28:45Z', endedAt: '2026-09-21T13:42:13Z', cause: 'scope-suspension',
            causeDetail: { entry: 280, activationAt: '2026-09-19T23:00:00Z', observationsAt: '2026-09-19T17:28:25Z' },
            evidence: { endBasis: 'scope-resume', firstFreshAt: '2026-09-21T14:20:00Z' }
        });
    });

    test('a resume nobody saw the freeze of is itself an episode, from Scope\'s last observation to the resume', () => {
        const resume = decodeLendingTransaction(TX['scope-resume-qqqx']).scopeResumes[0];
        const { emit } = applyScopeResume(null, resume, META);
        expect(freezeRow(emit[0])).toMatchObject({ startedAt: '2026-09-19T17:28:25Z', endedAt: '2026-09-21T13:42:13Z', observation: 'scope-resume' });
    });

    test('a stale sighting whose last update is newer than the open episode\'s saw an update: two episodes', () => {
        let { state } = applyReserveObservation(null, obs('2026-09-24T09:01:07Z', { stale: true, ageS: 1287 }), META);
        const split = applyReserveObservation(state, obs('2026-09-24T12:00:00Z', { stale: true, ageS: 600 }), META);
        expect(split.emit.map(freezeRow).map((r) => [r.startedAt, r.endedAt])).toEqual([['2026-09-24T08:39:40Z', '2026-09-24T11:50:00Z']]);
        expect(isoFromUnix(split.state.open.startedTs)).toBe('2026-09-24T11:50:00Z');
        ({ state } = applyReserveObservation(state, obs('2026-09-24T09:05:00Z', { stale: true, ageS: 1520 }), META));
        expect(isoFromUnix(state.open.startedTs)).toBe('2026-09-24T08:39:40Z');
    });

    test('fresh observations with nothing open change nothing', () => {
        expect(applyReserveObservation(null, obs('2026-09-24T09:05:00Z'), META)).toEqual({ state: { open: null }, emit: [] });
    });
});

describe('Jupiter Lend freeze episodes from cache refresh gaps', () => {
    const meta = { protocol: 'jupiter-lend', marketId: 'jupiter-lend:xstocks-vaults', mint: QQQX, symbol: 'QQQx', account: QQQX_CACHE };
    const sigs = pendingOldestFirst(CACHE_SIGS);

    // The fixture is two windows (19–21 Sep and 24 Sep); between them the stream is read as a new
    // listing with a coverage gap, exactly as the job treats an unlisted stretch.
    const split = sigs.findIndex((s) => s.blockTime > unixFromIso('2026-09-22T00:00:00Z'));
    const readBoth = () => {
        const first = applyCacheSignatures({}, sigs.slice(0, split), meta);
        const second = applyCacheSignatures(first.state, sigs.slice(split), meta, { coverageGap: true });
        return { emit: [...first.emit, ...second.emit], state: second.state };
    };

    test('the two real QQQx gaps, and nothing in between: failed operations during the freeze do not count', () => {
        const { emit, state } = readBoth();
        expect(emit.map(freezeRow).map((r) => [r.startedAt, r.endedAt])).toEqual([
            ['2026-09-19T17:29:01Z', '2026-09-21T12:31:24Z'],
            ['2026-09-24T08:38:00Z', '2026-09-24T09:07:45Z']
        ]);
        expect(sigs.filter((s) => s.err !== null).length).toBeGreaterThan(0);
        expect(state.lastOk.signature).toBe(sigs.filter((s) => s.err === null).at(-1).signature);
    });

    test('the lift transaction at the end of the 43-hour gap makes it an operator suspension', () => {
        const [gap, short] = readBoth().emit;
        const events = decodeLendingTransaction(TX['jupiter-lend-lift-qqqx']).oracleEvents;
        expect(gap.endSignature).toBe(events[0].signature);
        expect(jupiterGapCause(gap, events)).toMatchObject({ cause: 'operator-suspension', causeDetail: { liftedAt: '2026-09-21T12:31:24Z' } });
        expect(jupiterGapCause(short, events)).toBeNull();
    });

    test('state carries across runs; a coverage gap forgets it rather than inventing a freeze', () => {
        const half = sigs.findIndex((s) => s.blockTime > unixFromIso('2026-09-20T00:00:00Z'));
        const first = applyCacheSignatures({}, sigs.slice(0, half), meta);
        expect(first.emit).toHaveLength(0);
        expect(applyCacheSignatures(first.state, sigs.slice(half, split), meta).emit).toHaveLength(1);
        expect(applyCacheSignatures(first.state, sigs.slice(half, split), meta, { coverageGap: true }).emit).toHaveLength(0);
    });

    test('an ongoing gap is reported once it is longer than the limit plus the listing lag', () => {
        const state = { lastOk: { signature: 'last', blockTime: unixFromIso('2026-09-24T10:00:00Z') } };
        expect(ongoingCacheEpisode(state, unixFromIso('2026-09-24T10:09:00Z'), meta)).toBeNull();
        const ep = ongoingCacheEpisode(state, unixFromIso('2026-09-24T10:30:00Z'), meta);
        expect(freezeRow(ep)).toMatchObject({ startedAt: '2026-09-24T10:00:00Z', endedAt: null, lastSeenStaleAt: '2026-09-24T10:30:00Z' });
        expect(JL_CACHE_MAX_GAP_S).toBe(600);
    });
});

describe('Loopscale freeze episodes from its Pyth accounts', () => {
    const meta = { protocol: 'loopscale', marketId: 'loopscale:xstocks-orca-vaults', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', symbol: 'TSLAx', account: 'E8WFH8brgP58arcuW2wwsPHiomYrSvrgWTsRLZLAEZUQ' };
    const tsla = decodePriceUpdateV2(ACCOUNTS.E8WFH8brgP58arcuW2wwsPHiomYrSvrgWTsRLZLAEZUQ.data);

    test('decodes the real accounts: TSLA last published 2026-09-11 23:59:59, SPY 2026-08-26 15:54:46', () => {
        expect(tsla).toMatchObject({ verification: 'full', publishTs: unixFromIso('2026-09-11T23:59:59Z') });
        expect(tsla.price).toBeCloseTo(365.275, 3);
        expect(decodePriceUpdateV2(ACCOUNTS['9owhtgrdLiUMAH9JKxYFt5pUY4Luy4EzzLhdcWPVuDyy'].data).publishTs).toBe(unixFromIso('2026-08-26T15:54:46Z'));
        expect(decodePriceUpdateV2(ACCOUNTS.An6n6M3jjkCuDrU5JSLnhrvaLjDfcVDvJBVwFoi7eArt.data)).toBeNull();
    });

    test('opens only while the listed share\'s market is open, starting at the last publish time', () => {
        const nowTs = unixFromIso('2026-09-24T18:00:00Z');
        expect(applyPythReading(null, { publishTs: tsla.publishTs, nowTs, session: 'closed', maxAgeS: 900 }, meta).emit).toEqual([]);
        const opened = applyPythReading(null, { publishTs: tsla.publishTs, nowTs, session: 'open', maxAgeS: 900 }, meta);
        expect(freezeRow(opened.emit[0])).toMatchObject({ startedAt: '2026-09-11T23:59:59Z', endedAt: null, cause: 'stale-oracle-account' });
        const fresh = applyPythReading(null, { publishTs: nowTs - 60, nowTs, session: 'open', maxAgeS: 900 }, meta);
        expect(fresh.emit).toEqual([]);
    });

    test('ends at the first update after the start, looked up only when the account moved', () => {
        const nowTs = unixFromIso('2026-09-24T18:00:00Z');
        const { state } = applyPythReading(null, { publishTs: tsla.publishTs, nowTs, session: 'open', maxAgeS: 900 }, meta);
        const later = unixFromIso('2026-09-25T15:00:00Z');
        expect(applyPythReading(state, { publishTs: later, nowTs: later + 30, session: 'open', maxAgeS: 900 }, meta).needsFirstUpdate).toBe(true);
        const closed = applyPythReading(state, { publishTs: later, nowTs: later + 30, session: 'open', maxAgeS: 900, firstUpdate: { signature: 'first', blockTime: unixFromIso('2026-09-25T13:30:02Z') } }, meta);
        expect(freezeRow(closed.emit[0])).toMatchObject({ startedAt: '2026-09-11T23:59:59Z', endedAt: '2026-09-25T13:30:02Z', endSignature: 'first' });
    });

    test('the session calendar comes from the reference-price feed list', () => {
        expect(usEquitySchedule({ items: [{ schedule: null }, { schedule: 'America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C' }] })).toMatch(/^America\/New_York;/);
        expect(usEquitySchedule({ items: [] })).toBeNull();
    });
});

describe('rows and SQL', () => {
    const watch = buildWatchList({ research: RESEARCH, defiUsage: DEFI, tokens: TOKENS });

    test('a liquidation row: market id from the watch list, a stablecoin debt at $1 said so, an unknown price left null', () => {
        const [kamino] = decodeLendingTransaction(TX['kamino-liquidation-hoodx'], { stockMints: STOCKS }).liquidations;
        expect(liquidationRow(kamino, watch)).toMatchObject({ marketId: 'kamino:xstocks-pool', debtSymbol: 'USDC', debtPriceSource: 'protocol-log', ixIndex: kamino.invocation });
        const unpriced = liquidationRow({ ...kamino, protocol: 'jupiter-lend', marketAddress: 'unknown', debtUsd: null, collateralUsd: null, collateralPriceUsd: null, priceSource: null }, watch);
        expect(unpriced).toMatchObject({ marketId: 'jupiter-lend:xstocks-vaults', collateralUsd: null, debtUsd: kamino.debtAmount, debtPriceSource: 'stablecoin-at-1' });
        const stockDebt = liquidationRow({ ...kamino, debtMint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', debtUsd: null }, watch);
        expect(stockDebt).toMatchObject({ debtSymbol: 'SPYx', debtUsd: null, debtPriceSource: null });
    });

    test('the obligation owner is the borrower', () => {
        expect(obligationOwner(ACCOUNTS.An6n6M3jjkCuDrU5JSLnhrvaLjDfcVDvJBVwFoi7eArt.data, base58Encode)).toBe('9N9g4Pghj1Bki6yXDBfPqkCCtQK1LMpJuetwvgAKH5rp');
        expect(obligationOwner(ACCOUNTS.E8WFH8brgP58arcuW2wwsPHiomYrSvrgWTsRLZLAEZUQ.data, base58Encode)).toBeNull();
    });

    test('upserts are keyed on the natural keys and only touch a row that changed', () => {
        const liq = buildLiquidationSql([{ signature: 's', ixIndex: 3 }]);
        expect(liq).toContain('ON CONFLICT (signature, ix_index) DO UPDATE');
        expect(liq).toContain('t.borrower IS DISTINCT FROM EXCLUDED.borrower');
        // A price the trade tape filled in later is never overwritten by a re-read without one.
        expect(liq).not.toMatch(/collateral_usd = EXCLUDED/);
        const freeze = buildFreezeSql([{ marketId: 'm', mint: 'x', startedAt: '2026-09-24T00:00:00Z' }]);
        expect(freeze).toContain('ON CONFLICT (market_id, mint, started_at) DO UPDATE');
        expect(freeze).toContain('ended_at = EXCLUDED.ended_at');
        expect(buildScanSql([{ account: 'a' }])).toContain('ON CONFLICT (account) DO UPDATE');
        expect(buildLiquidationSql([])).toBeNull();
        expect(TRADE_PRICE_FILL_SQL).toContain('t.suspect IS NULL');
        expect(TRADE_PRICE_FILL_SQL).toContain("interval '1 hour'");
        expect(BACKFILL_FROM).toBe('2026-09-16T00:00:00Z');
    });
});
