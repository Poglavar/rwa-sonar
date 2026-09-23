// The personal morning digest: when a bound watch is due, which stored changes it covers, the
// message text, and one run over every enabled watch. Pure apart from the injected store, Telegram
// client and operator notifier, so tests drive it with fakes and a real database alike.

const MAX_BULLETS = 20;
const MAX_CHARS = 3800; // Telegram's limit is 4096; leave room for the footer.
// A digest that is hours late is no longer a morning digest; the next day's covers the gap.
const CATCH_UP_HOURS = 3;

// Changes that describe our own review workflow rather than the world. The comparison differ in
// stocks/lib/saved-items.js reports a flip of the legal-evidence review flag; that is an internal
// research state, not a change by an issuer, venue or protocol, so it never reaches a digest.
const INTERNAL = [/: legal-evidence review status changed$/];

export function isDigestMaterial(summary) {
    return typeof summary === 'string' && summary.trim() !== '' && !INTERNAL.some((re) => re.test(summary));
}

/** The calendar date and hour at `nowMs` in `timezone`. */
export function localDay(nowMs, timezone = 'UTC') {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function isDue(watch, nowMs) {
    const { hour } = localDay(nowMs, watch.digest_timezone || 'UTC');
    const target = Number(watch.digest_hour ?? 6);
    return hour >= target && hour < target + CATCH_UP_HOURS;
}

function targetOf(watch) {
    return watch.target && typeof watch.target === 'object' ? watch.target : {};
}

/** The exact thing a watch follows, in words. */
export function targetLabel(watch) {
    const target = targetOf(watch);
    const type = watch.watch_type ?? 'comparison';
    if (type === 'token') return `token ${target.mint}`;
    if (type === 'issuer') return `issuer ${target.issuerSlug}`;
    if (type === 'protocol-market') return `${target.integrationId} market ${target.marketKey} for token ${target.mint}`;
    return `${watch.underlying_ticker ?? target.ticker} comparison of ${(watch.issuer_slugs ?? target.issuers ?? []).join(', ')}`;
}

export function reportUrl(watch, baseUrl) {
    const target = targetOf(watch);
    const type = watch.watch_type ?? 'comparison';
    if ((type === 'token' || type === 'protocol-market') && target.mint) {
        return `${baseUrl}/card.html?mint=${encodeURIComponent(target.mint)}`;
    }
    if (type === 'issuer' && /^[a-z0-9-]+$/.test(target.issuerSlug ?? '')) return `${baseUrl}/issuers/${target.issuerSlug}.html`;
    const ticker = watch.underlying_ticker ?? target.ticker;
    return `${baseUrl}/stocks.html?view=compare&compare=${encodeURIComponent(ticker ?? '')}`;
}

/**
 * The digest text: the exact target, every material change as found (each already names its
 * token, market or issuer and the before/after where one was measured), and the report link.
 */
export function formatDigest(watch, events, { baseUrl, date }) {
    const label = targetLabel(watch);
    const prefix = (watch.watch_type ?? 'comparison') === 'comparison' ? `${watch.underlying_ticker ?? targetOf(watch).ticker} · ` : '';
    const header = [
        `RWA Sonar morning digest · ${date}`,
        watch.title ? `${watch.title} (${label})` : `Watch: ${label}`,
        '',
        `${events.length} material change${events.length === 1 ? '' : 's'} since your last digest:`
    ];
    const footer = [
        '',
        `Report: ${reportUrl(watch, baseUrl)}`,
        `Manage this watch: ${baseUrl}/watch.html · send /stop here to disconnect.`
    ];
    const bullets = [];
    let length = [...header, ...footer].join('\n').length;
    for (const event of events.slice(0, MAX_BULLETS)) {
        const line = `• ${prefix}${event.summary}`;
        if (length + line.length + 60 > MAX_CHARS) break;
        bullets.push(line);
        length += line.length + 1;
    }
    if (bullets.length < events.length) bullets.push(`…and ${events.length - bullets.length} more on the report page.`);
    return [...header, ...bullets, ...footer].join('\n');
}

function ms(value) {
    if (value === null || value === undefined) return null;
    const time = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(time) ? time : null;
}

/**
 * Send every due digest once. `store` owns persistence (see pgDigestStore in the job), `telegram`
 * has sendMessage(chatId, text), `decrypt` turns the stored ciphertext into a chat id, and
 * `notifyOperator` receives at most one line-free-of-contents summary when something failed.
 */
export async function runDigests({ store, telegram, decrypt, notifyOperator, nowMs = Date.now(), baseUrl, log = () => {} }) {
    const runIso = new Date(nowMs).toISOString();
    const stats = {
        startedAt: runIso, eligible: 0, due: 0, alreadyHandled: 0, sent: 0, noChange: 0,
        failed: 0, disconnected: 0, failureReasons: {}
    };
    const watches = await store.enabledBoundWatches();
    stats.eligible = watches.length;
    for (const watch of watches) {
        if (!isDue(watch, nowMs)) continue;
        stats.due += 1;
        const { date } = localDay(nowMs, watch.digest_timezone || 'UTC');
        if (!(await store.claim(watch.watch_id, date))) {
            stats.alreadyHandled += 1;
            continue;
        }
        const since = Math.max(...[watch.verified_at, watch.digest_since, watch.last_covered].map(ms).filter((v) => v !== null));
        const events = (await store.eventsBetween(watch.watch_id, new Date(since).toISOString(), runIso))
            .filter((event) => isDigestMaterial(event.summary));
        if (events.length === 0) {
            await store.finish(watch.watch_id, date, { status: 'no-change', changeCount: 0, coveredUntil: runIso });
            stats.noChange += 1;
            continue;
        }
        let chatId;
        try {
            chatId = decrypt(watch.chat_enc);
        } catch {
            chatId = null;
        }
        const result = chatId === null
            ? { ok: false, status: null, reason: 'undecryptable-chat' }
            : await telegram.sendMessage(chatId, formatDigest(watch, events, { baseUrl, date }));
        if (result.ok) {
            await store.finish(watch.watch_id, date, { status: 'sent', changeCount: events.length, coveredUntil: runIso });
            stats.sent += 1;
            log(`watch ${watch.watch_id}: digest sent (${events.length} change(s))`);
            continue;
        }
        await store.finish(watch.watch_id, date, { status: 'failed', changeCount: events.length, coveredUntil: null, error: result.reason });
        if (result.status === 403) {
            // The person blocked the bot or deleted the chat: that is their /stop, not our failure.
            await store.disconnect(watch.watch_id);
            stats.disconnected += 1;
            log(`watch ${watch.watch_id}: chat refused delivery (403), disconnected`);
            continue;
        }
        stats.failed += 1;
        stats.failureReasons[result.reason] = (stats.failureReasons[result.reason] ?? 0) + 1;
        log(`watch ${watch.watch_id}: digest failed (${result.reason})`);
    }
    stats.finishedAt = new Date().toISOString();
    stats.ok = stats.failed === 0;
    if (!stats.ok && notifyOperator) {
        const reasons = Object.entries(stats.failureReasons).map(([reason, count]) => `${reason} ×${count}`).join(', ');
        await notifyOperator(`RWA Sonar watch digests: ${stats.failed} of ${stats.sent + stats.failed} due digest(s) `
            + `failed (${reasons}). Watch contents and chats are deliberately not included; see logs/rwa-watch-digest-out.log. `
            + 'Failed digests retry on the next hourly run, at most three attempts a day.');
    }
    return stats;
}
