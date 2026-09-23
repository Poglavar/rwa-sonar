// The personal morning digest with a fake store and a fake Telegram client (no network): due-ness
// at the chosen hour, one message per day however often the job reruns, no message without a
// material change, exact targets in the text, and a contents-free operator summary on failure.
import { createRequire } from 'node:module';

import {
    buildTargetChangesSql, changeUrl, digestAssessment, formatChangeLine, formatDigest, isDigestMaterial, isDue, localDay,
    reportUrl, runDigests
} from '../src/lib/watch-digest.js';

const require = createRequire(import.meta.url);
const { comparisonSnapshotChanges } = require('../../stocks/lib/saved-items.js');

const MINT = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const MARKET = '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
const AT_0730 = Date.parse('2026-09-24T07:30:00Z');

function marketWatch(overrides = {}) {
    return {
        watch_id: 'w-market', title: null, watch_type: 'protocol-market',
        target: { mint: MINT, integrationId: 'kamino:collateral', marketKey: MARKET },
        underlying_ticker: null, issuer_slugs: [], digest_hour: 7, digest_timezone: 'UTC',
        chat_enc: 'enc:555', verified_at: new Date('2026-09-20T00:00:00Z'), digest_since: new Date('2026-09-21T00:00:00Z'),
        last_covered: null, ...overrides
    };
}

/** In-memory twin of pgDigestStore, with the same claim rule as the SQL. */
function fakeStore(watches, events, changes = []) {
    const log = new Map();
    const store = {
        log,
        disconnected: [],
        async enabledBoundWatches() {
            return watches.map((watch) => {
                const covered = [...log.entries()]
                    .filter(([key, row]) => key.startsWith(`${watch.watch_id}|`) && ['sent', 'no-change'].includes(row.status))
                    .map(([, row]) => Date.parse(row.coveredUntil));
                return { ...watch, last_covered: covered.length ? new Date(Math.max(...covered)) : watch.last_covered };
            });
        },
        async claim(watchId, date) {
            const key = `${watchId}|${date}`;
            const row = log.get(key);
            if (!row) { log.set(key, { status: 'sending', attempts: 1 }); return true; }
            if (row.status === 'failed' && row.attempts < 3) { row.status = 'sending'; row.attempts += 1; return true; }
            return false;
        },
        async eventsBetween(watchId, since, until) {
            return events.filter((event) => event.watch_id === watchId
                && Date.parse(event.detected_at) > Date.parse(since) && Date.parse(event.detected_at) <= Date.parse(until));
        },
        async changesBetween(watch, since, until) {
            return changes.filter((change) => change.watch_id === watch.watch_id
                && Date.parse(change.detected_at) > Date.parse(since) && Date.parse(change.detected_at) <= Date.parse(until));
        },
        async finish(watchId, date, result) {
            Object.assign(log.get(`${watchId}|${date}`), result);
        },
        async disconnect(watchId) {
            store.disconnected.push(watchId);
        }
    };
    return store;
}

function fakeTelegram(results = []) {
    const sent = [];
    return {
        sent,
        async sendMessage(chatId, text) {
            sent.push({ chatId, text });
            return results.shift() ?? { ok: true, status: 200, reason: 'ok' };
        }
    };
}

const decrypt = (value) => value.replace(/^enc:/, '');
const LTV = `NVDAx ${MINT} · Kamino Lend · Main: maximum LTV changed from 55% to 45%`;

describe('when a digest is due', () => {
    test('at the chosen hour in the watch timezone, for a bounded catch-up window only', () => {
        expect(localDay(AT_0730, 'UTC')).toEqual({ date: '2026-09-24', hour: 7 });
        expect(localDay(AT_0730, 'Asia/Tokyo')).toEqual({ date: '2026-09-24', hour: 16 });
        expect(isDue(marketWatch(), AT_0730)).toBe(true);
        expect(isDue(marketWatch({ digest_hour: 8 }), AT_0730)).toBe(false);
        expect(isDue(marketWatch({ digest_hour: 4 }), AT_0730)).toBe(false);
        expect(isDue(marketWatch({ digest_hour: 9, digest_timezone: 'Europe/Paris' }), AT_0730)).toBe(true);
    });
});

describe('digest content', () => {
    test('names the exact token and market, the before/after and the report link', () => {
        const text = formatDigest(marketWatch(), [{ summary: LTV }], { baseUrl: 'https://rwasonar.com', date: '2026-09-24' });
        expect(text).toContain(`Watch: kamino:collateral market ${MARKET} for token ${MINT}`);
        expect(text).toContain('1 material change since your last digest');
        expect(text).toContain('• NVDAx');
        expect(text).toContain('from 55% to 45%');
        expect(text).toContain(`Report: https://rwasonar.com/card.html?mint=${MINT}`);
        expect(text).toContain('/stop');
        expect(text.length).toBeLessThan(4096);
    });

    test('a comparison digest prefixes the ticker and links to that comparison; issuers link to their dossier', () => {
        const comparison = { watch_id: 'c', title: 'My NVDA', watch_type: 'comparison', target: {},
            underlying_ticker: 'NVDA', issuer_slugs: ['ondo-global-markets', 'xstocks-backed'] };
        const text = formatDigest(comparison, [{ summary: 'xstocks-backed: cash-redemption conclusion changed' }],
            { baseUrl: 'https://rwasonar.com', date: '2026-09-24' });
        expect(text).toContain('My NVDA (NVDA comparison of ondo-global-markets, xstocks-backed)');
        expect(text).toContain('• NVDA · xstocks-backed: cash-redemption conclusion changed');
        expect(text).toContain('stocks.html?view=compare&compare=NVDA');
        expect(reportUrl({ watch_type: 'issuer', target: { issuerSlug: 'xstocks-backed' } }, 'https://x.test'))
            .toBe('https://x.test/issuers/xstocks-backed.html');
    });

    test('long digests stay under Telegram’s limit and say how many were left out', () => {
        const events = Array.from({ length: 60 }, (_, i) => ({ summary: `${LTV} ${'x'.repeat(150)} #${i}` }));
        const text = formatDigest(marketWatch(), events, { baseUrl: 'https://rwasonar.com', date: '2026-09-24' });
        expect(text.length).toBeLessThan(4096);
        expect(text).toMatch(/…and \d+ more on the report page\./);
    });

    test('our own review-status flips are internal and never material for a digest', () => {
        const [internal] = comparisonSnapshotChanges(
            { products: { 'xstocks-backed': { evidencePending: false } } },
            { products: { 'xstocks-backed': { evidencePending: true } } }
        );
        expect(internal).toBe('xstocks-backed: legal-evidence review status changed');
        expect(isDigestMaterial(internal)).toBe(false);
        expect(isDigestMaterial(LTV)).toBe(true);
        expect(isDigestMaterial('')).toBe(false);
    });
});

describe('a digest run', () => {
    const events = [
        { watch_id: 'w-market', summary: LTV, detected_at: '2026-09-24T00:20:00Z' },
        { watch_id: 'w-market', summary: 'older than the opt-in', detected_at: '2026-09-20T12:00:00Z' }
    ];

    test('sends one message per watch per day, however often the job reruns', async () => {
        const store = fakeStore([marketWatch()], events);
        const telegram = fakeTelegram();
        const first = await runDigests({ store, telegram, decrypt, nowMs: AT_0730, baseUrl: 'https://rwasonar.com' });
        const second = await runDigests({ store, telegram, decrypt, nowMs: AT_0730 + 30 * 60 * 1000, baseUrl: 'https://rwasonar.com' });
        expect(first).toMatchObject({ ok: true, due: 1, sent: 1 });
        expect(second).toMatchObject({ ok: true, due: 1, sent: 0, alreadyHandled: 1 });
        expect(telegram.sent).toHaveLength(1);
        expect(telegram.sent[0].chatId).toBe('555');
        expect(telegram.sent[0].text).toContain(LTV);
        expect(telegram.sent[0].text).not.toContain('older than the opt-in');
        // The next day covers only what was found after this digest.
        const nextDay = await runDigests({ store, telegram, decrypt, nowMs: AT_0730 + 24 * 3600 * 1000, baseUrl: 'https://rwasonar.com' });
        expect(nextDay).toMatchObject({ sent: 0, noChange: 1 });
        expect(telegram.sent).toHaveLength(1);
    });

    test('no material change → no message, and a later genuine change is still sent the next day', async () => {
        const later = [{ watch_id: 'w-market', summary: 'xstocks-backed: legal-evidence review status changed', detected_at: '2026-09-24T00:20:00Z' }];
        const store = fakeStore([marketWatch()], later);
        const telegram = fakeTelegram();
        expect(await runDigests({ store, telegram, decrypt, nowMs: AT_0730, baseUrl: 'https://rwasonar.com' }))
            .toMatchObject({ sent: 0, noChange: 1 });
        expect(telegram.sent).toHaveLength(0);
        later.push({ watch_id: 'w-market', summary: LTV, detected_at: '2026-09-25T00:20:00Z' });
        await runDigests({ store, telegram, decrypt, nowMs: AT_0730 + 24 * 3600 * 1000, baseUrl: 'https://rwasonar.com' });
        expect(telegram.sent).toHaveLength(1);
        expect(telegram.sent[0].text).toContain('1 material change');
    });

    test('a watch that is not due is left alone', async () => {
        const telegram = fakeTelegram();
        const stats = await runDigests({ store: fakeStore([marketWatch({ digest_hour: 9 })], events), telegram, decrypt,
            nowMs: AT_0730, baseUrl: 'https://rwasonar.com' });
        expect(stats).toMatchObject({ eligible: 1, due: 0, sent: 0 });
        expect(telegram.sent).toHaveLength(0);
    });

    test('a failure is retried later that day and reported once, without watch contents', async () => {
        const store = fakeStore([marketWatch()], events);
        const telegram = fakeTelegram([{ ok: false, status: 500, reason: 'http-500' }]);
        const notices = [];
        const stats = await runDigests({ store, telegram, decrypt, nowMs: AT_0730, baseUrl: 'https://rwasonar.com',
            notifyOperator: async (text) => notices.push(text) });
        expect(stats).toMatchObject({ ok: false, failed: 1, failureReasons: { 'http-500': 1 } });
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain('http-500 ×1');
        for (const secret of [MINT, MARKET, 'w-market', '555', 'LTV']) expect(notices[0]).not.toContain(secret);
        const retry = await runDigests({ store, telegram, decrypt, nowMs: AT_0730 + 3600 * 1000, baseUrl: 'https://rwasonar.com',
            notifyOperator: async (text) => notices.push(text) });
        expect(retry).toMatchObject({ ok: true, sent: 1 });
        expect(notices).toHaveLength(1);
    });

    test('a chat that blocked the bot is disconnected rather than retried forever', async () => {
        const store = fakeStore([marketWatch()], events);
        const notices = [];
        const stats = await runDigests({ store, telegram: fakeTelegram([{ ok: false, status: 403, reason: 'http-403' }]), decrypt,
            nowMs: AT_0730, baseUrl: 'https://rwasonar.com', notifyOperator: async (text) => notices.push(text) });
        expect(stats).toMatchObject({ ok: true, failed: 0, disconnected: 1 });
        expect(store.disconnected).toEqual(['w-market']);
        expect(notices).toHaveLength(0);
    });
});

// Change events with the change judge's reading beside them (stocks/EVIDENCE.md §2.3): the reading
// is always labelled "model assessment", and it never decides which changes a digest lists.
describe('change events and model assessments in a digest', () => {
    const BASE = 'https://rwasonar.com';
    const ISSUER_WATCH = { watch_id: 'w-issuer', title: null, watch_type: 'issuer', target: { issuerSlug: 'tessera' },
        digest_hour: 7, digest_timezone: 'UTC', chat_enc: 'enc:777', verified_at: new Date('2026-09-20T00:00:00Z'),
        digest_since: null, last_covered: null };
    const valid = (overrides = {}) => ({ status: 'valid', model: 'm', promptVersion: 'p1', material: true, severity: 'warning',
        affects: ['redemption'], summary: 'Redemption now needs 30 days notice instead of 5.', quotedChange: [], confidence: 0.8, ...overrides });
    const MATERIAL = { id: '41', watch_id: 'w-issuer', detected_at: '2026-09-24T01:00:00Z', kind: 'legal-term', severity: 'caution',
        summary: 'tessera:sources[3]: +2 -1 line(s) · keywords: redemption', modelAssessment: valid(), judgment_id: '9' };
    const SAME_CHANGE = { ...MATERIAL, id: '42', kind: 'quote-lost', severity: 'warning',
        summary: 'tessera: the quoted words for claim redemption.fees are no longer in Terms' };
    const NOT_MATERIAL = { ...MATERIAL, id: '43', summary: 'tessera:sources[5]: +1 -1 line(s) · keywords: fee',
        modelAssessment: valid({ material: false, severity: 'info', summary: 'Only a footer date changed.' }), judgment_id: '10' };
    const UNJUDGED = { ...MATERIAL, id: '44', summary: 'tessera: document gone: https://docs.example/terms', modelAssessment: null, judgment_id: null };
    const INVALID = { ...MATERIAL, id: '45', summary: 'tessera:sources[7]: +3 -0 line(s)', modelAssessment: { status: 'invalid' }, judgment_id: '11' };

    test('a material reading is one line: what changed, the model\'s summary labelled as a model assessment, the link', () => {
        const line = formatChangeLine(MATERIAL, { baseUrl: BASE });
        expect(line).toContain('[caution] tessera:sources[3]: +2 -1 line(s)');
        expect(line).toContain('model assessment: material, warning — Redemption now needs 30 days notice instead of 5.');
        expect(line).toContain(`${BASE}/watch.html?material=true#change-41`);
        expect(line.split('\n')).toHaveLength(1);
    });

    test('a change with no reading, or an invalid one, is still listed as a plain change', () => {
        for (const change of [UNJUDGED, INVALID]) {
            const line = formatChangeLine(change, { baseUrl: BASE });
            expect(line).toContain(change.summary);
            expect(line).not.toContain('model assessment');
            expect(line).toContain(`${BASE}/watch.html#change-${change.id}`);
        }
        expect(digestAssessment({ status: 'invalid' })).toBeNull();
        expect(digestAssessment(valid({ material: null }))).toBeNull();
        expect(digestAssessment(valid({ summary: ' ' }))).toBeNull();
    });

    test('a not-material reading is shown as such, never used to drop the change', () => {
        const text = formatDigest(ISSUER_WATCH, [], { baseUrl: BASE, date: '2026-09-24', changes: [MATERIAL, NOT_MATERIAL, UNJUDGED] });
        expect(text).toContain('3 document or on-chain changes recorded for this target:');
        expect(text).toContain('model assessment: not material, info — Only a footer date changed.');
        expect(text).toContain(UNJUDGED.summary);
        expect(text).toContain('never decides what is listed here');
        expect(changeUrl(NOT_MATERIAL, BASE)).toBe(`${BASE}/watch.html#change-43`);
    });

    test('every line carrying a reading says "model assessment"', () => {
        const text = formatDigest(ISSUER_WATCH, [], { baseUrl: BASE, date: '2026-09-24',
            changes: [MATERIAL, SAME_CHANGE, NOT_MATERIAL, UNJUDGED, INVALID] });
        const lines = text.split('\n').filter((line) => line.startsWith('• '));
        expect(lines).toHaveLength(5);
        for (const line of lines) {
            const hasReading = /material/.test(line.replace(/\?material=true/, ''));
            if (hasReading) expect(line).toContain('model assessment');
        }
    });

    test('events of one change share one judgment: the reading is printed once and referred to after', () => {
        const text = formatDigest(ISSUER_WATCH, [], { baseUrl: BASE, date: '2026-09-24', changes: [MATERIAL, SAME_CHANGE] });
        expect(text.split('Redemption now needs 30 days').length - 1).toBe(1);
        expect(text).toContain('model assessment: material, warning (same change as above)');
    });

    test('a digest without change events reads exactly as before', () => {
        const text = formatDigest(marketWatch(), [{ summary: LTV }], { baseUrl: BASE, date: '2026-09-24' });
        expect(text).not.toContain('document or on-chain');
        expect(text).not.toContain('model assessment');
    });

    test('many change events stay under Telegram\'s limit and say how many are on the change feed', () => {
        const changes = Array.from({ length: 50 }, (_, i) => ({ ...MATERIAL, id: String(100 + i), judgment_id: String(i),
            summary: `${'y'.repeat(200)} #${i}`, modelAssessment: valid({ summary: 'z'.repeat(300) }) }));
        const text = formatDigest(ISSUER_WATCH, [{ summary: 'Issuer tessera: status changed' }], { baseUrl: BASE, date: '2026-09-24', changes });
        expect(text.length).toBeLessThan(4096);
        expect(text).toMatch(/…and \d+ more on https:\/\/rwasonar\.com\/watch\.html/);
        expect(text).toContain('1 material change since your last digest');
    });

    test('a run sends a digest for change events alone and counts them', async () => {
        const store = fakeStore([ISSUER_WATCH], [], [NOT_MATERIAL, UNJUDGED]);
        const telegram = fakeTelegram();
        const stats = await runDigests({ store, telegram, decrypt, nowMs: AT_0730, baseUrl: BASE });
        expect(stats).toMatchObject({ sent: 1, noChange: 0 });
        expect(telegram.sent[0].chatId).toBe('777');
        expect(telegram.sent[0].text).toContain('model assessment: not material');
        expect(telegram.sent[0].text).toContain(UNJUDGED.summary);
        expect(store.log.get('w-issuer|2026-09-24')).toMatchObject({ status: 'sent', changeCount: 2 });
    });

    test('the target query matches the watch\'s exact target and reads the judgment only where the table exists', () => {
        const issuer = buildTargetChangesSql(ISSUER_WATCH, '2026-09-20T00:00:00Z', '2026-09-24T07:30:00Z', { judgments: true });
        expect(issuer.values).toEqual(['tessera', '2026-09-20T00:00:00Z', '2026-09-24T07:30:00Z']);
        expect(issuer.text).toContain('LEFT JOIN LATERAL');
        expect(issuer.text).toContain('mj.id AS judgment_id');
        expect(issuer.text).toContain("e.evidence->>'issuer'");
        const token = buildTargetChangesSql(marketWatch(), 'a', 'b', { judgments: false });
        expect(token.values[0]).toBe(MINT);
        expect(token.text).not.toContain('LATERAL');
        expect(token.text).toContain('NULL::jsonb AS "modelAssessment"');
        const comparison = buildTargetChangesSql({ watch_type: 'comparison', target: {}, issuer_slugs: ['a', 'b'] }, 'x', 'y');
        expect(comparison.values[0]).toEqual(['a', 'b']);
        expect(comparison.text).toContain('= ANY($1::text[])');
    });
});
