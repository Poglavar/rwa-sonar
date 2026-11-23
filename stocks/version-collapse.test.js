// Tests for the collapse of stored versions that were only noise (lib/version-collapse.mjs and
// stocks/collapse-noise-versions.mjs `planFromRows`): consecutive versions reading the same under
// the current normaliser collapse into the earliest, and nothing the state, the change events or
// the change judge stand on is ever deleted; a second run finds nothing.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planFromRows } from './collapse-noise-versions.mjs';
import { planCollapse, protectedVersionIds, versionText } from './lib/version-collapse.mjs';
import { sourceId } from './lib/watch.mjs';

const v = (id, text) => ({ id, sourceId: 's', text });

describe('planCollapse', () => {
    test('a run of equal versions collapses into its first; a real change starts a new run', () => {
        const plan = planCollapse([v(1, 'a'), v(2, 'a'), v(3, 'a'), v(4, 'b'), v(5, 'b'), v(6, 'c')]);
        expect(plan).toEqual([
            { id: 2, sourceId: 's', keptId: 1 }, { id: 3, sourceId: 's', keptId: 1 }, { id: 5, sourceId: 's', keptId: 4 }
        ]);
    });

    test('the newest version is never deleted, even when it equals the one before', () => {
        expect(planCollapse([v(1, 'a'), v(2, 'a')])).toEqual([]);
    });

    test('a version nobody can read again breaks the chain on both sides', () => {
        expect(planCollapse([v(1, 'a'), v(2, null), v(3, 'a'), v(4, 'z')])).toEqual([]);
    });

    test('protected versions stay, and the next equal one collapses into them', () => {
        expect(planCollapse([v(1, 'a'), v(2, 'a'), v(3, 'a'), v(4, 'z')], { protectedIds: new Set([2]) })).toEqual([{ id: 3, sourceId: 's', keptId: 2 }]);
    });

    test('a change event protects the version it cites and the one before it', () => {
        const rows = new Map([['s', [{ id: 1, fetchedAt: '2026-11-20T04:00:00Z' }, { id: 2, fetchedAt: '2026-11-21T04:00:00Z' }, { id: 3, fetchedAt: '2026-11-22T04:00:00Z' }]]]);
        expect([...protectedVersionIds(rows, [{ sourceId: 's', versionFetchedAt: '2026-11-21T04:00:00.412Z' }])].sort()).toEqual([1, 2]);
        expect([...protectedVersionIds(rows, [{ sourceId: 's', versionFetchedAt: '2026-10-01T00:00:00Z' }])]).toEqual([]);
    });
});

describe('planFromRows over kept files', () => {
    let root;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'version-collapse-'));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    // Four versions of a Backpack-ticker-shaped API answer: the first three differ only by price
    // and trade count, the fourth adds a market (a real change).
    const URL_ = 'https://api.backpack.exchange/api/v1/ticker?symbol=SPCX.US_USDC';
    const ID = sourceId(URL_);
    const payloads = [
        { symbol: 'SPCX.US_USDC', lastPrice: '130.93', trades: '119' },
        { symbol: 'SPCX.US_USDC', lastPrice: '131.46', trades: '40' },
        { symbol: 'SPCX.US_USDC', lastPrice: '129.10', trades: '77' },
        { symbol: 'SPCX.US_USDC', lastPrice: '129.10', trades: '77', status: 'halted' }
    ];
    function setup({ pruneFirst = false } = {}) {
        mkdirSync(join(root, 'stocks', 'data', 'sources', ID), { recursive: true });
        return payloads.map((p, i) => {
            const stamp = `2026-11-2${i}T04-00-00Z`;
            const rawPath = `stocks/data/sources/${ID}/${stamp}.json`;
            if (!(pruneFirst && i === 0)) writeFileSync(join(root, rawPath), JSON.stringify(p));
            return { id: i + 1, sourceId: ID, url: URL_, readVia: 'api', rawPath, textPath: rawPath.replace('.json', '.txt'), bytes: 50, fetchedAt: `2026-11-2${i}T04:00:00Z` };
        });
    }

    test('the price-only versions collapse; the real change and the newest stay', async () => {
        const plan = await planFromRows(setup(), [], { root });
        expect(plan.doomed.map((d) => [d.id, d.keptId])).toEqual([[2, 1], [3, 1]]);
        expect(plan.checked).toBe(4);
    });

    test('a pruned file and a cited version are never collapsed across', async () => {
        const pruned = await planFromRows(setup({ pruneFirst: true }), [], { root });
        expect(pruned.doomed.map((d) => d.id)).toEqual([3]);
        expect(pruned.unreadable).toBe(1);
        const cited = await planFromRows(setup(), [{ subjectType: 'source', subjectId: ID, versionFetchedAt: '2026-11-22T04:00:00.120Z' }], { root });
        // Version 3 is cited and version 2 is the judge's "before" for it, so nothing is collapsed.
        expect(cited.doomed).toEqual([]);
    });

    test('a quote-lost citation finds its source by URL', async () => {
        const plan = await planFromRows(setup(), [{ subjectType: 'claim', subjectId: 'c1', url: URL_, versionFetchedAt: '2026-11-21T04:00:00Z' }], { root });
        expect(plan.doomed.map((d) => d.id)).toEqual([3]);
    });

    test('a rerun after the delete finds nothing', async () => {
        const rows = setup();
        const first = await planFromRows(rows, [], { root });
        const gone = new Set(first.doomed.map((d) => d.id));
        for (const d of first.doomed) rmSync(join(root, d.rawPath));
        const second = await planFromRows(rows.filter((r) => !gone.has(r.id)), [], { root });
        expect(second.doomed).toEqual([]);
    });

    test('versionText reads HTML and JSON copies, and not PDFs or readers it cannot reproduce', async () => {
        const rows = setup();
        expect(await versionText({ root, ...rows[0] })).toContain('"lastPrice": "•"');
        expect(await versionText({ root, ...rows[0], readVia: 'companion' })).toBeNull();
        expect(await versionText({ root, ...rows[0], rawPath: 'stocks/data/sources/x/a.pdf', readVia: 'pdf' })).toBeNull();
        expect(await versionText({ root, ...rows[0], rawPath: 'stocks/data/sources/x/missing.json' })).toBeNull();
    });
});
