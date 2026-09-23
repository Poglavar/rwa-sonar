const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const L = require('./landing.js');

const SERIES = [
    { date: '2026-09-16', tokenCount: 441, holderAccounts: 1000, volume24Usd: 10, issuerCounts: [{ issuer: 'ondo', tokenCount: 212 }, { issuer: 'xstocks', tokenCount: 156 }] },
    { date: '2026-09-17', tokenCount: 471, holderAccounts: 1200, volume24Usd: 20, issuerCounts: [{ issuer: 'ondo', tokenCount: 230 }, { issuer: 'xstocks', tokenCount: 165 }] },
    { date: '2026-09-18', tokenCount: 496, holderAccounts: 1400, volume24Usd: 15, issuerCounts: [{ issuer: 'ondo', tokenCount: 248 }, { issuer: 'xstocks', tokenCount: 169 }] },
    { date: '2026-09-19', tokenCount: 517, holderAccounts: 1500, volume24Usd: 30, issuerCounts: [{ issuer: 'ondo', tokenCount: 262 }, { issuer: 'xstocks', tokenCount: 176 }] }
];

describe('landing overview series', () => {
    test('states the latest catalogue jump and total observed growth separately', () => {
        expect(L.metricDelta(SERIES, 'tokenCount')).toEqual({
            latest: 517, previous: 496, delta: 21, totalDelta: 76
        });
    });

    test('attributes the latest change without calling it issuance', () => {
        expect(L.issuerDeltas(SERIES)).toEqual([
            { issuer: 'ondo', delta: 14 },
            { issuer: 'xstocks', delta: 7 }
        ]);
    });

    test('charts use a zero baseline and keep dates in ascending order', () => {
        const model = L.chartModel([...SERIES].reverse(), 'tokenCount', 500, 200);
        expect(model.points.map((point) => point.date)).toEqual(SERIES.map((row) => row.date));
        expect(model.points[0].y).toBeGreaterThan(model.points.at(-1).y);
        expect(model.max).toBe(517);
    });

    test('range controls are anchored to the newest observation, not the wall clock', () => {
        const old = { date: '2026-06-01', tokenCount: 10 };
        const recent = [
            { date: '2026-09-12', tokenCount: 490 },
            { date: '2026-09-19', tokenCount: 517 }
        ];
        expect(L.rangeRows([old, ...recent], '30').map((row) => row.date)).toEqual(recent.map((row) => row.date));
        expect(L.rangeRows([old, ...recent], '7').map((row) => row.date)).toEqual(['2026-09-19']);
        expect(L.rangeRows([old, ...recent], 'all')).toHaveLength(3);
    });

    test('catalogue annotations travel with chart points', () => {
        const model = L.chartModel(SERIES, 'tokenCount', 500, 200, {
            annotations: [{ date: '2026-09-19', previousDate: '2026-09-18', added: 21, removed: 0 }]
        });
        expect(model.points.at(-1).annotation).toEqual(expect.objectContaining({ added: 21 }));
        expect(model.points[0].annotation).toBeNull();
    });
});

describe('landing update feed', () => {
    test('uses the public journal and ranks demonstrated consequence before maintenance context', () => {
        const items = L.journalUpdates({ items: [
            { date: '2026-09-20', severity: 'info', kind: 'document-moved', title: 'URL moved', whyItMatters: 'No rights changed.' },
            { date: '2026-09-19', severity: 'warning', kind: 'fee-change', title: 'Fee doubled', whyItMatters: 'Every transfer now withholds 1%.' }
        ] });
        expect(items.map((item) => item.title)).toEqual(['Fee doubled', 'URL moved']);
    });

    test('merges dated protocol, catalogue and issuer events newest first', () => {
        const items = L.recentUpdates({
            latest: { from: '2026-09-18', to: '2026-09-19', changes: [] },
            newMints: [{ symbol: 'NEWx', mint: 'MINT', issuer: 'xstocks', firstSeenAt: '2026-09-19T01:00:00Z', cardSlug: 'NEWx' }],
            events: [{ date: '2026-09-17', kind: 'terms', issuer: 'ondo', summary: 'Terms changed' }]
        }, {
            latest: { to: '2026-09-20', events: [{ symbol: 'NEWx', mint: 'MINT', protocolName: 'Kamino', summary: 'NEWx now appears in Kamino.' }] }
        });
        expect(items.map((item) => item.type)).toEqual(['DeFi watch', 'Newly observed', 'Terms']);
        expect(items[1].detail).toContain('issuance may predate discovery');
    });

    test('groups exact snapshot additions by issuer instead of flooding the feed', () => {
        const items = L.catalogueUpdates({ latest: {
            from: '2026-09-18', to: '2026-09-19', changes: [
                { kind: 'new-mint', mint: 'A', issuer: 'ondo', symbol: 'Ax' },
                { kind: 'new-mint', mint: 'B', issuer: 'ondo', symbol: 'Bx' },
                { kind: 'new-mint', mint: 'C', issuer: 'xstocks', symbol: 'Cx' }
            ]
        } });
        expect(items).toHaveLength(1);
        expect(items[0].title).toContain('3 token addresses entered');
        expect(items[0].detail).toContain('Ondo +2');
        expect(items[0].detail).toContain('issuance may predate discovery');
    });
});

describe('landing/app separation', () => {
    const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
    const assets = readFileSync(join(__dirname, 'assets.html'), 'utf8');

    test('the public root leads with the monitored story and links into the analytics app', () => {
        for (const id of ['heroSearch', 'historyRange', 'holdersChart', 'volumeChart', 'updateFeed']) {
            expect(html).toContain(`id="${id}"`);
        }
        expect(html).toContain('href="./stocks.html"');
        expect(html).not.toContain('href="./stocks.html?view=compare">Compare the same stock</a>');
        expect(html).toContain('Its issuance may predate discovery.');
        expect(html).toContain('landing.js?v=');
        expect(html).toContain('data-chart-range="90"');
        expect(html).toContain('Market size tells you what exists.');
        expect(html).toContain('RWA.xyz and DefiLlama');
        expect(html).toContain('L2BEAT, extended to RWAs');
        expect(html).toContain('Claims versus reality');
        expect(html).not.toContain('Why tokenize an asset at all?');
        expect(html).toContain('The ticker is familiar.<br><span>The token is mysterious.</span>');
        expect(html).not.toContain('The token is not.');
        expect(html).not.toContain('not one score');
        expect(html).toContain('cannot tell us how many people own tokens');
        expect(html).toContain('Coverage is partial and volumes are unaudited.');
        expect(html).toContain('Neither makes');
        expect(html).toContain('a registered Apple shareholder');
        expect(html).toContain('Same stock reference.');
        expect(html).toContain('AAPLx');
        expect(html).toContain('AAPLon');
        expect(html).toContain('name="search"');
        expect(html).toContain('Market size tells you what exists.');
        expect(html).toContain('src="./clarity.js"');
        expect(html).toContain('<meta name="twitter:site" content="@RWASonar" />');
        expect(html).toContain('href="https://x.com/RWASonar"');
        expect(html).toContain('X · @RWASonar');
        expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    });

    test('carries the canonical X identity across the main public surfaces', () => {
        for (const file of ['stocks.html', 'watch.html', 'monitor.html', 'graph.html', 'live.html',
            'whatif.html', 'review.html', 'methodology.html', 'assets.html', 'learn/index.html']) {
            const page = readFileSync(join(__dirname, file), 'utf8');
            expect(page).toContain('<meta name="twitter:site" content="@RWASonar" />');
            expect(page).toContain('https://x.com/RWASonar');
        }
    });

    test('introduces the night watch after the real comparison with responsive, deferred artwork', () => {
        const scene = html.match(/<section id="below-the-surface"[\s\S]*?<\/section>/)?.[0];
        expect(scene).toBeTruthy();
        expect(html.indexOf('AAPLx')).toBeLessThan(html.indexOf('id="below-the-surface"'));
        expect(html.indexOf('id="below-the-surface"')).toBeLessThan(html.indexOf('id="holdersChart"'));
        expect(scene).toContain('night-watch-v2-768.webp 768w');
        expect(scene).toContain('loading="lazy"');
        expect(scene).toContain('href="./watch.html"');
        expect(scene).toContain('href="./methodology.html"');
        expect(scene).toContain('An illustration of the research below the surface.');
    });

    test('the previous general-RWA explorer remains available as its own app route', () => {
        expect(assets).toContain('id="assetsTable"');
        expect(assets).toContain("fetch('./rwa-assets-db.json'");
        expect(assets).toContain('href="./index.html"');
        expect(assets).toContain('rel="canonical" href="https://rwasonar.com/assets.html"');
    });
});
