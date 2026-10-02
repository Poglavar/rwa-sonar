#!/usr/bin/env node
// Dismiss the change events the document watcher raised from reads that were not the document — a
// region block, a script-only shell, an RPC endpoint's info page, a text file hashed as bytes
// (stocks/lib/unreadable.mjs, next-steps.md item 11). Each event is re-judged on the stored copy it
// was raised from; a dismissal is the schema's own mechanism: a `false-alarm` row in
// sonar.review_resolution carrying the reason, and `acknowledged_at` on the event. Nothing is
// deleted. Dry run by default; --apply writes, idempotently (a rerun writes nothing).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { wrapTransaction } from './lib/db-load.mjs';
import { readEnvFile } from './lib/env.mjs';
import { log, logError, logWarn, parseArgs, readJson } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { normaliseUrl } from './lib/sources.mjs';
import {
    buildDismissalSql, classifyRead, dismissalFor, dismissalNote, needsPreviousChars, DISMISS_REVIEWER
} from './lib/unreadable.mjs';
import { checkQuotes, dossierQuotes, looksLikeText, quoteFound, sourceId, storedReading, stripPublisherChrome } from './lib/watch.mjs';

const REPO = join(import.meta.dirname, '..');
const ISSUERS_DIR = join(REPO, 'stocks', 'data', 'issuers');
const DEFAULT_DAYS = 14;
const KINDS = ['legal-term', 'quote-lost'];

function usage() {
    console.log(`dismiss-unreadable-events.mjs — dismiss watcher events raised from reads that were not the document

USAGE
  node stocks/dismiss-unreadable-events.mjs --run [--apply] [--since=<ISO date>] [--include-reader-fixed]

  --run                   Re-judge every unacknowledged ${KINDS.join(' / ')} event since --since against
                          the stored copy it was raised from (stocks/data/sources/<id>/), and print the
                          plan. Without --apply nothing is written (a dry run: SELECTs only).
  --apply                 Write the plan: one 'false-alarm' sonar.review_resolution per event (reviewer
                          "${DISMISS_REVIEWER}", the reason as
                          the note) and acknowledged_at on the event. Idempotent.
  --since=<ISO date>      Default: ${DEFAULT_DAYS} days ago.
  --include-reader-fixed  Also dismiss quote-lost events whose quote IS in the stored copy when read by
                          today's quote reader (an older reader missed it). Off by default: those
                          reads were the document, only our reading of them was wrong.
  --help                  This text.

CATEGORIES
  unreadable-read      the read the event was raised from is unreadable (lib/unreadable.mjs)
  unreadable-baseline  a legal-term diff taken against a stored version that was unreadable
  reader-fixed         (opt-in) the lost quote is in the stored copy after all

Runs where the stored copies are: on the server, from /root/code/rwa-sonar. Needs DATABASE_URL in .env.`);
}

async function queryJson(url, sql, label) {
    const out = await psql(url, sql, label, ['-At']);
    return JSON.parse(out.trim() || 'null');
}

function loadEvents(url, since) {
    return queryJson(url, `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.id), '[]')
  FROM (SELECT e.id, to_char(e.detected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "detectedAt",
               e.kind, e.subject_type AS "subjectType", e.subject_id AS "subjectId", e.field, e.evidence,
               COALESCE(s.issuer_slug, e.evidence->>'issuer') AS "issuerSlug"
          FROM sonar.change_event e
          LEFT JOIN sonar.source s ON s.url = e.evidence->>'url'
         WHERE e.kind IN (${KINDS.map((k) => `'${k}'`).join(', ')})
           AND e.detected_at >= '${since}'::timestamptz
           AND e.acknowledged_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM sonar.review_resolution rr
                            WHERE rr.event_id = e.id AND rr.resolution = 'false-alarm')) t;`, 'change events');
}

/** Every quote the dossiers register, by the normalised URL it is checked against (as the watcher does). */
async function quoteRegistry() {
    const byUrl = new Map();
    for (const file of (await readdir(ISSUERS_DIR)).filter((f) => f.endsWith('.json')).sort()) {
        const dossier = await readJson(join(ISSUERS_DIR, file), null);
        if (!dossier) continue;
        for (const { url, ...item } of dossierQuotes(file.replace(/\.json$/, ''), dossier)) {
            const key = normaliseUrl(url);
            if (!key) continue;
            if (!byUrl.has(key)) byUrl.set(key, []);
            byUrl.get(key).push(item);
        }
    }
    return byUrl;
}

async function maybeRead(path, encoding) {
    try {
        return await readFile(path, encoding);
    } catch {
        return null;
    }
}

/**
 * One stored version as the classifier needs it: the text that was hashed (the .txt), the raw copy
 * beside it (.html / .json; a PDF's text is judged alone), and today's quote reading of the raw.
 */
async function storedVersion(dir, stamp, url) {
    const text = await maybeRead(join(dir, `${stamp}.txt`), 'utf8');
    if (text === null) return null;
    let ext = null;
    let buffer = null;
    for (const candidate of ['html', 'json', 'pdf']) {
        buffer = await maybeRead(join(dir, `${stamp}.${candidate}`));
        if (buffer !== null) {
            ext = candidate;
            break;
        }
    }
    const binary = /^binary \S+ \d+ bytes sha256:[0-9a-f]{64}$/.test(text.trim());
    const payload = buffer !== null && ext !== 'pdf' ? buffer.toString('utf8') : '';
    const notion = ext === 'json' && payload.includes('"recordMap"');
    const kind = ext === 'pdf' ? 'pdf' : ext === 'json' && !notion ? 'api' : 'html';
    let quoteText = text;
    if (!binary && ext !== null && ext !== 'pdf') {
        const reading = storedReading({ rawExt: ext, via: notion ? 'notion' : null, payload });
        if (reading) quoteText = stripPublisherChrome(url, reading.quoteText);
    }
    return { text, raw: binary ? '' : payload, buffer, kind, via: notion ? 'notion' : null, binary, quoteText, ext };
}

function classify(version, quotes, previousChars = null) {
    const check = quotes.length ? checkQuotes(version.quoteText, quotes, { pdf: version.kind === 'pdf' }) : null;
    return classifyRead({
        kind: version.kind, via: version.via, text: version.text, raw: version.raw, binary: version.binary,
        bytesAreText: version.binary && version.buffer !== null && looksLikeText(version.buffer),
        previousChars: needsPreviousChars({ text: version.text, raw: version.raw }) ? previousChars : null,
        quotes: check && { checked: check.checked, lost: check.lost.length }
    });
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const apply = Boolean(flags.apply);
    const includeReaderFixed = Boolean(flags['include-reader-fixed']);
    const since = typeof flags.since === 'string' ? flags.since : new Date(Date.now() - DEFAULT_DAYS * 86_400_000).toISOString().slice(0, 10);
    if (Number.isNaN(Date.parse(since))) throw new Error(`--since must be an ISO date, got ${flags.since}`);
    const env = { ...(await readEnvFile(join(REPO, '.env'))), ...process.env };
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is missing from .env');
    log(`dismiss-unreadable-events: ${apply ? 'APPLY' : 'dry run (nothing is written)'} · db ${describeUrl(env.DATABASE_URL)} · since ${since}`
        + `${includeReaderFixed ? ' · including reader-fixed quote losses' : ''}`);

    const [events, registry] = await Promise.all([loadEvents(env.DATABASE_URL, since), quoteRegistry()]);
    log(`${events.length} unacknowledged ${KINDS.join('/')} event(s) since ${since} without a false-alarm resolution`);

    const plan = [];
    const kept = { readable: 0, noStoredCopy: 0 };
    const noStoredCopy = [];
    const cache = new Map();
    for (const [index, event] of events.entries()) {
        const ev = event.evidence ?? {};
        const url = typeof ev.url === 'string' ? ev.url : null;
        const textPath = typeof ev.textPath === 'string' ? ev.textPath : null;
        const m = textPath ? textPath.match(/^(.*)\/([^/]+)\.txt$/) : null;
        if (!url || !m) {
            kept.noStoredCopy += 1;
            noStoredCopy.push({ id: event.id, url, why: 'the event names no stored copy' });
            continue;
        }
        const [, dirRel, stamp] = m;
        const dir = join(REPO, dirRel);
        const quotes = registry.get(normaliseUrl(url)) ?? [];
        const key = `${dirRel}/${stamp}`;
        if (!cache.has(key)) {
            const version = await storedVersion(dir, stamp, url);
            let previous = null;
            let previousChars = null;
            if (version) {
                const stamps = [...new Set(((await readdir(dir).catch(() => [])) ?? [])
                    .map((f) => f.replace(/\.(txt|html|json|pdf)$/, '')))].sort().filter((s) => s < stamp);
                if (stamps.length) {
                    previous = await storedVersion(dir, stamps[stamps.length - 1], url);
                    previousChars = previous ? previous.text.length : null;
                }
            }
            cache.set(key, {
                version,
                read: version ? classify(version, quotes, previousChars) : null,
                baseline: previous ? classify(previous, quotes) : null
            });
        }
        const { version, read, baseline } = cache.get(key);
        if (!version) {
            kept.noStoredCopy += 1;
            noStoredCopy.push({ id: event.id, url, why: `stored copy ${textPath} is no longer on disk (pruned)` });
            continue;
        }
        const decision = dismissalFor({
            kind: event.kind, read, baseline: event.kind === 'legal-term' ? baseline : null,
            quoteFound: event.kind === 'quote-lost' && typeof ev.quote === 'string' ? quoteFound(version.quoteText, ev.quote, { pdf: version.kind === 'pdf' }) === true : null,
            includeReaderFixed
        });
        if (!decision) {
            kept.readable += 1;
            continue;
        }
        plan.push({
            eventId: event.id, kind: event.kind, detectedAt: event.detectedAt, url, issuerSlug: event.issuerSlug ?? null,
            field: event.field ?? null, category: decision.category, code: decision.code, sourceId: sourceId(url),
            note: dismissalNote({ eventId: event.id, kind: event.kind, category: decision.category, reason: decision.reason, textPath })
        });
        if ((index + 1) % 100 === 0) log(`  ${index + 1}/${events.length} events judged`);
    }

    // The plan, grouped the way it will be read: by category and reason, then by source.
    const byCategory = {};
    for (const p of plan) {
        const k = `${p.category}${p.code ? ` (${p.code})` : ''}`;
        byCategory[k] = (byCategory[k] ?? 0) + 1;
    }
    log(`plan: ${plan.length} event(s) to dismiss · ${kept.readable} raised from a readable copy (kept) · ${kept.noStoredCopy} without a stored copy to judge (kept)`);
    for (const [k, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) log(`  ${k}: ${n}`);
    const bySource = new Map();
    for (const p of plan) {
        const k = `${p.category}${p.code ? ` (${p.code})` : ''} · ${p.url}`;
        if (!bySource.has(k)) bySource.set(k, []);
        bySource.get(k).push(p);
    }
    for (const [k, items] of [...bySource].sort((a, b) => b[1].length - a[1].length)) {
        const kinds = {};
        for (const p of items) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
        const ids = items.map((p) => p.eventId);
        log(`  ${String(items.length).padStart(3)} × ${k} — ${Object.entries(kinds).map(([kk, n]) => `${n} ${kk}`).join(', ')}; `
            + `events ${ids.length > 12 ? `${ids.slice(0, 6).join(', ')} … ${ids.slice(-3).join(', ')}` : ids.join(', ')}`);
    }
    if (plan.length) log(`  e.g. note: ${plan[0].note}`);
    if (noStoredCopy.length) {
        logWarn(`${noStoredCopy.length} event(s) could not be judged (kept as they are):`);
        const urls = {};
        for (const n of noStoredCopy) urls[`${n.url} — ${n.why.replace(/ \S+\.txt /, ' ')}`] = (urls[`${n.url} — ${n.why.replace(/ \S+\.txt /, ' ')}`] ?? 0) + 1;
        for (const [k, n] of Object.entries(urls)) logWarn(`    ${n} × ${k}`);
    }

    if (!apply) {
        log('dry run: nothing written. Re-run with --apply to write these dismissals.');
        return;
    }
    if (plan.length === 0) {
        log('nothing to dismiss');
        return;
    }
    const write = buildDismissalSql(plan);
    const out = await psql(env.DATABASE_URL, wrapTransaction(write.sql), write.table, ['-At', '-F', '|']);
    const [inserted, acknowledged] = out.trim().split('\n').filter((l) => /^\d+\|\d+$/.test(l)).pop()?.split('|') ?? ['?', '?'];
    log(`applied: ${inserted} false-alarm resolution(s) inserted, ${acknowledged} event(s) acknowledged (of ${plan.length} planned; the rest were already done)`);
    log('rebuild the review queue and the change journal to publish the new state');
}

main().catch((error) => {
    logError(error.stack ?? String(error));
    process.exitCode = 1;
});
