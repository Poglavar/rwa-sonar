// What one document-watch run leaves behind, decided without IO: the next sources-state.json and
// the sonar.source / source_version / change_event rows. Pure so the rules that keep the change feed
// honest — an extractor upgrade re-baselines silently, a throttled read changes nothing, a retired
// source is recorded as retired — are unit tested (../watch-rows.test.js); watch-sources.mjs does
// the fetching and the writing.

import { readProvenance } from './watch.mjs';
import { archivedProvenance } from './wayback.mjs';

export const CHECK_EVERY = '1 day';

/**
 * A `changed` read that is only changed because this run read the source with a newer extraction
 * generation (`result.normalizerUpgrade`, lib/watch.mjs `publisherNormalizerVersion`) is a new
 * BASELINE, not a document change: the version is recorded (`versionRecorded`), the status is `ok`,
 * the diff keeps its line counts but loses its severity and keywords, and `rebaselined` tells
 * `buildRows` to raise no `legal-term` and no `quote-lost` event from it. A real change on the next
 * run diffs against this baseline and raises its events as usual. Mutates and returns `result`.
 */
export function settleExtractorUpgrade(result) {
    if (result?.status !== 'changed' || !result.normalizerUpgrade) return result;
    result.status = 'ok';
    result.versionRecorded = true;
    result.rebaselined = true;
    // A capture read keeps saying it is one (its `waybackNote` carries the capture date).
    result.reason = `extractor upgraded to v${result.normalizerVersion}; baseline re-recorded without a change event`
        + (result.via === 'wayback' && result.waybackNote ? ` — ${result.waybackNote}` : '');
    if (result.diff) {
        result.diff = {
            ...result.diff,
            severity: null,
            keywords: [],
            summary: `re-baseline under extractor v${result.normalizerVersion}, not a document change: ${result.diff.summary}`
        };
    }
    return result;
}

/**
 * sources-state.json for the next run, from this run's results over the stored state. A
 * `throttled` result was not a look at the source, so its stored entry is kept whole and only the
 * consecutive-throttle count moves; a retired source keeps its last readings under `status:
 * 'retired'`. Returns only the entries for `results` (the caller merges them into the file).
 */
export function nextState(results, previous = {}) {
    const state = {};
    for (const result of results) {
        const prev = previous[result.url] ?? null;
        if (result.status === 'throttled') {
            state[result.url] = { ...(prev ?? { id: result.id }), throttledRuns: result.throttledRuns ?? 1, lastThrottledAt: result.fetchedAt };
            continue;
        }
        if (result.status === 'retired') {
            state[result.url] = { ...(prev ?? { id: result.id }), status: 'retired', retiredAt: result.retiredAt, retiredReason: result.retiredReason };
            continue;
        }
        const read = result.status === 'ok' || result.status === 'changed';
        // An unreadable read (lib/unreadable.mjs) produced no text: the hash, the text files and
        // their provenance are still the last readable version's, so they are carried over whole.
        const standsOnStored = Boolean(result.unreadableCode) && !read;
        state[result.url] = {
            id: result.id,
            kind: result.kind,
            status: result.status,
            httpStatus: result.httpStatus,
            contentHash: result.contentHash,
            etag: result.etag,
            lastModified: result.lastModified,
            validatorStatus: result.validatorStatus ?? null,
            firstSeenAt: prev?.firstSeenAt ?? result.fetchedAt,
            lastCheckedAt: result.fetchedAt,
            lastChangedAt: result.status === 'changed' ? result.fetchedAt : (prev?.lastChangedAt ?? null),
            textPath: result.textPath ?? prev?.textPath ?? null,
            rawPath: result.rawPath ?? prev?.rawPath ?? null,
            archiveUrl: result.archiveUrl ?? prev?.archiveUrl ?? null,
            versions: (prev?.versions ?? 0)
                + (result.status === 'changed' || result.versionRecorded === true ? 1 : 0),
            // Only a read that produced text is read by the new extraction generation; a refusal or an
            // unreadable read on the upgrade day leaves the upgrade (and its event-free baseline
            // refresh) for the first real read.
            normalizerVersion: read
                ? (result.normalizerVersion ?? prev?.normalizerVersion ?? 1)
                : (prev?.normalizerVersion ?? result.normalizerVersion ?? 1),
            // Provenance of the stored text: `wayback` means the live host refused us and the text
            // is from the capture dated `captureTimestamp` — never a live read. A 304 keeps the
            // reader of the text it confirmed.
            via: standsOnStored ? (prev?.via ?? null) : (result.via ?? (result.httpStatus === 304 ? (prev?.via ?? null) : null)),
            readVia: standsOnStored ? (prev?.readVia ?? null) : readProvenance(result, prev).readVia,
            captureTimestamp: standsOnStored ? (prev?.captureTimestamp ?? null) : (result.via === 'wayback' ? result.captureTimestamp : null),
            captureUrl: standsOnStored ? (prev?.captureUrl ?? null) : (result.via === 'wayback' ? result.captureUrl : null),
            // The publisher's API the text was read from when the cited page gave us nothing.
            companionUrl: standsOnStored ? (prev?.companionUrl ?? null) : (result.companionUrl ?? null),
            // Why the last look did not read the document (null when it did): lib/unreadable.mjs.
            unreadableCode: read ? null : (result.unreadableCode ?? null),
            archiveTodayUrl: result.archiveTodayUrl ?? null,
            // A re-baseline's lost quotes are not recorded as lost, so a quote that is really gone
            // is still a TRANSITION — and an event — on the next run's read.
            quotesLost: result.quotes && !result.rebaselined ? result.quotes.lost.map((q) => q.id) : (prev?.quotesLost ?? []),
            // A persistent throttle that became an `error` keeps counting until a real read.
            ...(Number.isInteger(result.throttledRuns) ? { throttledRuns: result.throttledRuns } : {})
        };
    }
    return state;
}

/**
 * The rows for Postgres: sources always, versions and events only for what actually happened. A
 * `throttled` result writes nothing (the row keeps what the last real look found); a retired source
 * writes its row once more as `retired`, with the reason and date in `error`, and never an event.
 */
export function buildRows(results, previousState = {}, { checkEvery = CHECK_EVERY } = {}) {
    const sources = [];
    const versions = [];
    const events = [];
    for (const result of results) {
        const prev = previousState[result.url] ?? null;
        if (result.status === 'throttled') continue;
        if (result.status === 'retired') {
            sources.push({
                id: result.id,
                url: result.url,
                kind: prev?.kind ?? result.kind,
                title: result.title,
                issuer: result.issuer,
                foundIn: result.foundIn,
                firstSeenAt: prev?.firstSeenAt ?? null,
                lastCheckedAt: prev?.lastCheckedAt ?? null,
                lastChangedAt: prev?.lastChangedAt ?? null,
                checkEvery,
                archiveUrl: prev?.archiveUrl ?? null,
                status: 'retired',
                contentHash: prev?.contentHash ?? null,
                httpStatus: prev?.httpStatus ?? null,
                error: `retired ${result.retiredAt}: ${result.retiredReason}`,
                readVia: null,
                captureAt: null
            });
            continue;
        }
        const changed = result.status === 'changed';
        // A read from an archived capture says so wherever it surfaces (lib/wayback.mjs).
        const { evidence: archived, prefix: archivedPrefix } = archivedProvenance(result);
        const versionRecorded = changed || result.versionRecorded === true;
        const { readVia, captureAt } = readProvenance(result, prev);
        sources.push({
            id: result.id,
            url: result.url,
            kind: result.kind,
            title: result.title,
            issuer: result.issuer,
            foundIn: result.foundIn,
            firstSeenAt: prev?.firstSeenAt ?? result.fetchedAt,
            lastCheckedAt: result.fetchedAt,
            lastChangedAt: changed ? result.fetchedAt : (prev?.lastChangedAt ?? null),
            checkEvery,
            // A result reused from the day's checkpoint predates an archive made since
            // (--archive-missing-only), so the stored one fills in rather than being nulled.
            archiveUrl: result.archiveUrl ?? prev?.archiveUrl ?? null,
            status: result.status,
            contentHash: result.contentHash,
            httpStatus: result.httpStatus,
            error: result.error,
            readVia,
            captureAt
        });
        if (versionRecorded) {
            versions.push({
                sourceId: result.id,
                fetchedAt: result.fetchedAt,
                contentHash: result.contentHash,
                bytes: result.bytes,
                textChars: result.textChars,
                textPath: result.textPath,
                rawPath: result.rawPath,
                archiveUrl: result.archiveUrl,
                etag: result.etag,
                lastModified: result.lastModified,
                diffSummary: result.diff?.summary == null ? (archived ? archivedPrefix.trim() : null) : `${archivedPrefix}${result.diff.summary}`,
                diffSeverity: result.diff?.severity ?? null,
                diffMethod: result.diff?.method ?? 'none',
                diffAdded: result.diff?.added ?? null,
                diffRemoved: result.diff?.removed ?? null,
                readVia,
                captureAt
            });
            if (changed && result.diff?.severity === 'caution') {
                events.push({
                    detectedAt: result.fetchedAt,
                    kind: 'legal-term',
                    subjectType: 'source',
                    subjectId: result.id,
                    field: null,
                    before: prev?.contentHash ?? null,
                    after: result.contentHash,
                    severity: 'caution',
                    summary: `${archivedPrefix}${result.title ?? result.url}: ${result.diff.summary}`,
                    evidence: {
                        ...(archived ?? {}),
                        url: result.url,
                        issuer: result.issuer,
                        foundIn: result.foundIn,
                        versionFetchedAt: result.fetchedAt,
                        contentHash: result.contentHash,
                        textPath: result.textPath,
                        diffExcerpt: (result.diff.unified ?? '').slice(0, 4000)
                    }
                });
            }
        }
        // A quote that stops being verbatim in its source is the strongest signal the watcher has
        // (EVIDENCE.md §2.3); only the TRANSITION into lost is an event, one per claim. A
        // re-baseline raises none: the words it misses are judged by the next run's read.
        const previouslyLost = new Set(Array.isArray(prev?.quotesLost) ? prev.quotesLost : []);
        for (const item of result.rebaselined ? [] : (result.quotes?.lost ?? [])) {
            if (previouslyLost.has(item.id)) continue;
            events.push({
                detectedAt: result.fetchedAt,
                kind: 'quote-lost',
                subjectType: item.kind,
                subjectId: item.id,
                field: item.ref,
                before: null,
                after: result.contentHash,
                severity: 'warning',
                summary: `${archivedPrefix}${item.slug}: the quoted words for ${item.kind} ${item.ref} are no longer in ${result.title ?? result.url}`,
                evidence: {
                    ...(archived ?? {}),
                    url: result.url,
                    issuer: result.issuer,
                    quote: item.quote,
                    versionFetchedAt: result.fetchedAt,
                    contentHash: result.contentHash,
                    textPath: result.textPath ?? prev?.textPath ?? null
                }
            });
        }
        // Only the TRANSITION into `gone` is an event; a citation that has been dead for a month
        // must not write one event per run.
        if (result.status === 'gone' && prev?.status !== 'gone') {
            events.push({
                detectedAt: result.fetchedAt,
                kind: 'document-gone',
                subjectType: 'source',
                subjectId: result.id,
                field: null,
                before: prev?.contentHash ?? null,
                after: null,
                severity: 'warning',
                summary: `${result.title ?? result.url} is gone (${result.reason})`,
                evidence: {
                    url: result.url,
                    issuer: result.issuer,
                    foundIn: result.foundIn,
                    httpStatus: result.httpStatus,
                    reason: result.reason
                }
            });
        }
    }
    return { sources, versions, events };
}
