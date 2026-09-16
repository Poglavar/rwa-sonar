#!/usr/bin/env node
// Builds the universe of tokenized stocks on Solana by unioning ~120 Jupiter search queries,
// keeping only equity-tagged records, and merging the hand-maintained data/manual-mints.json
// seed. Writes stocks/data/universe.json; resumable from a per-day checkpoint in data/raw/.

import { join } from 'node:path';
import {
    DEFAULT_PACE_MS, QUERIES, SEARCH_ENDPOINT, filterStockTokens, searchTokens, trimJupiterToken
} from './lib/jupiter.mjs';
import { STOCK_TAGS, issuerFromFreezeAuthority, issuerFromMintAuthority, issuerFromTags, underlyingTicker } from './lib/classify.mjs';
import {
    byString, isoDate, log, logError, logWarn, parseArgs, readJson, sleep, ts, writeJson
} from './lib/io.mjs';

const HERE = import.meta.dirname;
const DEFAULT_OUT = join(HERE, 'data', 'universe.json');
const MANUAL_MINTS = join(HERE, 'data', 'manual-mints.json');
const EXPECTED_MIN_TOKENS = 350; // 436 observed 2026-09-16; a big drop means the API changed.
const REWRITE_EVERY = 10;

function usage() {
    console.log(`fetch-universe.mjs — enumerate tokenized stocks on Solana via the Jupiter Tokens API v2

USAGE
  node stocks/fetch-universe.mjs --run [options]

OPTIONS
  --run                Actually fetch. Without it this help is printed and nothing runs.
  --force              Ignore today's checkpoint and re-run every query.
  --pace=<ms>          Delay between search calls (default ${DEFAULT_PACE_MS}; the lite API
                       allows ~60 calls/minute and answers 429 above that).
  --limit=<n>          Records per query, Jupiter max 100 (default 100).
  --max-queries=<n>    Only run the first n queries (smoke test).
  --queries=<a,b,c>    Run just these queries instead of the built-in list.
  --out=<path>         Output file (default stocks/data/universe.json).
  --help               This text.

NOTES
  ${QUERIES.length} queries are issued; a record is kept when its Jupiter tags include any of
  ${STOCK_TAGS.join(', ')}. Progress is checkpointed to stocks/data/raw/jupiter-search-<date>.json
  after every query, so a killed run resumes where it stopped. A 429 backs off first; a query
  that still fails is logged, listed again at the end, and retried by the next resumed run.`);
}

function issuerOf(token) {
    return issuerFromTags(token.tags) ?? issuerFromMintAuthority(token.mintAuthority) ?? issuerFromFreezeAuthority(token.freezeAuthority) ?? null;
}

function manualToItem(entry) {
    const issuer = entry.issuer || null;
    return {
        mint: entry.mint,
        name: entry.name ?? null,
        symbol: entry.symbol ?? null,
        decimals: null,
        tokenProgram: null,
        mintAuthority: null,
        freezeAuthority: null,
        dev: null,
        circSupply: null,
        totalSupply: null,
        holderCount: null,
        usdPrice: null,
        mcap: null,
        fdv: null,
        liquidity: null,
        stats24h: null,
        audit: null,
        organicScore: null,
        organicScoreLabel: null,
        isVerified: null,
        tags: [],
        firstPool: null,
        createdAt: null,
        website: null,
        issuer,
        underlyingTicker: underlyingTicker(entry.symbol, issuer),
        listedOnJupiter: false,
        manualSource: entry.source ?? null,
        note: entry.note ?? null
    };
}

function buildItems(tokensRaw, manual) {
    const items = new Map();
    for (const raw of Object.values(tokensRaw)) {
        const trimmed = trimJupiterToken(raw);
        const issuer = issuerOf(trimmed);
        items.set(trimmed.mint, {
            ...trimmed,
            issuer,
            underlyingTicker: underlyingTicker(trimmed.symbol, issuer),
            listedOnJupiter: true
        });
    }
    for (const entry of manual) {
        if (!entry || typeof entry.mint !== 'string' || entry.mint.length === 0) {
            throw new Error(`manual-mints.json entry without a mint: ${JSON.stringify(entry)}`);
        }
        const existing = items.get(entry.mint);
        if (existing) {
            logWarn(`manual mint ${entry.mint} (${entry.symbol ?? '?'}) is also on Jupiter; keeping the Jupiter record`);
            existing.note = entry.note ?? null;
            continue;
        }
        items.set(entry.mint, manualToItem(entry));
    }
    return [...items.values()].sort((a, b) => byString(a.mint, b.mint));
}

function countByIssuer(items) {
    const counts = {};
    for (const item of items) {
        const key = item.issuer ?? 'other';
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || byString(a[0], b[0])));
}

async function writeOutput(outPath, checkpoint, manual, rawFile) {
    const items = buildItems(checkpoint.tokensRaw, manual);
    const byIssuer = countByIssuer(items);
    const failed = Object.entries(checkpoint.queries)
        .filter(([, q]) => q.error)
        .map(([query, q]) => ({ query, status: q.status, error: q.error }));
    await writeJson(outPath, {
        fetchedAt: ts(),
        source: {
            endpoint: SEARCH_ENDPOINT,
            method: 'union of independent search queries — Jupiter has no authoritative tag listing for stocks',
            stockTags: STOCK_TAGS,
            queriesRun: Object.keys(checkpoint.queries).length,
            queriesFailed: failed,
            rawFile,
            counts: {
                total: items.length,
                listedOnJupiter: items.filter((i) => i.listedOnJupiter).length,
                manual: items.filter((i) => !i.listedOnJupiter).length,
                byIssuer
            }
        },
        items
    });
    return { items, byIssuer, failed };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }

    const paceMs = Number(flags.pace ?? DEFAULT_PACE_MS);
    const limit = Number(flags.limit ?? 100);
    if (!Number.isFinite(paceMs) || paceMs < 0) throw new Error(`--pace must be a non-negative number, got ${flags.pace}`);
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) throw new Error(`--limit must be 1..100, got ${flags.limit}`);

    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;
    const rawName = `jupiter-search-${isoDate()}.json`;
    const rawPath = join(HERE, 'data', 'raw', rawName);

    let queries = typeof flags.queries === 'string' ? flags.queries.split(',').map((q) => q.trim()).filter(Boolean) : QUERIES;
    if (flags['max-queries']) queries = queries.slice(0, Number(flags['max-queries']));

    const manual = await readJson(MANUAL_MINTS, []);
    log(`manual seed: ${manual.length} mint(s) from ${MANUAL_MINTS}`);

    const empty = { startedAt: ts(), endpoint: SEARCH_ENDPOINT, queries: {}, tokensRaw: {} };
    const checkpoint = flags.force ? empty : await readJson(rawPath, empty);
    const alreadyDone = Object.entries(checkpoint.queries).filter(([, q]) => !q.error).map(([q]) => q);
    const todo = queries.filter((q) => !alreadyDone.includes(q));
    if (alreadyDone.length) {
        log(`resuming from ${rawPath}: ${alreadyDone.length} query/queries already done and skipped, ${Object.keys(checkpoint.tokensRaw).length} token(s) held`);
    }
    log(`running ${todo.length}/${queries.length} query/queries at limit=${limit}, pace=${paceMs} ms`);

    for (let i = 0; i < todo.length; i += 1) {
        const query = todo[i];
        const res = await searchTokens(query, { limit });
        const matched = res.error ? [] : filterStockTokens(res.tokens);
        const fetchedAt = ts();

        for (const token of matched) {
            const prev = checkpoint.tokensRaw[token.id];
            const matchedQueries = new Set(prev?._matchedQueries ?? []);
            matchedQueries.add(query);
            checkpoint.tokensRaw[token.id] = { ...token, _fetchedAt: fetchedAt, _matchedQueries: [...matchedQueries].sort(byString) };
        }
        checkpoint.queries[query] = {
            fetchedAt,
            url: res.url,
            status: res.status,
            returned: res.tokens.length,
            matched: matched.length,
            error: res.error
        };

        const held = Object.keys(checkpoint.tokensRaw).length;
        if (res.error) {
            logError(`query ${i + 1}/${todo.length} "${query}": ${res.error}`);
        } else {
            log(`query ${i + 1}/${todo.length} "${query}": ${res.tokens.length} returned, ${matched.length} stock-tagged, ${held} unique so far`);
        }

        await writeJson(rawPath, checkpoint);
        if ((i + 1) % REWRITE_EVERY === 0) await writeOutput(outPath, checkpoint, manual, rawName);
        if (i < todo.length - 1 && paceMs > 0) await sleep(paceMs);
    }

    const { items, byIssuer, failed } = await writeOutput(outPath, checkpoint, manual, rawName);
    log(`wrote ${outPath}: ${items.length} token(s)`);
    log(`per-issuer counts: ${Object.entries(byIssuer).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (items.length < EXPECTED_MIN_TOKENS) {
        logWarn(`only ${items.length} tokens, below the ${EXPECTED_MIN_TOKENS} baseline (398 on 2026-09-16) — the search API or its tags may have changed`);
    }
    if (failed.length) {
        logError(`${failed.length} query/queries failed and are recorded in the output envelope:`);
        for (const f of failed) logError(`  "${f.query}" HTTP ${f.status}: ${f.error}`);
        return 1;
    }
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
