// Fast tests for the recurring redemption observer: the Superstate burn-to-book-entry classifier
// on real trimmed mainnet transactions, the independent reference price, checkpoint/resume over a
// simulated signature stream, xStocks deposit settlement across runs, the rule that a failed or
// uncovered scan never reads as "no redemptions", and the builder merge into redemption usability.
const ss = require('./fixtures/redemption-observation-superstate.sample.json');
const xs = require('./fixtures/redemption-observation.sample.json');
const {
    SUPERSTATE_EQUITY_BURN_ADDRESS, classifySuperstateLeg, pairSuperstateConversion, referencePriceAt,
    classifyXstocksLeg, pairXstocksRedemption
} = require('./lib/redemption-observation.mjs');
const {
    selectBatch, runInterval, mergeIntervals, intersectCoverage, covers, coveredHoursOn, bump, summariseFeed,
    publicFeed, resolveXstocksDeposits, mergeObservationIntoRedemption, pushRecent
} = require('./lib/redemption-feed.mjs');
const { shapeRedemptionUsability } = require('./lib/redemption-usability.mjs');

const FWDI = '7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9';
const GLXY = '2HehXG149TXuVptQhbiWAWDjbbuCsXSAtLTB5wc2aajK';
const equityMints = new Set([FWDI, GLXY]);
const clone = (v) => JSON.parse(JSON.stringify(v));

describe('Superstate burn-to-book-entry legs', () => {
    const deposit = classifySuperstateLeg(ss.ssDeposit, { equityMints });
    const burn = classifySuperstateLeg(ss.ssBurn, { equityMints });

    test('a holder transfer of an equity token to the burn address is a deposit, memo kept', () => {
        expect(deposit).toMatchObject({ kind: 'holder-deposit', holder: '2CVeWbwqLsndG3CcuRe84KbCj4oyg27BTizGQkzaAAkp',
            tokenMint: FWDI, tokenAmount: 8990, memo: 'Detokenize FWDI superstate ', blockTime: '2026-09-10T19:42:14Z' });
    });

    test('the burn address burning that balance is the issuer leg', () => {
        expect(burn).toMatchObject({ kind: 'issuer-burn', tokenMint: FWDI, tokenAmount: 8990, blockTime: '2026-09-10T19:42:35Z' });
    });

    test('a fund mint burned at the same address, account creation and a failed tx are not equity conversions', () => {
        expect(classifySuperstateLeg(ss.ssFundBurn, { equityMints }).kind).toBe('other-mint');
        expect(classifySuperstateLeg(ss.ssAtaCreate, { equityMints }).kind).toBe('other');
        const failed = clone(ss.ssBurn);
        failed.meta.err = { InstructionError: [2, 'Custom'] };
        expect(classifySuperstateLeg(failed, { equityMints }).kind).toBe('failed');
        // Same burn with FWDI not recognised as an equity mint: never a conversion.
        expect(classifySuperstateLeg(ss.ssBurn, { equityMints: new Set([GLXY]) }).kind).toBe('other-mint');
    });

    test('pairs the burn with its deposit; an unmatched burn keeps holder null; a deposit is used once', () => {
        const used = new Set();
        const pair = pairSuperstateConversion({ burn, deposits: [deposit], used });
        expect(pair).toMatchObject({ holder: deposit.holder, secondsToBurn: 21, legs: { deposit: deposit.signature, burn: burn.signature } });
        used.add(pair.legs.deposit);
        expect(pairSuperstateConversion({ burn, deposits: [deposit], used }).holder).toBeNull();
        expect(pairSuperstateConversion({ burn: { ...burn, tokenAmount: 1 }, deposits: [deposit] }).holder).toBeNull();
    });

    test('the published burn address is the one the classifier keys on', () => {
        expect(SUPERSTATE_EQUITY_BURN_ADDRESS).toBe('2u8YwJTykTreziHBN5QwE7Bi2SyN8M2MicCscthtph9E');
    });
});

describe('independent reference price', () => {
    const t = '2026-09-23T15:05:18Z';
    const row = (min, price, extra = {}) => ({ mint: 'M', time: new Date(Date.parse(t) + min * 60000).toISOString(), priceUsd: price, suspect: null, ...extra });
    test('median of at least three non-suspect prints within ±30 min, else null', () => {
        expect(referencePriceAt([row(-10, 100), row(5, 102), row(20, 101)], { mint: 'M', time: t })).toBe(101);
        expect(referencePriceAt([row(-10, 100), row(5, 102), row(40, 101)], { mint: 'M', time: t })).toBeNull();
        expect(referencePriceAt([row(-10, 100), row(5, 102), row(6, 999, { suspect: 'out-of-band' })], { mint: 'M', time: t })).toBeNull();
        expect(referencePriceAt([row(-1, 1), row(0, 2), row(1, 3), row(2, 4)], { mint: 'M', time: t })).toBe(2.5);
    });
});

describe('checkpoint and resume', () => {
    // A stream of 10 signatures one minute apart; #4 failed on chain.
    const base = Date.parse('2026-09-24T00:00:00Z') / 1000;
    const stream = Array.from({ length: 10 }, (_, i) => ({ signature: `s${i}`, blockTime: base + i * 60, slot: 100 + i, err: i === 4 ? { x: 1 } : null }));
    const listSince = (checkpoint) => {
        const idx = checkpoint ? stream.findIndex((s) => s.signature === checkpoint) + 1 : 0;
        return stream.slice(idx).reverse(); // getSignaturesForAddress is newest-first
    };

    test('consumes oldest-first up to the budget; a failed signature costs no fetch', () => {
        const { batch, fetches, backlog } = selectBatch(listSince(null), { budget: 4 });
        expect(batch.map((b) => b.signature)).toEqual(['s0', 's1', 's2', 's3', 's4']);
        expect(batch.find((b) => b.signature === 's4').fetch).toBe(false);
        expect(fetches).toBe(4);
        expect(backlog).toBe(5);
    });

    test('three budget-limited runs read every signature exactly once and coverage is contiguous', () => {
        let checkpoint = null;
        let through = null;
        const seen = [];
        let coverage = [];
        for (let run = 0; run < 3; run += 1) {
            const listed = listSince(checkpoint);
            const { batch, backlog } = selectBatch(listed, { budget: 4 });
            seen.push(...batch.map((b) => b.signature));
            const interval = runInterval({ previousThrough: through, consumed: batch, backlog, listedAt: '2026-09-24T01:00:00Z' });
            coverage = mergeIntervals([...coverage, interval]);
            checkpoint = batch.at(-1)?.signature ?? checkpoint;
            through = interval.to;
        }
        expect(seen).toEqual(stream.map((s) => s.signature));
        expect(coverage).toEqual([{ from: '2026-09-24T00:00:00Z', to: '2026-09-24T01:00:00Z' }]);
    });

    test('a horizon holds back newer signatures for the next run', () => {
        const { batch, backlog } = selectBatch(listSince(null), { budget: 100, horizon: '2026-09-24T00:02:30Z' });
        const held = selectBatch(listSince(null), { budget: 100, horizon: '2026-09-24T00:02:30Z' }).heldBack;
        expect(batch.map((b) => b.signature)).toEqual(['s0', 's1', 's2']);
        expect(held).toBe(7);
        expect(backlog).toBe(0);
        expect(runInterval({ consumed: batch, backlog, listedAt: '2026-09-24T01:00:00Z', horizon: '2026-09-24T00:02:30Z' }))
            .toEqual({ from: '2026-09-24T00:00:00Z', to: '2026-09-24T00:02:30Z' });
    });

    test('a listing that never reached the checkpoint leaves the unlisted stretch outside coverage', () => {
        const consumed = stream.slice(6);
        expect(runInterval({ previousThrough: '2026-09-23T00:00:00Z', consumed, backlog: 0, listedAt: '2026-09-24T01:00:00Z', reachedCheckpoint: false }))
            .toEqual({ from: '2026-09-24T00:06:00Z', to: '2026-09-24T01:00:00Z' });
    });

    test('a complete first history covers back to the requested start; an empty scan still covers to the listing', () => {
        expect(runInterval({ consumed: stream.slice(0, 2), backlog: 0, listedAt: '2026-09-24T01:00:00Z', completeHistorySince: '2026-08-25T00:00:00Z' }).from)
            .toBe('2026-08-25T00:00:00Z');
        expect(runInterval({ previousThrough: '2026-09-23T00:00:00Z', consumed: [], backlog: 0, listedAt: '2026-09-24T00:00:00Z' }))
            .toEqual({ from: '2026-09-23T00:00:00Z', to: '2026-09-24T00:00:00Z' });
    });

    test('issuer coverage is where every address is covered', () => {
        const a = [{ from: '2026-09-20T00:00:00Z', to: '2026-09-22T00:00:00Z' }];
        const b = [{ from: '2026-09-21T00:00:00Z', to: '2026-09-23T00:00:00Z' }];
        expect(intersectCoverage([a, b])).toEqual([{ from: '2026-09-21T00:00:00Z', to: '2026-09-22T00:00:00Z' }]);
        expect(covers(a, '2026-09-21T00:00:00Z', '2026-09-21T00:03:00Z')).toBe(true);
        expect(covers(a, '2026-09-21T23:59:00Z', '2026-09-22T00:02:00Z')).toBe(false);
    });
});

describe('a failed or uncovered scan is not zero redemptions', () => {
    const now = '2026-09-24T12:00:00Z';
    const coverage = [{ from: '2026-09-20T00:00:00Z', to: '2026-09-24T10:00:00Z' }];
    const daily = {};
    bump(daily, '2026-09-24T09:00:00Z', 'mints', 3);

    test('covered days with nothing accepted read as none-observed with the covered span', () => {
        const s = summariseFeed({ coverage, daily, lastScan: { at: now, status: 'ok', backlog: 0 } }, { now });
        expect(s).toMatchObject({ state: 'none-observed', noRedemptionDays: 4.4, since: '2026-09-20T00:00:00Z' });
        expect(s.counts30d.redemptions).toBe(0);
    });

    test('a failed last scan is scan-failed, with no no-redemption claim, whatever coverage exists', () => {
        const s = summariseFeed({ coverage, daily, lastScan: { at: now, status: 'failed', error: 'getTransaction HTTP 503' } }, { now });
        expect(s.state).toBe('scan-failed');
        expect(s.noRedemptionDays).toBeNull();
        expect(s.message).toMatch(/failed/);
    });

    test('under a day of continuous coverage is not enough to call redemptions absent', () => {
        const short = [{ from: '2026-09-24T02:00:00Z', to: '2026-09-24T10:00:00Z' }];
        const s = summariseFeed({ coverage: short, daily: {}, lastScan: { at: now, status: 'ok', backlog: 0 } }, { now });
        expect(s.state).toBe('not-yet-covered');
        expect(s.noRedemptionDays ?? null).toBeNull();
        expect(s.message).toMatch(/too short/);
    });

    test('no coverage at all, or coverage older than 48 h, never yields none-observed', () => {
        expect(summariseFeed({ coverage: [], daily: {}, lastScan: { at: now, status: 'ok' } }, { now }).state).toBe('not-yet-covered');
        expect(summariseFeed({ coverage: [{ from: '2026-09-01T00:00:00Z', to: '2026-09-20T00:00:00Z' }], daily: {}, lastScan: { at: now, status: 'ok' } }, { now }).state)
            .toBe('stale');
    });

    test('a day outside coverage reports 0 covered hours, so its missing counts are not zeros', () => {
        const feed = publicFeed({ observable: true, coverage, daily: { '2026-09-18': { other: 1 }, '2026-09-24': { mints: 3 } }, lastScan: { at: now, status: 'ok' } }, { now });
        expect(feed.daily['2026-09-18'].coveredHours).toBe(0);
        expect(feed.daily['2026-09-24'].coveredHours).toBe(10);
        expect(coveredHoursOn(coverage, '2026-09-19')).toBe(0);
    });

    test('an accepted redemption inside coverage makes the state observed', () => {
        const lastObserved = { id: 'x', blockTime: '2026-09-24T08:00:00Z' };
        const d = {};
        bump(d, lastObserved.blockTime, 'redemptions');
        const s = summariseFeed({ coverage, daily: d, lastObserved, lastScan: { at: now, status: 'partial', backlog: 12 } }, { now });
        expect(s).toMatchObject({ state: 'observed', lastObservedAt: '2026-09-24T08:00:00Z', noRedemptionDays: 0.1 });
        expect(s.message).toMatch(/behind by 12/);
    });
});

describe('xStocks deposit settlement across runs', () => {
    const opts = {
        treasury: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS', redemptionAddresses: ['CgyuW2dWDJzWW2H1XTjPRkbg9Y41dW2Fjj69KWsiir8C'],
        xstockMints: new Set(['Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu']), stablecoins: { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC' }
    };
    const deposit = classifyXstocksLeg(xs.xsDeposit, opts);
    const sweep = classifyXstocksLeg(xs.xsSweep, opts);
    const payout = classifyXstocksLeg(xs.xsPayout, opts);
    const run = (coverage, payouts, now = '2026-09-23T16:00:00Z', price = 756.75) => resolveXstocksDeposits({
        deposits: [deposit], sweeps: [sweep], payouts, coverage, now, pair: pairXstocksRedemption, priceFor: () => price
    });

    test('a deposit whose settlement window is not yet covered stays pending, not rejected', () => {
        const r = run([{ from: '2026-09-23T15:00:00Z', to: '2026-09-23T15:05:30Z' }], []);
        expect(r.pending).toHaveLength(1);
        expect(r.rejected).toHaveLength(0);
    });

    test('once both scans cover the window it is accepted with its three legs', () => {
        const r = run([{ from: '2026-09-23T15:00:00Z', to: '2026-09-23T16:00:00Z' }], [payout]);
        expect(r.accepted).toHaveLength(1);
        expect(r.accepted[0].result).toMatchObject({ accepted: true, settlementSeconds: 46 });
    });

    test('a deposit the price collector has not run past yet waits instead of being rejected for no price', () => {
        const r = resolveXstocksDeposits({ deposits: [deposit], sweeps: [sweep], payouts: [payout],
            coverage: [{ from: '2026-09-23T15:00:00Z', to: '2026-09-23T16:00:00Z' }], now: '2026-09-23T16:00:00Z',
            pair: pairXstocksRedemption, priceFor: () => null, priceReadyFor: () => false });
        expect(r.pending).toHaveLength(1);
        expect(r.rejected).toHaveLength(0);
    });

    test('no price is a rejection with its reason; an uncovered window past the pending limit is "not scanned"', () => {
        expect(run([{ from: '2026-09-23T15:00:00Z', to: '2026-09-23T16:00:00Z' }], [payout], undefined, null).rejected[0].reason)
            .toBe('no independent reference price');
        expect(run([], [], '2026-09-27T00:00:00Z').rejected[0].reason).toBe('settlement window not covered by a completed scan');
    });
});

describe('builder merge into redemption usability', () => {
    const now = '2026-09-24T12:00:00Z';
    const snapshot = {
        status: 'observed-onchain-transaction', checkedAt: '2026-09-23T18:27:08Z', chain: 'solana', route: 'documented route',
        settlement: 'atomic', caveats: 'whitelisted wallets', searchWindow: { from: '2026-09-22T23:31:49Z', to: '2026-09-23T18:18:41Z' },
        accepted: [{ symbol: 'RTXon', signature: 'old' }]
    };
    const redemption = { available: true, operationalRouteAvailable: true, successfulRedemptionObserved: true, successfulRedemptionEvidence: snapshot };
    const row = { id: 'n1', signature: 'n1', blockTime: '2026-09-24T09:00:00Z', symbol: 'NVDAon', tokenMint: 'm' };
    const daily = {};
    bump(daily, row.blockTime, 'redemptions', 57);
    const entry = {
        observable: true, mechanism: 'atomic-program-redemption', addresses: { a: {} },
        coverage: [{ from: '2026-09-23T18:00:00Z', to: '2026-09-24T11:00:00Z' }], daily,
        recent: pushRecent([], [row]), lastObserved: row, byProduct: { m: { symbol: 'NVDAon', lastAt: row.blockTime }, k: { symbol: 'TSLAon', lastAt: row.blockTime } },
        lastScan: { at: '2026-09-24T11:00:00Z', status: 'ok', backlog: 0 }
    };

    test('a newer recurring observation replaces the one-off snapshot as observed-execution evidence', () => {
        const merged = mergeObservationIntoRedemption(redemption, entry, { now });
        expect(merged.successfulRedemptionEvidence).toMatchObject({
            status: 'observed-onchain-recurring-scan', acceptedCount: 57, latestObservedAt: row.blockTime, route: 'documented route',
            supersedes: { checkedAt: snapshot.checkedAt }
        });
        expect(merged.operationalRouteAvailable).toBe(true);
        expect(merged.observationFeed.state).toBe('observed');
        const field = shapeRedemptionUsability({ redemption: merged, successfulRedemptionObserved: true,
            successfulRedemptionEvidence: merged.successfulRedemptionEvidence }).fields.find((f) => f.id === 'successful-redemption');
        expect(field.summary).toBe('Observed on-chain: 57 completed redemptions (NVDAon, TSLAon).');
        expect(field.completeText).toMatch(/Latest observed 2026-09-24T09:00:00Z/);
        expect(field.evidenceDetail).toMatchObject({ transactions: 57, latestObservedAt: row.blockTime });
    });

    test('a failed scan keeps the snapshot and says scan-failed; an older feed never overwrites a newer snapshot', () => {
        const failed = mergeObservationIntoRedemption(redemption, { ...entry, recent: [], lastObserved: null, lastScan: { at: now, status: 'failed', error: 'x' } }, { now });
        expect(failed.successfulRedemptionEvidence).toBe(snapshot);
        expect(failed.observationFeed.state).toBe('scan-failed');
        const old = { ...row, blockTime: '2026-09-23T10:00:00Z' };
        expect(mergeObservationIntoRedemption(redemption, { ...entry, recent: [old], lastObserved: old }, { now }).successfulRedemptionEvidence).toBe(snapshot);
    });

    test('an on-chain leg whose completion is off-chain (Superstate) stays in the feed and never becomes an observed redemption', () => {
        const merged = mergeObservationIntoRedemption({ available: true }, { ...entry, completionObservable: false }, { now });
        expect(merged.successfulRedemptionObserved).toBeUndefined();
        expect(merged.successfulRedemptionEvidence).toBeUndefined();
        expect(merged.observationFeed).toMatchObject({ state: 'observed', completionObservable: false });
    });

    test('a not-observable programme gets the reason, and its observed-execution answer is untouched', () => {
        const merged = mergeObservationIntoRedemption({ available: true, successfulRedemptionObserved: false },
            { observable: false, mechanism: 'discretionary-off-chain-request', whyNotObservable: 'no address', lastScan: { at: now, status: 'ok' } }, { now });
        expect(merged.successfulRedemptionObserved).toBe(false);
        expect(merged.observationFeed).toMatchObject({ observable: false, whyNotObservable: 'no address' });
        expect(mergeObservationIntoRedemption(redemption, null)).toBe(redemption);
    });
});
