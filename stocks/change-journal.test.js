import { buildChangeJournal } from './lib/change-journal.mjs';

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
