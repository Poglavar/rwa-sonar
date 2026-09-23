import { acknowledgeEventSql, areaFor, buildReviewQueue, collapseEventSequences, inferenceReviewState, queueSummary } from './lib/review-queue.mjs';

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

    test('distinguishes a rigorously reviewed inference from an unsupported or unreviewed one', () => {
        const reviewed = { field: 'holderClaim', status: 'inference', reasoning: 'The register rule controls title.',
            sources: [{ url: 'https://issuer.test/register' }], scope: 'This issuer’s Solana token only', reviewedAt: '2026-09-20T00:00:00Z' };
        expect(inferenceReviewState(reviewed)).toMatchObject({ reviewed: true, sourceCount: 1, missing: [] });
        expect(inferenceReviewState({ ...reviewed, scope: '' })).toMatchObject({ reviewed: false, missing: ['scope'] });
        const items = buildReviewQueue({ issuerDb: { issuers: [{ slug: 'inference', name: 'Inference', evidenceFields: ['holderClaim'], claims: [reviewed] }] }, legalTemplates: { templates: [] } });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ issue: 'reviewed-inference', priority: 'P3', conclusionValidityState: 'reviewed inference; not source-confirmed', evidence: { reviewedInference: true } });
        const unreviewed = buildReviewQueue({ issuerDb: { issuers: [{ slug: 'unreviewed', name: 'Unreviewed', evidenceFields: ['holderClaim'], claims: [{ field: 'holderClaim', status: 'inference', reasoning: 'A conclusion' }] }] }, legalTemplates: { templates: [] } });
        expect(unreviewed[0]).toMatchObject({ issue: 'unsupported', priority: 'P1' });
        expect(unreviewed[0].detail).toMatch(/missing sources, scope, review date/);
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

    test('a changed claim superseded by a newer confirmed claim on the same field is not P0', () => {
        // The Republic case: the dossier keeps the old quote (now `changed`) beside a re-read claim
        // carrying the page's current wording.
        const url = 'https://issuer.test/offer';
        const dossier = (rereadAt) => ({
            slug: 'example', name: 'Example', evidenceFields: ['redemption.rails'],
            claims: [
                { field: 'redemption.rails', url, quote: 'old wording of the payout', status: 'confirmed', accessedAt: '2026-09-01T00:00:00Z' },
                ...(rereadAt ? [{ field: 'redemption.rails', url, quote: 'new wording of the payout', status: 'confirmed', accessedAt: rereadAt }] : [])
            ]
        });
        // Old words last seen 09-10; the watcher keeps re-checking them (last_checked moves on).
        const lost = { issuer_slug: 'example', field: 'redemption.rails', url, quote: 'old wording of the payout', status: 'changed', last_confirmed_at: '2026-09-10T00:00:00Z', last_checked_at: '2026-09-25T01:00:00Z' };
        // After load-db both dossier claims have sonar.claim rows; the re-read one carries its own
        // confirmation time.
        const loaded = (issuerRecord) => [lost, ...issuerRecord.claims.filter((c) => c.quote.startsWith('new'))
            .map((c) => ({ issuer_slug: 'example', field: c.field, url, quote: c.quote, status: 'confirmed', last_confirmed_at: c.accessedAt }))];
        const run = (issuerRecord) => buildReviewQueue({ issuerDb: { issuers: [issuerRecord] }, legalTemplates: { templates: [] }, databaseClaims: loaded(issuerRecord), changeEvents: [] })
            .some((row) => row.field === 'redemption.rails' && row.issue === 'changed');
        expect(run(dossier('2026-09-21T01:00:00Z'))).toBe(false);
        expect(run(dossier('2026-09-05T01:00:00Z'))).toBe(true);
        expect(run(dossier(null))).toBe(true);
    });

    test('keeps current reviewed-inference metadata when watcher timestamps are joined', () => {
        const reviewed = {
            field: 'holderClaim', status: 'inference', url: 'https://issuer.test/register', quote: null,
            reasoning: 'The register rule controls title.', sources: ['https://issuer.test/register'],
            scope: 'This issuer’s Solana token only', reviewedAt: '2026-09-22T00:00:00Z'
        };
        const items = buildReviewQueue({
            issuerDb: { issuers: [{ slug: 'inference', name: 'Inference', evidenceFields: ['holderClaim'], claims: [reviewed] }] },
            legalTemplates: { templates: [] },
            databaseClaims: [{ issuer_slug: 'inference', field: 'holderClaim', status: 'inference',
                url: 'https://issuer.test/register', quote: null, last_checked_at: '2026-09-22T01:00:00Z' }]
        });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ issue: 'reviewed-inference', observedAt: '2026-09-22T01:00:00.000Z' });
    });

    test('keeps watcher bootstrap baselines internal rather than presenting them as actor changes', () => {
        const items = buildReviewQueue({
            issuerDb: { issuers: [issuer] }, legalTemplates: { templates: [] },
            changeEvents: [{
                id: 12, subject_type: 'issuer', subject_id: 'example', issuer_slug: 'example',
                kind: 'status', field: 'chain-watch', severity: 'info',
                summary: 'baseline recorded: 3 mint(s) of example read on chain for the first time — no change events until the next run',
                detected_at: '2026-09-20T04:00:00Z'
            }]
        });
        expect(items.some((row) => row.eventId === 12)).toBe(false);
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

    test('collapses repeated unresolved observations of one source into one review sequence', () => {
        const items = buildReviewQueue({
            issuerDb: { issuers: [issuer] }, legalTemplates: { templates: [] },
            changeEvents: [
                { id: 20, subject_type: 'source', subject_id: 'terms-page', issuer_slug: 'example', kind: 'legal-term', field: 'redemption.fees', severity: 'caution', summary: 'Fee changed once', before: '1%', after: '2%', detected_at: '2026-09-18T00:00:00Z' },
                { id: 21, subject_type: 'source', subject_id: 'terms-page', issuer_slug: 'example', kind: 'legal-term', field: 'redemption.fees', severity: 'caution', summary: 'Fee changed again', before: '2%', after: '3%', detected_at: '2026-09-19T00:00:00Z' },
                { id: 22, subject_type: 'source', subject_id: 'other-page', issuer_slug: 'example', kind: 'legal-term', field: 'redemption.fees', severity: 'caution', summary: 'A separate source changed', detected_at: '2026-09-19T00:00:00Z' }
            ]
        });
        const sequences = items.filter((row) => row.field === 'redemption.fees' && row.eventId);
        expect(sequences).toHaveLength(2);
        const repeated = sequences.find((row) => row.eventSubjectId === 'terms-page');
        expect(repeated).toMatchObject({ eventId: 21, eventIds: [20, 21], observationCount: 2,
            previousText: '1%', currentText: '3%' });
        expect(repeated.detail).toContain('2 unresolved observations');
    });

    test('leaves non-event work items untouched when event histories are collapsed', () => {
        expect(collapseEventSequences([{ id: 'research', eventId: null, title: 'Research' }]))
            .toEqual([{ id: 'research', eventId: null, title: 'Research' }]);
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
