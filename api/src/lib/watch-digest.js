// The personal morning digest: when a bound watch is due, which stored changes it covers, the
// message text, and one run over every enabled watch. Pure apart from the injected store, Telegram
// client and operator notifier, so tests drive it with fakes and a real database alike.
//
// Two kinds of change reach a digest: the watch's own snapshot diffs (sonar.stock_watch_event) and
// the watcher's document/on-chain change events for the watched target (sonar.change_event), each
// beside the change judge's reading of it when one exists (stocks/EVIDENCE.md §2.3). Every change
// event is listed whether or not the model read it or called it material: the model assessment is
// printed as such and never decides what a digest contains.

import {
    CHANGE_FROM, CHANGE_ISSUER_SQL, CHANGE_JUDGMENT_JOIN, MODEL_ASSESSMENT_COLUMN, PUBLIC_CHANGE_CONDITION
} from './evidence.js';

const MAX_BULLETS = 20;
const MAX_CHARS = 3800; // Telegram's limit is 4096; leave room for the footer.
// A digest that is hours late is no longer a morning digest; the next day's covers the gap.
const CATCH_UP_HOURS = 3;
// Change-event lines: what changed and the model's one-line reading, each cut visibly.
const CHANGE_TEXT_MAX = 140;
const ASSESSMENT_TEXT_MAX = 180;
// At most this many change events are read per digest; the rest are on watch.html.
export const MAX_TARGET_CHANGES = 50;

// Changes that describe our own review workflow rather than the world. The comparison differ in
// stocks/lib/saved-items.js reports a flip of the legal-evidence review flag; that is an internal
// research state, not a change by an issuer, venue or protocol, so it never reaches a digest.
const INTERNAL = [/: legal-evidence review status changed$/];

export function isDigestMaterial(summary) {
    return typeof summary === 'string' && summary.trim() !== '' && !INTERNAL.some((re) => re.test(summary));
}

/** The calendar date and hour at `nowMs` in `timezone`. */
export function localDay(nowMs, timezone = 'UTC') {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function isDue(watch, nowMs) {
    const { hour } = localDay(nowMs, watch.digest_timezone || 'UTC');
    const target = Number(watch.digest_hour ?? 6);
    return hour >= target && hour < target + CATCH_UP_HOURS;
}

function targetOf(watch) {
    return watch.target && typeof watch.target === 'object' ? watch.target : {};
}

/** The exact thing a watch follows, in words. */
export function targetLabel(watch) {
    const target = targetOf(watch);
    const type = watch.watch_type ?? 'comparison';
    if (type === 'token') return `token ${target.mint}`;
    if (type === 'issuer') return `issuer ${target.issuerSlug}`;
    if (type === 'protocol-market') return `${target.integrationId} market ${target.marketKey} for token ${target.mint}`;
    return `${watch.underlying_ticker ?? target.ticker} comparison of ${(watch.issuer_slugs ?? target.issuers ?? []).join(', ')}`;
}

export function reportUrl(watch, baseUrl) {
    const target = targetOf(watch);
    const type = watch.watch_type ?? 'comparison';
    if ((type === 'token' || type === 'protocol-market') && target.mint) {
        return `${baseUrl}/card.html?mint=${encodeURIComponent(target.mint)}`;
    }
    if (type === 'issuer' && /^[a-z0-9-]+$/.test(target.issuerSlug ?? '')) return `${baseUrl}/issuers/${target.issuerSlug}.html`;
    const ticker = watch.underlying_ticker ?? target.ticker;
    return `${baseUrl}/stocks.html?view=compare&compare=${encodeURIComponent(ticker ?? '')}`;
}

/** `text` cut to `max` characters at a word boundary, with the cut marked. */
function cut(text, max) {
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    const head = clean.slice(0, max - 1);
    const space = head.lastIndexOf(' ');
    return `${space > max * 0.6 ? head.slice(0, space) : head}…`;
}

/**
 * The change judge's reading of one change event, or null when there is nothing to print: only a
 * `valid` judgment with a boolean verdict and a summary counts (an invalid one arrives as
 * `{status:'invalid'}` with no text, exactly as /api/changes sends it, and is shown as no reading).
 */
export function digestAssessment(raw) {
    if (!raw || typeof raw !== 'object' || raw.status !== 'valid') return null;
    if (typeof raw.material !== 'boolean') return null;
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    if (summary === '') return null;
    return { material: raw.material, severity: typeof raw.severity === 'string' ? raw.severity : null, summary };
}

/** Where one change event sits on the public change feed. Material readings open the feed filtered to them. */
export function changeUrl(change, baseUrl) {
    const filter = digestAssessment(change.modelAssessment)?.material === true ? '?material=true' : '';
    return `${baseUrl}/watch.html${filter}#change-${encodeURIComponent(String(change.id))}`;
}

/**
 * One compact line per change event: severity, what changed, and — when the model read it — its
 * one-line summary labelled "model assessment", then the link. Several events of the same change
 * share one judgment; the reading is printed on the first and referred to on the rest.
 */
export function formatChangeLine(change, { baseUrl, seenJudgments = new Set() } = {}) {
    const what = typeof change.summary === 'string' && change.summary.trim() !== ''
        ? change.summary
        : `${change.kind ?? 'change'}${change.field ? ` (${change.field})` : ''}`;
    const parts = [`• ${change.severity ? `[${change.severity}] ` : ''}${cut(what, CHANGE_TEXT_MAX)}`];
    const assessment = digestAssessment(change.modelAssessment);
    if (assessment !== null) {
        const verdict = `${assessment.material ? 'material' : 'not material'}${assessment.severity ? `, ${assessment.severity}` : ''}`;
        const key = change.judgment_id ?? null;
        if (key !== null && seenJudgments.has(key)) {
            parts.push(`model assessment: ${verdict} (same change as above)`);
        } else {
            parts.push(`model assessment: ${verdict} — ${cut(assessment.summary, ASSESSMENT_TEXT_MAX)}`);
            if (key !== null) seenJudgments.add(key);
        }
    }
    parts.push(changeUrl(change, baseUrl));
    return parts.join(' · ');
}

/**
 * The digest text: the exact target, every material change as found (each already names its
 * token, market or issuer and the before/after where one was measured), then every document or
 * on-chain change event recorded for the target with the model's reading beside it where there is
 * one, and the report link.
 */
export function formatDigest(watch, events, { baseUrl, date, changes = [] }) {
    const label = targetLabel(watch);
    const prefix = (watch.watch_type ?? 'comparison') === 'comparison' ? `${watch.underlying_ticker ?? targetOf(watch).ticker} · ` : '';
    const header = [
        `RWA Sonar morning digest · ${date}`,
        watch.title ? `${watch.title} (${label})` : `Watch: ${label}`
    ];
    const footer = [
        '',
        `Report: ${reportUrl(watch, baseUrl)}`,
        `Manage this watch: ${baseUrl}/watch.html · send /stop here to disconnect.`
    ];
    const body = [];
    let length = [...header, ...footer].join('\n').length;
    const fits = (line) => length + line.length + 60 <= MAX_CHARS;
    const push = (line) => {
        body.push(line);
        length += line.length + 1;
    };

    if (events.length > 0) {
        push('');
        push(`${events.length} material change${events.length === 1 ? '' : 's'} since your last digest:`);
        let shown = 0;
        for (const event of events.slice(0, MAX_BULLETS)) {
            const line = `• ${prefix}${event.summary}`;
            if (!fits(line)) break;
            push(line);
            shown += 1;
        }
        if (shown < events.length) push(`…and ${events.length - shown} more on the report page.`);
    }

    if (changes.length > 0) {
        const intro = [
            '',
            `${changes.length} document or on-chain change${changes.length === 1 ? '' : 's'} recorded for this target:`,
            "Every recorded change is listed. A \"model assessment\" is a model's reading of the diff, not a legal "
                + 'conclusion, and never decides what is listed here; the diff is on the linked page.'
        ];
        if (fits(intro.join('\n'))) {
            for (const line of intro) push(line);
            const seenJudgments = new Set();
            let shown = 0;
            for (const change of changes) {
                const line = formatChangeLine(change, { baseUrl, seenJudgments });
                if (!fits(line)) break;
                push(line);
                shown += 1;
            }
            if (shown < changes.length) push(`…and ${changes.length - shown} more on ${baseUrl}/watch.html`);
        } else {
            push('');
            push(`${changes.length} document or on-chain change(s) recorded for this target: ${baseUrl}/watch.html`);
        }
    }
    return [...header, ...body, ...footer].join('\n');
}

/**
 * The public change events that concern one watch's target, detected in (since, until], each with
 * its latest model assessment (the same lateral join and column /api/changes uses) and the id of
 * the judgment behind it. Pure: returns {text, values}. The issuer of a claim or what-if event is
 * the one its evidence names, which /api/changes' issuer filter does not read.
 *
 * - token and protocol-market watches: events on that mint, and events on its issuer's documents;
 * - issuer watches: events whose issuer is that issuer;
 * - comparison watches: events for any of the compared issuers.
 */
export function buildTargetChangesSql(watch, sinceIso, untilIso, { judgments = false } = {}) {
    const values = [];
    const add = (value) => {
        values.push(value);
        return `$${values.length}`;
    };
    const target = targetOf(watch);
    const type = watch.watch_type ?? 'comparison';
    const issuer = `COALESCE(${CHANGE_ISSUER_SQL}, e.evidence->>'issuer')`;
    let match;
    if (type === 'token' || type === 'protocol-market') {
        const mint = add(String(target.mint ?? ''));
        match = `((e.subject_type = 'token' AND e.subject_id = ${mint})
      OR ${issuer} = (SELECT tk.issuer_slug FROM sonar.stock_token tk WHERE tk.mint = ${mint}))`;
    } else if (type === 'issuer') {
        match = `${issuer} = ${add(String(target.issuerSlug ?? ''))}`;
    } else {
        const slugs = (watch.issuer_slugs ?? target.issuers ?? []).map(String);
        match = `${issuer} = ANY(${add(slugs)}::text[])`;
    }
    const column = judgments
        ? `${MODEL_ASSESSMENT_COLUMN},\n    mj.id AS judgment_id`
        : 'NULL::jsonb AS "modelAssessment",\n    NULL::bigint AS judgment_id';
    const text = `SELECT e.id, e.detected_at, e.kind, e.subject_type, e.subject_id, e.field, e.severity, e.summary,
    ${issuer} AS issuer_slug,
    ${column}
  ${CHANGE_FROM}${judgments ? `\n  ${CHANGE_JUDGMENT_JOIN}` : ''}
  WHERE ${PUBLIC_CHANGE_CONDITION}
    AND e.detected_at > ${add(sinceIso)}::timestamptz AND e.detected_at <= ${add(untilIso)}::timestamptz
    AND ${match}
  ORDER BY e.detected_at, e.id
  LIMIT ${MAX_TARGET_CHANGES}`;
    return { text, values };
}

function ms(value) {
    if (value === null || value === undefined) return null;
    const time = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(time) ? time : null;
}

/**
 * Send every due digest once. `store` owns persistence (see pgDigestStore in the job), `telegram`
 * has sendMessage(chatId, text), `decrypt` turns the stored ciphertext into a chat id, and
 * `notifyOperator` receives at most one line-free-of-contents summary when something failed.
 */
export async function runDigests({ store, telegram, decrypt, notifyOperator, nowMs = Date.now(), baseUrl, log = () => {} }) {
    const runIso = new Date(nowMs).toISOString();
    const stats = {
        startedAt: runIso, eligible: 0, due: 0, alreadyHandled: 0, sent: 0, noChange: 0,
        failed: 0, disconnected: 0, failureReasons: {}
    };
    const watches = await store.enabledBoundWatches();
    stats.eligible = watches.length;
    for (const watch of watches) {
        if (!isDue(watch, nowMs)) continue;
        stats.due += 1;
        const { date } = localDay(nowMs, watch.digest_timezone || 'UTC');
        if (!(await store.claim(watch.watch_id, date))) {
            stats.alreadyHandled += 1;
            continue;
        }
        const since = Math.max(...[watch.verified_at, watch.digest_since, watch.last_covered].map(ms).filter((v) => v !== null));
        const sinceIso = new Date(since).toISOString();
        const events = (await store.eventsBetween(watch.watch_id, sinceIso, runIso))
            .filter((event) => isDigestMaterial(event.summary));
        // Listed in full whatever the model made of them; see formatDigest.
        const changes = await store.changesBetween(watch, sinceIso, runIso);
        const changeCount = events.length + changes.length;
        if (changeCount === 0) {
            await store.finish(watch.watch_id, date, { status: 'no-change', changeCount: 0, coveredUntil: runIso });
            stats.noChange += 1;
            continue;
        }
        let chatId;
        try {
            chatId = decrypt(watch.chat_enc);
        } catch {
            chatId = null;
        }
        const result = chatId === null
            ? { ok: false, status: null, reason: 'undecryptable-chat' }
            : await telegram.sendMessage(chatId, formatDigest(watch, events, { baseUrl, date, changes }));
        if (result.ok) {
            await store.finish(watch.watch_id, date, { status: 'sent', changeCount, coveredUntil: runIso });
            stats.sent += 1;
            const assessed = changes.filter((change) => digestAssessment(change.modelAssessment) !== null).length;
            log(`watch ${watch.watch_id}: digest sent (${events.length} watch change(s), ${changes.length} change event(s), `
                + `${assessed} with a model assessment)`);
            continue;
        }
        await store.finish(watch.watch_id, date, { status: 'failed', changeCount, coveredUntil: null, error: result.reason });
        if (result.status === 403) {
            // The person blocked the bot or deleted the chat: that is their /stop, not our failure.
            await store.disconnect(watch.watch_id);
            stats.disconnected += 1;
            log(`watch ${watch.watch_id}: chat refused delivery (403), disconnected`);
            continue;
        }
        stats.failed += 1;
        stats.failureReasons[result.reason] = (stats.failureReasons[result.reason] ?? 0) + 1;
        log(`watch ${watch.watch_id}: digest failed (${result.reason})`);
    }
    stats.finishedAt = new Date().toISOString();
    stats.ok = stats.failed === 0;
    if (!stats.ok && notifyOperator) {
        const reasons = Object.entries(stats.failureReasons).map(([reason, count]) => `${reason} ×${count}`).join(', ');
        await notifyOperator(`RWA Sonar watch digests: ${stats.failed} of ${stats.sent + stats.failed} due digest(s) `
            + `failed (${reasons}). Watch contents and chats are deliberately not included; see logs/rwa-watch-digest-out.log. `
            + 'Failed digests retry on the next hourly run, at most three attempts a day.');
    }
    return stats;
}
