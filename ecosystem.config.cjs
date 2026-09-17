// PM2 definition for the two server-side jobs behind the tokenized-stocks pages, run from the
// repo clone /root/code/rwa-sonar on the production host. Keys (SOLANA_RPC_URL, COINGECKO_API_KEY,
// PYTH_API_KEY) live in the clone's .env, which the scripts read themselves; nothing secret here.
// Restart with the FILE so PM2 re-reads it: `pm2 restart ecosystem.config.cjs --only <name> --update-env`.
module.exports = {
    apps: [
        {
            // The live tape: one pass every 3 hours over the busiest pools (+ the pinned Meteora
            // DBC pool), publishing stocks-trades.json straight into the docroot after each pass.
            name: 'rwa-trades',
            cwd: '/root/code/rwa-sonar',
            script: 'stocks/fetch-recent-trades.mjs',
            args: '--run --every=10800 --budget=400 --pin=HzG4UEc8BgZj8ViNaKxDcvWYobZ2BwAqi6xv792DS4ua --publish-dir=/var/www/rwasonar',
            interpreter: 'node',
            autorestart: true,
            max_restarts: 50,
            restart_delay: 30000,
            watch: false,
            env: { TZ: 'UTC' },
            error_file: './logs/rwa-trades-error.log',
            out_file: './logs/rwa-trades-out.log',
            merge_logs: true
        },
        {
            // Daily document watcher (stocks/EVIDENCE.md): refetches every source the dossiers
            // cite, diffs the normalised text, records versions and change events in schema
            // sonar. Needs poppler-utils (pdftotext) on the host. Run-and-exit, like the refresh.
            name: 'rwa-watch',
            cwd: '/root/code/rwa-sonar',
            script: 'stocks/watch-sources.mjs',
            args: '--run --ddl',
            interpreter: 'node',
            cron_restart: '41 3 * * *',
            autorestart: false,
            watch: false,
            env: { TZ: 'UTC' },
            error_file: './logs/rwa-watch-error.log',
            out_file: './logs/rwa-watch-out.log',
            merge_logs: true
        },
        {
            // The read-only JSON API over schema sonar in geodata (api/README.md): Hono on
            // 127.0.0.1:3300, proxied by nginx at https://rwasonar.com/api/. DATABASE_URL comes
            // from the clone's .env through Node's --env-file, so no secret sits in this file.
            name: 'rwa-sonar-api',
            cwd: '/root/code/rwa-sonar/api',
            script: 'src/server.js',
            interpreter: 'node',
            node_args: '--env-file=/root/code/rwa-sonar/.env',
            autorestart: true,
            max_restarts: 50,
            restart_delay: 5000,
            watch: false,
            env: { TZ: 'UTC', PORT: '3300', HOST: '127.0.0.1' },
            error_file: '/root/code/rwa-sonar/logs/rwa-sonar-api-error.log',
            out_file: '/root/code/rwa-sonar/logs/rwa-sonar-api-out.log',
            merge_logs: true
        },
        {
            // Run-and-exit refresh (fetch → build → cards → install into the docroot), four times a
            // day. autorestart is off on purpose: exiting is the normal end of a run.
            name: 'rwa-refresh',
            cwd: '/root/code/rwa-sonar',
            script: 'stocks/refresh-on-server.sh',
            interpreter: 'bash',
            cron_restart: '17 */6 * * *',
            autorestart: false,
            watch: false,
            env: { TZ: 'UTC', RWA_DOCROOT: '/var/www/rwasonar', RWA_BASE_URL: 'https://rwasonar.com' },
            error_file: './logs/rwa-refresh-error.log',
            out_file: './logs/rwa-refresh-out.log',
            merge_logs: true
        }
    ]
};
