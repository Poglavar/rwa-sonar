#!/usr/bin/env node
// One machine-readable probe for the RWA Sonar runtime. It distinguishes "nginx answers" from
// "the local API, public API and public collector artifact all answer with current data" so the
// central monitor can alert on the actual service outcome without scraping logs.

import { fetchJson, parseArgs, ts } from './lib/io.mjs';

const DEFAULT_LOCAL = 'http://127.0.0.1:3300/api/health';
const DEFAULT_PUBLIC = 'https://rwasonar.com/api/health';
const DEFAULT_STATUS = 'https://rwasonar.com/stocks-collector-status.json';

function ageMinutes(timestamp, nowMs) {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? Math.max(0, Math.round((nowMs - parsed) / 60_000)) : null;
}

export function assessRuntimeHealth({ localApi, publicApi, collectorStatus }, now = new Date()) {
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

    if (!localApiOk) reasons.push(`local API unavailable or unhealthy (HTTP ${localApi?.status ?? 'none'})`);
    if (!publicApiOk) reasons.push(`public API unavailable or unhealthy (HTTP ${publicApi?.status ?? 'none'})`);
    if (!staticStatusOk) reasons.push(`public collector status unavailable or incomplete (${collectors.length} collectors)`);
    if (!Number.isFinite(localTokens) || localTokens < 1000) reasons.push(`local API returned ${localTokens || 0} tokens, expected at least 1000`);
    if (!Number.isFinite(publicTokens) || publicTokens < 1000) reasons.push(`public API returned ${publicTokens || 0} tokens, expected at least 1000`);
    if (Number.isFinite(localTokens) && Number.isFinite(publicTokens) && localTokens !== publicTokens) {
        reasons.push(`local/public token counts differ (${localTokens}/${publicTokens})`);
    }
    if (latestBuildAgeMinutes === null || latestBuildAgeMinutes > 12 * 60) {
        reasons.push(`latest API build is ${latestBuildAgeMinutes ?? 'unknown'} minutes old, maximum 720`);
    }
    if (collectorStatusAgeMinutes === null || collectorStatusAgeMinutes > 150) {
        reasons.push(`collector status is ${collectorStatusAgeMinutes ?? 'unknown'} minutes old, maximum 150`);
    }

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

Prints exactly one JSON object suitable for the central run-stats monitor.`);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const startedMs = Date.now();
    const lastCheckStartedAt = ts(new Date(startedMs));
    const [localApi, publicApi, collectorStatus] = await Promise.all([
        get(typeof flags.local === 'string' ? flags.local : DEFAULT_LOCAL),
        get(typeof flags.public === 'string' ? flags.public : DEFAULT_PUBLIC),
        get(typeof flags.status === 'string' ? flags.status : DEFAULT_STATUS)
    ]);
    const result = assessRuntimeHealth({ localApi, publicApi, collectorStatus });
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
