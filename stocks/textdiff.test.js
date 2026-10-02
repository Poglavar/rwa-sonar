// Unit tests for stocks/lib/textdiff.mjs — the line diff a document change is reported with, and
// whose `changedLines` decide the keyword severity. The properties that matter: the counts are the
// real counts, the changed lines are ONLY the added and removed ones (so a keyword sitting in
// unchanged context cannot raise a severity), the unified output is capped because it is stored and
// displayed, and a region too large for an exact LCS degrades to an anchored or block diff that is
// still honest about what moved — and says which method produced it.

import { diffLines, summariseDiff, toLines } from './lib/textdiff.mjs';

describe('toLines', () => {
    test('a trailing newline does not invent an empty last line', () => {
        expect(toLines('a\nb\n')).toEqual(['a', 'b']);
        expect(toLines('a\nb')).toEqual(['a', 'b']);
        expect(toLines('')).toEqual([]);
        expect(toLines(null)).toEqual([]);
    });
});

describe('an unchanged document', () => {
    test('reports no change, no counts and no diff text', () => {
        const text = 'Terms of Service\nFees may change.\nGoverning law: England.';
        const diff = diffLines(text, text);
        expect(diff.changed).toBe(false);
        expect(diff.added).toBe(0);
        expect(diff.removed).toBe(0);
        expect(diff.changedLines).toEqual([]);
        expect(diff.unified).toBe('');
        expect(summariseDiff(diff)).toBe('no line changed');
    });
});

describe('a one-line edit', () => {
    const before = 'Terms\nRedemption fee: 0 bps\nGoverning law: England\nEnd';
    const after = 'Terms\nRedemption fee: 50 bps\nGoverning law: England\nEnd';
    const diff = diffLines(before, after);

    test('counts one added and one removed line', () => {
        expect(diff.changed).toBe(true);
        expect(diff.added).toBe(1);
        expect(diff.removed).toBe(1);
        expect(diff.method).toBe('lcs');
        expect(summariseDiff(diff)).toBe('+1 -1 line(s)');
    });

    test('changedLines are the two changed lines only, never the context', () => {
        expect(diff.changedLines).toEqual(['Redemption fee: 0 bps', 'Redemption fee: 50 bps']);
        expect(diff.changedLines.join('\n')).not.toMatch(/Governing law/);
    });

    test('the unified body marks -old and +new and keeps the context around them', () => {
        expect(diff.unified.split('\n')).toEqual([
            '@@ -1,4 +1,4 @@',
            ' Terms',
            '-Redemption fee: 0 bps',
            '+Redemption fee: 50 bps',
            ' Governing law: England',
            ' End'
        ]);
    });
});

describe('insertions and deletions', () => {
    test('an inserted clause is added with nothing removed', () => {
        const diff = diffLines('a\nb\nc', 'a\nb\nNEW CLAUSE\nc');
        expect([diff.added, diff.removed]).toEqual([1, 0]);
        expect(diff.changedLines).toEqual(['NEW CLAUSE']);
    });

    test('a deleted clause is removed with nothing added', () => {
        const diff = diffLines('a\nGONE\nb', 'a\nb');
        expect([diff.added, diff.removed]).toEqual([0, 1]);
        expect(diff.changedLines).toEqual(['GONE']);
    });

    test('an empty previous version makes every line an addition', () => {
        const diff = diffLines('', 'one\ntwo');
        expect([diff.added, diff.removed]).toEqual([2, 0]);
    });
});

describe('line numbers and distant hunks', () => {
    const before = ['keep', ...Array.from({ length: 20 }, (_, i) => `line ${i}`), 'tail'].join('\n');
    const after = before.replace('line 0', 'line ZERO').replace('line 19', 'line NINETEEN');

    test('two far-apart edits become two hunks, each numbered from the real line', () => {
        const diff = diffLines(before, after);
        const headers = diff.unified.split('\n').filter((l) => l.startsWith('@@'));
        expect(headers).toHaveLength(2);
        // First hunk starts at line 1 (`keep` is the only context before `line 0`).
        expect(headers[0]).toMatch(/^@@ -1,\d+ \+1,\d+ @@$/);
        // Second hunk starts deep in the file, not at 1.
        expect(headers[1]).toMatch(/^@@ -18,\d+ \+18,\d+ @@$/);
        expect([diff.added, diff.removed]).toEqual([2, 2]);
    });
});

describe('the output cap', () => {
    const before = Array.from({ length: 300 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 300 }, (_, i) => `new ${i}`).join('\n');

    test('the unified text is capped while the counts stay complete', () => {
        const diff = diffLines(before, after, { maxLines: 20 });
        expect(diff.added).toBe(300);
        expect(diff.removed).toBe(300);
        expect(diff.truncated).toBe(true);
        const lines = diff.unified.split('\n');
        expect(lines.length).toBeLessThanOrEqual(21);
        expect(lines[lines.length - 1]).toMatch(/further diff line\(s\) not shown \(cap 20\)/);
        // And all 600 changed lines are still available to the keyword check.
        expect(diff.changedLines).toHaveLength(600);
    });

    test('the default cap is 400 lines', () => {
        const diff = diffLines(before, after);
        expect(diff.unified.split('\n').length).toBeLessThanOrEqual(401);
    });
});

describe('regions too large for an exact LCS', () => {
    // 2500 changed lines on each side is 6.25M table cells, past the 4M cap: the differ must not
    // try to allocate that. With a unique line every ten rows it can anchor on those instead.
    const lines = (prefix) => Array.from({ length: 2500 }, (_, i) => (i % 10 === 0
        ? `ANCHOR-${i}` : `${prefix} body ${i}`));

    test('anchors on lines unique to both sides and still counts exactly', () => {
        const diff = diffLines(lines('old').join('\n'), lines('new').join('\n'));
        expect(diff.method).toBe('patience');
        // Every non-anchor line changed: 2500 - 250 anchors = 2250 on each side.
        expect(diff.added).toBe(2250);
        expect(diff.removed).toBe(2250);
        expect(diff.changedLines).toHaveLength(4500);
    });

    test('with nothing to anchor on it degrades to a block replace and says so', () => {
        const before = Array.from({ length: 2500 }, (_, i) => `only-in-a ${i}`).join('\n');
        const after = Array.from({ length: 2500 }, (_, i) => `only-in-b ${i}`).join('\n');
        const diff = diffLines(before, after);
        expect(diff.method).toBe('block');
        expect([diff.added, diff.removed]).toEqual([2500, 2500]);
        expect(summariseDiff(diff)).toBe('+2500 -2500 line(s) (block)');
    });

    test('a huge document with one edited line is still diffed exactly', () => {
        // The common prefix and suffix are trimmed first, so size is not what matters — the size
        // of the CHANGED region is.
        const body = Array.from({ length: 5000 }, (_, i) => `clause ${i}`);
        const before = body.join('\n');
        const changed = [...body];
        changed[2500] = 'clause 2500 — the custodian may be replaced without notice';
        const diff = diffLines(before, changed.join('\n'));
        expect(diff.method).toBe('lcs');
        expect([diff.added, diff.removed]).toEqual([1, 1]);
        expect(diff.unified.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(1);
    });
});
