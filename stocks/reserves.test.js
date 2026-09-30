// Fast tests for the reserves-vs-supply rules (stocks/lib/reserves.mjs): parsing the xStocks
// proof-of-reserves feed and Superstate's instrument registry from saved real payloads
// (stocks/fixtures/reserves/), the Solana outstanding arithmetic with the scaled-UI multiplier, the
// coverage/status rules, null-never-zero, the unchanged-reading dedupe and the SQL it writes.
const {
    PROGRAMMES, assessReading, buildWriteSql, chainOutstanding, decimalOrNull, formatSummary, mintSupply, parseLatest,
    parseSuperstateInstruments, parseXstocksPor, planWrites, readingHash, transitions, xstocksHasNextPage
} = require('./lib/reserves.mjs');
const por = require('./fixtures/reserves/xstocks-por.sample.json');
const superstate = require('./fixtures/reserves/superstate-instruments.sample.json');
const mints = require('./fixtures/reserves/mint-accounts.sample.json');

const NOW = '2026-09-30T12:33:30Z';
const AZNX = 'Xs3ZFkPYT2BN7qBMqf1j1bfTeTm1rFzEFSsQ1z3wAKU';
const FWDI = '7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9';

describe('parseXstocksPor (real payload)', () => {
    const map = parseXstocksPor(por);
    test('keys by symbol, keeps figures as strings and the source\'s own timestamp', () => {
        expect(map.get('SPCXx')).toEqual({
            symbol: 'SPCXx', sourceTime: '2026-09-29T18:12:06.441Z', reserve: '305231', issuerCirculating: '304943.58067451050468',
            holdings: [{ provider: 'Alpaca', quantity: '305231', symbol: 'SPCX' }]
        });
        expect(map.get('XIAOx').holdings[0].provider).toBe('Gtn');
        expect(map.size).toBe(por.nodes.length);
    });
    test('a zero reserve stays the string "0" (a real figure), a missing one is null', () => {
        expect(map.get('LULUx').reserve).toBe('0');
        const broken = parseXstocksPor({ nodes: [{ symbol: 'Xx', timestamp: 'nonsense', sharesHeld: null, circulatingSupply: 'abc' }] }).get('Xx');
        expect(broken).toMatchObject({ reserve: null, issuerCirculating: null, sourceTime: null });
    });
    test('a symbol listed twice keeps the newest reading, whichever page comes first', () => {
        const older = { nodes: [{ symbol: 'Ax', timestamp: '2026-09-01T00:00:00Z', sharesHeld: '1', circulatingSupply: '1' }] };
        const newer = { nodes: [{ symbol: 'Ax', timestamp: '2026-09-02T00:00:00Z', sharesHeld: '2', circulatingSupply: '2' }] };
        expect(parseXstocksPor([older, newer]).get('Ax').reserve).toBe('2');
        expect(parseXstocksPor([newer, older]).get('Ax').reserve).toBe('2');
    });
    test('a payload of another shape throws', () => {
        expect(() => parseXstocksPor({ items: [] })).toThrow(/nodes/);
    });
    test('pagination trusts hasNextPage, not the over-counted totalNodes', () => {
        expect(xstocksHasNextPage(por)).toBe(false);
        expect(xstocksHasNextPage({ nodes: [{}], page: { hasNextPage: true } })).toBe(true);
        expect(xstocksHasNextPage({ nodes: [], page: { hasNextPage: true } })).toBe(false);
    });
});

describe('parseSuperstateInstruments (real payload)', () => {
    const map = parseSuperstateInstruments(superstate.payload);
    test('keeps Solana equities keyed by mint, skips funds and equities without a Solana mint', () => {
        expect(map.get(FWDI)).toMatchObject({ symbol: 'FWDI', reserve: '7280819.200000', sourceTime: null, issuerCirculating: null,
            burnAddress: '2u8YwJTykTreziHBN5QwE7Bi2SyN8M2MicCscthtph9E' });
        expect([...map.values()].map((r) => r.symbol).sort()).toEqual(['EXOD', 'FWDI', 'GLXY', 'HSDT']);
    });
    test('an array is not the registry', () => {
        expect(() => parseSuperstateInstruments([])).toThrow();
    });
});

describe('Solana supply', () => {
    test('mintSupply reads the scaled-UI multiplier in force (AZNx ≈ 0.511, real account)', () => {
        const facts = mintSupply(mints.accounts[AZNX], Date.parse(NOW) / 1000);
        expect(facts).toEqual({ supplyRaw: '16652538920887', decimals: 8, uiMultiplier: '0.5111362527152737' });
    });
    test('a scheduled multiplier counts only once its time has passed', () => {
        const account = { data: { parsed: { type: 'mint', info: { supply: '100', decimals: 0, extensions: [{ extension: 'scaledUiAmountConfig',
            state: { multiplier: '1', newMultiplier: '2', newMultiplierEffectiveTimestamp: 1000 } }] } } } };
        expect(mintSupply(account, 999).uiMultiplier).toBe('1');
        expect(mintSupply(account, 1000).uiMultiplier).toBe('2');
    });
    test('an unreadable account gives nulls, never zeros', () => {
        expect(mintSupply(null, 0)).toEqual({ supplyRaw: null, decimals: null, uiMultiplier: null });
        expect(chainOutstanding({ supplyRaw: null, decimals: 8, uiMultiplier: '1' })).toBeNull();
    });
    test('outstanding = (supply − issuer-held) / 10^decimals × multiplier', () => {
        expect(chainOutstanding({ supplyRaw: '1000000000', decimals: 8, uiMultiplier: '0.5', excludedRaw: '400000000' })).toBeCloseTo(3);
        const f = mintSupply(mints.accounts[FWDI], 0);
        expect(chainOutstanding(f)).toBeCloseTo(7280819.1, 6);
    });
    test('an exclusion above supply (reads straddled a mint) is null, not negative', () => {
        expect(chainOutstanding({ supplyRaw: '10', decimals: 0, uiMultiplier: '1', excludedRaw: '11' })).toBeNull();
    });
});

describe('assessReading', () => {
    const fresh = '2026-09-30T12:00:00Z';
    test('covered: reserve at or above both figures', () => {
        const a = assessReading({ reserve: '305231', issuerCirculating: '304943.58', outstanding: 200000, sourceTime: fresh, now: NOW, staleAfterHours: 72 });
        expect(a.status).toBe('covered');
        expect(a.coverageIssuer).toBeCloseTo(305231 / 304943.58, 9);
        expect(a.coverageChain).toBeCloseTo(305231 / 200000, 9);
        expect(a.shortfallBasis).toBeNull();
    });
    test('the SpaceX class: reserve below the issuer\'s own circulating figure is an issuer-basis shortfall', () => {
        const a = assessReading({ reserve: '250000', issuerCirculating: '304943', outstanding: 100000, sourceTime: fresh, now: NOW, staleAfterHours: 72 });
        expect(a).toMatchObject({ status: 'shortfall', shortfallBasis: 'issuer' });
    });
    test('Solana alone above the reserve is a chain-basis shortfall even when the issuer\'s figures balance', () => {
        const a = assessReading({ reserve: '24124', issuerCirculating: '23847.03', outstanding: 69069.47, sourceTime: fresh, now: NOW, staleAfterHours: 72 });
        expect(a).toMatchObject({ status: 'shortfall', shortfallBasis: 'chain' });
        expect(a.reasons.join(' ')).toMatch(/exceeds the issuer's all-chain circulating/);
    });
    test('within the 0.1 % tolerance is not a shortfall', () => {
        expect(assessReading({ reserve: '999.5', issuerCirculating: '1000', sourceTime: fresh, now: NOW, staleAfterHours: 72 }).status).toBe('covered');
        expect(assessReading({ reserve: '998', issuerCirculating: '1000', sourceTime: fresh, now: NOW, staleAfterHours: 72 }).status).toBe('shortfall');
    });
    test('stale: the source\'s own time is older than the window (MDTx, real row)', () => {
        const r = parseXstocksPor(por).get('MDTx');
        const a = assessReading({ ...r, outstanding: 1819.38, now: NOW, staleAfterHours: 72 });
        expect(a).toMatchObject({ status: 'stale', stale: true });
    });
    test('a shortfall outranks staleness, and says both', () => {
        const a = assessReading({ reserve: '1', issuerCirculating: '10', sourceTime: '2026-09-01T00:00:00Z', now: NOW, staleAfterHours: 72 });
        expect(a).toMatchObject({ status: 'shortfall', stale: true });
    });
    test('a missing reserve is unreadable — never a reserve of zero, never a shortfall', () => {
        const a = assessReading({ reserve: null, issuerCirculating: '100', outstanding: 100, sourceTime: fresh, now: NOW, staleAfterHours: 72 });
        expect(a).toMatchObject({ status: 'unreadable', coverageIssuer: null, coverageChain: null, shortfallBasis: null });
    });
    test('a missing timestamp where freshness is required is unreadable, not invented', () => {
        expect(assessReading({ reserve: '10', issuerCirculating: '10', sourceTime: null, now: NOW, staleAfterHours: 72 }).status).toBe('unreadable');
    });
    test('a source without timestamps (Superstate) is judged on figures alone', () => {
        const a = assessReading({ reserve: '7280819.2', outstanding: 7280819.1, sourceTime: null, now: NOW, staleAfterHours: null });
        expect(a).toMatchObject({ status: 'covered', stale: null });
    });
    test('missing supply and issuer figure: nothing to compare → unreadable', () => {
        expect(assessReading({ reserve: '5', now: NOW }).status).toBe('unreadable');
    });
    test('0 held, 0 circulating, 0 on Solana → nothing-outstanding with null ratios', () => {
        const a = assessReading({ reserve: '0', issuerCirculating: '0', outstanding: 0, sourceTime: fresh, now: NOW, staleAfterHours: 72 });
        expect(a).toMatchObject({ status: 'nothing-outstanding', coverageIssuer: null, coverageChain: null });
    });
    test('0 held while Solana shows tokens outstanding is a shortfall (LULUx, real row)', () => {
        const r = parseXstocksPor(por).get('LULUx');
        expect(assessReading({ ...r, outstanding: 44316.42, now: NOW, staleAfterHours: 72 })).toMatchObject({ status: 'shortfall', shortfallBasis: 'chain', coverageChain: 0 });
    });
});

describe('storage', () => {
    const row = (over = {}) => ({ mint: 'M1', symbol: 'Ax', issuer: 'xstocks-backed', source: 'xstocks-por-api', status: 'covered', reserve: '10',
        issuerCirculating: '9', supplyRaw: '900', excludedRaw: '0', uiMultiplier: '1', stale: false, sourceTime: '2026-09-30T00:00:00.000Z', ...over });
    test('the reading hash ignores times but not figures', () => {
        expect(readingHash(row())).toBe(readingHash(row({ sourceTime: '2026-10-01T00:00:00.000Z' })));
        expect(readingHash(row())).not.toBe(readingHash(row({ supplyRaw: '901' })));
        expect(readingHash(row())).not.toBe(readingHash(row({ reserve: null })));
    });
    test('an unchanged reading is a touch, a changed one an insert that remembers the previous status', () => {
        const same = { ...row(), readingHash: readingHash(row()) };
        const moved = { ...row({ mint: 'M2', status: 'shortfall', reserve: '1' }) };
        moved.readingHash = readingHash(moved);
        const latest = parseLatest(`7,M1,xstocks-por-api,covered,${same.readingHash}\n8,M2,xstocks-por-api,covered,abc\n`);
        const plan = planWrites([same, moved], latest);
        expect(plan.touches.map((t) => [t.mint, t.id])).toEqual([['M1', 7]]);
        expect(plan.inserts.map((t) => [t.mint, t.previousStatus])).toEqual([['M2', 'covered']]);
        expect(transitions(plan.inserts).map((t) => t.kind)).toEqual(['reserve-shortfall']);
    });
    test('first sight is an insert; recovery raises reserve-restored', () => {
        const r = { ...row(), readingHash: 'h' };
        expect(planWrites([r], new Map()).inserts).toHaveLength(1);
        expect(transitions([{ ...r, previousStatus: 'shortfall' }]).map((t) => t.kind)).toEqual(['reserve-restored']);
        // A credentials-only feed (Tessera) is unreadable by construction: no event on first sight.
        expect(transitions([{ ...r, status: 'unreadable', previousStatus: null, detail: { restricted: true } }])).toEqual([]);
        expect(transitions([{ ...r, status: 'unreadable', previousStatus: 'covered', detail: {} }]).map((t) => t.kind)).toEqual(['reserve-unreadable']);
    });
    test('SQL writes NULL for missing figures, quotes text and moves last_seen on touches', () => {
        const sql = buildWriteSql({ inserts: [{ ...row({ symbol: "O'x", reserve: null, coverageIssuer: NaN }), readingHash: 'h', reasons: [] }],
            touches: [{ id: 42, sourceTime: '2026-09-30T00:00:00Z' }] }, { seenAt: NOW });
        expect(sql).toMatch(/'O''x'/);
        expect(sql).not.toMatch(/NaN/);
        expect(sql).toMatch(/UPDATE sonar\.reserve_observation SET last_seen_at = '2026-09-30T12:33:30Z'.*WHERE id = 42;/);
    });
});

describe('programmes and summary', () => {
    test('every catalogued issuer key has a researched entry with an access level', () => {
        for (const p of Object.values(PROGRAMMES)) expect(['keyless', 'credentials-required', 'none']).toContain(p.access);
        for (const [, p] of Object.entries(PROGRAMMES).filter(([, x]) => x.access === 'keyless')) expect(p.url).toMatch(/^https:\/\//);
    });
    test('no message without a shortfall, a stale proof or a failure; one that separates the issuer and chain bases', () => {
        expect(formatSummary({ rows: [{ status: 'covered' }], failures: [], restricted: 3, transitionsList: [], durationMs: 1000 })).toBeNull();
        const text = formatSummary({ rows: [
            { status: 'shortfall', shortfallBasis: 'issuer', symbol: 'SPCXx', mint: 'a', coverageIssuer: 0.64 },
            { status: 'shortfall', shortfallBasis: 'chain', symbol: 'RKLBx', mint: 'b', coverageChain: 0.35 }
        ], failures: [], restricted: 0, transitionsList: [{ kind: 'reserve-shortfall', row: { mint: 'a' } }], durationMs: 1000 });
        expect(text).toMatch(/OWN circulating figure: SPCXx NEW \(64\.00% of issuer circ\)/);
        expect(text).toMatch(/Solana outstanding .*RKLBx \(35\.00% of Solana\)/);
        expect(formatSummary({ rows: [], failures: ['x'], restricted: 0, transitionsList: [], durationMs: 1 })).toMatch(/1 failure/);
    });
    test('decimalOrNull never turns junk into 0', () => {
        expect(decimalOrNull('')).toBeNull();
        expect(decimalOrNull(undefined)).toBeNull();
        expect(decimalOrNull('1e5')).toBeNull();
        expect(decimalOrNull(' 12.5 ')).toBe('12.5');
    });
});
