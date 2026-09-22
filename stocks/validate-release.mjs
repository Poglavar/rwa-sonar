#!/usr/bin/env node
// Validates the deterministic generated pages before a release is mirrored to the public docroot.
// It deliberately reads local artifacts only: collection freshness is a separate runtime concern.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { log, logError, parseArgs } from './lib/io.mjs';
import discoveryHelpers from './lib/discovery.js';

const ROOT = join(import.meta.dirname, '..');
const REPRESENTATIVE_ROUTES = [
    { path: 'cards/NVDAx.html', canonicalPath: 'cards/NVDAx.html' },
    { path: 'issuers/xstocks-backed.html', canonicalPath: 'issuers/xstocks-backed.html' },
    { path: 'issuers/ondo-global-markets.html', canonicalPath: 'issuers/ondo-global-markets.html' },
    { path: 'templates/index.html', canonicalPath: 'templates/' },
    { path: 'protocols/index.html', canonicalPath: 'protocols/' }
];
const REPRESENTATIVE_TOKEN_SYMBOL = 'NVDAx';

async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

function requireHtmlIncludes(html, needle, label) {
    if (!html.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}

function usage() {
    console.log(`validate-release.mjs — verify generated public routes

USAGE
  node stocks/validate-release.mjs --run --base-url=https://rwasonar.com

The command fails unless cards/index.json has one entry per token and representative issuer,
template and protocol pages contain their route-specific canonical URL.`);
}

export async function validateRelease({ root = ROOT, baseUrl }) {
    if (typeof baseUrl !== 'string' || !/^https?:\/\/[^/]+$/.test(baseUrl)) {
        throw new Error('--base-url must be an origin without a trailing slash');
    }
    const tokenDb = await readJson(join(root, 'stocks-tokens.json'));
    const tokens = tokenDb.tokens;
    const tokenBuiltAt = tokenDb.builtAt;
    const discovery = await readJson(join(root, 'stocks-discovery.json'));
    const cards = await readJson(join(root, 'cards', 'index.json'));
    const protocolIndex = await readJson(join(root, 'protocols', 'index.json'));
    const comparisonIndex = await readJson(join(root, 'comparisons', 'index.json'));
    if (typeof tokenBuiltAt !== 'string' || !tokenBuiltAt || !Array.isArray(tokens) || !Array.isArray(cards) || cards.length !== tokens.length) {
        throw new Error(`generated card count ${Array.isArray(cards) ? cards.length : 'missing'} `
            + `does not match token count ${Array.isArray(tokens) ? tokens.length : 'missing'}`);
    }
    const cardMints = new Set(cards.map((card) => card.mint));
    if (cardMints.size !== tokens.length || tokens.some((token) => !cardMints.has(token.mint))) {
        throw new Error('card index does not contain every exact current token once');
    }
    if (!Array.isArray(discovery.tokens) || discovery.tokens.length !== tokens.length
        || !Array.isArray(discovery.issuers) || discovery.tokens.some((row) => !row.discoveryProfile)) {
        throw new Error('compact discovery index is missing or disagrees with the full token catalogue');
    }
    if (discovery.builtAt !== tokenBuiltAt) throw new Error('compact discovery index builtAt disagrees with the full token catalogue');
    if (comparisonIndex?.schemaVersion !== 1 || !Array.isArray(comparisonIndex.groups)) {
        throw new Error('comparison bundle index is missing schemaVersion 1 groups');
    }
    if (comparisonIndex.builtAt !== tokenBuiltAt) throw new Error('comparison bundle index builtAt disagrees with the full token catalogue');
    // Do not invent a comparable underlying for an unclassified or private-company token.
    // Such tokens still require their standalone card; only established groups get bundles.
    const underlyingMints = new Map(discoveryHelpers.sameUnderlyingGroups(tokens, { includeSingle: true })
        .map((group) => [group.ticker, group.rows.flatMap((row) => row.tokens)]));
    const ungroupedTokenCount = tokens.length - [...underlyingMints.values()].reduce((sum, rows) => sum + rows.length, 0);
    const indexedTickers = new Set();
    for (const group of comparisonIndex.groups) {
        if (!group?.ticker || !group?.path || indexedTickers.has(group.ticker)) throw new Error('comparison bundle index has a duplicate or invalid group');
        indexedTickers.add(group.ticker);
        const expected = underlyingMints.get(group.ticker);
        if (!expected) throw new Error(`comparison bundle declares unknown underlying ${group.ticker}`);
        const bundle = await readJson(join(root, 'comparisons', group.path));
        if (bundle?.schemaVersion !== 1 || bundle.ticker !== group.ticker || !Array.isArray(bundle.models)) {
            throw new Error(`comparisons/${group.path}: invalid schema or ticker`);
        }
        if (bundle.builtAt !== tokenBuiltAt) throw new Error(`comparisons/${group.path}: builtAt disagrees with the full token catalogue`);
        const expectedByMint = new Map(expected.map((token) => [token.mint, token]));
        const bundled = bundle.models.flatMap((model) => (model?.tokens ?? []).map((token) => ({ model, token })));
        if (bundled.length !== expected.length || new Set(bundled.map(({ token }) => token?.mint)).size !== expected.length) {
            throw new Error(`comparisons/${group.path}: token membership disagrees with ${group.ticker}`);
        }
        for (const { model, token } of bundled) {
            const current = expectedByMint.get(token?.mint);
            if (!current || token.issuer !== current.issuer || token.underlyingTicker !== group.ticker || model?.issuerSlug !== current.issuer) {
                throw new Error(`comparisons/${group.path}: model token disagrees with current ${group.ticker} membership`);
            }
        }
        const mints = group.mints ?? [];
        const issuers = group.issuers ?? [];
        if (group.tokenCount !== expected.length || group.issuerCount !== bundle.models.length
            || mints.length !== expected.length || new Set(mints).size !== expected.length
            || [...expectedByMint.keys()].some((mint) => !mints.includes(mint))
            || issuers.length !== bundle.models.length || bundle.models.some((model) => !issuers.includes(model.issuerSlug))) {
            throw new Error(`comparison bundle index disagrees with ${group.ticker} bundle`);
        }
    }
    if (indexedTickers.size !== underlyingMints.size || [...underlyingMints.keys()].some((ticker) => !indexedTickers.has(ticker))) {
        throw new Error('comparison bundle index is missing a current underlying');
    }
    for (const route of REPRESENTATIVE_ROUTES) {
        const html = await readFile(join(root, route.path), 'utf8');
        const canonical = `<link rel="canonical" href="${baseUrl}/${route.canonicalPath}"`;
        if (!html.includes(canonical)) throw new Error(`${route.path}: missing route-specific canonical URL`);
    }
    if (!Array.isArray(protocolIndex) || !protocolIndex.length) {
        throw new Error('protocol dossier index is missing or empty');
    }
    for (const dossier of protocolIndex) {
        if (!dossier?.slug) throw new Error('protocol dossier index has an entry without a slug');
        const path = `protocols/${dossier.slug}.html`;
        const html = await readFile(join(root, path), 'utf8');
        const canonical = `<link rel="canonical" href="${baseUrl}/protocols/${dossier.slug}.html"`;
        if (!html.includes(canonical)) throw new Error(`${path}: missing route-specific canonical URL`);
        requireHtmlIncludes(html, 'Proof status — do not read a source listing as execution proof', path);
    }
    const workspace = await readFile(join(root, 'stocks.html'), 'utf8');
    for (const marker of ['id="globalSearch"', 'id="comparisonView"']) {
        if (!workspace.includes(marker)) throw new Error(`stocks.html: missing release marker ${marker}`);
    }

    const issuers = (await readJson(join(root, 'stocks-issuers.json'))).issuers;
    const representative = tokens.find((row) => row.symbol === REPRESENTATIVE_TOKEN_SYMBOL);
    if (!representative) throw new Error(`${REPRESENTATIVE_TOKEN_SYMBOL}: missing representative token`);
    const issuer = issuers.find((row) => row.slug === representative.issuer);
    if (!issuer) throw new Error(`${REPRESENTATIVE_TOKEN_SYMBOL}: missing issuer ${representative.issuer}`);
    const cardSlug = representative.cardSlug || representative.symbol;
    const cardJson = await readJson(join(root, 'cards', `${cardSlug}.json`));
    const cardHtml = await readFile(join(root, 'cards', `${cardSlug}.html`), 'utf8');
    const issuerHtml = await readFile(join(root, 'issuers', `${issuer.slug}.html`), 'utf8');
    const templateId = cardJson.composability?.id;
    if (!templateId) throw new Error(`${cardSlug}: missing composability template id in card manifest`);
    const templateHtml = await readFile(join(root, 'templates', `${templateId}.html`), 'utf8');
    const claimLabel = issuer.grades?.claimLabel;
    if (!claimLabel || cardJson.ownership?.claimLabel !== claimLabel) {
        throw new Error(`${cardSlug}: card manifest claim label disagrees with issuer dossier`);
    }
    for (const [html, label] of [[cardHtml, `cards/${cardSlug}.html`], [issuerHtml, `issuers/${issuer.slug}.html`]]) {
        requireHtmlIncludes(html, claimLabel, label);
        requireHtmlIncludes(html, issuer.name, label);
    }
    requireHtmlIncludes(templateHtml, templateId, `templates/${templateId}.html`);
    requireHtmlIncludes(templateHtml, cardJson.composability.healthStatus, `templates/${templateId}.html`);
    requireHtmlIncludes(issuerHtml, 'Unknown means not established', `issuers/${issuer.slug}.html`);
    requireHtmlIncludes(templateHtml, 'Recorded external source changes', `templates/${templateId}.html`);

    return { tokenCount: tokens.length, cardCount: cards.length, representative: cardSlug,
        routes: REPRESENTATIVE_ROUTES.map((row) => row.path), protocolDossierCount: protocolIndex.length,
        comparisonBundleCount: comparisonIndex.groups.length, ungroupedTokenCount };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const result = await validateRelease({ root: ROOT, baseUrl: flags['base-url'] });
    log(`release artifacts valid: ${result.cardCount} card(s), ${result.protocolDossierCount} protocol dossier(s), ${result.comparisonBundleCount} comparison bundle(s), ${result.routes.length} representative route(s), `
        + `${result.representative} card/issuer/template consistency, search + comparison workspace`);
    return 0;
}

if (import.meta.filename === process.argv[1]) {
    main().then((code) => process.exit(code), (err) => {
        logError(err.stack ?? String(err));
        process.exit(1);
    });
}
