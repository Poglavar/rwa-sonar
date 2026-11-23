// Unit tests for stocks/lib/caselaw-feed.mjs: one SEC litigation feed task with its IO injected.
// The feed shows only its newest 25, so each test injects a failure on our side (a processing
// write, a parse, a store, an unreadable state) and asserts every item was still stored or the
// body kept, and that a repeat read of an unchanged feed stores nothing new.

import { readFileSync } from 'node:fs';

import { FEED_ITEM_KEYS, feedItemRows, runFeedTask } from './lib/caselaw-feed.mjs';
import { parseSecFeed } from './lib/caselaw.mjs';

const SEC_XML = readFileSync(new URL('./fixtures/caselaw/sec-litigation-releases.xml', import.meta.url), 'utf8');
const FEED = { id: 'sec-lr', label: 'SEC litigation release', url: 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss' };
const ITEMS = parseSecFeed(SEC_XML, FEED);
const AT = '2026-11-23T07:23:00Z';
const QUERIES = [{ phrase: 'Wavemark Capital, LLC', issuers: ['x'], origins: [{ role: 'test' }] }];

function memoryStore() {
    const rows = new Map();
    return {
        rows,
        store: async (list) => {
            let inserted = 0;
            for (const r of list) {
                const key = `${r.noticeId}|${r.contentHash}`;
                if (!rows.has(key)) {
                    rows.set(key, { ...r, matchedAt: null });
                    inserted += 1;
                }
            }
            return { inserted };
        }
    };
}

const input = (extra = {}) => ({
    feed: FEED, queries: QUERIES, previous: new Map(), prevRun: { lastRunAt: '2026-09-20T00:00:00Z' }, baseline: false,
    detectedAt: AT, review: new Map(), stateError: null, ...extra
});
const io = (store, extra = {}) => ({
    fetch: async () => SEC_XML,
    keepPending: async () => ({ path: 'pending/x.xml.gz' }),
    store: store.store,
    readBacklog: async () => [],
    write: async () => {},
    ...extra
});

describe('SEC feed: every item stored before matching', () => {
    test('every item is stored, not only the ones naming a watched party', async () => {
        const store = memoryStore();
        const out = await runFeedTask(input(), io(store));
        expect(out.ingestError).toBeNull();
        expect(out.processingError).toBeNull();
        expect(store.rows.size).toBe(ITEMS.length);
        expect(out.rows).toHaveLength(1);
        expect(out.events).toHaveLength(1);
        expect([...store.rows.values()][0]).toMatchObject({ source: 'sec-lr', publishedDate: ITEMS[0].dateFiled });
    });

    test('a processing write that throws leaves every item stored and the in-memory cases untouched', async () => {
        const store = memoryStore();
        const previous = new Map();
        const out = await runFeedTask(input({ previous }), io(store, { write: async () => { throw new Error('psql exited 3 on feed sec-lr'); } }));
        expect(out.ingestError).toBeNull();
        expect(out.processingError).toEqual({ step: 'record-cases', message: 'psql exited 3 on feed sec-lr' });
        expect(store.rows.size).toBe(ITEMS.length);
        expect(previous.size).toBe(0);
        expect(out.events).toEqual([]);
    });

    test('the next run matches the stored backlog: an item gone from the feed still raises its event', async () => {
        const wavemark = ITEMS.find((i) => i.caseName.includes('Wavemark'));
        const rest = ITEMS.filter((i) => i !== wavemark);
        const written = [];
        const out = await runFeedTask(input(), io(memoryStore(), {
            fetch: async () => SEC_XML.replace(/<item>(?:(?!<item>)[\s\S])*?Wavemark[\s\S]*?<\/item>/, ''),
            readBacklog: async () => [{ notice: wavemark }],
            write: async (s) => { written.push(...s); }
        }));
        expect(out.items).toHaveLength(rest.length);
        expect(out.backlogCount).toBe(1);
        expect(out.events).toHaveLength(1);
        expect(written.join('\n')).toContain('SET matched_at');
    });

    test('a body that will not parse is kept for replay; a store that fails keeps the body and still matches', async () => {
        const kept = [];
        const keepPending = async (xml) => { kept.push(xml); return { path: 'pending/y.xml.gz' }; };
        const broken = await runFeedTask(input(), io(memoryStore(), { fetch: async () => '<html>maintenance</html>', keepPending }));
        expect(broken.ingestError.step).toBe('parse');
        expect(kept).toEqual(['<html>maintenance</html>']);

        const unstored = await runFeedTask(input(), io(memoryStore(), { store: async () => { throw new Error('connection refused'); }, keepPending }));
        expect(unstored.ingestError.step).toBe('store-notices');
        expect(kept).toHaveLength(2);
        expect(unstored.processingError).toBeNull();
        expect(unstored.events).toHaveLength(1);
    });

    test('an unreadable state stops only processing: the feed is fetched and every item stored', async () => {
        const store = memoryStore();
        const out = await runFeedTask(input({ stateError: 'psql exited 2 on read cases' }),
            io(store, { readBacklog: async () => { throw new Error('must not be read'); }, write: async () => { throw new Error('must not be written'); } }));
        expect(store.rows.size).toBe(ITEMS.length);
        expect(out.processingError.step).toBe('read-state');
    });

    test('a repeat read of an unchanged feed stores nothing new', async () => {
        const store = memoryStore();
        const first = await runFeedTask(input(), io(store));
        const second = await runFeedTask(input(), io(store));
        expect(first.inserted).toBe(ITEMS.length);
        expect(second.inserted).toBe(0);
        expect(feedItemRows(FEED, ITEMS).map((r) => r.noticeId)).toEqual(ITEMS.map(FEED_ITEM_KEYS.idOf));
    });
});
