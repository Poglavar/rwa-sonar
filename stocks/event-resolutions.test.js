import { eventFacts, matchesEventResolution, partitionEventResolutions } from './lib/event-resolutions.mjs';

const feeEvent = {
    id: 42,
    issuer_slug: 'prestocks',
    kind: 'extension-toggle',
    subject_type: 'token',
    subject_id: 'MINT',
    field: 'transfer_fee_bps',
    before: '50',
    after: '100',
    detected_at: '2026-09-19T08:07:00Z',
    evidence: { url: 'https://rpc.example' }
};

test('normalises stable event facts without depending on a database-local id', () => {
    expect(eventFacts(feeEvent)).toEqual({
        issuerSlug: 'prestocks', kind: 'extension-toggle', subjectType: 'token', subjectId: 'MINT',
        field: 'transfer_fee_bps', before: '50', after: '100', sourceUrl: 'https://rpc.example',
        detectedOn: '2026-09-19'
    });
});
test('one reviewed actor change resolves every matching token event', () => {
    const resolution = { id: 'fee-rise', match: {
        issuerSlug: 'prestocks', kind: 'extension-toggle', field: 'transfer_fee_bps',
        before: '50', after: '100', detectedOn: '2026-09-19'
    } };
    expect(matchesEventResolution(feeEvent, resolution)).toBe(true);
    const result = partitionEventResolutions([
        feeEvent,
        { ...feeEvent, id: 43, subject_id: 'OTHER' },
        { ...feeEvent, id: 44, after: '125' }
    ], [resolution]);
    expect(result.resolved.map(({ event }) => event.id)).toEqual([42, 43]);
    expect(result.open.map((event) => event.id)).toEqual([44]);
});

test('a vanished source is matched by URL rather than a mutable dossier array index', () => {
    const event = { kind: 'document-gone', evidence: { url: 'https://example.com/old' } };
    expect(matchesEventResolution(event, { match: {
        kind: 'document-gone', sourceUrl: 'https://example.com/old'
    } })).toBe(true);
});
