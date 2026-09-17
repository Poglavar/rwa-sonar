// Unit tests for stocks/lib/funnel.mjs — the four-column funnel (mints → issuer programmes →
// control recipes → token programs) the stocks page draws. The small fixtures assert the counting
// rules: that every column's total is the mints represented in it, that the three edge hops conserve
// those mints, that an issuer with no mints is a node with count 0 and its status rather than a
// silent omission, and that a mint whose issuer we cannot name loses its two issuer edges instead of
// being invented into a programme. The last block reads the built stocks-funnel.json and pins it
// against the two databases it was built from.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildFunnel, instrumentNodeId, programNodeId, recipeNodeId } from './lib/funnel.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');

function readJson(name) {
    return JSON.parse(readFileSync(join(REPO_ROOT, name), 'utf8'));
}

/** A built token record, cut down to the fields the funnel reads. */
function token({ mint = 'MINT', issuer = 'xstocks-backed', instrumentType = 'stock', extensions = ['pausable'], program = 'token-2022' } = {}) {
    return {
        mint,
        issuer,
        instrumentType,
        tokenProgram: program,
        recipe: {
            program,
            extensions,
            label: `${program} · ${extensions.length ? extensions.join(' + ') : 'none'}`
        }
    };
}

function issuer({ slug = 'xstocks-backed', name = 'Kraken xStocks', status = 'live' } = {}) {
    return { slug, name, status };
}

function columnOf(funnel, key) {
    return funnel.columns.find((c) => c.key === key);
}

function nodeIds(funnel) {
    return new Set(funnel.columns.flatMap((c) => c.nodes.map((n) => n.id)));
}

describe('the shape of the funnel', () => {
    const funnel = buildFunnel(
        [
            token({ mint: 'A', instrumentType: 'stock' }),
            token({ mint: 'B', instrumentType: 'etf' }),
            token({ mint: 'C', issuer: 'tessera', instrumentType: 'private-company', extensions: ['transfer-fee'] })
        ],
        [issuer(), issuer({ slug: 'tessera', name: 'Tessera' })]
    );

    it('has the four columns, in reading order, with their headings', () => {
        expect(funnel.columns.map((c) => c.key)).toEqual(['tokens', 'issuers', 'recipes', 'programs']);
        expect(funnel.columns.map((c) => c.title)).toEqual([
            'Mints', 'Issuer programmes', 'Recipes (program + extensions)', 'Token program'
        ]);
    });

    it('gives every column a total that is the mints represented in it', () => {
        for (const column of funnel.columns) {
            expect(column.total).toBe(3);
            expect(column.nodes.reduce((sum, n) => sum + n.count, 0)).toBe(column.total);
        }
    });

    it('carries the fields each column’s nodes are drawn from', () => {
        expect(columnOf(funnel, 'tokens').nodes).toEqual(expect.arrayContaining([
            { id: instrumentNodeId('stock'), label: 'Stocks', count: 1, kind: 'instrument' }
        ]));
        expect(columnOf(funnel, 'issuers').nodes[0]).toEqual({
            id: 'xstocks-backed', label: 'Kraken xStocks', count: 2, status: 'live'
        });
        expect(columnOf(funnel, 'recipes').nodes[0]).toEqual({
            id: recipeNodeId('token-2022 · pausable'), label: 'token-2022 · pausable', count: 2
        });
        expect(columnOf(funnel, 'programs').nodes).toEqual([
            { id: programNodeId('token-2022'), label: 'Token-2022', count: 3 }
        ]);
    });

    it('sorts every column’s nodes by count, biggest first', () => {
        for (const column of funnel.columns) {
            const counts = column.nodes.map((n) => n.count);
            expect(counts).toEqual([...counts].sort((a, b) => b - a));
        }
    });

    it('connects instrument → issuer → recipe → program and nothing else', () => {
        const ids = nodeIds(funnel);
        for (const edge of funnel.edges) {
            expect(ids.has(edge.from)).toBe(true);
            expect(ids.has(edge.to)).toBe(true);
            expect(edge.count).toBeGreaterThan(0);
        }
        expect(funnel.edges).toEqual(expect.arrayContaining([
            { from: instrumentNodeId('etf'), to: 'xstocks-backed', count: 1 },
            { from: 'xstocks-backed', to: recipeNodeId('token-2022 · pausable'), count: 2 },
            { from: recipeNodeId('token-2022 · transfer-fee'), to: programNodeId('token-2022'), count: 1 }
        ]));
    });

    it('conserves the mints across each of the three hops', () => {
        const sumBetween = (fromKey, toKey) => {
            const from = new Set(columnOf(funnel, fromKey).nodes.map((n) => n.id));
            const to = new Set(columnOf(funnel, toKey).nodes.map((n) => n.id));
            return funnel.edges.filter((e) => from.has(e.from) && to.has(e.to))
                .reduce((sum, e) => sum + e.count, 0);
        };
        expect(sumBetween('tokens', 'issuers')).toBe(3);
        expect(sumBetween('issuers', 'recipes')).toBe(3);
        expect(sumBetween('recipes', 'programs')).toBe(3);
    });
});

describe('issuers with no mints', () => {
    const funnel = buildFunnel([token({ mint: 'A' })], [
        issuer(),
        issuer({ slug: 'ventuals', name: 'Ventuals Pre-IPO', status: 'defunct' }),
        issuer({ slug: 'republic-mirror', name: 'Republic Mirror', status: 'live' })
    ]);
    const issuers = columnOf(funnel, 'issuers');

    it('are nodes with count 0, so the page’s count of programmes is the funnel’s too', () => {
        expect(issuers.nodes).toHaveLength(3);
        const byId = new Map(issuers.nodes.map((n) => [n.id, n]));
        expect(byId.get('ventuals')).toEqual({ id: 'ventuals', label: 'Ventuals Pre-IPO', count: 0, status: 'defunct' });
        expect(byId.get('republic-mirror').count).toBe(0);
    });

    it('carry their status, which is what the graphic draws them hollow from', () => {
        expect(issuers.nodes.map((n) => n.status).sort()).toEqual(['defunct', 'live', 'live']);
    });

    it('do not change any total, because they carry no mints', () => {
        expect(issuers.total).toBe(1);
        expect(funnel.edges.some((e) => e.from === 'ventuals' || e.to === 'ventuals')).toBe(false);
    });

    it('sort last, after every programme that has mints', () => {
        expect(issuers.nodes[0].id).toBe('xstocks-backed');
        expect(issuers.nodes.slice(1).every((n) => n.count === 0)).toBe(true);
    });
});

describe('the honest gaps', () => {
    it('leaves a mint with no issuer out of the issuer column and its two edges', () => {
        const funnel = buildFunnel([token({ mint: 'A' }), token({ mint: 'B', issuer: null })], [issuer()]);
        expect(columnOf(funnel, 'tokens').total).toBe(2);
        expect(columnOf(funnel, 'issuers').total).toBe(1);
        expect(columnOf(funnel, 'recipes').total).toBe(2);
        expect(columnOf(funnel, 'programs').total).toBe(2);
        expect(funnel.edges.filter((e) => e.to === 'xstocks-backed')
            .reduce((sum, e) => sum + e.count, 0)).toBe(1);
    });

    it('still gives a mint whose issuer has no dossier a node, with a null status', () => {
        const funnel = buildFunnel([token({ mint: 'A', issuer: 'brand-new-issuer' })], []);
        expect(columnOf(funnel, 'issuers').nodes).toEqual([
            { id: 'brand-new-issuer', label: 'Brand new issuer', count: 1, status: null }
        ]);
    });

    it('files an unprofiled mint under the unknown recipe rather than dropping it', () => {
        const funnel = buildFunnel([
            { mint: 'A', issuer: 'xstocks-backed', instrumentType: 'stock', tokenProgram: 'token-2022', control: null }
        ], [issuer()]);
        expect(columnOf(funnel, 'recipes').nodes).toEqual([
            { id: recipeNodeId('unknown'), label: 'unknown', count: 1 }
        ]);
        expect(columnOf(funnel, 'recipes').total).toBe(1);
    });

    it('files a mint with no instrument type as unclassified, not as a stock', () => {
        const funnel = buildFunnel([token({ mint: 'A', instrumentType: null })], [issuer()]);
        expect(columnOf(funnel, 'tokens').nodes).toEqual([
            { id: instrumentNodeId('unknown'), label: 'Unclassified', count: 1, kind: 'instrument' }
        ]);
    });

    it('returns four empty columns and no edges for no data at all', () => {
        const funnel = buildFunnel(null, null);
        expect(funnel.columns.map((c) => c.total)).toEqual([0, 0, 0, 0]);
        expect(funnel.edges).toEqual([]);
    });
});

describe('the built stocks-funnel.json', () => {
    const funnel = readJson('stocks-funnel.json');
    const tokenDb = readJson('stocks-tokens.json');
    const issuerDb = readJson('stocks-issuers.json');

    it('was written by the same build as the two databases', () => {
        expect(funnel.builtAt).toBe(tokenDb.builtAt);
        expect(funnel.builtAt).toBe(issuerDb.builtAt);
    });

    it('is what buildFunnel makes of those two files, so the page cannot disagree with them', () => {
        const rebuilt = buildFunnel(tokenDb.tokens, issuerDb.issuers);
        expect(funnel.columns).toEqual(rebuilt.columns);
        expect(funnel.edges).toEqual(rebuilt.edges);
    });

    it('counts every mint in every column, and one node per issuer programme', () => {
        for (const column of funnel.columns) expect(column.total).toBe(tokenDb.tokens.length);
        expect(columnOf(funnel, 'issuers').nodes).toHaveLength(issuerDb.issuers.length);
    });

    it('funnels the whole universe into one token program', () => {
        const programs = columnOf(funnel, 'programs').nodes;
        expect(programs).toHaveLength(1);
        expect(programs[0].label).toBe('Token-2022');
        expect(programs[0].count).toBe(tokenDb.tokens.length);
    });

    it('has no unprofiled mint left, so every recipe is a real recipe', () => {
        const unknown = columnOf(funnel, 'recipes').nodes.filter((n) => n.label === 'unknown');
        expect(unknown).toEqual([]);
        expect(tokenDb.tokens.every((t) => t.recipe && t.recipe.label !== 'unknown')).toBe(true);
    });

    it('stays small enough to fetch alongside the issuer file', () => {
        expect(readFileSync(join(REPO_ROOT, 'stocks-funnel.json'), 'utf8').length).toBeLessThan(32 * 1024);
    });

    it('agrees with each issuer’s own recipes tally', () => {
        const byLabel = new Map();
        for (const issuerRecord of issuerDb.issuers) {
            for (const recipe of issuerRecord.recipes) {
                byLabel.set(recipe.label, (byLabel.get(recipe.label) ?? 0) + recipe.mints);
            }
        }
        for (const node of columnOf(funnel, 'recipes').nodes) {
            expect(byLabel.get(node.label)).toBe(node.count);
        }
    });
});

describe('every issuer’s recipes tally in the built database', () => {
    const issuerDb = readJson('stocks-issuers.json');
    const tokenDb = readJson('stocks-tokens.json');

    it('sums to that issuer’s mint count', () => {
        for (const issuerRecord of issuerDb.issuers) {
            const mints = issuerRecord.recipes.reduce((sum, r) => sum + r.mints, 0);
            expect(mints).toBe(issuerRecord.tokenMints.length);
        }
    });

    it('names only labels its own mints actually carry', () => {
        const byMint = new Map(tokenDb.tokens.map((t) => [t.mint, t]));
        for (const issuerRecord of issuerDb.issuers) {
            const own = new Set(issuerRecord.tokenMints.map((mint) => byMint.get(mint).recipe.label));
            expect(issuerRecord.recipes.map((r) => r.label).sort()).toEqual([...own].sort());
        }
    });
});
