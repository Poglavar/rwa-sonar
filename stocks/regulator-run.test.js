// Unit tests for stocks/lib/regulator-run.mjs: one regulator source's ingest and processing, with
// the IO injected. Each test injects the failure the 2026-11 audit found (a processing write that
// throws, a parser that throws, a store that throws, a state read that failed) and asserts that
// what the source sent was still stored or kept, and that the next source is still fetched.

import { readFileSync } from 'node:fs';

import { ingestSource, processSource } from './lib/regulator-run.mjs';
import { SOURCES, deriveWatchNames, noticeRows, parseFcaWarnings } from './lib/regulators.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/regulators/${name}`, import.meta.url), 'utf8');
const AT = '2026-11-23T05:37:00Z';
const FCA = SOURCES.find((s) => s.id === 'fca-warnings');
const NOTICES = parseFcaWarnings(fixture('fca-warnings.xml'));

/** A watched name that the first fixture notice's title is guaranteed to contain. */
function namesFor(notice) {
    const phrase = notice.title.replace(/[^A-Za-z ]/g, ' ').trim().split(/\s+/).slice(0, 3).join(' ');
    return deriveWatchNames([], { extra: { queries: [{ phrase, issuers: ['test-issuer'], why: 'test' }], dockets: [] } });
}

/** An in-memory notice store with the real dedupe key (source, id, content hash). */
function memoryStore() {
    const rows = new Map();
    return {
        rows,
        store: async (notices) => {
            let inserted = 0;
            for (const r of noticeRows('fca-warnings', notices)) {
                const key = `${r.noticeId}|${r.contentHash}`;
                if (!rows.has(key)) {
                    rows.set(key, { ...r, matchedAt: null });
                    inserted += 1;
                }
            }
            return { inserted, touched: notices.length };
        }
    };
}

const okIo = (store, extra = {}) => ({
    collect: async () => ({ notices: NOTICES, raw: [{ url: FCA.url, body: '<rss/>' }], requests: 1 }),
    keepRing: async () => ({ path: 'ring' }),
    keepPending: async () => ({ path: 'pending' }),
    store: store.store,
    ...extra
});

const processInput = (extra = {}) => ({
    source: FCA, notices: NOTICES, error: null, stateError: null, prev: { lastOkAt: '2026-11-22T05:37:00Z', consecutiveFailures: 0 },
    baseline: false, names: namesFor(NOTICES[0]), previous: new Map(), detectedAt: AT, review: new Map(), ...extra
});

describe('ingest is stored before, and apart from, processing', () => {
    test('a processing write that throws leaves every notice stored, and the next source is still fetched', async () => {
        const store = memoryStore();
        const ingested = await ingestSource(okIo(store));
        expect(ingested.errors).toEqual([]);
        expect(store.rows.size).toBe(NOTICES.length);

        const previous = new Map();
        const processed = await processSource(processInput({ previous }), {
            readBacklog: async () => [],
            write: async () => { throw new Error('psql exited 3 on source fca-warnings'); }
        });
        expect(processed.error).toEqual({ step: 'record-matches', message: 'psql exited 3 on source fca-warnings' });
        // The in-memory state is taken back, so the next run still sees these matches as new.
        expect(previous.size).toBe(0);
        // Nothing was stored as matched: the notices wait for the next run.
        expect([...store.rows.values()].every((r) => r.matchedAt === null)).toBe(true);

        let fetched = false;
        await ingestSource(okIo(memoryStore(), { collect: async () => { fetched = true; return { notices: [], raw: [], requests: 1 }; } }));
        expect(fetched).toBe(true);
    });

    test('the next run matches the stored backlog, so a notice gone from the feed is still matched', async () => {
        const backlog = noticeRows('fca-warnings', [NOTICES[0]]).map((r) => ({ notice: r.notice, contentHash: r.contentHash }));
        const written = [];
        const processed = await processSource(processInput({ notices: NOTICES.slice(1) }), {
            readBacklog: async () => backlog,
            write: async (statements) => { written.push(...statements); }
        });
        expect(processed.error).toBeNull();
        expect(processed.backlogCount).toBe(1);
        expect(processed.rows.some((r) => r.noticeId === NOTICES[0].id)).toBe(true);
        expect(processed.events.length).toBeGreaterThan(0);
        expect(written.join('\n')).toContain('UPDATE sonar.regulator_notice n SET matched_at');
    });

    test('a parse failure keeps the raw body for replay and is an ingest error, not a crash', async () => {
        const kept = [];
        const ingested = await ingestSource(okIo(memoryStore(), {
            collect: async () => { throw Object.assign(new Error('FCA warnings: no <item>'), { stage: 'parse', raw: [{ url: FCA.url, body: '<html>maintenance</html>' }] }); },
            keepPending: async (raw) => { kept.push(raw); return { path: 'pending/x.json.gz' }; }
        }));
        expect(ingested.errors.map((e) => e.step)).toEqual(['parse']);
        expect(kept).toEqual([[{ url: FCA.url, body: '<html>maintenance</html>' }]]);
        expect(ingested.error).toContain('raw kept for reprocessing');
    });

    test('a store that throws keeps the raw read for replay; matching still runs on what was read', async () => {
        const kept = [];
        const ingested = await ingestSource(okIo(memoryStore(), {
            store: async () => { throw new Error('connection refused'); },
            keepPending: async (raw) => { kept.push(raw); return { path: 'pending/y.json.gz' }; }
        }));
        expect(ingested.errors.map((e) => e.step)).toEqual(['store-notices']);
        expect(kept).toHaveLength(1);
        expect(ingested.notices).toHaveLength(NOTICES.length);
    });

    test('a failed state read stops only processing; the fetch and the store happen', async () => {
        const store = memoryStore();
        const ingested = await ingestSource(okIo(store));
        expect(ingested.errors).toEqual([]);
        expect(store.rows.size).toBe(NOTICES.length);
        const processed = await processSource(processInput({ stateError: 'psql exited 2 on read matches' }), {
            readBacklog: async () => { throw new Error('must not be read'); }, write: async () => { throw new Error('must not be written'); }
        });
        expect(processed.error.step).toBe('read-state');
    });

    test('a full disk while keeping raw is recorded, and the notices are still stored', async () => {
        const store = memoryStore();
        const ingested = await ingestSource(okIo(store, { keepRing: async () => { throw new Error('ENOSPC: no space left on device'); } }));
        expect(ingested.errors.map((e) => e.step)).toEqual(['keep-raw']);
        expect(store.rows.size).toBe(NOTICES.length);
    });

    test('a repeat fetch of unchanged notices stores nothing new', async () => {
        const store = memoryStore();
        const first = await ingestSource(okIo(store));
        const second = await ingestSource(okIo(store));
        expect(first.inserted).toBe(NOTICES.length);
        expect(second.inserted).toBe(0);
        expect(store.rows.size).toBe(NOTICES.length);
    });
});
