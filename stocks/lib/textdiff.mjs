// Pure line diff for the document watcher (EVIDENCE.md §2.1): given the previous and the current
// normalised text of a source, produce the unified-style diff a human reads, the changed lines the
// keyword-severity check reads, and the added/removed counts stored on the version row. No IO, no
// dependency; unit tested in ../textdiff.test.js.
//
// Exactness first, then a bound: a full LCS is used while the changed region is small enough to
// hold a backtrack table, and above that the region is split on lines that occur exactly once on
// both sides (patience anchors) and each gap is diffed on its own. A region with no anchors that
// is still too large is emitted as one replace block — still correct about what was added and
// removed, just coarser about the pairing. `method` always says which happened.

/** Context lines kept around each hunk, as in `diff -u`. */
const CONTEXT = 3;

/** Above this many LCS table cells, split on patience anchors instead. 4M cells = 16 MB table. */
const MAX_CELLS = 4_000_000;

/** Split into lines without inventing a trailing empty line for a file that ends in a newline. */
export function toLines(text) {
    if (typeof text !== 'string' || text === '') return [];
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/** Longest increasing subsequence of `values`, returned as indices into `values`. */
function longestIncreasing(values) {
    const tails = [];
    const tailIndex = [];
    const previous = new Array(values.length).fill(-1);
    for (let i = 0; i < values.length; i += 1) {
        const v = values[i];
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (tails[mid] < v) lo = mid + 1;
            else hi = mid;
        }
        tails[lo] = v;
        tailIndex[lo] = i;
        previous[i] = lo > 0 ? tailIndex[lo - 1] : -1;
    }
    const out = [];
    let cursor = tails.length ? tailIndex[tails.length - 1] : -1;
    while (cursor !== -1) {
        out.push(cursor);
        cursor = previous[cursor];
    }
    return out.reverse();
}

/** Lines occurring exactly once in both slices, as `[aOffset, bOffset]` pairs in a order. */
function uniqueAnchors(a, b, aStart, aEnd, bStart, bEnd) {
    const countA = new Map();
    const countB = new Map();
    for (let i = aStart; i < aEnd; i += 1) countA.set(a[i], (countA.get(a[i]) ?? 0) + 1);
    for (let j = bStart; j < bEnd; j += 1) countB.set(b[j], (countB.get(b[j]) ?? 0) + 1);
    const posB = new Map();
    for (let j = bStart; j < bEnd; j += 1) if (countB.get(b[j]) === 1) posB.set(b[j], j);
    const pairs = [];
    for (let i = aStart; i < aEnd; i += 1) {
        if (countA.get(a[i]) !== 1) continue;
        const j = posB.get(a[i]);
        if (j === undefined) continue;
        pairs.push([i, j]);
    }
    const keep = longestIncreasing(pairs.map(([, j]) => j));
    return keep.map((k) => pairs[k]);
}

/** Full LCS over the two slices, appended to `ops` as eq/del/add in order. Cost O(n*m). */
function lcsOps(a, b, aStart, aEnd, bStart, bEnd, ops) {
    const n = aEnd - aStart;
    const m = bEnd - bStart;
    const width = m + 1;
    const table = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            table[i * width + j] = a[aStart + i] === b[bStart + j]
                ? table[(i + 1) * width + (j + 1)] + 1
                : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[aStart + i] === b[bStart + j]) {
            ops.push({ type: 'eq', text: a[aStart + i], a: aStart + i, b: bStart + j });
            i += 1;
            j += 1;
        } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
            ops.push({ type: 'del', text: a[aStart + i], a: aStart + i, b: null });
            i += 1;
        } else {
            ops.push({ type: 'add', text: b[bStart + j], a: null, b: bStart + j });
            j += 1;
        }
    }
    for (; i < n; i += 1) ops.push({ type: 'del', text: a[aStart + i], a: aStart + i, b: null });
    for (; j < m; j += 1) ops.push({ type: 'add', text: b[bStart + j], a: null, b: bStart + j });
}

/** Everything removed, everything added: correct counts, no pairing. */
function blockOps(a, b, aStart, aEnd, bStart, bEnd, ops) {
    for (let i = aStart; i < aEnd; i += 1) ops.push({ type: 'del', text: a[i], a: i, b: null });
    for (let j = bStart; j < bEnd; j += 1) ops.push({ type: 'add', text: b[j], a: null, b: j });
}

/** Diff one region, choosing LCS, patience split or a replace block by size. */
function regionOps(a, b, aStart, aEnd, bStart, bEnd, ops, state) {
    const n = aEnd - aStart;
    const m = bEnd - bStart;
    if (n === 0 && m === 0) return;
    if (n === 0 || m === 0) {
        blockOps(a, b, aStart, aEnd, bStart, bEnd, ops);
        return;
    }
    if (n * m <= MAX_CELLS) {
        lcsOps(a, b, aStart, aEnd, bStart, bEnd, ops);
        return;
    }
    const anchors = uniqueAnchors(a, b, aStart, aEnd, bStart, bEnd);
    if (anchors.length === 0) {
        state.method = 'block';
        blockOps(a, b, aStart, aEnd, bStart, bEnd, ops);
        return;
    }
    if (state.method === 'lcs') state.method = 'patience';
    let ai = aStart;
    let bi = bStart;
    for (const [aAnchor, bAnchor] of anchors) {
        regionOps(a, b, ai, aAnchor, bi, bAnchor, ops, state);
        ops.push({ type: 'eq', text: a[aAnchor], a: aAnchor, b: bAnchor });
        ai = aAnchor + 1;
        bi = bAnchor + 1;
    }
    regionOps(a, b, ai, aEnd, bi, bEnd, ops, state);
}

/** Group ops into unified hunks with `CONTEXT` lines of context. */
function toHunks(ops) {
    const interesting = [];
    ops.forEach((op, index) => {
        if (op.type !== 'eq') interesting.push(index);
    });
    if (interesting.length === 0) return [];
    const hunks = [];
    let start = Math.max(0, interesting[0] - CONTEXT);
    let end = Math.min(ops.length, interesting[0] + CONTEXT + 1);
    for (const index of interesting.slice(1)) {
        if (index - CONTEXT <= end) {
            end = Math.min(ops.length, index + CONTEXT + 1);
        } else {
            hunks.push([start, end]);
            start = Math.max(0, index - CONTEXT);
            end = Math.min(ops.length, index + CONTEXT + 1);
        }
    }
    hunks.push([start, end]);
    return hunks;
}

/**
 * Unified-style diff of two texts.
 *
 * Returns `{changed, added, removed, changedLines, removedLines, addedLines, unified, truncated, method}`:
 * - `changedLines` are the added and removed line texts, which is what the keyword-severity
 *   check in lib/watch.mjs looks at — deliberately not the context lines, so an unrelated
 *   paragraph moving past a keyword cannot raise the severity; `removedLines` / `addedLines` are
 *   the same split by side, so the severity check can pair a removed line with its re-added
 *   twin that differs only in a ticker price or a relative time;
 * - `unified` is capped at `maxLines` output lines, with a final marker saying what was elided,
 *   because this string is stored on the version row and shown on a page;
 * - `method` is `lcs` (exact), `patience` (exact within anchored gaps) or `block` (a region too
 *   large with no unique line to anchor on: counts right, pairing coarse).
 */
export function diffLines(beforeText, afterText, { maxLines = 400 } = {}) {
    const a = toLines(beforeText);
    const b = toLines(afterText);

    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix
        && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;

    const state = { method: 'lcs' };
    const ops = [];
    for (let i = 0; i < prefix; i += 1) ops.push({ type: 'eq', text: a[i], a: i, b: i });
    regionOps(a, b, prefix, a.length - suffix, prefix, b.length - suffix, ops, state);
    for (let k = 0; k < suffix; k += 1) {
        const i = a.length - suffix + k;
        ops.push({ type: 'eq', text: a[i], a: i, b: b.length - suffix + k });
    }

    const added = ops.filter((op) => op.type === 'add');
    const removed = ops.filter((op) => op.type === 'del');
    const removedLines = removed.map((op) => op.text);
    const addedLines = added.map((op) => op.text);
    const changedLines = [...removedLines, ...addedLines];

    const out = [];
    let truncated = 0;
    for (const [start, end] of toHunks(ops)) {
        const slice = ops.slice(start, end);
        const aLines = slice.filter((op) => op.type !== 'add');
        const bLines = slice.filter((op) => op.type !== 'del');
        const aFrom = aLines.length ? aLines[0].a + 1 : 0;
        const bFrom = bLines.length ? bLines[0].b + 1 : 0;
        const header = `@@ -${aFrom},${aLines.length} +${bFrom},${bLines.length} @@`;
        if (out.length + 1 + slice.length > maxLines) {
            truncated += slice.length;
            continue;
        }
        out.push(header);
        for (const op of slice) {
            out.push(`${op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '}${op.text}`);
        }
    }
    if (truncated > 0) out.push(`… ${truncated} further diff line(s) not shown (cap ${maxLines})`);

    return {
        changed: added.length > 0 || removed.length > 0,
        added: added.length,
        removed: removed.length,
        changedLines,
        removedLines,
        addedLines,
        unified: out.join('\n'),
        truncated: truncated > 0,
        method: state.method
    };
}

/** One-line summary for `source_version.diff_summary`. */
export function summariseDiff(diff) {
    if (!diff.changed) return 'no line changed';
    return `+${diff.added} -${diff.removed} line(s)${diff.method === 'lcs' ? '' : ` (${diff.method})`}`;
}
