// Unit tests for stocks/lib/companions.mjs: which cited pages have a same-publisher API companion,
// what text a companion answer becomes (trimmed real answers of registry.npmjs.org and the
// crates.io API, 2026-09-23), and which live outcomes qualify for a companion read.

import { companionFor, companionNote, companionText, wantsCompanion } from './lib/companions.mjs';
import { quoteFound } from './lib/watch.mjs';

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

    test('the note says the page was not read and names the companion', () => {
        expect(companionNote({ liveReason: 'http-403 (bot wall)', reader: 'npm-registry', url: 'https://registry.npmjs.org/x' }))
            .toBe("live page unreadable (http-403 (bot wall)); text read from the publisher's npm-registry companion — https://registry.npmjs.org/x");
    });
});
