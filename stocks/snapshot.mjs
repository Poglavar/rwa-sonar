#!/usr/bin/env node
// Freezes one day of the tokenized-stock universe into stocks/data/history/<date>/tokens.json and
// issuers.json — the slim, committed rows the change log diffs day over day. Only fields whose
// change is worth a line are kept (see lib/changes.mjs), so a day costs tens of kilobytes rather
// than the megabyte stocks-tokens.json weighs. Re-running the same date overwrites it, and the
// --from-* options let a snapshot be synthesised from an older committed build, so yesterday can be
// reconstructed after the fact and the change log has two days to compare.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isoDate, log, logError, logWarn, parseArgs, readJson, writeJson } from './lib/io.mjs';
import { snapshotIssuerRow, snapshotTokenRow } from './lib/changes.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const TOKENS_PATH = join(REPO_ROOT, 'stocks-tokens.json');
const ISSUERS_PATH = join(REPO_ROOT, 'stocks-issuers.json');
const HEALTH_PATH = join(REPO_ROOT, 'stocks-health.json');
const HISTORY_DIR = join(HERE, 'data', 'history');

/** History files are indented by one space: they are committed daily, and 2 spaces costs ~15 %. */
const INDENT = 1;
/**
 * A day of tokens over this many bytes means the row shape has GROWN and should be trimmed again.
 *
 * It is not a wish: with the 21 field names this row carries, `"frozenAccountsTop20": ` and friends
 * cost ~296 bytes of key syntax per row before a single value, which is ~130 KB across 441 mints
 * even with no whitespace at all. So the ~250 KB this writes is close to the floor for a row keyed
 * by readable names, and a real reduction means dropping fields or going columnar — not reformatting.
 * The 6-significant-figure rounding in lib/changes.mjs is what keeps a rebuild byte-identical, which
 * is what actually bounds the repository: an unchanged day re-snapshots to no git diff at all.
 */
const TOKEN_BUDGET_BYTES = 400 * 1024;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function usage() {
    console.log(`snapshot.mjs — freeze one day of the universe for the change log

USAGE
  node stocks/snapshot.mjs --run [options]

OPTIONS
  --run                     Actually write. Without it this help is printed and nothing runs.
  --date=YYYY-MM-DD         The day to write (default: today, UTC). Re-running overwrites it.
  --from-tokens=<path>      Read tokens from this file instead of stocks-tokens.json.
  --from-issuers=<path>     Read issuers from this file instead of stocks-issuers.json.
  --from-health=<path|none> Read health from this file instead of stocks-health.json;
                            "none" means no health file, so health and worstRuleId are null.
  --help                    This text.

OUTPUT
  stocks/data/history/<date>/tokens.json   {date, builtAt, healthGeneratedAt, items:[...]}
  stocks/data/history/<date>/issuers.json  same envelope, issuer rows

  \`builtAt\` is the SOURCE build's timestamp, not the time this ran, so a snapshot synthesised from
  an older build still says which build it describes. Rows are sorted by mint / slug, so the same
  inputs always produce a byte-identical file and a re-run shows up as no diff at all.

SYNTHESISING AN OLDER DAY
  git show <ref>:stocks-tokens.json  > /tmp/tokens.json
  git show <ref>:stocks-issuers.json > /tmp/issuers.json
  node stocks/snapshot.mjs --run --date=2026-09-16 \\
      --from-tokens=/tmp/tokens.json --from-issuers=/tmp/issuers.json --from-health=none

  A build older than the holders fetch or the health rules simply leaves those fields null; the diff
  never fires a numeric or health change off a null, so a reconstructed day cannot invent movement.`);
}

/** `{mint: healthItem}` for whatever the health file gave us; an absent file is an empty index. */
function indexHealth(health) {
    const out = new Map();
    for (const item of Array.isArray(health?.items) ? health.items : []) {
        if (typeof item?.mint === 'string' && item.mint !== '') out.set(item.mint, item);
    }
    return out;
}

function byKey(key) {
    return (a, b) => {
        const left = a?.[key] ?? '';
        const right = b?.[key] ?? '';
        if (left === right) return 0;
        return left < right ? -1 : 1;
    };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return 0;
    }

    const date = typeof flags.date === 'string' ? flags.date : isoDate();
    if (!DATE_RE.test(date)) throw new Error(`--date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);

    const tokensPath = typeof flags['from-tokens'] === 'string' ? flags['from-tokens'] : TOKENS_PATH;
    const issuersPath = typeof flags['from-issuers'] === 'string' ? flags['from-issuers'] : ISSUERS_PATH;
    const healthFlag = flags['from-health'];
    const healthPath = typeof healthFlag === 'string' ? healthFlag : HEALTH_PATH;
    const wantHealth = healthFlag !== 'none';

    const tokens = await readJson(tokensPath);
    if (!Array.isArray(tokens?.tokens)) throw new Error(`${tokensPath}: expected {tokens:[...]}`);
    const issuers = await readJson(issuersPath);
    if (!Array.isArray(issuers?.issuers)) throw new Error(`${issuersPath}: expected {issuers:[...]}`);

    let health = null;
    if (wantHealth) {
        health = await readJson(healthPath, null);
        if (health === null) {
            logWarn(`${healthPath} is absent — health and worstRuleId will be null for every row `
                + '(run stocks/build-health.mjs first to record the verdicts)');
        } else if (!Array.isArray(health.items)) {
            throw new Error(`${healthPath}: expected {items:[...]}`);
        }
    } else {
        log('--from-health=none: health and worstRuleId will be null for every row');
    }

    const healthByMint = indexHealth(health);
    const healthGeneratedAt = health?.generatedAt ?? null;

    const tokenItems = tokens.tokens
        .map((token) => snapshotTokenRow(token, healthByMint.get(token?.mint) ?? null))
        .sort(byKey('mint'));
    const issuerItems = issuers.issuers.map(snapshotIssuerRow).sort(byKey('slug'));

    const dir = join(HISTORY_DIR, date);
    const tokensOut = await writeJson(join(dir, 'tokens.json'), {
        date,
        builtAt: tokens.builtAt ?? null,
        healthGeneratedAt,
        items: tokenItems
    }, INDENT);
    const issuersOut = await writeJson(join(dir, 'issuers.json'), {
        date,
        builtAt: issuers.builtAt ?? tokens.builtAt ?? null,
        healthGeneratedAt,
        items: issuerItems
    }, INDENT);

    const withHealth = tokenItems.filter((row) => row.health !== null).length;
    const withHolders = tokenItems.filter((row) => row.top1SharePct !== null).length;
    const tokenBytes = (await stat(tokensOut)).size;

    log(`wrote ${tokensOut}: ${tokenItems.length} token row(s) from build ${tokens.builtAt ?? 'unknown'} `
        + `(${withHealth} with a health verdict, ${withHolders} with holder concentration), ${(tokenBytes / 1024).toFixed(1)} KB`);
    if (tokenBytes > TOKEN_BUDGET_BYTES) {
        logWarn(`tokens.json is ${(tokenBytes / 1024).toFixed(1)} KB, over the ${TOKEN_BUDGET_BYTES / 1024} KB/day budget `
            + '— a field has been added to snapshotTokenRow; drop one rather than committing this every day');
    }
    log(`wrote ${issuersOut}: ${issuerItems.length} issuer row(s)`);
    return 0;
}

main().then((code) => process.exit(code), (err) => {
    logError(err.stack ?? String(err));
    process.exit(1);
});
