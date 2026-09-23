#!/usr/bin/env node
// Builds stocks-power-map.json for powers.html ("Who can touch your tokens"): per issuer programme
// and per power, who holds it (the authority-attribution model's resolved governance), on how many
// mints it is installed, the exact authority addresses read from the chain, and whether its use is
// on record. All shaping lives in stocks/lib/power-map.mjs (tested in stocks/power-map.test.js);
// this CLI only reads the built catalogue plus the retained raw mint accounts and writes the file.

import { join } from 'node:path';
import { log, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import { buildPowerMap } from './lib/power-map.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const DATA_DIR = join(HERE, 'data');
const OUT_FILE = 'stocks-power-map.json';

function usage() {
    console.log(`build-power-map.mjs — who holds each holder-affecting power, per issuer, into ${OUT_FILE}

USAGE
  node stocks/build-power-map.mjs --run [options]

OPTIONS
  --run               Actually build. Without it this help is printed and nothing runs.
  --issuers=<file>    Built issuer records (default ${join(REPO_ROOT, 'stocks-issuers.json')}).
  --tokens=<file>     Built token records (default ${join(REPO_ROOT, 'stocks-tokens.json')}).
  --onchain=<file>    Mint read summary naming the raw file (default ${join(DATA_DIR, 'onchain.json')}).
  --raw=<file>        Raw jsonParsed mint accounts (default: stocks/data/raw/<onchain.source.rawFile>).
  --out=<file>        Output path (default ${join(REPO_ROOT, OUT_FILE)}).
  --help              This text.

The raw mint file is required: the authority addresses for pause, rebase and transfer fee exist
only there. Run after stocks/build-stocks-db.mjs (it reads that builder's output).`);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const issuersFile = flags.issuers || join(REPO_ROOT, 'stocks-issuers.json');
    const tokensFile = flags.tokens || join(REPO_ROOT, 'stocks-tokens.json');
    const onchainFile = flags.onchain || join(DATA_DIR, 'onchain.json');
    const outFile = flags.out || join(REPO_ROOT, OUT_FILE);

    const issuersDb = await readJson(issuersFile);
    const tokensDb = await readJson(tokensFile);
    const onchain = await readJson(onchainFile);
    const rawName = onchain?.source?.rawFile;
    const rawFile = flags.raw || (typeof rawName === 'string' ? join(DATA_DIR, 'raw', rawName) : null);
    if (rawFile === null) throw new Error(`${onchainFile} names no source.rawFile and no --raw was given`);
    log(`reading ${issuersFile}, ${tokensFile} and raw mint accounts ${rawFile}`);
    const raw = await readJson(rawFile);

    const map = buildPowerMap({ issuersDb, tokensDb, onchain, raw, builtAt: ts() });
    const unread = map.issuers.reduce((sum, row) => sum + (row.mints - row.mintsRead), 0);
    if (unread > 0) logWarn(`${unread} catalogued mint(s) have no raw account record — their addresses are not in the map`);
    await writeJson(outFile, map);
    log(`${map.issuers.length} issuers x ${map.powers.length} powers: ` +
        Object.entries(map.counts).map(([kind, n]) => `${kind} ${n}`).join(', '));
    log(`wrote ${outFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error(`[${ts()}] ERROR`, err.message);
        process.exitCode = 1;
    });
}
