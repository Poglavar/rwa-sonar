// Exercise watch notification delivery with separate tokens, including mixed and failure-only runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { postTelegram, postRunNotifications } from './lib/telegram.mjs';
const env = { TELEGRAM_BOT_TOKEN: 'alert-token', TELEGRAM_CHAT_ID: 'alert-chat',
  TELEGRAM_ACTIVITY_BOT_TOKEN: 'activity-token', TELEGRAM_ACTIVITY_CHAT_ID: 'activity-chat', TELEGRAM_ACTIVITY_THREAD_ID: '42' };

test('mixed runs separate findings from failures and failure-only runs stay out of activity', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true }) }; };
  try {
    await postRunNotifications('new findings', { env, failures: ['one source failed', 'another source failed'], label: 'watch' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://api.telegram.org/botactivity-token/sendMessage');
    assert.equal(calls[0].body.message_thread_id, 42);
    assert.equal(calls[1].url, 'https://api.telegram.org/botalert-token/sendMessage');
    assert.equal(calls[1].body.chat_id, 'alert-chat');
    assert.equal('message_thread_id' in calls[1].body, false);
    assert.match(calls[1].body.text, /2 FAILURE/);
    calls.length = 0;
    await postRunNotifications(null, { env, failures: ['failed'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.telegram.org/botalert-token/sendMessage');
    calls.length = 0;
    await postRunNotifications(null, { env });
    assert.equal(calls.length, 0);
    assert.equal((await postTelegram('activity', { env: { ...env, TELEGRAM_ACTIVITY_THREAD_ID: '' } })).sent, false);
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = original; }
});
