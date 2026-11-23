// One regulator source's run, as two steps that cannot hold each other up (stocks/watch-regulators.mjs):
// INGEST fetches the source, keeps what it sent and stores every notice (sonar.regulator_notice)
// before anything is matched; PROCESSING matches this run's notices plus the stored backlog, and
// writes the check row, the matches, the events and the notices' matched_at in one transaction.
// A processing failure never undoes, skips or delays the ingest — its notices wait, unmatched, for
// the next run. All IO is passed in, so both steps are unit tested with failures injected
// (regulator-run.test.js).

import {
    buildCheckSql, buildMarkMatchedSql, buildMatchUpsertSql, checkVerdict, foldMatches, matchNotices, withBacklog
} from './regulators.mjs';
import { buildChangeEventSql } from './watch.mjs';

/**
 * io: {
 *   replayPending(): {inserted, failed, errors[]}   reads kept by earlier runs, stored first (optional)
 *   collect(): {notices, raw, requests}              throws err.stage 'fetch' | 'parse', err.raw
 *   keepRing(raw)                                    the recent-raw ring (optional)
 *   keepPending(raw): {path}                         keep a read whose notices are not stored
 *   store(notices): {inserted, touched}              null when there is no database
 * }
 * Returns { notices, error, stage, errors: [{step, message}], stored, inserted, requests }.
 */
export async function ingestSource(io) {
    const errors = [];
    // Keeping raw on disk can itself fail (a full disk): recorded, never allowed to stop the store.
    const keep = async (fn, raw) => {
        try {
            return await fn(raw);
        } catch (err) {
            errors.push({ step: 'keep-raw', message: err.message });
            return { path: '(not kept)' };
        }
    };
    let inserted = 0;
    if (io.replayPending) {
        const replayed = await io.replayPending();
        inserted += replayed.inserted ?? 0;
        if (replayed.failed) errors.push({ step: 'replay-pending', message: `${replayed.failed} kept read(s) still not stored: ${replayed.errors?.[0] ?? '?'}` });
    }
    let collected = null;
    let error = null;
    let stage = null;
    try {
        collected = await io.collect();
    } catch (err) {
        error = err.message;
        stage = err.stage === 'parse' ? 'parse' : 'fetch';
        if (stage === 'parse' && err.raw?.length) {
            // The source answered and our parser failed: what it sent is kept and replayed next run.
            const kept = await keep(io.keepPending, err.raw);
            error += ` (raw kept for reprocessing: ${kept.path})`;
        }
        errors.push({ step: stage, message: err.message });
        if (err.raw?.length && io.keepRing) await keep(io.keepRing, err.raw);
    }
    const notices = collected?.notices ?? [];
    let stored = null;
    if (collected) {
        if (io.keepRing) await keep(io.keepRing, collected.raw);
        if (io.store && notices.length) {
            try {
                stored = await io.store(notices);
                inserted += stored?.inserted ?? 0;
            } catch (err) {
                const kept = await keep(io.keepPending, collected.raw);
                errors.push({ step: 'store-notices', message: `${err.message} (raw kept for reprocessing: ${kept.path})` });
            }
        }
    }
    return { notices, error, stage, errors, stored, inserted, requests: collected?.requests ?? null, note: collected?.note ?? null };
}

/**
 * input: { source, notices, error, stateError, prev, baseline, names, previous, detectedAt, review }
 * io: { readBacklog(): [{notice, contentHash}] | null, write(statements[]) | null }
 * Returns { verdict, rows, events, error: {step, message} | null, backlogCount }. Nothing thrown.
 */
export async function processSource(input, io) {
    const { source, notices, error, stateError, prev, baseline, names, previous, detectedAt, review } = input;
    if (stateError) return { verdict: null, rows: [], events: [], error: { step: 'read-state', message: stateError }, backlogCount: 0 };
    let step = 'read-backlog';
    try {
        const backlog = io.readBacklog ? await io.readBacklog() : [];
        const toMatch = withBacklog(notices, backlog);
        const backlogCount = toMatch.length - notices.length;
        step = 'match';
        const matches = toMatch.length ? matchNotices(toMatch, names) : [];
        const verdict = checkVerdict(source, { prev, error, notices, matches: matches.length, runAt: detectedAt });
        // foldMatches records each new match in `previous`; on a failed write those are taken back.
        const before = new Map(previous);
        const { rows, events } = foldMatches(matches, { regulator: source, previous, baseline, detectedAt, review });
        if (io.write) {
            step = 'record-matches';
            const statements = [buildCheckSql([verdict]).sql];
            if (rows.length) statements.push(buildMatchUpsertSql(rows).sql);
            if (events.length) statements.push(buildChangeEventSql(events).sql);
            if (toMatch.length) statements.push(buildMarkMatchedSql(source.id, toMatch, { matchedAt: detectedAt }).sql);
            try {
                await io.write(statements);
            } catch (err) {
                previous.clear();
                for (const [k, v] of before) previous.set(k, v);
                throw err;
            }
        }
        return { verdict, rows, events, error: null, backlogCount };
    } catch (err) {
        return { verdict: null, rows: [], events: [], error: { step, message: err.message }, backlogCount: 0 };
    }
}
