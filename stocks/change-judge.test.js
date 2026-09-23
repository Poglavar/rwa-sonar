// Unit tests for stocks/lib/change-judge.mjs — the change judge's decisions: which changes a model
// is asked about (one per source + content hash, never one already judged), what the prompt shows
// (a bounded change text that SAYS when it was cut, the dossier fields and claims that cite the
// URL), what a model answer must satisfy (schema, 80 words, and quotes that are verbatim in the
// change — a paraphrase makes the judgment invalid), what the estimate costs, and the whole
// collect -> validate -> SQL path through the shared batch library with a fake Anthropic client.
// The legal-term diff below is the real one the watcher stored for event 189 (tekedia.com,
// 2026-09-22), trimmed: a "fee" keyword hit that is a course price list — cosmetic to a holder.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    CHANGE_TEXT_LIMIT, JUDGMENT_SCHEMA, PROMPT_VERSION, batchRequest, boundText, buildJudgmentSql,
    buildPrompt, changeTextFor, dedupeKey, estimateCost, estimateTokens, fragmentInChange,
    directResultItem, isStalledBatch, judgmentRows, previousVersion, selectCandidates, validateJudgment, windowAround
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

    test('the batch request asks for the strict JSON schema', () => {
        const [candidate] = selectCandidates([legalTerm(7)]);
        const p = buildPrompt(candidate, { source, claims, change: changeTextFor(candidate, {}) });
        const req = batchRequest(candidate, p, { model: 'claude-sonnet-5', maxTokens: 8000, effort: 'medium' });
        expect(req.custom_id).toBe('evt-7');
        expect(req.params.output_config.format).toEqual({ type: 'json_schema', schema: JUDGMENT_SCHEMA });
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
    test('estimateCost: tokens × fixture rate, halved for a batch', () => {
        const rate = { input: 2, output: 10 };
        expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 0 }, rate, { batch: false })).toBeCloseTo(2, 10);
        expect(estimateCost({ inputTokens: 2000, outputTokens: 1200 }, rate)).toBeCloseTo((2000 * 2 + 1200 * 10) / 1e6 / 2, 12);
        expect(() => estimateCost({ inputTokens: 1, outputTokens: 1 }, { input: 2 })).toThrow(/rate/);
    });

    test('estimateTokens is chars / 4, rounded up', () => {
        expect(estimateTokens('abcde')).toBe(2);
        expect(estimateTokens('')).toBe(0);
    });
});

describe('end to end through the shared batch library with a fake Anthropic client', () => {
    let ledgerDir;
    let batchLib;

    beforeAll(async () => {
        // index.cjs reads LLM_COST_DIR at load time, so it must point at a temp dir BEFORE import:
        // this test must never append to the real ~/.agents-llm-cost ledger.
        ledgerDir = mkdtempSync(join(tmpdir(), 'change-judge-ledger-'));
        process.env.LLM_COST_DIR = ledgerDir;
        const lib = new URL('../../agents/lib/llm-cost/batch.mjs', import.meta.url);
        batchLib = await import(lib.href);
    });
    afterAll(() => rmSync(ledgerDir, { recursive: true, force: true }));

    test('submit, collect, validate and build the SQL; per-item cost and the ledger line are recorded', async () => {
        const events = [legalTerm(21), legalTerm(22, { hash: 'h2', url: 'https://example.com/tekedia', diff: TEKEDIA_DIFF }), legalTerm(23, { hash: 'h3' })];
        const candidates = selectCandidates(events);
        const pending = {};
        const requests = [];
        for (const c of candidates) {
            const p = buildPrompt(c, { source: {}, claims: [], change: changeTextFor(c, {}) });
            const req = batchRequest(c, p, { model: 'claude-sonnet-5', maxTokens: 8000, effort: 'medium' });
            requests.push(req);
            pending[req.custom_id] = { candidate: c, changeText: p.changeText };
        }
        const answers = {
            'evt-21': GOOD,
            'evt-22': { material: true, severity: 'warning', affects: ['fees'], summary: 'A fee "went up".', quotedChange: ['membership fee doubled'], confidence: 0.4 }
        };
        const usage = { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        const submitted = [];
        const client = {
            messages: {
                batches: {
                    create: async ({ requests: r }) => { submitted.push(...r); return { id: 'msgbatch_fake' }; },
                    retrieve: async () => ({ processing_status: 'ended', request_counts: { processing: 0, succeeded: 2, errored: 1 } }),
                    results: async () => (async function* () {
                        for (const id of ['evt-21', 'evt-22']) {
                            yield { custom_id: id, result: { type: 'succeeded', message: { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: JSON.stringify(answers[id]) }] } } };
                        }
                        yield { custom_id: 'evt-23', result: { type: 'errored' } };
                    })()
                }
            }
        };

        const batchId = await batchLib.submitBatch({ client, provider: 'anthropic', requests });
        expect(submitted.map((r) => r.custom_id)).toEqual(['evt-23', 'evt-22', 'evt-21']);
        await batchLib.awaitBatch({ client, provider: 'anthropic', batchId, pollMs: 1 });
        const items = batchLib.collectBatch({ client, provider: 'anthropic', batchId, model: 'claude-sonnet-5', repo: 'rwa-sonar', script: 'judge-changes' });
        const rows = [];
        for await (const row of judgmentRows(items, pending, { model: 'claude-sonnet-5', batchId })) rows.push(row);

        const byEvent = Object.fromEntries(rows.map((r) => [r.changeEventId, r]));
        const perItem = (2000 * 2 + 1000 * 10) / 1e6 / 2; // Sonnet 5 at 2/10 online, halved in batch
        expect(byEvent[21].status).toBe('valid');
        expect(byEvent[21].costUsd).toBeCloseTo(perItem, 12);
        expect(byEvent[22].status).toBe('invalid');
        expect(byEvent[22].rejectedQuotes).toEqual(['membership fee doubled']);
        expect(byEvent[22].judgment.quotedChange).toEqual([]);
        expect(byEvent[23]).toMatchObject({ status: 'error', costUsd: 0, judgment: null });

        const ledger = readFileSync(join(ledgerDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        expect(ledger).toHaveLength(2);
        expect(ledger[0]).toMatchObject({ repo: 'rwa-sonar', script: 'judge-changes', model: 'claude-sonnet-5', batch: true, batchId: 'msgbatch_fake' });
        expect(ledger.reduce((a, r) => a + r.cost_usd, 0)).toBeCloseTo(perItem * 2, 12);

        const { sql, rows: n, table } = buildJudgmentSql(rows);
        expect(table).toBe('sonar.change_judgment');
        expect(n).toBe(3);
        expect(sql).toContain('ON CONFLICT (change_event_id, model, prompt_version) DO UPDATE');
        expect(sql).toContain("WHERE j.status = 'error'");
        expect(sql).toContain(`"promptVersion":"${PROMPT_VERSION}"`);
        expect(sql).toContain('"quotedChange":["Redemptions are suspended until further notice"');
        expect(sql).not.toContain('"quotedChange":["membership fee doubled"]');
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

describe('directResultItem (the --direct fallback)', () => {
    test('an online message becomes the same item a collected batch yields', () => {
        const message = {
            content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '{"material":false}' }],
            usage: { input_tokens: 501, output_tokens: 103, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 }
        };
        expect(directResultItem('evt-1', message)).toEqual({
            customId: 'evt-1', message, text: '{"material":false}',
            usage: { input_tokens: 501, output_tokens: 103, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 }
        });
    });

    test('missing usage counts as zero tokens, never NaN', () => {
        expect(directResultItem('evt-2', { content: [] }).usage).toEqual({
            input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0
        });
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
