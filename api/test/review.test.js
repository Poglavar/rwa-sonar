import { parseResolutionPayload, publicResolution, requireReviewToken } from '../src/lib/review.js';

describe('review workbench authentication and decisions', () => {
    test('requires the exact bearer token without exposing it', () => {
        expect(requireReviewToken('Bearer secret', 'secret')).toBe(true);
        expect(() => requireReviewToken('Bearer wrong', 'secret')).toThrow('valid editor bearer token');
        expect(() => requireReviewToken('', '')).toThrow('not configured');
    });

    test('accepts a bounded audit decision', () => {
        expect(parseResolutionPayload({ itemId: '0123456789abcdef', resolution: 'corrected', note: 'Updated the dossier.', reviewer: 'Editor' }))
            .toEqual({ itemId: '0123456789abcdef', resolution: 'corrected', note: 'Updated the dossier.', reviewer: 'Editor' });
        expect(() => parseResolutionPayload({ itemId: 'x', resolution: 'delete', note: '', reviewer: '' })).toThrow();
    });

    test('publishes database names as API names', () => {
        expect(publicResolution({ id: '4', review_item_id: '0123456789abcdef', event_id: '7', issuer_slug: 'issuer', field: 'redemption', issue: 'changed', resolution: 'confirmed', note: 'Reviewed', reviewer: 'Editor', previous_text: 'old', current_text: 'new', claim_impact: 'impact', created_at: '2026-09-20T00:00:00Z' }))
            .toMatchObject({ id: 4, eventId: 7, previousText: 'old', currentText: 'new' });
    });
});
