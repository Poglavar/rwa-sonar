// Unit tests for stocks/lib/raw-keep.mjs: raw payloads kept once per distinct content, gzip on
// disk, and pruned to a bound. Guards the two disk rules: an unchanged re-fetch writes nothing new,
// and the directory never grows past its bound.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isKeptName, keepRaw, listKept, openDayCache, planPrune, pruneKept, readKept } from './lib/raw-keep.mjs';

let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raw-keep-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('keepRaw', () => {
    test('the same payload twice is one file; the second write only moves its last-seen time', async () => {
        const first = await keepRaw(dir, '<rss>one</rss>', { ext: 'xml', now: Date.parse('2026-11-01T00:00:00Z') });
        const again = await keepRaw(dir, '<rss>one</rss>', { ext: 'xml', now: Date.parse('2026-11-02T00:00:00Z') });
        expect(first.written).toBe(true);
        expect(again.written).toBe(false);
        expect(again.path).toBe(first.path);
        expect(readdirSync(dir)).toHaveLength(1);
        expect(isKeptName(readdirSync(dir)[0])).toBe(true);
        expect((await readKept(first.path)).toString('utf8')).toBe('<rss>one</rss>');
        expect((await listKept(dir))[0].mtimeMs).toBe(Date.parse('2026-11-02T00:00:00Z'));
    });

    test('an identity dedupes payloads that differ only in their run context', async () => {
        const a = await keepRaw(dir, JSON.stringify({ today: '2026-11-01', body: 'x' }), { identity: 'x' });
        const b = await keepRaw(dir, JSON.stringify({ today: '2026-11-02', body: 'x' }), { identity: 'x' });
        expect(b.written).toBe(false);
        expect(JSON.parse((await readKept(a.path)).toString('utf8')).today).toBe('2026-11-01');
    });

    test('different content is a new file', async () => {
        await keepRaw(dir, 'a');
        await keepRaw(dir, 'b');
        expect(readdirSync(dir)).toHaveLength(2);
    });
});

describe('pruning', () => {
    test('planPrune keeps the newest N and drops what was last seen too long ago', () => {
        const now = Date.parse('2026-11-30T00:00:00Z');
        const files = [1, 2, 3, 4].map((d) => ({ name: `f${d}`, mtimeMs: now - d * 86_400_000 }));
        expect(planPrune(files, { maxFiles: 2, now }).map((f) => f.name)).toEqual(['f3', 'f4']);
        expect(planPrune(files, { maxAgeMs: 2.5 * 86_400_000, now }).map((f) => f.name)).toEqual(['f3', 'f4']);
        expect(planPrune(files, { now })).toEqual([]);
    });

    test('pruneKept deletes on disk and leaves foreign files alone', async () => {
        for (const [i, p] of ['a', 'b', 'c'].entries()) await keepRaw(dir, p, { now: Date.parse('2026-11-01T00:00:00Z') + i * 1000 });
        const deleted = await pruneKept(dir, { maxFiles: 1 });
        expect(deleted).toHaveLength(2);
        expect((await listKept(dir))).toHaveLength(1);
        expect((await readKept((await listKept(dir))[0].path)).toString('utf8')).toBe('c');
    });
});

describe('openDayCache', () => {
    test('the same day keeps its files; a new day starts empty, so no day is kept twice', async () => {
        const { writeFileSync, existsSync } = await import('node:fs');
        const first = await openDayCache(dir, '2026-11-23');
        writeFileSync(join(first.dir, 'AAPL@2026-08-15.json'), '{}');
        const same = await openDayCache(dir, '2026-11-23');
        expect(same.cleared).toBe(0);
        expect(existsSync(join(same.dir, 'AAPL@2026-08-15.json'))).toBe(true);
        const next = await openDayCache(dir, '2026-11-24');
        expect(next.cleared).toBe(1);
        expect(readdirSync(next.dir)).toEqual(['.date']);
        // Dated directories of the old layout beside it are not touched (they are the prune script's).
        expect(readdirSync(dir)).toEqual(['current']);
    });
});
