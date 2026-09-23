// The change judge's pure half (EVIDENCE.md §2.3 "LLM judge", next-steps.md iteration item 4): pick
// the document changes worth a model's reading, build the one bounded prompt per change, check what
// the model returned against the words it was shown, and render the SQL that stores the verdict in
// sonar.change_judgment. No network, no filesystem and no clock here; stocks/judge-changes.mjs does
// the IO, the batch and the accounting. A judgment is a MODEL ASSESSMENT shown beside the diff —
// never the only signal — so a quote the model cannot back with the diff's own words makes the
// whole judgment `invalid` rather than letting a paraphrase be stored as a quotation.

import { jsonbLiteral } from './db-load.mjs';
import { quoteFound, quoteKey } from './watch.mjs';

/** Bump when the question, the rubric or the schema changes: it is part of the judgment's identity. */
export const PROMPT_VERSION = 'change-judge-v1';

/** The change-event kinds a model is asked about. Everything else has its own deterministic check. */
export const JUDGED_KINDS = ['legal-term', 'document-gone', 'quote-lost'];

export const SEVERITIES = ['info', 'caution', 'warning', 'critical'];

export const AFFECTS = [
    'holder-rights', 'redemption', 'control-powers', 'fees', 'eligibility', 'custody',
    'disclosure-only', 'cosmetic'
];

/** Change text shown to the model, in characters. More than this is cut and the cut is stated. */
export const CHANGE_TEXT_LIMIT = 12_000;
export const SUMMARY_MAX_WORDS = 80;
const CLAIMS_SHOWN = 25;
const CLAIM_VALUE_CHARS = 300;
const CLAIM_QUOTE_CHARS = 400;

/**
 * The structured-output schema (Messages API `output_config.format`). The API does not enforce
 * numeric ranges or string lengths, so `validateJudgment` checks the 80 words and the 0..1 itself.
 */
export const JUDGMENT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['material', 'severity', 'affects', 'summary', 'quotedChange', 'confidence'],
    properties: {
        material: { type: 'boolean' },
        severity: { type: 'string', enum: SEVERITIES },
        affects: { type: 'array', items: { type: 'string', enum: AFFECTS } },
        summary: { type: 'string' },
        quotedChange: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number' }
    }
};

/**
 * The identity of one change: the source it happened to and the content it produced. A
 * `legal-term` event and the `quote-lost` events raised by the same fetch describe ONE change and
 * are judged once. A `document-gone` has no content, so its identity is the moment it went.
 */
export function dedupeKey(event) {
    const ev = event?.evidence ?? {};
    const source = typeof ev.url === 'string' && ev.url !== '' ? ev.url : `${event.subjectType}:${event.subjectId}`;
    if (event.kind === 'document-gone') return `${source}|gone@${event.detectedAt}`;
    return `${source}|${ev.contentHash ?? `event-${event.id}`}`;
}

const newestFirst = (a, b) => (Date.parse(b.detectedAt) - Date.parse(a.detectedAt)) || (b.id - a.id);

/**
 * Unjudged `legal-term` / `document-gone` / `quote-lost` events, one candidate per change, newest
 * first. `judgedKeys` are the dedupe keys that already carry a valid or invalid judgment for this
 * model and prompt version (an `error` one is retried). The representative event is the
 * `legal-term` one when the change has one (it carries the diff), else the newest; every lost quote
 * of the same change rides along, so the model sees all the words our dossiers relied on.
 */
export function selectCandidates(events, { judgedKeys = new Set() } = {}) {
    const groups = new Map();
    for (const event of Array.isArray(events) ? events : []) {
        if (!JUDGED_KINDS.includes(event?.kind)) continue;
        const key = dedupeKey(event);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(event);
    }
    const out = [];
    for (const [key, members] of groups) {
        if (judgedKeys.has(key)) continue;
        members.sort(newestFirst);
        const representative = members.find((e) => e.kind === 'legal-term') ?? members[0];
        const ev = representative.evidence ?? {};
        out.push({
            key,
            eventId: representative.id,
            eventIds: members.map((e) => e.id).sort((a, b) => a - b),
            kind: representative.kind,
            detectedAt: members[0].detectedAt,
            url: ev.url ?? null,
            issuer: ev.issuer ?? null,
            contentHash: ev.contentHash ?? null,
            // The watcher can raise the same claim's loss more than once against one content hash;
            // the model needs each lost quote once.
            lostQuotes: [...new Map(members
                .filter((e) => e.kind === 'quote-lost' && typeof e.evidence?.quote === 'string')
                .map((e) => [e.subjectId, { claimId: e.subjectId, field: e.field, quote: e.evidence.quote }])).values()],
            event: representative
        });
    }
    return out.sort((a, b) => (Date.parse(b.detectedAt) - Date.parse(a.detectedAt)) || (b.eventId - a.eventId));
}

/** Cut `text` to `limit` characters, saying so. */
export function boundText(text, limit = CHANGE_TEXT_LIMIT) {
    const s = typeof text === 'string' ? text : '';
    if (s.length <= limit) return { text: s, truncated: false, originalChars: s.length };
    return { text: s.slice(0, limit), truncated: true, originalChars: s.length };
}

/**
 * A `limit`-character window of `text` around where `quote` used to be: centred on the first
 * occurrence of the quote's rarest word (6+ letters) that still occurs in the text, so the model
 * sees what replaced the words rather than the page's first 12k characters. No such word: the
 * start of the text.
 */
export function windowAround(text, quote, limit = CHANGE_TEXT_LIMIT) {
    const s = typeof text === 'string' ? text : '';
    if (s.length <= limit) return s;
    const lower = s.toLowerCase();
    const words = [...new Set(String(quote ?? '').toLowerCase().match(/[a-z0-9]{6,}/g) ?? [])];
    let best = null;
    for (const word of words) {
        const first = lower.indexOf(word);
        if (first < 0) continue;
        let count = 0;
        for (let at = first; at >= 0; at = lower.indexOf(word, at + word.length)) count += 1;
        if (best === null || count < best.count) best = { first, count };
    }
    const centre = best?.first ?? 0;
    const start = Math.max(0, Math.min(s.length - limit, centre - Math.floor(limit / 2)));
    return s.slice(start, start + limit);
}

/** The newest stored version strictly before `fetchedAt` (versions in any order). */
export function previousVersion(versions, fetchedAt) {
    const at = Date.parse(fetchedAt);
    return (Array.isArray(versions) ? versions : [])
        .filter((v) => Date.parse(v.fetchedAt) < at)
        .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0] ?? null;
}

/**
 * The change text for one candidate — what the model reads and what its quotes are checked
 * against. The runner supplies what it could read from disk; this decides what is shown.
 *   legal-term:    the line diff (recomputed from the two stored texts when both exist, else the
 *                  watcher's stored excerpt, which it cut at 4000 characters).
 *   quote-lost:    the dossier's lost words as removed lines, then the current text around them.
 *   document-gone: the failure, then the last stored text of the document if we have it.
 */
export function changeTextFor(candidate, { diffText = null, currentText = null, lastText = null } = {}) {
    const ev = candidate.event?.evidence ?? {};
    const lost = candidate.lostQuotes.map((q) => `- ${q.quote}`).join('\n');
    if (candidate.kind === 'legal-term') {
        const recomputed = typeof diffText === 'string' && diffText !== '';
        const diff = recomputed ? diffText : (ev.diffExcerpt ?? '');
        const parts = [diff];
        if (lost) parts.push(`\nWords our dossier quoted from this document that are no longer found verbatim:\n${lost}`);
        return { text: parts.join('\n'), origin: recomputed ? 'recomputed-diff' : 'stored-excerpt' };
    }
    if (candidate.kind === 'quote-lost') {
        const parts = [`Words our dossier quoted from this document that are no longer found verbatim:\n${lost}`];
        if (typeof currentText === 'string' && currentText !== '') {
            // Sized so the whole change text fits the limit and is not cut by `buildPrompt` after all.
            const heading = '\nCurrent document text near where those words were:\n';
            const room = Math.max(1000, CHANGE_TEXT_LIMIT - parts[0].length - heading.length - 1);
            parts.push(`${heading}${windowAround(currentText, candidate.lostQuotes[0]?.quote, room)}`);
        } else {
            parts.push('\n(The current document text is not available to this run.)');
        }
        return { text: parts.join('\n'), origin: currentText ? 'current-text' : 'quotes-only' };
    }
    const failure = `The document is no longer available: ${ev.reason ?? 'unknown reason'}`
        + (ev.httpStatus ? ` (HTTP ${ev.httpStatus})` : '') + '.';
    const parts = [failure];
    if (typeof lastText === 'string' && lastText !== '') parts.push(`\nLast stored text of the document before it went:\n${lastText}`);
    return { text: parts.join('\n'), origin: lastText ? 'last-text' : 'failure-only' };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}… [cut at ${n} chars]` : s);

export const SYSTEM_PROMPT = [
    'You assess changes to documents that a tokenized-securities research site relies on.',
    'Each document is cited in dossiers about tokenized stocks and funds: who issues the token,',
    'what the holder owns, how redemption works, who can freeze or claw back tokens, fees,',
    'eligibility and custody. A watcher detected a change and you are shown exactly what changed.',
    '',
    'Answer one question: does this change alter what a holder owns, what a holder can do, or what',
    'can be done to a holder? Judge only from the change text you are shown. Page chrome, adverts,',
    'related-article lists, navigation, dates and reordering are cosmetic even when they contain',
    'words like "fee" or "custody". A change that only rewords a disclosure without changing a right',
    'or an obligation is disclosure-only.',
    '',
    'Severity:',
    '- info: no effect on holders (cosmetic or unrelated content).',
    '- caution: wording of a disclosure changed; a human should read it, no right visibly changed.',
    '- warning: a holder right, fee, redemption route, eligibility rule, custody arrangement or an',
    '  issuer/admin power changed, or words our dossier relies on disappeared.',
    '- critical: a right was removed, redemption suspended or terminated, a new power to freeze,',
    '  claw back, burn or force-transfer appeared, custody moved, or the governing document is gone.',
    'material is true exactly when affects contains anything other than cosmetic and disclosure-only.',
    '',
    'summary: at most 80 words, plain language for a retail holder, and it must quote (in double',
    'quotes) the changed words it relies on. quotedChange: those fragments copied character for',
    'character from ONE line of the change text each, without the leading "+" or "-" marker; never',
    'paraphrase, never join words from different lines. If nothing in the text supports a quote,',
    'return an empty quotedChange and say so. confidence: 0 to 1, how sure you are of the severity.',
    'If part of the change text was cut, do not guess about the part you did not see.'
].join('\n');

/**
 * The prompt for one candidate. `context.source` is the sonar.source row, `context.claims` the
 * active claims that cite its URL, `context.change` the output of `changeTextFor`. Returns the
 * system and user text plus `changeText` — the bounded text the model saw, which is exactly what
 * its quotes are checked against.
 */
export function buildPrompt(candidate, context = {}) {
    const source = context.source ?? {};
    const change = context.change ?? { text: '', origin: 'none' };
    const bounded = boundText(change.text, context.limit ?? CHANGE_TEXT_LIMIT);
    const claims = Array.isArray(context.claims) ? context.claims : [];
    const foundIn = Array.isArray(source.foundIn) ? source.foundIn : [];

    const lines = [];
    lines.push(`Document: ${source.title ?? '(untitled)'}`);
    lines.push(`URL: ${candidate.url ?? source.url ?? '(unknown)'}`);
    lines.push(`Issuer dossier: ${source.issuerSlug ?? candidate.issuer ?? '(unknown)'}`);
    lines.push(`Change detected: ${candidate.detectedAt} (${candidate.kind}; change text: ${change.origin})`);
    lines.push('');
    lines.push(`Where our dossiers cite this URL (${foundIn.length}):`);
    for (const path of foundIn.slice(0, CLAIMS_SHOWN)) lines.push(`- ${path}`);
    if (foundIn.length > CLAIMS_SHOWN) lines.push(`- … ${foundIn.length - CLAIMS_SHOWN} more not shown`);
    lines.push('');
    lines.push(`What we rely on it for — claims that cite it (${claims.length}):`);
    if (claims.length === 0) lines.push('- none recorded');
    for (const c of claims.slice(0, CLAIMS_SHOWN)) {
        const value = c.value == null ? '' : ` = ${clip(JSON.stringify(c.value), CLAIM_VALUE_CHARS)}`;
        const quote = typeof c.quote === 'string' && c.quote !== '' ? `; quoted: "${clip(c.quote, CLAIM_QUOTE_CHARS)}"` : '';
        lines.push(`- ${c.field}${value}${quote} [${c.status ?? 'unknown'}]`);
    }
    if (claims.length > CLAIMS_SHOWN) lines.push(`- … ${claims.length - CLAIMS_SHOWN} more not shown`);
    lines.push('');
    lines.push('<change>');
    lines.push(bounded.text);
    lines.push('</change>');
    if (bounded.truncated) {
        lines.push(`[Truncated: the change text above is the first ${bounded.text.length} of `
            + `${bounded.originalChars} characters; the rest was not shown to you.]`);
    }
    lines.push('');
    lines.push('Does this change alter what a holder owns, can do, or can have done to them? '
        + 'Answer in the required JSON.');
    return { system: SYSTEM_PROMPT, user: lines.join('\n'), changeText: bounded.text, truncated: bounded.truncated };
}

/**
 * The change text as blocks of words a quote may come from: consecutive lines with the same diff
 * marker (`+` added, `-` removed, anything else context or plain text), markers stripped, hunk
 * headers dropped. A wrapped paragraph stays one block; a fragment stitched from a removed line and
 * an added one spans two blocks and so is not verbatim.
 */
export function changeBlocks(changeText) {
    const blocks = [];
    let current = null;
    for (const line of String(changeText ?? '').split('\n')) {
        if (line.startsWith('@@')) {
            current = null;
            continue;
        }
        const marker = line[0] === '+' || line[0] === '-' ? line[0] : ' ';
        const words = marker === ' ' ? line.replace(/^ /, '') : line.slice(1).replace(/^ /, '');
        if (!current || current.marker !== marker) {
            current = { marker, lines: [] };
            blocks.push(current);
        }
        current.lines.push(words);
    }
    return blocks.map((b) => b.lines.join('\n'));
}

/** true when `fragment` occurs verbatim (modulo whitespace, case and quote style) in one block. */
export function fragmentInChange(fragment, changeText) {
    if (typeof fragment !== 'string' || quoteKey(fragment) === '') return false;
    return changeBlocks(changeText).some((block) => {
        const verdict = quoteFound(block, fragment);
        // `quoteFound` declines fragments too short to check (null); for those a plain keyed
        // substring test is still verbatim, just less distinctive.
        return verdict === null ? quoteKey(block).includes(quoteKey(fragment)) : verdict;
    });
}

const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Check a parsed model answer. Returns `{ status: 'valid' | 'invalid', judgment, reasons,
 * rejectedQuotes }`. `judgment.quotedChange` only ever holds fragments found verbatim in the change
 * text; anything else is moved to `rejectedQuotes` and makes the judgment invalid, so a paraphrase
 * is never stored as a quotation.
 */
export function validateJudgment(j, changeText, { kind = null } = {}) {
    const reasons = [];
    if (j === null || typeof j !== 'object' || Array.isArray(j)) {
        return { status: 'invalid', judgment: null, reasons: ['not a JSON object'], rejectedQuotes: [] };
    }
    if (typeof j.material !== 'boolean') reasons.push('material is not a boolean');
    if (!SEVERITIES.includes(j.severity)) reasons.push(`severity ${JSON.stringify(j.severity)} is not one of ${SEVERITIES.join('/')}`);
    const affects = Array.isArray(j.affects) ? j.affects : [];
    if (!Array.isArray(j.affects) || affects.length === 0) reasons.push('affects is empty');
    const unknown = affects.filter((a) => !AFFECTS.includes(a));
    if (unknown.length) reasons.push(`affects has unknown value(s): ${unknown.join(', ')}`);
    const summary = typeof j.summary === 'string' ? j.summary.trim() : '';
    if (summary === '') reasons.push('summary is empty');
    else if (wordCount(summary) > SUMMARY_MAX_WORDS) reasons.push(`summary is ${wordCount(summary)} words (max ${SUMMARY_MAX_WORDS})`);
    const confidence = j.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        reasons.push('confidence is not a number in 0..1');
    }
    const substantive = affects.some((a) => a !== 'cosmetic' && a !== 'disclosure-only');
    if (typeof j.material === 'boolean' && affects.length && j.material !== substantive) {
        reasons.push(`material=${j.material} contradicts affects [${affects.join(', ')}]`);
    }

    const quoted = Array.isArray(j.quotedChange) ? j.quotedChange : [];
    if (!Array.isArray(j.quotedChange)) reasons.push('quotedChange is not an array');
    const kept = [];
    const rejectedQuotes = [];
    for (const fragment of quoted) {
        if (fragmentInChange(fragment, changeText)) kept.push(fragment);
        else rejectedQuotes.push(fragment);
    }
    if (rejectedQuotes.length) {
        reasons.push(`${rejectedQuotes.length} quotedChange fragment(s) not found verbatim in the change text`);
    }
    // A material judgment must rest on words. A vanished document has none that changed.
    if (j.material === true && kind !== 'document-gone' && kept.length === 0) {
        reasons.push('material judgment without a verbatim quote from the change');
    }

    return {
        status: reasons.length ? 'invalid' : 'valid',
        judgment: {
            material: typeof j.material === 'boolean' ? j.material : null,
            severity: SEVERITIES.includes(j.severity) ? j.severity : null,
            affects: affects.filter((a) => AFFECTS.includes(a)),
            summary: summary || null,
            quotedChange: kept,
            confidence: typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : null
        },
        reasons,
        rejectedQuotes
    };
}

/** Parse the model's text as JSON; a refusal or a cut-off answer is an invalid judgment, not a crash. */
export function parseJudgmentText(text) {
    try {
        return { value: JSON.parse(text), error: null };
    } catch (err) {
        return { value: null, error: `model output is not JSON: ${err.message}` };
    }
}

/** Rough token count when the count-tokens endpoint is not available: characters / 4. */
export function estimateTokens(text) {
    return Math.ceil(String(text ?? '').length / 4);
}

/**
 * Dollars for `inputTokens` + `outputTokens` at `rate` ({ input, output } USD per million, ONLINE
 * rates as in agents/lib/llm-cost/rates.json); batch halves it, as the shared library does.
 */
export function estimateCost({ inputTokens, outputTokens }, rate, { batch = true } = {}) {
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    if (!rate || typeof rate.input !== 'number' || typeof rate.output !== 'number') {
        throw new Error('estimateCost needs a rate with numeric input and output');
    }
    return ((n(inputTokens) * rate.input + n(outputTokens) * rate.output) / 1e6) * (batch ? 0.5 : 1);
}

/** A batch custom_id (Anthropic: ^[a-zA-Z0-9_-]{1,64}$) for one candidate. */
export function customIdFor(candidate) {
    return `evt-${candidate.eventId}`;
}

/** The Message Batches request for one candidate. */
export function batchRequest(candidate, prompt, { model, maxTokens, effort }) {
    return {
        custom_id: customIdFor(candidate),
        params: {
            model,
            max_tokens: maxTokens,
            system: prompt.system,
            messages: [{ role: 'user', content: prompt.user }],
            thinking: { type: 'adaptive' },
            output_config: { effort, format: { type: 'json_schema', schema: JUDGMENT_SCHEMA } }
        }
    };
}

/**
 * A batch still open this long after submission is treated as stalled: the next run cancels it
 * (unprocessed requests are not billed) and judges that run's items directly, so one stuck batch
 * cannot block every later daily run. One batch sat 8.5 h unprocessed on 2026-09-23; a normal one
 * finished in about 45 minutes.
 */
export const STALLED_BATCH_MS = 12 * 3600_000;

/** Is this open checkpoint older than STALLED_BATCH_MS? An unreadable submission time is not stalled. */
export function isStalledBatch(checkpoint, nowMs) {
    const submitted = Date.parse(checkpoint?.submittedAt ?? '');
    return !checkpoint?.done && Number.isFinite(submitted) && nowMs - submitted > STALLED_BATCH_MS;
}

/**
 * An online Messages response shaped like the shared batch collector's item
 * (`{ customId, message, text, usage }`), so the --direct fallback feeds the same judgmentRow.
 * Anthropic reports input and cache tokens disjoint, which is what computeCost expects.
 */
export function directResultItem(customId, message) {
    return {
        customId,
        message,
        text: Array.isArray(message?.content) ? message.content.map((part) => part.text || '').join('') : '',
        usage: {
            input_tokens: message?.usage?.input_tokens ?? 0,
            output_tokens: message?.usage?.output_tokens ?? 0,
            cache_read_input_tokens: message?.usage?.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: message?.usage?.cache_creation_input_tokens ?? 0
        }
    };
}

/**
 * One sonar.change_judgment row from a collected batch item. `item` is what the shared library's
 * collectBatch yields ({ customId, text, usage, costUsd } or { customId, error }). An errored item
 * is billed nothing by the Batch API, so its cost is 0 and it is retried by the next run.
 */
export function judgmentRow({ candidate, changeText, item, model, batchId, promptVersion = PROMPT_VERSION }) {
    const base = {
        changeEventId: candidate.eventId,
        coversEventIds: candidate.eventIds,
        dedupeKey: candidate.key,
        model,
        promptVersion,
        batchId,
        inputTokens: item.usage?.input_tokens ?? 0,
        outputTokens: item.usage?.output_tokens ?? 0,
        cacheReadTokens: item.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: item.usage?.cache_creation_input_tokens ?? 0
    };
    if (item.error) {
        return { ...base, status: 'error', costUsd: 0, reasons: [String(item.error)], rejectedQuotes: [], judgment: null };
    }
    if (typeof item.costUsd !== 'number' || !Number.isFinite(item.costUsd)) {
        throw new Error(`no cost for ${item.customId}: refusing to store a judgment with an unknown price`);
    }
    const stop = item.message?.stop_reason;
    const parsed = parseJudgmentText(item.text ?? '');
    const checked = parsed.error
        ? { status: 'invalid', judgment: null, reasons: [parsed.error], rejectedQuotes: [] }
        : validateJudgment(parsed.value, changeText, { kind: candidate.kind });
    const reasons = stop && stop !== 'end_turn' ? [`stop_reason ${stop}`, ...checked.reasons] : checked.reasons;
    return {
        ...base,
        status: reasons.length ? 'invalid' : 'valid',
        costUsd: item.costUsd,
        reasons,
        rejectedQuotes: checked.rejectedQuotes,
        judgment: checked.judgment
    };
}

/**
 * Turn collected batch items (any async iterable, normally the shared library's collectBatch) into
 * judgment rows, one at a time so the caller can store each before the next arrives. `pending`
 * maps custom_id -> { candidate, changeText }; an item with an unknown custom_id is an error, not
 * something to guess about.
 */
export async function* judgmentRows(items, pending, { model, batchId, promptVersion = PROMPT_VERSION }) {
    for await (const item of items) {
        const entry = pending[item.customId];
        if (!entry) throw new Error(`batch ${batchId} returned unknown custom_id ${item.customId}`);
        yield judgmentRow({ candidate: entry.candidate, changeText: entry.changeText, item, model, batchId, promptVersion });
    }
}

/**
 * Upsert judgment rows. Keyed on (change_event_id, model, prompt_version); a stored `error` row is
 * replaced by a later attempt, a stored valid/invalid one is left alone — re-judging the same change
 * with the same prompt would only spend money.
 */
export function buildJudgmentSql(rows, { tag = 'sonar' } = {}) {
    const items = (Array.isArray(rows) ? rows : []).map((r) => ({
        ...r,
        material: r.judgment?.material ?? null,
        severity: r.judgment?.severity ?? null,
        affects: r.judgment?.affects ?? [],
        summary: r.judgment?.summary ?? null,
        quotedChange: r.judgment?.quotedChange ?? [],
        confidence: r.judgment?.confidence ?? null
    }));
    const sql = `WITH doc AS (SELECT ${jsonbLiteral({ rows: items }, tag)} AS d),\n`
        + "     src AS (SELECT x.r FROM doc, jsonb_array_elements(d->'rows') AS x(r))\n"
        + 'INSERT INTO sonar.change_judgment AS j\n'
        + '       (change_event_id, covers_event_ids, dedupe_key, model, prompt_version, material, severity,\n'
        + '        affects, summary, quoted_change, rejected_quotes, invalid_reasons, confidence, status,\n'
        + '        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, batch_id)\n'
        + "SELECT (r->>'changeEventId')::bigint, r->'coversEventIds', r->>'dedupeKey', r->>'model',\n"
        + "       r->>'promptVersion', (r->>'material')::boolean, r->>'severity', r->'affects', r->>'summary',\n"
        + "       r->'quotedChange', r->'rejectedQuotes', r->'reasons', (r->>'confidence')::numeric, r->>'status',\n"
        + "       (r->>'inputTokens')::int, (r->>'outputTokens')::int, (r->>'cacheReadTokens')::int,\n"
        + "       (r->>'cacheCreationTokens')::int, (r->>'costUsd')::numeric, r->>'batchId'\n"
        + '  FROM src\n'
        + 'ON CONFLICT (change_event_id, model, prompt_version) DO UPDATE SET\n'
        + '       covers_event_ids = EXCLUDED.covers_event_ids, dedupe_key = EXCLUDED.dedupe_key,\n'
        + '       material = EXCLUDED.material, severity = EXCLUDED.severity, affects = EXCLUDED.affects,\n'
        + '       summary = EXCLUDED.summary, quoted_change = EXCLUDED.quoted_change,\n'
        + '       rejected_quotes = EXCLUDED.rejected_quotes, invalid_reasons = EXCLUDED.invalid_reasons,\n'
        + '       confidence = EXCLUDED.confidence, status = EXCLUDED.status,\n'
        + '       input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,\n'
        + '       cache_read_tokens = EXCLUDED.cache_read_tokens,\n'
        + '       cache_creation_tokens = EXCLUDED.cache_creation_tokens, cost_usd = EXCLUDED.cost_usd,\n'
        + '       batch_id = EXCLUDED.batch_id, updated_at = now()\n'
        + " WHERE j.status = 'error';\n";
    return { table: 'sonar.change_judgment', rows: items.length, sql };
}
