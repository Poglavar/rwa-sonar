#!/usr/bin/env node
// One machine-readable probe for the RWA Sonar runtime. It distinguishes "nginx answers" from
// the local API, public API and public collector artifact, with freshness bounds derived from
// the jobs that are currently expected to publish those surfaces.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchJson, parseArgs, ts } from './lib/io.mjs';

const DEFAULT_LOCAL = 'http://127.0.0.1:3300/api/health';
const DEFAULT_PUBLIC = 'https://rwasonar.com/api/health';
const DEFAULT_STATUS = 'https://rwasonar.com/stocks-collector-status.json';

const DEFAULT_FRESHNESS_POLICY = Object.freeze({
    latestBuildMaxAgeMinutes: 720,
    collectorStatusMaxAgeMinutes: 150
});

const PUBLISHERS = Object.freeze({
    chain: 'RWA Sonar Chain Watcher',
    lending: 'RWA Sonar Lending Watcher',
    trade: 'RWA Sonar Trade Collector',
    sixHour: 'RWA Sonar Six-hour Refresh',
    documents: 'RWA Sonar Document Watcher'
});

function ageMinutes(timestamp, nowMs) {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? Math.max(0, Math.round((nowMs - parsed) / 60_000)) : null;
}

function explicitlyPaused(entry) {
    return Boolean(entry && (entry.active === false || entry.disabled === true)
        && typeof entry.mutedReason === 'string' && entry.mutedReason.trim()
        && typeof entry.unmuteWhen === 'string' && entry.unmuteWhen.trim());
}

function explicitlyActive(entry) {
    if (!entry || entry.disabled === true || entry.active === false) return false;
    if (entry.active === true) return true;
    // bot-list.json treats an unmuted entry without `active` as enabled. Unknown/muted entries
    // remain fail-closed because their pause metadata is not documented.
    return !(typeof entry.mutedReason === 'string' && entry.mutedReason.trim())
        && !(typeof entry.unmuteWhen === 'string' && entry.unmuteWhen.trim());
}

/** Derive age limits from explicit pause metadata; missing or undocumented scheduled publishers stay strict. */
export function deriveFreshnessPolicy(registry) {
    if (!Array.isArray(registry)) throw new TypeError('Bot registry must be a JSON array');
    const byName = new Map(registry.filter((entry) => typeof entry?.name === 'string')
        .map((entry) => [entry.name, entry]));
    const entry = (key) => byName.get(PUBLISHERS[key]);
    const paused = Object.fromEntries(Object.keys(PUBLISHERS).map((key) => [key, explicitlyPaused(entry(key))]));
    const hourlyAndTradePaused = paused.chain && paused.lending && paused.trade;
    const allSolanaPublishersPaused = hourlyAndTradePaused && paused.sixHour;
    const allPublishersPaused = allSolanaPublishersPaused && paused.documents;

    let collectorStatusMaxAgeMinutes = DEFAULT_FRESHNESS_POLICY.collectorStatusMaxAgeMinutes;
    if (allPublishersPaused) {
        // No publisher is expected to update the artifact. Keep requiring a valid timestamp,
        // but do not fail solely because its age grows while every publisher is disabled.
        collectorStatusMaxAgeMinutes = null;
    } else if (allSolanaPublishersPaused && explicitlyActive(entry('documents'))) {
        // The document watcher is the remaining daily publisher (including its completion grace).
        collectorStatusMaxAgeMinutes = 27 * 60;
    } else if (hourlyAndTradePaused && explicitlyActive(entry('sixHour'))) {
        // With only the six-hour refresh among the Solana publishers, allow its next cycle.
        collectorStatusMaxAgeMinutes = 7 * 60;
    }

    return {
        latestBuildMaxAgeMinutes: paused.sixHour ? null : DEFAULT_FRESHNESS_POLICY.latestBuildMaxAgeMinutes,
        collectorStatusMaxAgeMinutes
    };
}

export async function loadFreshnessPolicy(registryPath) {
    if (registryPath === undefined || registryPath === null) return { ...DEFAULT_FRESHNESS_POLICY };
    if (typeof registryPath !== 'string' || !registryPath.trim()) {
        throw new Error('--registry requires a file path');
    }
    const registry = JSON.parse(await readFile(resolve(registryPath), 'utf8'));
    return deriveFreshnessPolicy(registry);
}

function ageIssue(label, age, maxAge) {
    if (age === null) return `${label} timestamp is missing or invalid`;
    if (maxAge !== null && age > maxAge) return `${label} is ${age} minutes old, maximum ${maxAge}`;
    return null;
}

export function assessRuntimeHealth({ localApi, publicApi, collectorStatus }, now = new Date(), freshnessPolicy = DEFAULT_FRESHNESS_POLICY) {
    const nowMs = now.getTime();
    const reasons = [];
    const localBody = localApi?.json;
    const publicBody = publicApi?.json;
    const statusBody = collectorStatus?.json;
    const localApiOk = localApi?.ok === true && localBody?.ok === true;
    const publicApiOk = publicApi?.ok === true && publicBody?.ok === true;
    const collectors = Array.isArray(statusBody?.collectors) ? statusBody.collectors : [];
    const staticStatusOk = collectorStatus?.ok === true && collectors.length >= 10;
    const localTokens = Number(localBody?.counts?.tokens);
    const publicTokens = Number(publicBody?.counts?.tokens);
    const latestBuildAt = publicBody?.latestBuildAt ?? null;
    const latestBuildAgeMinutes = ageMinutes(latestBuildAt, nowMs);
    const collectorGeneratedAt = statusBody?.generatedAt ?? null;
    const collectorStatusAgeMinutes = ageMinutes(collectorGeneratedAt, nowMs);
    const latestBuildMaxAgeMinutes = freshnessPolicy.latestBuildMaxAgeMinutes;
    const collectorStatusMaxAgeMinutes = freshnessPolicy.collectorStatusMaxAgeMinutes;

    if (!localApiOk) reasons.push(`local API unavailable or unhealthy (HTTP ${localApi?.status ?? 'none'})`);
    if (!publicApiOk) reasons.push(`public API unavailable or unhealthy (HTTP ${publicApi?.status ?? 'none'})`);
    if (!staticStatusOk) reasons.push(`public collector status unavailable or incomplete (${collectors.length} collectors)`);
    if (!Number.isFinite(localTokens) || localTokens < 1000) reasons.push(`local API returned ${localTokens || 0} tokens, expected at least 1000`);
    if (!Number.isFinite(publicTokens) || publicTokens < 1000) reasons.push(`public API returned ${publicTokens || 0} tokens, expected at least 1000`);
    if (Number.isFinite(localTokens) && Number.isFinite(publicTokens) && localTokens !== publicTokens) {
        reasons.push(`local/public token counts differ (${localTokens}/${publicTokens})`);
    }
    const buildIssue = ageIssue('latest API build', latestBuildAgeMinutes, latestBuildMaxAgeMinutes);
    const collectorIssue = ageIssue('collector status', collectorStatusAgeMinutes, collectorStatusMaxAgeMinutes);
    if (buildIssue) reasons.push(buildIssue);
    if (collectorIssue) reasons.push(collectorIssue);

    return {
        runtimeStatus: reasons.length === 0 ? 'ok' : 'failed',
        localApiOk,
        publicApiOk,
        staticStatusOk,
        tokens: Number.isFinite(publicTokens) ? publicTokens : null,
        collectors: collectors.length,
        degradedCollectors: collectors.filter((row) => row?.status === 'degraded').length,
        delayedCollectors: collectors.filter((row) => row?.status === 'delayed').length,
        staleCollectors: collectors.filter((row) => row?.status === 'stale').length,
        latestBuildAt,
        latestBuildAgeMinutes,
        collectorGeneratedAt,
        collectorStatusAgeMinutes,
        buildFreshnessRequired: latestBuildMaxAgeMinutes !== null,
        latestBuildMaxAgeMinutes,
        collectorFreshnessRequired: collectorStatusMaxAgeMinutes !== null,
        collectorMaxAgeMinutes: collectorStatusMaxAgeMinutes,
        failures: reasons.length,
        failureReasons: reasons
    };
}

async function get(url) {
    try {
        // The central run-stats command itself has a 10 s ceiling. These run concurrently, so a
        // 7 s per-surface deadline leaves time to emit the structured failure instead of being killed.
        const response = await fetchJson(url, { timeoutMs: 7_000 });
        return { status: response.status, ok: response.ok, json: response.json };
    } catch (error) {
        return { status: null, ok: false, json: null, error: error.message };
    }
}

function usage() {
    console.log(`Usage: node stocks/check-runtime-health.mjs --run [options]

  --run             Probe the endpoints. Without it, print this help and do nothing.
  --local=<url>     Local API health URL (default ${DEFAULT_LOCAL})
  --public=<url>    Public API health URL (default ${DEFAULT_PUBLIC})
  --status=<url>    Public collector-status URL (default ${DEFAULT_STATUS})
  --registry=<path> Central bot-list.json; intentional publisher pauses relax only freshness limits

Prints exactly one JSON object suitable for the central run-stats monitor.`);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const freshnessPolicy = await loadFreshnessPolicy(flags.registry);
    const startedMs = Date.now();
    const lastCheckStartedAt = ts(new Date(startedMs));
    const [localApi, publicApi, collectorStatus] = await Promise.all([
        get(typeof flags.local === 'string' ? flags.local : DEFAULT_LOCAL),
        get(typeof flags.public === 'string' ? flags.public : DEFAULT_PUBLIC),
        get(typeof flags.status === 'string' ? flags.status : DEFAULT_STATUS)
    ]);
    const result = assessRuntimeHealth({ localApi, publicApi, collectorStatus }, new Date(), freshnessPolicy);
    const lastCheckEndedAt = ts();
    console.log(JSON.stringify({
        ...result,
        lastCheckStartedAt,
        lastCheckEndedAt,
        durationSec: Math.round((Date.now() - startedMs) / 100) / 10
    }));
    // The JSON field is the verdict. Keep exit zero so a run-stats monitor can parse the detailed
    // failure reasons instead of reducing every unhealthy result to "command exited non-zero".
    return 0;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
    main().then((code) => { process.exitCode = code; }, (error) => {
        console.error(error.stack ?? error.message);
        process.exitCode = 1;
    });
}
