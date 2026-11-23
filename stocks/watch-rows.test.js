// Unit tests for stocks/lib/watch-rows.mjs — what a document-watch run writes: the next
// sources-state.json and the sonar.source / source_version / change_event rows. The rules under
// test keep the change feed honest: the first read under a new extractor re-baselines without a
// single event while a real change after it still raises one, a read archive.org throttled writes
// nothing and keeps the stored state, and a retired source is written as retired, never as an event.

import { buildRows, mergePendingLoad, nextState, revertUnstoredChange, settleExtractorUpgrade, wantsRawKept } from './lib/watch-rows.mjs';
import { publisherNormalizerVersion, HTML_EXTRACTOR_VERSION, settleThrottle } from './lib/watch.mjs';

const URL_ = 'https://www.cysec.gov.cy/en-GB/public-info/announcements/';
const QUOTE = { id: 'issuer:regulatoryStatus:1', kind: 'claim', ref: 'regulatoryStatus', slug: 'issuer', quote: 'Withdrawal of Investors Compensation Fund (ICF) membership' };

/** The stored state of a source last read under the previous HTML extractor. */
const storedV2 = {
    id: 'abc123def456', kind: 'html', status: 'ok', httpStatus: 200, contentHash: 'hash-v2', etag: '"e1"',
    firstSeenAt: '2026-09-17T02:00:00Z', lastCheckedAt: '2026-09-29T02:00:00Z', lastChangedAt: null,
    textPath: 'stocks/data/sources/abc123def456/2026-09-17T02-00-00Z.txt', rawPath: 'stocks/data/sources/abc123def456/2026-09-17T02-00-00Z.html',
    versions: 1, normalizerVersion: 2, quotesLost: []
};

/** One read as watchOne + recordChange leave it: a new hash with a caution-severity diff and a lost quote. */
function changedRead({ fetchedAt, hash, normalizerUpgrade, prev }) {
    return {
        id: 'abc123def456', url: URL_, issuer: 'issuer', title: 'CySEC announcements', foundIn: ['issuer:regulatoryStatus'],
        kind: 'html', fetchedAt, httpStatus: 200, bytes: 9000, textChars: 4300, contentHash: hash,
        etag: '"e2"', lastModified: null, status: 'changed', reason: 'new hash', error: null, via: 'html',
        textPath: `stocks/data/sources/abc123def456/${fetchedAt.replace(/:/g, '-')}.txt`,
        rawPath: `stocks/data/sources/abc123def456/${fetchedAt.replace(/:/g, '-')}.html`,
        normalizerVersion: publisherNormalizerVersion(URL_, 'html'),
        normalizerUpgrade: normalizerUpgrade ?? publisherNormalizerVersion(URL_, 'html') > (prev?.normalizerVersion ?? 1),
        diff: {
            added: 120, removed: 1, method: 'keyword', severity: 'caution', keywords: ['redemption', 'terminate'],
            summary: '+120 -1 line(s) · keywords: redemption, terminate', unified: '+ Withdrawal of ...'
        },
        quotes: { checked: 1, found: 0, foundIds: [], skipped: 0, notCheckable: 0, lost: [QUOTE] }
    };
}

describe('an extractor upgrade re-baselines silently; a real change after it does not', () => {
    test('the first read under the new extractor records a version and raises no event', () => {
        const result = settleExtractorUpgrade(changedRead({ fetchedAt: '2026-10-01T02:00:00Z', hash: 'hash-v3', prev: storedV2 }));
        expect(result.normalizerVersion).toBe(HTML_EXTRACTOR_VERSION);
        expect(result).toMatchObject({ status: 'ok', rebaselined: true, versionRecorded: true });
        expect(result.reason).toBe(`extractor upgraded to v${HTML_EXTRACTOR_VERSION}; baseline re-recorded without a change event`);

        const rows = buildRows([result], { [URL_]: storedV2 });
        expect(rows.events).toEqual([]);
        expect(rows.versions).toHaveLength(1);
        expect(rows.versions[0]).toMatchObject({ contentHash: 'hash-v3', diffSeverity: null });
        expect(rows.versions[0].diffSummary).toMatch(/^re-baseline under extractor v3, not a document change: \+120 -1/);
        expect(rows.sources[0]).toMatchObject({ status: 'ok', contentHash: 'hash-v3', lastChangedAt: null });

        // The quote the re-baseline misses is NOT recorded as lost, so the next run can still raise it.
        const state = nextState([result], { [URL_]: storedV2 });
        expect(state[URL_]).toMatchObject({ contentHash: 'hash-v3', normalizerVersion: HTML_EXTRACTOR_VERSION, versions: 2, quotesLost: [] });
    });

    test('the next run diffs against that baseline, and a real change raises its events', () => {
        const rebaseline = settleExtractorUpgrade(changedRead({ fetchedAt: '2026-10-01T02:00:00Z', hash: 'hash-v3', prev: storedV2 }));
        const afterRebaseline = nextState([rebaseline], { [URL_]: storedV2 })[URL_];

        const real = settleExtractorUpgrade(changedRead({ fetchedAt: '2026-10-02T02:00:00Z', hash: 'hash-v3b', prev: afterRebaseline }));
        expect(real.normalizerUpgrade).toBe(false);
        expect(real.status).toBe('changed');
        const rows = buildRows([real], { [URL_]: afterRebaseline });
        expect(rows.events.map((e) => e.kind).sort()).toEqual(['legal-term', 'quote-lost']);
        expect(rows.events.find((e) => e.kind === 'legal-term')).toMatchObject({ before: 'hash-v3', after: 'hash-v3b', severity: 'caution' });
        expect(nextState([real], { [URL_]: afterRebaseline })[URL_].quotesLost).toEqual([QUOTE.id]);
    });

    test('without the upgrade flag the same read is an ordinary change with its events', () => {
        const read = settleExtractorUpgrade(changedRead({ fetchedAt: '2026-10-01T02:00:00Z', hash: 'hash-v3', normalizerUpgrade: false }));
        expect(read.status).toBe('changed');
        expect(buildRows([read], { [URL_]: storedV2 }).events).toHaveLength(2);
    });
});

describe('archive references belong to a content version', () => {
    const oldArchive = 'https://web.archive.org/web/20260901000000/https://www.cysec.gov.cy/en-GB/public-info/announcements/';
    test('a failed archive for changed content keeps old evidence but does not attach it to the new version', () => {
        const prev = { ...storedV2, contentHash: 'hash-v2', archiveUrl: oldArchive, archiveContentHash: 'hash-v2' };
        const result = {
            ...changedRead({ fetchedAt: '2026-10-02T02:00:00Z', hash: 'hash-v3', prev }),
            archiveUrl: oldArchive, archiveContentHash: 'hash-v2', archivePending: true,
            archiveHistory: []
        };
        const state = nextState([result], { [URL_]: prev })[URL_];
        const rows = buildRows([result], { [URL_]: prev });
        expect(state).toMatchObject({
            archiveUrl: oldArchive, archiveContentHash: 'hash-v2', archivePending: true,
            versionFetchedAt: '2026-10-02T02:00:00Z'
        });
        expect(rows.sources[0].archiveUrl).toBe(oldArchive);
        expect(rows.versions[0].archiveUrl).toBeNull();
    });

    test('a successful retry preserves the old capture in history and attaches the new one to its version', () => {
        const prev = { ...storedV2, contentHash: 'hash-v2', archiveUrl: oldArchive, archiveContentHash: 'hash-v2' };
        const result = {
            ...changedRead({ fetchedAt: '2026-10-02T02:00:00Z', hash: 'hash-v3', prev }),
            archiveUrl: 'https://web.archive.org/web/20261002030000/https://www.cysec.gov.cy/en-GB/public-info/announcements/',
            archiveContentHash: 'hash-v3', archivePending: false,
            archiveHistory: [{ archiveUrl: oldArchive, contentHash: 'hash-v2' }]
        };
        const state = nextState([result], { [URL_]: prev })[URL_];
        const rows = buildRows([result], { [URL_]: prev });
        expect(state).toMatchObject({ archiveUrl: result.archiveUrl, archiveContentHash: 'hash-v3', archivePending: false });
        expect(state.archiveHistory).toContainEqual({ archiveUrl: oldArchive, contentHash: 'hash-v2' });
        expect(rows.versions[0].archiveUrl).toBe(result.archiveUrl);
    });
});

describe('a throttled read writes nothing and keeps the stored state', () => {
    const capture = 'https://web.archive.org/web/20260129134841/https://remoramarkets.xyz/legal-documentation/privacy-policy';
    const stored = { ...storedV2, id: 'db0acd299783', normalizerVersion: HTML_EXTRACTOR_VERSION };
    const throttled = (prev) => settleThrottle({
        id: 'db0acd299783', url: capture, fetchedAt: '2026-10-01T02:30:00Z', status: 'throttled', httpStatus: null, contentHash: prev?.contentHash ?? null,
        reason: 'archive.org pushed back (ECONNREFUSED after backoff) — our traffic, not the source; retried next run'
    }, prev);

    test('no source row, no version, no event; the state keeps the last real read and counts the throttle', () => {
        const result = throttled(stored);
        const rows = buildRows([result], { [capture]: stored });
        expect(rows).toEqual({ sources: [], versions: [], events: [] });
        const state = nextState([result], { [capture]: stored })[capture];
        expect(state).toMatchObject({ ...stored, throttledRuns: 1, lastThrottledAt: '2026-10-01T02:30:00Z' });
        expect(state.lastCheckedAt).toBe(stored.lastCheckedAt);
    });

    test('a real read afterwards resets the count; a third throttle in a row is an error', () => {
        const once = nextState([throttled(stored)], { [capture]: stored })[capture];
        const twice = nextState([throttled(once)], { [capture]: once })[capture];
        expect(twice.throttledRuns).toBe(2);
        const third = throttled(twice);
        expect(third.status).toBe('error');
        const rows = buildRows([third], { [capture]: twice });
        expect(rows.sources[0]).toMatchObject({ status: 'error', contentHash: 'hash-v2' });
        expect(rows.sources[0].error).toMatch(/on 3 consecutive runs/);

        const ok = { ...changedRead({ fetchedAt: '2026-10-04T02:00:00Z', hash: 'hash-v2', normalizerUpgrade: false }), url: capture, status: 'ok', diff: null, quotes: null };
        expect(nextState([ok], { [capture]: twice })[capture].throttledRuns).toBeUndefined();
    });
});

describe('a retired source', () => {
    test('is written as retired with its reason, keeps its last reading, and raises no event', () => {
        const url = 'https://remoramarkets.xyz/proof-of-reserves';
        const prev = { id: '22dfe4ba1a1a', kind: 'html', status: 'error', httpStatus: null, contentHash: null, firstSeenAt: '2026-09-17T02:00:00Z', lastCheckedAt: '2026-09-30T04:00:00Z' };
        const result = {
            id: '22dfe4ba1a1a', url, issuer: 'remora-markets', title: 'remora-markets:findings[4].statement', foundIn: ['remora-markets:findings[4].statement'],
            kind: 'html', status: 'retired', retiredAt: '2026-09-30', retiredReason: 'Remora Markets is wound down; the domain answers DNS SERVFAIL.'
        };
        const rows = buildRows([result], { [url]: prev });
        expect(rows.events).toEqual([]);
        expect(rows.versions).toEqual([]);
        expect(rows.sources[0]).toMatchObject({
            status: 'retired', lastCheckedAt: '2026-09-30T04:00:00Z', firstSeenAt: '2026-09-17T02:00:00Z',
            error: 'retired 2026-09-30: Remora Markets is wound down; the domain answers DNS SERVFAIL.'
        });
        expect(nextState([result], { [url]: prev })[url]).toMatchObject({ status: 'retired', retiredAt: '2026-09-30', lastCheckedAt: '2026-09-30T04:00:00Z' });
    });
});

describe('ingest apart from the Postgres load (2026-11-23)', () => {
    test('a change whose version files could not be written does not advance the state, so the next run sees it again', () => {
        const prev = { ...storedV2, normalizerVersion: publisherNormalizerVersion(URL_, 'html') };
        const read = revertUnstoredChange(changedRead({ fetchedAt: '2026-11-23T02:41:00Z', hash: 'hash-new', normalizerUpgrade: false, prev }), prev, 'ENOSPC: no space left on device');
        expect(read).toMatchObject({ status: 'error', storeFailed: true, contentHash: 'hash-v2', etag: '"e1"', textPath: null, rawPath: null });
        const state = nextState([read], { [URL_]: prev })[URL_];
        expect(state.contentHash).toBe('hash-v2');
        expect(state.textPath).toBe(prev.textPath);
        expect(state.etag).toBe('"e1"');
        expect(buildRows([read], { [URL_]: prev }).versions).toEqual([]);
    });

    test('the bytes of a read our reader could not use are kept; a 304 with no body is not', () => {
        expect(wantsRawKept({ extractionFailed: true }, Buffer.from('%PDF-1.7 broken'))).toBe(true);
        expect(wantsRawKept({ unreadableCode: 'js-shell' }, Buffer.from('<html><script></script></html>'))).toBe(true);
        expect(wantsRawKept({ unreadableCode: 'js-shell' }, Buffer.alloc(0))).toBe(false);
        expect(wantsRawKept({ status: 'ok' }, Buffer.from('fine'))).toBe(false);
    });

    test('rows a failed load kept are offered first next run; this run\'s source row replaces the kept one', () => {
        const pending = {
            sources: [{ id: 'a', status: 'changed' }, { id: 'b', status: 'ok' }],
            versions: [{ sourceId: 'a', fetchedAt: '2026-11-22T02:41:00Z' }],
            events: [{ subjectId: 'a', kind: 'legal-term', detectedAt: '2026-11-22T02:41:00Z' }]
        };
        const rows = { sources: [{ id: 'a', status: 'ok' }], versions: [], events: [] };
        const merged = mergePendingLoad(pending, rows);
        expect(merged.versions).toEqual(pending.versions);
        expect(merged.events).toEqual(pending.events);
        expect(merged.sources).toEqual([{ id: 'b', status: 'ok' }, { id: 'a', status: 'ok' }]);
        expect(mergePendingLoad(null, rows)).toBe(rows);
    });
});
