import { buildChangeJournal } from './lib/change-journal.mjs';
import watch from '../watch.js';

describe('public change journal', () => {
    test('publishes real actor changes but never internal-only resolutions', () => {
        const items = buildChangeJournal({ resolutions: [
            { id: 'real', public: true, date: '2026-09-20', title: 'Fee changed', kind: 'fee-change', issuerSlug: 'issuer',
                actor: 'Issuer authority', affectedHolders: ['all token holders'], whyItMatters: 'Transfers cost more.' },
            { id: 'noise', public: false, date: '2026-09-20', title: 'Transient fetch failure' }
        ] });
        expect(items.map((item) => item.id)).toEqual(['real']);
        expect(items[0]).toMatchObject({ eventAt: null, firstObservedAt: '2026-09-20' });
        expect(items[0]).toMatchObject({ actor: 'Issuer authority', affectedHolders: ['all token holders'], consequence: 'Transfers cost more.' });
    });

    test('describes catalogue observations without claiming issuance or burning', () => {
        const [removed, added] = buildChangeJournal({
            changes: [
                { kind: 'new-mint', mint: 'NEW', date: '2026-09-19', issuer: 'xstocks-backed' },
                { kind: 'removed-mint', mint: 'OLD', date: '2026-09-20', issuer: 'old' }
            ],
            identities: [{ mint: 'NEW', symbol: 'NEWx', operationalStatus: 'issuer-reports-zero-circulation' }]
        });
        expect(added.summary).toContain('observation date');
        expect(added).toMatchObject({ eventAt: null, firstObservedAt: '2026-09-19' });
        expect(added.assets[0].operationalStatus).toBe('issuer-reports-zero-circulation');
        expect(removed.summary).toContain('does not by itself mean the token was burned');
    });

    test('groups a bulk catalogue import by date and issuer instead of making hundreds of cards', () => {
        const items = buildChangeJournal({ changes: [
            { kind: 'new-mint', mint: 'A', date: '2026-09-20', issuer: 'xstocks-backed' },
            { kind: 'new-mint', mint: 'B', date: '2026-09-20', issuer: 'xstocks-backed' }
        ] });
        expect(items).toHaveLength(1);
        expect(items[0].title).toContain('2 xstocks-backed token addresses');
        expect(items[0].summary).not.toMatch(/\bmints?\b/);
        expect(items[0].assets.map((asset) => asset.mint)).toEqual(['A', 'B']);
    });

    test('groups exact-token protocol changes and keeps observation separate from event time', () => {
        const items = buildChangeJournal({
            defiChanges: { latest: { to: '2026-09-20', events: [
                { kind: 'token-removed', severity: 'warning', mint: 'A', protocolId: 'kamino', protocolName: 'Kamino' },
                { kind: 'token-removed', severity: 'warning', mint: 'B', protocolId: 'kamino', protocolName: 'Kamino' }
            ] } },
            identities: [{ mint: 'A', symbol: 'Ax' }, { mint: 'B', symbol: 'Bx' }]
        });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            category: 'protocol-change', eventAt: null, firstObservedAt: '2026-09-20', severity: 'warning'
        });
        expect(items[0].title).toContain('2 token addresses left Kamino');
        expect(items[0].sources[0].url).toBe('./monitor.html#defiChangesSection');
        expect(items[0].affectedHolders).toContain('current or prospective users of this exact protocol route');
    });

    test('a curated programme event links its issuer dossier and is titled with the issuer name', () => {
        const [spcx, unknown] = buildChangeJournal({
            curatedEvents: [
                { date: '2026-09-16', issuer: 'backpack-securities-spcx', kind: 'disclosure', summary: 'Self-custody may be worthless.' },
                { date: '2026-09-15', issuer: 'nobody-known', kind: 'wind-down', summary: 'Gone.' }
            ],
            issuerNames: { 'backpack-securities': 'Backpack Securities', backpack: 'Backpack' }
        });
        expect(spcx).toMatchObject({ href: './issuers/backpack-securities.html', title: 'Backpack Securities: disclosure', issuer: 'backpack-securities-spcx' });
        expect(unknown).toMatchObject({ href: null, title: 'nobody-known: wind down' });
    });
});

describe('protocol docs-vs-chain discrepancies in the journal', () => {
    const record = {
        id: 'multisig', title: 'Docs say 3-of-5; the chain shows 4 of 7', severity: 'info', observedAt: '2026-09-23',
        protocolId: 'loopscale', protocolName: 'Loopscale', tokenMint: 'MINT', symbol: 'SECZ',
        dossierSlug: 'secz-loopscale-loopscale-collateral-5vzwkk', reviewedAt: '2026-09-23T18:25:08Z',
        impact: 'The docs are out of date.', resolutionCondition: 'Docs updated.',
        claim: { text: '"All program upgrades require approval from a 3/5 multisig."', sources: [
            { label: 'Loopscale docs', url: 'https://docs.loopscale.com/partners/curators/security', locator: 'Access Controls', accessedAt: '2026-09-23T19:30:20Z' }] },
        reality: { text: 'Threshold 4 of 7.', sources: [
            { label: 'Squads multisig', url: 'https://solscan.io/account/C4awuufiuL8DNT5wMDP27HneKKqbgynrsbCa4XYGSuPk', locator: 'rpc:getAccountInfo', accessedAt: '2026-09-23T19:31:59Z' }] }
    };

    test('dates the entry by the day the discrepancy was recorded and keeps both sides with their evidence', () => {
        const [item] = buildChangeJournal({ protocolDiscrepancies: [record], tokens: [{ mint: 'MINT', symbol: 'SECZ', cardSlug: 'SECZ' }] });
        expect(item).toMatchObject({
            id: 'protocol-discrepancy-multisig', date: '2026-09-23', firstObservedAt: '2026-09-23', eventAt: null,
            reviewedAt: '2026-09-23T18:25:08Z', category: 'protocol-change', kind: 'docs-vs-chain', severity: 'info',
            actor: 'Loopscale', title: 'Loopscale: Docs say 3-of-5; the chain shows 4 of 7', consequence: 'The docs are out of date.',
            href: './protocols/secz-loopscale-loopscale-collateral-5vzwkk.html',
            claim: { text: record.claim.text }, reality: { text: 'Threshold 4 of 7.' }
        });
        expect(item.assets).toEqual([expect.objectContaining({ mint: 'MINT', symbol: 'SECZ', href: './cards/SECZ.html' })]);
        expect(item.sources).toEqual([...record.claim.sources, ...record.reality.sources]);
    });

    test('a record without its recorded date is left out, never dated now', () => {
        expect(buildChangeJournal({ protocolDiscrepancies: [{ ...record, observedAt: null }] })).toEqual([]);
    });
});


describe('observed token-control deltas in the public journal', () => {
    const address = '0x1234567890abcdef1234567890abcdef12345678';
    const event = {
        id: `ethereum:${address}:2026-09-30T23:00:00Z:owner`,
        deploymentId: `ethereum:${address}`, productId: 'fund-one', productName: 'Fund One',
        address, network: 'Ethereum', field: 'owner', before: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        after: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', firstObservedAt: '2026-09-30T23:00:00Z',
        eventAt: null, blockTimestamp: '2026-09-30T22:58:00.000Z', blockHash: `0x${'12'.repeat(32)}`, slot: null
    };
    const researchProducts = [{
        id: 'fund-one', name: 'Fund One', ticker: 'FUND', instrument: { id: 'instrument:fund-one' },
        deployments: [{ id: event.deploymentId, network: 'Ethereum', address, identityCheckedAt: '2026-09-10T00:00:00Z' }]
    }];

    test('publishes only an actual changed control on a verified exact deployment with separate observation/block times', () => {
        const [item] = buildChangeJournal({ deploymentEvents: [event], researchProducts });
        expect(buildChangeJournal({ deploymentEvents: [event], researchProducts })[0].id).toBe(item.id);
        expect(item).toMatchObject({
            id: `deployment-control-${event.id}`, date: '2026-09-30', category: 'actor-change', kind: 'control-change',
            eventAt: null, effectiveAt: null, firstObservedAt: '2026-09-30T23:00:00Z',
            blockTimestamp: '2026-09-30T22:58:00.000Z', actor: 'Fund One', issuer: null,
            href: './report.html?product=fund-one', before: event.before, after: event.after,
            deployment: { id: event.deploymentId, network: 'Ethereum', address, instrumentId: 'instrument:fund-one', field: 'owner' }
        });
        expect(item.summary).toContain('The block timestamp dates the observed state, not the precise control-change time.');
        expect(item.assets).toEqual([expect.objectContaining({ mint: address, name: `Ethereum deployment ${address}`, href: null, network: 'Ethereum', address })]);
        expect(item.assets[0].href).toBeNull();
        const [rendered] = watch.journalRows([item]);
        expect(rendered).toMatchObject({ eventAt: null, firstObservedAt: item.firstObservedAt, href: item.href });
        expect(rendered.assets[0]).toMatchObject({ mint: address, name: `Ethereum deployment ${address}`, href: null });
        expect(rendered.sources[0]).toMatchObject({ url: './rwa-research.json', accessedAt: item.firstObservedAt });
        expect(rendered.summary).toContain(item.blockTimestamp);
    });

    test('ignores baseline-like, internal, missing-field, supply and unverified-deployment rows', () => {
        const bad = [
            { ...event, id: 'supply', field: 'supply', before: '100', after: '101' },
            { ...event, id: 'supply-raw', field: 'supplyRaw', before: '100000000', after: '101000000' },
            { ...event, id: 'decimals', field: 'decimals', before: '6', after: '9' },
            { ...event, id: 'unknown-product', productId: 'corrected-product' },
            { ...event, id: 'unverified', deploymentId: 'ethereum:other', address: '0x' + '99'.repeat(20) },
            { ...event, id: 'baseline-no-old-value', before: undefined },
            { ...event, id: 'no-observed-time', firstObservedAt: null },
            { ...event, id: 'not-a-delta', before: 'same', after: 'same' }
        ];
        expect(buildChangeJournal({ deploymentEvents: bad, researchProducts })).toEqual([]);
        expect(buildChangeJournal({ deploymentEvents: [], researchProducts })).toEqual([]);
    });
});
