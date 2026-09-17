// One Telegram message, or a clearly-logged no-op. The workspace convention is that a scheduled
// job sends at most ONE summary per run through alerts-server-telegram's chat; that repo's own
// sender is CommonJS with its own config and token, so a job in this repo posts directly with the
// credentials in ITS .env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) — the same shape the
// zagreb-veleprojekti pipeline uses.
//
// Absent credentials are NOT an error and never fail a run: the summary is logged instead, saying
// so in as many words, because a watcher that dies for want of a chat id is worse than a silent one.

import { log, logWarn } from './io.mjs';

export function telegramConfigured(env = {}) {
    return Boolean((env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN)
        && (env.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID));
}

/**
 * Post `text` as plain text (no parse_mode, so an underscore in a mint address cannot break the
 * message). Returns `{sent, reason}` and never throws: a failed send is reported, not fatal.
 */
export async function postTelegram(text, { env = {}, timeoutMs = 15000 } = {}) {
    const token = env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? null;
    const chatId = env.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID ?? null;
    if (!token || !chatId) {
        log('telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set — the summary was not'
            + ' sent, it is logged below instead');
        for (const line of String(text).split('\n')) log(`telegram | ${line}`);
        return { sent: false, reason: 'no-credentials' };
    }
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(timeoutMs)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.ok !== true) {
            logWarn(`telegram: sendMessage failed with HTTP ${res.status} — ${JSON.stringify(body).slice(0, 200)}`);
            return { sent: false, reason: `http-${res.status}` };
        }
        log('telegram: summary sent');
        return { sent: true, reason: 'ok' };
    } catch (err) {
        logWarn(`telegram: sendMessage threw — ${err.message}`);
        return { sent: false, reason: `exception: ${err.message}` };
    }
}
