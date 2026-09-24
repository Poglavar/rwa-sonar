import {
    COLLATERAL_DROP_PCT,
    COLLATERAL_VALUE_FLOOR_USD,
    diffDefiSnapshots,
    formatDefiNoticeLines,
    snapshotDefiUsage
} from './lib/defi-changes.mjs';

function row(overrides = {}) {
    return {
        mint: 'MINT_A', symbol: 'AAPLx', issuer: 'xstocks-backed', protocolId: 'kamino',
        protocolName: 'Kamino', integrationId: 'kamino:collateral', category: 'lending',
        status: 'live', maxLtvMin: 0.5, maxLtvMax: 0.5, liquidationLtvMin: 0.65,
        liquidationLtvMax: 0.65, collateralValueUsd: 1_000_000, ...overrides
    };
}

function snap(date, items) {
    return { date, fetchedAt: `${date}T00:20:00Z`, items };
}

describe('daily DeFi snapshots', () => {
    test('flattens only confirmed exact-token integrations and keeps lending risk fields', () => {
        const rows = snapshotDefiUsage({ items: [
            { mint: 'EMPTY', symbol: 'NONE', integrations: [] },
            { mint: 'MINT_A', symbol: 'AAPLx', issuer: 'xstocks-backed', integrations: [{
                id: 'kamino:collateral', protocolId: 'kamino', protocolName: 'Kamino',
                category: 'lending', status: 'live',
                metrics: {
                    sizeUsd: 123456.78901234, maxLtvMin: 0.5, maxLtvMax: 0.55,
                    liquidationPenaltyMin: 0.03, liquidationPenaltyMax: 0.05,
                    depositLimitUsd: 2_000_000, borrowLimitUsd: 1_000_000,
                    utilizationPct: 41.2, maxOracleStalenessSeconds: 120,
                    oracleProviders: ['pyth-lazer']
                },
                corroboration: { status: 'confirmed', verifiedCount: 2, accountCount: 2 }
            }] }
        ] });
        expect(rows).toEqual([expect.objectContaining({
            mint: 'MINT_A', protocolId: 'kamino', collateralValueUsd: 123456.79,
            maxLtvMin: 0.5, maxLtvMax: 0.55,
            liquidationPenaltyMin: 0.03, depositLimitUsd: 2_000_000,
            oracleProviders: ['pyth-lazer'], corroborationStatus: 'confirmed', corroboratedAccounts: 2
        })]);
    });

    test('loans read on-chain for the first time are a baseline; later ones are observed loans, never listings', () => {
        const listed = { mint: 'MINT_T', symbol: 'TSLAx', protocolId: 'loopscale', protocolName: 'Loopscale', category: 'lending', status: 'live', basis: 'exact-token-registry' };
        const loan = (mint, symbol) => ({ mint, symbol, protocolId: 'loopscale', protocolName: 'Loopscale', category: 'lending', status: 'live', basis: 'onchain-position' });
        // Day 1 of the loan scan: AAPLx and MSTRx loans existed before we could see them.
        const first = diffDefiSnapshots(snap('2026-09-24', [listed]), snap('2026-09-25', [listed, loan('MINT_A', 'AAPLx'), loan('MINT_M', 'MSTRx')]));
        expect(first.events).toEqual([]);
        expect(first.baselined).toBe(2);
        // Day 2: a new loan against QQQx is a real observation, worded as one.
        const second = diffDefiSnapshots(snap('2026-09-25', [listed, loan('MINT_A', 'AAPLx')]), snap('2026-09-26', [listed, loan('MINT_A', 'AAPLx'), loan('MINT_Q', 'QQQx')]));
        expect(second.events).toHaveLength(1);
        expect(second.events[0]).toMatchObject({ kind: 'token-added', symbol: 'QQQx', basis: 'onchain-position' });
        expect(second.events[0].summary).toBe('A Loopscale loan against QQQx was first observed on-chain; no published listing names it.');
        // The snapshot keeps the basis the diff relies on.
        const [row] = snapshotDefiUsage({ items: [{ mint: 'MINT_A', symbol: 'AAPLx', integrations: [{ id: 'loopscale:collateral', protocolId: 'loopscale', category: 'lending', status: 'live', proof: { sourceStatus: 'onchain-position' } }] }] });
        expect(row.basis).toBe('onchain-position');
    });

    test('the first observation is a baseline, never hundreds of additions', () => {
        expect(diffDefiSnapshots(null, snap('2026-09-19', [row()])).events).toEqual([]);
    });
});

describe('protocol change detection', () => {
    test('uses exact mint plus protocol identity for additions and removals', () => {
        const diff = diffDefiSnapshots(
            snap('2026-09-18', [row(), row({ mint: 'MINT_GONE', symbol: 'OLD' })]),
            snap('2026-09-19', [row(), row({ mint: 'MINT_NEW', symbol: 'NEW' })])
        );
        expect(diff.events.map((event) => [event.kind, event.symbol])).toEqual([
            ['token-added', 'NEW'], ['token-removed', 'OLD']
        ]);
        expect(diff.events[0].mint).toBe('MINT_NEW');
        expect(diff.events[0].summary).toContain("NEW now appears in Kamino's checked registry");
    });

    test('reports any configured maximum LTV move but ignores missing measurements', () => {
        const changed = diffDefiSnapshots(snap('2026-09-18', [row()]), snap('2026-09-19', [row({ maxLtvMax: 0.55 })]));
        expect(changed.events).toEqual([expect.objectContaining({
            kind: 'ltv-changed', before: { min: 0.5, max: 0.5 }, after: { min: 0.5, max: 0.55 }
        })]);
        const missing = diffDefiSnapshots(snap('2026-09-18', [row({ maxLtvMin: null, maxLtvMax: null })]), snap('2026-09-19', [row()]));
        expect(missing.events).toEqual([]);
        const partial = diffDefiSnapshots(snap('2026-09-18', [row({ maxLtvMin: null })]), snap('2026-09-19', [row()]));
        expect(partial.events).toEqual([]);
    });

    test('reports live to non-live once, without calling already-available markets inactive', () => {
        const inactive = diffDefiSnapshots(snap('2026-09-18', [row()]), snap('2026-09-19', [row({ status: 'available' })]));
        expect(inactive.events.map((event) => event.kind)).toEqual(['market-inactive']);
        const unchanged = diffDefiSnapshots(snap('2026-09-18', [row({ status: 'available' })]), snap('2026-09-19', [row({ status: 'available' })]));
        expect(unchanged.events).toEqual([]);
    });

    test('a collateral-value fall must clear both the percentage and prior-value floors', () => {
        const fires = diffDefiSnapshots(
            snap('2026-09-18', [row({ collateralValueUsd: COLLATERAL_VALUE_FLOOR_USD })]),
            snap('2026-09-19', [row({ collateralValueUsd: COLLATERAL_VALUE_FLOOR_USD * (1 - COLLATERAL_DROP_PCT / 100) })])
        );
        expect(fires.events).toEqual([expect.objectContaining({ kind: 'collateral-value-drop', dropPct: 25 })]);
        const tooSmall = diffDefiSnapshots(snap('2026-09-18', [row({ collateralValueUsd: 99_999 })]), snap('2026-09-19', [row({ collateralValueUsd: 0 })]));
        const tooShallow = diffDefiSnapshots(snap('2026-09-18', [row()]), snap('2026-09-19', [row({ collateralValueUsd: 750_001 })]));
        expect(tooSmall.events).toEqual([]);
        expect(tooShallow.events).toEqual([]);
    });

    test('morning text is bounded and says token, while evidence retains the mint address', () => {
        const diff = diffDefiSnapshots(snap('2026-09-18', []), snap('2026-09-19', [
            row({ mint: 'A', symbol: 'ONE' }), row({ mint: 'B', symbol: 'TWO' })
        ]));
        const lines = formatDefiNoticeLines(diff, 1);
        expect(lines).toHaveLength(4);
        expect(lines[0]).toContain('2 tokens added to protocols');
        expect(lines[1]).toContain("ONE now appears in Kamino's checked registry");
        expect(lines[1]).toContain('https://rwasonar.com/cards/ONE.html');
        expect(lines[2]).toContain('and 1 more');
        expect(lines[3]).toBe('Evidence: https://rwasonar.com/monitor.html#defiChangesSection');
        expect(diff.events[0].mint).toBe('A');
    });
});
