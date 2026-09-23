// Private Telegram delivery for saved watches: configuration, chat-id encryption, one-time binding
// tokens, parsing of the watch bot's webhook updates and a minimal Telegram client. Pure apart from
// the client's fetch, which tests replace with a fake through setWatchBotClient().
//
// The watch bot is deliberately NOT the operator alerts bot. Verifying `/start <token>` means
// receiving updates, and a bot has one update stream: registering a webhook on the shared bot, or
// polling getUpdates on it, would take that stream away from whatever else reads it. So the watch
// bot has its own token, and this module refuses to run when that token equals the operator one.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const BINDING_TTL_MS = 15 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * The watch bot's configuration from the environment, read at call time. `configured` is false
 * — with the reason in `problem` — unless every piece is present, the key is exactly 32 bytes and
 * the bot is not the operator alerts bot.
 */
export function deliveryConfig(env = process.env) {
    const botToken = text(env.WATCH_BOT_TOKEN);
    const botUsername = text(env.WATCH_BOT_USERNAME).replace(/^@/, '');
    const webhookSecret = text(env.WATCH_BOT_WEBHOOK_SECRET);
    const rawKey = text(env.WATCH_DELIVERY_KEY);
    let key = null;
    try {
        const decoded = Buffer.from(rawKey, 'base64');
        if (decoded.length === 32) key = decoded;
    } catch {
        key = null;
    }
    let problem = null;
    if (!botToken || !botUsername || !webhookSecret || !rawKey) {
        problem = 'WATCH_BOT_TOKEN, WATCH_BOT_USERNAME, WATCH_BOT_WEBHOOK_SECRET and WATCH_DELIVERY_KEY must all be set';
    } else if (!key) {
        problem = 'WATCH_DELIVERY_KEY must be 32 random bytes, base64-encoded';
    } else if (!/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) {
        problem = 'WATCH_BOT_USERNAME is not a Telegram bot username';
    } else if (!/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
        problem = 'WATCH_BOT_WEBHOOK_SECRET must be 16–256 characters of A–Z, a–z, 0–9, _ or -';
    } else if (text(env.TELEGRAM_BOT_TOKEN) && botToken === text(env.TELEGRAM_BOT_TOKEN)) {
        problem = 'WATCH_BOT_TOKEN is the operator alerts bot; use a dedicated bot so its updates are not taken over';
    }
    return { configured: problem === null, problem, botToken, botUsername, webhookSecret, key };
}

const b64 = (buffer) => buffer.toString('base64url');

/** AES-256-GCM ciphertext of a chat id as `v1.<iv>.<tag>.<ciphertext>`. */
export function encryptChatId(chatId, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(String(chatId), 'utf8'), cipher.final()]);
    return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(body)}`;
}

export function decryptChatId(value, key) {
    const [version, iv, tag, body] = String(value).split('.');
    if (version !== 'v1' || !iv || !tag || !body) throw new Error('unrecognised chat ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

/** Keyed, deterministic hash of a chat id, so `/stop` can find its watches without decrypting all. */
export function chatHash(chatId, key) {
    return createHmac('sha256', key).update(`telegram-chat:${chatId}`).digest('hex');
}

export function hashBindingToken(token) {
    return createHash('sha256').update(String(token)).digest('hex');
}

/** A one-time token usable as a Telegram `start` parameter (A–Z, a–z, 0–9, _ and -, ≤ 64). */
export function createBindingToken() {
    const token = randomBytes(24).toString('base64url');
    return { token, tokenHash: hashBindingToken(token) };
}

export function bindingUrl(botUsername, token) {
    return `https://t.me/${botUsername}?start=${token}`;
}

export function safeEqual(a, b) {
    const left = Buffer.from(String(a ?? ''));
    const right = Buffer.from(String(b ?? ''));
    return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * What a webhook update asks for. Only text messages in a private chat count: a group can never
 * become a "private delivery channel", and every other update type is ignored.
 */
export function parseBotCommand(update) {
    const message = update?.message;
    const chatId = message?.chat?.id;
    const body = text(message?.text);
    if (!message || (typeof chatId !== 'number' && typeof chatId !== 'string') || !body.startsWith('/')) {
        return { kind: 'ignore' };
    }
    const [rawCommand, argument = ''] = body.split(/\s+/, 2);
    const command = rawCommand.split('@')[0].toLowerCase();
    const isPrivate = message.chat.type === 'private';
    if (command === '/start') {
        if (!isPrivate) return { kind: 'not-private', chatId: String(chatId) };
        if (!argument) return { kind: 'help', chatId: String(chatId) };
        if (!TOKEN_PATTERN.test(argument)) return { kind: 'invalid-token', chatId: String(chatId) };
        return { kind: 'start', chatId: String(chatId), token: argument };
    }
    if (command === '/stop') return { kind: 'stop', chatId: String(chatId) };
    if (command === '/help') return { kind: 'help', chatId: String(chatId) };
    return { kind: 'ignore' };
}

/**
 * The smallest Telegram client this feature needs. Plain text (no parse_mode), no previews.
 * Returns `{ ok, status, reason }` and never throws, so one failed chat cannot stop a run.
 */
export function createTelegramClient(botToken, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    return {
        async sendMessage(chatId, message) {
            try {
                const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
                    signal: AbortSignal.timeout(timeoutMs)
                });
                const body = await res.json().catch(() => ({}));
                if (!res.ok || body.ok !== true) {
                    return { ok: false, status: res.status, reason: `http-${res.status}` };
                }
                return { ok: true, status: res.status, reason: 'ok' };
            } catch (err) {
                return { ok: false, status: null, reason: err.name === 'TimeoutError' ? 'timeout' : 'network' };
            }
        }
    };
}

let clientOverride = null;

/** Tests install a fake here; production builds a real client from the configuration. */
export function setWatchBotClient(client) {
    clientOverride = client;
}

export function watchBotClient(config) {
    return clientOverride ?? createTelegramClient(config.botToken);
}

export const BOT_REPLIES = {
    bound: 'Connected. This private chat can now receive the RWA Sonar morning digest for your saved watch. '
        + 'Turn the digest on, and choose its hour, on the watch page. Send /stop at any time to disconnect.',
    alreadyBound: 'This chat is already connected to that watch.',
    expired: 'That link has expired or was already used. Create a new one from the watch page.',
    notPrivate: 'Watch digests can only be delivered to a private chat with this bot.',
    help: 'This bot delivers RWA Sonar saved-watch digests. Connect a watch from its page on rwasonar.com; '
        + 'send /stop to disconnect every watch from this chat.',
    stopped: (count) => count > 0
        ? `Stopped. ${count} watch${count === 1 ? ' is' : 'es are'} disconnected from this chat and no further digests will be sent here.`
        : 'No watch is connected to this chat.'
};
