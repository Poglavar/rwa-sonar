const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { readdirSync } = require('node:fs');
const { renderIssuerIndex, renderIssuerPage, whatIfStatusCounts } = require('./lib/issuer-pages.mjs');
const { dossierFileFor } = require('./lib/issuer-whatif.mjs');
const { renderTemplatePage } = require('./lib/template-pages.mjs');
const { assignSlugs } = require('./lib/cards.mjs');

const root = join(__dirname, '..');
const issuers = JSON.parse(readFileSync(join(root, 'stocks-issuers.json'), 'utf8'));
const tokens = JSON.parse(readFileSync(join(root, 'stocks-tokens.json'), 'utf8'));
const templates = JSON.parse(readFileSync(join(root, 'stocks-legal-templates.json'), 'utf8'));

describe('canonical issuer dossiers', () => {
    const issuer = issuers.issuers.find((row) => row.slug === 'xstocks-backed');
    const issuerTokens = tokens.tokens.filter((row) => row.issuer === issuer.slug);
    const html = renderIssuerPage({ issuer, tokens: issuerTokens, templates: templates.templates, builtAt: issuers.builtAt },
        { baseUrl: 'https://rwasonar.com', version: 'test' });

    it('has a stable canonical URL and starts with the plain-English decision', () => {
        expect(html).toContain('rel="canonical" href="https://rwasonar.com/issuers/xstocks-backed.html"');
        expect(html).toContain('The short answer');
        expect(html).toContain('What do you own?');
        expect(html).toContain('Can you redeem?');
        expect(html).toContain('Route currently available');
        expect(html).toContain('Successful redemption independently observed');
        expect(html).toContain('Asset-specific; inspect the exact-token report');
        expect(html).toContain('Can the issuer intervene?');
        expect(html).toContain('../economics.html?issuer=xstocks-backed');
        expect(html).toContain('<meta name="twitter:site" content="@RWASonar" />');
        expect(html).toContain('href="https://x.com/RWASonar"');
    });

    it('states evidence context and keeps outside-world discrepancies visible', () => {
        // Derived from the record, not typed: research raises the sourced count over time.
        const { sourced, needed } = issuer.evidence.coverage;
        expect(Number.isInteger(sourced) && Number.isInteger(needed) && needed > 0).toBe(true);
        expect(html).toContain(`${sourced} of ${needed} required fields sourced`);
        expect(html).toContain('Unknown means not established, never “no”');
        expect(html).toContain('Published claim ≠ observed reality');
        expect(html).toContain('Edits to RWA Sonar’s own research are not listed here');
    });

    it('labels the TSLAx fee as a programme example instead of an issuer-wide term', () => {
        expect(html).toContain('Product example only (TSLAx); no programme-wide fee is confirmed.');
        expect(html).toContain('<details class="redemption-term">');
        expect(html).toContain('0.50%');
    });

    it('shows the effective signer behind each installed control path', () => {
        expect(html).toContain('Who can exercise token controls');
        expect(html).toContain('Unattributed direct signer S7vYFF');
        expect(html).toContain('2 of 4');
        expect(html).toContain('initiate-only members are not counted as voters');
    });

    it('links each short answer to the relevant plain-language guide', () => {
        for (const guide of ['beneficial-ownership', 'redemption', 'issuer-control', 'bankruptcy-remoteness', 'defi-custody']) {
            expect(html).toContain(`../learn/${guide}.html`);
        }
    });

    it('links the reusable legal template and limits the initial asset wall', () => {
        expect(html).toContain('../templates/xstocks-backed--token-2022-pausable-clawback-rebase.html');
        expect(html).toContain('Browse the complete catalogue');
        expect((html.match(/<li><a href="\.\.\/cards\//g) || []).length).toBe(36);
        expect(html).not.toContain('[object Object]');
    });

    it('carries the Open Graph tags an X card needs', () => {
        expect(html).toContain('<meta property="og:title" content="Kraken xStocks: what the token holder owns — RWA Sonar" />');
        expect(html).toMatch(/<meta property="og:description" content="[^"]{40,}" \/>/);
        expect(html).toContain('<meta property="og:image" content="https://rwasonar.com/images/og-rwasonar.png?v=20260923" />');
        expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    });

    it('publishes an index containing every programme', () => {
        const index = renderIssuerIndex(issuers.issuers, { baseUrl: 'https://rwasonar.com' });
        for (const row of issuers.issuers) expect(index).toContain(`./${row.slug}.html`);
        expect(index).toContain('<meta name="twitter:site" content="@RWASonar" />');
    });
});

describe('asset chips link to the card file build-cards writes', () => {
    // A symbol shared by two mints (FWDI, COPX) gets `<symbol>-<mint prefix>.html`; a bare
    // `<symbol>.html` link was a live 404 on the Backpack issuer and template pages (2026-09-23).
    const cardSlugs = assignSlugs(tokens.tokens);
    const written = new Set(cardSlugs.values());
    const cardLinks = (html) => [...html.matchAll(/href="\.\.\/cards\/([^"]+)\.html"/g)].map((m) => decodeURIComponent(m[1]));

    it('every issuer page links only to existing cards', () => {
        for (const issuer of issuers.issuers) {
            const html = renderIssuerPage({ issuer, tokens: tokens.tokens.filter((row) => row.issuer === issuer.slug), templates: templates.templates },
                { cardSlugs });
            for (const slug of cardLinks(html)) expect(written.has(slug) ? slug : `missing card ${slug} on ${issuer.slug}`).toBe(slug);
        }
    });

    it('every template page links only to existing cards', () => {
        for (const template of templates.templates) {
            for (const slug of cardLinks(renderTemplatePage(template, { cardSlugs }))) {
                expect(written.has(slug) ? slug : `missing card ${slug} on ${template.id}`).toBe(slug);
            }
        }
    });
});

describe('each dossier counts its what-if answers and links to them', () => {
    const dossierDir = join(__dirname, 'data', 'issuers');
    const files = readdirSync(dossierDir).filter((name) => name.endsWith('.json'));
    const questions = JSON.parse(readFileSync(join(__dirname, 'data', 'trust-chain.json'), 'utf8')).failureModes.length;

    it('resolves every issuer to exactly one dossier file with answers', () => {
        for (const issuer of issuers.issuers) {
            const file = dossierFileFor(issuer.slug, files);
            expect(file === null ? `no dossier for ${issuer.slug}` : file).toMatch(/\.json$/);
        }
        // `bullish` is filed as bullish-blsh.json; an ambiguous prefix must not be guessed.
        expect(dossierFileFor('bullish', ['bullish-blsh.json'])).toBe('bullish-blsh.json');
        expect(dossierFileFor('a', ['a-1.json', 'a-2.json'])).toBeNull();
    });

    it('prints the five status counts and both links on every issuer page', () => {
        for (const issuer of issuers.issuers) {
            const dossier = JSON.parse(readFileSync(join(dossierDir, dossierFileFor(issuer.slug, files)), 'utf8'));
            const html = renderIssuerPage({ issuer, tokens: [], templates: [], whatIf: dossier.whatIf, whatIfQuestions: questions });
            const counts = whatIfStatusCounts(dossier.whatIf, questions);
            expect(counts.total).toBe(questions);
            for (const [status, label] of [['documented', 'documented'], ['inferred', 'inferred'], ['litigated', 'litigated'],
                ['unknown', 'unknown'], ['not-applicable', 'not applicable']]) {
                expect(html).toContain(`<li class="whatif-${status}"><strong>${counts[status]}</strong> ${label}</li>`);
            }
            expect(html).toContain(`href="../whatif.html?issuer=${encodeURIComponent(issuer.slug)}"`);
            expect(html).toContain(`href="../stocks.html?issuer=${encodeURIComponent(issuer.slug)}"`);
        }
    });

    it('counts an unreadable or absent answer as not yet answered, and says so when no dossier exists', () => {
        expect(whatIfStatusCounts([{ status: 'documented' }, { status: 'excellent' }, null], 38))
            .toEqual({ documented: 1, inferred: 0, litigated: 0, unknown: 0, 'not-applicable': 0, missing: 37, total: 38 });
        const issuer = issuers.issuers[0];
        const none = renderIssuerPage({ issuer, whatIf: null, whatIfQuestions: 38 });
        expect(none).toContain('No failure-scenario answer is recorded for this programme yet');
        expect(none).toContain(`../whatif.html?issuer=${encodeURIComponent(issuer.slug)}`);
        expect(none).not.toContain('whatif-counts');
    });
});

describe('recurring on-chain redemption scan on issuer dossiers', () => {
    const { publicFeed } = require('./lib/redemption-feed.mjs');
    const NOW = '2026-09-23T21:00:00Z';
    const page = (slug, feed) => {
        const issuer = issuers.issuers.find((row) => row.slug === slug);
        return renderIssuerPage({ issuer: { ...issuer, redemption: { ...issuer.redemption, observationFeed: feed } },
            tokens: tokens.tokens.filter((row) => row.issuer === slug), templates: templates.templates, builtAt: issuers.builtAt },
        { version: 'test' });
    };
    const line = (html) => html.match(/<dt>Recurring on-chain scan<\/dt><dd><strong>(.*?)<\/strong><small class="evidence-state">(.*?)<\/small>/)?.slice(1) ?? null;

    it('states an observed programme after the observed-execution row, separate from route and availability', () => {
        const html = page('ondo-global-markets', publicFeed({ observable: true, coverage: [{ from: '2026-09-23T02:11:07Z', to: '2026-09-23T20:19:17Z' }],
            daily: { '2026-09-23': { redemptions: 217 } }, lastObserved: { blockTime: '2026-09-23T20:12:36Z' },
            lastScan: { at: '2026-09-23T20:20:17Z', status: 'ok', backlog: 0 } }, { now: NOW }));
        expect(line(html)).toEqual(['Redemptions observed on-chain: last on 2026-09-23 (217 in the last 18 h, recurring scan).', 'observed']);
        expect(html.indexOf('Route currently available')).toBeLessThan(html.indexOf('Successful redemption independently observed'));
        expect(html.indexOf('Successful redemption independently observed')).toBeLessThan(html.indexOf('Recurring on-chain scan'));
    });

    it('never words a failed scan or the Superstate burn as redemptions observed, and explains the unobservable', () => {
        const failed = page('xstocks-backed', publicFeed({ observable: true, coverage: [{ from: '2026-09-22T00:00:00Z', to: '2026-09-23T00:00:00Z' }],
            lastScan: { at: '2026-09-23T06:00:00Z', status: 'failed', error: 'RPC 429' } }, { now: NOW }));
        expect(line(failed)).toEqual(['Scan failed on 2026-09-23; redemptions for that period are unknown.', 'scan failed']);
        const superstate = page('superstate-opening-bell', publicFeed({ observable: true, mechanism: 'burn-to-book-entry-conversion', completionObservable: false,
            coverage: [{ from: '2026-08-24T20:27:42Z', to: '2026-09-23T20:26:42Z' }], daily: { '2026-09-10': { redemptions: 3 } },
            lastObserved: { blockTime: '2026-09-10T19:42:35Z' }, lastScan: { at: '2026-09-23T20:27:42Z', status: 'ok', backlog: 0 } }, { now: NOW }));
        expect(line(superstate)[0]).toBe('On-chain leg only: burn-to-book-entry conversion last seen on 2026-09-10 (3 in the last 30 days, recurring scan). Completion (the book-entry credit) happens off-chain and is not observed.');
        const tessera = page('tessera', publicFeed({ observable: false, whyNotObservable: 'No Redemption Period has commenced. The IDL has no burn.' }, { now: NOW }));
        expect(line(tessera)).toEqual(['Not observable on-chain: No Redemption Period has commenced.', 'not observable']);
    });

    it('prints nothing when the builder merged no feed', () => {
        expect(page('prestocks', undefined)).not.toContain('Recurring on-chain scan');
    });
});

describe('issuer page schematics', () => {
    const schematics = JSON.parse(readFileSync(join(root, 'stocks-schematics.json'), 'utf8'));
    const issuer = issuers.issuers.find((row) => row.slug === 'ondo-global-markets');
    const render = (entry) => renderIssuerPage({ issuer, tokens: [], templates: templates.templates, builtAt: issuers.builtAt,
        schematics: entry }, { version: 'test' });

    it('draws the redemption, creation and relationship figures, then the key what-if sequences, with unique ids', () => {
        const html = render(schematics.issuers['ondo-global-markets']);
        expect(html).toContain('<link rel="stylesheet" href="../flow-diagram.css?v=test" />');
        const how = html.slice(html.indexOf('id="how-it-works"'), html.indexOf('</section>', html.indexOf('id="how-it-works"')));
        expect(how).toContain('data-schematic-id="ondo-global-markets:redemption"');
        expect(how).toContain('data-schematic-id="ondo-global-markets:creation"');
        expect(how).toContain('data-schematic-id="ondo-global-markets:relationships"');
        expect(html).toContain('id="what-happens"');
        expect(html).toContain('data-schematic-id="ondo-global-markets:whatif:custodian-insolvency"');
        const ids = [...html.matchAll(/aria-labelledby="(fd-\d+)-t/g)].map((m) => m[1]);
        expect(ids.length).toBeGreaterThan(5);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('draws nothing, not an empty frame, when there are no schematics', () => {
        const html = render(null);
        expect(html).not.toContain('id="how-it-works"');
        expect(html).not.toContain('id="what-happens"');
    });
});

describe('growing lists on issuer and template pages are compact rows that open to the full item', () => {
    const { escapeHtml } = require('./lib/fmt.js');
    const rowsOf = (html) => html.split(/(?=<li(?: id="[^"]*")? class="fold-row)/).slice(1).map((part) => ({
        open: part.slice(3, part.indexOf('>')),
        summary: part.slice(part.indexOf('<summary>'), part.indexOf('</summary>')),
        body: part.slice(part.indexOf('<div class="fold-body">'))
    }));

    it('shows each issuer discrepancy as one row: severity and title, why it matters, then both sides and the sources', () => {
        const issuer = issuers.issuers.find((row) => row.slug === 'xstocks-backed');
        const html = renderIssuerPage({ issuer, tokens: tokens.tokens.filter((row) => row.issuer === issuer.slug), templates: templates.templates, builtAt: issuers.builtAt },
            { baseUrl: 'https://rwasonar.com', version: 'test' });
        const section = html.slice(html.indexOf('<section class="issuer-conflicts" id="discrepancies">'), html.indexOf('</section>', html.indexOf('issuer-conflicts')));
        const rows = rowsOf(section);
        expect(rows).toHaveLength(issuer.discrepancies.length);
        const d = issuer.discrepancies[0];
        expect(rows[0].open).toBe(` id="discrepancy-${d.id}" class="fold-row fold-${d.severity}"`);
        expect(rows[0].summary).toContain(`<b class="fold-chip">${d.severity}</b> <strong class="fold-title">${escapeHtml(d.title)}</strong>`);
        expect(rows[0].summary).toContain(`<span class="fold-line2">${escapeHtml(d.impact)}</span>`);
        expect(rows[0].summary).not.toContain('<a ');
        for (const words of ['Published claim', 'Observed reality', 'Why it matters:', 'What resolves it:', escapeHtml(d.claim.text)]) {
            expect(rows[0].body).toContain(words);
        }
        expect(rows[0].body).toMatch(/<a href="https:[^"]+" target="_blank"/);
    });

    it('shows each recorded external source change of a template as one row', () => {
        const base = templates.templates.find((row) => row.issuer.slug === 'xstocks-backed');
        const template = { ...base, sourceAuthority: { ...base.sourceAuthority, changes: [
            { field: 'redemption.fee', status: 'changed', note: 'The fee schedule now names a 0.5% redemption fee.', url: 'https://example.com/terms', accessedAt: '2026-09-20T10:00:00Z' }
        ] } };
        const html = renderTemplatePage(template, { baseUrl: 'https://rwasonar.com', version: 'test' });
        const [row] = rowsOf(html.slice(html.indexOf('<h3>Recorded external source changes</h3>')));
        expect(row.open).toBe(' class="fold-row fold-caution"');
        expect(row.summary).toContain('20 Sep 2026 · <b class="fold-chip">changed</b> <strong class="fold-title">redemption.fee</strong>');
        expect(row.summary).toContain('<span class="fold-line2">The fee schedule now names a 0.5% redemption fee.</span>');
        expect(row.summary).not.toContain('<a ');
        expect(row.body).toContain('href="https://example.com/terms"');
    });
});
