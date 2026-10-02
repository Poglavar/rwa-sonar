// Owner-only private delivery for saved watches, plus the dedicated watch bot's Telegram webhook.
// The owner key (never the read-only share key) creates a one-time, 15-minute binding link; the
// chat that sends `/start <token>` to the watch bot becomes the verified delivery channel; only a
// verified watch may enable its morning digest. No response of any route here, or anywhere else,
// contains the chat id: it is stored only as AES-GCM ciphertext and a keyed hash.

import { Hono } from 'hono';

import { query } from '../db.js';
import { log, logWarn } from '../lib/log.js';
import { ApiError } from '../lib/query.js';
import {
    BINDING_TTL_MS, BOT_REPLIES, bindingUrl, chatHash, createBindingToken, deliveryConfig,
    encryptChatId, hashBindingToken, parseBotCommand, safeEqual, watchBotClient
} from '../lib/watch-delivery.js';
import { ownedWatch } from './watchlists.js';

const routes = new Hono();
const PRIVATE = 'private, no-store';

function requireConfigured() {
    const config = deliveryConfig();
    if (!config.configured) {
        throw new ApiError(503, 'delivery_unconfigured', 'private digest delivery is not configured on this server');
    }
    return config;
}

async function deliveryStatus(watch) {
    const config = deliveryConfig();
    const [{ rows: bound }, { rows: pending }] = await Promise.all([
        query('SELECT verified_at FROM sonar.stock_watch_delivery WHERE watch_id = $1', [watch.watch_id]),
        query(`SELECT max(expires_at) AS expires_at FROM sonar.stock_watch_binding
               WHERE watch_id = $1 AND used_at IS NULL AND expires_at > now()`, [watch.watch_id])
    ]);
    return {
        watchId: watch.watch_id,
        channel: 'telegram',
        available: config.configured,
        bot: config.configured ? `@${config.botUsername}` : null,
        bound: Boolean(bound[0]),
        verifiedAt: bound[0]?.verified_at ?? null,
        pendingLinkExpiresAt: pending[0]?.expires_at ?? null,
        digest: {
            // A legacy row may carry the reserved flag without a verified chat; it is not delivered.
            enabled: watch.digest_enabled === true && Boolean(bound[0]),
            hour: watch.digest_hour ?? 6,
            timezone: watch.digest_timezone ?? 'UTC'
        }
    };
}

routes.get('/watchlists/:watchId/delivery', async (c) => {
    const watch = await ownedWatch(c);
    c.header('Cache-Control', PRIVATE);
    return c.json(await deliveryStatus(watch));
});

routes.post('/watchlists/:watchId/delivery/telegram', async (c) => {
    const watch = await ownedWatch(c);
    const config = requireConfigured();
    const { token, tokenHash } = createBindingToken();
    const expiresAt = new Date(Date.now() + BINDING_TTL_MS).toISOString();
    // A new link replaces any unused earlier one, so at most one live token exists per watch.
    await query(`
        WITH cleared AS (
            DELETE FROM sonar.stock_watch_binding WHERE watch_id = $1 AND used_at IS NULL
        )
        INSERT INTO sonar.stock_watch_binding (token_hash, watch_id, expires_at)
        VALUES ($2, $1, $3::timestamptz)`, [watch.watch_id, tokenHash, expiresAt]);
    log(`watch ${watch.watch_id}: telegram binding link created, expires ${expiresAt}`);
    return c.json({ watchId: watch.watch_id, url: bindingUrl(config.botUsername, token), expiresAt }, 201);
});

routes.delete('/watchlists/:watchId/delivery', async (c) => {
    const watch = await ownedWatch(c);
    await query(`
        WITH gone AS (
            DELETE FROM sonar.stock_watch_delivery WHERE watch_id = $1
        ), tokens AS (
            DELETE FROM sonar.stock_watch_binding WHERE watch_id = $1 AND used_at IS NULL
        )
        UPDATE sonar.stock_watchlist SET digest_enabled = false, updated_at = now() WHERE watch_id = $1`,
    [watch.watch_id]);
    log(`watch ${watch.watch_id}: delivery unbound by owner`);
    return c.body(null, 204);
});

function parseDigestBody(body, current) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') {
        throw new ApiError(400, 'invalid_digest', 'body must be {"enabled": true|false, "hour"?: 0–23, "timezone"?: IANA}');
    }
    const hour = body.hour === undefined ? current.digest_hour ?? 6 : body.hour;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw new ApiError(400, 'invalid_digest_hour', 'digest hour must be an integer from 0 to 23');
    }
    const timezone = body.timezone === undefined ? current.digest_timezone ?? 'UTC' : String(body.timezone).trim();
    try {
        new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    } catch {
        throw new ApiError(400, 'invalid_digest_timezone', 'digest timezone must be an IANA timezone');
    }
    return { enabled: body.enabled, hour, timezone };
}

routes.put('/watchlists/:watchId/digest', async (c) => {
    const watch = await ownedWatch(c);
    let body;
    try {
        body = await c.req.json();
    } catch {
        throw new ApiError(400, 'invalid_json', 'request body must be valid JSON');
    }
    const digest = parseDigestBody(body, watch);
    // Enabling requires a verified chat, checked in the same statement that sets the flag. The
    // digest starts from "now": changes found before the owner opted in are never sent.
    const { rows } = await query(`
        WITH updated AS (
            UPDATE sonar.stock_watchlist w
            SET digest_enabled = $2, digest_hour = $3, digest_timezone = $4, updated_at = now()
            WHERE w.watch_id = $1
              AND (NOT $2 OR EXISTS (SELECT 1 FROM sonar.stock_watch_delivery d WHERE d.watch_id = w.watch_id))
            RETURNING w.watch_id
        ), since AS (
            UPDATE sonar.stock_watch_delivery d SET digest_since = now(), updated_at = now()
            FROM updated
            WHERE d.watch_id = updated.watch_id AND $2 AND (NOT $5 OR d.digest_since IS NULL)
        )
        SELECT watch_id FROM updated`,
    [watch.watch_id, digest.enabled, digest.hour, digest.timezone, watch.digest_enabled === true]);
    if (!rows[0]) {
        throw new ApiError(409, 'digest_delivery_unverified',
            'connect a private Telegram chat to this watch before enabling its digest');
    }
    log(`watch ${watch.watch_id}: digest ${digest.enabled ? `enabled at ${digest.hour}:00 ${digest.timezone}` : 'disabled'}`);
    return c.json(await deliveryStatus({ ...watch, digest_enabled: digest.enabled,
        digest_hour: digest.hour, digest_timezone: digest.timezone }));
});

async function reply(config, chatId, message) {
    const result = await watchBotClient(config).sendMessage(chatId, message);
    if (!result.ok) logWarn(`watch-bot: reply failed (${result.reason})`);
}

async function handleStart(config, command) {
    const tokenHash = hashBindingToken(command.token);
    const hash = chatHash(command.chatId, config.key);
    const { rows } = await query(`
        WITH claimed AS (
            UPDATE sonar.stock_watch_binding SET used_at = now(), updated_at = now()
            WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
            RETURNING watch_id
        )
        INSERT INTO sonar.stock_watch_delivery (watch_id, chat_enc, chat_hash, verified_at)
        SELECT watch_id, $2, $3, now() FROM claimed
        ON CONFLICT (watch_id) DO UPDATE
            SET chat_enc = EXCLUDED.chat_enc, chat_hash = EXCLUDED.chat_hash, verified_at = now(), updated_at = now()
        RETURNING watch_id`, [tokenHash, encryptChatId(command.chatId, config.key), hash]);
    if (rows[0]) {
        log(`watch ${rows[0].watch_id}: private telegram chat verified`);
        return BOT_REPLIES.bound;
    }
    // Telegram redelivers an update it thinks failed; the same chat re-sending a used link is not an error.
    const { rows: same } = await query(`
        SELECT 1 FROM sonar.stock_watch_binding b
        JOIN sonar.stock_watch_delivery d ON d.watch_id = b.watch_id
        WHERE b.token_hash = $1 AND b.used_at IS NOT NULL AND d.chat_hash = $2`, [tokenHash, hash]);
    return same[0] ? BOT_REPLIES.alreadyBound : BOT_REPLIES.expired;
}

async function handleStop(config, command) {
    const { rows } = await query(`
        WITH gone AS (
            DELETE FROM sonar.stock_watch_delivery WHERE chat_hash = $1 RETURNING watch_id
        )
        UPDATE sonar.stock_watchlist w SET digest_enabled = false, updated_at = now()
        FROM gone WHERE w.watch_id = gone.watch_id
        RETURNING w.watch_id`, [chatHash(command.chatId, config.key)]);
    if (rows.length) log(`watch-bot: /stop disconnected ${rows.length} watch(es)`);
    return BOT_REPLIES.stopped(rows.length);
}

// Telegram calls this for the dedicated watch bot only (see api/src/jobs/watch-bot-webhook.js).
// Authenticated by the secret_token registered with setWebhook; always 200 once authenticated, so
// Telegram does not retry an update we have deliberately ignored.
routes.post('/telegram/watch-bot', async (c) => {
    const config = requireConfigured();
    if (!safeEqual(c.req.header('X-Telegram-Bot-Api-Secret-Token'), config.webhookSecret)) {
        throw new ApiError(401, 'webhook_unauthorised', 'unknown webhook secret');
    }
    const bytes = Number(c.req.header('Content-Length'));
    if (Number.isFinite(bytes) && bytes > 65536) throw new ApiError(413, 'body_too_large', 'update exceeds 64 KiB');
    let update;
    try {
        update = await c.req.json();
    } catch {
        return c.json({ ok: true });
    }
    const command = parseBotCommand(update);
    let answer = null;
    if (command.kind === 'start') answer = await handleStart(config, command);
    else if (command.kind === 'stop') answer = await handleStop(config, command);
    else if (command.kind === 'invalid-token') answer = BOT_REPLIES.expired;
    else if (command.kind === 'not-private') answer = BOT_REPLIES.notPrivate;
    else if (command.kind === 'help') answer = BOT_REPLIES.help;
    if (answer) await reply(config, command.chatId, answer);
    return c.json({ ok: true });
});

export default routes;
