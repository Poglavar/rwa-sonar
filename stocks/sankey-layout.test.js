// Unit tests for stocks/lib/sankey-layout.js: aggregation by proof stage, the layout geometry
// (conservation at the middle column, fit to height, proportional widths), the no-USD rule (never
// zero, never dropped), the phone-legibility switch and the ranked list.

const S = require('./lib/sankey-layout.js');

const FLOWS = [
    { symbol: 'A', issuer: 'xs', protocolId: 'raydium', protocol: 'Raydium', action: 'liquidity', stage: 'observed-market', usd: 3000, usdBasis: 'pool-liquidity' },
    { symbol: 'B', issuer: 'xs', protocolId: 'raydium', protocol: 'Raydium', action: 'liquidity', stage: 'observed-market', usd: 1000, usdBasis: 'pool-liquidity' },
    { symbol: 'A', issuer: 'xs', protocolId: 'kamino', protocol: 'Kamino', action: 'collateral', stage: 'decoded', usd: 2000, usdBasis: 'reported-market-size', dossier: 'a-kamino' },
    { symbol: 'C', issuer: 'ondo', protocolId: 'kamino', protocol: 'Kamino', action: 'collateral', stage: 'source-listed', usd: 1000, usdBasis: 'reported-market-size' },
    { symbol: 'C', issuer: 'ondo', protocolId: 'nest', protocol: 'Nest', action: 'collateral', stage: 'source-listed', usd: null, usdBasis: null }
];
const NAMES = { xs: 'Kraken xStocks', ondo: 'Ondo' };

describe('aggregateFlows', () => {
    const g = S.aggregateFlows(FLOWS, { issuerNames: NAMES });

    it('makes issuer, protocol and action nodes, and splits links by proof stage', () => {
        expect(g.nodes.map((n) => n.id).sort()).toEqual(['a:collateral', 'a:liquidity', 'i:ondo', 'i:xs', 'p:kamino', 'p:nest', 'p:raydium']);
        const kaminoToCollateral = g.links.filter((l) => l.source === 'p:kamino' && l.target === 'a:collateral');
        expect(kaminoToCollateral.map((l) => [l.stage, l.usd]).sort()).toEqual([['decoded', 2000], ['source-listed', 1000]]);
        expect(g.nodes.find((n) => n.id === 'i:xs').label).toBe('Kraken xStocks');
    });

    it('keeps a no-USD link as null with its row counted, never as zero', () => {
        const nest = g.links.find((l) => l.source === 'i:ondo' && l.target === 'p:nest');
        expect(nest).toMatchObject({ usd: null, usdRows: 0, noUsdRows: 1 });
    });

    it('skips rows without a recognised action', () => {
        expect(S.aggregateFlows([{ ...FLOWS[0], action: 'swap' }]).links).toEqual([]);
    });
});

describe('layoutSankey', () => {
    const g = S.aggregateFlows(FLOWS, { issuerNames: NAMES });
    const L = S.layoutSankey(g, { width: 800, height: 300, noUsdPx: 2, minLinkPx: 1 });
    const node = (id) => L.nodes.find((n) => n.id === id);

    it('fits the tallest column inside the height and uses it (scale is maximal)', () => {
        for (const n of L.nodes) {
            expect(n.y).toBeGreaterThanOrEqual(10 - 1e-6);
            expect(n.y + n.h).toBeLessThanOrEqual(290 + 1e-6);
        }
        const loose = S.layoutSankey(g, { width: 800, height: 600, noUsdPx: 2, minLinkPx: 1 });
        expect(loose.scale).toBeGreaterThan(L.scale);
    });

    it('draws widths proportional to USD and gives no-USD links the fixed thin width', () => {
        const ray = L.links.find((l) => l.source === 'i:xs' && l.target === 'p:raydium');
        const kam = L.links.find((l) => l.source === 'i:xs' && l.target === 'p:kamino');
        expect(ray.w / kam.w).toBeCloseTo(2, 5);
        expect(L.links.find((l) => l.target === 'p:nest').w).toBe(2);
    });

    it('conserves flow at the middle column: what enters a protocol leaves it', () => {
        for (const id of ['p:kamino', 'p:raydium', 'p:nest']) {
            const inW = L.links.filter((l) => l.target === id).reduce((t, l) => t + l.w, 0);
            const outW = L.links.filter((l) => l.source === id).reduce((t, l) => t + l.w, 0);
            expect(inW).toBeCloseTo(outW, 6);
            expect(node(id).h).toBeCloseTo(Math.max(inW, 4), 6); // minNodePx default
        }
    });

    it('stacks link ends inside their nodes without overlap', () => {
        for (const n of L.nodes) {
            const outs = L.links.filter((l) => l.source === n.id).sort((a, b) => a.sy - b.sy);
            for (let i = 1; i < outs.length; i += 1) expect(outs[i].sy - outs[i].w / 2).toBeCloseTo(outs[i - 1].sy + outs[i - 1].w / 2, 6);
            for (const l of outs) {
                expect(l.sy - l.w / 2).toBeGreaterThanOrEqual(n.y - 1e-6);
                expect(l.sy + l.w / 2).toBeLessThanOrEqual(n.y + n.h + 1e-6);
            }
        }
        expect(node('i:xs').x).toBeLessThan(node('p:kamino').x);
        expect(node('p:kamino').x).toBeLessThan(node('a:collateral').x);
    });

    it('orders actions in the fixed column order', () => {
        expect(node('a:collateral').y).toBeLessThan(node('a:liquidity').y);
    });

    it('renders an SVG with a title per link, dashed class for no-USD, and dossier-index links', () => {
        const svg = S.sankeySvg(L, { protocolHref: './protocols/' });
        expect(svg.match(/<path /g)).toHaveLength(L.links.length);
        expect(svg).toContain('class="sk-link stage-source-listed no-usd"');
        expect(svg).toContain('USD not reported');
        expect(svg).toContain('<a href="./protocols/"');
        expect(svg).not.toMatch(/NaN|undefined/);
    });
});

describe('legibility and the phone list', () => {
    const g = S.aggregateFlows(FLOWS, { issuerNames: NAMES });

    it('refuses narrow containers and crowded columns', () => {
        const L = S.layoutSankey(g, { width: 900, height: 400 });
        expect(S.sankeyLegible(L, 900)).toBe(true);
        expect(S.sankeyLegible(L, 375)).toBe(false);
        expect(S.sankeyLegible(L, null)).toBe(false);
        const cramped = S.layoutSankey(g, { width: 900, height: 40, nodeGap: 1 });
        expect(S.sankeyLegible(cramped, 900)).toBe(false);
    });

    it('ranks full paths by USD with unreported USD last', () => {
        const paths = S.rankedPaths(FLOWS, { issuerNames: NAMES });
        expect(paths.map((p) => `${p.issuerName}>${p.protocol}>${p.stage}:${p.usd}`)).toEqual([
            'Kraken xStocks>Raydium>observed-market:4000',
            'Kraken xStocks>Kamino>decoded:2000',
            'Ondo>Kamino>source-listed:1000',
            'Ondo>Nest>source-listed:null'
        ]);
        expect(paths[1].rows[0].dossier).toBe('a-kamino');
    });

    it('suggests a height from the busiest column within bounds', () => {
        expect(S.suggestHeight(g, { perNode: 100, min: 50, max: 250 })).toBe(250);
        expect(S.suggestHeight(g, { perNode: 10, min: 320 })).toBe(320);
    });
});
