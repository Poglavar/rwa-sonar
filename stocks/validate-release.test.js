// Tests the release boundary against tiny generated fixtures, including the failure mode where
// nginx would otherwise serve the landing page for a missing issuer artifact.

import { lstat, mkdtemp, mkdir, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateRelease } from './validate-release.mjs';
import { publishRelease } from './publish-release.mjs';
import { hashArtifactFamily } from './release-evidence.mjs';
import { releaseRsyncExcludes } from './lib/release-manifest.mjs';

const RELEASE_DIRECTORIES = new Set(['stocks/data/history', 'cards', 'templates', 'issuers', 'protocols', 'comparisons']);

/**
 * The staged-publication test publishes this subset rather than the real 29-family manifest: the
 * refusal it checks (a required artifact missing from the stage) does not depend on the family
 * count, and each family costs a publish ~15 filesystem calls, which is what pushed the release
 * tests towards jest's 5 s budget on a loaded laptop (see publish-release.test.js).
 */
const PUBLICATION_ARTIFACTS = ['release-evidence.json', 'stocks-tokens.json', 'stocks-discovery.json',
    'stocks-issuers.json', 'cards'];

async function completePublicationFixture(root, artifacts = PUBLICATION_ARTIFACTS) {
    for (const item of artifacts.slice(1)) {
        try { await lstat(join(root, item)); } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            if (RELEASE_DIRECTORIES.has(item)) {
                await mkdir(join(root, item), { recursive: true });
                await writeFile(join(root, item, 'fixture.txt'), item);
            } else {
                await mkdir(join(root, item, '..'), { recursive: true });
                await writeFile(join(root, item), '{}');
            }
        }
    }
    const hashes = [];
    for (const item of artifacts.slice(1)) hashes.push(await hashArtifactFamily({ root, artifact: item }));
    await writeFile(join(root, 'release-evidence.json'), JSON.stringify({ artifacts: hashes }));
}

const ORIGIN = 'https://rwasonar.com';
const ROUTES = [
    ['cards/NVDAx.html', 'cards/NVDAx.html'],
    ['issuers/xstocks-backed.html', 'issuers/xstocks-backed.html'],
    ['issuers/ondo-global-markets.html', 'issuers/ondo-global-markets.html'],
    ['templates/index.html', 'templates/'],
    ['protocols/index.html', 'protocols/']
];

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rwa-release-'));
    await mkdir(join(root, 'cards'), { recursive: true });
    await mkdir(join(root, 'issuers'), { recursive: true });
    await mkdir(join(root, 'templates'), { recursive: true });
    await mkdir(join(root, 'protocols'), { recursive: true });
    await mkdir(join(root, 'comparisons'), { recursive: true });
    const builtAt = '2026-09-22T00:00:00Z';
    await writeFile(join(root, 'stocks-tokens.json'), JSON.stringify({ builtAt, tokens: [{
        mint: 'one', symbol: 'NVDAx', issuer: 'xstocks-backed', cardSlug: 'NVDAx', underlyingTicker: 'NVDA'
    }] }));
    await writeFile(join(root, 'stocks-issuers.json'), JSON.stringify({ issuers: [{
        slug: 'xstocks-backed', name: 'Kraken xStocks', grades: { claimLabel: 'secured claim on collateral' }
    }] }));
    await writeFile(join(root, 'stocks-discovery.json'), JSON.stringify({ builtAt,
        issuers: [{ slug: 'xstocks-backed', name: 'Kraken xStocks' }],
        tokens: [{ mint: 'one', symbol: 'NVDAx', issuer: 'xstocks-backed', discoveryProfile: { cashRedemption: true } }]
    }));
    await writeFile(join(root, 'cards/index.json'), JSON.stringify([{ mint: 'one' }]));
    await writeFile(join(root, 'cards/NVDAx.json'), JSON.stringify({
        ownership: { claimLabel: 'secured claim on collateral' },
        composability: { id: 'xstocks-backed--template', healthStatus: 'caution' }
    }));
    await writeFile(join(root, 'cards/NVDAx.html'), '<h1>NVDAx</h1><p>Kraken xStocks · secured claim on collateral</p>'
        + `<link rel="canonical" href="${ORIGIN}/cards/NVDAx.html" />`);
    await writeFile(join(root, 'issuers/xstocks-backed.html'), '<h1>Kraken xStocks</h1>'
        + '<p>secured claim on collateral</p><p>Unknown means not established, never “no”</p>'
        + `<link rel="canonical" href="${ORIGIN}/issuers/xstocks-backed.html" />`);
    await writeFile(join(root, 'templates/xstocks-backed--template.html'), '<h1>xStocks template</h1>'
        + '<p>xstocks-backed--template</p><p>caution</p><h3>Recorded external source changes</h3>');
    await writeFile(join(root, 'stocks.html'), '<input id="globalSearch"><div id="comparisonView"></div>');
    await writeFile(join(root, 'protocols/index.json'), JSON.stringify([{ slug: 'nvda-kamino-one' }]));
    await writeFile(join(root, 'protocols/nvda-kamino-one.html'), '<h1>NVDAx × Kamino</h1>'
        + '<p>Proof status — do not read a source listing as execution proof</p>'
        + `<link rel="canonical" href="${ORIGIN}/protocols/nvda-kamino-one.html" />`);
    await writeFile(join(root, 'comparisons/index.json'), JSON.stringify({ schemaVersion: 1, builtAt, groups: [{
        ticker: 'NVDA', path: 'u-nvda.json', issuerCount: 1, tokenCount: 1, issuers: ['xstocks-backed'], mints: ['one']
    }] }));
    await writeFile(join(root, 'comparisons/u-nvda.json'), JSON.stringify({ schemaVersion: 1, ticker: 'NVDA', builtAt, sources: {}, reviewPendingIssuers: [], models: [{
        issuerSlug: 'xstocks-backed', tokens: [{ mint: 'one', symbol: 'NVDAx', cardSlug: 'NVDAx', issuer: 'xstocks-backed', underlyingTicker: 'NVDA' }]
    }] }));
    for (const [path, canonicalPath] of ROUTES) {
        if (['cards/NVDAx.html', 'issuers/xstocks-backed.html'].includes(path)) continue;
        await writeFile(join(root, path), `<link rel="canonical" href="${ORIGIN}/${canonicalPath}" />`);
    }
    await writeFile(join(root, 'release-evidence.json'), '{}\n');
    return root;
}

describe('release artifact validation', () => {
    let root;

    afterEach(async () => {
        if (root) await rm(root, { recursive: true, force: true });
    });

    test('accepts one generated card per token and route-specific canonicals', async () => {
        root = await fixture();
        await expect(validateRelease({ root, baseUrl: ORIGIN })).resolves.toMatchObject({
            tokenCount: 1,
            cardCount: 1
        });
    });

    test('rejects a route whose bytes are a generic fallback page', async () => {
        root = await fixture();
        await writeFile(join(root, 'issuers/xstocks-backed.html'), '<title>RWA Sonar</title>');
        await expect(validateRelease({ root, baseUrl: ORIGIN })).rejects.toThrow(/route-specific canonical/);
    });

    test('retains standalone coverage without inventing an underlying for an unclassified token', async () => {
        root = await fixture();
        const tokens = JSON.parse(await readFile(join(root, 'stocks-tokens.json'), 'utf8'));
        const discovery = JSON.parse(await readFile(join(root, 'stocks-discovery.json'), 'utf8'));
        const standalone = { mint: 'unclassified', issuer: 'xstocks-backed', symbol: 'PRIVATE', underlyingTicker: null };
        await writeFile(join(root, 'stocks-tokens.json'), JSON.stringify({ ...tokens, tokens: [...tokens.tokens, standalone] }));
        await writeFile(join(root, 'stocks-discovery.json'), JSON.stringify({ ...discovery,
            tokens: [...discovery.tokens, { ...standalone, discoveryProfile: {} }] }));
        await writeFile(join(root, 'cards/index.json'), JSON.stringify([{ mint: 'one' }, { mint: 'unclassified' }]));
        await expect(validateRelease({ root, baseUrl: ORIGIN })).resolves.toMatchObject({
            tokenCount: 2, cardCount: 2, comparisonBundleCount: 1, ungroupedTokenCount: 1
        });
        await writeFile(join(root, 'cards/index.json'), JSON.stringify([{ mint: 'one' }, { mint: 'wrong-token' }]));
        await expect(validateRelease({ root, baseUrl: ORIGIN })).rejects.toThrow(/every exact current token once/);
    });

    test('rejects card, issuer and template conclusion drift', async () => {
        root = await fixture();
        await writeFile(join(root, 'cards/NVDAx.json'), JSON.stringify({
            ownership: { claimLabel: 'beneficial interest in the security' },
            composability: { id: 'xstocks-backed--template', healthStatus: 'caution' }
        }));
        await expect(validateRelease({ root, baseUrl: ORIGIN })).rejects.toThrow(/claim label disagrees/);
    });

    test('rejects an individual protocol dossier that would fall back to a generic page', async () => {
        root = await fixture();
        await writeFile(join(root, 'protocols/nvda-kamino-one.html'), '<title>RWA Sonar</title>');
        await expect(validateRelease({ root, baseUrl: ORIGIN })).rejects.toThrow(/protocols\/nvda-kamino-one\.html: missing route-specific canonical/);
    });

    test('rejects a comparison bundle whose listed mint is not in its current underlying', async () => {
        root = await fixture();
        await writeFile(join(root, 'comparisons/u-nvda.json'), JSON.stringify({ schemaVersion: 1, ticker: 'NVDA', builtAt: '2026-09-22T00:00:00Z', models: [{
            issuerSlug: 'xstocks-backed', tokens: [{ mint: 'wrong', issuer: 'xstocks-backed', underlyingTicker: 'NVDA' }]
        }] }));
        await expect(validateRelease({ root, baseUrl: ORIGIN })).rejects.toThrow(/model token disagrees/);
    });

    test('rejects an index that omits a current underlying bundle', async () => {
        root = await fixture();
        await writeFile(join(root, 'comparisons/index.json'), JSON.stringify({ schemaVersion: 1, builtAt: '2026-09-22T00:00:00Z', groups: [] }));
        await expect(validateRelease({ root, baseUrl: ORIGIN })).rejects.toThrow(/missing a current underlying/);
    });

    test('rejects stale discovery or comparison timestamps even when membership still matches', async () => {
        root = await fixture();
        const discovery = JSON.parse(await readFile(join(root, 'stocks-discovery.json'), 'utf8'));
        await writeFile(join(root, 'stocks-discovery.json'), JSON.stringify({ ...discovery, builtAt: 'old' }));
        await expect(validateRelease({ root, baseUrl: ORIGIN })).rejects.toThrow(/discovery index builtAt/);
        await rm(root, { recursive: true, force: true });
        root = await fixture();
        const index = JSON.parse(await readFile(join(root, 'comparisons/index.json'), 'utf8'));
        await writeFile(join(root, 'comparisons/index.json'), JSON.stringify({ ...index, builtAt: 'old' }));
        await expect(validateRelease({ root, baseUrl: ORIGIN })).rejects.toThrow(/comparison bundle index builtAt/);
        await rm(root, { recursive: true, force: true });
        root = await fixture();
        const bundle = JSON.parse(await readFile(join(root, 'comparisons/u-nvda.json'), 'utf8'));
        await writeFile(join(root, 'comparisons/u-nvda.json'), JSON.stringify({ ...bundle, builtAt: 'old' }));
        await expect(validateRelease({ root, baseUrl: ORIGIN })).rejects.toThrow(/u-nvda\.json: builtAt disagrees/);
    });
});

describe('deployment release ordering', () => {
    test('rebuilds retained raw inputs into base data before database loading and review-aware surfaces', async () => {
        const script = await readFile(join(import.meta.dirname, '..', 'deploy-to-server.sh'), 'utf8');
        const manifest = await readFile(join(import.meta.dirname, 'lib', 'release-manifest.mjs'), 'utf8');
        const evidenceAt = script.indexOf('node stocks/release-evidence.mjs --run');
        expect(manifest.indexOf("'stocks/build-stocks-db.mjs'")).toBeLessThan(manifest.indexOf("'stocks/build-discovery-index.mjs'"));
        expect(manifest.indexOf("'stocks/build-health.mjs'")).toBeLessThan(manifest.indexOf("'stocks/build-legal-templates.mjs'"));
        const baseAt = script.indexOf('node stocks/build-release-artifacts.mjs --run --phase=base');
        const dbAt = script.indexOf('node stocks/load-db.mjs --run --ddl --only=tokens,snapshots');
        const preReviewAt = script.indexOf('node stocks/build-release-artifacts.mjs --run --phase=pre-review');
        const queueAt = script.indexOf('node stocks/build-review-queue.mjs --run');
        const surfacesAt = script.indexOf('node stocks/build-release-artifacts.mjs --run --phase=surfaces');
        expect(baseAt).toBeGreaterThan(script.indexOf('flock 9'));
        expect(dbAt).toBeGreaterThan(baseAt);
        expect(preReviewAt).toBeGreaterThan(dbAt);
        expect(queueAt).toBeGreaterThan(preReviewAt);
        expect(surfacesAt).toBeGreaterThan(queueAt);
        expect(evidenceAt).toBeGreaterThan(surfacesAt);
        const publishAt = script.indexOf('node stocks/publish-release.mjs --run');
        const unlockAt = script.indexOf('flock -u 9');
        expect(unlockAt).toBeGreaterThan(publishAt);
        expect(unlockAt).toBeLessThan(script.indexOf('pm2 restart ecosystem.config.cjs'));
        expect(script.match(/JOB_OWNED=.*stocks-discovery\.json/)).toBeNull();
    });

    test('refresh seeds exact token membership before DeFi, then rebuilds base and review-aware surfaces', async () => {
        const script = await readFile(join(import.meta.dirname, 'refresh-on-server.sh'), 'utf8');
        const seedAt = script.indexOf('node stocks/build-stocks-db.mjs --run');
        const defiAt = script.indexOf('node stocks/fetch-defi-usage.mjs --run');
        const baseAt = script.indexOf('node stocks/build-release-artifacts.mjs --run --phase=base');
        const dbAt = script.indexOf('node stocks/load-db.mjs --run --ddl');
        const queueAt = script.indexOf('node stocks/build-review-queue.mjs --run');
        const surfacesAt = script.indexOf('node stocks/build-release-artifacts.mjs --run --phase=surfaces');
        expect(seedAt).toBeGreaterThan(script.indexOf('node stocks/fetch-meteora.mjs --run'));
        expect(defiAt).toBeGreaterThan(seedAt);
        expect(baseAt).toBeGreaterThan(defiAt);
        expect(dbAt).toBeGreaterThan(baseAt);
        expect(queueAt).toBeGreaterThan(dbAt);
        expect(surfacesAt).toBeGreaterThan(queueAt);
    });

    test('uses the shared staged publisher after the general docroot mirror', async () => {
        const script = await readFile(join(import.meta.dirname, '..', 'deploy-to-server.sh'), 'utf8');
        expect(script).toContain('node stocks/lib/release-manifest.mjs --rsync-excludes');
        expect(releaseRsyncExcludes()).toContain('.rwa-release-current');
        expect(script.indexOf('node stocks/release-evidence.mjs --run')).toBeLessThan(script.indexOf('node stocks/publish-release.mjs --run'));
        expect(script.indexOf('node stocks/publish-release.mjs --run')).toBeGreaterThan(script.indexOf('rsync -a --delete'));
    });
});

describe('staged publication', () => {
    let root;
    let docroot;

    afterEach(async () => {
        if (root) await rm(root, { recursive: true, force: true });
        if (docroot) await rm(docroot, { recursive: true, force: true });
    });

    test('does not replace an existing complete release when a required staged artifact is absent', async () => {
        root = await fixture();
        await completePublicationFixture(root);
        docroot = await mkdtemp(join(tmpdir(), 'rwa-docroot-'));
        await writeFile(join(docroot, 'stocks-tokens.json'), 'previous complete release');
        await unlink(join(root, 'stocks-discovery.json'));
        await expect(publishRelease({ source: root, destination: docroot, artifacts: PUBLICATION_ARTIFACTS })).rejects.toThrow(/stocks-discovery\.json/);
        await expect(readFile(join(docroot, 'stocks-tokens.json'), 'utf8')).resolves.toBe('previous complete release');
    });
});
