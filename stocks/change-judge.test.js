// Unit tests for stocks/lib/change-judge.mjs — the change judge's decisions: which changes a model
// is asked about (one per source + content hash, never one already judged), what the prompt shows
// (a bounded change text that SAYS when it was cut, the dossier fields and claims that cite the
// URL), what a model answer must satisfy (schema, 80 words, and quotes that are verbatim in the
// change — a paraphrase makes the judgment invalid), and the whole submit -> collect -> validate ->
// SQL path through the shared LLM layer (agents/lib/llm-cost/llm.mjs createLlm) with a fake
// Anthropic client: the layer's default model is what is submitted and what the cost is priced at.
// The legal-term diff below is the real one the watcher stored for event 189 (tekedia.com,
// 2026-09-22), trimmed: a "fee" keyword hit that is a course price list — cosmetic to a holder.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    CHANGE_TEXT_LIMIT, JUDGMENT_SCHEMA, PROMPT_VERSION, boundText, buildJudgmentSql,
    buildPrompt, changeTextFor, customIdFor, dedupeKey, estimateTokens, fragmentInChange,
    directItem, isStalledBatch, judgeRequest, judgmentRow, judgmentRows, previousVersion, selectCandidates, validateJudgment, windowAround
} from './lib/change-judge.mjs';

const DDL = readFileSync(new URL('../db/2026-09-23-sonar-change-judgment.sql', import.meta.url), 'utf8');

const TEKEDIA_DIFF = [
    '@@ -119,15 +119,15 @@',
    ' Products',
    '+Nigeria Capital Market Masterclass (Oct 5 – Nov 28, 2026) | $500 or N350,000',
    ' Tekedia Mini-MBA Annual Package | $340 or N180,000',
    '-Tekedia Capital Membership Fee for 4 Investment Cycles | $1000 or N1,000,000',
    '+Tekedia Capital Membership Fee for 4 Investment Cycles | $1000 or N1,000,000'
].join('\n');

const REDEMPTION_DIFF = [
    '@@ -40,3 +40,3 @@',
    ' Redemption',
    '-Holders may redeem tokens for the underlying shares at any time, subject to a fee of 0.5%.',
    '+Redemptions are suspended until further notice. The issuer may freeze any wallet at its discretion.'
].join('\n');

function legalTerm(id, { url = 'https://example.com/terms', hash = 'h1', at = '2026-09-22T10:00:00Z', diff = REDEMPTION_DIFF } = {}) {
    return {
        id, kind: 'legal-term', subjectType: 'source', subjectId: 'abc123', field: null, detectedAt: at,
        severity: 'caution', summary: 'terms changed',
        evidence: { url, issuer: 'acme', contentHash: hash, textPath: 'stocks/data/sources/abc123/x.txt', diffExcerpt: diff, versionFetchedAt: at }
    };
}
function quoteLost(id, { url = 'https://example.com/terms', hash = 'h1', at = '2026-09-22T10:00:00Z', claim = 'acme:redemption:1', quote = 'Holders may redeem tokens for the underlying shares at any time' } = {}) {
    return {
        id, kind: 'quote-lost', subjectType: 'claim', subjectId: claim, field: 'redemption', detectedAt: at,
        severity: 'warning', summary: 'quote lost', evidence: { url, issuer: 'acme', quote, contentHash: hash, textPath: 'x.txt' }
    };
}
function gone(id, { url = 'https://example.com/gone', at = '2026-09-21T10:00:00Z' } = {}) {
    return {
        id, kind: 'document-gone', subjectType: 'source', subjectId: 'def456', field: null, detectedAt: at,
        severity: 'warning', summary: 'gone', evidence: { url, issuer: 'acme', reason: 'http-404', httpStatus: 404 }
    };
}

const GOOD = {
    material: true,
    severity: 'critical',
    affects: ['redemption', 'control-powers'],
    summary: 'Redemption was switched off: the page now says "Redemptions are suspended until further notice" and adds that the issuer "may freeze any wallet at its discretion".',
    quotedChange: ['Redemptions are suspended until further notice', 'The issuer may freeze any wallet at its discretion'],
    confidence: 0.9
};

describe('selectCandidates', () => {
    test('keeps only judged kinds, newest first', () => {
        const events = [
            legalTerm(1, { hash: 'a', at: '2026-09-20T00:00:00Z' }),
            { ...legalTerm(2, { hash: 'b' }), kind: 'supply' },
            gone(3, { at: '2026-09-21T00:00:00Z' }),
            legalTerm(4, { hash: 'c', at: '2026-09-22T00:00:00Z' })
        ];
        expect(selectCandidates(events).map((c) => c.eventId)).toEqual([4, 3, 1]);
    });

    test('one candidate per source + content hash; the legal-term event represents it, lost quotes ride along once', () => {
        const events = [
            quoteLost(10, { claim: 'acme:a:1', quote: 'first quote words here' }),
            legalTerm(11),
            quoteLost(12, { claim: 'acme:b:2', quote: 'second quote words here' }),
            quoteLost(13, { claim: 'acme:a:1', quote: 'first quote words here' }),
            legalTerm(14, { hash: 'h2', at: '2026-09-22T11:00:00Z' })
        ];
        const out = selectCandidates(events);
        expect(out.map((c) => c.eventId)).toEqual([14, 11]);
        const merged = out[1];
        expect(merged.kind).toBe('legal-term');
        expect(merged.eventIds).toEqual([10, 11, 12, 13]);
        expect(merged.lostQuotes.map((q) => q.claimId)).toEqual(['acme:a:1', 'acme:b:2']);
    });

    test('an event dismissed as a false alarm (a read that was not the document) never reaches the model', () => {
        const events = [
            { ...quoteLost(20, { claim: 'acme:a:1', quote: 'first quote words here' }), dismissed: true },
            { ...legalTerm(21, { hash: 'geo', at: '2026-09-19T05:19:06Z' }), dismissed: true },
            legalTerm(22, { hash: 'real', at: '2026-09-22T00:00:00Z' }),
            { ...legalTerm(23, { hash: 'x', at: '2026-09-23T00:00:00Z' }), dismissed: false }
        ];
        expect(selectCandidates(events).map((c) => c.eventId)).toEqual([23, 22]);
        // A dismissed quote loss does not ride along with an open event of the same change either.
        const change = [{ ...quoteLost(30, { claim: 'acme:b:2', quote: 'second quote words here' }), dismissed: true }, legalTerm(31)];
        const [candidate] = selectCandidates(change);
        expect(candidate.eventIds).toEqual([31]);
        expect(candidate.lostQuotes).toEqual([]);
    });

    test('a change already judged (by dedupe key) is not selected again', () => {
        const events = [legalTerm(1), legalTerm(2, { hash: 'h2' })];
        const judgedKeys = new Set([dedupeKey(events[0])]);
        expect(selectCandidates(events, { judgedKeys }).map((c) => c.eventId)).toEqual([2]);
    });

    test('two document-gone transitions of one URL are two changes', () => {
        const a = gone(1, { at: '2026-09-01T00:00:00Z' });
        const b = gone(2, { at: '2026-09-20T00:00:00Z' });
        expect(dedupeKey(a)).not.toBe(dedupeKey(b));
        expect(selectCandidates([a, b])).toHaveLength(2);
    });
});

describe('prompt', () => {
    const source = {
        title: 'Acme token terms', url: 'https://example.com/terms', issuerSlug: 'acme',
        foundIn: ['acme:documents[0].url', 'acme:redemption.url']
    };
    const claims = [{ field: 'redemption.available', value: true, quote: 'Holders may redeem tokens', status: 'confirmed' }];

    test('shows source, the fields and claims citing the URL, the change and the exact question', () => {
        const [candidate] = selectCandidates([legalTerm(1)]);
        const change = changeTextFor(candidate, {});
        const p = buildPrompt(candidate, { source, claims, change });
        expect(p.user).toContain('Document: Acme token terms');
        expect(p.user).toContain('- acme:redemption.url');
        expect(p.user).toContain('- redemption.available = true; quoted: "Holders may redeem tokens" [confirmed]');
        expect(p.user).toContain('+Redemptions are suspended until further notice.');
        expect(p.user).toContain('Does this change alter what a holder owns, can do, or can have done to them?');
        expect(p.user).toContain('change text: stored-excerpt');
        expect(p.user).not.toContain('Truncated');
        expect(p.changeText).toBe(REDEMPTION_DIFF);
    });

    test('a long change is cut at the limit and the cut is stated', () => {
        const big = `@@ -1,1 +1,1 @@\n+${'x'.repeat(CHANGE_TEXT_LIMIT * 2)}`;
        const [candidate] = selectCandidates([legalTerm(1, { diff: big })]);
        const p = buildPrompt(candidate, { source, claims, change: changeTextFor(candidate, {}) });
        expect(p.changeText).toHaveLength(CHANGE_TEXT_LIMIT);
        expect(p.truncated).toBe(true);
        expect(p.user).toContain(`[Truncated: the change text above is the first ${CHANGE_TEXT_LIMIT} of ${big.length} characters; the rest was not shown to you.]`);
    });

    test('boundText leaves short text alone', () => {
        expect(boundText('abc', 10)).toEqual({ text: 'abc', truncated: false, originalChars: 3 });
    });

    test('a recomputed diff is preferred over the stored 4000-char excerpt', () => {
        const [candidate] = selectCandidates([legalTerm(1)]);
        expect(changeTextFor(candidate, { diffText: '+full diff' })).toEqual({ text: '+full diff', origin: 'recomputed-diff' });
    });

    test('quote-lost shows the lost words as removed lines and the current text around them', () => {
        const [candidate] = selectCandidates([quoteLost(5)]);
        const current = `${'filler '.repeat(4000)}Holders may now redeem only on Fridays.${' tail'.repeat(4000)}`;
        const change = changeTextFor(candidate, { currentText: current });
        expect(change.origin).toBe('current-text');
        expect(change.text).toContain('- Holders may redeem tokens for the underlying shares at any time');
        expect(change.text).toContain('Holders may now redeem only on Fridays.');
    });

    test('windowAround centres on a distinctive word of the quote', () => {
        const text = `${'a '.repeat(10_000)}underlying${' b'.repeat(10_000)}`;
        const w = windowAround(text, 'the underlying shares', 1000);
        expect(w).toHaveLength(1000);
        expect(w).toContain('underlying');
    });

    test('previousVersion picks the newest one strictly before', () => {
        const versions = [
            { fetchedAt: '2026-09-22T10:00:00Z', textPath: 'c' },
            { fetchedAt: '2026-09-20T10:00:00Z', textPath: 'a' },
            { fetchedAt: '2026-09-21T10:00:00Z', textPath: 'b' }
        ];
        expect(previousVersion(versions, '2026-09-22T10:00:00Z').textPath).toBe('b');
        expect(previousVersion(versions, '2026-09-20T10:00:00Z')).toBeNull();
    });

    test('the judge request is a model-free description with the strict JSON schema', () => {
        const [candidate] = selectCandidates([legalTerm(7)]);
        const p = buildPrompt(candidate, { source, claims, change: changeTextFor(candidate, {}) });
        expect(customIdFor(candidate)).toBe('evt-7');
        // No model, effort, thinking or max_tokens: those are the shared layer's (defaults.json).
        expect(judgeRequest(p)).toEqual({ system: p.system, content: p.user, schema: JUDGMENT_SCHEMA });
        expect(JUDGMENT_SCHEMA.additionalProperties).toBe(false);
        expect(JUDGMENT_SCHEMA.required.sort()).toEqual(Object.keys(JUDGMENT_SCHEMA.properties).sort());
    });
});

describe('validateJudgment', () => {
    test('a well-formed answer quoting the diff verbatim is valid', () => {
        const v = validateJudgment(GOOD, REDEMPTION_DIFF);
        expect(v.status).toBe('valid');
        expect(v.reasons).toEqual([]);
        expect(v.judgment.quotedChange).toEqual(GOOD.quotedChange);
    });

    test('a paraphrased quote is rejected and makes the judgment invalid; it is never stored as a quote', () => {
        const paraphrase = 'Redemption has been paused indefinitely';
        const v = validateJudgment({ ...GOOD, quotedChange: [GOOD.quotedChange[0], paraphrase] }, REDEMPTION_DIFF);
        expect(v.status).toBe('invalid');
        expect(v.rejectedQuotes).toEqual([paraphrase]);
        expect(v.judgment.quotedChange).toEqual([GOOD.quotedChange[0]]);
        expect(v.reasons.join(' ')).toMatch(/not found verbatim/);
    });

    test('a fragment stitched across two diff lines is not verbatim', () => {
        expect(fragmentInChange('at any time, subject to a fee of 0.5%. Redemptions are suspended', REDEMPTION_DIFF)).toBe(false);
        expect(fragmentInChange('subject to a fee of 0.5%', REDEMPTION_DIFF)).toBe(true);
    });

    test('schema violations are reasons', () => {
        const v = validateJudgment({
            material: 'yes', severity: 'severe', affects: ['holder rights'], summary: 'word '.repeat(81),
            quotedChange: [], confidence: 1.5
        }, REDEMPTION_DIFF);
        expect(v.status).toBe('invalid');
        const text = v.reasons.join(' | ');
        expect(text).toMatch(/material is not a boolean/);
        expect(text).toMatch(/severity "severe"/);
        expect(text).toMatch(/unknown value\(s\): holder rights/);
        expect(text).toMatch(/81 words/);
        expect(text).toMatch(/confidence/);
    });

    test('material must agree with affects, and a material judgment needs a verbatim quote', () => {
        expect(validateJudgment({ ...GOOD, material: false }, REDEMPTION_DIFF).reasons.join(' ')).toMatch(/contradicts affects/);
        expect(validateJudgment({ ...GOOD, quotedChange: [] }, REDEMPTION_DIFF).reasons.join(' ')).toMatch(/without a verbatim quote/);
        expect(validateJudgment({ ...GOOD, quotedChange: [] }, 'The document is no longer available', { kind: 'document-gone' }).status).toBe('valid');
    });

    test('a cosmetic verdict on the real tekedia price-list diff is valid', () => {
        const v = validateJudgment({
            material: false, severity: 'info', affects: ['cosmetic'],
            summary: 'Only a course price list changed ("Nigeria Capital Market Masterclass"); nothing about the token.',
            quotedChange: ['Nigeria Capital Market Masterclass (Oct 5 – Nov 28, 2026)'], confidence: 0.95
        }, TEKEDIA_DIFF);
        expect(v.status).toBe('valid');
    });
});

describe('cost', () => {
    test('estimateTokens is chars / 4, rounded up', () => {
        expect(estimateTokens('abcde')).toBe(2);
        expect(estimateTokens('')).toBe(0);
    });
});

describe('end to end through the shared LLM layer with a fake Anthropic client', () => {
    let ledgerDir;
    let llmLib;
    let costLib;

    beforeAll(async () => {
        // index.cjs reads LLM_COST_DIR at load time, so it must point at a temp dir BEFORE import:
        // this test must never append to the real ~/.agents-llm-cost ledger.
        ledgerDir = mkdtempSync(join(tmpdir(), 'change-judge-ledger-'));
        process.env.LLM_COST_DIR = ledgerDir;
        llmLib = await import(new URL('../../agents/lib/llm-cost/llm.mjs', import.meta.url).href);
        costLib = await import(new URL('../../agents/lib/llm-cost/index.mjs', import.meta.url).href);
    });
    afterAll(() => rmSync(ledgerDir, { recursive: true, force: true }));
    const readLedger = () => readFileSync(join(ledgerDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

    /** A fake SDK-shaped client whose batch answers `answers[custom_id]` as `model`. */
    function fakeClient({ answers, model, submitted = [] }) {
        const usage = { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        return {
            usage,
            submitted,
            messages: {
                create: async () => { throw new Error('no online call expected'); },
                batches: {
                    create: async ({ requests: r }) => { submitted.push(...r); return { id: 'msgbatch_fake' }; },
                    retrieve: async () => ({ processing_status: 'ended', request_counts: { processing: 0, succeeded: 2, errored: 1 } }),
                    results: async () => (async function* () {
                        for (const [id, answer] of Object.entries(answers)) {
                            if (answer === 'errored') {
                                yield { custom_id: id, result: { type: 'errored', error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } } };
                                continue;
                            }
                            const stop = answer === 'max_tokens' ? 'max_tokens' : 'end_turn';
                            const text = answer === 'max_tokens' ? '{"material": tr' : JSON.stringify(answer);
                            yield { custom_id: id, result: { type: 'succeeded', message: { model, stop_reason: stop, usage, content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text }] } } };
                        }
                    })()
                }
            }
        };
    }

    test('submit at the layer default model, collect, validate and build the SQL; per-item cost and ledger lines', async () => {
        const defaults = llmLib.DEFAULTS.providers.anthropic;
        const events = [legalTerm(21), legalTerm(22, { hash: 'h2', url: 'https://example.com/tekedia', diff: TEKEDIA_DIFF }), legalTerm(23, { hash: 'h3' }), legalTerm(24, { hash: 'h4' })];
        const candidates = selectCandidates(events);
        const answers = {
            'evt-21': GOOD,
            'evt-22': { material: true, severity: 'warning', affects: ['fees'], summary: 'A fee "went up".', quotedChange: ['membership fee doubled'], confidence: 0.4 },
            'evt-23': 'errored',
            'evt-24': 'max_tokens'
        };
        const client = fakeClient({ answers, model: defaults.model });
        const llm = llmLib.createLlm({ client, repo: 'rwa-sonar', script: 'judge-changes', meta: { promptVersion: PROMPT_VERSION } });
        const pending = {};
        const requests = [];
        for (const c of candidates) {
            const p = buildPrompt(c, { source: {}, claims: [], change: changeTextFor(c, {}) });
            requests.push(llm.batchRequest(customIdFor(c), judgeRequest(p)));
            pending[customIdFor(c)] = { candidate: c, changeText: p.changeText };
        }

        const batchId = await llm.submitBatch(requests);
        expect(client.submitted.map((r) => r.custom_id)).toEqual(['evt-24', 'evt-23', 'evt-22', 'evt-21']);
        // The model is the layer's default and nothing else: a repo-pinned model fails here.
        for (const r of client.submitted) {
            expect(r.params.model).toBe(defaults.model);
            expect(r.params.output_config.effort).toBe(defaults.effort);
            expect(r.params.output_config.format).toEqual({ type: 'json_schema', schema: JUDGMENT_SCHEMA });
            for (const k of ['thinking', 'temperature', 'top_p', 'tool_choice', 'fallbacks', 'betas']) expect(r.params).not.toHaveProperty(k);
        }
        await llm.awaitBatch(batchId, { pollMs: 1 });
        const rows = [];
        for await (const row of judgmentRows(llm.collectBatch(batchId, { schema: JUDGMENT_SCHEMA }), pending, { model: llm.model, batchId })) rows.push(row);

        const byEvent = Object.fromEntries(rows.map((r) => [r.changeEventId, r]));
        const perItem = costLib.computeCost(defaults.model, client.usage, { batch: true });
        expect(perItem).toBeGreaterThan(0);
        expect(byEvent[21]).toMatchObject({ status: 'valid', model: defaults.model, batchId: 'msgbatch_fake' });
        expect(byEvent[21].costUsd).toBeCloseTo(perItem, 12);
        expect(byEvent[22].status).toBe('invalid');
        expect(byEvent[22].rejectedQuotes).toEqual(['membership fee doubled']);
        expect(byEvent[22].judgment.quotedChange).toEqual([]);
        expect(byEvent[23]).toMatchObject({ status: 'error', costUsd: 0, judgment: null });
        expect(byEvent[23].reasons[0]).toMatch(/Overloaded/);
        // A truncated answer was paid for: invalid (not retried), with its real cost.
        expect(byEvent[24]).toMatchObject({ status: 'invalid', judgment: null });
        expect(byEvent[24].costUsd).toBeCloseTo(perItem, 12);
        expect(byEvent[24].reasons[0]).toMatch(/^max_tokens: /);

        const ledger = readLedger().filter((r) => r.batchId === 'msgbatch_fake');
        expect(ledger).toHaveLength(3);
        expect(ledger[0]).toMatchObject({ repo: 'rwa-sonar', script: 'judge-changes', model: defaults.model, batch: true, promptVersion: PROMPT_VERSION });
        expect(ledger.reduce((a, r) => a + r.cost_usd, 0)).toBeCloseTo(perItem * 3, 12);

        const { sql, rows: n, table } = buildJudgmentSql(rows);
        expect(table).toBe('sonar.change_judgment');
        expect(n).toBe(4);
        expect(sql).toContain('ON CONFLICT (change_event_id, model, prompt_version) DO UPDATE');
        expect(sql).toContain("WHERE j.status = 'error'");
        expect(sql).toContain(`"promptVersion":"${PROMPT_VERSION}"`);
        expect(sql).toContain('"quotedChange":["Redemptions are suspended until further notice"');
        expect(sql).not.toContain('"quotedChange":["membership fee doubled"]');
    });

    test('a batch checkpointed under an older model resumes: priced at the model that answered, keyed on the checkpoint model', async () => {
        const [c] = selectCandidates([legalTerm(31)]);
        const p = buildPrompt(c, { source: {}, claims: [], change: changeTextFor(c, {}) });
        const cp = { batchId: 'msgbatch_old', model: 'claude-sonnet-5', pending: { 'evt-31': { candidate: c, changeText: p.changeText } } };
        const client = fakeClient({ answers: { 'evt-31': GOOD }, model: 'claude-sonnet-5' });
        const llm = llmLib.createLlm({ client, repo: 'rwa-sonar', script: 'judge-changes' });
        const rows = [];
        for await (const row of judgmentRows(llm.collectBatch(cp.batchId, { schema: JUDGMENT_SCHEMA }), cp.pending, { model: cp.model, batchId: cp.batchId })) rows.push(row);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'valid', model: 'claude-sonnet-5' });
        expect(rows[0].costUsd).toBeCloseTo(costLib.computeCost('claude-sonnet-5', client.usage, { batch: true }), 12);
    });

    test('an unknown custom_id is an error, not a guess', async () => {
        const items = (async function* () { yield { customId: 'evt-999', text: '{}', usage: {}, costUsd: 0 }; })();
        await expect(async () => { for await (const r of judgmentRows(items, {}, { model: 'm', batchId: 'b' })) void r; })
            .rejects.toThrow(/unknown custom_id evt-999/);
    });
});

describe('DDL', () => {
    test('every column the upsert writes exists in the table', () => {
        const { sql } = buildJudgmentSql([]);
        const cols = sql.match(/INSERT INTO sonar\.change_judgment AS j\n\s+\(([^)]+)\)/)[1].split(',').map((c) => c.trim());
        for (const col of cols) expect(DDL).toMatch(new RegExp(`\\n\\s+${col}\\s+\\w`));
        expect(DDL).toMatch(/UNIQUE \(change_event_id, model, prompt_version\)/);
        expect(DDL).toMatch(/cost_usd\s+numeric NOT NULL/);
        expect(DDL).toMatch(/CHECK \(status IN \('valid', 'invalid', 'error'\)\)/);
    });
});

describe('directItem (the --direct fallback)', () => {
    const [candidate] = selectCandidates([legalTerm(41)]);
    const changeText = REDEMPTION_DIFF;
    const usage = { input_tokens: 501, output_tokens: 103, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 };

    test("a complete() result becomes the item a collected batch yields, without the raw response", () => {
        const result = { text: JSON.stringify(GOOD), data: GOOD, model: 'claude-opus-5-5', usage, costUsd: 0.01, stopReason: 'end_turn', raw: { big: true } };
        const item = directItem('evt-41', result);
        expect(item).toEqual({ customId: 'evt-41', text: JSON.stringify(GOOD), data: GOOD, model: 'claude-opus-5-5', usage, costUsd: 0.01, stopReason: 'end_turn' });
        expect(judgmentRow({ candidate, changeText, item, model: 'claude-opus-5-5', batchId: 'direct' })).toMatchObject({ status: 'valid', costUsd: 0.01, inputTokens: 501 });
    });

    test('a paid output failure (LlmOutputError) is an invalid reading with its cost and tokens', () => {
        const err = Object.assign(new Error('llm-cost/llm: refused (cyber)'), { name: 'LlmOutputError', reason: 'refusal', model: 'claude-opus-5-5', costUsd: 0.002, raw: { usage } });
        const row = judgmentRow({ candidate, changeText, item: directItem('evt-41', err), model: 'claude-opus-5-5', batchId: 'direct' });
        expect(row).toMatchObject({ status: 'invalid', costUsd: 0.002, inputTokens: 501, outputTokens: 103, judgment: null });
        expect(row.reasons).toEqual(['refusal: llm-cost/llm: refused (cyber)']);
    });

    test('a failed request (HTTP, network) is an error row: no charge, retried next run', () => {
        const row = judgmentRow({ candidate, changeText, item: directItem('evt-41', new Error('anthropic POST /v1/messages -> HTTP 529: Overloaded')), model: 'm', batchId: 'direct' });
        expect(row).toMatchObject({ status: 'error', costUsd: 0, inputTokens: 0, judgment: null });
    });

    test('a paid answer without a price is refused, never stored as free', () => {
        const err = Object.assign(new Error('truncated'), { name: 'LlmOutputError', reason: 'max_tokens', costUsd: null, raw: {} });
        expect(() => judgmentRow({ candidate, changeText, item: directItem('evt-41', err), model: 'm', batchId: 'direct' })).toThrow(/unknown price/);
    });
});

describe('isStalledBatch', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    test('an open batch older than 12 h is stalled; a younger or finished one is not', () => {
        expect(isStalledBatch({ submittedAt: '2026-09-23T09:30:01Z', done: false }, now)).toBe(true);
        expect(isStalledBatch({ submittedAt: '2026-09-24T01:00:00Z', done: false }, now)).toBe(false);
        expect(isStalledBatch({ submittedAt: '2026-09-23T09:30:01Z', done: true }, now)).toBe(false);
    });

    test('a checkpoint without a readable submission time is never cancelled', () => {
        expect(isStalledBatch({ submittedAt: 'garbage', done: false }, now)).toBe(false);
        expect(isStalledBatch({}, now)).toBe(false);
    });
});
