#!/usr/bin/env node
// Builds the small public collector-status artifact used by methodology.html. It summarizes
// timestamps and coverage only; raw source text, RPC endpoints and credentials never enter it.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDocumentWatchable } from './lib/sources.mjs';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT = resolve(HERE, '..');

export const COLLECTOR_SPECS = [
    { id: 'catalogue', label: 'Token catalogue', cadenceHours: 24, file: 'universe', timestamp: 'fetchedAt', countPath: ['items'], unit: 'token records', source: 'Jupiter token search plus reviewed issuer lists' },
    { id: 'chain', label: 'On-chain token state', cadenceHours: 24, file: 'onchain', timestamp: 'fetchedAt', countPath: ['items'], unit: 'mint reads', source: 'Solana RPC' },
    { id: 'identity-chain', label: 'Issuer identity & chain coverage', cadenceHours: 24, file: 'identities', timestamp: 'fetchedAt', countPath: ['items'], unit: 'issuer-known mint identities', source: 'Issuer exact-mint registries, reserves and Solana RPC' },
    { id: 'authority-watch', label: 'Authority & extension watch', cadenceHours: 1, file: 'chainWatch', timestamp: 'lastRunEndedAt', fallbackTimestamp: 'generatedAt', countPath: ['mintsRead'], unit: 'mints checked', source: 'Solana RPC; hourly change detection' },
    { id: 'dex-market', label: 'DEX market data', cadenceHours: 6, file: 'venues', timestamp: 'fetchedAt', countPath: ['items'], unit: 'token venue records', source: 'DexScreener and on-chain pool registries' },
    { id: 'reference-prices', label: 'Reference prices', cadenceHours: 6, file: 'prices', timestamp: 'fetchedAt', countPath: ['items'], unit: 'reference records', source: 'Pyth, issuer registries and reviewed sponsor sources' },
    { id: 'holders', label: 'Holder accounts', cadenceHours: 24, file: 'holders', timestamp: 'fetchedAt', countPath: ['items'], unit: 'mint holder samples', source: 'Solana/Jupiter holder data' },
    { id: 'trade-tape', label: 'Observed DEX trades', cadenceHours: 1, file: 'tradeWatch', fallbackFile: 'trades', timestamp: 'lastRunEndedAt', fallbackTimestamp: 'updatedAt', countPath: ['windowTrades'], fallbackCountPath: ['trades'], unit: 'trades in rolling file', source: 'Solana pool transactions' },
    { id: 'defi', label: 'Confirmed DeFi integrations', cadenceHours: 6, file: 'defi', timestamp: 'fetchedAt', countPath: ['items'], unit: 'tokens reviewed', source: 'Exact-mint protocol registries plus on-chain accounts' }
];

function valueAt(record, path) {
    let value = record;
    for (const key of path) value = value?.[key];
    return value;
}

/**
 * The legal-sources watch reads ~550 pages on ~150 independent third-party hosts. One of them
 * having a bad day (a lapsed DNS zone, a 500 from someone's API) is a finding about that source,
 * already listed in the watcher's failure reasons — not the collector being degraded. So that one
 * collector tolerates failures up to this share of the sources it evaluated before it reads
 * `degraded`. Every other collector reads one provider, where any failure is its own.
 * Measured 2026-09-22/23: 1-3 errored hosts of 545 on every run (0.2-0.6 %), while a broken
 * reader (every PDF, every Notion page) fails tens of sources at once.
 */
export const LEGAL_SOURCE_FAILURE_SHARE = 0.01;

export function legalSourceFailureTolerance(sourcesEvaluated) {
    const evaluated = Number.isFinite(sourcesEvaluated) ? sourcesEvaluated : null;
    return evaluated !== null && evaluated > 0 ? Math.floor(evaluated * LEGAL_SOURCE_FAILURE_SHARE) : 0;
}

function operationalState({ observedAt, cadenceHours, failures, watchStatus, failureTolerance = 0 }, generatedAt) {
    const observed = Date.parse(observedAt);
    const now = Date.parse(generatedAt);
    if (!Number.isFinite(observed) || !Number.isFinite(now)) {
        return { status: 'unknown', ageMinutes: null, freshUntil: null };
    }
    const ageMinutes = Math.max(0, Math.round((now - observed) / 60_000));
    const currentMinutes = cadenceHours * 90;
    const delayedMinutes = cadenceHours * 180;
    const freshUntil = new Date(observed + currentMinutes * 60_000).toISOString();
    if (ageMinutes > delayedMinutes) return { status: 'stale', ageMinutes, freshUntil };
    if (ageMinutes > currentMinutes) return { status: 'delayed', ageMinutes, freshUntil };
    const failureCount = Number.isFinite(failures) ? failures : null;
    const degraded = watchStatus === 'failed'
        || (failureTolerance > 0 && failureCount !== null
            ? failureCount > failureTolerance
            : watchStatus === 'partial' || (failureCount !== null && failureCount > 0));
    if (degraded) return { status: 'degraded', ageMinutes, freshUntil };
    return { status: 'current', ageMinutes, freshUntil };
}
function countAt(record, path) {
    if (record === null || record === undefined || !Array.isArray(path) || path.length === 0) return null;
    const value = valueAt(record, path);
    if (Array.isArray(value)) return value.length;
    if (value === null || value === undefined || value === '') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function legalSourceCoverage(state, registry = null) {
    const hasRegistry = Array.isArray(registry?.items);
    // Only what the document watcher actually reads: on-chain locators (explorer addresses, the
    // bare Raydium lookup route) are registry entries left to the chain watcher, and their stale
    // state rows would otherwise inflate both the total and the error count.
    const activeUrls = new Set(hasRegistry
        ? registry.items.map((item) => item?.url)
            .filter((url) => typeof url === 'string' && url !== '' && isDocumentWatchable(url))
        : []);
    const entries = Object.entries(state && typeof state === 'object' ? state : {});
    const rows = entries
        .filter(([url, row]) => row && (!hasRegistry || activeUrls.has(url)))
        .map(([, row]) => row);
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
        const primary = documents?.[spec.file] ?? null;
        const document = primary ?? documents?.[spec.fallbackFile] ?? null;
        const observedAt = typeof document?.[spec.timestamp] === 'string'
            ? document[spec.timestamp]
            : (typeof document?.[spec.fallbackTimestamp] === 'string' ? document[spec.fallbackTimestamp] : null);
        const coverage = countAt(document, spec.countPath) ?? countAt(document, spec.fallbackCountPath ?? []);
        const failures = Number.isFinite(Number(document?.failures)) ? Number(document.failures) : null;
        const watchStatus = document?.watchStatus ?? document?.refreshStatus ?? null;
        return {
            id: spec.id,
            label: spec.label,
            cadenceHours: spec.cadenceHours,
            observedAt,
            coverage,
            unit: spec.unit,
            source: spec.source,
            failures,
            watchStatus,
            ...operationalState({ observedAt, cadenceHours: spec.cadenceHours, failures, watchStatus }, generatedAt)
        };
    });
    const legal = legalSourceCoverage(documents?.sourceState, documents?.sourceRegistry);
    const sourceWatch = documents?.sourceWatch ?? null;
    const sourceObservedAt = sourceWatch?.lastRunEndedAt ?? legal.newestCheckedAt;
    const sourceFailures = Number.isFinite(Number(sourceWatch?.failures))
        ? Number(sourceWatch.failures) : (legal.statuses.error ?? 0);
    const sourceStatus = sourceWatch?.watchStatus ?? null;
    const sourcesEvaluated = Number.isFinite(sourceWatch?.sourcesEvaluated) ? sourceWatch.sourcesEvaluated : null;
    const failureTolerance = legalSourceFailureTolerance(sourcesEvaluated);
    collectors.push({
        id: 'legal-sources',
        label: 'Legal & evidence sources',
        cadenceHours: 24,
        observedAt: sourceObservedAt,
        coverage: legal.checked,
        unit: `of ${legal.total} watched URLs checked`,
        source: 'Primary documents, regulator records and cited operational pages',
        oldestObservedAt: legal.oldestCheckedAt,
        statuses: legal.statuses,
        archived: legal.archived,
        failures: sourceFailures,
        watchStatus: sourceStatus,
        failureTolerance,
        sourcesEvaluated,
        httpFetches: sourceWatch?.httpFetches ?? null,
        resumedFromCheckpoint: sourceWatch?.resumedFromCheckpoint ?? null,
        ...operationalState({
            observedAt: sourceObservedAt, cadenceHours: 24, failures: sourceFailures, watchStatus: sourceStatus, failureTolerance
        }, generatedAt)
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

export async function refreshCollectorStatus({ outputs = [join(ROOT, 'stocks-collector-status.json')] } = {}) {
    const files = {
        universe: 'stocks/data/universe.json',
        onchain: 'stocks/data/onchain.json',
        identities: 'stocks/data/mint-identities.json',
        chainWatch: '.last-chain-watch-stats.json',
        venues: 'stocks/data/venues.json',
        prices: 'stocks/data/reference-prices.json',
        holders: 'stocks/data/holders.json',
        trades: 'stocks/data/trades-24h.json',
        tradeWatch: '.last-trade-watch-stats.json',
        defi: 'stocks/data/defi-usage.json',
        sourceState: 'stocks/data/sources-state.json',
        sourceRegistry: 'stocks/data/sources.json',
        sourceWatch: '.last-source-watch-stats.json'
    };
    const documents = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) =>
        [key, await readJson(join(ROOT, path))])));
    const artifact = buildCollectorStatus(documents);
    const body = `${JSON.stringify(artifact, null, 2)}\n`;
    for (const output of [...new Set(outputs.map((path) => resolve(path)))]) {
        const temporary = `${output}.${process.pid}.tmp`;
        await writeFile(temporary, body, 'utf8');
        await rename(temporary, output);
    }
    return artifact;
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
    const artifact = await refreshCollectorStatus({ outputs: [output] });
    console.log(`[${artifact.generatedAt}] collector status: ${artifact.collectors.length} collectors -> ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`[${new Date().toISOString()}] collector status failed: ${error.stack ?? error.message}`);
        process.exitCode = 1;
    });
}
