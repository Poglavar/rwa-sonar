#!/usr/bin/env node
// Runs the shared deterministic generated-release builders in dependency order. Collection and
// source observation timestamps are intentionally owned by earlier pipeline steps.
import { spawn } from 'node:child_process';
import { parseArgs, log, logError } from './lib/io.mjs';
import { RELEASE_BUILD_STAGES } from './lib/release-manifest.mjs';

function run(script, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, '--run', ...args], { stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
    });
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run) {
        console.log('node stocks/build-release-artifacts.mjs --run --phase=base|pre-review|surfaces [--base-url=https://rwasonar.com]');
        return;
    }
    const phase = flags.phase ?? 'surfaces';
    const builders = RELEASE_BUILD_STAGES[phase];
    if (!builders) throw new Error(`unknown release build phase ${phase}; expected ${Object.keys(RELEASE_BUILD_STAGES).join(', ')}`);
    const args = flags['base-url'] ? [`--base-url=${flags['base-url']}`] : [];
    for (const builder of builders) await run(builder, args);
    log(`built ${builders.length} release artifact builder(s) for ${phase}`);
}
if (import.meta.filename === process.argv[1]) main().catch((error) => { logError(error.stack ?? String(error)); process.exit(1); });
