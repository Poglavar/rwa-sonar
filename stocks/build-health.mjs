#!/usr/bin/env node
// Builds stocks-health.json: the eleven lib/health.mjs rules run over every mint, reduced to one
// status per rule plus the worst-of roll-up and the programme / this-token levels (with the count
// of checks each token passes), so a page can colour every token without loading the
// four source files (1.1 MB + 2.4 MB + 2.5 MB + 613 kB) or re-deriving anything. Deliberately thin:
// no rule `inputs` and no notes, which is what keeps it small enough to fetch — a stock card needs
// those and therefore calls evaluateHealth itself (stocks/build-cards.mjs) rather than reading this.

import { join } from 'node:path';
import { HEALTH_DIMENSIONS, HEALTH_LEVELS, HEALTH_RULES, evaluateHealth } from './lib/health.mjs';
import { composabilityTemplateFor, indexComposabilityTemplates } from './lib/composability.mjs';
import { byString, log, logError, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import fmt from './lib/fmt.js';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const TOKENS_PATH = join(REPO_ROOT, 'stocks-tokens.json');
const ISSUERS_PATH = join(REPO_ROOT, 'stocks-issuers.json');
const HOLDERS_PATH = join(HERE, 'data', 'holders.json');
const TRADES_PATH = join(REPO_ROOT, 'stocks-trades.json');
const COMPOSABILITY_PATH = join(HERE, 'data', 'composability-templates.json');
const DEFAULT_OUT = join(REPO_ROOT, 'stocks-health.json');

/** Values are display-only here, so six significant figures is plenty and keeps the file stable. */
const VALUE_DIGITS = 6;

function usage() {
    console.log(`build-health.mjs — the eleven health rules for every mint, as one small file

USAGE
  node stocks/build-health.mjs --run [options]

OPTIONS
  --run                 Actually build. Without it this help is printed and nothing runs.
  --out=<path>          Output file (default stocks-health.json in the repo root).
  --help                This text.

INPUTS
  stocks-tokens.json         .tokens[] — price, reference, market, activity, control
  stocks-issuers.json        .issuers[] — verification strength and the authority keys
  stocks/data/holders.json   .items[] — the top 20 holders, for concentration and frozen accounts
  stocks-trades.json         .pools[] — signaturesSeen / failedTx per pool, for the failed-swap rate
  stocks/data/composability-templates.json — reviewed issuer + control-recipe outcomes

OUTPUT
  {generatedAt, sources, counts, byLevel, byTokenWorstRule, byWorstRule, levels, rules, items[]}
  sorted by mint. Each item carries {mint, symbol, issuer, status, worstRuleId, levels, dimensions,
  rules:{<id>: status}, values:{<id>: value}} and nothing else: a rule whose inputs are missing is
  \`unknown\`, which is never counted as bad. \`levels.programme\` / \`levels.token\` are the headline
  (the issuer's shared verdict and this token's, each with passed of judged checks).`);
}

/** This mint's pools from the trade tape. A mint with no pool is [] — the rule then reads unknown. */
function poolsByMint(pools) {
    const index = new Map();
    for (const pool of Array.isArray(pools) ? pools : []) {
        const mint = typeof pool?.mint === 'string' ? pool.mint : null;
        if (mint === null) continue;
        if (!index.has(mint)) index.set(mint, []);
        index.get(mint).push(pool);
    }
    return index;
}

function indexBy(list, key) {
    const index = new Map();
    for (const row of Array.isArray(list) ? list : []) {
        const id = typeof row?.[key] === 'string' ? row[key] : null;
        if (id !== null) index.set(id, row);
    }
    return index;
}

/**
 * One item per token: the two maps keyed by rule id (so a consumer can colour a single rule without
 * knowing the order) and nothing that could be recomputed from them.
 */
export function buildItems({ tokens, issuers, holders, pools, composabilityTemplates = [] }) {
    const issuerIndex = indexBy(issuers, 'slug');
    const holdersIndex = indexBy(holders, 'mint');
    const poolIndex = poolsByMint(pools);
    const composabilityIndex = indexComposabilityTemplates(composabilityTemplates);
    const items = [];

    for (const token of Array.isArray(tokens) ? tokens : []) {
        if (typeof token?.mint !== 'string') continue;
        const verdict = evaluateHealth({
            token,
            issuer: issuerIndex.get(token.issuer) ?? null,
            holders: holdersIndex.get(token.mint) ?? null,
            pools: poolIndex.get(token.mint) ?? null,
            composabilityTemplate: composabilityTemplateFor(token, composabilityIndex)
        });
        const rules = {};
        const values = {};
        for (const rule of verdict.rules) {
            rules[rule.id] = rule.status;
            values[rule.id] = fmt.roundSignificant(rule.value, VALUE_DIGITS);
        }
        items.push({
            mint: token.mint,
            symbol: token.symbol ?? null,
            issuer: token.issuer ?? null,
            status: verdict.status,
            worstRuleId: verdict.worstRuleId,
            levels: verdict.levels,
            dimensions: verdict.dimensions,
            rules,
            values
        });
    }

    items.sort((a, b) => byString(a.mint, b.mint));
    return items;
}

/**
 * Counts per status — overall, per level and per dimension — and how often each rule is the one
 * dragging a token down: overall (`byWorstRule`, where the programme rules dominate because they
 * are the same for every token of an issuer) and at the token level (`byTokenWorstRule`, which is
 * what actually separates one token from another).
 */
export function summarize(items) {
    const counts = { good: 0, caution: 0, warning: 0, unknown: 0 };
    const byLevel = Object.fromEntries(HEALTH_LEVELS.map((level) => [level.id, { good: 0, caution: 0, warning: 0, unknown: 0 }]));
    const byTokenWorstRule = {};
    for (const rule of HEALTH_RULES) if (rule.level === 'token') byTokenWorstRule[rule.id] = 0;
    const byDimension = Object.fromEntries(HEALTH_DIMENSIONS.map((dimension) => [
        dimension.id,
        { good: 0, caution: 0, warning: 0, unknown: 0 }
    ]));
    const byWorstRule = {};
    for (const rule of HEALTH_RULES) byWorstRule[rule.id] = 0;
    for (const item of Array.isArray(items) ? items : []) {
        if (item.status in counts) counts[item.status] += 1;
        if (typeof item.worstRuleId === 'string' && item.worstRuleId in byWorstRule) {
            byWorstRule[item.worstRuleId] += 1;
        }
        for (const dimension of HEALTH_DIMENSIONS) {
            const status = item?.dimensions?.[dimension.id]?.status;
            if (status in byDimension[dimension.id]) byDimension[dimension.id][status] += 1;
        }
        for (const level of HEALTH_LEVELS) {
            const status = item?.levels?.[level.id]?.status;
            if (status in byLevel[level.id]) byLevel[level.id][status] += 1;
        }
        // A level names only a failing rule, so a good or unmeasured token counts under no rule.
        const tokenWorst = item?.levels?.token?.worstRuleId;
        if (typeof tokenWorst === 'string' && tokenWorst in byTokenWorstRule) byTokenWorstRule[tokenWorst] += 1;
    }
    return { counts, byLevel, byTokenWorstRule, byDimension, byWorstRule };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }
    const outPath = typeof flags.out === 'string' ? flags.out : DEFAULT_OUT;

    const tokenDb = await readJson(TOKENS_PATH);
    if (!Array.isArray(tokenDb?.tokens)) throw new Error(`${TOKENS_PATH}: expected {tokens:[...]}`);
    const issuerDb = await readJson(ISSUERS_PATH);
    if (!Array.isArray(issuerDb?.issuers)) throw new Error(`${ISSUERS_PATH}: expected {issuers:[...]}`);
    const holderDb = await readJson(HOLDERS_PATH, { fetchedAt: null, items: [] });
    const tradeDb = await readJson(TRADES_PATH, { generatedAt: null, pools: [] });
    const composabilityDb = await readJson(COMPOSABILITY_PATH, { reviewedAt: null, templates: [] });

    if (!Array.isArray(holderDb?.items) || holderDb.items.length === 0) {
        logWarn(`${HOLDERS_PATH} has no items — the concentration and frozen-account rules will read unknown`);
    }
    if (!Array.isArray(tradeDb?.pools) || tradeDb.pools.length === 0) {
        logWarn(`${TRADES_PATH} has no pools — the failed-swap rule will read unknown`);
    }

    log(`read ${tokenDb.tokens.length} token(s) (built ${tokenDb.builtAt}), ${issuerDb.issuers.length} issuer(s), ` +
        `${holderDb?.items?.length ?? 0} holder record(s), ${tradeDb?.pools?.length ?? 0} pool(s)`);

    const items = buildItems({
        tokens: tokenDb.tokens,
        issuers: issuerDb.issuers,
        holders: holderDb?.items ?? [],
        pools: tradeDb?.pools ?? [],
        composabilityTemplates: composabilityDb?.templates ?? []
    });
    const { counts, byLevel, byTokenWorstRule, byDimension, byWorstRule } = summarize(items);

    await writeJson(outPath, {
        generatedAt: ts(),
        sources: {
            tokens: tokenDb.builtAt ?? null,
            holders: holderDb?.fetchedAt ?? null,
            trades: tradeDb?.generatedAt ?? null,
            composability: composabilityDb?.reviewedAt ?? null
        },
        counts,
        levels: HEALTH_LEVELS,
        byLevel,
        byTokenWorstRule,
        dimensions: HEALTH_DIMENSIONS,
        byDimension,
        byWorstRule,
        rules: HEALTH_RULES,
        items
        // Written without indentation: a page fetches this whole file, and the same payload is
        // 233 kB compact against 306 kB at one space and 354 kB at two. Nothing hand-edits it.
    }, 0);

    const worst = Object.entries(byWorstRule)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))
        .map(([id, n]) => `${id} ${n}`)
        .join(', ');
    log(`wrote ${outPath}: ${items.length} item(s) — ${counts.good} good, ${counts.caution} caution, ` +
        `${counts.warning} warning, ${counts.unknown} unknown`);
    log(`worst rule: ${worst || 'none (every token is unknown)'}`);
    for (const level of HEALTH_LEVELS) {
        const c = byLevel[level.id];
        log(`${level.label.toLowerCase()} level: ${c.good} good, ${c.caution} caution, ${c.warning} warning, ${c.unknown} not measured`);
    }
    const tokenWorst = Object.entries(byTokenWorstRule)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))
        .map(([id, n]) => `${id} ${n}`)
        .join(', ');
    log(`worst token-level rule: ${tokenWorst || 'none'}`);
    return 0;
}

if (import.meta.filename === process.argv[1]) {
    main().then((code) => process.exit(code), (err) => {
        logError(err.stack ?? String(err));
        process.exit(1);
    });
}
