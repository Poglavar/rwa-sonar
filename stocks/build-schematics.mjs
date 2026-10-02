#!/usr/bin/env node
// Builds stocks-schematics.json: the drawable schematic specs (redemption and creation flows,
// relationship maps, key what-if sequences, DeFi loops) that issuer pages, cards, the stocks issuer
// panel, learn articles and flows/exits draw with stocks/lib/flow-diagram.js. All shaping lives in
// stocks/lib/schematics.js (tested in stocks/schematics.test.js); this CLI only reads the curated
// step lists, the dossiers, the what-if catalogue and the built issuer names, and writes the file.

import { join } from 'node:path';
import { log, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';
import { loadSchematics } from './lib/schematics-load.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const DATA_DIR = join(HERE, 'data');
const OUT_FILE = 'stocks-schematics.json';

function usage() {
    console.log(`build-schematics.mjs — schematic specs for every issuer programme into ${OUT_FILE}

USAGE
  node stocks/build-schematics.mjs --run [options]

OPTIONS
  --run               Actually build. Without it this help is printed and nothing runs.
  --issuers=<file>    Built issuer records, for slugs and names (default ${join(REPO_ROOT, 'stocks-issuers.json')}).
  --curated=<file>    Curated step lists (default ${join(DATA_DIR, 'schematics.json')}).
  --out=<file>        Output path (default ${join(REPO_ROOT, OUT_FILE)}).
  --help              This text.

Deterministic: no clock is written, so a rebuild from unchanged data is byte-identical.`);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const issuersFile = flags.issuers || join(REPO_ROOT, 'stocks-issuers.json');
    const curatedFile = flags.curated || join(DATA_DIR, 'schematics.json');
    const outFile = flags.out || join(REPO_ROOT, OUT_FILE);
    log(`reading ${issuersFile}, ${curatedFile} and the dossiers in ${join(DATA_DIR, 'issuers')}`);
    const issuersDb = await readJson(issuersFile);
    const issuers = Array.isArray(issuersDb?.issuers) ? issuersDb.issuers : [];
    const curated = await readJson(curatedFile);
    const built = await loadSchematics({ issuers, curatedFile });
    const unknownIssuers = (curated.diagrams ?? []).filter((entry) => entry.role !== 'defi' && !built.issuers[entry.issuer]);
    for (const entry of unknownIssuers) logWarn(`curated diagram ${entry.id} names issuer "${entry.issuer}", which is not in the catalogue — skipped`);
    const counts = Object.values(built.issuers).reduce((acc, row) => ({
        redemption: acc.redemption + row.redemption.length,
        creation: acc.creation + row.creation.length,
        whatIf: acc.whatIf + row.whatIf.length
    }), { redemption: 0, creation: 0, whatIf: 0 });
    const noRedemption = Object.entries(built.issuers).filter(([, row]) => row.redemption.length === 0).map(([slug]) => slug);
    if (noRedemption.length) logWarn(`no redemption schematic for: ${noRedemption.join(', ')}`);
    await writeJson(outFile, built);
    log(`${Object.keys(built.issuers).length} issuers: ${counts.redemption} redemption, ${counts.creation} creation, ` +
        `${counts.whatIf} what-if sequences; ${built.defi.length} DeFi schematics`);
    log(`wrote ${outFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error(`[${ts()}] ERROR`, err.message);
        process.exitCode = 1;
    });
}
