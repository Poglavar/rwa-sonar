#!/usr/bin/env node
// Applies every sonar schema file (db/*.sql) once, in dependency order. This is the ONE place the
// schema is applied: the deploy runs it, and no scheduled job does. A job that re-applied its DDL on
// every run took `ALTER TABLE … OWNER` locks (exclusive even when nothing changes), so two jobs
// overlapping at the same minute cancelled each other on lock timeout (30 Sep, 06:35 UTC: the
// six-hour refresh and the hourly lending watcher). Every file is idempotent; a run on a current
// database changes nothing.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readEnvFile } from './lib/env.mjs';
import { log, logError, parseArgs } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { SCHEMA_FILES } from './lib/schema.mjs';

const REPO = join(import.meta.dirname, '..');

function usage() {
    console.log(`apply-schema.mjs — apply every sonar schema file, once, in order

USAGE
  node stocks/apply-schema.mjs --run

  --run    Apply the files (without it this help is printed and nothing runs).
  --help   This text.

FILES (stocks/lib/schema.mjs, in this order)
${SCHEMA_FILES.map((file) => `  db/${file}`).join('\n')}

Run by deploy-to-server.sh before the database load. Scheduled jobs never apply schema.
DATABASE_URL comes from ${join(REPO, '.env')}.`);
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run || flags.help) {
        usage();
        return;
    }
    const url = process.env.DATABASE_URL ?? (await readEnvFile(join(REPO, '.env'))).DATABASE_URL;
    if (!url) throw new Error(`DATABASE_URL is not set in ${join(REPO, '.env')}`);
    log(`apply-schema: ${describeUrl(url)} — ${SCHEMA_FILES.length} file(s)`);
    for (const [i, file] of SCHEMA_FILES.entries()) {
        const sql = await readFile(join(REPO, 'db', file), 'utf8');
        await psql(url, sql, `schema db/${file}`);
        log(`apply-schema: ${i + 1}/${SCHEMA_FILES.length} db/${file} (${sql.length} bytes)`);
    }
    log('apply-schema: done');
}

main().catch((err) => {
    logError(err.stack ?? err.message);
    process.exit(1);
});
