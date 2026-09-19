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
});

describe('landing update feed', () => {
    test('merges dated protocol, catalogue and issuer events newest first', () => {
        const items = L.recentUpdates({
            newMints: [{ symbol: 'NEWx', mint: 'MINT', issuer: 'xstocks', firstSeenAt: '2026-09-19T01:00:00Z', cardSlug: 'NEWx' }],
            events: [{ date: '2026-09-17', kind: 'terms', issuer: 'ondo', summary: 'Terms changed' }]
        }, {
            latest: { to: '2026-09-20', events: [{ symbol: 'NEWx', mint: 'MINT', protocolName: 'Kamino', summary: 'NEWx now appears in Kamino.' }] }
        });
        expect(items.map((item) => item.type)).toEqual(['DeFi watch', 'Newly observed', 'Terms']);
        expect(items[1].detail).toContain('not necessarily newly issued');
    });
});

describe('landing/app separation', () => {
    const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
    const assets = readFileSync(join(__dirname, 'assets.html'), 'utf8');

    test('the public root leads with the monitored story and links into the analytics app', () => {
        for (const id of ['tokenTotal', 'tokenChart', 'holdersChart', 'volumeChart', 'updateFeed']) {
            expect(html).toContain(`id="${id}"`);
        }
        expect(html).toContain('href="./stocks.html"');
        expect(html).toContain('discovery growth, not a claim');
        expect(html).toContain('landing.js?v=');
        expect(html).toContain('src="./clarity.js"');
        expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    });

    test('the previous general-RWA explorer remains available as its own app route', () => {
        expect(assets).toContain('id="assetsTable"');
        expect(assets).toContain("fetch('./rwa-assets-db.json'");
        expect(assets).toContain('href="./index.html"');
        expect(assets).toContain('rel="canonical" href="https://rwasonar.com/assets.html"');
    });
});
