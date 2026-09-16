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
            // Run-and-exit refresh (fetch → build → cards → install into the docroot), four times a
            // day. autorestart is off on purpose: exiting is the normal end of a run.
            name: 'rwa-refresh',
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
