// One SEC litigation feed task of the case-law watcher (stocks/watch-caselaw.mjs), as two steps that
// cannot hold each other up. INGEST fetches the feed, parses it and stores EVERY item in
// sonar.regulator_notice (source = the feed id) before anything is matched — until 2026-11-23 only
// the items naming a watched party were kept, and the feed shows only its newest 25. PROCESSING
// matches this run's items plus any stored ones no run has matched yet against the watched
// phrases and writes the cases, the feed's run row, the events and the items' matched_at in one
// transaction. All IO is passed in (caselaw-feed.test.js injects the failures).

import { buildCaseUpsertSql, buildQueryRunSql, foldHits, matchSecItems, parseSecFeed, secFeedGap } from './caselaw.mjs';
import { buildMarkMatchedSql, noticeRows, withBacklog } from './regulators.mjs';
import { buildChangeEventSql } from './watch.mjs';

/** How a feed item is stored in sonar.regulator_notice: its release number (or link) is the id, its filing date the date. */
export const FEED_ITEM_KEYS = { idOf: (item) => item.externalId, dateOf: (item) => item.dateFiled };

/** A feed's items as notice-store rows. */
export function feedItemRows(feed, items) {
    return noticeRows(feed.id, items, FEED_ITEM_KEYS);
}

/** Parse a feed body; a body with no item is a parse failure (the feed format changed, or an error page). */
export function parseFeedItems(xml, feed) {
    const items = parseSecFeed(xml, feed);
    if (items.length === 0) throw new Error(`${feed.url}: no <item> parsed — the feed format changed`);
    return items;
}

/**
 * The items that name a watched phrase, one record per item attributed to every phrase it names,
 * folded into the stored cases (lib/caselaw.mjs foldHits).
 */
export function foldFeedItems(items, { queries, previous, baseline, detectedAt, review }) {
    const byKey = new Map();
    for (const { record, query } of matchSecItems(items, queries)) {
        const entry = byKey.get(record.key) ?? { record, phrases: [], issuers: new Set(), origins: [] };
        entry.phrases.push(query.phrase);
        query.issuers.forEach((i) => entry.issuers.add(i));
        entry.origins.push(...query.origins);
        if (record.matchLevel === 'caption') entry.record = record;
        byKey.set(record.key, entry);
    }
    const rows = [];
    const events = [];
    for (const { record, phrases, issuers } of byKey.values()) {
        const folded = foldHits([record], {
            previous, query: { phrase: phrases.join(' | '), issuers: [...issuers].sort() }, baseline, detectedAt, review
        });
        rows.push(...folded.rows);
        events.push(...folded.events);
    }
    return { rows, events };
}

/**
 * io: {
 *   replayPending(): {inserted, failed, errors[]}   kept feed bodies, parsed and stored first (optional)
 *   fetch(): xml                                     throws on a failed request
 *   keepPending(xml): {path}                         keep a body whose items are not stored
 *   store(rows): {inserted}                          null without a database
 *   readBacklog(): [{notice}]                        null without a database
 *   write(statements[])                              null without a database
 * }
 * input: { feed, queries, previous, prevRun, baseline, detectedAt, review, stateError }
 * Returns { items, inserted, ingestError, processingError, rows, events, gap, backlogCount }; never throws.
 */
export async function runFeedTask(input, io) {
    const { feed, queries, previous, prevRun, baseline, detectedAt, review, stateError } = input;
    const out = { items: [], inserted: 0, ingestError: null, processingError: null, rows: [], events: [], gap: false, backlogCount: 0 };
    const keep = async (xml) => {
        try {
            return (await io.keepPending(xml)).path;
        } catch (err) {
            return `(not kept: ${err.message})`;
        }
    };

    // --- ingest
    if (io.replayPending) {
        const replayed = await io.replayPending();
        out.inserted += replayed.inserted ?? 0;
        if (replayed.failed) out.ingestError = { step: 'replay-pending', message: `${replayed.failed} kept feed body(ies) still not stored: ${replayed.errors?.[0] ?? '?'}` };
    }
    let xml;
    try {
        xml = await io.fetch();
    } catch (err) {
        out.ingestError = { step: 'fetch', message: err.message };
        return out;
    }
    try {
        out.items = parseFeedItems(xml, feed);
    } catch (err) {
        out.ingestError = { step: 'parse', message: `${err.message} (raw kept for reprocessing: ${await keep(xml)})` };
        return out;
    }
    if (io.store) {
        try {
            out.inserted += (await io.store(feedItemRows(feed, out.items)))?.inserted ?? 0;
        } catch (err) {
            out.ingestError = { step: 'store-notices', message: `${err.message} (raw kept for reprocessing: ${await keep(xml)})` };
        }
    }
    out.gap = secFeedGap(out.items, prevRun?.lastRunAt ?? null);

    // --- processing
    if (stateError) {
        out.processingError = { step: 'read-state', message: stateError };
        return out;
    }
    let step = 'read-backlog';
    try {
        const backlog = io.readBacklog ? await io.readBacklog() : [];
        const toMatch = withBacklog(out.items, backlog, FEED_ITEM_KEYS);
        out.backlogCount = toMatch.length - out.items.length;
        step = 'match';
        const before = new Map(previous);
        const { rows, events } = foldFeedItems(toMatch, { queries, previous, baseline, detectedAt, review });
        if (io.write) {
            step = 'record-cases';
            const statements = [];
            if (rows.length) statements.push(buildCaseUpsertSql(rows).sql);
            statements.push(buildQueryRunSql([{ source: feed.id, query: '(feed)', issuers: [], origins: [], runAt: detectedAt, total: out.items.length }]).sql);
            if (events.length) statements.push(buildChangeEventSql(events).sql);
            statements.push(buildMarkMatchedSql(feed.id, toMatch, { matchedAt: detectedAt, idOf: FEED_ITEM_KEYS.idOf }).sql);
            try {
                await io.write(statements);
            } catch (err) {
                // foldHits recorded the new cases in `previous`: take them back, so the next run still sees them as new.
                previous.clear();
                for (const [k, v] of before) previous.set(k, v);
                throw err;
            }
        }
        out.rows = rows;
        out.events = events;
    } catch (err) {
        out.processingError = { step, message: err.message };
    }
    return out;
}
