// Private watch delivery against the real sonar schema, in-process (app.request, no port) with a
// fake Telegram client, so no request ever reaches Telegram. Covers owner-versus-share-key
// authority, one-time and expiring binding tokens, the chat id never appearing in any response,
// enabling only after verification, /stop, and the digest store's per-day idempotence and
// exclusion of legacy rows. Skipped, loudly, without DATABASE_URL.
import { randomBytes } from 'node:crypto';

import app from '../src/app.js';
import { closePool, query } from '../src/db.js';
import { pgDigestStore } from '../src/jobs/send-watch-digests.js';
import { decryptChatId, setWatchBotClient } from '../src/lib/watch-delivery.js';
import { runDigests } from '../src/lib/watch-digest.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) console.log('[api] watch-delivery.integration.test.js SKIPPED: DATABASE_URL is not set.');

const CHAT_ID = 987650001;
const OTHER_CHAT = 987650002;
const SECRET = 'integration-webhook-secret-0123';
const KEY = randomBytes(32);
const ENV = {
    WATCH_BOT_TOKEN: '111:integration-watch-bot', WATCH_BOT_USERNAME: 'RwaSonarWatchTestBot',
    WATCH_BOT_WEBHOOK_SECRET: SECRET, WATCH_DELIVERY_KEY: KEY.toString('base64')
};
const bodies = [];
const replies = [];
let ipCounter = 0;

async function call(path, { method = 'GET', body, watchKey, headers = {} } = {}) {
    const all = { ...headers };
    if (body !== undefined) all['Content-Type'] = 'application/json';
    if (watchKey) all['X-Watch-Key'] = watchKey;
    all['X-Forwarded-For'] = `198.51.100.${(ipCounter += 1) % 250}`;
    const res = await app.request(path, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

function botUpdate(text, chatId = CHAT_ID, type = 'private', secret = SECRET) {
    return call('/api/telegram/watch-bot', {
        method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
        body: { update_id: Date.now(), message: { message_id: 1, chat: { id: chatId, type }, text } }
    });
}

async function createWatch() {
    const { rows } = await query('SELECT slug FROM sonar.stock_issuer ORDER BY slug LIMIT 1');
    const created = await call('/api/watchlists', {
        method: 'POST', body: { type: 'issuer', target: { issuerSlug: rows[0].slug }, title: 'Delivery integration watch' }
    });
    expect(created.status).toBe(201);
    return created.body;
}

describeDb('private Telegram delivery for saved watches', () => {
    const saved = {};
    const created = [];

    beforeAll(() => {
        for (const [key, value] of Object.entries(ENV)) {
            saved[key] = process.env[key];
            process.env[key] = value;
        }
        setWatchBotClient({ async sendMessage(chatId, text) { replies.push({ chatId, text }); return { ok: true, status: 200, reason: 'ok' }; } });
    });

    afterAll(async () => {
        for (const watch of created) await query('DELETE FROM sonar.stock_watchlist WHERE watch_id = $1', [watch.watchId]);
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        setWatchBotClient(null);
        // Whatever else a test asserted, no response body may ever have carried a chat id.
        for (const text of bodies) {
            expect(text).not.toContain(String(CHAT_ID));
            expect(text).not.toContain(String(OTHER_CHAT));
        }
        await closePool();
    });

    test('only the owner key binds, reads status, enables or unbinds; the share key cannot', async () => {
        const watch = await createWatch();
        created.push(watch);
        const base = `/api/watchlists/${watch.watchId}`;
        for (const [method, path, body] of [
            ['GET', '/delivery'], ['POST', '/delivery/telegram'], ['DELETE', '/delivery'],
            ['PUT', '/digest', { enabled: false }]
        ]) {
            const denied = await call(`${base}${path}`, { method, watchKey: watch.readKey, body });
            expect([method, path, denied.status]).toEqual([method, path, 404]);
        }
        const status = await call(`${base}/delivery`, { watchKey: watch.watchKey });
        expect(status.status).toBe(200);
        expect(status.headers.get('cache-control')).toBe('private, no-store');
        expect(status.body).toMatchObject({ available: true, bot: '@RwaSonarWatchTestBot', bound: false,
            pendingLinkExpiresAt: null, digest: { enabled: false } });
        const shared = await call(base, { watchKey: watch.readKey });
        expect(shared.headers.get('cache-control')).toBe('private, no-store');
    });

    test('the digest cannot be enabled before a private chat is verified', async () => {
        const watch = await createWatch();
        created.push(watch);
        const early = await call(`/api/watchlists/${watch.watchId}/digest`, {
            method: 'PUT', watchKey: watch.watchKey, body: { enabled: true, hour: 7 }
        });
        expect(early.status).toBe(409);
        expect(early.body.error.code).toBe('digest_delivery_unverified');
        const viaBody = await call(`/api/watchlists/${watch.watchId}`, {
            method: 'PUT', watchKey: watch.watchKey,
            body: { type: 'issuer', target: watch.target, digest: { enabled: true, hour: 7 } }
        });
        expect(viaBody.status).toBe(409);
    });

    test('a binding link verifies one private chat once; the chat id is stored only encrypted', async () => {
        const watch = await createWatch();
        created.push(watch);
        const base = `/api/watchlists/${watch.watchId}`;
        const link = await call(`${base}/delivery/telegram`, { method: 'POST', watchKey: watch.watchKey });
        expect(link.status).toBe(201);
        const token = link.body.url.match(/^https:\/\/t\.me\/RwaSonarWatchTestBot\?start=([A-Za-z0-9_-]{32})$/)[1];
        expect((await call(`${base}/delivery`, { watchKey: watch.watchKey })).body.pendingLinkExpiresAt).not.toBeNull();

        expect((await botUpdate(`/start ${token}`, CHAT_ID, 'group')).status).toBe(200);
        expect(replies.at(-1).text).toMatch(/private chat/);
        expect((await botUpdate(`/start ${token}`, CHAT_ID, 'private', 'wrong-secret-wrong-secret')).status).toBe(401);

        replies.length = 0;
        expect((await botUpdate(`/start ${token}`)).status).toBe(200);
        expect(replies).toEqual([{ chatId: String(CHAT_ID), text: expect.stringMatching(/^Connected\./) }]);
        const { rows } = await query('SELECT chat_enc, chat_hash FROM sonar.stock_watch_delivery WHERE watch_id = $1', [watch.watchId]);
        expect(rows[0].chat_enc).not.toContain(String(CHAT_ID));
        expect(rows[0].chat_hash).not.toContain(String(CHAT_ID));
        expect(decryptChatId(rows[0].chat_enc, KEY)).toBe(String(CHAT_ID));

        // Single use: the same chat is told it is already connected; another chat cannot reuse it.
        await botUpdate(`/start ${token}`);
        expect(replies.at(-1).text).toMatch(/already connected/);
        await botUpdate(`/start ${token}`, OTHER_CHAT);
        expect(replies.at(-1).text).toMatch(/expired or was already used/);
        const still = await query('SELECT chat_enc FROM sonar.stock_watch_delivery WHERE watch_id = $1', [watch.watchId]);
        expect(decryptChatId(still.rows[0].chat_enc, KEY)).toBe(String(CHAT_ID));

        const status = await call(`${base}/delivery`, { watchKey: watch.watchKey });
        expect(status.body).toMatchObject({ bound: true, pendingLinkExpiresAt: null });
        const enabled = await call(`${base}/digest`, { method: 'PUT', watchKey: watch.watchKey, body: { enabled: true, hour: 7 } });
        expect(enabled.status).toBe(200);
        expect(enabled.body.digest).toEqual({ enabled: true, hour: 7, timezone: 'UTC' });
        // Editing the watch itself keeps the owner's delivery choice.
        const edited = await call(base, { method: 'PUT', watchKey: watch.watchKey, body: { type: 'issuer', target: watch.target, title: 'Renamed' } });
        expect(edited.body.digest.enabled).toBe(true);
    });

    test('an expired link binds nothing', async () => {
        const watch = await createWatch();
        created.push(watch);
        const link = await call(`/api/watchlists/${watch.watchId}/delivery/telegram`, { method: 'POST', watchKey: watch.watchKey });
        const token = new URL(link.body.url).searchParams.get('start');
        await query(`UPDATE sonar.stock_watch_binding SET expires_at = now() - interval '1 second' WHERE watch_id = $1`, [watch.watchId]);
        await botUpdate(`/start ${token}`);
        expect(replies.at(-1).text).toMatch(/expired/);
        const { rows } = await query('SELECT 1 FROM sonar.stock_watch_delivery WHERE watch_id = $1', [watch.watchId]);
        expect(rows).toHaveLength(0);
    });

    test('a new link replaces an unused one, and the owner can unbind', async () => {
        const watch = await createWatch();
        created.push(watch);
        const base = `/api/watchlists/${watch.watchId}`;
        const first = new URL((await call(`${base}/delivery/telegram`, { method: 'POST', watchKey: watch.watchKey })).body.url).searchParams.get('start');
        const second = new URL((await call(`${base}/delivery/telegram`, { method: 'POST', watchKey: watch.watchKey })).body.url).searchParams.get('start');
        await botUpdate(`/start ${first}`, OTHER_CHAT);
        expect(replies.at(-1).text).toMatch(/expired/);
        await botUpdate(`/start ${second}`, OTHER_CHAT);
        expect(replies.at(-1).text).toMatch(/^Connected\./);
        await call(`${base}/digest`, { method: 'PUT', watchKey: watch.watchKey, body: { enabled: true } });
        expect((await call(`${base}/delivery`, { method: 'DELETE', watchKey: watch.watchKey })).status).toBe(204);
        const status = await call(`${base}/delivery`, { watchKey: watch.watchKey });
        expect(status.body).toMatchObject({ bound: false, digest: { enabled: false } });
    });

    test('/stop from the chat disconnects every watch bound to it', async () => {
        const watch = await createWatch();
        created.push(watch);
        const base = `/api/watchlists/${watch.watchId}`;
        const token = new URL((await call(`${base}/delivery/telegram`, { method: 'POST', watchKey: watch.watchKey })).body.url).searchParams.get('start');
        await botUpdate(`/start ${token}`, OTHER_CHAT);
        await call(`${base}/digest`, { method: 'PUT', watchKey: watch.watchKey, body: { enabled: true } });
        await botUpdate('/stop', OTHER_CHAT);
        expect(replies.at(-1).text).toMatch(/^Stopped\./);
        const status = await call(`${base}/delivery`, { watchKey: watch.watchKey });
        expect(status.body).toMatchObject({ bound: false, digest: { enabled: false } });
    });

    test('the digest store sends once per day, never to legacy unbound rows, and only for material changes', async () => {
        const bound = await createWatch();
        const legacy = await createWatch();
        created.push(bound, legacy);
        const token = new URL((await call(`/api/watchlists/${bound.watchId}/delivery/telegram`, { method: 'POST', watchKey: bound.watchKey })).body.url).searchParams.get('start');
        await botUpdate(`/start ${token}`);
        const hour = new Date().getUTCHours();
        await call(`/api/watchlists/${bound.watchId}/digest`, { method: 'PUT', watchKey: bound.watchKey, body: { enabled: true, hour } });
        // A legacy row carrying the reserved flag without any verified chat.
        await query('UPDATE sonar.stock_watchlist SET digest_enabled = true, digest_hour = $2 WHERE watch_id = $1', [legacy.watchId, hour]);
        for (const id of [bound.watchId, legacy.watchId]) {
            await query('INSERT INTO sonar.stock_watch_event (watch_id, summary, detected_at) VALUES ($1, $2, clock_timestamp())',
                [id, `Issuer X: programme status changed from active to paused (${id})`]);
        }
        const sent = [];
        const telegram = { async sendMessage(chatId, text) { sent.push({ chatId, text }); return { ok: true, status: 200, reason: 'ok' }; } };
        const store = pgDigestStore();
        const watches = await store.enabledBoundWatches();
        expect(watches.map((row) => row.watch_id)).toContain(bound.watchId);
        expect(watches.map((row) => row.watch_id)).not.toContain(legacy.watchId);
        const at = Date.now() + 1000;
        // Other developers' local watches must not be messaged by this test.
        const only = { ...store, enabledBoundWatches: async () => (await store.enabledBoundWatches()).filter((row) => row.watch_id === bound.watchId) };
        const first = await runDigests({ store: only, telegram, decrypt: (v) => decryptChatId(v, KEY), nowMs: at, baseUrl: 'https://rwasonar.com' });
        const second = await runDigests({ store: only, telegram, decrypt: (v) => decryptChatId(v, KEY), nowMs: at, baseUrl: 'https://rwasonar.com' });
        expect(first).toMatchObject({ due: 1, sent: 1 });
        expect(second).toMatchObject({ due: 1, sent: 0, alreadyHandled: 1 });
        expect(sent).toHaveLength(1);
        expect(sent[0].chatId).toBe(String(CHAT_ID));
        expect(sent[0].text).toContain(`programme status changed from active to paused (${bound.watchId})`);
        expect(sent[0].text).not.toContain(legacy.watchId);
        const { rows } = await query('SELECT status, change_count, attempts FROM sonar.stock_watch_digest_log WHERE watch_id = $1', [bound.watchId]);
        expect(rows).toEqual([{ status: 'sent', change_count: 1, attempts: 1 }]);
    });
});
