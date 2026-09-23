// The "feels alive" motions (next-steps 18–20) are decided by pure functions, tested here without a
// browser: the watch patrol's material-change ping, the landing trade ticker and count-up, and the
// what-if matrix reveal. Plus the markup contracts the pages rely on: the ping's text equivalent
// starts empty, the ticker starts hidden, and the ticker's second (marquee) copy is inert.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const landing = require('./landing.js');
const watch = require('./watch.js');
const whatif = require('./whatif.js');

const read = (file) => readFileSync(join(__dirname, file), 'utf8');

describe('count-up', () => {
    test('ends on the exact rendered text, whatever its shape', () => {
        for (const text of ['1,183', '$4.56M', '12,345.67', '517', '$0', '—', '']) {
            expect(landing.countUpText(text, 1)).toBe(text);
            expect(landing.countUpText(text, 1.4)).toBe(text);
        }
    });

    test('starts at zero in the same format, and climbs without overshooting', () => {
        expect(landing.countUpText('1,183', 0)).toBe('0');
        expect(landing.countUpText('$4.56M', 0)).toBe('$0.00M');
        expect(landing.countUpText('12,345.67', 0)).toBe('0.00');
        const frames = [0.1, 0.3, 0.5, 0.8, 0.99].map((p) => Number(landing.countUpText('1,183', p).replace(/,/g, '')));
        for (let i = 1; i < frames.length; i++) expect(frames[i]).toBeGreaterThanOrEqual(frames[i - 1]);
        expect(frames.at(-1)).toBeLessThanOrEqual(1183);
        expect(landing.countUpText('2,468', 0.5)).toMatch(/^\d{1,3}(,\d{3})*$/);
    });

    test('a missing value never counts', () => {
        expect(landing.countUpText('—', 0)).toBe('—');
        expect(landing.countUpText('Data unavailable', 0.2)).toBe('Data unavailable');
    });
});

describe('landing trade ticker', () => {
    const NOW = Date.parse('2026-09-23T19:14:00Z');
    const row = (over) => ({
        sig: 'sig-a', time: '2026-09-23T19:13:20.000Z', mint: 'MintNVDA', symbol: 'NVDAx', dex: 'raydium',
        side: 'buy', price_usd: 182.4, suspect: null, ...over
    });

    test('formats a real trade as symbol, side, USD price, venue and age, linked to the builder slug', () => {
        const [item] = landing.tickerItems([row()], new Map([['MintNVDA', 'NVDAx']]), NOW);
        expect(item).toMatchObject({
            symbol: 'NVDAx', side: 'buy', glyph: '▲', price: '$182.40', venue: 'Raydium',
            age: '40 s ago', href: './cards/NVDAx.html', mint: 'MintNVDA'
        });
    });

    test('a colliding symbol links to the slug the builder chose, never a guess from the symbol', () => {
        const slugs = new Map([['XyzMint123', 'ABCx-XyzMin']]);
        const [item] = landing.tickerItems([row({ mint: 'XyzMint123', symbol: 'ABCx' })], slugs, NOW);
        expect(item.href).toBe('./cards/ABCx-XyzMin.html');
        const [unknown] = landing.tickerItems([row({ mint: 'Other', symbol: 'ABCx' })], slugs, NOW);
        expect(unknown.href).toBeNull();
    });

    test('drops rows that would show something untrue: suspect, unpriced, undated, stale or duplicated', () => {
        const rows = [
            row({ sig: '1', suspect: 'round-trip' }),
            row({ sig: '2', price_usd: null }),
            row({ sig: '3', price_usd: 0 }),
            row({ sig: '4', time: 'not a time' }),
            row({ sig: '5', symbol: '' }),
            row({ sig: '6', time: '2026-09-21T19:13:20.000Z' }),
            row({ sig: '7', side: 'sell', time: '2026-09-23T19:10:00.000Z' }),
            row({ sig: '7', side: 'sell', time: '2026-09-23T19:10:00.000Z' })
        ];
        const items = landing.tickerItems(rows, new Map(), NOW);
        expect(items.map((item) => item.sig)).toEqual(['7']);
        expect(items[0]).toMatchObject({ glyph: '▼', age: '4 min ago' });
        expect(landing.tickerItems([], new Map(), NOW)).toEqual([]);
        expect(landing.tickerItems(null, null, NOW)).toEqual([]);
    });

    test('newest first, capped, and the card lookups are the distinct mints shown', () => {
        const rows = Array.from({ length: 20 }, (_, i) => row({
            sig: `s${i}`, mint: `M${i % 3}`, time: new Date(NOW - (20 - i) * 1000).toISOString()
        }));
        const items = landing.tickerItems(rows, new Map(), NOW);
        expect(items).toHaveLength(landing.TICKER_LIMIT);
        expect(items[0].sig).toBe('s19');
        expect(landing.tickerMints(items)).toEqual(['M1', 'M0', 'M2']);
    });

    test('the marquee is slow: at least 24 s a lap, longer for a longer track', () => {
        expect(landing.tickerDurationSeconds(0)).toBe(24);
        expect(landing.tickerDurationSeconds(null)).toBe(24);
        expect(landing.tickerDurationSeconds(3200)).toBe(100);
    });

    test('the strip starts hidden, and the marquee copy is inert to keyboards and screen readers', () => {
        expect(read('index.html')).toMatch(/<section id="tradeTicker" class="trade-ticker"[^>]*\bhidden>/);
        const [item] = landing.tickerItems([row()], new Map([['MintNVDA', 'NVDAx']]), NOW);
        const first = landing.tickerItemHtml(item, false);
        const copy = landing.tickerItemHtml(item, true);
        expect(first).toContain('<a href="./cards/NVDAx.html">');
        expect(first).toContain('<span class="sr-only"> buy</span>');
        expect(first).not.toContain('tabindex');
        expect(first).not.toContain('ticker-copy');
        expect(copy).toMatch(/^<li class="ticker-item ticker-copy" aria-hidden="true">/);
        expect(copy).toContain('tabindex="-1"');
        const unlinked = landing.tickerItemHtml({ ...item, href: null }, false);
        expect(unlinked).not.toContain('<a ');
        const css = read('landing.css');
        // Without motion the copy is never displayed; the marquee only exists inside the guard.
        expect(css).toMatch(/\.ticker-copy,[^{]*\{\s*display: none;/);
    });
});

describe('watch patrol contact', () => {
    const NOW = Date.parse('2026-09-23T20:00:00Z');
    const valid = { status: 'valid', material: true, summary: 'Redemption fee rises.' };

    test('pings only for a valid, material assessment on a change detected in the last 24 hours', () => {
        expect(watch.materialContact([{ detected_at: '2026-09-23T10:00:00Z', modelAssessment: valid }], NOW))
            .toEqual({ count: 1, message: 'A material change was detected in the last 24 hours.' });
        const two = [
            { detected_at: '2026-09-23T10:00:00Z', modelAssessment: valid },
            { detected_at: '2026-09-23T19:59:00Z', modelAssessment: valid }
        ];
        expect(watch.materialContact(two, NOW).message).toBe('2 material changes were detected in the last 24 hours.');
    });

    test('stays silent otherwise', () => {
        for (const items of [
            [],
            null,
            [{ detected_at: '2026-09-22T19:59:00Z', modelAssessment: valid }],
            [{ detected_at: '2026-09-23T10:00:00Z', modelAssessment: { ...valid, material: false } }],
            [{ detected_at: '2026-09-23T10:00:00Z', modelAssessment: { status: 'invalid' } }],
            [{ detected_at: '2026-09-23T10:00:00Z', modelAssessment: null }],
            [{ detected_at: null, modelAssessment: valid }]
        ]) expect(watch.materialContact(items, NOW)).toBeNull();
        expect(watch.materialContact([{ detected_at: '2026-09-23T10:00:00Z', modelAssessment: valid }], null)).toBeNull();
    });

    test('the text equivalent starts empty in a status region, beside the ring it describes', () => {
        const html = read('watch.html');
        expect(html).toMatch(/<span id="patrolSpot" class="research-spot-wrap"><img class="research-spot dolphin-bob"[^>]*><span class="sonar-ping" aria-hidden="true"><\/span><\/span>/);
        expect(html).toMatch(/<p id="patrolContact" class="visually-hidden" role="status"><\/p>/);
    });
});

describe('what-if matrix reveal', () => {
    test('is short however many rows there are, starting at once and never going backwards', () => {
        for (const n of [1, 5, 38, 400]) {
            const delays = whatif.revealDelays(n);
            expect(delays).toHaveLength(n);
            expect(delays[0]).toBe(0);
            expect(delays.at(-1)).toBeLessThanOrEqual(480);
            for (let i = 1; i < n; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
        }
        expect(whatif.revealDelays(5)).toEqual([0, 18, 36, 54, 72]);
        expect(whatif.revealDelays(0)).toEqual([]);
        expect(whatif.revealDelays(-3)).toEqual([]);
    });
});
