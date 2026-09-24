// Unit tests for stocks/lib/watch.mjs — every decision the document watcher makes without a
// network: what text gets hashed, what an HTTP result means, how severe a change is, and what SQL
// a run writes. The normalisation tests run against two REAL sources cited by the dossiers, saved
// once under stocks/fixtures/sources/:
//
//   backed-fi-legal-documentation.html          https://assets.backed.fi/legal-documentation
//   shift-dao-series-17-spx3l-pages-1-2.pdf     pages 1-2 of the Shift DAO Series 17 operating
//                                               agreement (pdfseparate + pdfunite from the
//                                               gitbook PDF the shift dossier cites)
//   …pages-1-2.pdftotext.txt                    that PDF through `pdftotext -layout`, which is
//                                               what the watcher feeds the normaliser. Kept beside
//                                               the PDF so these tests need no poppler binary and
//                                               stay fast; regenerate with
//                                               `pdftotext -layout <pdf> <txt>`.
//
// A synthetic fixture cannot show whether the normaliser survives a real page's chrome, and that
// is the whole risk here: a normaliser that lets one churning line through reports a change every
// single day, and one that strips too much hides the clause that changed.

import { readFileSync } from 'node:fs';

import { kindFromContentType } from './lib/sources.mjs';
import {
    KEYWORDS, binaryMarker, blockVendor, buildChangeEventSql, buildSourceSql, buildVersionSql,
    DEFAULT_USER_AGENT, archiveRefusal, conditionalHeaders, isJsOnlyRead, buildClaimCheckSql, challengeInBody, checkQuotes, decideOutcome,
    driveDownloadUrl, dropboxDownloadUrl, fileStamp, htmlToText, isTextual, looksLikePdf,
    jsOnlyShell, jsonToText, looksLikeChurn, normaliseByKind, normaliseLines, parseArchiveLocation,
    pdfTextToText, rawExtension, reusableCheckpoint, runFailed, severityForChange, sha256Hex, sourceId,
    sourceWatchStatsFileName, stripPublisherChrome, publisherNormalizerVersion, tolerates503,
    verificationUrlFor,
    dossierQuotes,
    previouslyBlocked,
    apiAnswerIsDocument,
    userAgentFor,
    parseSpnStatus, quoteFound, quoteFragments, quoteKey, spnBusy, spnTransient,
    archivableUrl, archiveMissingTargets, buildArchiveUrlSql, captureIsRecent, spnAlreadyCaptured,
    READ_VIA, htmlDocumentText, isTickerLine, quoteVerdicts, readProvenance, storedReading, substantiveChanges
} from './lib/watch.mjs';
import { diffLines } from './lib/textdiff.mjs';

const FIXTURES = new URL('./fixtures/sources/', import.meta.url);
const REAL_HTML = readFileSync(new URL('backed-fi-legal-documentation.html', FIXTURES), 'utf8');
const REAL_PDF_TEXT = readFileSync(new URL('shift-dao-series-17-spx3l-pages-1-2.pdftotext.txt', FIXTURES), 'utf8');
const DDL = readFileSync(new URL('../db/2026-09-18-sonar-evidence.sql', import.meta.url), 'utf8');
const PROVENANCE_DDL = readFileSync(new URL('../db/2026-09-23-sonar-source-provenance.sql', import.meta.url), 'utf8');
// app.ventuals.com/sunset as the watcher stored it on 2026-09-17: a client-rendered Next.js page
// whose served HTML normalises to the single word "Ventuals"; the letter renders only in a browser.
const VENTUALS_SUNSET = readFileSync(new URL('ventuals-app-sunset-2026-09-17.html', FIXTURES), 'utf8');

describe('identity and paths', () => {
    test('a source id is the first 12 hex of sha256(url) and never moves', () => {
        const id = sourceId('https://assets.backed.fi/legal-documentation');
        expect(id).toMatch(/^[0-9a-f]{12}$/);
        expect(sourceId('https://assets.backed.fi/legal-documentation')).toBe(id);
        expect(sourceId('https://assets.backed.fi/legal-documentation/')).not.toBe(id);
        expect(() => sourceId('')).toThrow();
    });

    test('a fetch timestamp becomes a filename without losing the instant', () => {
        expect(fileStamp('2026-09-17T15:06:09Z')).toBe('2026-09-17T15-06-09Z');
    });

    test('the raw copy gets the extension of what was served', () => {
        expect([rawExtension('pdf'), rawExtension('api'), rawExtension('html')])
            .toEqual(['pdf', 'json', 'html']);
    });

    test('only a full registry run owns the canonical collector heartbeat', () => {
        expect(sourceWatchStatsFileName()).toBe('.last-source-watch-stats.json');
        expect(sourceWatchStatsFileName({ only: 'Ondo Global Markets' }))
            .toBe('.last-source-watch-stats-ondo-global-markets.json');
        expect(sourceWatchStatsFileName({ limit: 5 })).toBe('.last-source-watch-stats-limit-5.json');
        expect(sourceWatchStatsFileName({ onlyBlocked: true })).toBe('.last-source-watch-stats-only-blocked.json');
        expect(sourceWatchStatsFileName({ onlyBlocked: true, only: 'tessera' })).toBe('.last-source-watch-stats-only-blocked-tessera.json');
    });

    test('--only-blocked picks the sources the live host did not give us last time', () => {
        const sources = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => ({ url: `https://x.example/${k}` }));
        const state = {
            'https://x.example/a': { status: 'blocked' },
            'https://x.example/b': { status: 'ok', via: 'wayback' },
            'https://x.example/c': { status: 'ok', via: 'html' },
            'https://x.example/d': { status: 'ok', via: 'api', companionUrl: 'https://registry.example/d' },
            'https://x.example/e': { status: 'gone' }
            // f: never seen — not "previously blocked"
        };
        expect(previouslyBlocked(sources, state).map((s) => s.url.slice(-1))).toEqual(['a', 'b', 'd']);
        expect(previouslyBlocked(sources, {})).toEqual([]);
    });

    test('publisher live sidebars cannot masquerade as changes to cited articles', () => {
        const coindesk = 'Headline\nThe cited article remains here.\nLatest Crypto News\n1 Live market story 2 hours ago\nBTC $86,000';
        expect(stripPublisherChrome('https://www.coindesk.com/policy/story', coindesk))
            .toBe('Headline\nThe cited article remains here.');
        const tekedia = 'Headline\nThe cited article remains here.\nProducts\nCourse A\n$400';
        expect(stripPublisherChrome('https://www.tekedia.com/story', tekedia))
            .toBe('Headline\nThe cited article remains here.');
        expect(stripPublisherChrome('https://www.cryptotimes.io/story',
            'Headline\nArticle.\nCrypto Connections\nLatest rotating story'))
            .toBe('Headline\nArticle.');
        expect(stripPublisherChrome('https://issuer.example/legal', coindesk)).toBe(coindesk);
        expect(publisherNormalizerVersion('https://www.coindesk.com/policy/story')).toBe(3);
        expect(publisherNormalizerVersion('https://issuer.example/legal')).toBe(2);
    });

    test('the Next.js flight reader is a new HTML extraction generation; PDF and JSON stay at 1', () => {
        // Generation 2 drops the stored etag once, so a page stored as a bare title (ventuals.com
        // answered 304 to it every day) is actually read again with the flight reader.
        expect(publisherNormalizerVersion('https://ventuals.com/terms', 'html')).toBe(2);
        expect(publisherNormalizerVersion('https://issuer.example/prospectus.pdf', 'pdf')).toBe(1);
        expect(publisherNormalizerVersion('https://api.example/v1/x', 'api')).toBe(1);
        expect(publisherNormalizerVersion('https://www.coindesk.com/x', 'pdf')).toBe(2);
    });
});

describe('restart checkpoints', () => {
    test('reuses completed findings but retries transient errors on the same UTC day', () => {
        for (const status of ['ok', 'changed', 'blocked', 'gone']) {
            expect(reusableCheckpoint({ status })).toBe(true);
        }
        expect(reusableCheckpoint({ status: 'error' })).toBe(false);
        expect(reusableCheckpoint(null)).toBe(false);
    });
});

describe('churn lines', () => {
    test('a bare date, time, relative time or counter is churn', () => {
        for (const line of ['2026-09-17', '2026-09-17T15:06:09Z', '17/09/2026', 'Sep 17, 2026',
            '15:06', '3:06 pm', '2 hours ago', 'just now', '1,204 views', '(12)', 'Loading…',
            'Skip to main content', 'Back to top']) {
            expect(looksLikeChurn(line)).toBe(true);
        }
    });

    test('a LABELLED date is not churn — on a terms page it is the most informative line there', () => {
        expect(looksLikeChurn('Last updated 2026-09-08')).toBe(false);
        expect(looksLikeChurn('Effective as of 17 September 2026')).toBe(false);
    });

    test('a cookie banner is churn, a clause that merely mentions cookies is not', () => {
        expect(looksLikeChurn('We use cookies to improve your experience. Accept all')).toBe(true);
        const clause = 'You agree that the Issuer may amend these Terms at any time and that your '
            + 'continued use constitutes consent to the amended Terms, including any change to the '
            + 'redemption fee, the custodian, or the governing law of this agreement, and that no '
            + 'separate notice of such amendment need be given to you in any form whatsoever.';
        expect(clause.length).toBeGreaterThan(300);
        expect(looksLikeChurn(clause)).toBe(false);
    });

    test('a bare Solana address is NOT churn — an authority key in a document is the signal', () => {
        expect(looksLikeChurn('WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc')).toBe(false);
    });

    test('a bare price or percentage is a ticker widget in HTML and a fee table in a PDF', () => {
        for (const line of ['$76,336.00', '-0.79%', '2,451.08', '0.50%']) {
            expect(looksLikeChurn(line, { htmlWidgets: true })).toBe(true);
            // The same line in PDF text is a fee-table cell and must survive.
            expect(looksLikeChurn(line)).toBe(false);
        }
        // A number with words around it is content in both.
        expect(looksLikeChurn('Redemption fee: 0.50%', { htmlWidgets: true })).toBe(false);
    });

    test('the price ticker above a news article does not make the article look changed', () => {
        const page = (btc) => `<main><div>BTC</div><div>$${btc}</div>`
            + '<article><p>Securitize begins trading on the NYSE.</p></article></main>';
        expect(sha256Hex(htmlToText(page('76,260.00')))).toBe(sha256Hex(htmlToText(page('76,336.00'))));
        expect(htmlToText(page('76,260.00'))).toMatch(/Securitize begins trading/);
    });

    test('whitespace inside a line is collapsed and empty lines vanish', () => {
        expect(normaliseLines('a  \t b\n\n\n  c  ')).toBe('a b\nc');
    });
});

describe('HTML normalisation, on the real Backed legal-documentation page', () => {
    const text = htmlToText(REAL_HTML);

    test('keeps the document text and drops the markup', () => {
        expect(text.length).toBeGreaterThan(2000);
        expect(text).toMatch(/Legal Documentation/i);
        expect(text).not.toMatch(/<\/?(div|script|style|nav|svg)\b/i);
        expect(text).not.toMatch(/&(amp|nbsp|quot|#\d+);/);
    });

    test('is stable: the same bytes hash to the same text twice over', () => {
        expect(sha256Hex(htmlToText(REAL_HTML))).toBe(sha256Hex(text));
    });

    test('leaves no bare date or timestamp line behind to churn tomorrow', () => {
        const churny = text.split('\n').filter((line) => looksLikeChurn(line));
        expect(churny).toEqual([]);
    });

    test('a page whose only change is a counter hashes identically', () => {
        const before = htmlToText('<main><p>Redemption fee: 0 bps</p><footer><span>1,204 views</span></footer></main>');
        const after = htmlToText('<main><p>Redemption fee: 0 bps</p><footer><span>1,207 views</span></footer></main>');
        expect(sha256Hex(after)).toBe(sha256Hex(before));
    });

    test('script and style bodies never reach the text', () => {
        const html = '<html><head><style>.a{color:red}</style><script>var fee = "0 bps";</script></head>'
            + '<body><nav>Home Docs</nav><p>Governing law: Switzerland</p></body></html>';
        const out = htmlToText(html);
        expect(out).toBe('Governing law: Switzerland');
    });
});

describe('PDF normalisation, on the real Shift DAO series agreement', () => {
    const text = pdfTextToText(REAL_PDF_TEXT);

    test('keeps the operating agreement text and the layout padding is collapsed', () => {
        expect(text).toMatch(/SERIES OPERATING AGREEMENT/);
        expect(text).toMatch(/SHIFT DAO LLC/);
        expect(text).toMatch(/NOTICE OF RESTRICTIONS ON DUTIES AND TRANSFERS/);
        expect(text).not.toMatch(/ {2}/);
        expect(text).not.toMatch(/\f/);
        expect(text.length).toBeGreaterThan(3000);
    });

    test('normaliseByKind routes pdf text through the same path', () => {
        expect(normaliseByKind('pdf', REAL_PDF_TEXT)).toBe(text);
    });

    test('is stable across two normalisations of the same extract', () => {
        expect(sha256Hex(pdfTextToText(REAL_PDF_TEXT))).toBe(sha256Hex(text));
    });
});

describe('JSON normalisation', () => {
    test('a shuffled key order is not a change', () => {
        const a = '{"symbol":"OPENAI","name":"OpenAI PreStocks","terms":"https://x/t"}';
        const b = '{"name":"OpenAI PreStocks","terms":"https://x/t","symbol":"OPENAI"}';
        expect(sha256Hex(jsonToText(a))).toBe(sha256Hex(jsonToText(b)));
    });

    test('a changed value IS a change', () => {
        const a = '{"transferFeeBps":0}';
        const b = '{"transferFeeBps":50}';
        expect(sha256Hex(jsonToText(a))).not.toBe(sha256Hex(jsonToText(b)));
    });

    test('a body that claims to be JSON but is not falls back to text', () => {
        expect(jsonToText('<html>error</html>')).toBe('<html>error</html>');
    });
});

describe('binary payloads', () => {
    test('a zip or image is watched as bytes, not decoded as text', () => {
        const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0xfe]);
        const marker = binaryMarker(bytes, 'application/zip; charset=binary');
        expect(marker).toMatch(/^binary application\/zip 7 bytes sha256:[0-9a-f]{64}$/);
        expect(binaryMarker(bytes, 'application/zip')).toBe(binaryMarker(Buffer.from(bytes), 'application/zip'));
        expect(binaryMarker(Buffer.from([0x50, 0x4b, 0x03, 0x05]), 'application/zip')).not.toBe(marker);
    });

    test('isTextual knows what can become text', () => {
        expect(isTextual('text/html; charset=utf-8')).toBe(true);
        expect(isTextual('application/json')).toBe(true);
        expect(isTextual('application/xml')).toBe(true);
        expect(isTextual('application/zip')).toBe(false);
        expect(isTextual('image/png')).toBe(false);
        expect(isTextual(undefined)).toBe(false);
    });
});

describe('bot walls and javascript-only pages', () => {
    test('a Cloudflare HEADER on a good 200 is not a block — this was a real false positive', () => {
        const headers = { server: 'cloudflare', 'cf-ray': '9abc-FRA', 'content-type': 'text/html' };
        expect(challengeInBody('<html><body><h1>Terms of Service</h1></body></html>')).toBe(false);
        expect(blockVendor(headers)).toBe('cloudflare');
        // Vendor alone must never produce `blocked` on a 2xx.
        expect(decideOutcome({ httpStatus: 200, vendor: 'cloudflare', sameHash: false }).status).toBe('changed');
    });

    test('a challenge in the BODY is a block', () => {
        expect(challengeInBody('<title>Just a moment...</title>')).toBe(true);
        expect(challengeInBody('Attention Required! | Cloudflare')).toBe(true);
        expect(decideOutcome({ httpStatus: 200, blocked: true }).status).toBe('blocked');
    });

    test('a Notion-style shell needs both no text and the noscript notice', () => {
        const raw = '<html><body><div id="root"></div>'
            + '<noscript>You need to enable JavaScript to run this app.</noscript></body></html>';
        expect(jsOnlyShell('Notion', raw)).toBe(true);
        // A page that carries the notice AND serves its text is readable, so not blocked.
        expect(jsOnlyShell('x'.repeat(900), raw)).toBe(false);
        // A genuinely short but readable document (a sitemap) is not a shell.
        expect(jsOnlyShell('https://prestocks.com/\nhttps://prestocks.com/products', '<urlset/>')).toBe(false);
    });
});

describe('per-host User-Agent', () => {
    test('the SEC gets a UA that declares who is asking, as its access policy requires', () => {
        const ua = 'rwa-sonar source-watch contact@rwasonar.com';
        for (const host of ['www.sec.gov', 'data.sec.gov', 'efts.sec.gov',
            'api.adviserinfo.sec.gov', 'sec.gov']) {
            expect(userAgentFor(host)).toBe(ua);
        }
    });

    test('everyone else gets the browser string, which is what keeps bot walls down', () => {
        expect(userAgentFor('docs.ondo.finance')).toBe(DEFAULT_USER_AGENT);
        expect(userAgentFor('notsec.gov.example.com')).toBe(DEFAULT_USER_AGENT);
        // A host that merely CONTAINS the suffix is not a subdomain of it.
        expect(userAgentFor('fakesec.gov')).toBe(DEFAULT_USER_AGENT);
        expect(userAgentFor(null)).toBe(DEFAULT_USER_AGENT);
    });
});

describe('explicit quote verification companions', () => {
    const claim = { url: 'https://issuer.example/faq', quote: 'Exact words' };
    test('keeps the citation unless the dossier names an exact official companion', () => {
        expect(verificationUrlFor(claim, {})).toBe(claim.url);
        expect(verificationUrlFor(claim, { quoteVerificationSources: [{
            sourceUrl: claim.url, verificationUrl: 'https://issuer.example/llms-full.txt'
        }] })).toBe('https://issuer.example/llms-full.txt');
    });
    test('does not fall back to another issuer page merely because it may contain the same words', () => {
        expect(verificationUrlFor(claim, { quoteVerificationSources: [{
            sourceUrl: 'https://issuer.example/other', verificationUrl: 'https://issuer.example/all.txt'
        }] })).toBe(claim.url);
    });

    // A what-if answer citing a client-rendered page (the words only exist after its JavaScript
    // runs) is checked against the companion the dossier declares, exactly like a claim; before
    // 2026-09-23 only claims[] went through the mapping and such an answer read as lost.
    const dossier = {
        quoteVerificationSources: [{
            sourceUrl: 'https://app.issuer.example/sunset', verificationUrl: 'https://app.issuer.example/sunset/__data.json'
        }],
        claims: [{ field: 'status', url: 'https://app.issuer.example/sunset', quote: 'We are winding down the platform' }],
        whatIf: [
            { mode: 'issuer-wind-down', status: 'documented', url: 'https://app.issuer.example/sunset', quote: 'withdraw any remaining balance before that date' },
            { mode: 'keys-stolen', status: 'documented', url: 'https://docs.issuer.example/security', quote: 'keys are held in an HSM' },
            { mode: 'no-quote', status: 'unknown', url: 'https://app.issuer.example/sunset' }
        ]
    };
    test('what-if answers go through the same companion mapping as claims, keeping the cited URL', () => {
        const quotes = dossierQuotes('issuer', dossier);
        expect(quotes.map((q) => [q.kind, q.ref, q.url, q.citedUrl])).toEqual([
            ['claim', 'status', 'https://app.issuer.example/sunset/__data.json', 'https://app.issuer.example/sunset'],
            ['what-if', 'issuer-wind-down', 'https://app.issuer.example/sunset/__data.json', 'https://app.issuer.example/sunset'],
            ['what-if', 'keys-stolen', 'https://docs.issuer.example/security', 'https://docs.issuer.example/security']
        ]);
        expect(quotes[1].id).toBe('issuer:issuer-wind-down');
        expect(quotes[0].id).toMatch(/^issuer:status:[0-9a-f]{8}$/);
    });
    test('the companion text verifies the what-if quote the rendered-only page cannot', () => {
        const [, windDown] = dossierQuotes('issuer', dossier);
        const shell = 'Ventuals';
        const companion = jsonToText(JSON.stringify({ nodes: [{ data: { body: 'Please withdraw any remaining balance before that date.' } }] }), { keepChurn: true });
        expect(quoteFound(shell, windDown.quote)).toBe(false);
        expect(quoteFound(companion, windDown.quote)).toBe(true);
    });
});

test('a changed claim with a confirmed successor on the same field and URL is not watched again', () => {
    const url = 'https://api.router.example/quote?mint=A';
    const dossier = { claims: [
        { field: 'redemption.eligibility', url, quote: '{"errorCode":"NO_ROUTES_FOUND"}', status: 'changed' },
        { field: 'redemption.eligibility', url, quote: '{"errorCode":"TOKEN_NOT_TRADABLE"}', status: 'confirmed' },
        { field: 'pricing.notes', url, quote: 'old price text', status: 'changed' }
    ] };
    expect(dossierQuotes('issuer', dossier).map((q) => q.quote)).toEqual([
        '{"errorCode":"TOKEN_NOT_TRADABLE"}',
        // No successor for this field: the lost quote stays watched and keeps being reported.
        'old price text'
    ]);
});

test('quote matching compares visible words across XML and Markdown representations', () => {
    expect(quoteFound('RepublicX LLC', '<entityName>RepublicX LLC</entityName>')).toBe(true);
    expect(quoteFound('The minimum is just $1.00 USD.', 'The minimum is just \\$1.00 USD.')).toBe(true);
    expect(quoteFound('Purchased with USDon, our native stablecoin.',
        'Purchased with [USDon](/ondo-stocks/available-assets), our **native** stablecoin.')).toBe(true);
});

describe('decideOutcome', () => {
    test('200 with the same hash is ok, with a new hash is changed, 304 is ok', () => {
        expect(decideOutcome({ httpStatus: 200, sameHash: true })).toEqual({ status: 'ok', reason: 'same hash' });
        expect(decideOutcome({ httpStatus: 200, sameHash: false })).toEqual({ status: 'changed', reason: 'new hash' });
        expect(decideOutcome({ httpStatus: 304 }).status).toBe('ok');
    });

    test('404, 410 and a host that stopped resolving are gone', () => {
        expect(decideOutcome({ httpStatus: 404 })).toEqual({ status: 'gone', reason: 'http-404' });
        expect(decideOutcome({ httpStatus: 410 }).status).toBe('gone');
        expect(decideOutcome({ networkErrorCode: 'ENOTFOUND' }).status).toBe('gone');
    });

    test('a permanently expired certificate is a visible access block, not a broken collector', () => {
        expect(decideOutcome({ networkErrorCode: 'CERT_HAS_EXPIRED', host: 'remora.markets' }))
            .toEqual({ status: 'blocked', reason: 'tls: certificate expired' });
        expect(runFailed([{ status: 'blocked' }])).toBe(false);
    });

    test('a refusal is blocked, with the reason kept', () => {
        expect(decideOutcome({ httpStatus: 403, blocked: true }).reason).toBe('http-403 (bot wall)');
        expect(decideOutcome({ httpStatus: 403, vendor: 'akamai' }).reason).toBe('http-403 (akamai)');
        for (const code of [400, 401, 403, 405, 406, 451]) {
            expect(decideOutcome({ httpStatus: code }).status).toBe('blocked');
        }
    });

    test('a 400 from a query API is blocked, not an error that reddens every run forever', () => {
        // One source is a Sanity GROQ endpoint that answers a bare GET with "param query is
        // required". Retrying that daily never makes it a document.
        expect(decideOutcome({ httpStatus: 400 })).toEqual({ status: 'blocked', reason: 'http-400' });
        expect(runFailed([{ status: 'blocked' }])).toBe(false);
    });

    test('a challenge page served as 429 is a bot wall at once, not a rate limit to wait out', () => {
        const vercel = '<!DOCTYPE html><html><head><title>Vercel Security Checkpoint</title></head>';
        expect(challengeInBody(vercel)).toBe(true);
        expect(decideOutcome({ httpStatus: 429, blocked: true })).toEqual({ status: 'blocked', reason: 'http-429 (bot wall)' });
    });

    test('an exact API query answering 400 JSON is read as the cited response', () => {
        const url = 'https://lite-api.jup.ag/swap/v1/quote?inputMint=FJug&outputMint=EPjF&amount=1000000000';
        expect(apiAnswerIsDocument({ httpStatus: 400, contentType: 'application/json; charset=utf-8', url })).toBe(true);
        expect(apiAnswerIsDocument({ httpStatus: 422, contentType: 'application/json', url })).toBe(true);
        // A bare route's "missing parameter", an HTML error page and a 403/404 are not evidence.
        expect(apiAnswerIsDocument({ httpStatus: 400, contentType: 'application/json', url: 'https://lite-api.jup.ag/swap/v1/quote' })).toBe(false);
        expect(apiAnswerIsDocument({ httpStatus: 400, contentType: 'text/html', url })).toBe(false);
        expect(apiAnswerIsDocument({ httpStatus: 403, contentType: 'application/json', url })).toBe(false);
        expect(apiAnswerIsDocument({ httpStatus: 404, contentType: 'application/json', url })).toBe(false);
        expect(decideOutcome({ httpStatus: 400, apiAnswer: true, sameHash: false }).status).toBe('changed');
        expect(decideOutcome({ httpStatus: 400, apiAnswer: true, sameHash: true }))
            .toEqual({ status: 'ok', reason: 'same hash (http-400 JSON answer is the cited response)' });
        expect(decideOutcome({ httpStatus: 400 }).status).toBe('blocked');
        // The quoted words are checked against that answer like any JSON document.
        const answer = jsonToText('{"error":"The token FJug3z58gssSTDhVNkTse5fP8GRZzuidf9SRtfB2RhDe is not tradable","errorCode":"TOKEN_NOT_TRADABLE"}', { keepChurn: true });
        expect(quoteFound(answer, '{"error":"The token FJug3z58gssSTDhVNkTse5fP8GRZzuidf9SRtfB2RhDe is not tradable","errorCode":"TOKEN_NOT_TRADABLE"}')).toBe(true);
    });

    test('a 429 is an error until it has been backed off, then it is blocked', () => {
        expect(decideOutcome({ httpStatus: 429 }).status).toBe('error');
        expect(decideOutcome({ httpStatus: 429, retriedAfterBackoff: true })).toEqual({
            status: 'blocked', reason: 'http-429 after backoff'
        });
    });

    test("archive.org's own outage is recorded, not counted as our failure", () => {
        // Its availability and CDX APIs answered 503 "temporarily offline" on 2026-09-17, and six
        // dossier URLs point at web.archive.org. One maintenance window must not redden the run.
        expect(tolerates503('web.archive.org')).toBe(true);
        expect(tolerates503('archive.org')).toBe(true);
        expect(tolerates503('docs.ondo.finance')).toBe(false);
        expect(decideOutcome({ httpStatus: 503, retriedAfterBackoff: true, host: 'web.archive.org' }))
            .toEqual({ status: 'blocked', reason: 'http-503 after backoff (host temporarily unavailable)' });
        // Any other host's 503 is still a failure the run must report.
        expect(decideOutcome({ httpStatus: 503, retriedAfterBackoff: true, host: 'docs.ondo.finance' }).status)
            .toBe('error');
        // And a first 503 from the tolerated host, before any backoff, is not yet written off.
        expect(decideOutcome({ httpStatus: 503, host: 'web.archive.org' }).status).toBe('error');
        expect(decideOutcome({ networkErrorCode: 'ETIMEDOUT', retriedAfterBackoff: true, host: 'web.archive.org' }))
            .toEqual({ status: 'blocked', reason: 'network timeout after backoff (host temporarily unavailable)' });
    });

    test('a Save Page Now outage reads as archive-unavailable, not as a per-source failure', () => {
        expect(archiveRefusal(503)).toMatch(/^archive-unavailable: save-page-now is temporarily offline/);
        expect(archiveRefusal(502)).toMatch(/archive-unavailable/);
    });

    test('5xx, a timeout and no response at all are errors', () => {
        expect(decideOutcome({ httpStatus: 503 }).status).toBe('error');
        expect(decideOutcome({ networkErrorCode: 'ETIMEDOUT' })).toEqual({ status: 'error', reason: 'network: ETIMEDOUT' });
        expect(decideOutcome({}).status).toBe('error');
    });

    test('only an error fails the run — a dead citation and a hostile host do not', () => {
        expect(runFailed([{ status: 'gone' }, { status: 'blocked' }, { status: 'ok' }])).toBe(false);
        expect(runFailed([{ status: 'ok' }, { status: 'error' }])).toBe(true);
    });
});

describe('severity from the EVIDENCE.md §2.3 keyword list', () => {
    test('a changed line carrying a keyword is caution and names the keywords', () => {
        const out = severityForChange({
            kind: 'html',
            changedLines: ['The redemption fee may be raised without notice.', 'Unrelated wording.']
        });
        expect(out.severity).toBe('caution');
        expect(out.method).toBe('keyword');
        expect(out.keywords).toEqual(['fee', 'redemption']);
    });

    test('a change with no keyword is info', () => {
        const out = severityForChange({ kind: 'html', changedLines: ['Our office has moved to Zug.'] });
        expect(out).toEqual({ severity: 'info', method: 'none', keywords: [], capped: false });
    });

    test('word boundaries: a camelCase JSON field is not the word "fee"', () => {
        expect(severityForChange({ kind: 'html', changedLines: ['"transferFeeBps": 50'] }).severity).toBe('info');
        expect(severityForChange({ kind: 'html', changedLines: ['Fee Schedule updated'] }).severity).toBe('caution');
    });

    test('an api source is capped at info: a price endpoint moves by design', () => {
        const out = severityForChange({ kind: 'api', changedLines: ['"custodian": "Anchorage"'] });
        expect(out).toEqual({ severity: 'info', method: 'none', keywords: [], capped: true });
    });

    test('every §2.3 keyword is covered', () => {
        expect(KEYWORDS.map(([name]) => name)).toEqual([
            'redemption', 'fee', 'custody', 'custodian', 'jurisdiction', 'governing law', 'freeze',
            'pause', 'clawback', 'burn', 'delegate', 'authority', 'terminate', 'suspend',
            'eligibility', 'lock-up', 'dividend'
        ]);
    });

    test('on real document text: the clauses that carry keywords score caution', () => {
        const lines = pdfTextToText(REAL_PDF_TEXT).split('\n');
        // Two real lines of the Shift DAO Series 17 agreement, one per keyword it contains.
        const authority = lines.find((l) => /discretionary authority/i.test(l));
        const termination = lines.find((l) => /dissolution and termination/i.test(l));
        expect([authority, termination].every(Boolean)).toBe(true);
        const out = severityForChange({ kind: 'pdf', changedLines: [authority, termination] });
        expect(out.severity).toBe('caution');
        expect(out.keywords).toEqual(['authority', 'terminate']);
        // And a line of the same document with no keyword on it stays info.
        const plain = lines.find((l) => /Republic of the Marshall Islands/i.test(l));
        expect(severityForChange({ kind: 'pdf', changedLines: [plain] }).severity).toBe('info');
    });
});

describe('Wayback locations', () => {
    test('a relative Content-Location becomes the archived URL', () => {
        expect(parseArchiveLocation('/web/20260917150655/https://a.com/x'))
            .toBe('https://web.archive.org/web/20260917150655/https://a.com/x');
    });

    test('an absolute location passes through and the final URL is the fallback', () => {
        expect(parseArchiveLocation('https://web.archive.org/web/2026/https://a.com/x'))
            .toBe('https://web.archive.org/web/2026/https://a.com/x');
        expect(parseArchiveLocation(null, 'https://web.archive.org/web/20260917/https://a.com/x'))
            .toBe('https://web.archive.org/web/20260917/https://a.com/x');
    });

    test('an anonymous save refused with a 500 says so, and why', () => {
        // Measured 2026-09-17 and reproduced with curl: SPN answers an anonymous save with 500 and
        // its own form. The log line has to name the cause, or the next reader debugs our client.
        expect(archiveRefusal(500)).toMatch(/anonymous save \(http 500\).*account key/);
        expect(archiveRefusal(429)).toMatch(/rate limit/);
        expect(archiveRefusal(404)).toBe('save-page-now http 404');
    });

    test('a save that archived nothing yields null, never a guessed URL', () => {
        expect(parseArchiveLocation(null, 'https://web.archive.org/save/https://a.com/x')).toBeNull();
        expect(parseArchiveLocation('', null)).toBeNull();
    });
});

describe('SQL', () => {
    const source = {
        id: 'abc123456789',
        url: 'https://a.com/terms',
        kind: 'html',
        title: 'Terms',
        issuer: 'alpha',
        foundIn: ['alpha:documents[0].url'],
        firstSeenAt: '2026-09-17T15:00:00Z',
        lastCheckedAt: '2026-09-17T15:00:00Z',
        lastChangedAt: '2026-09-17T15:00:00Z',
        checkEvery: '1 day',
        archiveUrl: null,
        status: 'changed',
        contentHash: 'f'.repeat(64),
        httpStatus: 200,
        error: null
    };

    test('the source upsert never rewrites first_seen_at or url', () => {
        const { sql, rows } = buildSourceSql([source]);
        expect(rows).toBe(1);
        expect(sql).toContain('INSERT INTO sonar.source');
        expect(sql).toContain('ON CONFLICT (id) DO UPDATE SET');
        expect(sql).not.toMatch(/first_seen_at = EXCLUDED/);
        expect(sql).not.toMatch(/\burl = EXCLUDED/);
        expect(sql).toMatch(/last_checked_at = EXCLUDED\.last_checked_at/);
    });

    test('an unchanged row is not even touched: every updated column is in the guard', () => {
        const { sql } = buildSourceSql([source]);
        for (const column of ['status', 'content_hash', 'last_checked_at', 'archive_url', 'error']) {
            expect(sql).toContain(`tgt.${column} IS DISTINCT FROM EXCLUDED.${column}`);
        }
    });

    test('the same id twice in one run inserts once', () => {
        const { rows, sql } = buildSourceSql([source, { ...source, status: 'ok' }]);
        expect(rows).toBe(1);
        expect(sql).toContain("DISTINCT ON (x.r->>'id')");
    });

    test('a version is keyed on (source_id, fetched_at) so a re-load writes nothing new', () => {
        const { sql, rows } = buildVersionSql([{
            sourceId: source.id, fetchedAt: '2026-09-17T15:00:00Z', contentHash: 'a'.repeat(64),
            bytes: 41419, textChars: 7126, textPath: 'stocks/data/sources/abc/x.txt',
            rawPath: 'stocks/data/sources/abc/x.html', diffSummary: '+1 -1 line(s)',
            diffSeverity: 'caution', diffMethod: 'keyword', diffAdded: 1, diffRemoved: 1
        }]);
        expect(rows).toBe(1);
        expect(sql).toContain('ON CONFLICT (source_id, fetched_at) DO UPDATE SET');
        expect(sql).toContain('diff_severity');
    });

    test('a change event is inserted only when the same event is not already there', () => {
        const { sql } = buildChangeEventSql([{
            detectedAt: '2026-09-17T15:00:00Z', kind: 'legal-term', subjectType: 'source',
            subjectId: source.id, field: null, before: 'a', after: 'b', severity: 'caution',
            summary: 'Terms changed', evidence: { url: source.url }
        }]);
        expect(sql).toContain('INSERT INTO sonar.change_event');
        expect(sql).toContain('WHERE NOT EXISTS (');
        expect(sql).toContain("coalesce(e.field, '') = coalesce(r->>'field', '')");
    });

    test('a document whose own bytes contain the dollar tag cannot break out of the literal', () => {
        const nasty = { ...source, title: 'weird $sonar$ title' };
        const { sql } = buildSourceSql([nasty]);
        expect(sql).toContain('$sonar1$');
        expect(sql.split('$sonar1$').length).toBe(3);
    });

    test('an empty run still renders valid SQL that writes nothing', () => {
        expect(buildSourceSql([]).rows).toBe(0);
        expect(buildVersionSql([]).sql).toContain('INSERT INTO sonar.source_version');
        expect(buildChangeEventSql([]).rows).toBe(0);
    });
});

describe('the code and the DDL agree', () => {
    // A value the watcher can write that the check constraint forbids is a run that dies at the
    // load step, hours after the fetching. Cross-check the two lists instead of hoping.
    test('every status and kind the watcher can produce is allowed by sonar.source', () => {
        for (const status of ['new', 'ok', 'changed', 'gone', 'blocked', 'error']) {
            expect(DDL).toMatch(new RegExp(`'${status}'`));
        }
        for (const kind of ['pdf', 'html', 'api', 'onchain']) expect(DDL).toMatch(new RegExp(`'${kind}'`));
    });

    test('every change kind and severity the watcher can produce is allowed', () => {
        for (const kind of ['legal-term', 'document-gone']) expect(DDL).toContain(`'${kind}'`);
        for (const severity of ['info', 'caution', 'warning', 'critical']) {
            expect(DDL).toContain(`'${severity}'`);
        }
        expect(DDL).toContain("subject_type IN ('issuer', 'token', 'source')");
    });

    test('the diff methods the version row can carry are allowed', () => {
        for (const method of ['none', 'keyword']) expect(DDL).toContain(`'${method}'`);
        // Named in the constraint for slices 2 and 5, before anything writes them.
        expect(DDL).toContain("'quote-lost'");
        expect(DDL).toContain("'llm'");
    });

    test('claim is NOT created by this slice', () => {
        expect(DDL).not.toMatch(/CREATE TABLE IF NOT EXISTS sonar\.claim/);
    });
});

describe('parseSpnStatus (authenticated Save Page Now job status)', () => {
    test('a finished capture becomes the absolute archived URL', () => {
        expect(parseSpnStatus({ status: 'success', timestamp: '20260917183012', original_url: 'https://x.test/a.pdf' }))
            .toEqual({ done: true, archiveUrl: 'https://web.archive.org/web/20260917183012/https://x.test/a.pdf', error: null });
    });
    test('pending is not done and carries no error', () => {
        expect(parseSpnStatus({ status: 'pending' })).toEqual({ done: false, archiveUrl: null, error: null });
    });
    test('an error carries the archive\'s own reason and never a URL', () => {
        const out = parseSpnStatus({ status: 'error', status_ext: 'error:blocked-url', message: 'This URL is blocked' });
        expect(out.done).toBe(true);
        expect(out.archiveUrl).toBeNull();
        expect(out.error).toMatch(/error:blocked-url/);
    });
    test('a success without a capture timestamp is an error, not a guessed URL', () => {
        expect(parseSpnStatus({ status: 'success', original_url: 'https://x.test' }).archiveUrl).toBeNull();
        expect(parseSpnStatus(null).error).toMatch(/not an object/);
    });    test('a capture of the page\'s favicon is not an archive of the page', () => {
        const job = { status: 'success', timestamp: '20260923111011', original_url: 'https://remora.markets/favicon.ico' };
        const out = parseSpnStatus(job, 'https://remora.markets/');
        expect(out.archiveUrl).toBeNull();
        expect(out.error).toMatch(/captured https:\/\/remora\.markets\/favicon\.ico instead of the page/);
        // A redirect to another page, or a requested image, is still the capture.
        expect(parseSpnStatus({ ...job, original_url: 'https://remora.markets/home' }, 'https://remora.markets/').archiveUrl)
            .toBe('https://web.archive.org/web/20260923111011/https://remora.markets/home');
        expect(parseSpnStatus({ ...job, original_url: 'https://x.test/logo.png' }, 'https://x.test/logo.png').archiveUrl).not.toBeNull();
    });
});

describe('spnBusy (Save Page Now active-session cap)', () => {
    it('recognises the cap message and nothing else', () => {
        expect(spnBusy('You have already reached the limit of active Save Page Now sessions. Please wait for a minute and then try again.')).toBe(true);
        expect(spnBusy('error:bad-request: The target server could not understand the request')).toBe(false);
        expect(spnBusy('Cannot resolve host alpaca.markets.')).toBe(false);
        expect(spnBusy(null)).toBe(false);
    });
});

describe('spnTransient (archive.org connection failures worth a retry)', () => {
    it('retries refused and dropped connections but not application errors', () => {
        expect(spnTransient('ECONNREFUSED')).toBe(true);
        expect(spnTransient('timeout')).toBe(true);
        expect(spnTransient('save-page-now submit: Cannot resolve host alpaca.markets.')).toBe(false);
        expect(spnTransient(null)).toBe(false);
    });
});

describe('verbatim quote check (EVIDENCE.md §2.3)', () => {
    const text = 'If a beneficiary of ledger- based securities loses access (power of dis-\nposal), such beneficiary may demand… “Realization Event” — gen- erally subject to applicable Jersey Law.';
    it('survives what pdftotext does to a document: hyphenated line breaks, typographic quotes, whitespace', () => {
        expect(quoteFound(text, 'ledger-based securities loses access (power of disposal), such beneficiary')).toBe(true);
        expect(quoteFound(text, '"Realization Event" - generally subject to applicable Jersey Law')).toBe(true);
    });
    it('a quote with an internal ellipsis is fragments in order', () => {
        expect(quoteFound(text, 'beneficiary of ledger-based … Jersey Law.')).toBe(true);
        expect(quoteFound(text, 'applicable Jersey Law … beneficiary of ledger-based')).toBe(false);
        expect(quoteFragments('…the… beneficiary of ledger-based securities')).toEqual([quoteKey('beneficiary of ledger-based securities')]);
    });
    it('a missing quote is lost; nothing checkable is null, never lost', () => {
        expect(quoteFound(text, 'the Issuer guarantees every redemption in full')).toBe(false);
        expect(quoteFound(text, 'the')).toBeNull();
        expect(quoteFound(text, null)).toBeNull();
        expect(quoteFound('', 'beneficiary of ledger-based securities')).toBe(false);
    });
    it('checkQuotes sorts a batch and counts what it skipped', () => {
        const out = checkQuotes(text, [
            { id: 'a', kind: 'claim', ref: 'x', quote: 'ledger-based securities loses access' },
            { id: 'b', kind: 'what-if', ref: 'keys-stolen', quote: 'not in the document at all, honestly' },
            { id: 'c', kind: 'claim', ref: 'y', quote: '…' }
        ]);
        expect(out.checked).toBe(2);
        expect(out.found.map((q) => q.id)).toEqual(['a']);
        expect(out.lost.map((q) => q.id)).toEqual(['b']);
        expect(out.skipped).toBe(1);
    });
    it('buildClaimCheckSql confirms found quotes, marks lost ones changed, and drops malformed rows', () => {
        const out = buildClaimCheckSql([
            { id: 'x:field:1', found: true, checkedAt: '2026-09-18T10:00:00Z' },
            { id: 'x:field:2', found: false, checkedAt: '2026-09-18T10:00:00Z' },
            { id: 'x:field:3', found: 'yes', checkedAt: '2026-09-18T10:00:00Z' }
        ]);
        expect(out.rows).toBe(2);
        expect(out.sql).toMatch(/UPDATE sonar\.claim/);
        expect(out.sql).toMatch(/THEN 'changed'/);
        expect(out.sql).toMatch(/THEN 'confirmed'/);
        expect(out.sql).not.toMatch(/x:field:3/);
    });
});

describe('quote check and JS shells, measured 2026-09-18', () => {
    it('strips real XML tags without deleting prose between fee-table comparisons', () => {
        expect(quoteFound('<name>Superstate Services LLC</name>', 'Superstate Services LLC')).toBe(true);
        const feeTable = 'Tier\n<5M\n>25M\nFor each user, there is one volume-based fee tier across all assets.';
        expect(quoteFound(feeTable, 'For each user, there is one volume-based fee tier across all assets.')).toBe(true);
    });

    it('a page number on its own line inside a sentence is not part of the quote (PDF text)', () => {
        const text = 'the Issuer holds the Underlyings held in the\n68\nmain and sub accounts at all times.';
        expect(quoteFound(text, 'the Underlyings held in the main and sub accounts at all times', { pdf: true })).toBe(true);
        expect(checkQuotes(text, [{ id: 'q', quote: 'the Underlyings held in the main and sub accounts at all times' }], { pdf: true }).found).toHaveLength(1);
        expect(quoteVerdicts({ status: 'ok', kind: 'pdf', text, quotes: [{ id: 'q', quote: 'the Underlyings held in the main and sub accounts at all times' }] }).found).toHaveLength(1);
        // but a number that is part of the words still has to be there
        expect(quoteFound('a fee of 25 basis points applies', 'a fee of 25 basis points')).toBe(true);
        expect(quoteFound('a fee of 25 basis points applies', 'a fee of 50 basis points')).toBe(false);
    });
    it('a large HTML document that renders to a cookie popup is a JavaScript-only shell', () => {
        const raw = '<html>' + '<script>x</script>'.repeat(2000) + '</html>';
        expect(jsOnlyShell('Backed\nOops! Something went wrong while submitting the form.\nClose Cookie Popup', raw)).toBe(true);
        expect(jsOnlyShell('Backed\nOops! Something went wrong while submitting the form.', '<html><p>tiny</p></html>')).toBe(false);
        expect(jsOnlyShell('A real page with plenty of readable words in it. '.repeat(20), raw)).toBe(false);
    });
});

describe('documents behind a viewer, measured 2026-09-18', () => {
    it('rewrites a Google Drive file link to its direct download and leaves everything else alone', () => {
        // The five binding Backpack Securities documents, as the dossier cites them.
        expect(driveDownloadUrl('https://drive.google.com/file/d/1Bw7oNVFsrqu8SE41-xAIJfPJnhdNnNms/view'))
            .toBe('https://drive.google.com/uc?export=download&id=1Bw7oNVFsrqu8SE41-xAIJfPJnhdNnNms');
        expect(driveDownloadUrl('https://drive.google.com/file/d/1stJoNwPAOaHDbFmL72OGSkAxyCf-_RCo/view?usp=sharing'))
            .toBe('https://drive.google.com/uc?export=download&id=1stJoNwPAOaHDbFmL72OGSkAxyCf-_RCo');
        expect(driveDownloadUrl('https://drive.google.com/open?id=15_8CjUoc8sK_IJbsZa97f5FBphjJiHI0'))
            .toBe('https://drive.google.com/uc?export=download&id=15_8CjUoc8sK_IJbsZa97f5FBphjJiHI0');
        // A folder is a listing, not a document: there is no download URL to invent for it.
        expect(driveDownloadUrl('https://drive.google.com/drive/folders/1Bw7oNVFsrqu8SE41xAIJfPJnhdNnNms')).toBeNull();
        expect(driveDownloadUrl('https://drive.google.com/file/d/short/view')).toBeNull();
        expect(driveDownloadUrl('https://assets.backed.fi/legal-documentation')).toBeNull();
        expect(driveDownloadUrl('not a url')).toBeNull();
        expect(driveDownloadUrl(null)).toBeNull();
    });

    it('fetches a Dropbox shared FILE link with dl=1, never a shared folder (its dl=1 is a zip)', () => {
        // Ankura's 2026-09-15 Ondo daily report, as the Ondo dossier cites it (measured 2026-09-24:
        // dl=0 is the JavaScript previewer, dl=1 is the PDF).
        const file = 'https://www.dropbox.com/scl/fo/jzkrw308mrhsasauqrjqq/ACPgkS13mCGLGXty4QPGcag/2026/09%20September/Daily%20Report%20-%20Ondo%20Stocks%20-%202026-09-15_20_00_ET%20-%20Ankura%20Attestation.pdf?rlkey=nik1v5slekrzx5fbi0zan5sk3&dl=0';
        expect(dropboxDownloadUrl(file)).toBe(file.replace('&dl=0', '&dl=1'));
        expect(dropboxDownloadUrl('https://www.dropbox.com/scl/fi/abc123/report.pdf?rlkey=k&dl=0'))
            .toBe('https://www.dropbox.com/scl/fi/abc123/report.pdf?rlkey=k&dl=1');
        // The folder itself and a subfolder: a listing, whose download is a zip of everything.
        expect(dropboxDownloadUrl('https://www.dropbox.com/scl/fo/jzkrw308mrhsasauqrjqq/AJxJak0F90kcwkADSN3DCD4?rlkey=nik1v5slekrzx5fbi0zan5sk3&dl=0')).toBeNull();
        expect(dropboxDownloadUrl('https://www.dropbox.com/scl/fo/jzkrw308mrhsasauqrjqq/AOWfmMwQLmV_E6BQpnV5xw8/2026/09%20September?rlkey=nik1v5slekrzx5fbi0zan5sk3&dl=0')).toBeNull();
        expect(dropboxDownloadUrl('https://drive.google.com/file/d/1Bw7oNVFsrqu8SE41-xAIJfPJnhdNnNms/view')).toBeNull();
        expect(dropboxDownloadUrl('not a url')).toBeNull();
    });

    it('trusts the bytes over a content-type that says octet-stream', () => {
        // What drive.usercontent.google.com actually answers with for all six cited files.
        expect(looksLikePdf(Buffer.from('%PDF-1.3\n%\xc4\xe5\xf2', 'latin1'))).toBe(true);
        expect(looksLikePdf(Buffer.from('<!doctype html><html>'))).toBe(false);
        expect(looksLikePdf(Buffer.alloc(0))).toBe(false);
        expect(looksLikePdf(null)).toBe(false);
        // A PDF served as octet-stream would otherwise be classified from the URL, which for a
        // `uc?export=download` link has no extension to go on — i.e. as html.
        expect(kindFromContentType('application/octet-stream',
            'https://drive.google.com/uc?export=download&id=1Bw7oNVFsrqu8SE41-xAIJfPJnhdNnNms')).toBe('html');
    });
});

describe('re-reading pages that were never actually read', () => {
    test('no conditional headers without stored text, or after an extraction upgrade', () => {
        const stored = { etag: 'W/"abc"', lastModified: 'Tue, 22 Sep 2026 10:00:00 GMT', textPath: 'stocks/data/sources/x/t.txt' };
        expect(conditionalHeaders(stored)).toEqual({ etag: 'W/"abc"', lastModified: 'Tue, 22 Sep 2026 10:00:00 GMT' });
        // securitize.io's Terms: an etag but never any text — a 304 would be `ok` over nothing.
        expect(conditionalHeaders({ etag: 'W/"abc"', lastModified: null, textPath: null })).toEqual({ etag: null, lastModified: null });
        expect(conditionalHeaders(stored, { normalizerUpgrade: true })).toEqual({ etag: null, lastModified: null });
        expect(conditionalHeaders(null)).toEqual({ etag: null, lastModified: null });
    });

    test('only an HTML read can be a JavaScript shell; bytes and Notion reads cannot', () => {
        const raw = 'x'.repeat(25_000);
        expect(isJsOnlyRead({ kind: 'html', text: 'Securitize', rawHtml: raw })).toBe(true);
        expect(isJsOnlyRead({ kind: 'html', binary: true, text: 'binary application/zip 25000 bytes sha256:ab', rawHtml: raw })).toBe(false);
        expect(isJsOnlyRead({ kind: 'html', notion: true, text: 'Notion', rawHtml: raw })).toBe(false);
        expect(isJsOnlyRead({ kind: 'pdf', text: 'x', rawHtml: raw })).toBe(false);
    });
});

describe('read provenance: read_via and capture_at', () => {
    const base = { url: 'https://republic.com/rspax', status: 'ok', httpStatus: 200, via: 'html', resolvedUrl: null };

    test('a Wayback read is `wayback` with the CDX capture time, never the fetch time', () => {
        const got = readProvenance({
            ...base, httpStatus: 403, via: 'wayback', fetchedAt: '2026-09-23T09:00:00Z',
            captureTimestamp: '2026-09-18T13:57:22Z', resolvedUrl: 'https://web.archive.org/web/20260918135722id_/https://republic.com/rspax'
        });
        expect(got).toEqual({ readVia: 'wayback', captureAt: '2026-09-18T13:57:22Z' });
        // No capture time recorded: null, not an invented one.
        expect(readProvenance({ ...base, via: 'wayback' }).captureAt).toBeNull();
    });

    test('a live read names its reader and has no capture time', () => {
        expect(readProvenance(base)).toEqual({ readVia: 'html', captureAt: null });
        expect(readProvenance({ ...base, via: 'next-flight' }).readVia).toBe('next-flight');
        expect(readProvenance({ ...base, via: 'notion' }).readVia).toBe('notion');
        const drive = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view';
        expect(readProvenance({ ...base, url: drive, via: 'pdf', resolvedUrl: 'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp' }).readVia)
            .toBe('drive');
    });

    test('a 304 keeps the reader of the text it confirmed, or says `live` when none is on record', () => {
        const notModified = { ...base, httpStatus: 304, via: null };
        expect(readProvenance(notModified, { readVia: 'next-flight' }).readVia).toBe('next-flight');
        expect(readProvenance(notModified, {}).readVia).toBe('live');
        expect(readProvenance(notModified, { readVia: 'wayback' }).readVia).toBe('live');
    });

    test('nothing read, nothing recorded: gone, blocked and error rows have no reader', () => {
        for (const status of ['gone', 'blocked', 'error']) {
            expect(readProvenance({ ...base, status, via: 'wayback', captureTimestamp: '2026-09-18T13:57:22Z' }))
                .toEqual({ readVia: null, captureAt: null });
        }
    });

    test('the source and version upserts write both columns', () => {
        const src = buildSourceSql([{ id: 'a'.repeat(12), url: base.url, kind: 'html', status: 'ok', readVia: 'wayback', captureAt: '2026-09-18T13:57:22Z' }]).sql;
        expect(src).toContain("r->>'readVia'");
        expect(src).toContain("(r->>'captureAt')::timestamptz");
        expect(src).toContain('tgt.read_via IS DISTINCT FROM EXCLUDED.read_via');
        expect(src).toContain('tgt.capture_at IS DISTINCT FROM EXCLUDED.capture_at');
        const ver = buildVersionSql([{ sourceId: 'a'.repeat(12), fetchedAt: '2026-09-23T09:00:00Z', contentHash: 'b', readVia: 'wayback', captureAt: '2026-09-18T13:57:22Z' }]).sql;
        expect(ver).toContain('read_via');
        expect(ver).toContain("(r->>'captureAt')::timestamptz");
    });

    test('every reader the code can record is one the DDL accepts, and nothing else', () => {
        for (const table of ['source_read_via_check', 'source_version_read_via_check']) {
            const at = PROVENANCE_DDL.indexOf(`CONSTRAINT ${table}`);
            const list = PROVENANCE_DDL.slice(at, PROVENANCE_DDL.indexOf(';', at)).match(/IN \(([\s\S]*?)\)\)/)[1];
            expect([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()).toEqual([...READ_VIA].sort());
        }
        expect(PROVENANCE_DDL).toMatch(/ADD COLUMN IF NOT EXISTS read_via/);
        expect(PROVENANCE_DDL).toMatch(/SET ROLE geo_user/);
    });
});

describe('quotes against a source that could not be read', () => {
    // The Ventuals `issuingEntity` claim: the names sit in a client-rendered letter.
    const ventualsQuote = [{ id: 'ventuals:issuingEntity:2f91c024', kind: 'claim', ref: 'issuingEntity', quote: 'SIGNED Alvin Hsia CEO Alvin Hsia Emily Hsia CTO Emily Hsia' }];

    test('the stored copy of app.ventuals.com/sunset is a JavaScript shell', () => {
        const reading = storedReading({ rawExt: 'html', via: 'html', payload: VENTUALS_SUNSET });
        expect(reading.text).toBe('Ventuals');
        expect(reading.jsOnly).toBe(true);
    });

    test('checked against that stub, the quote would be lost; for a blocked source it is not checkable', () => {
        const stub = storedReading({ rawExt: 'html', payload: VENTUALS_SUNSET }).quoteText;
        // What happened before: a 304 made the source `ok`, and the stub "lost" the quote.
        expect(quoteVerdicts({ status: 'ok', text: stub, quotes: ventualsQuote }).lost).toHaveLength(1);
        const blocked = quoteVerdicts({ status: 'blocked', text: stub, quotes: ventualsQuote });
        expect(blocked).toEqual({ checked: 0, found: [], lost: [], skipped: 0, notCheckable: 1 });
    });

    test('gone and error sources give no verdict at all; a readable one is checked as before', () => {
        expect(quoteVerdicts({ status: 'gone', text: null, quotes: ventualsQuote })).toBeNull();
        expect(quoteVerdicts({ status: 'error', text: null, quotes: ventualsQuote })).toBeNull();
        const read = quoteVerdicts({ status: 'changed', text: 'SIGNED\nAlvin Hsia\nCEO\nAlvin Hsia\nEmily Hsia\nCTO\nEmily Hsia', quotes: ventualsQuote });
        expect(read.found).toHaveLength(1);
        expect(read.notCheckable).toBe(0);
    });
});

describe('numbers on their own line in HTML are words, not page numbers', () => {
    // A Seedrs progress block (europe.republic.com): the figures are lines of their own.
    const html = '<div class="progress"><p>Raised from</p><p>958</p><p>investors, of whom</p><p>850</p><p>invested via the app</p></div>';
    const quote = [{ id: 'q', kind: 'claim', ref: 'x', quote: 'Raised from 958 investors, of whom 850 invested via the app' }];

    test('an HTML quote keeps its numbers; the page-number rule is PDF-only', () => {
        const text = htmlDocumentText(html).quoteText;
        expect(quoteVerdicts({ status: 'ok', kind: 'html', text, quotes: quote }).found).toHaveLength(1);
        // What the PDF rule would do to the same lines: the verbatim quote reads as lost.
        expect(quoteVerdicts({ status: 'ok', kind: 'pdf', text, quotes: quote }).lost).toHaveLength(1);
        expect(quoteKey('a\n958\nb')).toBe('a958b');
        expect(quoteKey('a\n958\nb', { pdf: true })).toBe('ab');
    });
});

describe('a <header> holding content is read for quotes', () => {
    // republic.com/rspax: the offering-summary strip lives in a <header>, the menu in a <nav>.
    const html = '<body><header><nav><a>Invest</a><a>Raise</a></nav><div>Status</div><div>Closed</div>'
        + '<div>Minimum investment</div><div>$50</div></header><main><p>About rSPAX.</p></main></body>';
    const quote = [{ id: 'republic-mirror:status:x', kind: 'claim', ref: 'status', quote: 'Status Closed Minimum investment $50' }];

    test('the hashed text still drops the header; the quote text keeps it (but not its nav)', () => {
        const read = htmlDocumentText(html);
        expect(read.text).toBe('About rSPAX.');
        expect(read.quoteText).toBe('Status\nClosed\nMinimum investment\n$50\nAbout rSPAX.');
        expect(checkQuotes(read.text, quote).lost).toHaveLength(1);
        expect(checkQuotes(read.quoteText, quote).found).toHaveLength(1);
        expect(htmlToText(html, { forQuotes: true })).toBe(read.quoteText);
    });
});

describe('the quote check reads the text before the churn filter', () => {
    // republic.com/rspax (Wayback capture of 2026-09-18) prints its offering terms as label/value
    // cells, so the price is a line of its own — which the HTML ticker rule drops as churn.
    const html = '<main><div>Security type</div><div>Contingent Payout Note</div><div>Price per security</div>'
        + '<div>$1.00</div><div>Reference asset</div><div>SpaceX common stock*</div>'
        + '<div>Reference price</div><div>$275</div></main>';
    const quote = [{ id: 'republic-mirror:redemption.minimum:06a6d3cd', kind: 'claim', ref: 'redemption.minimum',
        quote: 'Security type Contingent Payout Note Price per security $1.00 Reference asset SpaceX common stock* Reference price $275' }];

    test('the hashed text drops "$275"; the quote text keeps it, and nothing else changes', () => {
        const read = htmlDocumentText(html);
        expect(read.text.split('\n')).not.toContain('$275');
        expect(read.quoteText.split('\n')).toContain('$275');
        expect(normaliseLines('a\n\n$50\n  b  ', { htmlWidgets: true, keepChurn: true })).toBe('a\n$50\nb');
    });

    test('a quote containing "$275" on its own line is lost in the filtered text and found in the unfiltered one', () => {
        const read = htmlDocumentText(html);
        expect(checkQuotes(read.text, quote).lost).toHaveLength(1);
        expect(checkQuotes(read.quoteText, quote).found).toHaveLength(1);
        // The same for a stored copy re-read on a 304 or an unchanged Wayback capture.
        const stored = storedReading({ rawExt: 'html', via: 'wayback', payload: html });
        expect(stored.text).toBe(read.text);
        expect(checkQuotes(stored.quoteText, quote).found).toHaveLength(1);
    });

    test('a stored Notion recordMap and a stored JSON body are re-read by their own readers', () => {
        const recordMap = { block: {
            root: { value: { id: 'root', type: 'page', properties: { title: [['Terms']] }, content: ['p1', 'p2'] } },
            p1: { value: { id: 'p1', type: 'text', properties: { title: [['Minimum investment']] } } },
            p2: { value: { id: 'p2', type: 'text', properties: { title: [['$50']] } } }
        } };
        const notion = storedReading({ rawExt: 'json', via: 'notion', payload: JSON.stringify({ pageId: 'root', recordMap }) });
        expect(notion.text).toBe('Terms\nMinimum investment');
        expect(notion.quoteText).toBe('Terms\nMinimum investment\n$50');
        expect(notion.jsOnly).toBe(false);
        expect(storedReading({ rawExt: 'json', payload: '{"b":1,"a":2}' }).text).toBe(jsonToText('{"a":2,"b":1}'));
        expect(storedReading({ rawExt: 'html', via: 'binary', payload: 'PK\u0003\u0004' })).toBeNull();
    });
});

describe('ticker widgets and news-list churn do not raise a keyword severity (sonar.change_event, 2026-09-23)', () => {
    // Event 197 (SPCX vs SPCXx vs SPACEX): the paragraph is the same; only the inline AAPLx and
    // ANTHROPIC tickers moved. "redemption" is in the line but did not change.
    const before197 = [
        'xStocks AAPLx $343.15 +1.3% offers SPCXx , its tokenized SpaceX product, under a different legal structure. It tracks the SpaceX share price, but does not provide the ACATS/DTCC redemption pathway that SPCX offers.',
        "PreStocks ANTHROPIC $1,042.17 +1.6% 's SPACEX has the highest holder count of the three (approximately 12,600 as of June 14), but it carries a structural characteristic the others do not: a hard expiration."
    ].join('\n');
    const after197 = before197.replace('$343.15 +1.3%', '$341.91 +0.9%').replace('$1,042.17 +1.6%', '$1,028.68 -3.6%');
    // Event 195 (CoinDesk): the footer ticker strip.
    const strip = 'CD20 $2,495.93 CD20 up 1.32 percent 1.32% BTC $86,553.96 BTC up 0.81 percent 0.81% ETH $2,753.41 ETH up 0.42 percent 0.42%';

    test('a line that is only a ticker strip is a widget, prose with a price is not', () => {
        expect(isTickerLine(strip)).toBe(true);
        expect(isTickerLine('AAPLx $343.15 +1.3%')).toBe(true);
        expect(isTickerLine('The redemption fee is $5 per request.')).toBe(false);
        expect(isTickerLine('$ 500.00')).toBe(false);
        expect(isTickerLine('USDC')).toBe(false);
    });

    test('event 197: a paragraph whose only change is an inline ticker is info, not caution', () => {
        const diff = diffLines(before197, after197);
        expect(diff.changedLines).toHaveLength(4);
        const out = severityForChange({ kind: 'html', changedLines: diff.changedLines, removedLines: diff.removedLines, addedLines: diff.addedLines });
        expect(out.severity).toBe('info');
        // The old input — the changed lines without their sides — is what made it `caution`.
        expect(severityForChange({ kind: 'html', changedLines: diff.changedLines }).keywords).toEqual(['redemption']);
    });

    test('event 195: the ticker strip changing is info; a real new list item is still read', () => {
        const next = strip.replace('$2,495.93', '$2,496.39').replace('1.32 percent 1.32%', '1.34 percent 1.34%');
        const diff = diffLines(`Article\n${strip}`, `Article\n${next}`);
        expect(severityForChange({ kind: 'html', ...diff }).severity).toBe('info');
        // The CoinDesk news list re-stamps and renumbers every item; only the item that really
        // left (with its keyword) is a change.
        const before = ['1 Next for the U.S. SEC: path for custody 2 hours ago', '2 Animoca Brands suspends merger talks 7 hours ago'].join('\n');
        const after = ['1 Canada banks launch tokenized deposits 20 minutes ago', '2 Next for the U.S. SEC: path for custody 3 hours ago'].join('\n');
        const listDiff = diffLines(before, after);
        expect(substantiveChanges(listDiff)).toEqual(['2 Animoca Brands suspends merger talks 7 hours ago', '1 Canada banks launch tokenized deposits 20 minutes ago']);
        expect(severityForChange({ kind: 'html', ...listDiff }).keywords).toEqual(['suspend']);
    });

    test('a real edit in a line that also carries a ticker is still caution', () => {
        const before = 'xStocks AAPLx $343.15 +1.3% offers redemption through the issuer.';
        const after = 'xStocks AAPLx $341.91 +0.9% no longer offers redemption through the issuer.';
        expect(severityForChange({ kind: 'html', ...diffLines(before, after) }).severity).toBe('caution');
    });
});

describe('archive gap pass (--archive-missing-only)', () => {
    test('targets only read, archivable sources that still have no archive URL', () => {
        const sources = ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test',
            'https://e.test', 'https://f.test', 'https://web.archive.org/cdx/search/cdx?url=x.test*'].map((url) => ({ url }));
        const state = {
            'https://a.test': { status: 'ok', archiveUrl: 'https://web.archive.org/web/1/https://a.test' },
            'https://b.test': { status: 'blocked', archiveUrl: null },
            'https://c.test': { status: 'gone', archiveUrl: null },
            'https://d.test': { status: 'error', archiveUrl: null },
            'https://e.test': { status: 'changed', archiveUrl: '' }
        };
        const { targets, skipped } = archiveMissingTargets(sources, state);
        expect(targets).toEqual([{ url: 'https://b.test', status: 'blocked' }, { url: 'https://e.test', status: 'changed' }]);
        expect(skipped).toEqual({ archived: 1, unchecked: 1, gone: 1, error: 1, archiveHost: 1 });
        expect(archivableUrl('https://web.archive.org/cdx/search/cdx?url=remora.markets*')).toBe(false);
        expect(archivableUrl('https://www.sec.gov/x')).toBe(true);
        expect(archivableUrl('not a url')).toBe(false);
    });

    test('fills only NULL archive_url rows, by source id', () => {
        const { sql, rows } = buildArchiveUrlSql([
            { id: 'abc123def456', archiveUrl: 'https://web.archive.org/web/20260923110000/https://b.test' },
            { id: 'nothing', archiveUrl: null }
        ]);
        expect(rows).toBe(1);
        expect(sql).toMatch(/UPDATE sonar\.source AS s SET archive_url/);
        expect(sql).toMatch(/s\.archive_url IS NULL/);
        expect(sql).toContain('abc123def456');
        expect(sql).not.toContain('nothing');
    });

    test('a declined repeat snapshot is resolved to a recent capture, never an old one', () => {
        expect(spnAlreadyCaptured('save-page-now submit: The same snapshot had been made 17 hours, 38 minutes ago. You can make new capture of this URL after 24 hours.')).toBe(true);
        expect(spnAlreadyCaptured('save-page-now error — error:job-failed: Job failed.')).toBe(false);
        expect(spnAlreadyCaptured(null)).toBe(false);
        const now = Date.parse('2026-09-23T12:00:00Z');
        expect(captureIsRecent('20260922180000', now)).toBe(true);
        expect(captureIsRecent('20260901120000', now)).toBe(false);
        expect(captureIsRecent('2026092218', now)).toBe(false);
        expect(captureIsRecent(null, now)).toBe(false);
    });
});

describe('readProvenance for a companion read', () => {
    test('text read from the publisher\'s own API is recorded as companion, not as a live api read', () => {
        const result = { status: 'ok', via: 'api', companionReader: 'npm-registry', resolvedUrl: 'https://registry.npmjs.org/x', url: 'https://www.npmjs.com/package/x' };
        expect(readProvenance(result)).toEqual({ readVia: 'companion', captureAt: null });
        expect(READ_VIA).toContain('companion');
    });
});
