#!/usr/bin/env node
// Editorial action for the public queue. This is intentionally a server/local CLI rather than a
// public write endpoint: acknowledging evidence changes must not be available to anonymous users.

import { join } from 'node:path';

import { readEnvFile } from './lib/env.mjs';
import { log, logError, parseArgs } from './lib/io.mjs';
import { psql } from './lib/psql.mjs';
import { acknowledgeEventSql } from './lib/review-queue.mjs';

const ROOT = join(import.meta.dirname, '..');

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run || !flags.event) {
        console.log('Usage: node stocks/ack-review-event.mjs --run --event=<change_event id>');
        return;
    }
    const env = { ...(await readEnvFile(join(ROOT, '.env'))), ...process.env };
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is missing from .env');
    const out = await psql(env.DATABASE_URL, acknowledgeEventSql(flags.event), 'acknowledge review event', ['-t', '-A']);
    if (!out.trim()) throw new Error(`event ${flags.event} does not exist or was already acknowledged`);
    log(`acknowledged evidence event ${flags.event}; rebuild the review queue to publish the new state`);
}

main().catch((error) => {
    logError(error.stack ?? String(error));
    process.exitCode = 1;
});
