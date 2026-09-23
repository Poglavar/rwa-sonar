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
    driveDownloadUrl, fileStamp, htmlToText, isTextual, looksLikePdf,
    jsOnlyShell, jsonToText, looksLikeChurn, normaliseByKind, normaliseLines, parseArchiveLocation,
    pdfTextToText, rawExtension, reusableCheckpoint, runFailed, severityForChange, sha256Hex, sourceId,
    sourceWatchStatsFileName, stripPublisherChrome, publisherNormalizerVersion, tolerates503,
    verificationUrlForClaim,
    userAgentFor,
    parseSpnStatus, quoteFound, quoteFragments, quoteKey, spnBusy, spnTransient
} from './lib/watch.mjs';

const FIXTURES = new URL('./fixtures/sources/', import.meta.url);
const REAL_HTML = readFileSync(new URL('backed-fi-legal-documentation.html', FIXTURES), 'utf8');
const REAL_PDF_TEXT = readFileSync(new URL('shift-dao-series-17-spx3l-pages-1-2.pdftotext.txt', FIXTURES), 'utf8');
const DDL = readFileSync(new URL('../db/2026-09-18-sonar-evidence.sql', import.meta.url), 'utf8');

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
        expect(verificationUrlForClaim(claim, {})).toBe(claim.url);
        expect(verificationUrlForClaim(claim, { quoteVerificationSources: [{
            sourceUrl: claim.url, verificationUrl: 'https://issuer.example/llms-full.txt'
        }] })).toBe('https://issuer.example/llms-full.txt');
    });
    test('does not fall back to another issuer page merely because it may contain the same words', () => {
        expect(verificationUrlForClaim(claim, { quoteVerificationSources: [{
            sourceUrl: 'https://issuer.example/other', verificationUrl: 'https://issuer.example/all.txt'
        }] })).toBe(claim.url);
    });
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

    it('a page number on its own line inside a sentence is not part of the quote', () => {
        const text = 'the Issuer holds the Underlyings held in the\n68\nmain and sub accounts at all times.';
        expect(quoteFound(text, 'the Underlyings held in the main and sub accounts at all times')).toBe(true);
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
