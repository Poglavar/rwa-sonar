#!/usr/bin/env node
// One-off registration of the DEDICATED watch bot's webhook, so Telegram pushes `/start <token>`
// and `/stop` to POST /api/telegram/watch-bot. Refuses to touch the operator alerts bot: a webhook
// replaces a bot's whole update stream. Run by hand on the server after the .env is filled in.
//
//   node --env-file=/root/code/rwa-sonar/.env api/src/jobs/watch-bot-webhook.js --info
//   node --env-file=/root/code/rwa-sonar/.env api/src/jobs/watch-bot-webhook.js --set

import { deliveryConfig } from '../lib/watch-delivery.js';
import { log, logError } from '../lib/log.js';

async function call(config, method, body) {
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(15000)
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload.ok !== true) throw new Error(`${method} failed: HTTP ${res.status} ${payload.description ?? ''}`);
    return payload.result;
}

async function main(argv) {
    const mode = ['--info', '--set', '--delete'].find((flag) => argv.includes(flag));
    if (!mode) {
        console.log('Usage: watch-bot-webhook.js --info | --set | --delete   (reads WATCH_BOT_* from the env)');
        return 0;
    }
    const config = deliveryConfig();
    if (!config.configured) throw new Error(`watch bot is not configured: ${config.problem}`);
    const me = await call(config, 'getMe');
    if (me.username?.toLowerCase() !== config.botUsername.toLowerCase()) {
        throw new Error(`WATCH_BOT_TOKEN belongs to @${me.username}, not @${config.botUsername}`);
    }
    if (mode === '--set') {
        const baseUrl = (process.env.RWA_BASE_URL || 'https://rwasonar.com').replace(/\/+$/, '');
        await call(config, 'setWebhook', {
            url: `${baseUrl}/api/telegram/watch-bot`,
            secret_token: config.webhookSecret,
            allowed_updates: ['message'],
            drop_pending_updates: true
        });
        log(`@${me.username}: webhook set to ${baseUrl}/api/telegram/watch-bot`);
    } else if (mode === '--delete') {
        await call(config, 'deleteWebhook', {});
        log(`@${me.username}: webhook deleted`);
    }
    const info = await call(config, 'getWebhookInfo');
    log(`@${me.username}: url=${info.url || '(none)'} pending=${info.pending_update_count} `
        + `lastError=${info.last_error_message ?? 'none'}`);
    return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    logError(err.message);
    process.exit(1);
});
