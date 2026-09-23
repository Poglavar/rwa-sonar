// Tests the build-time counts written into index.html and pitch/index.html, the issuer-programme
// qualification shared with stocks.js, and that the scheduled refresh publishes the rewritten pages.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import counts from './lib/catalogue-counts.js';
import { RELEASE_BUILD_STAGES } from './lib/release-manifest.mjs';
import {
    STATIC_SNAPSHOT_PAGES, landingSnapshotHtml, pitchProofHtml, renderStaticSnapshots, replaceMarkedRegion, snapshotFacts
} from './lib/static-snapshot.mjs';

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
    defi: { fetchedAt: '2026-09-21T00:00:00Z', counts: { withAnyConfirmedUse: 125 } }
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
        expect(html).toContain('<strong>125</strong><span>assets with confirmed DeFi use in the 21 Sep 2026 composability snapshot');
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

    test('runs after the other release surfaces, and the scheduled refresh publishes every rewritten page', () => {
        expect(RELEASE_BUILD_STAGES.surfaces.at(-1)).toBe('stocks/build-static-snapshot.mjs');
        const refresh = readFileSync(join(ROOT, 'stocks/refresh-on-server.sh'), 'utf8');
        const loop = refresh.match(/for page in ([^;]+); do\n\s+install -m 0644 "\$page" "\$DOCROOT\/\$page\.next-\$\$" && mv -f/);
        expect(loop).not.toBeNull();
        expect(loop[1].trim().split(/\s+/)).toEqual(STATIC_SNAPSHOT_PAGES);
        expect(refresh.indexOf('static page snapshots')).toBeGreaterThan(refresh.indexOf('complete release surfaces'));
    });
});
