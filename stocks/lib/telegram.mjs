// One Telegram message, or a clearly-logged no-op. The workspace convention is that a scheduled
// job sends at most ONE failure alert per run; findings go to the separate activity bot. That repo's own
// sender is CommonJS with its own config and token, so a job in this repo posts directly with the
// credentials in ITS .env: TELEGRAM_ACTIVITY_* for findings, TELEGRAM_* for alerts — the same shape the
// other pipelines on this server use.
//
// Absent credentials are NOT an error and never fail a run: the summary is logged instead, saying
// so in as many words, because a watcher that dies for want of a chat id is worse than a silent one.

import { log, logWarn } from './io.mjs';

export function telegramConfigured(env = {}, alert = false) {
    const prefix = alert ? 'TELEGRAM_' : 'TELEGRAM_ACTIVITY_';
    return Boolean((env[`${prefix}BOT_TOKEN`] ?? process.env[`${prefix}BOT_TOKEN`])
        && (env[`${prefix}CHAT_ID`] ?? process.env[`${prefix}CHAT_ID`])
        && (alert || (env.TELEGRAM_ACTIVITY_THREAD_ID ?? process.env.TELEGRAM_ACTIVITY_THREAD_ID)));
}

/**
 * Post `text` as plain text (no parse_mode, so an underscore in a mint address cannot break the
 * message). Returns `{sent, reason}` and never throws: a failed send is reported, not fatal.
 */
export async function postTelegram(text, { env = {}, timeoutMs = 15000, alert = false } = {}) {
    const prefix = alert ? 'TELEGRAM_' : 'TELEGRAM_ACTIVITY_';
    const token = env[`${prefix}BOT_TOKEN`] ?? process.env[`${prefix}BOT_TOKEN`] ?? null;
    const chatId = env[`${prefix}CHAT_ID`] ?? process.env[`${prefix}CHAT_ID`] ?? null;
    const threadId = alert ? null : (env.TELEGRAM_ACTIVITY_THREAD_ID ?? process.env.TELEGRAM_ACTIVITY_THREAD_ID);
    if (!token || !chatId || (!alert && !threadId)) {
        log(`telegram: ${prefix} configuration is incomplete — the summary was not`
            + ' sent, it is logged below instead');
        for (const line of String(text).split('\n')) log(`telegram | ${line}`);
        return { sent: false, reason: 'no-credentials' };
    }
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true,
                ...(!alert ? { message_thread_id: Number(threadId) } : {}) }),
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

// Product news is a report; failures produce one separate compact alert on the monitoring bot.
export async function postRunNotifications(report, { env = {}, failures = [], label = 'RWA Sonar' } = {}) {
    const results = [];
    if (report) results.push(await postTelegram(report, { env }));
    if (failures.length) {
        const details = failures.slice(0, 3).map(f => typeof f === 'string' ? f : JSON.stringify(f)).join(' | ');
        results.push(await postTelegram(`${label}: ${failures.length} FAILURE(S): ${details}`.slice(0, 4000), { env, alert: true }));
    }
    return results;
}
