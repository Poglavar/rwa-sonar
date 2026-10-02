#!/usr/bin/env node
// Builds the public mint-identity register from issuer registries, the reviewed catalogue and
// finalized Solana mint observations. Running without --run prints usage and changes nothing.

import { join } from 'node:path';
import { buildMintIdentities } from './lib/mint-identities.mjs';
import { log, parseArgs, readJson, writeJson } from './lib/io.mjs';

const HERE = import.meta.dirname;

function usage() {
    console.log(`build-mint-identities.mjs — build the mint identity and provenance register

USAGE
  node stocks/build-mint-identities.mjs --run [--out=<path>]

OUTPUT
  stocks/data/mint-identities.json by default`);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }
    const data = join(HERE, 'data');
    const [universe, onchain, identityOnchain, sponsorApis, manualMints] = await Promise.all([
        readJson(join(data, 'universe.json')),
        readJson(join(data, 'onchain.json')),
        readJson(join(data, 'identity-onchain.json'), null),
        readJson(join(data, 'sponsor-apis.json')),
        readJson(join(data, 'manual-mints.json'), [])
    ]);
    const output = buildMintIdentities({ universe, onchain, identityOnchain, sponsorApis, manualMints });
    const out = typeof flags.out === 'string' ? flags.out : join(data, 'mint-identities.json');
    await writeJson(out, output);
    log(`wrote ${out}: ${output.counts.total} identities, ${output.counts.catalogued} catalogued, ${output.counts.chainObserved} chain-observed, ${output.counts.pendingCatalogueIngestion} pending catalogue ingestion`);
}

main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
});
