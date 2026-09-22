// Tests the release boundary against tiny generated fixtures, including the failure mode where
// nginx would otherwise serve the landing page for a missing issuer artifact.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateRelease } from './validate-release.mjs';

const ORIGIN = 'https://rwasonar.com';
const ROUTES = [
    ['cards/NVDAx.html', 'cards/NVDAx.html'],
    ['issuers/xstocks-backed.html', 'issuers/xstocks-backed.html'],
    ['issuers/ondo-global-markets.html', 'issuers/ondo-global-markets.html'],
    ['templates/index.html', 'templates/']
];

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rwa-release-'));
    await mkdir(join(root, 'cards'), { recursive: true });
    await mkdir(join(root, 'issuers'), { recursive: true });
    await mkdir(join(root, 'templates'), { recursive: true });
    await writeFile(join(root, 'stocks-tokens.json'), JSON.stringify({ tokens: [{
        mint: 'one', symbol: 'NVDAx', issuer: 'xstocks-backed', cardSlug: 'NVDAx'
    }] }));
    await writeFile(join(root, 'stocks-issuers.json'), JSON.stringify({ issuers: [{
        slug: 'xstocks-backed', name: 'Kraken xStocks', grades: { claimLabel: 'secured claim on collateral' }
    }] }));
    await writeFile(join(root, 'stocks-discovery.json'), JSON.stringify({
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
    for (const [path, canonicalPath] of ROUTES) {
        if (['cards/NVDAx.html', 'issuers/xstocks-backed.html'].includes(path)) continue;
        await writeFile(join(root, path), `<link rel="canonical" href="${ORIGIN}/${canonicalPath}" />`);
    }
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

    test('rejects card, issuer and template conclusion drift', async () => {
        root = await fixture();
        await writeFile(join(root, 'cards/NVDAx.json'), JSON.stringify({
            ownership: { claimLabel: 'beneficial interest in the security' },
            composability: { id: 'xstocks-backed--template', healthStatus: 'caution' }
        }));
        await expect(validateRelease({ root, baseUrl: ORIGIN })).rejects.toThrow(/claim label disagrees/);
    });
});

describe('deployment release ordering', () => {
    test('rebuilds the derived discovery index after retaining live data and before validation', async () => {
        const script = await readFile(join(import.meta.dirname, '..', 'deploy-to-server.sh'), 'utf8');
        const buildAt = script.indexOf('node stocks/build-discovery-index.mjs --run');
        const validateAt = script.indexOf('node stocks/validate-release.mjs --run');
        expect(buildAt).toBeGreaterThan(script.indexOf('node stocks/load-db.mjs --run'));
        expect(validateAt).toBeGreaterThan(buildAt);
        expect(script.match(/JOB_OWNED=.*stocks-discovery\.json/)).toBeNull();
    });
});
