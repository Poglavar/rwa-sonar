// Unit tests for stocks/lib/companions.mjs: which cited pages have a same-publisher API companion,
// what text a companion answer becomes (trimmed real answers of registry.npmjs.org and the
// crates.io API, 2026-09-23), and which live outcomes qualify for a companion read.

import { readFileSync } from 'node:fs';

import { companionFor, companionNote, companionText, currentNextChunk, formatUnits, solanaTxText, wantsCompanion } from './lib/companions.mjs';
import { dossierQuotes, quoteFound } from './lib/watch.mjs';

// A real getTransaction (jsonParsed, finalized) answer, trimmed to the fields the renderer reads:
// an Ondo GM RedeemForUsdc of RTXon, slot 449655006, read 2026-09-24.
const RTXON_REDEEM = JSON.parse(readFileSync(new URL('./fixtures/sources/solana-tx-ondo-rtxon-redeem.json', import.meta.url), 'utf8'));
const RTXON_SIG = '4wK2ovdzfwt71u2cJ1DxMCixDw6bNhHNV8aiC4V5dGPyj2rDwa1je9sfPYd4J91AJmCnBps3kkrcqRUBxJxhHMAN';

const NPM = {
    _id: '@superstateinc/allowlist',
    name: '@superstateinc/allowlist',
    'dist-tags': { latest: '0.1.1' },
    versions: { '0.1.1': { description: 'TypeScript library for interacting with the Superstate Allowlist program on Solana', license: 'MIT' } },
    time: { modified: '2026-09-01T00:00:00.000Z' },
    description: 'TypeScript library for interacting with the Superstate Allowlist program on Solana',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/superstate-holdings/webserver-clone.git' },
    readme: '# Superstate Allowlist Program\n\nTypeScript library for interacting with the Superstate Allowlist program on Solana.'
};
const CRATE = {
    crate: {
        name: 'superstate-allowlist-interface', description: 'Superstate Allowlist Interface',
        max_stable_version: '0.1.0', newest_version: '0.1.0', downloads: 1234, updated_at: '2026-09-01T00:00:00Z',
        repository: null, homepage: null, documentation: null
    }
};

describe('companionFor', () => {
    test('npm package pages map to the registry document, scoped names encoded', () => {
        expect(companionFor('https://www.npmjs.com/package/@superstateinc/allowlist')).toEqual({
            url: 'https://registry.npmjs.org/@superstateinc%2fallowlist', reader: 'npm-registry'
        });
        expect(companionFor('https://www.npmjs.com/package/left-pad')).toEqual({
            url: 'https://registry.npmjs.org/left-pad', reader: 'npm-registry'
        });
    });

    test('crates.io crate pages map to the documented API', () => {
        expect(companionFor('https://crates.io/crates/superstate-allowlist-interface')).toEqual({
            url: 'https://crates.io/api/v1/crates/superstate-allowlist-interface', reader: 'crates-api'
        });
    });

    test('anything else has no companion — the watcher never guesses one', () => {
        expect(companionFor('https://www.npmjs.com/search?q=allowlist')).toBeNull();
        expect(companionFor('https://www.npmjs.com/package/@scope/name/v/1.0.0')).toBeNull();
        expect(companionFor('https://crates.io/users/someone')).toBeNull();
        expect(companionFor('https://www.theblock.co/post/1')).toBeNull();
        expect(companionFor('not a url')).toBeNull();
    });
});

describe('companionText', () => {
    test('npm: the package document as a reader sees it, without the modified clock', () => {
        const text = companionText('npm-registry', JSON.stringify(NPM));
        expect(text).toContain('package: @superstateinc/allowlist');
        expect(text).toContain('latest version: 0.1.1');
        expect(text).toContain('# Superstate Allowlist Program');
        expect(text).not.toContain('2026-09-01');
        expect(quoteFound(text, 'TypeScript library for interacting with the Superstate Allowlist program on Solana')).toBe(true);
    });

    test('crates: the crate record without download counts or update times', () => {
        const text = companionText('crates-api', CRATE);
        expect(text.split('\n')).toEqual([
            'crate: superstate-allowlist-interface', 'description: Superstate Allowlist Interface', 'newest version: 0.1.0'
        ]);
    });

    test('an answer of the wrong shape throws instead of becoming an empty document', () => {
        expect(() => companionText('npm-registry', '{"error":"Not found"}')).toThrow(/no package name/);
        expect(() => companionText('crates-api', '{"errors":[{"detail":"crate does not exist"}]}')).toThrow(/no crate name/);
        expect(() => companionText('npm-registry', '<html>')).toThrow();
        expect(() => companionText('other', '{}')).toThrow(/unknown companion reader/);
    });
});

describe('securitize.io disclosures through Builder.io', () => {
    // Trimmed shape of cdn.builder.io/api/v3/content/legal?…&query.name=terms-of-service (2026-09-23):
    // nested Text components carry the words as HTML; `updatedAt` is left out of the text.
    const LEGAL = { results: [{ name: 'terms-of-service', data: {
        title: 'Terms of Service', updatedAt: 1780318800000,
        blocks: [
            { component: { name: 'Text', options: { text: '<p><strong>PLEASE READ THESE TERMS OF SERVICE CAREFULLY.</strong></p>' } } },
            { component: { name: 'Box' }, children: [
                { component: { name: 'Text', options: { text: '<p>Securitize may freeze your account&nbsp;at any time.</p>' } } },
                { component: { name: 'Image', options: { image: 'https://cdn.builder.io/x.png' } } }
            ] }
        ]
    } }] };

    test('a disclosure page maps to its `legal` entry; the library to its list; nothing else', () => {
        expect(companionFor('https://securitize.io/disclosure/terms-of-service-transfer-agent')).toEqual({
            url: 'https://cdn.builder.io/api/v3/content/legal?apiKey=d39b51a544e84e2fbb2445f58c6c6f2c&query.name=terms-of-service-transfer-agent&limit=1',
            reader: 'builder-content'
        });
        expect(companionFor('https://securitize.io/disclosure-library').url).toMatch(/\/content\/disclosure-library\?apiKey=/);
        expect(companionFor('https://securitize.io/')).toBeNull();
    });

    test('the Text components, in order and depth-first, become the page text', () => {
        const text = companionText('builder-content', LEGAL);
        expect(text.split('\n')).toEqual(['title: Terms of Service', 'PLEASE READ THESE TERMS OF SERVICE CAREFULLY.', 'Securitize may freeze your account at any time.']);
        expect(text).not.toContain('1780318800000');
        expect(quoteFound(text, 'Securitize may freeze your account at any time')).toBe(true);
    });

    test('the library entry lists its disclosures; an empty answer is an error', () => {
        const library = { results: [{ data: { title: 'Disclosure Library', links: [
            { label: 'Securitize Markets Terms of Service', url: '/disclosure/terms-of-service-markets' }
        ] } }] };
        expect(companionText('builder-content', library)).toBe(
            'title: Disclosure Library\nSecuritize Markets Terms of Service — /disclosure/terms-of-service-markets');
        expect(() => companionText('builder-content', { results: [] })).toThrow(/no entry/);
        expect(() => companionText('builder-content', { results: [{ data: { title: 'x', blocks: [] } }] })).toThrow(/no text blocks/);
    });
});

describe('wantsCompanion', () => {
    test('a refusal or a JavaScript-only page qualifies; gone, rate limits and good reads do not', () => {
        expect(wantsCompanion({ status: 'blocked', httpStatus: 403, reason: 'http-403 (bot wall)' })).toBe(true);
        expect(wantsCompanion({ status: 'blocked', httpStatus: 200, reason: 'javascript-only page: no text without a browser' })).toBe(true);
        expect(wantsCompanion({ status: 'blocked', httpStatus: 200, botWall: true, reason: 'bot wall served with a 200' })).toBe(true);
        expect(wantsCompanion({ status: 'blocked', httpStatus: 429, reason: 'http-429 after backoff' })).toBe(false);
        expect(wantsCompanion({ status: 'gone', httpStatus: 404, reason: 'http-404' })).toBe(false);
        expect(wantsCompanion({ status: 'ok', httpStatus: 200, reason: 'same hash' })).toBe(false);
    });

    test('a Next.js page chunk qualifies only once it is gone', () => {
        expect(wantsCompanion({ status: 'gone', httpStatus: 404, reason: 'http-404', reader: 'next-app-chunk' })).toBe(true);
        expect(wantsCompanion({ status: 'ok', httpStatus: 200, reason: 'same hash', reader: 'next-app-chunk' })).toBe(false);
        expect(wantsCompanion({ status: 'blocked', httpStatus: 403, reason: 'http-403 (bot wall)', reader: 'next-app-chunk' })).toBe(false);
        expect(wantsCompanion({ status: 'error', httpStatus: 503, reason: 'http-503', reader: 'next-app-chunk' })).toBe(false);
    });

    test('the note says the page was not read and names the companion', () => {
        expect(companionNote({ liveReason: 'http-403 (bot wall)', reader: 'npm-registry', url: 'https://registry.npmjs.org/x' }))
            .toBe("live page unreadable (http-403 (bot wall)); text read from the publisher's npm-registry companion — https://registry.npmjs.org/x");
    });
});

describe('Solscan transaction pages through Solana RPC getTransaction', () => {
    test('a solscan /tx/<signature> page maps to an RPC call whose descriptor carries no RPC URL', () => {
        const companion = companionFor(`https://solscan.io/tx/${RTXON_SIG}`);
        expect(companion).toEqual({
            url: `solana-rpc:getTransaction:${RTXON_SIG}`,
            reader: 'solana-tx',
            rpc: { method: 'getTransaction', params: [RTXON_SIG, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' }] }
        });
        expect(companionFor('https://solscan.io/token/12BvLZtzjdssAycxPeBQUjukhmgQpULAvy6SroYdondo')).toBeNull();
        expect(companionFor('https://solscan.io/tx/not-a-signature')).toBeNull();
    });

    test('the chain\'s answer becomes identity, verbatim logs, decoded instructions and balance changes', () => {
        const lines = solanaTxText(RTXON_REDEEM).split('\n');
        expect(lines.slice(0, 6)).toEqual([
            `transaction ${RTXON_SIG}`,
            'slot 449655006',
            'block time 2026-09-23T08:54:45Z',
            'status success',
            'fee payer 9BB7Tt5uE5VdRsxA5XRqrjwNaq8XtgAUQW8czA6ymUPG',
            'signers 9BB7Tt5uE5VdRsxA5XRqrjwNaq8XtgAUQW8czA6ymUPG'
        ]);
        expect(lines).toContain('Program log: Instruction: RedeemForUsdc');
        expect(lines).toContain('#2.7 spl-token burnChecked: amount 0.877296251, account 8CLHPVvu5EEmQPYFkNAXdWoQkJAKpMscmq41KT5Gcui8, '
            + 'authority 9BB7Tt5uE5VdRsxA5XRqrjwNaq8XtgAUQW8czA6ymUPG, mint 12BvLZtzjdssAycxPeBQUjukhmgQpULAvy6SroYdondo');
        expect(lines).toContain('#1 program KeccakSecp256k11111111111111111111111111111 (not decoded)');
        expect(lines).toContain('owner 9BB7Tt5uE5VdRsxA5XRqrjwNaq8XtgAUQW8czA6ymUPG, mint 12BvLZtzjdssAycxPeBQUjukhmgQpULAvy6SroYdondo, '
            + 'account 8CLHPVvu5EEmQPYFkNAXdWoQkJAKpMscmq41KT5Gcui8: 0.877296251 -> 0 (-0.877296251)');
        // Sections in a fixed order, so a quote's ellipsis fragments can rely on it.
        expect(lines.indexOf('program logs:')).toBeLessThan(lines.indexOf('instructions:'));
        expect(lines.indexOf('instructions:')).toBeLessThan(lines.indexOf('token balance changes:'));
        expect(companionText('solana-tx', JSON.stringify(RTXON_REDEEM))).toBe(solanaTxText(RTXON_REDEEM));
    });

    test('the Ondo dossier\'s quote for this transaction is found in the rendered chain answer', () => {
        const dossier = JSON.parse(readFileSync(new URL('./data/issuers/ondo-global-markets.json', import.meta.url), 'utf8'));
        const quoted = dossierQuotes('ondo-global-markets', dossier).filter((q) => q.citedUrl === `https://solscan.io/tx/${RTXON_SIG}`);
        expect(quoted).toHaveLength(1);
        expect(quoteFound(solanaTxText(RTXON_REDEEM), quoted[0].quote)).toBe(true);
    });

    test('a null answer (not found, not finalized) is an error, never an empty document', () => {
        expect(() => solanaTxText(null)).toThrow('transaction not found');
        expect(() => companionText('solana-tx', 'null')).toThrow('transaction not found');
    });

    test('base units format exactly, without floating point', () => {
        expect(formatUnits('877296251', 9)).toBe('0.877296251');
        expect(formatUnits('9916733845527', 6)).toBe('9916733.845527');
        expect(formatUnits('-168381097', 6)).toBe('-168.381097');
        expect(formatUnits('8160140778570159', 9)).toBe('8160140.778570159');
        expect(formatUnits('5000000', 6)).toBe('5');
        expect(formatUnits('0', 6)).toBe('0');
    });
});

describe('Next.js page chunks renamed by a redeploy', () => {
    // prestocks.com/faq keeps its 17 answers in the page chunk; page-eda8c20836ef75f8.js answered 404
    // on 2026-09-24 and the page served that day loads page-d984255e63e260a7.js (both forms below
    // are trimmed from that HTML: the <script src> and the flight payload's bare reference).
    const FAQ_HTML = '<script src="/_next/static/chunks/app/faq/page-d984255e63e260a7.js" async="" nonce="x"></script>'
        + '<script>self.__next_f.push([1,"6:I[42,[\\"static/chunks/1816-4f7d0bba9810fd96.js\\",\\"7505\\",'
        + '\\"static/chunks/app/faq/page-d984255e63e260a7.js\\"],\\"default\\"]"])</script>';

    test('a page chunk maps to the route that loads it; route groups drop out; dynamic routes have none', () => {
        expect(companionFor('https://prestocks.com/_next/static/chunks/app/faq/page-eda8c20836ef75f8.js')).toEqual({
            url: 'https://prestocks.com/faq', reader: 'next-app-chunk', chunkPrefix: '/_next/static/chunks/app/faq/page-', liveValidators: true
        });
        expect(companionFor('https://x.example/_next/static/chunks/app/(marketing)/legal/terms/page-0a1b2c3d4e5f6a7b.js')?.url)
            .toBe('https://x.example/legal/terms');
        expect(companionFor('https://x.example/_next/static/chunks/app/page-0a1b2c3d4e5f6a7b.js')?.url).toBe('https://x.example/');
        expect(companionFor('https://x.example/_next/static/chunks/app/docs/[slug]/page-0a1b2c3d4e5f6a7b.js')).toBeNull();
        expect(companionFor('https://x.example/_next/static/chunks/app/@modal/page-0a1b2c3d4e5f6a7b.js')).toBeNull();
        expect(companionFor('https://x.example/_next/static/chunks/1816-4f7d0bba9810fd96.js')).toBeNull();
        expect(companionFor('https://x.example/_next/static/chunks/app/faq/layout-0a1b2c3d4e5f6a7b.js')).toBeNull();
    });

    test('the chunk the page loads now is found from either reference, once', () => {
        expect(currentNextChunk(FAQ_HTML, 'https://prestocks.com/faq', '/_next/static/chunks/app/faq/page-'))
            .toBe('https://prestocks.com/_next/static/chunks/app/faq/page-d984255e63e260a7.js');
        // Only the flight payload names it: still the page's own origin.
        expect(currentNextChunk('"static/chunks/app/faq/page-d984255e63e260a7.js"', 'https://prestocks.com/faq', '/_next/static/chunks/app/faq/page-'))
            .toBe('https://prestocks.com/_next/static/chunks/app/faq/page-d984255e63e260a7.js');
        // An asset prefix on the <script src> wins over the bare reference.
        expect(currentNextChunk('"static/chunks/app/faq/page-abc123.js" <script src="https://cdn.example/_next/static/chunks/app/faq/page-abc123.js">',
            'https://site.example/faq', '/_next/static/chunks/app/faq/page-'))
            .toBe('https://cdn.example/_next/static/chunks/app/faq/page-abc123.js');
    });

    test('no chunk, or two different ones, is an error rather than a guess', () => {
        expect(() => currentNextChunk('<html>moved</html>', 'https://prestocks.com/faq', '/_next/static/chunks/app/faq/page-'))
            .toThrow(/loads no/);
        expect(() => currentNextChunk('/_next/static/chunks/app/faq/page-aaa.js /_next/static/chunks/app/faq/page-bbb.js',
            'https://prestocks.com/faq', '/_next/static/chunks/app/faq/page-')).toThrow(/2 different/);
    });
});
