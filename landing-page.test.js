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

    test('offers only range toggles the available history can fill', () => {
        const week = Array.from({ length: 7 }, (_, i) => ({ date: `2026-09-${String(16 + i).padStart(2, '0')}`, tokenCount: 400 + i }));
        expect(L.historySpanDays(week)).toBe(7);
        expect(L.availableRanges(week, ['7', '30', '90', 'all'])).toEqual(['7', 'all']);
        expect(L.availableRanges(week.slice(0, 3), ['7', '30', '90', 'all'])).toEqual(['all']);
        const longer = [{ date: '2026-06-01', tokenCount: 10 }, ...week];
        expect(L.availableRanges(longer, ['7', '30', '90', 'all'])).toEqual(['7', '30', '90', 'all']);
        expect(L.availableRanges([], ['7', 'all'])).toEqual(['all']);
    });

    test('the live overview refines the static hero count and date, never blanks it', () => {
        expect(L.snapshotRefinement(SERIES)).toEqual({ tokens: '517', date: '2026-09-19', label: 'latest daily observation' });
        expect(L.snapshotRefinement([])).toBeNull();
        expect(L.snapshotRefinement([{ date: '2026-09-20', tokenCount: null }])).toBeNull();
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

    test('the PreStocks fee card says 1 % now and the scheduled 3 % with its epoch, as the chain reads', () => {
        // The card is the journal built from the reviewed resolutions (stocks/build-change-journal.mjs).
        const { buildChangeJournal } = require('./stocks/lib/change-journal.mjs');
        const resolutions = JSON.parse(readFileSync(join(__dirname, 'stocks/data/event-resolutions.json'), 'utf8')).items;
        const items = buildChangeJournal({ resolutions });
        const cards = L.journalUpdates({ items }, 50).filter((item) => /PreStocks/.test(item.title));
        const scheduled = cards.find((item) => /3\.00 %/.test(item.detail));
        expect(scheduled).toBeTruthy();
        expect(scheduled.detail).toContain('1.00 % now on all 8 PreStocks mints');
        expect(scheduled.detail).toContain('7 of them');
        expect(scheduled.detail).toContain('epoch 1043');
        expect(scheduled.detail).toContain('uncapped');
        // It outranks the older 19 Sep card, so the home page leads with the current state.
        expect(cards.indexOf(scheduled)).toBe(0);
        // The watcher's 100 → 300 bps rows are resolved by this entry, so they never read as a fee already charged.
        const entry = resolutions.find((row) => row.match?.after === '300');
        expect(entry).toMatchObject({ public: true, issuerSlug: 'prestocks', match: { field: 'transfer_fee_bps', before: '100', after: '300', detectedOn: '2026-09-24' } });
        expect(entry.affectedMints).toHaveLength(7);
        expect(entry.affectedMints).not.toContain('PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh'); // SPACEX stays at 1.00 %
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
        expect(html).toMatch(/src="\.\/clarity\.js\?v=[0-9a-z]+"/);
        expect(html).toContain('<meta name="twitter:site" content="@RWASonar" />');
        expect(html).toContain('href="https://x.com/RWASonar"');
        // X and Telegram appear once, in the shared contact strip, not again in the footer nav.
        const footerNav = html.match(/<nav aria-label="Footer navigation">[\s\S]*?<\/nav>/)[0];
        expect(footerNav).not.toContain('x.com/RWASonar');
        expect(footerNav).not.toContain('t.me/rwasonar');
        expect(html).not.toMatch(/<script(?![^>]*\s(?:src=|type="application\/ld\+json"))/); // JSON-LD is inert data
    });

    test('carries the canonical X identity across the main public surfaces', () => {
        for (const file of ['stocks.html', 'watch.html', 'monitor.html', 'graph.html', 'live.html',
            'whatif.html', 'review.html', 'methodology.html', 'assets.html', 'learn/index.html']) {
            const page = readFileSync(join(__dirname, file), 'utf8');
            expect(page).toContain('<meta name="twitter:site" content="@RWASonar" />');
            expect(page).toContain('https://x.com/RWASonar');
        }
    });

    test('every public page has its own large preview image with absolute URLs', () => {
        // Page-specific images since 2026-09-24 (stocks/build-site-seo.mjs): og/<page>.png with a
        // content-hash query, so X and the other preview fetchers re-read it when the numbers change.
        const images = new Set();
        for (const file of ['index.html', 'stocks.html', 'whatif.html', 'monitor.html', 'watch.html', 'graph.html',
            'live.html', 'methodology.html', 'economics.html', 'learn/index.html', 'pitch/index.html']) {
            const page = readFileSync(join(__dirname, file), 'utf8');
            const canonical = page.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
            expect(canonical).toMatch(/^https:\/\/rwasonar\.com\//);
            expect(page).toContain(`<meta property="og:url" content="${canonical}" />`);
            const image = page.match(/<meta property="og:image" content="([^"]+)" \/>/)?.[1];
            expect(image).toMatch(/^https:\/\/rwasonar\.com\/og\/[a-z-]+\.png\?v=[0-9a-f]{12}$/);
            images.add(image);
            expect(page).toContain('<meta property="og:image:width" content="1200" />');
            expect(page).toContain('<meta property="og:image:height" content="630" />');
            expect(page).toMatch(/<meta property="og:title" content="[^"]+" \/>/);
            expect(page).toMatch(/<meta property="og:description" content="[^"]+" \/>/);
            expect(page).toContain('<meta name="twitter:card" content="summary_large_image" />');
            expect(page).toContain(`<meta name="twitter:image" content="${image}" />`);
            expect(page).not.toContain('content="summary" />');
        }
        expect(images.size).toBe(11);
        // The site-wide image stays the fallback whenever a page image cannot be rendered.
        expect(readFileSync(join(__dirname, 'images/og-rwasonar.png')).subarray(16, 24).toString('hex')).toBe('000004b000000276');
    });

    test('the landing and workspace link to the pitch and the code', () => {
        const stocks = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
        for (const page of [html, stocks]) {
            expect(page).toContain('<a href="./pitch/">Pitch</a>');
            expect(page).toContain('<a href="https://github.com/Poglavar/rwa-sonar">Code</a>');
        }
        const footer = html.match(/<footer>[\s\S]*?<\/footer>/)[0];
        expect(footer).toContain('href="./pitch/"');
        expect(footer).toContain('href="https://github.com/Poglavar/rwa-sonar"');
    });

    test('public prose does not type catalogue counts the data can contradict', () => {
        const stocks = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
        const whatif = readFileSync(join(__dirname, 'whatif.html'), 'utf8');
        expect(stocks).not.toMatch(/up to \d+ tokens/);
        expect(stocks).toContain('id="largestProgramme"');
        expect(stocks).toContain('id="issuerQualifier"');
        expect(whatif).not.toMatch(/Thirty-eight failure modes/);
        for (const page of [html, stocks, whatif]) expect(page).not.toMatch(/\b(?:12|twelve) issuers?\b/i);
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
        // The page logic lives in assets.js since the 2026-09-23 CSP work removed inline scripts.
        expect(assets).toContain('<script src="assets.js');
        expect(readFileSync(join(__dirname, 'assets.js'), 'utf8')).toContain("fetch('./rwa-assets-db.json'");
        expect(assets).toContain('href="./index.html"');
        expect(assets).toContain('rel="canonical" href="https://rwasonar.com/assets.html"');
    });
});
