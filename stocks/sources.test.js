// Unit tests for stocks/lib/sources.mjs — the registry extraction that decides WHICH URLs the
// watcher will fetch and what each one is called. Every test asserts something a reader of
// stocks/data/sources.json would notice if it broke: that two spellings of the same document are
// one source and not two, that a URL buried in prose is found at all, that a citation written with
// an ellipsis is reported instead of being fetched as a guess, and that a document keeps the title
// its dossier gave it.

import { readFileSync } from 'node:fs';

import {
    buildRegistry, classifyKind, countBy, extractUrls, hostOf, kindFromContentType, labelPath,
    isDocumentWatchable, normaliseUrl, topHosts, trimUrl, walkUrls
} from './lib/sources.mjs';

const RUN = '2026-09-17T09:00:00Z';

describe('normaliseUrl', () => {
    test('drops the fragment and utm parameters but keeps every other query parameter', () => {
        expect(normaliseUrl('https://a.com/doc?utm_source=x&id=7#section-3')).toBe('https://a.com/doc?id=7');
        // ?alt=media&token=… IS the document on gitbook/firebase hosting: it must survive.
        expect(normaliseUrl('https://f.io/o/x.pdf?alt=media&token=abc')).toBe('https://f.io/o/x.pdf?alt=media&token=abc');
    });

    test('a URL that is only tracking parameters loses the lone question mark', () => {
        expect(normaliseUrl('https://a.com/doc?utm_campaign=x')).toBe('https://a.com/doc');
    });

    test('lowercases the host, keeps the path case, gives an empty path a slash', () => {
        expect(normaliseUrl('https://WWW.SEC.GOV/Archives/Edgar')).toBe('https://www.sec.gov/Archives/Edgar');
        expect(normaliseUrl('https://prestocks.com')).toBe('https://prestocks.com/');
    });

    test('two spellings of the same document normalise to one source', () => {
        const a = normaliseUrl('https://docs.ondo.finance/terms?utm_medium=email#top');
        const b = normaliseUrl('https://DOCS.ondo.finance/terms');
        expect(a).toBe(b);
    });

    test('trims the punctuation a sentence leaves behind', () => {
        expect(trimUrl('https://a.com/doc.')).toBe('https://a.com/doc');
        expect(trimUrl('https://a.com/doc),')).toBe('https://a.com/doc');
    });

    test('a citation written with an ellipsis is not a URL', () => {
        // Both of these are real: the dossiers cite them truncated.
        expect(trimUrl('https://api.brokercheck.finra.org/search/firm?query=...')).toBeNull();
        expect(trimUrl('https://remora-public.s3.us-east-2.amazonaws.com/solana/token...')).toBeNull();
        expect(normaliseUrl('https://a.com/x…')).toBeNull();
    });

    test('rejects what is not an http(s) URL', () => {
        expect(normaliseUrl('ftp://a.com/x')).toBeNull();
        expect(normaliseUrl('mailto:someone@a.com')).toBeNull();
        expect(normaliseUrl('not a url')).toBeNull();
    });
});

describe('classifyKind', () => {
    test('pdf by extension, api by host or path or .json, html otherwise', () => {
        expect(classifyKind('https://www.sec.gov/files/x.pdf')).toBe('pdf');
        expect(classifyKind('https://lite-api.jup.ag/tokens/v2/search?query=AAPLx')).toBe('api');
        expect(classifyKind('https://prestocks.com/api/prestocks')).toBe('api');
        expect(classifyKind('https://prestocks.com/metadata/openai.json')).toBe('api');
        expect(classifyKind('https://docs.ondo.finance/terms')).toBe('html');
    });

    test('the served content-type overrides the URL guess', () => {
        // A prospectus served from a path with no extension is still a PDF.
        expect(kindFromContentType('application/pdf', 'https://a.com/download/1234')).toBe('pdf');
        expect(kindFromContentType('application/json; charset=utf-8', 'https://a.com/doc')).toBe('api');
        expect(kindFromContentType('text/html; charset=utf-8', 'https://a.com/x.pdf')).toBe('html');
        // No content-type at all falls back to the URL.
        expect(kindFromContentType(undefined, 'https://a.com/x.pdf')).toBe('pdf');
    });
});

describe('document watcher boundary', () => {
    test('leaves RPC and explorer locators to the chain watcher', () => {
        expect(isDocumentWatchable('https://api.mainnet-beta.solana.com/')).toBe(false);
        expect(isDocumentWatchable('https://explorer.solana.com/address/MINT')).toBe(false);
        expect(isDocumentWatchable('https://explorer.solana.com/tx/SIGNATURE')).toBe(false);
        expect(isDocumentWatchable('https://api-v3.raydium.io/pools/info/mint')).toBe(false);
        expect(isDocumentWatchable('https://api-v3.raydium.io/pools/info/mint?mint1=abc')).toBe(true);
        expect(isDocumentWatchable('https://docs.solana.com/accounts')).toBe(true);
    });
});

describe('extractUrls and walkUrls', () => {
    test('finds a URL inside prose and stops at the closing punctuation', () => {
        const prose = 'Observed on-chain (see https://api.mainnet-beta.solana.com (getAccountInfo)) '
            + 'and reported by https://www.coindesk.com/markets/x.';
        expect(extractUrls(prose).map((h) => h.url)).toEqual([
            'https://api.mainnet-beta.solana.com/',
            'https://www.coindesk.com/markets/x'
        ]);
    });

    test('reports the field path a URL was found in, arrays included', () => {
        const doc = {
            documents: [{ title: 'Terms', url: 'https://a.com/terms' }],
            redemption: { rails: 'USDC, see https://a.com/fees for the schedule' },
            findings: [{ evidence: 'https://a.com/terms' }]
        };
        expect(walkUrls(doc).map((h) => [h.path, h.url])).toEqual([
            ['documents[0].url', 'https://a.com/terms'],
            ['redemption.rails', 'https://a.com/fees'],
            ['findings[0].evidence', 'https://a.com/terms']
        ]);
    });
});

describe('buildRegistry', () => {
    const alpha = {
        slug: 'alpha',
        doc: {
            documents: [
                { title: 'Alpha Terms of Service', url: 'https://alpha.com/terms?utm_source=news' },
                { title: 'Alpha Prospectus', url: 'https://cdn.alpha.com/base.pdf' }
            ],
            findings: [{ evidence: 'https://alpha.com/terms#clause-9' }],
            redemption: { fees: 'Unbounded; see https://alpha.com/fees.' }
        }
    };
    const beta = {
        slug: 'beta',
        doc: { sources: ['https://alpha.com/terms', 'https://beta.com/api/tokens'] }
    };

    test('dedupes across dossiers and keeps every citing path', () => {
        const { items, count } = buildRegistry([alpha, beta], { generatedAt: RUN });
        expect(count).toBe(items.length);
        const terms = items.find((i) => i.url === 'https://alpha.com/terms');
        expect(terms.foundIn).toEqual([
            'alpha:documents[0].url', 'alpha:findings[0].evidence', 'beta:sources[0]'
        ]);
        // Three spellings (utm, fragment, bare) became ONE source.
        expect(items.filter((i) => i.url.startsWith('https://alpha.com/terms'))).toHaveLength(1);
    });

    test('a documents[] title wins; otherwise the field path is the name', () => {
        const { items } = buildRegistry([alpha, beta], { generatedAt: RUN });
        expect(items.find((i) => i.url === 'https://alpha.com/terms').title).toBe('Alpha Terms of Service');
        expect(items.find((i) => i.url === 'https://alpha.com/fees').title).toBe('alpha:redemption.fees');
    });

    test('the issuer is the dossier whose documents[] cites it, not merely the first one', () => {
        // beta cites alpha's terms in sources[]; alpha cites it as a document.
        const { items } = buildRegistry([beta, alpha], { generatedAt: RUN });
        expect(items.find((i) => i.url === 'https://alpha.com/terms').issuer).toBe('alpha');
        expect(items.find((i) => i.url === 'https://beta.com/api/tokens').issuer).toBe('beta');
    });

    test('kinds are classified and items sorted by URL, so the file is stable', () => {
        const { items } = buildRegistry([alpha, beta], { generatedAt: RUN });
        expect(items.map((i) => i.url)).toEqual([...items.map((i) => i.url)].sort());
        expect(items.find((i) => i.url === 'https://cdn.alpha.com/base.pdf').kind).toBe('pdf');
        expect(items.find((i) => i.url === 'https://beta.com/api/tokens').kind).toBe('api');
    });

    test('a truncated citation is reported, never fetched', () => {
        const dossier = { slug: 'gamma', doc: { sources: ['https://gamma.com/token...'] } };
        const { items, truncated } = buildRegistry([dossier], { generatedAt: RUN });
        expect(items).toHaveLength(0);
        expect(truncated).toEqual([
            { issuer: 'gamma', path: 'sources[0]', raw: 'https://gamma.com/token...' }
        ]);
    });

    test('a dossier with no slug (canonical-parties.json) is tagged shared and has no issuer', () => {
        const { items } = buildRegistry([{ slug: null, doc: { website: 'https://forwardindustries.com' } }],
            { generatedAt: RUN });
        expect(items[0].issuer).toBeNull();
        expect(items[0].foundIn).toEqual(['shared:website']);
    });

    test('refuses to invent its own generatedAt', () => {
        expect(() => buildRegistry([alpha])).toThrow(/generatedAt/);
    });
});

describe('summary helpers', () => {
    const items = [
        { url: 'https://www.sec.gov/a', kind: 'pdf', issuer: 'x' },
        { url: 'https://www.sec.gov/b', kind: 'html', issuer: 'x' },
        { url: 'https://docs.ondo.finance/c', kind: 'html', issuer: null }
    ];

    test('countBy and topHosts count what the run summary prints', () => {
        expect(countBy(items, (i) => i.kind)).toEqual({ html: 2, pdf: 1 });
        expect(countBy(items, (i) => i.issuer)).toEqual({ x: 2, none: 1 });
        expect(topHosts(items, 1)).toEqual([['www.sec.gov', 2]]);
        expect(hostOf('https://Docs.Ondo.Finance/c')).toBe('docs.ondo.finance');
    });
});

describe('what-if answers are watched sources too', () => {
    // A `whatIf[]` answer cites the clause it rests on and, when a court decided the case, the
    // judgment. Those are exactly the documents that must not change behind our back, so they have
    // to reach the registry — and be labelled by the MODE, because the array index moves whenever
    // an answer is inserted above them.
    const doc = {
        whatIf: [
            {
                mode: 'issuer-wind-down',
                status: 'documented',
                quote: 'The Issuer may terminate the Products on 30 days notice.',
                url: 'https://gamma.com/terms.pdf',
                accessedAt: '2026-09-18T00:00:00Z'
            },
            {
                mode: 'court-order',
                status: 'litigated',
                url: 'https://gamma.com/notice',
                cases: [
                    { name: 'A v. B', url: 'https://www.courtlistener.com/docket/1/a-v-b/' },
                    { name: 'C v. D', url: 'https://www.sec.gov/litigation/litreleases/lr-1.htm' }
                ],
                searched: ['https://gamma.com/faq'],
                accessedAt: '2026-09-18T00:00:00Z'
            }
        ]
    };
    const { items } = buildRegistry([{ slug: 'gamma', doc }], { generatedAt: RUN });
    const at = (url) => items.find((i) => i.url === url);

    test('a whatIf[].url enters the registry, labelled by its failure mode', () => {
        expect(at('https://gamma.com/terms.pdf').foundIn).toEqual(['gamma:whatIf[issuer-wind-down]']);
        expect(at('https://gamma.com/notice').foundIn).toEqual(['gamma:whatIf[court-order]']);
    });

    test('every whatIf[].cases[].url enters the registry too, with its case index', () => {
        expect(at('https://www.courtlistener.com/docket/1/a-v-b/').foundIn)
            .toEqual(['gamma:whatIf[court-order].cases[0]']);
        expect(at('https://www.sec.gov/litigation/litreleases/lr-1.htm').foundIn)
            .toEqual(['gamma:whatIf[court-order].cases[1]']);
    });

    test('a searched[] URL is recorded as well — an `unknown` says where we looked', () => {
        expect(at('https://gamma.com/faq').foundIn).toEqual(['gamma:whatIf[court-order].searched[0]']);
    });

    test('the kind still comes from the extension, so a cited PDF is fetched as one', () => {
        expect(at('https://gamma.com/terms.pdf').kind).toBe('pdf');
        expect(at('https://gamma.com/notice').kind).toBe('html');
    });

    test('inserting an answer above does NOT change any label — that is the point of the mode id', () => {
        const shifted = { whatIf: [{ mode: 'sanctioned', status: 'unknown', searched: ['https://gamma.com/x'] }, ...doc.whatIf] };
        const after = buildRegistry([{ slug: 'gamma', doc: shifted }], { generatedAt: RUN });
        expect(after.items.find((i) => i.url === 'https://gamma.com/terms.pdf').foundIn)
            .toEqual(['gamma:whatIf[issuer-wind-down]']);
    });

    test('labelPath leaves every other path alone, and keeps the index when there is no mode', () => {
        expect(labelPath(doc, 'documents[3].url')).toBe('documents[3].url');
        expect(labelPath(doc, 'redemption.fees')).toBe('redemption.fees');
        expect(labelPath({ whatIf: [{}] }, 'whatIf[0].url')).toBe('whatIf[0]');
        expect(labelPath({}, 'whatIf[0].cases[2].url')).toBe('whatIf[0].cases[2]');
    });
});

describe('against a real dossier', () => {
    // The extraction has to work on the actual shape of the files, not only on a fixture: this is
    // the file whose URLs the watcher will fetch.
    const doc = JSON.parse(readFileSync(new URL('./data/issuers/prestocks.json', import.meta.url), 'utf8'));

    test('picks up the ToS as a document and the RPC endpoint out of prose', () => {
        const { items } = buildRegistry([{ slug: 'prestocks', doc }], { generatedAt: RUN });
        const tos = items.find((i) => i.url === 'https://url.prestocks.com/terms-of-service');
        expect(tos).toBeDefined();
        expect(tos.kind).toBe('html');
        expect(tos.title).toMatch(/Terms of Service/);
        // Cited by documents[], findings[] and attestations[] — all of them are recorded.
        expect(tos.foundIn.length).toBeGreaterThan(3);
        // `sources[6]` is `https://api.mainnet-beta.solana.com (getAccountInfo …)`: prose.
        expect(items.map((i) => i.url)).toContain('https://api.mainnet-beta.solana.com/');
        expect(items.find((i) => i.url === 'https://prestocks.com/api/prestocks').kind).toBe('api');
    });
});
