#!/usr/bin/env node
// Builds stocks-exits.json for exits.html: per-wrapper exit routes (DEX pools per venue, issuer
// redemption route, lending markets) and the exact-token DeFi-usage rows the Sankey draws. Reads
// only already-built or already-collected files; never contacts a source. Idempotent.
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildExits } from './lib/exits.mjs';
import { log, logError, logWarn, parseArgs, readJson, writeJson } from './lib/io.mjs';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');

const USAGE = `node stocks/build-exits.mjs --run [--out=stocks-exits.json]

Inputs (all local, none fetched):
  stocks-tokens.json, stocks-issuers.json          built catalogue (tokens, issuer redemption terms)
  stocks/data/venues.json, stocks/data/meteora.json  DEX pools per mint (DexScreener) + Meteora's own API
  stocks/data/defi-usage.json                      exact-token protocol integrations
  stocks/data/protocol-market-research.json        decoded market routes (proof stage)
  stocks/data/composability-templates.json         lender-exit templates
  stocks/data/redemption-observations.json         recurring on-chain redemption scan (optional)
  protocols/index.json                             generated dossier slugs (optional; no links without it)`;

async function exists(path) {
    try { await access(path); return true; } catch { return false; }
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run) { console.log(USAGE); return; }
    const out = resolve(ROOT, typeof flags.out === 'string' ? flags.out : 'stocks-exits.json');
    const data = join(HERE, 'data');
    const [tokens, issuers, venues, meteora, usage, marketResearch, templates] = await Promise.all([
        readJson(join(ROOT, 'stocks-tokens.json')), readJson(join(ROOT, 'stocks-issuers.json')),
        readJson(join(data, 'venues.json')), readJson(join(data, 'meteora.json')), readJson(join(data, 'defi-usage.json')),
        readJson(join(data, 'protocol-market-research.json')), readJson(join(data, 'composability-templates.json'))
    ]);
    const observationsPath = join(data, 'redemption-observations.json');
    const observations = await exists(observationsPath) ? await readJson(observationsPath) : null;
    if (!observations) logWarn(`no ${observationsPath}; redemption routes carry the built issuer snapshot only`);
    const indexPath = join(ROOT, 'protocols', 'index.json');
    const dossierIndex = await exists(indexPath) ? await readJson(indexPath) : null;
    if (!dossierIndex) logWarn(`no ${indexPath}; run build-protocol-dossiers.mjs first or the Sankey has no dossier links`);

    const sources = {
        tokens: { file: 'stocks-tokens.json', builtAt: tokens.builtAt ?? null },
        issuers: { file: 'stocks-issuers.json', builtAt: issuers.builtAt ?? null },
        venues: { file: 'stocks/data/venues.json', fetchedAt: venues.fetchedAt ?? null, provider: 'DexScreener tokens/v1 (pool liquidity, 24 h volume)', dexscreenerFetchedAt: venues.source?.dexscreener?.fetchedAt ?? null, mintsCovered: venues.items?.length ?? null },
        meteora: { file: 'stocks/data/meteora.json', fetchedAt: meteora.fetchedAt ?? null, provider: 'Meteora per-pool APIs' },
        defiUsage: { file: 'stocks/data/defi-usage.json', fetchedAt: usage.fetchedAt ?? null },
        marketResearch: { file: 'stocks/data/protocol-market-research.json', reviewedAt: marketResearch.reviewedAt ?? null },
        templates: { file: 'stocks/data/composability-templates.json', reviewedAt: templates.reviewedAt ?? null },
        redemptionObservations: observations ? { file: 'stocks/data/redemption-observations.json', generatedAt: observations.generatedAt ?? null } : null
    };
    const exits = buildExits({
        tokens: tokens.tokens ?? [], issuers: issuers.issuers ?? [], venues, meteora, usage,
        templates: templates.templates ?? [], marketResearch, observations,
        dossierSlugs: dossierIndex ? new Set(dossierIndex.map((row) => row.slug)) : null,
        builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), sources
    });
    await writeJson(out, exits, 0);
    const observed = exits.tokens.filter((t) => t.venueCoverage === 'observed').length;
    const none = exits.tokens.filter((t) => t.venueCoverage === 'none-observed').length;
    const missing = exits.tokens.filter((t) => t.venueCoverage === 'not-collected').length;
    log(`wrote ${out}: ${exits.tokens.length} tokens (${observed} with a DEX pool, ${none} collected with none, ${missing} venues not collected), ${exits.flows.length} flow rows`);
}

if (import.meta.filename === process.argv[1]) main().catch((e) => { logError(e.stack ?? String(e)); process.exit(1); });
