// Unit tests for stocks/lib/weekly.mjs — the "This week in tokenized stocks" digest. Each test pins a
// rule a reader would notice breaking: the Monday 00:00 UTC week boundary and ISO year edges, that a
// week nobody observed never produces a week-over-week delta, that the founding cohort is not "new",
// that an uncovered redemption scan reads "not covered" rather than 0, that model readings are always
// labelled as such and link to their diff, and that an unreadable database shows as not read.

import {
    LIST_LIMIT, WEEKLY_OG_IMAGE, buildWeek, dataAsOf, inWeek, isoWeekOf, issuerPageSlug, ogDescription, parseTableProbe,
    renderWeekPage, renderWeeklyIndex, summariseSnapshot, weekFromId, weekHeadlines, weekMaterialChanges,
    weekNewTokens, weekRange, weekRedemptions, weeklyDbSql, weeksBetween
} from './lib/weekly.mjs';

const W38 = weekFromId('2026-W38');
const W39 = weekFromId('2026-W39');

function snap(date, { tokens = 3, live = 2, defi = [1, null, 2] } = {}) {
    return summariseSnapshot(
        { date, builtAt: `${date}T10:00:00Z`, items: Array.from({ length: tokens }, (_, i) => ({ mint: `m${i}`, defiIntegrationCount: defi[i] ?? null })) },
        { date, items: [...Array.from({ length: live }, (_, i) => ({ slug: `i${i}`, status: 'live', tokenCount: 1 })), { slug: 'gone', status: 'defunct', tokenCount: 1 }, { slug: 'no-mint', status: 'live', tokenCount: 0 }] }
    );
}

function inputs(overrides = {}) {
    return {
        snapshots: [], diffs: [], tokens: [], issuers: [], journal: [], material: [], events: [], trades: null,
        sources: {}, recordsBeginOn: '2026-09-16', slugs: {}, protocolPages: {}, ...overrides
    };
}

describe('ISO weeks', () => {
    test('a week opens Monday 00:00 UTC and the Sunday before belongs to the previous week', () => {
        expect(isoWeekOf('2026-09-21T00:00:00Z')).toEqual({ id: '2026-W39', year: 2026, week: 39,
            start: '2026-09-21T00:00:00Z', end: '2026-09-28T00:00:00Z' });
        expect(isoWeekOf('2026-09-20T23:59:59Z').id).toBe('2026-W38');
        expect(isoWeekOf('2026-09-27T23:59:59Z').id).toBe('2026-W39');
        expect(inWeek('2026-09-28', W39)).toBe(false);
        expect(inWeek('2026-09-21', W39)).toBe(true);
    });

    test('the Thursday decides the ISO year at both year edges', () => {
        expect(isoWeekOf('2026-01-01').id).toBe('2026-W01');
        expect(isoWeekOf('2027-01-01').id).toBe('2026-W53');
        expect(isoWeekOf('2024-12-30').id).toBe('2025-W01');
    });

    test('ids round-trip and an impossible week is rejected', () => {
        expect(weekFromId('2026-W39')).toEqual(isoWeekOf('2026-09-24'));
        expect(weekFromId('2026-W54')).toBeNull();
        expect(weekFromId('2025-W53')).toBeNull();
        expect(isoWeekOf(null)).toBeNull();
        expect(isoWeekOf('yesterday')).toBeNull();
        expect(weeksBetween('2026-09-16', '2026-09-23T11:58:24Z').map((w) => w.id)).toEqual(['2026-W38', '2026-W39']);
        expect(weekRange(W39)).toBe('21–27 Sep 2026');
    });

    test('the build instant is the newest input timestamp, never the clock', () => {
        expect(dataAsOf(['2026-09-20T10:00:00Z', null, 'garbage', '2026-09-23T11:58:24Z'])).toBe('2026-09-23T11:58:24Z');
        expect(dataAsOf([null, undefined])).toBeNull();
    });
});

describe('numbers of the week', () => {
    test('level measures come from the week\'s last snapshot, with a delta against the previous week\'s', () => {
        const digest = buildWeek(W39, W38, '2026-09-24T12:00:00Z', inputs({
            snapshots: [snap('2026-09-17', { tokens: 3 }), snap('2026-09-20', { tokens: 5, live: 2 }), snap('2026-09-23', { tokens: 8, live: 3 })]
        }));
        expect(digest.numbers.tokens).toMatchObject({ value: 8, observedAt: '2026-09-23', delta: 3, comparedWith: '2026-09-20' });
        expect(digest.numbers.issuersLive).toMatchObject({ value: 3, delta: 1 });
        expect(digest.numbers.defiIntegrations.value).toBe(3);
    });

    test('a previous week with no snapshot gives no delta, and a week with none shows missing, not zero', () => {
        const noPrev = buildWeek(W39, W38, '2026-09-24T12:00:00Z', inputs({ snapshots: [snap('2026-09-23')] }));
        expect(noPrev.numbers.tokens).toMatchObject({ value: 3, delta: null, comparedWith: null });
        const none = buildWeek(W39, W38, '2026-09-24T12:00:00Z', inputs({ snapshots: [snap('2026-09-20')] }));
        expect(none.numbers.tokens.value).toBeNull();
        expect(none.numbers.tokens.missing).toMatch(/no daily snapshot/);
        const html = renderWeekPage(none);
        expect(html).toContain('no daily snapshot recorded in this week');
        expect(summariseSnapshot({ items: [{ mint: 'a' }] }, null)).toMatchObject({ defiIntegrations: null, issuersLive: null });
    });

    test('trades need two complete, fully collected weeks before a delta is shown', () => {
        const trades = { firstTradeAt: '2026-09-16T22:54:26Z', lastTradeAt: '2026-09-24T11:00:00Z', weeks: [
            { week: '2026-09-14', trades: 5669, suspect: 10 }, { week: '2026-09-21', trades: 900, suspect: 0 }] };
        const w38 = buildWeek(W38, weekFromId('2026-W37'), '2026-09-24T12:00:00Z', inputs({ trades }));
        expect(w38.numbers.trades).toMatchObject({ value: 5669, partial: true, delta: null, suspect: 10 });
        const w39 = buildWeek(W39, W38, '2026-09-24T12:00:00Z', inputs({ trades }));
        expect(w39.numbers.trades).toMatchObject({ value: 900, partial: true, delta: null });
        const complete = { firstTradeAt: '2026-09-01T00:00:00Z', lastTradeAt: '2026-09-28T23:00:00Z', weeks: trades.weeks };
        const done = buildWeek(W39, W38, '2026-09-29T00:00:00Z', inputs({ trades: complete }));
        expect(done.numbers.trades).toMatchObject({ value: 900, partial: false, delta: 900 - 5669, comparedWith: '2026-W38' });
        const unread = buildWeek(W39, W38, '2026-09-24T12:00:00Z', inputs({ trades: null }));
        expect(unread.numbers.trades).toMatchObject({ value: null, missing: 'trade database not read in this build' });
        const stale = buildWeek(W39, W38, '2026-09-24T12:00:00Z', inputs({ trades: { ...trades, lastTradeAt: '2026-09-20T08:51:27Z' } }));
        expect(stale.numbers.trades).toMatchObject({ value: null, missing: 'no trades stored for this week (newest stored trade 2026-09-20T08:51:27Z)' });
        const early = buildWeek(weekFromId('2026-W30'), null, '2026-09-24T12:00:00Z', inputs({ trades }));
        expect(early.numbers.trades.value).toBeNull();
    });
});

describe('week sections', () => {
    test('new tokens are the week\'s firstSeenAt minus the founding cohort, grouped per issuer', () => {
        const tokens = [
            { mint: 'a', symbol: 'AAPLx', issuer: 'x', firstSeenAt: '2026-09-16T20:27:15Z' },
            { mint: 'b', symbol: 'TSLAx', issuer: 'x', firstSeenAt: '2026-09-17T09:00:00Z', cardSlug: 'TSLAx' },
            { mint: 'c', symbol: 'NVDAon', issuer: 'o', firstSeenAt: '2026-09-20T10:28:13Z' },
            { mint: 'd', symbol: 'METAx', issuer: 'x', firstSeenAt: '2026-09-21T00:00:00Z' },
            { mint: 'e', symbol: 'NOx', issuer: 'x', firstSeenAt: null }
        ];
        const groups = weekNewTokens(tokens, W38, { recordsBeginOn: '2026-09-16', issuerNames: { x: 'Kraken xStocks' } });
        expect(groups.map((g) => [g.issuer, g.issuerName, g.count])).toEqual([['o', 'o', 1], ['x', 'Kraken xStocks', 1]]);
        expect(groups[1].tokens[0]).toMatchObject({ symbol: 'TSLAx', cardSlug: 'TSLAx' });
        expect(weekNewTokens(tokens, W39, { recordsBeginOn: '2026-09-16' })[0].tokens[0].symbol).toBe('METAx');
    });

    test('model readings are deduplicated per judgment and kept only when material', () => {
        const rows = [
            { id: '7', detectedAt: '2026-09-22T09:00:00Z', judgmentId: 'j1', representative: false, material: true, assessmentSummary: 'x' },
            { id: '8', detectedAt: '2026-09-22T10:00:00Z', judgmentId: 'j1', representative: true, material: true, assessmentSummary: 'x', summary: 'Terms changed' },
            { id: '9', detectedAt: '2026-09-23T10:00:00Z', judgmentId: 'j2', material: false, assessmentSummary: 'y' },
            { id: '10', detectedAt: '2026-09-20T10:00:00Z', judgmentId: 'j3', material: true, assessmentSummary: 'z' }
        ];
        expect(weekMaterialChanges(rows, W39).map((row) => row.id)).toEqual(['8']);
        expect(weekMaterialChanges(null, W39)).toBeNull();
    });

    test('a redemption feed that did not cover the week reads "not covered", never zero', () => {
        const issuers = [
            { slug: 'a', name: 'A', status: 'live', redemption: { observationFeed: { observable: true, lastScanAt: '2026-09-23T10:00:00Z',
                daily: { '2026-09-22': { redemptions: 3, coveredHours: 24 }, '2026-09-23': { coveredHours: 10 }, '2026-09-20': { redemptions: 5, coveredHours: 24 } } } } },
            { slug: 'b', name: 'B', status: 'live', redemption: { observationFeed: { observable: true, daily: { '2026-09-10': { redemptions: 1, coveredHours: 24 } } } } },
            { slug: 'c', name: 'C', status: 'live', redemption: {} },
            { slug: 'd', name: 'D', status: 'defunct' },
            { slug: 'e', name: 'E', status: 'live', redemption: { observationFeed: { observable: false, whyNotObservable: 'off-chain register' } } }
        ];
        const { observed, withoutFeed } = weekRedemptions(issuers, W39);
        expect(observed.find((row) => row.issuer === 'a')).toMatchObject({ redemptions: 3, coveredHours: 34 });
        expect(observed.find((row) => row.issuer === 'b')).toMatchObject({ redemptions: null, coveredHours: 0 });
        expect(observed.find((row) => row.issuer === 'e')).toMatchObject({ observable: false, why: 'off-chain register' });
        expect(withoutFeed.map((row) => row.issuer)).toEqual(['c']);
    });
});

describe('redemptions table', () => {
    test('balanced fixed columns; a not-observable reason is folded so it cannot squeeze the other columns', () => {
        const issuers = [
            { slug: 'a', name: 'Ondo Global Markets', status: 'live', redemption: { observationFeed: { observable: true, lastScanAt: '2026-09-23T23:05:00Z', daily: { '2026-09-22': { redemptions: 3, coveredHours: 24 } } } } },
            { slug: 'e', name: 'PreStocks', status: 'live', redemption: { observationFeed: { observable: false, whyNotObservable: 'Redemption is a discretionary off-chain request.' } } }
        ];
        const html = renderWeekPage(buildWeek(W39, W38, '2026-09-23T23:05:00Z', inputs({ issuers })));
        expect(html).toContain('<table class="wk-redemptions"><colgroup>');
        expect(html).toContain('not observable on-chain<details class="wk-why"><summary>Why</summary><p>Redemption is a discretionary off-chain request.</p></details>');
        expect(html).not.toContain('not observable on-chain: ');
    });
});

describe('page', () => {
    const digest = buildWeek(W39, W38, '2026-09-23T11:58:24Z', inputs({
        snapshots: [snap('2026-09-20'), snap('2026-09-22', { tokens: 4 })],
        diffs: [{ from: '2026-09-20', to: '2026-09-22', changes: [
            { kind: 'health-worse', mint: 'm1', symbol: 'AAPLx', issuer: 'xstocks-backed', note: 'Worst health status went from caution to warning.' },
            { kind: 'removed-mint', mint: 'm9', symbol: 'OLDx', issuer: 'xstocks-backed', note: 'gone' }] }],
        issuers: [{ slug: 'xstocks-backed', name: 'Kraken xStocks', status: 'live' }],
        journal: [{ id: 'j', date: '2026-09-22', category: 'actor-change', severity: 'info', title: 'Docs <corrected>', href: './issuers/tessera.html', issuer: 'tessera' }],
        material: [{ id: '2056', detectedAt: '2026-09-22T10:00:00Z', material: true, assessmentSeverity: 'warning',
            assessmentSummary: 'Redemption now needs issuer consent.', summary: 'Terms changed', issuerSlug: 'xstocks-backed' }],
        events: [{ week: '2026-09-21', kind: 'legal-term', events: 4 }, { week: '2026-09-14', kind: 'quote-lost', events: 9 }]
    }));

    test('Open Graph tags make the week shareable', () => {
        const html = renderWeekPage(digest, { baseUrl: 'https://rwasonar.com/', version: '20260924d' });
        expect(html).toContain('<meta property="og:title" content="This week in tokenized stocks — week 39, 2026" />');
        expect(html).toContain(`<meta property="og:image" content="${WEEKLY_OG_IMAGE}" />`);
        expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
        expect(html).toContain('<link rel="canonical" href="https://rwasonar.com/weekly/2026-W39.html" />');
        expect(html).toContain('weekly.css?v=20260924d');
        expect(renderWeekPage(digest)).not.toContain('rel="canonical"');
        expect(ogDescription(digest).length).toBeLessThanOrEqual(200);
        expect(ogDescription(digest)).toMatch(/^21–27 Sep 2026, in progress: 1 material change \(model assessment\)/);
    });

    test('the week carries its own preview image, Report + breadcrumb JSON-LD and the contact footer', () => {
        const image = { url: 'https://rwasonar.com/weekly/og/2026-W39.0123456789ab.png', alt: 'Week 39 in numbers', width: 1200, height: 630 };
        const html = renderWeekPage(digest, { baseUrl: 'https://rwasonar.com', ogImage: image });
        expect(html).toContain(`<meta property="og:image" content="${image.url}" />`);
        expect(html).toContain(`<meta name="twitter:image" content="${image.url}" />`);
        const description = html.match(/<meta name="description" content="([^"]*)"/)[1];
        expect(description.length).toBeLessThanOrEqual(160);
        const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
        expect(ld['@graph'].map((node) => node['@type'])).toEqual(['Organization', 'Report', 'BreadcrumbList']);
        expect(ld['@graph'][1].dateModified).toBe('2026-09-23T11:58:24Z');
        expect(html).toMatch(/<div class="site-contact site-contact-inner"[\s\S]*href="https:\/\/t\.me\/rwasonar"[\s\S]*?<\/div><\/footer>/);
        expect(html.match(/<footer\b/g)).toHaveLength(1);
        const index = renderWeeklyIndex([digest], { baseUrl: 'https://rwasonar.com', ogImage: image });
        expect(index).toContain(`<meta property="og:image" content="${image.url}" />`);
        expect(index).toContain('"@type":"CollectionPage"');
    });

    test('the current week is in progress as of the data time, and model readings are labelled and linked', () => {
        const html = renderWeekPage(digest);
        expect(html).toContain('In progress, as of <time datetime="2026-09-23T11:58:24Z">23 Sep 2026 11:58 UTC</time>');
        expect(html).toContain('model assessment · warning');
        expect(html).toContain('href="../watch.html?material=true#change-2056"');
        expect(html).toContain('Docs &lt;corrected&gt;');
        expect(html).toContain('href="../issuers/tessera.html"');
        expect(html).toContain('href="../cards/AAPLx.html"');
        expect(html).toContain('legal-term <strong>4</strong>');
        expect(html).not.toContain('quote-lost');
        // Script-free apart from the site theme (theme.js), so nothing in the data can run.
        expect(html.replace(/<script src="\.\.\/theme\.js\?v=\w+"><\/script>/, '')).not.toMatch(/<script/);
        expect(renderWeekPage(digest)).toBe(html);
    });

    test('unreadable database parts are shown as not read, not as none', () => {
        const unread = buildWeek(W39, W38, '2026-09-23T11:58:24Z', inputs({ material: null, events: null }));
        const html = renderWeekPage(unread, { hasNext: false });
        expect(html).toContain('could not be read for this build');
        expect(weekHeadlines(unread)[0]).toMatchObject({ empty: true, text: 'Material changes: model assessments not available in this build' });
        expect(html).not.toContain('1 material change');
    });

    test('long lists are capped with a visible remainder, and the index lists newest first', () => {
        const tokens = Array.from({ length: LIST_LIMIT + 5 }, (_, i) => ({ mint: `m${String(i).padStart(3, '0')}`, symbol: `T${i}`, issuer: 'x', firstSeenAt: '2026-09-22T00:00:00Z' }));
        const big = buildWeek(W39, W38, '2026-09-23T11:58:24Z', inputs({ tokens }));
        expect(renderWeekPage(big)).toContain('…and 5 more');
        const older = buildWeek(W38, null, '2026-09-23T11:58:24Z', inputs());
        const index = renderWeeklyIndex([older, digest]);
        expect(index.indexOf('2026-W39.html')).toBeLessThan(index.indexOf('2026-W38.html'));
        expect(index).toContain('href="latest.html"');
    });
});

/** One fold row's parts: its opening tag, its summary (the two closed lines) and its opened body. */
function foldRow(html, id) {
    const start = html.indexOf(`<li id="${id}" class="fold-row`);
    if (start < 0) return null;
    const rest = html.slice(start);
    const next = rest.indexOf('class="fold-row', rest.indexOf('>'));
    const row = next < 0 ? rest : rest.slice(0, next);
    return { tag: row.slice(0, row.indexOf('>') + 1), summary: row.match(/<summary>([\s\S]*?)<\/summary>/)[1],
        body: row.slice(row.indexOf('<div class="fold-body">')) };
}

describe('growing lists are compact fold rows', () => {
    const digest = buildWeek(W39, W38, '2026-09-23T11:58:24Z', inputs({
        issuers: [{ slug: 'xstocks-backed', name: 'Kraken xStocks', status: 'live', discrepancies: [{ id: 'por gap', title: 'Reserves <cover> fewer tokens', severity: 'warning',
            observedAt: '2026-09-22', impact: 'Two tokens have no published reserve figure.' }] }],
        journal: [{ id: 'j1', date: '2026-09-22', category: 'actor-change', severity: 'caution', title: 'Docs corrected', href: './issuers/tessera.html', issuer: 'tessera',
            whyItMatters: 'Redemption wording changed.', assets: [{ mint: 'm1', symbol: 'AAPLx', href: './cards/AAPLx.html' }] }],
        material: [{ id: '2056', detectedAt: '2026-09-22T10:00:00Z', material: true, assessmentSeverity: 'warning',
            assessmentSummary: 'Redemption now needs issuer consent.', summary: 'Terms changed', issuerSlug: 'xstocks-backed' }]
    }));
    const html = renderWeekPage(digest);

    test('a material change is one row: date, severity and change closed; the reading and its link open', () => {
        const row = foldRow(html, 'material-2056');
        expect(row).not.toBeNull();
        expect(row.tag).toBe('<li id="material-2056" class="fold-row fold-warning">');
        expect(row.summary).toContain('<strong class="fold-title">Terms changed</strong>');
        expect(row.summary).toContain('22 Sep 2026');
        expect(row.summary).toContain('<span class="fold-line2">Redemption now needs issuer consent.</span>');
        expect(row.summary).not.toContain('<a ');
        expect(row.body).toContain('model assessment · warning');
        expect(row.body).toContain('<q>Redemption now needs issuer consent.</q>');
        expect(row.body).toContain('href="../watch.html?material=true#change-2056"');
        expect(row.body).toContain('href="../issuers/xstocks-backed.html"');
    });

    test('a journal change is one row whose links (the change, its tokens) live in the opened body', () => {
        const row = foldRow(html, 'journal-j1');
        expect(row).not.toBeNull();
        expect(row.tag).toBe('<li id="journal-j1" class="fold-row fold-caution">');
        expect(row.summary).toContain('<strong class="fold-title">Docs corrected</strong>');
        expect(row.summary).toContain('<span class="fold-line2">Redemption wording changed.</span>');
        expect(row.summary).not.toContain('<a ');
        expect(row.body).toContain('href="../issuers/tessera.html"');
        expect(row.body).toContain('href="../cards/AAPLx.html"');
        expect(row.body).toContain('actor-change · caution');
    });

    test('a new discrepancy is one row with its consequence on line two and the issuer link in the body', () => {
        const row = foldRow(html, 'discrepancy-por-gap');
        expect(row).not.toBeNull();
        expect(row.tag).toBe('<li id="discrepancy-por-gap" class="fold-row fold-warning">');
        expect(row.summary).toContain('<strong class="fold-title">Reserves &lt;cover&gt; fewer tokens</strong>');
        expect(row.summary).toContain('<span class="fold-line2">Two tokens have no published reserve figure.</span>');
        expect(row.summary).not.toContain('<a ');
        expect(row.body).toContain('href="../issuers/xstocks-backed.html"');
    });
});

describe('database read', () => {
    test('every part is bounded by the data instant and a missing table becomes null', () => {
        const sql = weeklyDbSql({ since: '2026-09-14T00:00:00Z', asOf: '2026-09-23T21:49:40Z', tables: { judgment: false, event: true, trade: true } });
        expect(sql).toContain("json_build_object('material', NULL::json");
        expect(sql).toContain("e.detected_at <= '2026-09-23T21:49:40Z'::timestamptz");
        expect(sql).toContain(`"time" <= '2026-09-23T21:49:40Z'::timestamptz`);
        expect(sql).toMatch(/baseline recorded/);
        const full = weeklyDbSql({ since: '2026-09-14T00:00:00Z', asOf: '2026-09-23T21:49:40Z', tables: { judgment: true, event: true, trade: true } });
        expect(full).toContain("j.status = 'valid'");
        expect(() => weeklyDbSql({ since: '2026-09-14', asOf: "x'; DROP TABLE y; --" })).toThrow(/asOf/);
        expect(parseTableProbe('t|f|t\n')).toEqual({ judgment: true, event: false, trade: true });
    });
});

describe('issuerPageSlug', () => {
    const names = { securitize: 'Securitize', 'backpack-securities': 'Backpack Securities', bullish: 'Bullish' };
    it('maps a programme slug to the issuer page it belongs to', () => {
        expect(issuerPageSlug('securitize-secz', names)).toBe('securitize');
        expect(issuerPageSlug('backpack-securities-spcx', names)).toBe('backpack-securities');
        expect(issuerPageSlug('bullish', names)).toBe('bullish');
    });
    it('returns null for an issuer without a page, so nothing links to a missing file', () => {
        expect(issuerPageSlug('unknown-co', names)).toBeNull();
        expect(issuerPageSlug('securitizer', names)).toBeNull();
        expect(issuerPageSlug(null, names)).toBeNull();
    });
});
