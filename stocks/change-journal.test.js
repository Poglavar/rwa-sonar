import { buildChangeJournal } from './lib/change-journal.mjs';

describe('public change journal', () => {
    test('publishes real actor changes but never internal-only resolutions', () => {
        const items = buildChangeJournal({ resolutions: [
            { id: 'real', public: true, date: '2026-09-20', title: 'Fee changed', kind: 'fee-change', issuerSlug: 'issuer' },
            { id: 'noise', public: false, date: '2026-09-20', title: 'Transient fetch failure' }
        ] });
        expect(items.map((item) => item.id)).toEqual(['real']);
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
        expect(added.assets[0].operationalStatus).toBe('issuer-reports-zero-circulation');
        expect(removed.summary).toContain('does not by itself mean the token was burned');
    });

    test('groups a bulk catalogue import by date and issuer instead of making hundreds of cards', () => {
        const items = buildChangeJournal({ changes: [
            { kind: 'new-mint', mint: 'A', date: '2026-09-20', issuer: 'xstocks-backed' },
            { kind: 'new-mint', mint: 'B', date: '2026-09-20', issuer: 'xstocks-backed' }
        ] });
        expect(items).toHaveLength(1);
        expect(items[0].title).toContain('2 xstocks-backed mints');
        expect(items[0].assets.map((asset) => asset.mint)).toEqual(['A', 'B']);
    });
});
