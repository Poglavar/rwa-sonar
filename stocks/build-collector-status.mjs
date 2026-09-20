#!/usr/bin/env node
// Builds the small public collector-status artifact used by methodology.html. It summarizes
// timestamps and coverage only; raw source text, RPC endpoints and credentials never enter it.

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT = resolve(HERE, '..');

export const COLLECTOR_SPECS = [
    { id: 'catalogue', label: 'Token catalogue', cadenceHours: 24, file: 'universe', timestamp: 'fetchedAt', countPath: ['items'], unit: 'token records', source: 'Jupiter token search plus reviewed issuer lists' },
    { id: 'chain', label: 'On-chain token state', cadenceHours: 24, file: 'onchain', timestamp: 'fetchedAt', countPath: ['items'], unit: 'mint reads', source: 'Solana RPC' },
    { id: 'identity-chain', label: 'Issuer identity & chain coverage', cadenceHours: 24, file: 'identities', timestamp: 'fetchedAt', countPath: ['items'], unit: 'issuer-known mint identities', source: 'Issuer exact-mint registries, reserves and Solana RPC' },
    { id: 'authority-watch', label: 'Authority & extension watch', cadenceHours: 1, file: 'chainWatch', timestamp: 'generatedAt', countPath: ['mintsRead'], unit: 'mints checked', source: 'Solana RPC; hourly change detection' },
    { id: 'dex-market', label: 'DEX market data', cadenceHours: 6, file: 'venues', timestamp: 'fetchedAt', countPath: ['items'], unit: 'token venue records', source: 'DexScreener and on-chain pool registries' },
    { id: 'reference-prices', label: 'Reference prices', cadenceHours: 6, file: 'prices', timestamp: 'fetchedAt', countPath: ['items'], unit: 'reference records', source: 'Pyth, issuer registries and reviewed sponsor sources' },
    { id: 'holders', label: 'Holder accounts', cadenceHours: 24, file: 'holders', timestamp: 'fetchedAt', countPath: ['items'], unit: 'mint holder samples', source: 'Solana/Jupiter holder data' },
    { id: 'trade-tape', label: 'Observed DEX trades', cadenceHours: 3, file: 'trades', timestamp: 'updatedAt', countPath: ['trades'], unit: 'trades in rolling file', source: 'Solana pool transactions' },
    { id: 'defi', label: 'Confirmed DeFi integrations', cadenceHours: 6, file: 'defi', timestamp: 'fetchedAt', countPath: ['items'], unit: 'tokens reviewed', source: 'Exact-mint protocol registries plus on-chain accounts' }
];

function valueAt(record, path) {
    let value = record;
    for (const key of path) value = value?.[key];
    return value;
}
function countAt(record, path) {
    const value = valueAt(record, path);
    if (Array.isArray(value)) return value.length;
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function legalSourceCoverage(state) {
    const rows = Object.values(state && typeof state === 'object' ? state : {}).filter(Boolean);
    const dates = rows.map((row) => Date.parse(row.lastCheckedAt)).filter(Number.isFinite).sort((a, b) => a - b);
    const statuses = {};
    for (const row of rows) {
        const status = typeof row.status === 'string' && row.status !== '' ? row.status : 'unknown';
        statuses[status] = (statuses[status] ?? 0) + 1;
    }
    return {
        total: rows.length,
        checked: dates.length,
        archived: rows.filter((row) => typeof row.archiveUrl === 'string' && row.archiveUrl !== '').length,
        statuses,
        oldestCheckedAt: dates.length ? new Date(dates[0]).toISOString() : null,
        newestCheckedAt: dates.length ? new Date(dates.at(-1)).toISOString() : null
    };
}

export function buildCollectorStatus(documents, generatedAt = new Date().toISOString()) {
    const collectors = COLLECTOR_SPECS.map((spec) => {
        const document = documents?.[spec.file] ?? null;
        return {
            id: spec.id,
            label: spec.label,
            cadenceHours: spec.cadenceHours,
            observedAt: typeof document?.[spec.timestamp] === 'string' ? document[spec.timestamp] : null,
            coverage: countAt(document, spec.countPath),
            unit: spec.unit,
            source: spec.source,
            failures: spec.id === 'authority-watch' && Number.isFinite(Number(document?.failures))
                ? Number(document.failures) : null
        };
    });
    const legal = legalSourceCoverage(documents?.sourceState);
    collectors.push({
        id: 'legal-sources',
        label: 'Legal & evidence sources',
        cadenceHours: 24,
        observedAt: legal.newestCheckedAt,
        coverage: legal.checked,
        unit: `of ${legal.total} watched URLs checked`,
        source: 'Primary documents, regulator records and cited operational pages',
        oldestObservedAt: legal.oldestCheckedAt,
        statuses: legal.statuses,
        archived: legal.archived,
        failures: legal.statuses.error ?? 0
    });
    return { generatedAt, collectors };
}

async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function usage() {
    console.log('Usage: node stocks/build-collector-status.mjs --run [--out=<file>]');
}

async function main() {
    const args = process.argv.slice(2);
    if (!args.includes('--run')) {
        usage();
        return;
    }
    const outArg = args.find((arg) => arg.startsWith('--out='));
    const output = outArg ? resolve(process.cwd(), outArg.slice(6)) : join(ROOT, 'stocks-collector-status.json');
    const files = {
        universe: 'stocks/data/universe.json',
        onchain: 'stocks/data/onchain.json',
        identities: 'stocks/data/mint-identities.json',
        chainWatch: '.last-chain-watch-stats.json',
        venues: 'stocks/data/venues.json',
        prices: 'stocks/data/reference-prices.json',
        holders: 'stocks/data/holders.json',
        trades: 'stocks/data/trades-24h.json',
        defi: 'stocks/data/defi-usage.json',
        sourceState: 'stocks/data/sources-state.json'
    };
    const documents = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) =>
        [key, await readJson(join(ROOT, path))])));
    const artifact = buildCollectorStatus(documents);
    await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    console.log(`[${artifact.generatedAt}] collector status: ${artifact.collectors.length} collectors -> ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`[${new Date().toISOString()}] collector status failed: ${error.stack ?? error.message}`);
        process.exitCode = 1;
    });
}
