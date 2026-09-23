// PM2 definition for the server-side collectors and API behind the tokenized-stocks pages, run from the
// repo clone /root/code/rwa-sonar on the production host. Keys (SOLANA_RPC_URL, COINGECKO_API_KEY,
// PYTH_API_KEY) live in the clone's .env, which the scripts read themselves; nothing secret here.
// CoinGecko runs in one quota-capped rotating batch per day; DexScreener refreshes every six hours.
// Restart with the FILE so PM2 re-reads it: `pm2 restart ecosystem.config.cjs --only <name> --update-env`.
module.exports = {
    apps: [
        {
            // The live tape: one pass every 3 hours over the busiest pools (+ the pinned Meteora
            // DBC pool), publishing stocks-trades.json straight into the docroot after each pass.
            name: 'rwa-trades',
            cwd: '/root/code/rwa-sonar',
            script: 'stocks/fetch-recent-trades.mjs',
            args: '--run --every=10800 --budget=400 --sync-db --pin=HzG4UEc8BgZj8ViNaKxDcvWYobZ2BwAqi6xv792DS4ua --publish-dir=/var/www/rwasonar',
            interpreter: 'node',
            autorestart: true,
            max_restarts: 50,
            restart_delay: 30000,
            watch: false,
            env: { TZ: 'UTC', RWA_DOCROOT: '/var/www/rwasonar' },
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
            args: '--run --ddl --archive',
            interpreter: 'node',
            cron_restart: '41 2 * * *',
            autorestart: false,
            watch: false,
            env: { TZ: 'UTC', RWA_DOCROOT: '/var/www/rwasonar' },
            error_file: './logs/rwa-watch-error.log',
            out_file: './logs/rwa-watch-out.log',
            merge_logs: true
        },
        {
            // Hourly on-chain watcher (stocks/EVIDENCE.md §2.4): mint extension state, authority
            // keys, scheduled rebases, metadata and labelled treasury balances for every mint;
            // writes sonar.mint_state / wallet_balance and change events. ~46 RPC calls a run.
            // Telegram is disabled here: the central bot monitor folds its outcome into the one
            // morning digest instead of this hourly job messaging independently.
            name: 'rwa-watch-chain',
            cwd: '/root/code/rwa-sonar',
            script: 'stocks/watch-chain.mjs',
            args: '--run --ddl --no-telegram',
            interpreter: 'node',
            cron_restart: '7 * * * *',
            autorestart: false,
            watch: false,
            env: { TZ: 'UTC', RWA_DOCROOT: '/var/www/rwasonar' },
            error_file: './logs/rwa-watch-chain-error.log',
            out_file: './logs/rwa-watch-chain-out.log',
            merge_logs: true
        },
        {
            // Daily case-law watcher (stocks/watch-caselaw.mjs --help): CourtListener opinions and
            // RECAP dockets plus the SEC litigation-release / administrative-proceeding feeds, per
            // issuer legal entity and party; writes sonar.litigation_case / litigation_query and
            // `litigation` change events for review. Never sets a what-if answer to `litigated`.
            // Keyless, ~160 requests paced 1.5 s apart, a few minutes. One Telegram summary only
            // when there are new events or failures.
            name: 'rwa-watch-caselaw',
            cwd: '/root/code/rwa-sonar',
            script: 'stocks/watch-caselaw.mjs',
            args: '--run --ddl',
            interpreter: 'node',
            cron_restart: '23 4 * * *',
            autorestart: false,
            watch: false,
            env: { TZ: 'UTC' },
            error_file: './logs/rwa-watch-caselaw-error.log',
            out_file: './logs/rwa-watch-caselaw-out.log',
            merge_logs: true
        },
        {
            // The change judge (stocks/judge-changes.mjs): once a day, one small Message Batches
            // batch of the newest unjudged document changes, costed per item into
            // sonar.change_judgment. Kept at 10 items (about $0.08) so a day's spend stays bounded;
            // a larger backlog run is the owner's decision. Needs ANTHROPIC_API_KEY in the clone's .env.
            name: 'rwa-judge',
            cwd: '/root/code/rwa-sonar',
            script: 'stocks/judge-changes.mjs',
            args: '--run --limit=10',
            interpreter: 'node',
            cron_restart: '47 6 * * *',
            autorestart: false,
            watch: false,
            env: { TZ: 'UTC' },
            error_file: './logs/rwa-judge-error.log',
            out_file: './logs/rwa-judge-out.log',
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
            // Hourly run-and-exit sender of personal saved-watch digests (next-steps.md item 12):
            // only watches whose owner verified a private chat with the DEDICATED watch bot and then
            // enabled the digest; one message per watch per day at its hour, only with a material
            // change. Needs WATCH_BOT_TOKEN / WATCH_BOT_USERNAME / WATCH_BOT_WEBHOOK_SECRET /
            // WATCH_DELIVERY_KEY in the clone's .env (see api/README.md). NOT in deploy-to-server.sh's
            // start list: start it by hand once the watch bot and its webhook are set up.
            name: 'rwa-watch-digest',
            cwd: '/root/code/rwa-sonar',
            script: 'api/src/jobs/send-watch-digests.js',
            args: '--run',
            interpreter: 'node',
            node_args: '--env-file=/root/code/rwa-sonar/.env',
            cron_restart: '50 * * * *',
            autorestart: false,
            watch: false,
            env: { TZ: 'UTC', RWA_BASE_URL: 'https://rwasonar.com' },
            error_file: './logs/rwa-watch-digest-error.log',
            out_file: './logs/rwa-watch-digest-out.log',
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
