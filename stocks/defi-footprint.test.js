// Tests for the on-chain DeFi footprint (lib/defi-footprint.mjs), its address arithmetic
// (lib/solana-address.mjs), the Kamino decoders (lib/kamino-accounts.mjs), the composite vault
// model (lib/defi-usage.mjs) and the "New in DeFi" feed (lib/defi-changes.mjs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { addressBytes, base58Decode, base58Encode, findProgramAddress, isOnCurve } from './lib/solana-address.mjs';
import {
    classifyOwner, deriveAuthorities, diffFootprints, footprintCandidates, indexRegistry, listedIndex,
    mintFootprint, resolvePdaProgram, selectMintsToScan, snapshotFootprint, transferParents
} from './lib/defi-footprint.mjs';
import { decodeObligation, decodeReserve, priceDropToLiquidation } from './lib/kamino-accounts.mjs';
import { buildDefiUsage, curatedUsage, integrationAccountRefs, kaminoUsage, loopscaleVaultMarkets } from './lib/defi-usage.mjs';
import { buildDefiNewFeed, diffDefiSnapshots, mergeFootprintDiff, snapshotDefiUsage } from './lib/defi-changes.mjs';
import { buildReviewQueue } from './lib/review-queue.mjs';

const HERE = import.meta.dirname;
const KLEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const XSTOCKS_MARKET = '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
const XSTOCKS_LMA = '2Z7zhqp1eddmHNmEqexftST6DFPWmoL4QqfgiG5uJMJx';
const WALLET = '45oF6Ea7tTSArCxGH7hksFnAPsE9vgnaN3ek9jwKd9MU';
const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const UNKNOWN_PROGRAM = 'BSE8uppfb56cX75LmPZyJLySy7c3JLornP92tF6dmmXt';
const SQUADS = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

const registry = {
    authorityDerivations: [{ programId: KLEND, protocolId: 'kamino', seeds: ['lma', '$market'], marketsFrom: 'kamino-markets' }],
    programs: [
        { programId: KLEND, protocolId: 'kamino', protocolName: 'Kamino Lend', category: 'lending', usageProtocolIds: ['kamino'] },
        { programId: RAYDIUM_CLMM, protocolId: 'raydium', protocolName: 'Raydium CLMM', category: 'dex', usageProtocolIds: ['raydium'] },
        { programId: SQUADS, protocolId: 'squads', protocolName: 'Squads', category: 'custody', usageProtocolIds: [] }
    ],
    knownAddresses: []
};
const index = indexRegistry(registry);
const authorities = deriveAuthorities(registry.authorityDerivations, { 'kamino-markets': [{ address: XSTOCKS_MARKET, name: 'xStocks Market' }] });
const token = { mint: 'MINT_NVDA', symbol: 'NVDAx', issuer: 'xstocks-backed', market: { usdPrice: 200 } };

// A second PDA we can build deterministically: the ATA of WALLET for some mint is off-curve.
const OTHER_PDA = findProgramAddress([addressBytes(WALLET), Buffer.from('x')], KLEND).address;

describe('solana address arithmetic', () => {
    test('base58 round-trips and derives a known associated token account', () => {
        expect(base58Encode(base58Decode(WALLET))).toBe(WALLET);
        const ata = findProgramAddress([
            addressBytes(WALLET),
            addressBytes('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
            addressBytes('123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo')
        ], 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
        // Observed on-chain as AAPLon's largest token account, owned by WALLET.
        expect(ata.address).toBe('9v4M7TUPMFhcLCH2iRTNXcJKYBpvaH6H3chLkC4APLuo');
    });

    test('wallet keys are on the curve, PDAs are not', () => {
        expect(isOnCurve(WALLET)).toBe(true);
        expect(isOnCurve(XSTOCKS_LMA)).toBe(false);
        expect(isOnCurve(OTHER_PDA)).toBe(false);
    });

    test('Kamino lending-market authority derives from the market address', () => {
        expect(authorities.get(XSTOCKS_LMA)).toMatchObject({ programId: KLEND, market: { address: XSTOCKS_MARKET, name: 'xStocks Market' } });
    });
});

describe('owner classification', () => {
    test('a system-owned on-curve owner is a wallet, never an integration', () => {
        expect(classifyOwner({ owner: WALLET, ownerAccount: { owner: '11111111111111111111111111111111' }, index, authorities }).kind).toBe('wallet');
        expect(classifyOwner({ owner: WALLET, ownerAccount: null, index, authorities }).kind).toBe('wallet');
    });

    test('a program-owned data account is attributed to its program', () => {
        expect(classifyOwner({ owner: 'Pool', ownerAccount: { owner: RAYDIUM_CLMM }, index, authorities }))
            .toMatchObject({ kind: 'program', programId: RAYDIUM_CLMM, via: 'owner-account-program' });
    });

    test('a derived authority PDA is attributed to its market; an unknown PDA stays unresolved until resolved', () => {
        expect(classifyOwner({ owner: XSTOCKS_LMA, ownerAccount: null, index, authorities }))
            .toMatchObject({ programId: KLEND, via: 'derived-authority', market: { address: XSTOCKS_MARKET } });
        expect(classifyOwner({ owner: OTHER_PDA, ownerAccount: null, index, authorities }).kind).toBe('unresolved-pda');
        expect(classifyOwner({ owner: OTHER_PDA, ownerAccount: null, index, authorities, pdaResolutions: { [OTHER_PDA]: { programId: UNKNOWN_PROGRAM } } }))
            .toMatchObject({ kind: 'program', programId: UNKNOWN_PROGRAM, via: 'transaction-resolved' });
    });
});

function footprint(accounts, owners, { listed = new Map(), read = { status: 'ok', observedAt: '2026-09-24T00:00:00Z' } } = {}) {
    return mintFootprint({ token, read, accounts, ownerAccounts: new Map(owners), index, authorities, pdaResolutions: {}, listed });
}

describe('footprint candidates', () => {
    const accounts = [
        { tokenAccount: 'ta1', owner: WALLET, amountUi: 500, sharePct: 50 },
        { tokenAccount: 'ta2', owner: 'UnknownState', amountUi: 100, sharePct: 10 },
        { tokenAccount: 'ta3', owner: XSTOCKS_LMA, amountUi: 80, sharePct: 8 },
        { tokenAccount: 'ta4', owner: 'Treasury', amountUi: 60, sharePct: 6 },
        { tokenAccount: 'ta5', owner: 'DustPool', amountUi: 0.001, sharePct: 0.0001 }
    ];
    const owners = [
        [WALLET, { owner: '11111111111111111111111111111111' }],
        ['UnknownState', { owner: UNKNOWN_PROGRAM }],
        ['Treasury', { owner: SQUADS }],
        ['DustPool', { owner: RAYDIUM_CLMM }]
    ];

    test('an unknown program above the threshold becomes a candidate; wallets and custody never do', () => {
        const item = footprint(accounts, owners);
        expect(item.wallets).toMatchObject({ accounts: 1, sharePct: 50 });
        const candidates = footprintCandidates([item]);
        expect(candidates.map((row) => row.reason).sort()).toEqual(['unknown-program', 'unlisted-integration']);
        const unknown = candidates.find((row) => row.reason === 'unknown-program');
        expect(unknown).toMatchObject({ programId: UNKNOWN_PROGRAM, usd: 20000, sharePct: 10 });
        expect(candidates.some((row) => row.protocolId === 'squads')).toBe(false);
        expect(candidates.some((row) => row.protocolId === 'raydium')).toBe(false); // dust stays quiet
    });

    test('a known protocol holding a token is not a candidate once the registry lists that exact market', () => {
        const listed = listedIndex({ items: [{ mint: 'MINT_NVDA', integrations: [{ protocolId: 'kamino', markets: [{ marketAddress: XSTOCKS_MARKET }] }] }] });
        const item = footprint(accounts, owners, { listed });
        expect(item.programs.find((row) => row.programId === KLEND)).toMatchObject({ defi: true, listedInUsage: true });
        expect(footprintCandidates([item]).map((row) => row.reason)).toEqual(['unknown-program']);
    });

    test('a failed read produces no candidates at all', () => {
        const item = footprint(accounts, owners, { read: { status: 'partial' } });
        expect(footprintCandidates([item])).toEqual([]);
    });
});

function snap(date, item) {
    return { date, ...snapshotFootprint({ items: [item] }) };
}

describe('footprint diff', () => {
    const base = [{ tokenAccount: 'ta1', owner: WALLET, amountUi: 500, sharePct: 50 }];
    const owners = [[WALLET, { owner: '11111111111111111111111111111111' }], ['UnknownState', { owner: UNKNOWN_PROGRAM }]];
    const withKamino = [...base, { tokenAccount: 'ta3', owner: XSTOCKS_LMA, amountUi: 80, sharePct: 8 }];
    const withUnknown = [...base, { tokenAccount: 'ta2', owner: 'UnknownState', amountUi: 100, sharePct: 10 }];

    test('a known protocol newly holding a token is an addition; an unknown program is a candidate', () => {
        const diff = diffFootprints(snap('2026-09-23', footprint(base, owners)), snap('2026-09-24', footprint([...withKamino, withUnknown[1]], owners)));
        expect(diff.events.map((event) => event.kind)).toEqual(['defi-integration-added', 'defi-integration-candidate']);
        expect(diff.events[0]).toMatchObject({ protocolId: 'kamino', market: { address: XSTOCKS_MARKET }, detectedBy: 'chain' });
        expect(diff.counts['defi-integration-candidate']).toBe(1);
    });

    test('a failed read is never a removal', () => {
        const previous = snap('2026-09-23', footprint(withKamino, owners));
        const failed = snap('2026-09-24', footprint([], owners, { read: { status: 'not-scanned' } }));
        const diff = diffFootprints(previous, failed);
        expect(diff.events).toEqual([]);
        expect(diff.unreadMints).toBe(1);
        const partial = snap('2026-09-24', footprint(base, owners, { read: { status: 'partial' } }));
        expect(diffFootprints(previous, partial).events).toEqual([]);
    });

    test('a removal needs the old holding to be above today\'s visibility floor', () => {
        const previous = snap('2026-09-23', footprint(withKamino, owners));
        // Complete view (fewer than 20 accounts): the Kamino holding is really gone.
        expect(diffFootprints(previous, snap('2026-09-24', footprint(base, owners))).events.map((e) => e.kind)).toEqual(['defi-integration-removed']);
        // Twenty accounts all larger than the old holding: it may simply have dropped out of view.
        const crowded = Array.from({ length: 20 }, (_, i) => ({ tokenAccount: `w${i}`, owner: WALLET, amountUi: 1000 + i, sharePct: 1 }));
        expect(diffFootprints(previous, snap('2026-09-24', footprint(crowded, owners))).events).toEqual([]);
    });

    test('the first observation is a baseline', () => {
        expect(diffFootprints(null, snap('2026-09-24', footprint(withKamino, owners))).events).toEqual([]);
    });
});

describe('PDA resolution from transactions', () => {
    const tx = (source, destination, parent) => ({
        transaction: { message: { instructions: [{ programId: 'ComputeBudget111111111111111111111111111111' }, { programId: parent }] } },
        meta: { innerInstructions: [{ index: 1, instructions: [
            { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', stackHeight: 2, parsed: { type: 'transferChecked', info: { source, destination } } }
        ] }] }
    });

    test('the program that signs an outgoing transfer owns the PDA', () => {
        const parents = [transferParents(tx('VAULT', 'user', KLEND), 'VAULT'), transferParents(tx('user', 'VAULT', 'Router'), 'VAULT')];
        expect(resolvePdaProgram(parents)).toEqual({ programId: KLEND, basis: 'outgoing-transfer-signer' });
    });

    test('inflow-only evidence is weaker and ambiguity stays unresolved', () => {
        expect(resolvePdaProgram([transferParents(tx('user', 'VAULT', KLEND), 'VAULT')])).toMatchObject({ programId: KLEND, basis: 'incoming-transfer-caller' });
        const ambiguous = resolvePdaProgram([transferParents(tx('VAULT', 'u', 'A'), 'VAULT'), transferParents(tx('VAULT', 'u', 'B'), 'VAULT')]);
        expect(ambiguous).toMatchObject({ programId: null, basis: 'ambiguous-outflow' });
    });
});

describe('scan rotation', () => {
    test('uncovered, never-scanned mints first, then the oldest scan; zero supply is skipped', () => {
        const tokens = [{ mint: 'A', supplyRaw: '5' }, { mint: 'B', supplyRaw: '5' }, { mint: 'C', supplyRaw: '0' }, { mint: 'D', supplyRaw: '5' }, { mint: 'E', supplyRaw: '5' }];
        const picked = selectMintsToScan(tokens, { coveredMints: new Set(['A']), scans: { B: { scannedAt: '2026-09-20T00:00:00Z' }, E: { scannedAt: '2026-09-18T00:00:00Z' } }, budget: 2 });
        expect(picked.map((t) => t.mint)).toEqual(['D', 'E']);
    });
});

const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'kamino-sentora-nvdax.sample.json'), 'utf8'));

describe('Kamino account decoders', () => {
    test('reserve configuration decodes to the Sentora xStocks Market NVDAx terms', () => {
        expect(decodeReserve(fixture.reserve.data)).toMatchObject({
            lendingMarket: '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr',
            liquidityMint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
            status: 'active', maxLtvPct: 62, liquidationLtvPct: 73
        });
    });

    test('the obligation is self-consistent: allowed and unhealthy borrow values equal LTV × deposits', () => {
        const obligation = decodeObligation(fixture.obligation.data);
        expect(obligation.owner).toBe('FTeDtYDsHotvxdLBqpAccPsYrtU5VDfjZjrZUENC1fpD');
        expect(obligation.deposits).toHaveLength(1);
        expect(obligation.borrows[0].reserve).toBe('6bR98MJTH68s7eV8ssyBgfuuH5oR2bEt58P9rZPLpBrC');
        expect(obligation.allowedBorrowValueUsd / obligation.depositedValueUsd).toBeCloseTo(0.62, 6);
        expect(obligation.liquidationLoanToValue).toBeCloseTo(0.73, 6);
        expect(obligation.loanToValue).toBeGreaterThan(0.3);
        expect(obligation.loanToValue).toBeLessThan(0.73);
        expect(priceDropToLiquidation(obligation)).toBeCloseTo(1 - obligation.loanToValue / 0.73, 9);
    });

    test('wrong account types decode to null, never to plausible numbers', () => {
        expect(decodeReserve(fixture.obligation.data)).toBeNull();
        expect(decodeObligation(fixture.reserve.data)).toBeNull();
        expect(decodeObligation('AAAA')).toBeNull();
    });
});

describe('composite vault model (xStocks Vaults)', () => {
    const curated = JSON.parse(readFileSync(join(HERE, 'data', 'defi-integrations.json'), 'utf8'));
    const nvda = { mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', symbol: 'NVDAx', issuer: 'xstocks-backed', decimals: 8 };

    test('the route is modelled per asset: vault → strategy → Kamino collateral → borrow → Earn vault', () => {
        const [row] = curatedUsage(nvda, curated);
        expect(row.composite).toBe(true);
        expect(row.route.map((leg) => leg.role)).toEqual(['deposit-interface', 'vault', 'bridge', 'vault-manager', 'strategy', 'collateral', 'borrow', 'yield', 'conversion']);
        expect(row.route.find((leg) => leg.role === 'vault')).toMatchObject({ chain: 'ink', address: '0xBeB4a79e150564857488E6142D26787A78d54a66' });
        const collateral = row.route.find((leg) => leg.role === 'collateral');
        expect(collateral).toMatchObject({ programId: KLEND, marketAddress: '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr', reserveAddress: '4WqQtjQbewk7ptnXsX3E3Tf3M4pa9YiBsgAqjsJDkspH', address: 'AcVJAGBqFnyjCf2qd6Nbdihjs7WtMjgx66AoTx4LafDC' });
        expect(row.route.find((leg) => leg.role === 'borrow').assetSymbol).toBe('PYUSD');
        expect(row.holderReceives).toMatchObject({ shareSymbol: 'sentoraNVDAx', shareChain: 'ink', shareAddress: '0xBeB4a79e150564857488E6142D26787A78d54a66', solanaShareMint: 'BYW6N3VjFXsHW9D4mTjR2HZ3sKtKCbxrrcMdzf7C7c5F' });
        expect(row.risks.map((risk) => risk.id)).toContain('leverage-liquidation');
        const roles = integrationAccountRefs(row).map((ref) => ref.role);
        expect(roles).toEqual(expect.arrayContaining(['lending-market', 'collateral-reserve', 'obligation', 'vault-state', 'vault-share-mint']));
    });

    test('a decoded live position makes the product configuration-decoded with the loop metrics', () => {
        const observations = new Map([[`veda-sentora-kraken-xstocks-vaults\u0000${nvda.mint}`, {
            shareSupplyRaw: '0',
            position: { loanToValue: 0.58, liquidationLtv: 0.73, priceDropToLiquidation: 0.2055 },
            metrics: { sizeUsd: 164315, debtAgainstCollateralUsd: 95303, maxLtvMin: 0.62, maxLtvMax: 0.62 },
            decoding: { observedAt: '2026-09-24T00:30:00Z', slot: 449867046, scope: 'obligation', decoder: 'kamino-accounts', idl: null }
        }]]);
        const usage = buildDefiUsage({ tokens: [nvda], curated, fetchedAt: '2026-09-24T00:30:00Z', compositeObservations: observations });
        const row = usage.items[0].integrations.find((entry) => entry.id === 'veda-sentora-kraken-xstocks-vaults');
        expect(row.proof).toMatchObject({ configurationDecoded: true, activityObserved: true });
        expect(row.position.priceDropToLiquidation).toBeCloseTo(0.2055);
        expect(row.holderReceives.shareSupplyOnSolanaRaw).toBe('0');
        expect(usage.counts.withYieldVault).toBe(1);
    });
});

describe('Kamino per-market reserves', () => {
    test('a curated market missing from the cross-market registry is still listed, with decoded terms', () => {
        const reserves = [
            { market: 'SentoraMarket', marketName: 'Sentora xStocks Market', curated: true, reserve: 'R1', mint: 'MINT_NVDA', maxLtv: 0.62, totalSupplyUsd: 206973 },
            { market: 'SentoraMarket', marketName: 'Sentora xStocks Market', reserve: 'R2', mint: 'PYUSD', maxLtv: 0, totalSupplyUsd: 7e6 }
        ];
        const configs = new Map([['R1', { liquidityMint: 'MINT_NVDA', status: 'active', maxLtvPct: 62, liquidationLtvPct: 73, minLiquidationBonusBps: 1000, maxLiquidationBonusBps: 1000 }]]);
        const [row] = kaminoUsage(token, [], { marketReserves: reserves, reserveConfigs: configs, decodedAt: '2026-09-24T00:30:00Z', slot: 1 });
        expect(row.markets).toEqual([expect.objectContaining({ name: 'Sentora xStocks Market', marketAddress: 'SentoraMarket', reserveAddress: 'R1', maxLtv: 0.62, liquidationLtv: 0.73, source: 'market-reserve-list' })]);
        expect(row.metrics).toMatchObject({ maxLtvMax: 0.62, liquidationLtvMax: 0.73, sizeUsd: 206973 });
        expect(row.decoding.reserves).toEqual(['R1']);
        expect(kaminoUsage({ ...token, mint: 'PYUSD' }, [], { marketReserves: reserves })).toEqual([]);
    });

    test('a decoded config for a different mint is ignored', () => {
        const reserves = [{ market: 'M', marketName: 'M', reserve: 'R1', mint: 'MINT_NVDA', maxLtv: 0.5, totalSupplyUsd: 1 }];
        const [row] = kaminoUsage(token, [], { marketReserves: reserves, reserveConfigs: new Map([['R1', { liquidityMint: 'OTHER', maxLtvPct: 90, liquidationLtvPct: 95 }]]) });
        expect(row.metrics.maxLtvMax).toBe(0.5);
        expect(row.decoding).toBeUndefined();
    });
});

describe('New in DeFi feed and review queue', () => {
    const registryDiff = { from: '2026-09-23', to: '2026-09-24', counts: {}, events: [
        { kind: 'token-added', severity: 'info', mint: 'M1', symbol: 'NVDAx', protocolId: 'kamino', protocolName: 'Kamino', category: 'lending', summary: 'registry' },
        { kind: 'token-added', severity: 'info', mint: 'M2', symbol: 'ABC', protocolId: 'raydium', protocolName: 'Raydium', category: 'dex' }
    ] };
    const footprintDiff = { from: '2026-09-23', to: '2026-09-24', unreadMints: 3, counts: {}, events: [
        { kind: 'defi-integration-added', severity: 'info', mint: 'M1', symbol: 'NVDAx', protocolId: 'kamino', category: 'lending', detectedBy: 'chain' },
        { kind: 'defi-integration-candidate', severity: 'caution', mint: 'M3', symbol: 'SPYx', programId: 'Prog', detectedBy: 'chain' }
    ] };

    test('registry and chain observations of the same addition collapse into one row with both sources', () => {
        const feed = buildDefiNewFeed([registryDiff, footprintDiff]);
        const kamino = feed.items.filter((row) => row.protocolId === 'kamino');
        expect(kamino).toHaveLength(1);
        expect(kamino[0].detectedBy.sort()).toEqual(['chain', 'registry']);
        expect(feed.items[0].category).toBe('lending'); // non-DEX first
        expect(feed.counts).toMatchObject({ added: 1, dexPoolsAdded: 1, candidates: 1 });
    });

    test('the merged daily diff counts every declared kind', () => {
        const merged = mergeFootprintDiff(registryDiff, footprintDiff);
        expect(merged.counts).toMatchObject({ 'token-added': 2, 'defi-integration-added': 1, 'defi-integration-candidate': 1, 'token-removed': 0 });
        expect(merged.footprint.unreadMints).toBe(3);
    });

    test('footprint candidates become evidence-review items in the DeFi area', () => {
        const items = buildReviewQueue({ issuerDb: { issuers: [{ slug: 'xstocks-backed', name: 'xStocks' }] }, legalTemplates: {}, defiCandidates: [{
            reason: 'unknown-program', mint: 'MINT_NVDA', symbol: 'NVDAx', issuer: 'xstocks-backed', programId: UNKNOWN_PROGRAM,
            owners: ['UnknownState'], summary: 'Program holds NVDAx.', observedAt: '2026-09-24T00:00:00Z'
        }] });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ issue: 'defi-integration-candidate', area: 'defi', priority: 'P1', issuerName: 'xStocks' });
    });
});

describe('registry diff sees a new market inside an already-listed protocol', () => {
    const usage = (markets) => ({ items: [{ mint: 'M', symbol: 'NVDAx', integrations: [{ id: 'kamino:collateral', protocolId: 'kamino', protocolName: 'Kamino', category: 'lending', status: 'live', markets }] }] });
    const day = (date, markets) => ({ date, items: snapshotDefiUsage(usage(markets)) });

    test('Kamino adding the Sentora xStocks Market for NVDAx is a market-added event', () => {
        const before = day('2026-09-23', [{ name: 'xStocks Market', marketAddress: 'A' }]);
        const after = day('2026-09-24', [{ name: 'xStocks Market', marketAddress: 'A' }, { name: 'Sentora xStocks Market', marketAddress: 'B' }]);
        const diff = diffDefiSnapshots(before, after);
        expect(diff.events).toEqual([expect.objectContaining({ kind: 'market-added', market: { address: 'B', name: 'Sentora xStocks Market' } })]);
        expect(diffDefiSnapshots(after, before).events.map((e) => e.kind)).toEqual(['market-removed']);
    });

    test('snapshots written before market identities existed raise no market events', () => {
        const legacy = { date: '2026-09-20', items: day('x', []).items.map(({ markets, ...rest }) => rest) };
        expect(diffDefiSnapshots(legacy, day('2026-09-24', [{ name: 'B', marketAddress: 'B' }])).events).toEqual([]);
    });
});

describe('Loopscale lending-vault registry', () => {
    test('a vault whose terms name the exact mint is a standing collateral offer; its allocation counter is not the loans', () => {
        const vaults = [{
            vault: { address: 'V1', principalMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', depositsEnabled: true },
            vaultMetadata: { name: 'USDC Orca' },
            vaultStrategy: { strategy: { address: 'S1' }, terms: { assetTerms: { MINT_NVDA: { durationAndApys: [[{ duration: 1 }, 20000]], allocationInfo: { currentAllocationAmount: '21337692372' } } } } }
        }, { vault: { address: 'V2' }, vaultStrategy: { terms: { assetTerms: { OTHER: {} } } } }];
        const rows = loopscaleVaultMarkets(token, vaults);
        expect(rows).toEqual([expect.objectContaining({ vaultAddress: 'V1', debtSymbol: 'USDC', lenderApyPct: 2, source: 'lending-vault-registry' })]);
        expect(rows[0].vaultAllocation).toBeCloseTo(21337.692372, 6);
        // Without a Loan scan nothing is known about open loans: an offer, with no debt figure.
        const usage = buildDefiUsage({ tokens: [token], fetchedAt: 't', loopscaleVaults: vaults });
        expect(usage.items[0].integrations).toEqual([expect.objectContaining({ protocolId: 'loopscale', status: 'available' })]);
        expect(usage.items[0].integrations[0].metrics).toMatchObject({ debtAgainstCollateralUsd: null, positions: null });
        // With a Loan scan that found no Loan naming this mint, the open principal is a measured zero.
        const scanned = buildDefiUsage({ tokens: [token], fetchedAt: 't', loopscaleVaults: vaults, loopscale: { fetchedAt: 't', positions: [] } });
        expect(scanned.items[0].integrations[0].metrics).toMatchObject({ debtAgainstCollateralUsd: 0, positions: 0, debtLabel: 'open loan principal' });
    });
});

describe('footprint snapshot size discipline', () => {
    test('a holding that only grew past the threshold is not announced as new', () => {
        const owners = [[WALLET, { owner: '11111111111111111111111111111111' }]];
        const small = snap('2026-09-23', footprint([{ tokenAccount: 't', owner: XSTOCKS_LMA, amountUi: 0.01, sharePct: 0.001 }], owners));
        expect(small.holdings).toEqual([]);
        expect(Object.values(small.minor).flat()).toHaveLength(1);
        const big = snap('2026-09-24', footprint([{ tokenAccount: 't', owner: XSTOCKS_LMA, amountUi: 80, sharePct: 8 }], owners));
        expect(diffFootprints(small, big).events).toEqual([]);
    });
});
