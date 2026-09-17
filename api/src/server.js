#!/usr/bin/env node
// Bootstrap for the read-only sonar API: bind the Hono app to 127.0.0.1 only (nginx is the only
// thing that should ever reach it) on PORT, default 3300, and shut the pool down on a signal.
// DATABASE_URL comes from the environment — locally `node --env-file=../.env src/server.js`,
// under PM2 the same flag with the absolute path. The URL is never logged; the startup line
// reports the host and database name only.

import { serve } from '@hono/node-server';

import app, { ROUTES } from './app.js';
import { closePool, describeDatabase, query } from './db.js';
import { log, logError } from './lib/log.js';

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '3300', 10);

async function main() {
    if (!process.env.DATABASE_URL) {
        logError('DATABASE_URL is not set. Run: node --env-file=../.env src/server.js');
        process.exit(1);
    }
    log(`rwa-sonar-api starting; database ${describeDatabase()}`);

    // Fail loudly at startup rather than on the first request: a wrong URL or a missing schema is
    // a deploy mistake, and it should be in the log before nginx starts sending traffic.
    const probe = await query('SELECT count(*)::int AS tokens FROM sonar.stock_token');
    log(`schema sonar reachable; ${probe.rows[0].tokens} tokens`);

    const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
        log(`listening on http://${info.address}:${info.port} (${ROUTES.length} routes)`);
    });

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            log(`${signal} received; closing`);
            server.close(async () => {
                await closePool();
                process.exit(0);
            });
        });
    }
}

main().catch(async (err) => {
    logError('startup failed:', err.stack || err.message);
    await closePool().catch(() => {});
    process.exit(1);
});
