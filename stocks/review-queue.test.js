import { acknowledgeEventSql, areaFor, buildReviewQueue, queueSummary } from './lib/review-queue.mjs';

const issuer = {
    slug: 'example', name: 'Example', evidenceFields: ['holderClaim', 'redemption.rails', 'keyGovernance.freeze'],
    claims: [
        { field: 'redemption.rails', status: 'confirmed', accessedAt: '2026-09-19T00:00:00Z' },
        { field: 'keyGovernance.freeze', status: 'contradicted-corrected', accessedAt: '2026-09-19T00:00:00Z' }
    ]
};

describe('evidence review queue', () => {
    test('classifies the consequential legal and technical areas', () => {
        expect(areaFor('holderClaim')).toBe('ownership');
        expect(areaFor('bankruptcyRemote')).toBe('insolvency');
        expect(areaFor('redemption.rails')).toBe('redemption');
        expect(areaFor('keyGovernance.freeze')).toBe('control');
        expect(areaFor('', 'Can a lending protocol liquidate collateral?')).toBe('defi');
    });

    test('puts missing and conflicting required evidence ahead of ordinary gaps', () => {
        const items = buildReviewQueue({
            issuerDb: { issuers: [issuer] }, legalTemplates: { templates: [] }, nowMs: Date.parse('2026-09-20T00:00:00Z')
        });
        expect(items.map((row) => [row.field, row.issue, row.priority])).toEqual(expect.arrayContaining([
            ['holderClaim', 'missing', 'P1'],
            ['keyGovernance.freeze', 'conflict', 'P1']
        ]));
        expect(items).toHaveLength(2);
        expect(queueSummary(items).byArea).toMatchObject({ ownership: 1, control: 1 });
    });

    test('watcher state overrides the older dossier claim and an event stays open until acknowledged', () => {
        const databaseClaims = [
            { issuer_slug: 'example', field: 'redemption.rails', status: 'changed', last_checked_at: '2026-09-20T01:00:00Z' }
        ];
        const changeEvents = [
            { id: 7, subject_type: 'issuer', subject_id: 'example', issuer_slug: 'example', kind: 'legal-term', field: 'redemption.fees', severity: 'warning', summary: 'Fee language changed', detected_at: '2026-09-20T02:00:00Z' },
            { id: 8, subject_type: 'issuer', subject_id: 'example', issuer_slug: 'example', kind: 'legal-term', field: 'redemption.kyc', severity: 'warning', summary: 'Already handled', detected_at: '2026-09-20T02:00:00Z', acknowledged_at: '2026-09-20T03:00:00Z' }
        ];
        const items = buildReviewQueue({ issuerDb: { issuers: [issuer] }, legalTemplates: { templates: [] }, databaseClaims, changeEvents });
        expect(items.some((row) => row.field === 'redemption.rails' && row.issue === 'changed' && row.priority === 'P0')).toBe(true);
        expect(items.some((row) => row.eventId === 7)).toBe(true);
        expect(items.some((row) => row.eventId === 8)).toBe(false);
    });

    test('adds only DeFi-enforcement open questions from legal templates', () => {
        const items = buildReviewQueue({
            issuerDb: { issuers: [issuer] },
            legalTemplates: { templates: [{ id: 'tpl', issuer: { slug: 'example', name: 'Example' }, openQuestions: [
                'Can a lending protocol liquidate the collateral?', 'Which court has jurisdiction?'
            ] }] }
        });
        expect(items.filter((row) => row.issue === 'open-question')).toHaveLength(1);
        expect(items.find((row) => row.issue === 'open-question').area).toBe('defi');
    });

    test('folds source-registry suffixes onto the canonical issuer and keeps caution at P1', () => {
        const items = buildReviewQueue({
            issuerDb: { issuers: [issuer] }, legalTemplates: { templates: [] },
            changeEvents: [{ id: 9, subject_type: 'source', subject_id: 'abc', issuer_slug: 'example-token', kind: 'legal-term', field: 'redemption.rails', severity: 'caution', summary: 'Terms moved', detected_at: '2026-09-20T02:00:00Z' }]
        });
        const event = items.find((row) => row.eventId === 9);
        expect(event).toMatchObject({ issuerSlug: 'example', issuerName: 'Example', priority: 'P1' });
        expect(event.href).toBe('./stocks.html#issuer-example');
    });

    test('acknowledgement SQL accepts only a numeric event id', () => {
        expect(acknowledgeEventSql(42)).toContain('WHERE id = 42 AND acknowledged_at IS NULL');
        expect(() => acknowledgeEventSql('1; DROP TABLE sonar.claim')).toThrow(/positive integer/);
    });
});
