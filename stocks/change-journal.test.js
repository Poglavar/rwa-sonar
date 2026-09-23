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
});
