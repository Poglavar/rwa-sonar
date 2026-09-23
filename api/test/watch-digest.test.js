// The personal morning digest with a fake store and a fake Telegram client (no network): due-ness
// at the chosen hour, one message per day however often the job reruns, no message without a
// material change, exact targets in the text, and a contents-free operator summary on failure.
import { createRequire } from 'node:module';

import { formatDigest, isDigestMaterial, isDue, localDay, reportUrl, runDigests } from '../src/lib/watch-digest.js';

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
function fakeStore(watches, events) {
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
