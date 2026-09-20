// Unit tests for the pure health rules (lib/health.mjs). Every band is pinned at its boundary from
// both sides — 1.00 % is good and 1.01 % is not — because an off-by-a-hair comparison is exactly the
// kind of change that silently repaints hundreds of cards. The synthetic fixtures use the real field
// names of stocks-tokens.json / stocks-issuers.json / stocks/data/holders.json / stocks-trades.json,
// and the last suite runs the rules over those four real files so a shape drift in any of them fails
// here rather than on the page.

const fs = require('node:fs');
const path = require('node:path');

const {
    STATUSES,
    HEALTH_DIMENSIONS,
    HEALTH_RULES,
    topSharePctExcludingLabels,
    evaluateHealth,
    worstStatus
} = require('./lib/health.mjs');
const { composabilityTemplateFor, indexComposabilityTemplates } = require('./lib/composability.mjs');

// --- Fixture builders -------------------------------------------------------------------------
// Everything defaults to null, so each test states only the inputs its rule reads and every other
// rule stays honestly unknown.

function makeToken({ control, market, activity, reference, issuerApi } = {}) {
    return {
        mint: 'TestMint1111111111111111111111111111111111',
        symbol: 'TEST',
        control: { paused: null, rebase: null, ...control },
        market: { usdPrice: null, liquidity: null, organicSharePct: null, ...market },
        activity: {
            trades24: null,
            tradesPerTrader: null,
            dexPairs: null,
            venueSpreadPct: null,
            venueSpreadLow: null,
            venueSpreadHigh: null,
            venuesPriced: null,
            ...activity
        },
        reference: { source: null, price: null, premiumPct: null, marketOpen: null, ageSeconds: null, ...reference },
        issuerApi: issuerApi === undefined ? null : issuerApi
    };
}

function makeIssuer({ grades, custodyVerification, keyGovernance } = {}) {
    return {
        slug: 'test-issuer',
        grades: { verificationStrength: null, verificationLabel: null, ...grades },
        custodyVerification: { type: null, machineReadable: null, ...custodyVerification },
        keyGovernance: { mint: null, freeze: null, delegate: null, rebase: null, ...keyGovernance }
    };
}

/** One `top20[]` entry. `amountUi` defaults to the share so dedupeOwners' ordering is deterministic. */
function holder({ owner, sharePct, amountUi, ownerLabel = null, state = 'initialized', tokenAccount }) {
    return {
        tokenAccount: tokenAccount ?? `${owner}-ata`,
        owner,
        amountUi: amountUi === undefined ? sharePct : amountUi,
        sharePct,
        state,
        ownerLabel
    };
}

function makeHolders({ top20 = [], top1SharePct = null, distinctOwnersTop20 = null, frozenAccountsTop20 = null } = {}) {
    return { mint: 'TestMint1111111111111111111111111111111111', symbol: 'TEST', top20, top1SharePct, distinctOwnersTop20, frozenAccountsTop20 };
}

function ruleOf(result, id) {
    const rule = result.rules.find((entry) => entry.id === id);
    if (rule === undefined) throw new Error(`no rule ${id} in the result`);
    return rule;
}

/** The status one rule reaches for a given input — the shorthand nearly every case below uses. */
function statusOf(id, input) {
    return ruleOf(evaluateHealth(input), id).status;
}

function makeComposability(healthStatus = 'good') {
    return {
        id: 'test-template',
        healthStatus,
        summary: 'A reviewed test template whose status is supplied by the fixture.',
        scenarios: {
            escrow: { outcome: 'permissionless' },
            borrowerDefault: { outcome: 'onchain-enforceable' },
            protocolHack: { outcome: 'final' },
            accessLoss: { outcome: 'no-onchain-rescue' }
        }
    };
}

const RULE_IDS = [
    'tracking',
    'liquidity',
    'organic',
    'failedTx',
    'concentration',
    'verification',
    'defiComposability',
    'keyControl',
    'paused',
    'frozen',
    'spread'
];

// --- Contract ---------------------------------------------------------------------------------

describe('exported contract', () => {
    test('STATUSES is the four statuses in severity order', () => {
        expect(STATUSES).toEqual(['good', 'caution', 'warning', 'unknown']);
    });

    test('HEALTH_RULES has eleven entries whose ids are the rule ids in order', () => {
        expect(HEALTH_RULES).toHaveLength(11);
        expect(HEALTH_RULES.map((rule) => rule.id)).toEqual(RULE_IDS);
    });

    test('every rule belongs to one of the four health dimensions', () => {
        expect(HEALTH_DIMENSIONS.map((dimension) => dimension.id)).toEqual(['market', 'control', 'legal', 'composability']);
        expect(new Set(HEALTH_RULES.map((rule) => rule.dimension))).toEqual(new Set(['market', 'control', 'legal', 'composability']));
    });

    test('every HEALTH_RULES entry carries a label, a description and threshold strings', () => {
        for (const rule of HEALTH_RULES) {
            expect(typeof rule.label).toBe('string');
            expect(rule.label.length).toBeGreaterThan(0);
            expect(typeof rule.description).toBe('string');
            expect(rule.description.length).toBeGreaterThan(10);
            for (const band of ['good', 'caution', 'warning']) {
                expect(band in rule.thresholds).toBe(true);
                const value = rule.thresholds[band];
                expect(value === null || (typeof value === 'string' && value.length > 0)).toBe(true);
            }
        }
    });

    test('the bands a rule can never reach are null, not invented text', () => {
        const byId = Object.fromEntries(HEALTH_RULES.map((rule) => [rule.id, rule.thresholds]));
        expect(byId.keyControl.warning).toBeNull();
        expect(byId.frozen.warning).toBeNull();
        expect(byId.paused.caution).toBeNull();
        expect(byId.tracking.warning).not.toBeNull();
    });

    test('evaluateHealth returns the eleven rules in the fixed order with the full per-rule shape', () => {
        const result = evaluateHealth({ token: makeToken() });
        expect(result.rules).toHaveLength(11);
        expect(result.rules.map((rule) => rule.id)).toEqual(RULE_IDS);
        for (const rule of result.rules) {
            expect(Object.keys(rule).sort()).toEqual(['dimension', 'id', 'inputs', 'label', 'note', 'status', 'threshold', 'value']);
            expect(STATUSES).toContain(rule.status);
            expect(rule.value === null || Number.isFinite(rule.value)).toBe(true);
            expect(typeof rule.threshold).toBe('string');
            expect(rule.threshold.length).toBeGreaterThan(0);
            expect(typeof rule.note).toBe('string');
            expect(rule.note.length).toBeGreaterThan(0);
            expect(typeof rule.inputs).toBe('object');
            expect(rule.inputs).not.toBeNull();
        }
    });

    test('market, control, legal/evidence and composability are judged independently', () => {
        const result = evaluateHealth({
            token: makeToken({
                market: { usdPrice: 100, liquidity: 500000 },
                reference: { price: 100, premiumPct: 0 }
            }),
            issuer: { grades: { verificationStrength: 0 }, keyGovernance: { mint: 'multisig' } },
            holders: { top20: [{ owner: 'wallet', sharePct: 10, ownerLabel: null }], frozenAccountsTop20: 0 },
            pools: [{ signaturesSeen: 10, failedTx: 0 }]
        });
        expect(result.dimensions.market.status).toBe('good');
        expect(result.dimensions.control.status).toBe('good');
        expect(result.dimensions.legal).toEqual({ status: 'warning', worstRuleId: 'verification' });
        expect(result.dimensions.composability).toEqual({ status: 'unknown', worstRuleId: null });
        expect(result.status).toBe('warning');
    });

    test('the threshold string reads like the tracking example', () => {
        const rule = ruleOf(evaluateHealth({ token: makeToken() }), 'tracking');
        expect(rule.threshold).toBe('≤ 1 % good · ≤ 3 % caution · > 3 % warning');
    });

    test('a rule that cannot warn does not advertise a warning band in its threshold string', () => {
        const result = evaluateHealth({ token: makeToken() });
        expect(ruleOf(result, 'keyControl').threshold).not.toMatch(/warning/);
        expect(ruleOf(result, 'frozen').threshold).not.toMatch(/warning/);
        expect(ruleOf(result, 'paused').threshold).not.toMatch(/caution/);
    });

    test('evaluateHealth survives being called with nothing at all', () => {
        for (const input of [undefined, {}, null]) {
            const result = evaluateHealth(input);
            expect(result.status).toBe('unknown');
            expect(result.worstRuleId).toBeNull();
            expect(result.rules).toHaveLength(11);
        }
    });
});

// --- worstStatus ------------------------------------------------------------------------------

describe('worstStatus', () => {
    test.each([
        [['good', 'good'], 'good'],
        [['good', 'caution'], 'caution'],
        [['caution', 'warning', 'good'], 'warning'],
        [['warning'], 'warning'],
        [['good', 'unknown'], 'good'],
        [['caution', 'unknown', 'good'], 'caution'],
        [['unknown', 'unknown'], 'unknown'],
        [[], 'unknown']
    ])('%j → %s', (statuses, expected) => {
        expect(worstStatus(statuses)).toBe(expected);
    });

    test('unknown is never counted as bad, however many there are', () => {
        expect(worstStatus(['unknown', 'unknown', 'unknown', 'good'])).toBe('good');
    });

    test('an unrecognised status is ignored rather than ranked', () => {
        expect(worstStatus(['good', 'catastrophic', null, undefined])).toBe('good');
        expect(worstStatus(['nonsense'])).toBe('unknown');
    });

    test('a non-array is unknown rather than a crash', () => {
        expect(worstStatus(null)).toBe('unknown');
        expect(worstStatus('warning')).toBe('unknown');
    });
});

// --- topSharePctExcludingLabels ---------------------------------------------------------------

describe('topSharePctExcludingLabels', () => {
    const ISSUER = holder({ owner: 'AuthorityOwner', sharePct: 60, amountUi: 600, ownerLabel: 'issuer-authority' });
    const BURN = holder({ owner: 'BurnOwner', sharePct: 10, amountUi: 100, ownerLabel: 'burn-address' });
    const WHALE = holder({ owner: 'WhaleOwner', sharePct: 18, amountUi: 180 });
    const SECOND = holder({ owner: 'SecondOwner', sharePct: 7, amountUi: 70 });
    const THIRD = holder({ owner: 'ThirdOwner', sharePct: 3, amountUi: 30 });

    test('skips labelled rows and sums the biggest n unlabelled ones', () => {
        const top20 = [ISSUER, WHALE, BURN, SECOND, THIRD];
        expect(topSharePctExcludingLabels(top20, 1)).toBeCloseTo(18, 10);
        expect(topSharePctExcludingLabels(top20, 2)).toBeCloseTo(25, 10);
        expect(topSharePctExcludingLabels(top20, 3)).toBeCloseTo(28, 10);
        // n beyond the number of unlabelled rows just sums them all.
        expect(topSharePctExcludingLabels(top20, 20)).toBeCloseTo(28, 10);
    });

    test('the denominator is NOT renormalised — the labelled 70 % stays in the supply base', () => {
        // Were the labelled rows' 70 % removed from the denominator, the whale's 18/30 would read 60 %.
        expect(topSharePctExcludingLabels([ISSUER, BURN, WHALE], 1)).toBeCloseTo(18, 10);
    });

    test('one owner across two token accounts is one row, its shares summed', () => {
        const top20 = [
            holder({ owner: 'Split', sharePct: 12, amountUi: 120, tokenAccount: 'ata-a' }),
            holder({ owner: 'Other', sharePct: 11, amountUi: 110 }),
            holder({ owner: 'Split', sharePct: 9, amountUi: 90, tokenAccount: 'ata-b' })
        ];
        expect(topSharePctExcludingLabels(top20, 1)).toBeCloseTo(21, 10);
    });

    test('null (never 0) when there is nothing summable', () => {
        expect(topSharePctExcludingLabels([], 1)).toBeNull();
        expect(topSharePctExcludingLabels([ISSUER, BURN], 1)).toBeNull();
        expect(topSharePctExcludingLabels(null, 1)).toBeNull();
        expect(topSharePctExcludingLabels(undefined, 1)).toBeNull();
        // A supply of 0 leaves every sharePct null; the answer must stay null, not become 0.
        expect(topSharePctExcludingLabels([holder({ owner: 'Zero', sharePct: null, amountUi: 5 })], 1)).toBeNull();
    });

    test('a non-positive or non-integer n sums nothing', () => {
        const top20 = [WHALE, SECOND];
        expect(topSharePctExcludingLabels(top20, 0)).toBeNull();
        expect(topSharePctExcludingLabels(top20, -1)).toBeNull();
        expect(topSharePctExcludingLabels(top20, 1.5)).toBeNull();
    });
});

describe('DeFi composability', () => {
    test.each(['good', 'caution', 'warning'])('the reviewed template status %s becomes the dimension status', (status) => {
        const result = evaluateHealth({ composabilityTemplate: makeComposability(status) });
        const rule = ruleOf(result, 'defiComposability');
        expect(rule.status).toBe(status);
        expect(rule.inputs).toEqual({
            templateId: 'test-template', escrow: 'permissionless',
            borrowerDefault: 'onchain-enforceable', protocolHack: 'final', accessLoss: 'no-onchain-rescue'
        });
        expect(result.dimensions.composability).toEqual({ status, worstRuleId: 'defiComposability' });
    });

    test('missing review is unknown, never treated as non-composable', () => {
        const result = evaluateHealth({});
        expect(ruleOf(result, 'defiComposability').status).toBe('unknown');
        expect(result.dimensions.composability).toEqual({ status: 'unknown', worstRuleId: null });
    });
});

// --- 1. tracking ------------------------------------------------------------------------------

describe('tracking', () => {
    const at = (premiumPct) => makeToken({ reference: { premiumPct, source: 'pyth', price: 100 }, market: { usdPrice: 101 } });

    test.each([
        [0, 'good'],
        [0.99, 'good'],
        [1, 'good'],
        [1.01, 'caution'],
        [2.99, 'caution'],
        [3, 'caution'],
        [3.01, 'warning'],
        [40, 'warning']
    ])('premium %p %% → %s', (premiumPct, expected) => {
        expect(statusOf('tracking', { token: at(premiumPct) })).toBe(expected);
    });

    test('the band is on the absolute premium, so a discount grades like a premium', () => {
        expect(statusOf('tracking', { token: at(-1) })).toBe('good');
        expect(statusOf('tracking', { token: at(-1.01) })).toBe('caution');
        expect(statusOf('tracking', { token: at(-3.01) })).toBe('warning');
    });

    test('value is the absolute premium and the note names the direction', () => {
        expect(ruleOf(evaluateHealth({ token: at(-2.5) }), 'tracking').value).toBeCloseTo(2.5, 10);
        expect(ruleOf(evaluateHealth({ token: at(-2.5) }), 'tracking').note).toMatch(/below/);
        expect(ruleOf(evaluateHealth({ token: at(2.5) }), 'tracking').note).toMatch(/above/);
    });

    test('no reference premium → unknown with a null value', () => {
        const rule = ruleOf(evaluateHealth({ token: makeToken() }), 'tracking');
        expect(rule.status).toBe('unknown');
        expect(rule.value).toBeNull();
        expect(rule.note).toMatch(/cannot be measured/);
    });

    test('inputs carry the reference source, price, age, market state and on-chain price', () => {
        const token = makeToken({
            reference: { premiumPct: 0.5, source: 'ondo-implied', price: 333.335, ageSeconds: 42, marketOpen: false },
            market: { usdPrice: 332.37 }
        });
        expect(ruleOf(evaluateHealth({ token }), 'tracking').inputs).toEqual({
            referenceSource: 'ondo-implied',
            referencePrice: 333.335,
            ageSeconds: 42,
            marketOpen: false,
            usdPrice: 332.37
        });
    });

    test('a closed underlying market is flagged in the note, not in the status', () => {
        const token = makeToken({ reference: { premiumPct: 0.2, source: 'pyth', marketOpen: false } });
        const rule = ruleOf(evaluateHealth({ token }), 'tracking');
        expect(rule.status).toBe('good');
        expect(rule.note).toMatch(/market closed/);
    });
});

// --- 2. liquidity -----------------------------------------------------------------------------

describe('liquidity', () => {
    const at = (liquidity) => makeToken({ market: { liquidity } });

    test.each([
        [0, 'warning'],
        [9999, 'warning'],
        [10000, 'caution'],
        [10001, 'caution'],
        [99999, 'caution'],
        [100000, 'good'],
        [5000000, 'good']
    ])('$%p of liquidity → %s', (liquidity, expected) => {
        expect(statusOf('liquidity', { token: at(liquidity) })).toBe(expected);
    });

    test('no liquidity figure → unknown, and the note says so rather than reading as $0', () => {
        const rule = ruleOf(evaluateHealth({ token: makeToken() }), 'liquidity');
        expect(rule.status).toBe('unknown');
        expect(rule.value).toBeNull();
        expect(rule.note).toBe('no venue reports liquidity');
    });

    test('a reported liquidity of exactly 0 is a warning, not an unknown', () => {
        const rule = ruleOf(evaluateHealth({ token: at(0) }), 'liquidity');
        expect(rule.status).toBe('warning');
        expect(rule.value).toBe(0);
    });

    test('inputs carry the liquidity and the DEX pair count', () => {
        const token = makeToken({ market: { liquidity: 892.06 }, activity: { dexPairs: 3 } });
        expect(ruleOf(evaluateHealth({ token }), 'liquidity').inputs).toEqual({ liquidityUsd: 892.06, dexPairs: 3 });
    });
});

// --- 3. organic -------------------------------------------------------------------------------

describe('organic', () => {
    const at = ({ organicSharePct = null, tradesPerTrader = null, trades24 = 100 }) =>
        makeToken({ market: { organicSharePct }, activity: { tradesPerTrader, trades24 } });

    test.each([
        [24, 'good'],
        [25, 'good'],
        [26, 'caution']
    ])('%p trades per trader with a healthy organic share → %s', (tradesPerTrader, expected) => {
        expect(statusOf('organic', { token: at({ organicSharePct: 40, tradesPerTrader }) })).toBe(expected);
    });

    test.each([
        [9.99, 'caution'],
        [10, 'good'],
        [10.01, 'good']
    ])('%p %% organic share with a healthy trades-per-trader → %s', (organicSharePct, expected) => {
        expect(statusOf('organic', { token: at({ organicSharePct, tradesPerTrader: 2 }) })).toBe(expected);
    });

    test('both failing is a warning', () => {
        expect(statusOf('organic', { token: at({ organicSharePct: 9.99, tradesPerTrader: 25.01 }) })).toBe('warning');
    });

    test('both at their exact boundaries is good', () => {
        expect(statusOf('organic', { token: at({ organicSharePct: 10, tradesPerTrader: 25 }) })).toBe('good');
    });

    test.each([
        [null, /no 24 h trade count/],
        [0, /no trades in 24 h/]
    ])('trades24 %p → unknown', (trades24, noteMatch) => {
        const token = at({ organicSharePct: 1, tradesPerTrader: 900, trades24 });
        const rule = ruleOf(evaluateHealth({ token }), 'organic');
        expect(rule.status).toBe('unknown');
        expect(rule.note).toMatch(noteMatch);
    });

    test('with only the organic share known it is judged alone and the note says so', () => {
        const pass = ruleOf(evaluateHealth({ token: at({ organicSharePct: 12 }) }), 'organic');
        expect(pass.status).toBe('good');
        expect(pass.note).toMatch(/trades per trader is not reported/);
        expect(pass.value).toBeCloseTo(12, 10);

        const fail = ruleOf(evaluateHealth({ token: at({ organicSharePct: 4 }) }), 'organic');
        expect(fail.status).toBe('caution');
        expect(fail.note).toMatch(/trades per trader is not reported/);
    });

    test('with only trades-per-trader known it is judged alone and the note says so', () => {
        const pass = ruleOf(evaluateHealth({ token: at({ tradesPerTrader: 1.4 }) }), 'organic');
        expect(pass.status).toBe('good');
        expect(pass.note).toMatch(/organic share is not reported/);
        expect(pass.value).toBeCloseTo(1.4, 10);

        const fail = ruleOf(evaluateHealth({ token: at({ tradesPerTrader: 400 }) }), 'organic');
        expect(fail.status).toBe('caution');
        expect(fail.note).toMatch(/organic share is not reported/);
    });

    test('a single known input can never reach warning on its own', () => {
        expect(statusOf('organic', { token: at({ tradesPerTrader: 10000 }) })).toBe('caution');
        expect(statusOf('organic', { token: at({ organicSharePct: 0 }) })).toBe('caution');
    });

    test('trades happened but neither flow input is reported → unknown', () => {
        const rule = ruleOf(evaluateHealth({ token: at({}) }), 'organic');
        expect(rule.status).toBe('unknown');
        expect(rule.note).toMatch(/neither the organic share nor trades-per-trader/);
    });

    test('inputs carry all three raw numbers', () => {
        const token = at({ organicSharePct: 33.3, tradesPerTrader: 1.4, trades24: 42 });
        expect(ruleOf(evaluateHealth({ token }), 'organic').inputs).toEqual({
            organicSharePct: 33.3,
            tradesPerTrader: 1.4,
            trades24: 42
        });
    });
});

// --- 4. failedTx ------------------------------------------------------------------------------

describe('failedTx', () => {
    const pool = (signaturesSeen, failedTx, extra = {}) => ({
        pair: 'PoolPair1111',
        dex: 'raydium',
        signaturesSeen,
        failedTx,
        ...extra
    });

    test.each([
        [0, 'good'],
        [20, 'good'],
        [21, 'caution'],
        [49, 'caution'],
        [50, 'caution'],
        [51, 'warning'],
        [100, 'warning']
    ])('%p failed of 100 signatures → %s', (failed, expected) => {
        expect(statusOf('failedTx', { pools: [pool(100, failed)] })).toBe(expected);
    });

    test('the ratio is pooled across pools, not averaged per pool', () => {
        // 5/10 in one pool and 5/90 in another is 10/100 = 10 %, not the 27.8 % a per-pool mean gives.
        const rule = ruleOf(evaluateHealth({ pools: [pool(10, 5), pool(90, 5)] }), 'failedTx');
        expect(rule.value).toBeCloseTo(10, 10);
        expect(rule.status).toBe('good');
        expect(rule.inputs.signaturesSeen).toBe(100);
        expect(rule.inputs.failedTx).toBe(10);
    });

    test('pools with no signatures are excluded from the denominator', () => {
        const rule = ruleOf(evaluateHealth({ pools: [pool(0, 0), pool(50, 30)] }), 'failedTx');
        expect(rule.value).toBeCloseTo(60, 10);
        expect(rule.inputs.poolsCounted).toBe(1);
        expect(rule.inputs.signaturesSeen).toBe(50);
    });

    test('a pool with signatures but no failure figure is not counted as having failed nothing', () => {
        const rule = ruleOf(evaluateHealth({ pools: [pool(100, null), pool(10, 6)] }), 'failedTx');
        expect(rule.value).toBeCloseTo(60, 10);
        expect(rule.inputs.signaturesSeen).toBe(10);
        expect(rule.inputs.poolsCounted).toBe(1);
        // It is still listed, so the card can show the gap.
        expect(rule.inputs.pools).toHaveLength(2);
        expect(rule.inputs.pools[0].failedTx).toBeNull();
    });

    test.each([
        [[], /no swap pool was sampled/],
        [[pool(0, 0)], /no usable signature counts/],
        [[pool(null, null)], /no usable signature counts/]
    ])('%j → unknown', (pools, noteMatch) => {
        const rule = ruleOf(evaluateHealth({ pools }), 'failedTx');
        expect(rule.status).toBe('unknown');
        expect(rule.value).toBeNull();
        expect(rule.note).toMatch(noteMatch);
    });

    test('no pools field at all is unknown, not 0 %', () => {
        const rule = ruleOf(evaluateHealth({ token: makeToken() }), 'failedTx');
        expect(rule.status).toBe('unknown');
        expect(rule.value).toBeNull();
    });

    test('inputs list each pool with its pair, dex and counts', () => {
        const rule = ruleOf(evaluateHealth({ pools: [pool(50, 3, { pair: 'AbcPair', dex: 'orca', decoded: 17 })] }), 'failedTx');
        expect(rule.inputs.pools).toEqual([{ pair: 'AbcPair', dex: 'orca', signaturesSeen: 50, failedTx: 3 }]);
    });
});

// --- 5. concentration -------------------------------------------------------------------------

describe('concentration', () => {
    const AUTHORITY = holder({ owner: 'AuthorityOwner', sharePct: 60, amountUi: 6000, ownerLabel: 'issuer-authority' });
    const BURN = holder({ owner: 'BurnOwner', sharePct: 12, amountUi: 1200, ownerLabel: 'burn-address' });

    /** Both labelled rows sit ABOVE the unlabelled one, so a rule that forgot to skip them would grade 60 %. */
    const withTop1 = (sharePct) => makeHolders({
        top20: [
            AUTHORITY,
            BURN,
            holder({ owner: 'BiggestWallet', sharePct, amountUi: sharePct * 10 }),
            holder({ owner: 'SmallWallet', sharePct: 1, amountUi: 10 })
        ],
        top1SharePct: 60,
        distinctOwnersTop20: 4,
        frozenAccountsTop20: 0
    });

    test.each([
        [1, 'good'],
        [24, 'good'],
        [25, 'good'],
        [26, 'caution'],
        [49, 'caution'],
        [50, 'caution'],
        [51, 'warning'],
        [90, 'warning']
    ])('%p %% held by the biggest unlabelled wallet → %s', (sharePct, expected) => {
        expect(statusOf('concentration', { holders: withTop1(sharePct) })).toBe(expected);
    });

    test('the labelled issuer authority and burn address are excluded from the judged value', () => {
        const rule = ruleOf(evaluateHealth({ holders: withTop1(25) }), 'concentration');
        expect(rule.value).toBeCloseTo(25, 10);
        expect(rule.status).toBe('good');
        expect(rule.inputs.top1SharePct).toBeCloseTo(60, 10);
        expect(rule.inputs.excluded).toEqual([
            { ownerLabel: 'issuer-authority', sharePct: 60 },
            { ownerLabel: 'burn-address', sharePct: 12 }
        ]);
    });

    test('inputs carry the cumulative unlabelled shares and the distinct owner count', () => {
        const rule = ruleOf(evaluateHealth({ holders: withTop1(30) }), 'concentration');
        expect(rule.inputs.top1SharePctExcludingLabels).toBeCloseTo(30, 10);
        expect(rule.inputs.top5SharePctExcludingLabels).toBeCloseTo(31, 10);
        expect(rule.inputs.top20SharePctExcludingLabels).toBeCloseTo(31, 10);
        expect(rule.inputs.distinctOwnersTop20).toBe(4);
    });

    test('no holder snapshot → unknown', () => {
        const rule = ruleOf(evaluateHealth({ token: makeToken() }), 'concentration');
        expect(rule.status).toBe('unknown');
        expect(rule.value).toBeNull();
        expect(rule.note).toMatch(/no holder snapshot/);
    });

    test('a snapshot of nothing but labelled rows → unknown, not 0 %', () => {
        const rule = ruleOf(evaluateHealth({ holders: makeHolders({ top20: [AUTHORITY, BURN] }) }), 'concentration');
        expect(rule.status).toBe('unknown');
        expect(rule.value).toBeNull();
        expect(rule.note).toMatch(/no unlabelled holder/);
    });

    test('a supply of 0 leaves every share null, so the rule stays unknown', () => {
        const holders = makeHolders({ top20: [holder({ owner: 'Only', sharePct: null, amountUi: 12 })] });
        expect(statusOf('concentration', { holders })).toBe('unknown');
    });
});

// --- 6. verification --------------------------------------------------------------------------

describe('verification', () => {
    const at = (verificationStrength, extra = {}) => makeIssuer({
        grades: { verificationStrength, verificationLabel: 'daily agent' },
        custodyVerification: { type: 'daily-verification-agent', machineReadable: false },
        ...extra
    });

    test.each([
        [0, 'warning'],
        [1, 'caution'],
        [2, 'caution'],
        [3, 'good'],
        [4, 'good'],
        [5, 'good']
    ])('verification strength %p → %s', (strength, expected) => {
        expect(statusOf('verification', { issuer: at(strength) })).toBe(expected);
    });

    test('no issuer record → unknown, not a zero strength', () => {
        const rule = ruleOf(evaluateHealth({ token: makeToken() }), 'verification');
        expect(rule.status).toBe('unknown');
        expect(rule.value).toBeNull();
        expect(rule.note).toMatch(/unrated/);
    });

    test('an issuer with no strength recorded → unknown', () => {
        expect(statusOf('verification', { issuer: makeIssuer() })).toBe('unknown');
    });

    test('inputs carry the custody type, the machine-readable flag and the label', () => {
        const issuer = makeIssuer({
            grades: { verificationStrength: 5, verificationLabel: 'register' },
            custodyVerification: { type: 'transfer-agent-register', machineReadable: true }
        });
        const rule = ruleOf(evaluateHealth({ issuer }), 'verification');
        expect(rule.inputs).toEqual({ custodyType: 'transfer-agent-register', machineReadable: true, verificationLabel: 'register' });
        expect(rule.note).toMatch(/machine-readable/);
    });
});

// --- 7. keyControl ----------------------------------------------------------------------------

describe('keyControl', () => {
    const gov = (keyGovernance) => makeIssuer({ keyGovernance });

    test('any hot key is a caution', () => {
        expect(statusOf('keyControl', { issuer: gov({ mint: 'hot-key', freeze: 'unknown', delegate: null }) })).toBe('caution');
        expect(statusOf('keyControl', { issuer: gov({ mint: 'unknown', freeze: 'hot-key', delegate: 'unknown' }) })).toBe('caution');
        expect(statusOf('keyControl', { issuer: gov({ mint: 'program', freeze: 'multisig', delegate: 'hot-key' }) })).toBe('caution');
    });

    test('a multisig or a program with no hot key is good', () => {
        expect(statusOf('keyControl', { issuer: gov({ mint: 'multisig', freeze: 'unknown', delegate: null }) })).toBe('good');
        expect(statusOf('keyControl', { issuer: gov({ mint: 'unknown', freeze: 'program', delegate: 'program' }) })).toBe('good');
        expect(statusOf('keyControl', { issuer: gov({ mint: 'multisig', freeze: 'multisig', delegate: 'multisig' }) })).toBe('good');
    });

    test('nothing judgeable is unknown — none/unknown/null say nothing either way', () => {
        expect(statusOf('keyControl', { issuer: gov({ mint: 'unknown', freeze: 'unknown', delegate: 'unknown' }) })).toBe('unknown');
        expect(statusOf('keyControl', { issuer: gov({ mint: 'none', freeze: 'none', delegate: 'none' }) })).toBe('unknown');
        expect(statusOf('keyControl', { issuer: gov({}) })).toBe('unknown');
        expect(statusOf('keyControl', { token: makeToken() })).toBe('unknown');
    });

    test('this rule never warns, whatever the keys are', () => {
        const combos = [
            { mint: 'hot-key', freeze: 'hot-key', delegate: 'hot-key' },
            { mint: 'none', freeze: 'hot-key', delegate: 'unknown' },
            { mint: 'gibberish', freeze: 'gibberish', delegate: 'gibberish' }
        ];
        for (const combo of combos) {
            expect(statusOf('keyControl', { issuer: gov(combo) })).not.toBe('warning');
        }
    });

    test('value is null and inputs are the four authority values', () => {
        const rule = ruleOf(evaluateHealth({ issuer: gov({ mint: 'unknown', freeze: 'program', delegate: 'program', rebase: 'program' }) }), 'keyControl');
        expect(rule.value).toBeNull();
        expect(rule.inputs).toEqual({ mint: 'unknown', freeze: 'program', delegate: 'program', rebase: 'program' });
        expect(rule.note).toMatch(/3 of 4/);
    });

    test('the note names which authority is on a hot key', () => {
        const rule = ruleOf(evaluateHealth({ issuer: gov({ mint: 'hot-key', freeze: 'hot-key', delegate: 'unknown' }) }), 'keyControl');
        expect(rule.note).toMatch(/mint, freeze/);
    });

    // --- the fourth authority: rebase (MODEL.md §2.7) -----------------------------------------

    test('a hot-key rebase authority alone is a caution, exactly like the other three', () => {
        // xStocks: mint hot-key is already a caution, but Superstate is the case that matters —
        // freeze and delegate are program-held and the rebase key is the weak one.
        const issuer = gov({ mint: 'program', freeze: 'program', delegate: 'program', rebase: 'hot-key' });
        const rule = ruleOf(evaluateHealth({ issuer, token: makeToken({ control: { rebase: true } }) }), 'keyControl');
        expect(rule.status).toBe('caution');
        expect(rule.note).toBe('rebase authority held by a hot key');
    });

    test('a rebase authority is skipped for a mint KNOWN to carry no scaled-UI extension', () => {
        // Tessera has no scaledUiAmountConfig on any mint, so an issuer-level rebase value says
        // nothing about that mint and must not drag its verdict down.
        const issuer = gov({ mint: 'program', freeze: 'program', delegate: 'program', rebase: 'hot-key' });
        const rule = ruleOf(evaluateHealth({ issuer, token: makeToken({ control: { rebase: false } }) }), 'keyControl');
        expect(rule.status).toBe('good');
        expect(rule.note).toMatch(/3 of 3/);
        // The value is still reported in the inputs — the rule skipped it, it did not hide it.
        expect(rule.inputs.rebase).toBe('hot-key');
    });

    test('an unread control block leaves the issuer-level rebase value standing', () => {
        const issuer = gov({ mint: 'program', freeze: 'program', delegate: 'program', rebase: 'hot-key' });
        expect(statusOf('keyControl', { issuer, token: makeToken({ control: { rebase: null } }) })).toBe('caution');
        expect(statusOf('keyControl', { issuer })).toBe('caution');
    });

    test("a rebase of 'none' is not a governance credit and not a fault", () => {
        const issuer = gov({ mint: 'multisig', freeze: 'multisig', delegate: 'multisig', rebase: 'none' });
        const rule = ruleOf(evaluateHealth({ issuer, token: makeToken({ control: { rebase: false } }) }), 'keyControl');
        expect(rule.status).toBe('good');
        expect(rule.note).toMatch(/3 of 3/);
    });

    test('a strong rebase authority counts towards the good note', () => {
        const rule = ruleOf(evaluateHealth({
            issuer: gov({ mint: 'multisig', freeze: 'multisig', delegate: 'multisig', rebase: 'multisig' }),
            token: makeToken({ control: { rebase: true } })
        }), 'keyControl');
        expect(rule.status).toBe('good');
        expect(rule.note).toMatch(/4 of 4/);
    });

    test('a hot-key rebase authority still never warns', () => {
        const issuer = gov({ mint: 'multisig', freeze: 'multisig', delegate: 'multisig', rebase: 'hot-key' });
        expect(statusOf('keyControl', { issuer, token: makeToken({ control: { rebase: true } }) })).not.toBe('warning');
    });
});

// --- 8. paused --------------------------------------------------------------------------------

describe('paused', () => {
    test('an on-chain pause is a warning', () => {
        expect(statusOf('paused', { token: makeToken({ control: { paused: true } }) })).toBe('warning');
    });

    test('an explicit not-paused is good', () => {
        expect(statusOf('paused', { token: makeToken({ control: { paused: false } }) })).toBe('good');
    });

    test('neither source reporting → unknown, not good', () => {
        const rule = ruleOf(evaluateHealth({ token: makeToken({ control: { paused: null } }) }), 'paused');
        expect(rule.status).toBe('unknown');
        expect(rule.note).toMatch(/neither the mint nor an issuer API/);
    });

    test("the issuer API's isTradingPaused counts as paused on its own", () => {
        const token = makeToken({ control: { paused: null }, issuerApi: { isTradingPaused: true } });
        const rule = ruleOf(evaluateHealth({ token }), 'paused');
        expect(rule.status).toBe('warning');
        expect(rule.note).toMatch(/at the issuer/);
    });

    test('an issuer API pause outranks an on-chain not-paused', () => {
        const token = makeToken({ control: { paused: false }, issuerApi: { isTradingPaused: true } });
        expect(statusOf('paused', { token })).toBe('warning');
    });

    test('isTradingPaused false is enough to grade good even with no on-chain flag', () => {
        const token = makeToken({ control: { paused: null }, issuerApi: { isTradingPaused: false } });
        expect(statusOf('paused', { token })).toBe('good');
    });

    test('issuerApi is read off the token when it is not passed separately', () => {
        const token = makeToken({ issuerApi: { isTradingPaused: true } });
        expect(ruleOf(evaluateHealth({ token }), 'paused').inputs).toEqual({ controlPaused: null, issuerApiPaused: true });
    });

    test('an explicitly passed issuerApi is used', () => {
        const token = makeToken({ control: { paused: false } });
        expect(statusOf('paused', { token, issuerApi: { isTradingPaused: true } })).toBe('warning');
    });

    test('an issuer API without the field leaves it null rather than false', () => {
        const token = makeToken({ issuerApi: { symbol: 'TEST' } });
        const rule = ruleOf(evaluateHealth({ token }), 'paused');
        expect(rule.inputs.issuerApiPaused).toBeNull();
        expect(rule.status).toBe('unknown');
    });

    test('this rule never cautions', () => {
        for (const paused of [true, false, null]) {
            expect(statusOf('paused', { token: makeToken({ control: { paused } }) })).not.toBe('caution');
        }
    });

    test('value is null and both sources are reported in inputs', () => {
        const token = makeToken({ control: { paused: true }, issuerApi: { isTradingPaused: false } });
        const rule = ruleOf(evaluateHealth({ token }), 'paused');
        expect(rule.value).toBeNull();
        expect(rule.inputs).toEqual({ controlPaused: true, issuerApiPaused: false });
    });
});

// --- 9. frozen --------------------------------------------------------------------------------

describe('frozen', () => {
    test.each([
        [0, 'good'],
        [1, 'caution'],
        [9, 'caution']
    ])('%p frozen accounts in the top 20 → %s', (frozenAccountsTop20, expected) => {
        expect(statusOf('frozen', { holders: makeHolders({ frozenAccountsTop20 }) })).toBe(expected);
    });

    test('no snapshot → unknown, not a clean bill of health', () => {
        const rule = ruleOf(evaluateHealth({ holders: makeHolders({ frozenAccountsTop20: null }) }), 'frozen');
        expect(rule.status).toBe('unknown');
        expect(rule.value).toBeNull();
        expect(rule.note).toMatch(/no holder snapshot/);
        expect(statusOf('frozen', { token: makeToken() })).toBe('unknown');
    });

    test('this rule never warns', () => {
        for (const count of [0, 1, 20, null]) {
            expect(statusOf('frozen', { holders: makeHolders({ frozenAccountsTop20: count }) })).not.toBe('warning');
        }
    });

    test('inputs carry the frozen count and the snapshot size', () => {
        const holders = makeHolders({ frozenAccountsTop20: 9, top20: [holder({ owner: 'A', sharePct: 1 })] });
        expect(ruleOf(evaluateHealth({ holders }), 'frozen').inputs).toEqual({ frozenAccountsTop20: 9, top20Count: 1 });
    });
});

// --- 10. spread -------------------------------------------------------------------------------

describe('spread', () => {
    const at = (venueSpreadPct, venuesPriced = 9) => makeToken({
        activity: { venueSpreadPct, venuesPriced, venueSpreadLow: 'WEEX', venueSpreadHigh: 'Ondo Stocks' }
    });

    test.each([
        [0, 'good'],
        [1.99, 'good'],
        [2, 'good'],
        [2.01, 'caution'],
        [5, 'caution'],
        [5.01, 'warning'],
        [40, 'warning']
    ])('a %p %% venue spread → %s', (spread, expected) => {
        expect(statusOf('spread', { token: at(spread) })).toBe(expected);
    });

    test('a spread needs two priced venues to mean anything', () => {
        expect(statusOf('spread', { token: at(30, 2) })).toBe('warning');
        for (const venuesPriced of [0, 1]) {
            const rule = ruleOf(evaluateHealth({ token: at(30, venuesPriced) }), 'spread');
            expect(rule.status).toBe('unknown');
            expect(rule.value).toBeNull();
            expect(rule.note).toMatch(/no spread to measure/);
            // The raw figure is still reported for the card, it is just not graded.
            expect(rule.inputs.venueSpreadPct).toBeCloseTo(30, 10);
        }
    });

    test('no spread reported → unknown', () => {
        const rule = ruleOf(evaluateHealth({ token: makeToken() }), 'spread');
        expect(rule.status).toBe('unknown');
        expect(rule.value).toBeNull();
        expect(rule.note).toBe('no venue spread reported');
    });

    test('inputs carry the spread, both venue names and the priced-venue count', () => {
        expect(ruleOf(evaluateHealth({ token: at(0.52) }), 'spread').inputs).toEqual({
            venueSpreadPct: 0.52,
            venueSpreadLow: 'WEEX',
            venueSpreadHigh: 'Ondo Stocks',
            venuesPriced: 9
        });
    });
});

// --- Roll-up ----------------------------------------------------------------------------------

describe('roll-up', () => {
    test('the overall status is the worst judged rule', () => {
        const good = evaluateHealth({ token: makeToken({ reference: { premiumPct: 0.1 }, control: { paused: false } }) });
        expect(good.status).toBe('good');

        const caution = evaluateHealth({ token: makeToken({ reference: { premiumPct: 2 }, control: { paused: false } }) });
        expect(caution.status).toBe('caution');

        const warning = evaluateHealth({ token: makeToken({ reference: { premiumPct: 2 }, market: { liquidity: 5 }, control: { paused: false } }) });
        expect(warning.status).toBe('warning');
    });

    test('worstRuleId names the FIRST rule in display order carrying the overall status', () => {
        // tracking (index 0) and liquidity (index 1) both warn; tracking must win.
        const both = evaluateHealth({ token: makeToken({ reference: { premiumPct: 9 }, market: { liquidity: 5 } }) });
        expect(both.status).toBe('warning');
        expect(both.worstRuleId).toBe('tracking');

        // Only liquidity warns, so it is named even though tracking is a caution above it.
        const onlyLiquidity = evaluateHealth({ token: makeToken({ reference: { premiumPct: 2 }, market: { liquidity: 5 } }) });
        expect(onlyLiquidity.status).toBe('warning');
        expect(onlyLiquidity.worstRuleId).toBe('liquidity');
    });

    test('worstRuleId points at a rule that really carries that status', () => {
        const result = evaluateHealth({
            token: makeToken({ reference: { premiumPct: 2 }, control: { paused: false } }),
            holders: makeHolders({ frozenAccountsTop20: 3 })
        });
        expect(result.status).toBe('caution');
        expect(result.worstRuleId).toBe('tracking');
        expect(ruleOf(result, result.worstRuleId).status).toBe('caution');
    });

    test('one good rule among ten unknowns is good, not unknown', () => {
        const result = evaluateHealth({ token: makeToken({ control: { paused: false } }) });
        expect(result.status).toBe('good');
        expect(result.worstRuleId).toBe('paused');
        expect(result.rules.filter((rule) => rule.status === 'unknown')).toHaveLength(10);
    });

    test('every rule unknown → unknown with a null worstRuleId', () => {
        const result = evaluateHealth({ token: makeToken(), issuer: makeIssuer(), holders: makeHolders(), pools: [] });
        expect(result.rules.every((rule) => rule.status === 'unknown')).toBe(true);
        expect(result.status).toBe('unknown');
        expect(result.worstRuleId).toBeNull();
    });

    test('a token with every input null never yields a warning and every value stays null', () => {
        const result = evaluateHealth({ token: makeToken(), issuer: makeIssuer(), holders: makeHolders(), pools: [], issuerApi: null });
        expect(result.status).not.toBe('warning');
        expect(result.rules.some((rule) => rule.status === 'warning')).toBe(false);
        expect(result.rules.some((rule) => rule.status === 'caution')).toBe(false);
        for (const rule of result.rules) expect(rule.value).toBeNull();
    });

    test('a fully healthy token grades good on all eleven rules', () => {
        const result = evaluateHealth({
            token: makeToken({
                control: { paused: false },
                market: { liquidity: 250000, organicSharePct: 40, usdPrice: 100 },
                activity: { trades24: 500, tradesPerTrader: 2, dexPairs: 4, venueSpreadPct: 0.5, venuesPriced: 6, venueSpreadLow: 'A', venueSpreadHigh: 'B' },
                reference: { premiumPct: 0.2, source: 'pyth', price: 100, marketOpen: true }
            }),
            issuer: makeIssuer({
                grades: { verificationStrength: 5, verificationLabel: 'register' },
                custodyVerification: { type: 'transfer-agent-register', machineReadable: true },
                keyGovernance: { mint: 'multisig', freeze: 'program', delegate: 'program', rebase: 'program' }
            }),
            holders: makeHolders({
                top20: [holder({ owner: 'A', sharePct: 10, amountUi: 100 }), holder({ owner: 'B', sharePct: 5, amountUi: 50 })],
                top1SharePct: 10,
                distinctOwnersTop20: 2,
                frozenAccountsTop20: 0
            }),
            pools: [{ pair: 'P', dex: 'raydium', signaturesSeen: 100, failedTx: 4 }],
            composabilityTemplate: makeComposability('good')
        });
        expect(result.rules.map((rule) => rule.status)).toEqual(Array(11).fill('good'));
        expect(result.status).toBe('good');
        expect(result.worstRuleId).toBe('tracking');
    });
});

// --- Real data sanity -------------------------------------------------------------------------
// Cheap shape guard over the four real files: if a producer renames a field or changes a nesting,
// the distribution collapses to unknown and this suite says so.

describe('the real stocks data', () => {
    const root = path.join(__dirname, '..');
    const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

    const tokensDb = readJson('stocks-tokens.json');
    const issuersDb = readJson('stocks-issuers.json');
    const holdersDb = readJson('stocks/data/holders.json');
    const tradesDb = readJson('stocks/fixtures/stocks-trades.sample.json');
    const composabilityDb = readJson('stocks/data/composability-templates.json');

    const issuerBySlug = new Map(issuersDb.issuers.map((issuer) => [issuer.slug, issuer]));
    const holdersByMint = new Map(holdersDb.items.map((item) => [item.mint, item]));
    const composabilityIndex = indexComposabilityTemplates(composabilityDb.templates);
    const poolsByMint = new Map();
    for (const pool of Array.isArray(tradesDb.pools) ? tradesDb.pools : []) {
        if (!poolsByMint.has(pool.mint)) poolsByMint.set(pool.mint, []);
        poolsByMint.get(pool.mint).push(pool);
    }

    const results = tokensDb.tokens.map((token) => evaluateHealth({
        token,
        issuer: issuerBySlug.get(token.issuer) ?? null,
        holders: holdersByMint.get(token.mint) ?? null,
        pools: poolsByMint.get(token.mint) ?? [],
        issuerApi: token.issuerApi ?? null,
        composabilityTemplate: composabilityTemplateFor(token, composabilityIndex)
    }));

    test('the fixtures really are the whole universe', () => {
        expect(tokensDb.tokens.length).toBeGreaterThan(400);
        expect(issuerBySlug.size).toBeGreaterThan(5);
        expect(holdersByMint.size).toBeGreaterThan(400);
    });

    test('every token gets a valid status and eleven rules in the fixed order', () => {
        for (const result of results) {
            expect(STATUSES).toContain(result.status);
            expect(result.rules).toHaveLength(11);
            expect(result.rules.map((rule) => rule.id)).toEqual(RULE_IDS);
            for (const rule of result.rules) {
                expect(STATUSES).toContain(rule.status);
                expect(rule.value === null || Number.isFinite(rule.value)).toBe(true);
                expect(typeof rule.note).toBe('string');
                expect(rule.note.length).toBeGreaterThan(0);
            }
        }
    });

    test('worstRuleId is null exactly when the status is unknown, and otherwise names a rule with that status', () => {
        for (const result of results) {
            if (result.status === 'unknown') {
                expect(result.worstRuleId).toBeNull();
                continue;
            }
            expect(RULE_IDS).toContain(result.worstRuleId);
            expect(ruleOf(result, result.worstRuleId).status).toBe(result.status);
        }
    });

    test('the real data exercises both overall risk bands and every per-rule status', () => {
        const statuses = new Set(results.map((result) => result.status));
        expect(statuses).toEqual(new Set(['caution', 'warning']));
        const ruleStatuses = new Set(results.flatMap((result) => result.rules.map((rule) => rule.status)));
        expect(ruleStatuses).toEqual(new Set(STATUSES));
    });

    test('no rule is dead — every one of the eleven is judged on at least one real token', () => {
        for (const id of RULE_IDS) {
            const judged = results.filter((result) => ruleOf(result, id).status !== 'unknown');
            expect(judged.length).toBeGreaterThan(0);
        }
    });
});
