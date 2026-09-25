// Tests the build-time counts written into index.html and pitch/index.html, the issuer-programme
// qualification shared with stocks.js, and that the scheduled refresh publishes the rewritten pages.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import counts from './lib/catalogue-counts.js';
import { RELEASE_BUILD_STAGES } from './lib/release-manifest.mjs';
import { SITE_PAGES } from './lib/site-pages.mjs';

const SITE_PAGE_PATHS = SITE_PAGES.map((page) => page.file ?? page.path ?? page);
import {
    LANDING_EVENT_ROWS, STATIC_SNAPSHOT_PAGES, landingEventsHtml, landingEventsUpdatedHtml, landingFloatHtml, landingRedemptionsHtml,
    landingSnapshotHtml, pitchPowersHeadHtml, pitchPowersHtml, pitchProofHtml, pitchSourcesHtml,
    renderStaticSnapshots, replaceMarkedRegion, snapshotFacts
} from './lib/static-snapshot.mjs';
import { RELEASE_ARTIFACTS } from './lib/release-manifest.mjs';

const ROOT = join(import.meta.dirname, '..');

const ISSUERS = [
    { slug: 'xstocks-backed', name: 'Kraken xStocks', status: 'live', market: { tokens: 927 } },
    { slug: 'ondo', name: 'Ondo Global Markets', status: 'live', market: { tokens: 268 } },
    { slug: 'remora-markets', name: 'Remora Markets', status: 'defunct', market: { tokens: 0 } },
    { slug: 'ventuals', name: 'Ventuals', status: 'defunct', market: { tokens: 0 } },
    { slug: 'republic-mirror', name: 'Republic Mirror', status: 'live', market: { tokens: 0 } }
];

const FILES = {
    tokens: { builtAt: '2026-09-22T16:33:09Z', tokens: Array.from({ length: 1195 }, (_, i) => ({ mint: `M${i}` })) },
    issuers: { issuers: ISSUERS },
    templates: { templates: [{}, {}, {}] },
    health: { rules: Array.from({ length: 11 }, () => ({})) },
    defi: { fetchedAt: '2026-09-21T00:00:00Z', counts: { withAnyConfirmedUse: 125, integrations: 171 } },
    // The shapes flows.html, powers.html and the source watcher read (stocks-flows.json,
    // stocks-power-map.json, stocks/data/sources.json), trimmed to the fields the snapshot uses.
    flows: {
        flows: {
            issuers: [
                { slug: 'xstocks-backed', days: [{ date: '2026-09-23', redeemed: { coveredHours: 23.1, count: 246 }, created: null }] },
                { slug: 'ondo-global-markets', days: [
                    { date: '2026-09-22', created: { coveredHours: 5, count: 90 }, redeemed: { coveredHours: 5, count: 40 } },
                    { date: '2026-09-23', created: { coveredHours: 20.9, count: 437 }, redeemed: { coveredHours: 20.9, count: 250 } },
                    { date: '2026-09-24', created: { coveredHours: 0, count: null }, redeemed: { coveredHours: 0, count: null } }
                ] }
            ]
        },
        float: {
            readAt: '2026-09-24T19:07:34Z',
            totals: { supplyUsd: 2727314161, inventoryUsd: 2229947731, floatUsd: 497366430, pricedMints: 107, inventorySharePct: 81.76 }
        }
    },
    powerMap: {
        powers: Array.from({ length: 7 }, (_, i) => ({ id: `p${i}` })),
        issuers: Array.from({ length: 12 }, (_, i) => ({ slug: `i${i}` })),
        counts: { 'single-key': 26, multisig: 16, program: 8, none: 18, unknown: 16 }
    },
    sources: { generatedAt: '2026-09-24T15:45:08Z', count: 621 },
    events: {
        asOf: '2026-09-24T14:07:04Z',
        events: Array.from({ length: 12 }, (_, i) => ({
            id: `e${i}`, at: i === 0 ? '2026-09-24T12:29:11Z' : `2026-09-${String(23 - i).padStart(2, '0')}`, category: i % 2 ? 'terms' : 'market',
            severity: 'warning', source: i % 2 ? 'change journal' : 'catalogue', href: './watch.html', title: `Event <${i}>`
        }))
    }
};

describe('issuer programme counts', () => {
    test('separates live-token programmes from defunct and not-yet-minted ones', () => {
        const summary = counts.issuerProgrammeSummary(ISSUERS);
        expect(summary).toMatchObject({ total: 5, withTokens: 2, tokens: 1195, defunct: ['Remora Markets', 'Ventuals'], noMint: ['Republic Mirror'] });
        expect(summary.largest).toEqual({ name: 'Kraken xStocks', tokens: 927 });
        expect(counts.programmeQualifier(summary)).toBe('2 with live tokens · Remora Markets and Ventuals defunct · Republic Mirror: no mint yet');
    });

    test('a programme with no token count is unmeasured, not a zero', () => {
        const summary = counts.issuerProgrammeSummary([{ name: 'Mystery', status: 'live' }]);
        expect(summary.noMint).toEqual([]);
        expect(summary.unmeasured).toEqual(['Mystery']);
    });
});

describe('static snapshot regions', () => {
    const facts = snapshotFacts(FILES);

    test('replaces only the marked region and refuses a missing or doubled marker', () => {
        const html = 'a<!-- snapshot:x:start -->old<!-- snapshot:x:end -->b';
        expect(replaceMarkedRegion(html, 'x', 'new')).toBe('a<!-- snapshot:x:start -->new<!-- snapshot:x:end -->b');
        expect(() => replaceMarkedRegion('nothing', 'x', 'new')).toThrow('not marked');
        expect(() => replaceMarkedRegion(html + html, 'x', 'new')).toThrow('more than once');
    });

    test('the landing line carries the count, the qualified programmes and the build date', () => {
        const html = landingSnapshotHtml(facts);
        expect(html).toContain('<span id="snapshotTokens">1,195</span> exact Solana token addresses');
        expect(html).toContain('from 2 issuer programmes with live tokens');
        expect(html).toContain('(of 5 tracked: Remora Markets and Ventuals defunct; Republic Mirror: no mint yet)');
        expect(html).toContain('<time id="snapshotDate" datetime="2026-09-22T16:33:09Z">22 Sep 2026</time>');
    });

    test('the pitch numbers come from the files, each dated', () => {
        const html = pitchProofHtml(facts);
        expect(html).toContain('<strong data-live-token-count>1,195</strong><span>exact Solana token addresses in the 22 Sep 2026 public snapshot');
        expect(html).toContain('<strong>3</strong><span>reviewed legal and technology templates');
        expect(html).toContain('<strong>11</strong><span>health checks');
        // Two different DeFi counts exist (weekly shows the second): the label says which is which.
        expect(html).toContain('<strong>125</strong><span>token addresses with at least one confirmed DeFi integration '
            + '(171 token–protocol integrations in all) in the 21 Sep 2026 composability snapshot');
    });

    test('the xStocks float finding is read from stocks-flows.json, the numbers flows.html shows', () => {
        const html = landingFloatHtml(facts);
        expect(html).toContain('<p class="finding-kicker">Float · read on chain, 24 Sep 2026</p>');
        expect(html).toContain('<h3>81.8% of priced xStocks supply sits in issuer wallets.</h3>');
        expect(html).toContain('Across the 107 xStocks with a market price, $2.23B of $2.73B of supply');
        expect(html).toContain('a public float of at most $497.37M');
        expect(() => landingFloatHtml(snapshotFacts({ ...FILES, flows: { flows: FILES.flows.flows, float: null } }))).toThrow('xStocks float');
    });

    test('redemption counts are the newest Ondo day the scan covered, with its covered hours', () => {
        expect(landingRedemptionsHtml(facts)).toBe('On 23 Sep 2026 the scan saw 250 Ondo redemptions and 437 creations in the 20.9 hours it read.');
        // A window with no covered Ondo day says so rather than printing a zero.
        const uncovered = snapshotFacts({ ...FILES, flows: { ...FILES.flows, flows: { issuers: [{ slug: 'ondo-global-markets', days: [
            { date: '2026-09-24', created: { coveredHours: 0, count: null }, redeemed: { coveredHours: 0, count: null } }] }] } } });
        expect(landingRedemptionsHtml(uncovered)).toBe('No Ondo day in the current window has been read by the scan yet.');
    });

    test('the pitch powers line is the power map’s own cell counts', () => {
        expect(pitchPowersHeadHtml(facts)).toBe('12 programmes × 7 powers.');
        expect(pitchPowersHtml(facts)).toBe('84 cells: 26 held by one key, 16 by a multisig, 8 by a program, 18 not installed, 16 unknown.');
        expect(() => pitchPowersHtml(snapshotFacts({ ...FILES, powerMap: { powers: [], issuers: [], counts: {} } }))).toThrow('power map');
    });

    test('the source count is the cited-source registry the watcher reads, named for what it counts', () => {
        expect(pitchSourcesHtml(facts)).toBe('Daily: 621 cited source URLs re-read');
        expect(() => pitchSourcesHtml(snapshotFacts({ ...FILES, sources: {} }))).toThrow('cited source count');
    });

    test('the committed pages mark every data-driven number, so none can drift from its file', () => {
        const landing = readFileSync(join(ROOT, 'index.html'), 'utf8');
        const pitch = readFileSync(join(ROOT, 'pitch/index.html'), 'utf8');
        for (const name of ['float-finding', 'redemptions']) expect(landing).toContain(`<!-- snapshot:${name}:start -->`);
        for (const name of ['pitch-powers-head', 'pitch-powers', 'pitch-sources']) expect(pitch).toContain(`<!-- snapshot:${name}:start -->`);
        // The flows-and-float box left the deck on 25 Sep 2026 (owner's edit); flows.html keeps the figures.
        expect(pitch).not.toContain('snapshot:pitch-flows');
        // No hand-typed copy of the figures the regions now carry.
        expect(landing).not.toContain('81.0%');
        expect(pitch).not.toContain('81.0%');
        expect(pitch).not.toContain('576 cited sources');
        const rendered = renderStaticSnapshots({ 'index.html': landing, 'pitch/index.html': pitch }, facts);
        expect(rendered['index.html']).toContain('<!-- snapshot:float-finding:start --><p class="finding-kicker">Float · read on chain, 24 Sep 2026</p>');
        expect(rendered['pitch/index.html']).toContain('<!-- snapshot:pitch-powers:start -->84 cells: 26 held by one key');
        expect(rendered['pitch/index.html']).toContain('<!-- snapshot:pitch-sources:start -->Daily: 621 cited source URLs re-read<!-- snapshot:pitch-sources:end -->');
    });

    test('a missing input throws instead of writing a guessed number', () => {
        expect(() => pitchProofHtml(snapshotFacts({ ...FILES, templates: {} }))).toThrow('legal template count');
        expect(() => snapshotFacts({ ...FILES, tokens: { builtAt: 'never', tokens: [] } })).toThrow('builtAt');
    });

    test('the committed pages carry a filled snapshot, never the loading placeholder', () => {
        const pages = Object.fromEntries(STATIC_SNAPSHOT_PAGES.map((page) => [page, readFileSync(join(ROOT, page), 'utf8')]));
        expect(pages['index.html']).not.toContain('Loading the latest monitored snapshot');
        expect(pages['index.html']).toMatch(/<!-- snapshot:landing:start --><span id="snapshotTokens">[\d,]+<\/span>/);
        expect(pages['pitch/index.html']).toMatch(/<!-- snapshot:pitch-proof:start --><article><strong data-live-token-count>[\d,]+</);
        const rendered = renderStaticSnapshots(pages, facts);
        expect(rendered['index.html']).toContain('<span id="snapshotTokens">1,195</span>');
    });

    test('the landing events box carries the newest rows with dates, never an age the page cannot know', () => {
        const html = landingEventsHtml(facts);
        expect(html.match(/<li class="event-row"/g)).toHaveLength(LANDING_EVENT_ROWS);
        expect(html).toContain('<time datetime="2026-09-24T12:29:11Z" title="2026-09-24T12:29:11Z" data-at="2026-09-24T12:29:11Z">24 Sep, 12:29 UTC</time>');
        expect(html).toContain('<time datetime="2026-09-22" title="2026-09-22" data-at="2026-09-22">22 Sep</time>');
        expect(html).toContain('Event &lt;0&gt;');
        expect(html).not.toMatch(/ ago</);
        expect(landingEventsUpdatedHtml(facts)).toBe('Updated hourly · newest <time datetime="2026-09-24T12:29:11Z" title="2026-09-24T12:29:11Z" data-at="2026-09-24T12:29:11Z">24 Sep, 12:29 UTC</time>');
        expect(landingEventsHtml(snapshotFacts({ ...FILES, events: { events: [] } }))).toContain('No events recorded in the last 30 days.');
        expect(() => snapshotFacts({ ...FILES, events: undefined })).toThrow('stocks-events.json');
        const rendered = renderStaticSnapshots({ 'index.html': readFileSync(join(ROOT, 'index.html'), 'utf8'), 'pitch/index.html': readFileSync(join(ROOT, 'pitch/index.html'), 'utf8') }, facts);
        expect(rendered['index.html']).toMatch(/<!-- snapshot:events:start --><li class="event-row" data-category="market"/);
        expect(rendered['index.html']).toContain('<!-- snapshot:events-updated:start -->Updated hourly · newest <time');
    });

    test('the committed landing page carries built event rows, and the feed is built before the snapshot and published', () => {
        const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
        expect(html).toMatch(/<ul id="latestEventsList" class="latest-events-list"><!-- snapshot:events:start --><li class="event-row"/);
        const surfaces = RELEASE_BUILD_STAGES.surfaces;
        expect(surfaces.indexOf('stocks/build-events.mjs')).toBeGreaterThan(-1);
        expect(surfaces.indexOf('stocks/build-events.mjs')).toBeLessThan(surfaces.indexOf('stocks/build-static-snapshot.mjs'));
        expect(RELEASE_ARTIFACTS).toContain('stocks-events.json');
        const refresh = readFileSync(join(ROOT, 'stocks/refresh-on-server.sh'), 'utf8');
        expect(refresh.indexOf('node stocks/fetch-mint-created.mjs --run')).toBeGreaterThan(-1);
        expect(refresh.indexOf('node stocks/fetch-mint-created.mjs --run')).toBeLessThan(refresh.indexOf('complete release surfaces'));
    });

    test('runs after the other release surfaces, and the scheduled refresh publishes every rewritten page', () => {
        // The site-SEO step (head blocks, page images, sitemaps) runs last, right after the snapshot.
        expect(RELEASE_BUILD_STAGES.surfaces.slice(-2)).toEqual(['stocks/build-static-snapshot.mjs', 'stocks/build-site-seo.mjs']);
        const refresh = readFileSync(join(ROOT, 'stocks/refresh-on-server.sh'), 'utf8');
        // The refresh installs every page the SEO registry lists, which must include each snapshot page.
        expect(refresh).toMatch(/for page in \$\(node stocks\/build-site-seo\.mjs --list-pages\); do/);
        for (const page of STATIC_SNAPSHOT_PAGES) expect(SITE_PAGE_PATHS).toContain(page);
        expect(refresh.indexOf('static page snapshots')).toBeGreaterThan(refresh.indexOf('complete release surfaces'));
    });
});
