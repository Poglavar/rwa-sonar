// Unit tests for the pure half of watch-delivery.js — the "Get this on Telegram" control on owned
// saved-watch cards (watch.html) and owned saved comparisons (stocks.html): the deep link it will
// render, the binding-flow state machine, the bounded poll plan, the digest settings it sends, the
// owner-key lookup on each page, and the owner/read-only split.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const D = require('./watch-delivery.js');

const HTML = readFileSync(join(__dirname, 'watch.html'), 'utf8');
const STOCKS_HTML = readFileSync(join(__dirname, 'stocks.html'), 'utf8');
const STOCKS_JS = readFileSync(join(__dirname, 'stocks.js'), 'utf8');
const JS = readFileSync(join(__dirname, 'watch-delivery.js'), 'utf8');
const TOKEN = 'abcDEF0123456789_-abcDEF0123456789';
const URL_OK = `https://t.me/rwa_sonar_bot?start=${TOKEN}`;
const NOW = Date.parse('2026-09-24T08:00:00Z');

const status = (overrides = {}) => ({
    watchId: 'w1', channel: 'telegram', available: true, bot: '@rwa_sonar_bot', bound: false,
    verifiedAt: null, pendingLinkExpiresAt: null, digest: { enabled: false, hour: 6, timezone: 'UTC' }, ...overrides
});

describe('deep link', () => {
    test('builds the t.me start link, with or without the @', () => {
        expect(D.telegramDeepLink('rwa_sonar_bot', TOKEN)).toBe(URL_OK);
        expect(D.telegramDeepLink('@rwa_sonar_bot', TOKEN)).toBe(URL_OK);
    });

    test('refuses a token or bot Telegram would not accept', () => {
        expect(D.telegramDeepLink('rwa_sonar_bot', 'short')).toBeNull();
        expect(D.telegramDeepLink('rwa_sonar_bot', `${TOKEN}&x=1`)).toBeNull();
        expect(D.telegramDeepLink('bad bot', TOKEN)).toBeNull();
        expect(D.telegramDeepLink(null, TOKEN)).toBeNull();
    });

    test('only an exact https t.me link from the API becomes a link on the page', () => {
        expect(D.parseBindingUrl(URL_OK)).toEqual({ bot: 'rwa_sonar_bot', token: TOKEN, url: URL_OK });
        for (const bad of [`http://t.me/rwa_sonar_bot?start=${TOKEN}`, `https://evil.example/rwa_sonar_bot?start=${TOKEN}`,
            `javascript:alert(1)//https://t.me/rwa_sonar_bot?start=${TOKEN}`, `${URL_OK}#x`, `https://t.me.evil.io/rwa_sonar_bot?start=${TOKEN}`, undefined]) {
            expect(D.parseBindingUrl(bad)).toBeNull();
        }
    });
});

describe('digest settings', () => {
    test('accepts an IANA zone and an hour 0–23 (a <select> value string included)', () => {
        expect(D.validateDigestSettings({ enabled: true, hour: '7', timezone: 'Europe/Zagreb' }))
            .toEqual({ ok: true, value: { enabled: true, hour: 7, timezone: 'Europe/Zagreb' } });
        expect(D.validateDigestSettings({ enabled: false, hour: 0, timezone: 'UTC' }).ok).toBe(true);
        expect(D.validateDigestSettings({ enabled: true, hour: 23, timezone: ' America/New_York ' }).value.timezone).toBe('America/New_York');
    });

    test('rejects what the API would reject', () => {
        expect(D.validateDigestSettings({ enabled: 'yes', hour: 6, timezone: 'UTC' }).ok).toBe(false);
        expect(D.validateDigestSettings({ enabled: true, hour: 24, timezone: 'UTC' }).ok).toBe(false);
        expect(D.validateDigestSettings({ enabled: true, hour: -1, timezone: 'UTC' }).ok).toBe(false);
        expect(D.validateDigestSettings({ enabled: true, hour: 6.5, timezone: 'UTC' }).ok).toBe(false);
        expect(D.validateDigestSettings({ enabled: true, hour: 6, timezone: 'Mars/Olympus' }).ok).toBe(false);
        expect(D.validateDigestSettings({ enabled: true, hour: 6, timezone: '' }).ok).toBe(false);
    });

    test('browser timezone comes from Intl and falls back to UTC', () => {
        const fake = (zone) => ({ DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: zone }) }) });
        expect(D.browserTimezone(fake('Asia/Tokyo'))).toBe('Asia/Tokyo');
        expect(D.browserTimezone(fake(undefined))).toBe('UTC');
        expect(D.browserTimezone(fake('Not/AZone'))).toBe('UTC');
    });

    test('connected label names the hour and zone, or says the digest is off', () => {
        expect(D.connectedLabel({ enabled: true, hour: 7, timezone: 'Europe/Zagreb' })).toBe('Connected. Daily digest at 07:00 Europe/Zagreb.');
        expect(D.connectedLabel({ enabled: false, hour: 7, timezone: 'UTC' })).toBe('Connected. Daily digest is off.');
    });
});

describe('binding flow', () => {
    const run = (events) => events.reduce((state, event) => D.reduce(state, event), D.initialState());

    test('status decides the first phase', () => {
        expect(run([{ type: 'status', status: status(), nowMs: NOW }]).phase).toBe('idle');
        expect(run([{ type: 'status', status: status({ bound: true }), nowMs: NOW }]).phase).toBe('connected');
        expect(run([{ type: 'status', status: status({ available: false, bot: null }), nowMs: NOW }]).phase).toBe('unavailable');
        expect(run([{ type: 'fail', message: 'HTTP 500' }])).toMatchObject({ phase: 'unavailable', error: 'HTTP 500' });
    });

    test('request → link → pending polls → connected, exactly once', () => {
        const created = { url: URL_OK, expiresAt: new Date(NOW + 15 * 60 * 1000).toISOString() };
        const pending = run([{ type: 'status', status: status(), nowMs: NOW }, { type: 'request' }, { type: 'link', created, nowMs: NOW }]);
        expect(pending.phase).toBe('pending');
        expect(pending.link).toMatchObject({ url: URL_OK, bot: 'rwa_sonar_bot', deadlineMs: NOW + 15 * 60 * 1000 });

        const stillPending = D.reduce(pending, { type: 'status', status: status(), nowMs: NOW + 3000 });
        expect(stillPending.phase).toBe('pending');
        expect(D.justConnected(pending, stillPending)).toBe(false);
        expect(D.sameView(pending, stillPending)).toBe(true); // an unchanged poll does not re-render

        const bound = D.reduce(stillPending, { type: 'status', status: status({ bound: true }), nowMs: NOW + 6000 });
        expect(bound.phase).toBe('connected');
        expect(bound.link).toBeNull();
        expect(D.justConnected(stillPending, bound)).toBe(true);
        expect(D.justConnected(bound, D.reduce(bound, { type: 'status', status: status({ bound: true }), nowMs: NOW + 9000 }))).toBe(false);
    });

    test('an unusable link from the server never reaches pending', () => {
        const state = run([{ type: 'status', status: status(), nowMs: NOW }, { type: 'request' },
            { type: 'link', created: { url: 'https://evil.example/x', expiresAt: null }, nowMs: NOW }]);
        expect(state.phase).toBe('idle');
        expect(state.link).toBeNull();
        expect(state.error).toMatch(/unusable/);
    });

    test('a failed link request returns to idle with the error', () => {
        const state = run([{ type: 'status', status: status(), nowMs: NOW }, { type: 'request' }, { type: 'fail', message: 'no such watchlist or owner key' }]);
        expect(state).toMatchObject({ phase: 'idle', error: 'no such watchlist or owner key' });
    });

    test('the link expires: polling stops at the deadline and the state says so', () => {
        const created = { url: URL_OK, expiresAt: new Date(NOW + 60 * 1000).toISOString() };
        const pending = run([{ type: 'link', created, nowMs: NOW }]);
        expect(D.nextPoll(pending, NOW)).toBe(NOW + 3000);
        expect(D.nextPoll(pending, NOW + 58 * 1000)).toBeNull();
        expect(D.reduce(pending, { type: 'tick', nowMs: NOW + 59 * 1000 }).phase).toBe('pending');
        expect(D.reduce(pending, { type: 'tick', nowMs: NOW + 60 * 1000 }).phase).toBe('expired');
        expect(D.reduce(pending, { type: 'status', status: status(), nowMs: NOW + 61 * 1000 }).phase).toBe('expired');
    });

    test('polling is bounded to 15 minutes even if the server claims a later expiry', () => {
        const created = { url: URL_OK, expiresAt: new Date(NOW + 60 * 60 * 1000).toISOString() };
        const pending = run([{ type: 'link', created, nowMs: NOW }]);
        expect(pending.link.deadlineMs).toBe(NOW + D.BINDING_TTL_MS);
        expect(D.nextPoll(pending, NOW + D.BINDING_TTL_MS - 1000)).toBeNull();
    });

    test('no poll outside pending', () => {
        expect(D.nextPoll(run([{ type: 'status', status: status({ bound: true }), nowMs: NOW }]), NOW)).toBeNull();
        expect(D.nextPoll(D.initialState(), NOW)).toBeNull();
    });

    test('unbinding returns to idle with the digest off', () => {
        const connected = run([{ type: 'status', status: status({ bound: true, digest: { enabled: true, hour: 7, timezone: 'UTC' } }), nowMs: NOW }]);
        const idle = D.reduce(connected, { type: 'unbound' });
        expect(idle.phase).toBe('idle');
        expect(idle.status.digest.enabled).toBe(false);
    });

    test('a failed settings save keeps the connected phase and shows the error', () => {
        const connected = run([{ type: 'status', status: status({ bound: true }), nowMs: NOW }]);
        expect(D.reduce(connected, { type: 'fail', message: 'HTTP 409' })).toMatchObject({ phase: 'connected', error: 'HTTP 409' });
    });
});

describe('owner-only authority and page wiring', () => {
    test('only a stored owner key may manage delivery', () => {
        expect(D.canManageDelivery({ watchId: 'w1', watchKey: 'k' })).toBe(true);
        expect(D.canManageDelivery({ watchId: 'w1', readKey: 'r' })).toBe(false);
        expect(D.canManageDelivery({ watchId: 'w1', watchKey: '' })).toBe(false);
        expect(D.canManageDelivery(null)).toBe(false);
    });

    test('an owner key is found on either page, and a read-only key never counts', () => {
        // watch.js: an array of rows; stocks.js: an object keyed by ticker.
        const focused = [{ watchId: 'w1', watchKey: 'k1' }, { watchId: 'w2', readKey: 'r2' }];
        expect(D.storedCredential(focused, 'w1')).toEqual({ watchId: 'w1', watchKey: 'k1' });
        expect(D.storedCredential(focused, 'w2')).toBeNull();
        const comparisons = { NVDA: { watchId: 'c1', watchKey: 'k', readKey: 'r' }, TSLA: { watchId: 'c2', watchKey: '', readKey: 'r' } };
        expect(D.storedCredential(comparisons, 'c1')).toMatchObject({ watchId: 'c1', watchKey: 'k' });
        expect(D.storedCredential(comparisons, 'c2')).toBeNull();
        expect(D.storedCredential(comparisons, 'nope')).toBeNull();
        expect(D.storedCredential(comparisons, '')).toBeNull();
        expect(D.storedCredential(null, 'c1')).toBeNull();
        expect(D.storedCredential('c1', 'c1')).toBeNull();
    });

    test('each page names its own owned list, owner-key store and copy', () => {
        expect(D.HOSTS.map((host) => [host.listId, host.storageKey])).toEqual([
            ['savedWatchList', 'rwa-sonar-focused-watches-v1'],
            ['personalComparisons', 'rwa-sonar-server-watches-v1']
        ]);
        expect(D.HOSTS[1].subject).toBe('this comparison');
        expect(D.HOSTS[1].contents).toMatch(/compared issuers/);
        expect(D.HOSTS[1].contents).toContain('A model assessment is not a legal conclusion.');
        // stocks.js stores comparison owner keys under the key this module reads.
        expect(STOCKS_JS).toContain(`localStorage.setItem('${D.COMPARISON_STORAGE_KEY}'`);
    });

    test('controls decorate only the owned list, never the read-only shared view', () => {
        expect(JS).toContain('document.getElementById(host.listId)');
        expect(JS).not.toContain('sharedWatchView');
        // Every request is made with the owner key read back through canManageDelivery().
        expect(JS).toMatch(/return canManageDelivery\(row\) \? row : null;/);
        expect(JS).not.toMatch(/readKey/);
        // The shared view is a sibling of the owned list, not inside it.
        const shared = HTML.indexOf('id="sharedWatchView"');
        const owned = HTML.indexOf('id="savedWatchList"');
        expect(shared).toBeGreaterThan(0);
        expect(HTML.slice(shared, owned)).toMatch(/^id="sharedWatchView"[^>]*><\/div>\s*<div $/);
    });

    test('watch.html loads the script after api-base and watch.js, cache-busted', () => {
        const apiBase = HTML.indexOf('stocks/lib/api-base.js');
        const watch = HTML.indexOf('src="watch.js');
        const delivery = HTML.search(/src="watch-delivery\.js\?v=2026\d{4}[a-z]"/);
        expect(delivery).toBeGreaterThan(watch);
        expect(watch).toBeGreaterThan(apiBase);
    });

    test('stocks.html loads the script after stocks.js, cache-busted, with the shared stylesheet', () => {
        const stocks = STOCKS_HTML.indexOf('src="stocks.js');
        const delivery = STOCKS_HTML.search(/src="watch-delivery\.js\?v=2026\d{4}[a-z]"/);
        expect(stocks).toBeGreaterThan(0);
        expect(delivery).toBeGreaterThan(stocks);
        for (const page of [STOCKS_HTML, HTML]) expect(page).toMatch(/href="watch-delivery\.css\?v=2026\d{4}[a-z]"/);
        expect(readFileSync(join(__dirname, 'watch-delivery.css'), 'utf8')).toContain('.personal-list .wat-tg {');
    });

    test('only saved comparisons with an owner key in this browser are marked for the control', () => {
        // The read-only shared comparison (#watch=id.readKey) never stores a watchKey, so it never
        // gets data-watch-id, and the Telegram control never appears for it.
        expect(STOCKS_JS).toMatch(/typeof credential\?\.watchKey === 'string' && credential\.watchKey/);
        expect(STOCKS_JS).toContain('data-watch-id="${escapeHtml(ownedWatchId(row.ticker))}"');
        expect(STOCKS_JS).toMatch(/if \(watch\.access === 'owner' && credential\.watchKey\) \{\s*storeServerWatchCredential/);
    });

    test('copy says what arrives, labels the model assessment, and states the privacy promise', () => {
        expect(D.COPY.contents).toContain('model assessment');
        expect(D.COPY.contents).toMatch(/Nothing is sent on a day with no change/);
        expect(D.COPY.privacy).toMatch(/encrypted Telegram chat id/);
        expect(JS).toContain("'Get this on Telegram'");
        expect(JS).toContain("'Stop Telegram digests'");
    });
});
