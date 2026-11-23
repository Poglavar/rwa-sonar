// Tests for the document watcher's per-day check history (stocks/lib/check-history.mjs) and the
// prune that deletes the old daily checkpoints only once the history reproduces them
// (stocks/prune-run-caches.mjs `pruneRunCaches`): extraction completeness, refusal when a
// checkpoint is not covered, and a rerun that changes nothing.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkpointRows, checkRow, compileHistory, expandHistory, parseHistory, uncoveredRows } from './lib/check-history.mjs';
import { pruneRunCaches } from './prune-run-caches.mjs';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

function result(url, id, over = {}) {
    return {
        id, url, title: 'T', issuer: 'x', foundIn: ['x:documents[0].url'], kind: 'html', fetchedAt: '2026-11-01T04:00:00.000Z',
        httpStatus: 200, contentHash: H1, etag: '"e"', status: 'ok', reason: 'same hash', error: null, diff: null, via: 'html', ...over
    };
}

// Three days: source A unchanged throughout, B changes on day 2 and is blocked on day 3, C is
// missing on day 2 (not looked at) and has a lost quote on day 3.
function checkpoints() {
    return {
        '2026-11-01': {
            'https://a/': result('https://a/', 'aaaaaaaaaaaa'),
            'https://b/': result('https://b/', 'bbbbbbbbbbbb'),
            'https://c/': result('https://c/', 'cccccccccccc')
        },
        '2026-11-02': {
            'https://a/': result('https://a/', 'aaaaaaaaaaaa'),
            'https://b/': result('https://b/', 'bbbbbbbbbbbb', { status: 'changed', reason: 'new hash', contentHash: H2, diff: { summary: '+3 −1' } })
        },
        '2026-11-03': {
            'https://a/': result('https://a/', 'aaaaaaaaaaaa'),
            'https://b/': result('https://b/', 'bbbbbbbbbbbb', { status: 'blocked', httpStatus: 403, contentHash: H2, via: null, reason: 'http-403 (bot wall)', error: 'http-403 (bot wall)' }),
            'https://c/': result('https://c/', 'cccccccccccc', { quotes: { checked: 2, found: 1, lost: [{ id: 'q2' }] } })
        }
    };
}

let dir;
let rawDir;
let historyFile;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-history-'));
    rawDir = join(dir, 'raw');
    historyFile = join(dir, 'source-check-history.json');
    mkdirSync(join(rawDir, 'corporate-actions', '2026-11-01'), { recursive: true });
    writeFileSync(join(rawDir, 'corporate-actions', '2026-11-01', 'AAPL.json'), '{}');
    for (const [date, doc] of Object.entries(checkpoints())) writeFileSync(join(rawDir, `sources-${date}.json`), JSON.stringify(doc));
    // Today's checkpoint is kept and not extracted.
    writeFileSync(join(rawDir, 'sources-2026-11-23.json'), JSON.stringify({ 'https://a/': result('https://a/', 'aaaaaaaaaaaa') }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const prune = (apply) => pruneRunCaches({ rawDir, historyFile, today: '2026-11-23', apply });
const onDisk = () => parseHistory(JSON.parse(readFileSync(historyFile, 'utf8')));

describe('checkRow', () => {
    test('keeps status, http status, a hash prefix, error, reader and lost quotes; nothing stored elsewhere', () => {
        expect(checkRow(result('https://a/', 'aaaaaaaaaaaa'))).toEqual({
            status: 'ok', httpStatus: 200, contentHash: H1.slice(0, 16), error: null, via: 'html', quotesLost: null
        });
        // A non-read keeps its reason as the error when the checkpoint has no error text.
        expect(checkRow(result('https://a/', 'a', { status: 'reachable-unverified', reason: 'couldn\'t read (script-only page)' })).error)
            .toBe('couldn\'t read (script-only page)');
        expect(checkRow(result('https://a/', 'a', { quotes: { lost: [{ id: 'z' }, { id: 'y' }] } })).quotesLost).toEqual(['y', 'z']);
    });

    test('a result without id or status, or a checkpoint that is not keyed by URL, is an error, not an empty day', () => {
        expect(() => checkRow({ url: 'https://a/' })).toThrow(/not a source result/);
        expect(() => checkpointRows([result('https://a/', 'a')])).toThrow(/keyed by URL/);
        expect(() => checkpointRows({ 'https://a/': result('https://a/', 'a'), 'https://b/': result('https://b/', 'a') })).toThrow(/twice/);
    });
});

describe('compileHistory / expandHistory', () => {
    test('equal consecutive days are one run; a change or a day not looked at starts a new run; expanding gives every day back', () => {
        const days = new Map(Object.entries(checkpoints()).map(([d, doc]) => [d, checkpointRows(doc)]));
        const history = compileHistory(days);
        expect(history.sources.aaaaaaaaaaaa).toHaveLength(1);
        expect(history.sources.aaaaaaaaaaaa[0].slice(0, 2)).toEqual(['2026-11-01', '2026-11-03']);
        expect(history.sources.bbbbbbbbbbbb.map((r) => r[2])).toEqual(['ok', 'changed', 'blocked']);
        expect(history.sources.cccccccccccc.map((r) => r.slice(0, 2))).toEqual([['2026-11-01', '2026-11-01'], ['2026-11-03', '2026-11-03']]);
        const expanded = expandHistory(history);
        for (const [date, rows] of days) expect(uncoveredRows(expanded, date, rows)).toEqual([]);
        expect(expanded.get('2026-11-02').has('cccccccccccc')).toBe(false);
    });

    test('a history that lost a source, a value or a day is reported, not passed', () => {
        const days = new Map(Object.entries(checkpoints()).map(([d, doc]) => [d, checkpointRows(doc)]));
        const history = compileHistory(days);
        const tampered = JSON.parse(JSON.stringify(history));
        delete tampered.sources.cccccccccccc;
        tampered.sources.bbbbbbbbbbbb[2][3] = 429;
        const expanded = expandHistory(tampered);
        expect(uncoveredRows(expanded, '2026-11-01', days.get('2026-11-01'))).toEqual([{ id: 'cccccccccccc', problem: 'missing' }]);
        expect(uncoveredRows(expanded, '2026-11-03', days.get('2026-11-03'))).toEqual([
            { id: 'bbbbbbbbbbbb', problem: 'differs' }, { id: 'cccccccccccc', problem: 'missing' }
        ]);
        expect(uncoveredRows(expanded, '2026-11-04', days.get('2026-11-03'))[0].problem).toMatch(/not in the history/);
    });
});

describe('pruneRunCaches', () => {
    test('dry run writes and deletes nothing', async () => {
        const r = await prune(false);
        expect(r.refused).toBe(false);
        expect(r.doomed).toHaveLength(4);
        expect(existsSync(historyFile)).toBe(false);
        expect(existsSync(join(rawDir, 'sources-2026-11-01.json'))).toBe(true);
    });

    test('apply: the history on disk reproduces every deleted checkpoint exactly, then they are gone', async () => {
        const r = await prune(true);
        expect(r.refused).toBe(false);
        expect(r.removed.map((e) => e.name).sort()).toEqual(['2026-11-01', 'sources-2026-11-01.json', 'sources-2026-11-02.json', 'sources-2026-11-03.json']);
        const expanded = expandHistory(onDisk());
        expect(onDisk().dates).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
        // Completeness, checked independently of the prune's own verification: every result of
        // every checkpoint, field by field.
        for (const [date, doc] of Object.entries(checkpoints())) {
            const day = expanded.get(date);
            expect(day.size).toBe(Object.keys(doc).length);
            for (const res of Object.values(doc)) expect(day.get(res.id)).toEqual(checkRow(res));
        }
        expect(existsSync(join(rawDir, 'sources-2026-11-02.json'))).toBe(false);
        expect(existsSync(join(rawDir, 'corporate-actions', '2026-11-01'))).toBe(false);
        expect(existsSync(join(rawDir, 'sources-2026-11-23.json'))).toBe(true);
    });

    test('a checkpoint that cannot be extracted refuses the whole delete: nothing is removed, no history written', async () => {
        writeFileSync(join(rawDir, 'sources-2026-11-02.json'), '{"https://a/": {"url": "https://a/"');
        const r = await prune(true);
        expect(r.refused).toBe(true);
        expect(r.failures.map((f) => f.name)).toEqual(['sources-2026-11-02.json']);
        expect(r.removed).toEqual([]);
        for (const d of ['01', '02', '03']) expect(existsSync(join(rawDir, `sources-2026-11-${d}.json`))).toBe(true);
        expect(existsSync(join(rawDir, 'corporate-actions', '2026-11-01'))).toBe(true);
        expect(existsSync(historyFile)).toBe(false);

        // A result the extraction cannot read (no status) is refused the same way.
        writeFileSync(join(rawDir, 'sources-2026-11-02.json'), JSON.stringify({ 'https://a/': { id: 'aaaaaaaaaaaa', url: 'https://a/' } }));
        expect((await prune(true)).refused).toBe(true);
        expect(existsSync(join(rawDir, 'sources-2026-11-01.json'))).toBe(true);
    });

    test('a rerun is a no-op: nothing left to delete and the history file is not rewritten', async () => {
        await prune(true);
        const before = readFileSync(historyFile, 'utf8');
        const mtime = statSync(historyFile).mtimeMs;
        const again = await prune(true);
        expect(again.refused).toBe(false);
        expect(again.doomed).toEqual([]);
        expect(readFileSync(historyFile, 'utf8')).toBe(before);
        expect(statSync(historyFile).mtimeMs).toBe(mtime);
    });

    test('a checkpoint left behind (a delete that did not happen) merges into the history without duplicating its day', async () => {
        await prune(true);
        writeFileSync(join(rawDir, 'sources-2026-11-02.json'), JSON.stringify(checkpoints()['2026-11-02']));
        const before = readFileSync(historyFile, 'utf8');
        const r = await prune(true);
        expect(r.refused).toBe(false);
        expect(readFileSync(historyFile, 'utf8')).toBe(before);
        expect(existsSync(join(rawDir, 'sources-2026-11-02.json'))).toBe(false);
    });
});
