// The Postgres connection for the API: one lazily created `pg` Pool from DATABASE_URL,
// plus a `query()` wrapper that times every statement and warns about slow ones. The URL itself
// is never logged or returned — `describeDatabase()` reports the host, port and database name
// only, which is what a startup line needs to prove it is pointed at the right box.

import pg from 'pg';
const { Pool } = pg;

import { log, logWarn } from './lib/log.js';

// node-postgres turns a `date` column into a JavaScript Date at LOCAL midnight, so a
// snapshot_date of 2026-09-17 becomes 2026-09-16T22:00:00Z on a UTC+2 host and serialises to the
// wrong day. A `date` has no time and no zone; keep it as the text Postgres sent.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

const SLOW_MS = 500;

let pool = null;

/** Host, port and database name from DATABASE_URL. Never the user, never the password. */
export function describeDatabase(url = process.env.DATABASE_URL) {
    if (!url) return '(DATABASE_URL is not set)';
    try {
        const u = new URL(url);
        const db = decodeURIComponent(u.pathname).replace(/^\//, '') || '(no database in URL)';
        return `${u.hostname}:${u.port || '5432'}/${db}`;
    } catch {
        return '(DATABASE_URL is not a parseable URL)';
    }
}

/** The shared pool. Created on first use so importing the app needs no database. */
export function getPool() {
    if (pool) return pool;
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not set; run with --env-file=../.env');
    }
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        application_name: 'rwa-sonar-api',
        max: 8,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        // Public reads and bounded watchlist writes have no business running for more than seconds,
        // and a runaway one would otherwise hold a connection for as long as the client waits.
        statement_timeout: 15_000
    });
    pool.on('error', (err) => logWarn(`idle pool client error: ${err.message}`));
    return pool;
}

/**
 * Run one parameterised statement. `text` is always a literal from lib/, `params` are always the
 * request's values — nothing user-supplied is ever concatenated into `text`. A statement over
 * SLOW_MS is logged with its first line so it can be found without turning on log_statement.
 */
export async function query(text, params = []) {
    const started = process.hrtime.bigint();
    try {
        const result = await getPool().query(text, params);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        if (ms > SLOW_MS) {
            logWarn(`slow query ${ms.toFixed(0)} ms (${result.rowCount} rows): ${firstLine(text)}`);
        }
        return result;
    } catch (err) {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        logWarn(`query failed after ${ms.toFixed(0)} ms: ${firstLine(text)} — ${err.message}`);
        throw err;
    }
}

function firstLine(text) {
    return String(text).trim().split('\n')[0].slice(0, 160);
}

/** Close the pool (tests, and SIGTERM in server.js). */
export async function closePool() {
    if (!pool) return;
    const closing = pool;
    pool = null;
    await closing.end();
    log('database pool closed');
}
