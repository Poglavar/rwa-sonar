import { assessDiscovery, partitionDiscoveries, sponsorMintIndex } from './lib/discovery-candidates.mjs';

const base = {
    mint: 'mint-1', symbol: 'ACMEx', name: 'Acme xStock', tags: ['stocks', 'xstocks'],
    isVerified: true, mintAuthority: '7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj', freezeAuthority: null,
    issuer: 'xstocks-backed'
};

describe('discovery admission', () => {
    test('admits a new mint only when independent issuer signals agree', () => {
        expect(assessDiscovery(base)).toMatchObject({
            decision: 'admit', proposedIssuer: 'xstocks-backed',
            admittedBy: 'concordant issuer tag and known programme authority'
        });
    });

    test('quarantines a stock-tagged address when identity is only an aggregator claim', () => {
        const assessment = assessDiscovery({ ...base, mintAuthority: null });
        expect(assessment.decision).toBe('candidate');
        expect(assessment.reasons).toContain('no issuer-controlled exact-mint source');
    });

    test('treats conflicting programme identities as critical', () => {
        const assessment = assessDiscovery({ ...base, freezeAuthority: '2Yq4T3mPNfjtEyTxSbRjRKqLf1pwbTasuCQrWe6QpM7x' });
        expect(assessment).toMatchObject({ decision: 'candidate', severity: 'critical' });
        expect(assessment.reasons).toContain('issuer signals disagree');
    });

    test('accepts an issuer exact-mint registry and maps its programme', () => {
        const sponsorApis = { items: { superstate: [{ mint: 'mint-super' }] } };
        const index = sponsorMintIndex(sponsorApis);
        const assessment = assessDiscovery({ mint: 'mint-super', symbol: 'ACME', tags: ['stocks'], isVerified: false }, { sponsorMints: index });
        expect(assessment).toMatchObject({ decision: 'admit', proposedIssuer: 'superstate-opening-bell', admittedBy: 'issuer exact-mint registry' });
        const partitioned = partitionDiscoveries({
            previousItems: [], freshItems: [{ mint: 'mint-super', symbol: 'ACME', tags: ['stocks'], isVerified: false }],
            sponsorApis, fetchedAt: '2026-09-20T00:00:00Z'
        });
        expect(partitioned.accepted[0]).toMatchObject({ issuer: 'superstate-opening-bell', underlyingTicker: 'ACME' });
    });

    test('keeps new uncertainty out of the universe and carries the candidate across a missed search run', () => {
        const first = partitionDiscoveries({
            previousItems: [], freshItems: [{ ...base, mintAuthority: null }], fetchedAt: '2026-09-20T00:00:00Z'
        });
        expect(first.accepted).toHaveLength(0);
        expect(first.candidates).toHaveLength(1);
        const second = partitionDiscoveries({
            previousItems: [], freshItems: [], previousCandidates: first.candidates, fetchedAt: '2026-09-21T00:00:00Z'
        });
        expect(second.candidates[0]).toMatchObject({ firstSeenAt: '2026-09-20T00:00:00Z', seenInSearch: false });
    });

    test('never re-quarantines a mint already admitted to the reviewed universe', () => {
        const result = partitionDiscoveries({
            previousItems: [{ mint: 'mint-1' }], freshItems: [{ ...base, mintAuthority: null }], fetchedAt: '2026-09-20T00:00:00Z'
        });
        expect(result.accepted).toHaveLength(1);
        expect(result.candidates).toHaveLength(0);
    });
});
