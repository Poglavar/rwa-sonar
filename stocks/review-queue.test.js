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

    test('does not turn our corrected research history into a public review item', () => {
        const items = buildReviewQueue({
            issuerDb: { issuers: [issuer] }, legalTemplates: { templates: [] }, nowMs: Date.parse('2026-09-20T00:00:00Z')
        });
        expect(items.map((row) => [row.field, row.issue, row.priority])).toEqual([
            ['holderClaim', 'missing', 'P1']
        ]);
        expect(items).toHaveLength(1);
        expect(queueSummary(items).byArea).toMatchObject({ ownership: 1 });
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
        const event = items.find((row) => row.eventId === 7);
        expect(event.claimImpact).toMatch(/exit for cash/);
        expect(event).toMatchObject({
            retrievalState: 'retrieved successfully',
            contentComparisonState: 'source bytes or cited text changed; relevance is not yet reviewed',
            analystReviewState: 'pending analyst review',
            conclusionValidityState: 'published conclusion must be treated as provisional'
        });
        expect(event.affectedConclusions).toContain('cash exit');
        expect(event.resolutionCriteria).toMatch(/Compare the new source text/);
    });

    test('sorts high-impact evidence recovery ahead of low-value changed URLs', () => {
        const items = buildReviewQueue({
            issuerDb: { issuers: [issuer] },
            legalTemplates: { templates: [] },
            changeEvents: [
                { id: 10, subject_type: 'issuer', subject_id: 'example', issuer_slug: 'example', kind: 'metadata', field: 'documentUrl', severity: 'warning', summary: 'A documentation URL changed', detected_at: '2026-09-20T04:00:00Z' },
                { id: 11, subject_type: 'issuer', subject_id: 'example', issuer_slug: 'example', kind: 'legal-term', field: 'holderClaim', severity: 'warning', summary: 'Holder claim language changed', detected_at: '2026-09-20T03:00:00Z' }
            ]
        });
        const ranked = items.filter((row) => row.eventId === 10 || row.eventId === 11);
        expect(ranked.map((row) => row.eventId)).toEqual([11, 10]);
        expect(ranked[0].impactScore).toBeGreaterThan(ranked[1].impactScore);
    });

    test('a retained database claim from an older editorial reading does not reappear publicly', () => {
        const current = { ...issuer, evidenceFields: ['redemption.rails'], claims: [
            { field: 'redemption.rails', status: 'confirmed', url: 'https://issuer.test/terms', quote: 'Current words' }
        ] };
        const items = buildReviewQueue({
            issuerDb: { issuers: [current] }, legalTemplates: { templates: [] },
            databaseClaims: [
                { issuer_slug: 'example', field: 'redemption.rails', status: 'changed', url: 'https://issuer.test/terms', quote: 'Old words' },
                { issuer_slug: 'example', field: 'redemption.rails', status: 'confirmed', url: 'https://issuer.test/terms', quote: 'Current words' }
            ]
        });
        expect(items).toEqual([]);
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

    test('routes quarantined discovery addresses into ownership review without publishing them as assets', () => {
        const items = buildReviewQueue({
            issuerDb: { issuers: [issuer] }, legalTemplates: { templates: [] },
            discoveryCandidates: [{
                mint: 'candidateMint', symbol: 'EX', proposedIssuer: 'example', status: 'candidate',
                severity: 'caution', reasons: ['no issuer-controlled exact-mint source'],
                signals: { stockTag: true, aggregatorVerified: true }, lastSeenAt: '2026-09-20T04:00:00Z'
            }]
        });
        const candidate = items.find((row) => row.issue === 'discovery-candidate');
        expect(candidate).toMatchObject({ area: 'ownership', priority: 'P1', issuerSlug: 'example' });
        expect(candidate.detail).toContain('candidateMint');
        expect(queueSummary(items).byIssue['discovery-candidate']).toBe(1);
    });

    test('folds source-registry suffixes onto the canonical issuer and keeps caution at P1', () => {
        const items = buildReviewQueue({
            issuerDb: { issuers: [issuer] }, legalTemplates: { templates: [] },
            changeEvents: [{ id: 9, subject_type: 'source', subject_id: 'abc', issuer_slug: 'example-token', kind: 'legal-term', field: 'redemption.rails', severity: 'caution', summary: 'Terms moved', detected_at: '2026-09-20T02:00:00Z' }]
        });
        const event = items.find((row) => row.eventId === 9);
        expect(event).toMatchObject({ issuerSlug: 'example', issuerName: 'Example', priority: 'P1' });
        expect(event.href).toBe('./issuers/example.html');
    });

    test('acknowledgement SQL accepts only a numeric event id', () => {
        expect(acknowledgeEventSql(42)).toContain('WHERE id = 42 AND acknowledged_at IS NULL');
        expect(() => acknowledgeEventSql('1; DROP TABLE sonar.claim')).toThrow(/positive integer/);
    });
});
