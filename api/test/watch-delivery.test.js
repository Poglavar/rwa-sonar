// Pure tests for private watch delivery: configuration guards (never the operator bot), chat-id
// encryption, one-time binding tokens and the parsing of the watch bot's webhook updates.
import { randomBytes } from 'node:crypto';

import {
    bindingUrl, chatHash, createBindingToken, createTelegramClient, decryptChatId, deliveryConfig,
    encryptChatId, hashBindingToken, parseBotCommand, safeEqual
} from '../src/lib/watch-delivery.js';

const KEY = randomBytes(32);
const ENV = {
    WATCH_BOT_TOKEN: '111:watch-bot-token', WATCH_BOT_USERNAME: 'RwaSonarWatchBot',
    WATCH_BOT_WEBHOOK_SECRET: 'a-long-webhook-secret-value', WATCH_DELIVERY_KEY: KEY.toString('base64'),
    TELEGRAM_BOT_TOKEN: '222:operator-token'
};

describe('watch delivery configuration', () => {
    test('is configured only with a dedicated bot, a secret and a 32-byte key', () => {
        expect(deliveryConfig(ENV)).toMatchObject({ configured: true, problem: null, botUsername: 'RwaSonarWatchBot' });
        expect(deliveryConfig({ ...ENV, WATCH_BOT_USERNAME: '@RwaSonarWatchBot' }).botUsername).toBe('RwaSonarWatchBot');
        expect(deliveryConfig({ ...ENV, WATCH_BOT_TOKEN: '' }).configured).toBe(false);
        expect(deliveryConfig({ ...ENV, WATCH_DELIVERY_KEY: randomBytes(16).toString('base64') }).problem).toMatch(/32 random bytes/);
        expect(deliveryConfig({ ...ENV, WATCH_BOT_WEBHOOK_SECRET: 'short' }).configured).toBe(false);
    });

    test('refuses the operator alerts bot, whose update stream a webhook would take over', () => {
        const shared = deliveryConfig({ ...ENV, WATCH_BOT_TOKEN: ENV.TELEGRAM_BOT_TOKEN });
        expect(shared.configured).toBe(false);
        expect(shared.problem).toMatch(/operator alerts bot/);
    });
});

describe('chat ids at rest', () => {
    test('are AES-GCM ciphertext that never contains the id and decrypts only with the key', () => {
        const stored = encryptChatId('987654321', KEY);
        expect(stored).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        expect(stored).not.toContain('987654321');
        expect(encryptChatId('987654321', KEY)).not.toBe(stored);
        expect(decryptChatId(stored, KEY)).toBe('987654321');
        expect(() => decryptChatId(stored, randomBytes(32))).toThrow();
        const [v, iv, tag, body] = stored.split('.');
        expect(() => decryptChatId([v, iv, tag, `${body.slice(0, -2)}AA`].join('.'), KEY)).toThrow();
    });

    test('the lookup hash is keyed and stable', () => {
        expect(chatHash('987654321', KEY)).toMatch(/^[0-9a-f]{64}$/);
        expect(chatHash('987654321', KEY)).toBe(chatHash('987654321', KEY));
        expect(chatHash('987654321', randomBytes(32))).not.toBe(chatHash('987654321', KEY));
    });
});

describe('binding tokens and bot commands', () => {
    test('tokens are unguessable Telegram start parameters stored only as a hash', () => {
        const first = createBindingToken();
        expect(first.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(first.tokenHash).toBe(hashBindingToken(first.token));
        expect(first.tokenHash).not.toContain(first.token);
        expect(createBindingToken().token).not.toBe(first.token);
        expect(bindingUrl('RwaSonarWatchBot', first.token)).toBe(`https://t.me/RwaSonarWatchBot?start=${first.token}`);
    });

    test('only a private chat can bind; /stop and help are recognised; anything else is ignored', () => {
        const token = createBindingToken().token;
        const msg = (text, type = 'private') => ({ update_id: 1, message: { chat: { id: 42, type }, text } });
        expect(parseBotCommand(msg(`/start ${token}`))).toEqual({ kind: 'start', chatId: '42', token });
        expect(parseBotCommand(msg(`/start@RwaSonarWatchBot ${token}`)).kind).toBe('start');
        expect(parseBotCommand(msg(`/start ${token}`, 'group')).kind).toBe('not-private');
        expect(parseBotCommand(msg('/start short')).kind).toBe('invalid-token');
        expect(parseBotCommand(msg('/start')).kind).toBe('help');
        expect(parseBotCommand(msg('/stop'))).toEqual({ kind: 'stop', chatId: '42' });
        expect(parseBotCommand(msg('hello')).kind).toBe('ignore');
        expect(parseBotCommand({ update_id: 2, edited_message: {} }).kind).toBe('ignore');
    });

    test('secret comparison is exact', () => {
        expect(safeEqual('abc', 'abc')).toBe(true);
        expect(safeEqual('abc', 'abd')).toBe(false);
        expect(safeEqual(undefined, 'abc')).toBe(false);
    });

    test('the Telegram client posts plain text and reports failures without throwing', async () => {
        const calls = [];
        const ok = createTelegramClient('T', { fetchImpl: async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        } });
        expect(await ok.sendMessage('42', 'hi')).toEqual({ ok: true, status: 200, reason: 'ok' });
        expect(calls[0]).toEqual({ url: 'https://api.telegram.org/botT/sendMessage',
            body: { chat_id: '42', text: 'hi', disable_web_page_preview: true } });
        const blocked = createTelegramClient('T', { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false }) }) });
        expect(await blocked.sendMessage('42', 'hi')).toEqual({ ok: false, status: 403, reason: 'http-403' });
        const down = createTelegramClient('T', { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
        expect((await down.sendMessage('42', 'hi')).reason).toBe('network');
    });
});
