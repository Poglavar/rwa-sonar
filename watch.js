/**
 * Renders watch.html: what RWA Sonar keeps watch on, and what has moved. The focused-watch surface
 * uses the capability-key API; the evidence sections use the read-only JSON API:
 *
 *   1. the sources we watch          /api/sources   (paginated, 500 per call)
 *   2. the change feed               /api/changes    (kind / severity / issuer / since / material
 *      filters). A row the change judge has read carries `modelAssessment`, shown as a labelled
 *      MODEL ASSESSMENT under the diff and never in place of it (stocks/EVIDENCE.md §2.3).
 *   3. evidence freshness per issuer /api/issuers + /api/issuers/:slug/claims?limit=1, whose
 *      `summary` is the per-status claim aggregate SQL already computes. The full claim list is
 *      never pulled for this: 1,264 claims with their quotes is ~1 MB to draw twelve bars.
 *   4. a claims lookup               /api/claims?issuer=…  (one issuer at a time, then a
 *      substring filter over the field paths in the browser, because the API's `field` filter is
 *      an exact match and nobody knows a dotted field path by heart)
 *
 * Two things this page has to hold a copy of, both LOCKED to their source of truth by
 * watch-page.test.js so they cannot drift: the change-event kinds and severities, and the source
 * and claim statuses — all of them are CHECK constraints in db/2026-09-18-sonar-evidence.sql and
 * db/2026-09-18-sonar-claims.sql, which is the only place they are defined. The labels are this
 * page's own; the vocabularies are not.
 *
 * One data wrinkle it has to cope with: `sonar.source.issuer_slug` does NOT use the same slugs as
 * `sonar.stock_issuer` — three of the twelve carry a token suffix (`bullish-blsh` for `bullish`,
 * `securitize-secz`, `backpack-securities-spcx`). resolveIssuerSlug() folds those back onto the
 * real issuer so one issuer is one row, rather than appearing twice under two spellings.
 *
 * Everything above the DOM section is pure — no DOM, no fetch, no clock — and is exported for jest
 * (watch-page.test.js). Formatters come from stocks/lib/fmt.js and the API base from
 * stocks/lib/api-base.js, the copies the other pages share. Wrapped in a UMD factory so it declares
 * no globals and cannot shadow a top-level name in another classic script.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__watch = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const fmt = (typeof __rwaFmt !== 'undefined') ? __rwaFmt : require('./stocks/lib/fmt.js');
    const {
        DASH, SLUG_SAFE, escapeHtml, isNum, isSafeUrl, isoToMillis, fmtNumber, fmtPct,
        fmtDateTime, fmtRelativeTime, humanizeSlug, cardSlug
    } = fmt;

    // -----------------------------------------------------------------------
    // Pure section — no DOM, no fetch, no Date.now(). Exported for jest.
    // -----------------------------------------------------------------------

    /**
     * The colour bands every chip, tile, bar segment and legend dot resolves through — .wat-tone-*
     * in watch.css is the one place they are defined, so a source status, a change severity and a
     * claim status cannot disagree about what "warning" looks like. `accent` is also available
     * for non-severity emphasis without inventing a one-off colour.
     */
    const TONES = ['good', 'accent', 'info', 'caution', 'warning', 'critical'];

    /** `sonar.source.kind` — the CHECK constraint's values, in the order the tiles read. */
    const SOURCE_KINDS = ['pdf', 'html', 'api', 'onchain'];

    /** `sonar.source.status` — all six, including the two the watcher added to EVIDENCE.md §1. */
    const SOURCE_STATUSES = ['new', 'ok', 'changed', 'gone', 'blocked', 'error'];

    /**
     * Which colour band a source status belongs in. `changed` is not a fault — it is the watcher
     * doing its job — so it reads as caution, while `gone` (nothing left to read) is the worst.
     */
    const SOURCE_STATUS_TONE = {
        new: 'info', ok: 'good', changed: 'caution', gone: 'critical', blocked: 'warning', error: 'warning'
    };

    /** What each source status means, so a tile is never a bare number. */
    const SOURCE_STATUS_BLURBS = {
        new: 'registered, never fetched yet',
        ok: 'last fetch matched the stored hash',
        changed: 'the text moved since we last read it',
        gone: '404 or replaced — nothing left to re-read',
        blocked: 'the host refuses us (403, bot wall, paywall)',
        error: 'the fetch failed for another reason'
    };

    /** How each kind is read. `onchain` is an account, not a document. */
    const SOURCE_KIND_BLURBS = {
        pdf: 'text via pdftotext -layout',
        html: 'readable main text, nav and counters stripped',
        api: 'JSON response, normalised',
        onchain: 'account state read over RPC'
    };

    /** `sonar.change_event.kind` — the CHECK constraint's thirteen kinds (EVIDENCE.md §3). */
    const CHANGE_KINDS = [
        'legal-term', 'document-gone', 'authority-key', 'extension-toggle', 'rebase', 'supply',
        'treasury', 'holder-concentration', 'venue', 'float', 'liquidity', 'metadata', 'status'
    ];

    /** What each kind is called in the feed and in the filter. */
    const CHANGE_KIND_LABELS = {
        'legal-term': 'Legal term',
        'document-gone': 'Document gone',
        'authority-key': 'Authority key',
        'extension-toggle': 'Extension toggle',
        rebase: 'Rebase',
        supply: 'Supply',
        treasury: 'Treasury wallet',
        'holder-concentration': 'Holder concentration',
        venue: 'Venue',
        float: 'Float',
        liquidity: 'Liquidity',
        metadata: 'Token metadata',
        status: 'Issuer status'
    };

    /** `sonar.change_event.severity` — worst last, which is also the filter's order. */
    const SEVERITIES = ['info', 'caution', 'warning', 'critical'];

    const IMPACT_LEVELS = {
        high: { rank: 3, label: 'Could change holder rights or control' },
        medium: { rank: 2, label: 'Could change usability, exit or market risk' },
        low: { rank: 1, label: 'Context or catalogue update' }
    };

    /** Holder impact is separate from watcher severity: it says why a human should read first. */
    function holderImpact(row) {
        const severity = str(row?.severity) ?? 'info';
        const kind = str(row?.kind) ?? '';
        const text = [kind, row?.field, row?.category, row?.title, row?.summary, row?.whyItMatters]
            .filter(Boolean).join(' ').toLowerCase();
        const rights = /legal|governing law|holder claim|ownership|redemption|custod|bankrupt|security interest|eligib|freeze|clawback|pause|authority|document.gone|status/;
        const use = /liquid|venue|market|collateral|borrow|lend|protocol|defi|treasury|supply|rebase|float|concentration|holder/;
        if (severity === 'critical' || rights.test(text)) {
            return { key: 'high', ...IMPACT_LEVELS.high,
                reason: 'Read first: this may alter enforceability, redemption, custody or who can control the token.' };
        }
        if (severity === 'warning' || severity === 'caution' || use.test(text)) {
            return { key: 'medium', ...IMPACT_LEVELS.medium,
                reason: 'This may change where the token can be used, sold, borrowed against or how exposed holders are.' };
        }
        return { key: 'low', ...IMPACT_LEVELS.low,
            reason: 'Useful context, but no direct change to holder rights or current use is established.' };
    }

    function rankByHolderImpact(rows) {
        return (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, impact: row.impact ?? holderImpact(row) }))
            .sort((a, b) => (b.impact.rank - a.impact.rank)
                || String(b.detectedAt ?? b.date ?? '').localeCompare(String(a.detectedAt ?? a.date ?? '')));
    }

    function impactGroups(rows) {
        const groups = [];
        for (const row of rankByHolderImpact(rows)) {
            let group = groups.find((entry) => entry.key === row.impact.key);
            if (!group) {
                group = { key: row.impact.key, label: row.impact.label, rank: row.impact.rank, items: [] };
                groups.push(group);
            }
            group.items.push(row);
        }
        return groups;
    }

    /** Stable enough to remember a public journal row without storing any visitor data. */
    function journalIdentity(row) {
        return str(row?.id) ?? [row?.date, row?.kind, row?.title].map((value) => str(value) ?? '').join('\u0000');
    }

    /** Name the time we actually know; a first observation must never masquerade as event time. */
    function journalTimeLabel(row) {
        const parts = [];
        if (str(row?.effectiveAt)) parts.push(`Effective ${row.effectiveAt}`);
        else if (str(row?.eventAt)) parts.push(`Event ${row.eventAt}`);
        if (str(row?.firstObservedAt)) parts.push(`First observed ${row.firstObservedAt}`);
        if (str(row?.reviewedAt)) parts.push(`Reviewed ${row.reviewedAt}`);
        return parts.join(' · ') || `Recorded ${str(row?.date) ?? DASH}`;
    }

    /** Compare the current public journal with the anonymous baseline kept in this browser. */
    function journalVisitSummary(rows, seenIdentities) {
        const list = Array.isArray(rows) ? rows : [];
        const currentIdentities = list.map(journalIdentity);
        if (!Array.isArray(seenIdentities)) {
            return { firstVisit: true, newCount: 0, highImpactCount: 0, unseen: [], currentIdentities };
        }
        const seen = new Set(seenIdentities.filter((value) => typeof value === 'string'));
        const unseen = list.filter((row) => !seen.has(journalIdentity(row)));
        return {
            firstVisit: false,
            newCount: unseen.length,
            highImpactCount: unseen.filter((row) => (row.impact ?? holderImpact(row)).key === 'high').length,
            unseen,
            currentIdentities
        };
    }

    /** `sonar.claim.status` — in the API's own trust order (CLAIM_STATUS_ORDER), best first. */
    const CLAIM_STATUSES = ['confirmed', 'changed', 'inference', 'unverified', 'source-gone'];

    /** Short labels for the freshness bar's segments and the claim rows' chips. */
    const CLAIM_STATUS_LABELS = {
        confirmed: 'confirmed',
        changed: 'changed',
        inference: 'inference',
        unverified: 'unverified',
        'source-gone': 'source gone'
    };

    /** What each claim status asserts. The bar's legend, and the chip's tooltip. */
    const CLAIM_STATUS_BLURBS = {
        confirmed: 'the source\'s own words were found verbatim',
        changed: 'the quote is no longer in the source — a human decides, the claim is not false yet',
        inference: 'our reading, not the source\'s words',
        unverified: 'recorded, not yet found verbatim in a source',
        'source-gone': 'the document it was read from has disappeared'
    };

    /** Which colour band a claim status reads in. Only `changed`/`source-gone` are faults. */
    const CLAIM_STATUS_TONE = {
        confirmed: 'good',
        changed: 'warning',
        inference: 'caution',
        unverified: 'info',
        'source-gone': 'critical'
    };

    /** The "since" quick pick. `all` is a real choice, not the absence of one. */
    const SINCE_CHOICES = [
        { key: '24h', label: '24 hours', hours: 24 },
        { key: '7d', label: '7 days', hours: 24 * 7 },
        { key: '30d', label: '30 days', hours: 24 * 30 },
        { key: 'all', label: 'all time', hours: null }
    ];

    /** How many rows a call asks for. The API caps sources at 1000 and changes at 500. */
    const SOURCES_PER_CALL = 500;
    const CHANGES_PER_CALL = 200;
    const CLAIMS_PER_CALL = 500;

    /** The group a source with no `issuer_slug` at all falls into — 51 of 337 on 2026-09-17. */
    const UNATTRIBUTED = 'unattributed';

    /** Where the per-token cards and the issuer dossiers live, relative to this page. */
    const CARDS_DIR = './cards/';
    const DOSSIER_DIR = './issuers/';

    /** Display cuts. A hash is cut much shorter: nobody reads the middle of a sha256. */
    const TITLE_MAX = 130;
    const QUOTE_MAX = 260;
    const VALUE_MAX = 90;
    const SUMMARY_MAX = 200;
    const HASH_MAX = 12;

    function str(value) {
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    }

    function num(value) {
        return isNum(value) ? value : null;
    }

    /**
     * A display cut plus the full text for a `title=`, so nothing is ever silently lost: the whole
     * value is always one hover away. Cuts on a word boundary when one is near enough the limit.
     */
    function truncate(text, max) {
        const full = str(text) ?? '';
        const limit = isNum(max) && max > 4 ? Math.floor(max) : 80;
        if (full === '') return { text: DASH, full: '', truncated: false, empty: true };
        if (full.length <= limit) return { text: full, full, truncated: false, empty: false };
        const cut = full.slice(0, limit);
        const space = cut.lastIndexOf(' ');
        const head = space > limit * 0.6 ? cut.slice(0, space) : cut;
        return { text: `${head}…`, full, truncated: true, empty: false };
    }

    /**
     * A dossier field path rather than a human title — `xstocks-backed:sources[14]`,
     * `securitize-secz:attestations[10].link`. The extractor stores one as `source.title` when the
     * dossier cited a bare URL, which is 109 of the 337 sources on 2026-09-17, so a third of the
     * registry would otherwise be listed under a name that says nothing about the document.
     */
    const FIELD_PATH_TITLE = /^[a-z0-9-]+:[a-z][A-Za-z0-9_.[\]-]*$/;

    /**
     * Anchored at BOTH ends, and the field name has to start lowercase: only a title that is
     * ENTIRELY a dossier path is rejected, so a real title that happens to contain a colon
     * (`Ondo: the prospectus`, `SEC: staff statement`) is never discarded as one. Matched 117 of
     * the 337 registered sources on 2026-09-17; every unmatched one is a human title.
     */
    function isFieldPathTitle(text) {
        const raw = str(text);
        return raw !== null && FIELD_PATH_TITLE.test(raw);
    }

    /** `sec.gov/Archives/ea0…` — what to call a document whose only title is where we found it. */
    function urlLabel(url) {
        const raw = str(url);
        if (raw === null) return null;
        try {
            const parsed = new URL(raw);
            const host = parsed.hostname.replace(/^www\./, '');
            const tail = parsed.pathname.split('/').filter(Boolean).slice(-2).join('/');
            return tail === '' ? host : `${host}/${tail}`;
        } catch {
            return raw;
        }
    }

    /** A content hash, which is what a document diff's before/after actually are. */
    function isHashLike(text) {
        return typeof text === 'string' && /^[0-9a-f]{32,}$/i.test(text.trim());
    }

    /** truncate() for a change event's before/after: a hash is cut to twelve characters. */
    function shapeValue(raw, max) {
        const full = raw === null || raw === undefined ? '' : String(raw);
        const hashLike = isHashLike(full);
        return { ...truncate(full, hashLike ? HASH_MAX : max), hashLike };
    }

    /**
     * `since=<ISO>` for one quick-pick key, against a given clock. `all` and an unknown key are
     * null, which is the API's "no lower bound" — never a silently narrowed window.
     */
    function sinceIso(key, nowMs) {
        const choice = SINCE_CHOICES.find((entry) => entry.key === key);
        if (!choice || choice.hours === null) return null;
        const now = isNum(nowMs) ? nowMs : Date.now();
        return new Date(now - choice.hours * 3600 * 1000).toISOString();
    }

    /** The offsets a full sweep of `total` rows needs, `per` at a time. Always at least [0]. */
    function pageOffsets(total, per) {
        const size = isNum(per) && per > 0 ? Math.floor(per) : 1;
        const rows = isNum(total) && total > 0 ? Math.floor(total) : 0;
        const offsets = [];
        for (let offset = 0; offset < rows; offset += size) offsets.push(offset);
        return offsets.length === 0 ? [0] : offsets;
    }

    /** slug → name from /api/issuers. A row without a slug is skipped, not guessed at. */
    function issuerNames(issuers) {
        const list = Array.isArray(issuers) ? issuers : (Array.isArray(issuers?.items) ? issuers.items : []);
        const out = new Map();
        for (const row of list) {
            const slug = str(row?.slug);
            if (slug === null) continue;
            out.set(slug, str(row?.name) ?? humanizeSlug(slug));
        }
        return out;
    }

    /**
     * The source registry's issuer slug folded back onto the dossier's slug. `sonar.source` keys
     * three of the twelve issuers with a token suffix — `bullish-blsh`, `securitize-secz`,
     * `backpack-securities-spcx` — and without this the page would show fifteen issuers, three of
     * them duplicates with no name and no dossier link. An unknown slug is returned unchanged
     * rather than dropped: a source we cannot attribute is still a source we watch.
     */
    function resolveIssuerSlug(slug, known) {
        const raw = str(slug);
        if (raw === null) return null;
        const list = known instanceof Map ? [...known.keys()] : (Array.isArray(known) ? known : []);
        if (list.includes(raw)) return raw;
        let best = null;
        for (const candidate of list) {
            if (typeof candidate !== 'string' || !raw.startsWith(`${candidate}-`)) continue;
            if (best === null || candidate.length > best.length) best = candidate;
        }
        return best ?? raw;
    }

    /** Stable, shareable issuer dossier URL. */
    function dossierHref(slug) {
        const safe = str(slug);
        if (safe === null || !SLUG_SAFE.test(safe)) return null;
        return `${DOSSIER_DIR}${encodeURIComponent(safe)}.html`;
    }

    /**
     * `./cards/<slug>.html`, or null when there is no symbol to make a card slug from. `known` is the
     * API's collision-aware slug: a symbol two mints share (FWDI, COPX) has no `<symbol>.html`.
     */
    function cardHref(symbol, mint, known = null) {
        const slug = str(known) ?? str(cardSlug(symbol, mint));
        if (slug === null) return null;
        const href = `${CARDS_DIR}${encodeURIComponent(slug)}.html`;
        return isSafeUrl(href) ? href : null;
    }

    /** The later of two ISO timestamps, comparing as instants rather than as strings. */
    function laterIso(a, b) {
        const left = isoToMillis(a);
        const right = isoToMillis(b);
        if (left === null) return b ?? null;
        if (right === null) return a ?? null;
        return right > left ? b : a;
    }

    /**
     * The tiles over the whole registry: one count per kind, one per status, how many carry an
     * archived copy, how many are reporting an error, and the last sweep — the newest
     * `last_checked_at` in the set, which is what "when did the watcher last run" means.
     */
    function sourceTotals(sources) {
        const list = Array.isArray(sources) ? sources : [];
        const kinds = new Map(SOURCE_KINDS.map((kind) => [kind, 0]));
        const statuses = new Map(SOURCE_STATUSES.map((status) => [status, 0]));
        let archived = 0;
        let errors = 0;
        let lastSweepAt = null;
        let claims = 0;
        let versions = 0;
        for (const src of list) {
            const kind = str(src?.kind) ?? 'unknown';
            kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
            const status = str(src?.status) ?? 'unknown';
            statuses.set(status, (statuses.get(status) ?? 0) + 1);
            if (isSafeUrl(src?.archive_url)) archived += 1;
            if (str(src?.error) !== null) errors += 1;
            claims += num(src?.claims) ?? 0;
            versions += num(src?.versions) ?? 0;
            lastSweepAt = laterIso(lastSweepAt, str(src?.last_checked_at));
        }
        return {
            total: list.length,
            archived,
            errors,
            claims,
            versions,
            lastSweepAt,
            byKind: [...kinds].map(([key, count]) => ({
                key, count, label: key, blurb: SOURCE_KIND_BLURBS[key] ?? 'an unknown kind of source'
            })),
            byStatus: [...statuses].map(([key, count]) => ({
                key,
                count,
                label: key,
                tone: SOURCE_STATUS_TONE[key] ?? 'info',
                blurb: SOURCE_STATUS_BLURBS[key] ?? 'a status this page does not know'
            }))
        };
    }

    /**
     * One source, shaped for the expanded list under its issuer. A title that is really a dossier
     * field path is NOT printed as the document's name — the URL is, and the field path moves to
     * `citedAs`, where it says something true: which dossier field cites this URL.
     */
    function sourceRow(src) {
        const url = str(src?.url);
        const status = str(src?.status) ?? 'new';
        const archive = str(src?.archive_url);
        // `read_via = 'wayback'`: the live host refused the watcher and the text is an archived
        // capture of `capture_at`. The row must say so; a capture is not the live page.
        const readVia = str(src?.read_via);
        const captureAt = readVia === 'wayback' ? str(src?.capture_at) : null;
        const rawTitle = str(src?.title);
        const named = rawTitle !== null && !isFieldPathTitle(rawTitle) ? rawTitle : null;
        return {
            id: str(src?.id),
            url,
            href: isSafeUrl(url) ? url : null,
            title: truncate(named ?? urlLabel(url) ?? url, TITLE_MAX),
            citedAs: named === null ? rawTitle : null,
            kind: str(src?.kind) ?? 'unknown',
            status,
            tone: SOURCE_STATUS_TONE[status] ?? 'info',
            lastCheckedAt: str(src?.last_checked_at),
            lastChangedAt: str(src?.last_changed_at),
            archiveHref: isSafeUrl(archive) ? archive : null,
            error: truncate(src?.error, VALUE_MAX * 2),
            readVia,
            captureAt,
            captureNote: readVia === 'wayback'
                ? `read from the Wayback capture of ${captureAt === null ? 'an unrecorded date' : fmtDateTime(captureAt)}`
                : null,
            claims: num(src?.claims) ?? 0,
            versions: num(src?.versions) ?? 0
        };
    }

    /**
     * One row per issuer: how many sources, when it was last checked, how many are changed / gone /
     * blocked, how many have an archived copy, and the shaped source list the row expands into.
     * Sorted by source count, so the issuer with the most watched paper reads first.
     */
    function sourcesByIssuer(sources, names) {
        const list = Array.isArray(sources) ? sources : [];
        const index = names instanceof Map ? names : new Map();
        const groups = new Map();
        for (const src of list) {
            const slug = resolveIssuerSlug(src?.issuer_slug, index) ?? UNATTRIBUTED;
            if (!groups.has(slug)) {
                const known = index.has(slug);
                groups.set(slug, {
                    slug,
                    name: known ? index.get(slug) : (slug === UNATTRIBUTED ? 'No issuer recorded' : humanizeSlug(slug)),
                    href: known ? dossierHref(slug) : null,
                    count: 0,
                    lastCheckedAt: null,
                    changed: 0,
                    gone: 0,
                    blocked: 0,
                    errors: 0,
                    archived: 0,
                    items: []
                });
            }
            const group = groups.get(slug);
            const row = sourceRow(src);
            group.count += 1;
            group.lastCheckedAt = laterIso(group.lastCheckedAt, row.lastCheckedAt);
            if (row.status === 'changed') group.changed += 1;
            if (row.status === 'gone') group.gone += 1;
            if (row.status === 'blocked') group.blocked += 1;
            if (row.status === 'error') group.errors += 1;
            if (row.archiveHref !== null) group.archived += 1;
            group.items.push(row);
        }
        for (const group of groups.values()) {
            // Worst first inside an issuer: a gone document is the one worth reading about.
            group.items.sort((a, b) => {
                const rank = (row) => SOURCE_STATUSES.indexOf(row.status);
                return (rank(b) - rank(a)) || a.title.full.localeCompare(b.title.full);
            });
        }
        // Most-watched issuer first, but the sources we could not attribute to an issuer go LAST
        // however many there are (51 of 337 on 2026-09-17): "No issuer recorded" is not an issuer,
        // and leading the section with it reads as though it were the biggest one.
        return [...groups.values()].sort((a, b) => {
            if ((a.slug === UNATTRIBUTED) !== (b.slug === UNATTRIBUTED)) return a.slug === UNATTRIBUTED ? 1 : -1;
            return (b.count - a.count) || a.name.localeCompare(b.name);
        });
    }

    /**
     * What a change event was read from. A document diff names the source version it came from; an
     * on-chain change names the account and the slot; a market change names the two snapshot dates.
     * Whatever is there is shown — this is the line that stops the feed being an assertion.
     */
    function changeEvidence(row, sourceIndex) {
        const ev = row?.evidence && typeof row.evidence === 'object' ? row.evidence : {};
        const subjectId = str(row?.subject_id);
        const source = sourceIndex instanceof Map && str(row?.subject_type) === 'source'
            ? sourceIndex.get(subjectId) ?? null
            : null;
        const url = str(ev.url) ?? source?.url ?? null;
        const label = source?.title?.full ?? str(ev.title) ?? url;
        const parts = [];
        if (str(ev.account) !== null) parts.push(`account ${truncate(ev.account, 20).text}`);
        if (num(ev.slot) !== null) parts.push(`slot ${fmtNumber(ev.slot)}`);
        if (str(ev.signature) !== null) parts.push(`tx ${truncate(ev.signature, 16).text}`);
        const snapshots = Array.isArray(ev.snapshotDates) ? ev.snapshotDates.filter((d) => str(d) !== null) : [];
        if (snapshots.length > 0) parts.push(`snapshots ${snapshots.join(' → ')}`);
        if (num(ev.diffAdded) !== null || num(ev.diffRemoved) !== null) {
            parts.push(`+${num(ev.diffAdded) ?? 0} −${num(ev.diffRemoved) ?? 0} lines`);
        }
        return {
            label: label === null ? null : truncate(label, TITLE_MAX),
            href: isSafeUrl(url) ? url : null,
            // A document diff's evidence IS the document the event is about, so repeating its
            // title a second time in the same row says nothing; the renderer names the version
            // instead. Anything else (an on-chain account, a market snapshot) is new information.
            sameAsSubject: source !== null && isSafeUrl(url) && url === source.href,
            archiveHref: isSafeUrl(source?.archiveHref) ? source.archiveHref : null,
            versionFetchedAt: str(ev.versionFetchedAt),
            diffExcerpt: str(ev.diffExcerpt),
            parts
        };
    }

    /** What the page says under every model assessment, so nobody reads it as a finding. */
    const MODEL_ASSESSMENT_DISCLAIMER = "A model's reading of the change, not a legal conclusion.";
    const DIFF_EXCERPT_MAX = 4000;

    /**
     * `modelAssessment` from /api/changes, shaped for the row — or null when there is nothing to
     * show. Only a `valid` judgment is shown: the API sends an invalid one as `{status:'invalid'}`
     * with no text precisely so that a reading which failed its own checks (a quote not found
     * verbatim in the change) never reaches a reader. A valid one missing its verdict is treated
     * the same way rather than printed half-empty. Quotes are the model's fragments of the change,
     * already checked verbatim by the judge, and are printed as they are.
     */
    function modelAssessmentView(raw) {
        if (!raw || typeof raw !== 'object' || raw.status !== 'valid') return null;
        if (typeof raw.material !== 'boolean') return null;
        const summary = str(raw.summary);
        if (summary === null) return null;
        const severity = SEVERITIES.includes(str(raw.severity)) ? str(raw.severity) : null;
        const strings = (list) => (Array.isArray(list) ? list.map(str).filter((v) => v !== null) : []);
        const cost = num(raw.costUsd);
        const confidence = num(raw.confidence);
        return {
            material: raw.material,
            materialLabel: raw.material ? 'material' : 'not material',
            materialTone: raw.material ? 'caution' : 'info',
            severity,
            affects: strings(raw.affects).map(humanizeSlug),
            summary,
            quotes: strings(raw.quotedChange),
            model: str(raw.model),
            promptVersion: str(raw.promptVersion),
            costLabel: cost === null ? null : `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`,
            confidenceLabel: confidence === null || confidence < 0 || confidence > 1
                ? null : `${Math.round(confidence * 100)} % confidence`,
            judgedAt: str(raw.judgedAt)
        };
    }

    /**
     * The "Model assessment" block for one change row, or '' when there is none. Pure markup from
     * a modelAssessmentView() result: every value is escaped, and the disclaimer is part of the
     * block rather than a page note, so the block cannot be screenshotted without it.
     */
    function modelAssessmentHtml(view) {
        if (view === null || view === undefined) return '';
        const tone = (text, cls, title) => `<span class="wat-chip wat-tone-${escapeHtml(cls)}"`
            + `${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(text)}</span>`;
        const affects = view.affects.length === 0
            ? ''
            : `<p class="wat-model-affects"><span class="wat-model-key">affects</span> ${escapeHtml(view.affects.join(', '))}</p>`;
        const quotes = view.quotes.length === 0
            ? ''
            : `<ul class="wat-model-quotes" aria-label="Fragments the model quoted from the change">${view.quotes
                .map((q) => `<li><q>${escapeHtml(q)}</q></li>`).join('')}</ul>`;
        const meta = [
            view.model === null ? null : `<code>${escapeHtml(view.model)}</code>`,
            view.promptVersion === null ? null : `prompt ${escapeHtml(view.promptVersion)}`,
            view.confidenceLabel === null ? null : escapeHtml(view.confidenceLabel),
            view.costLabel === null ? null : `cost ${escapeHtml(view.costLabel)}`,
            view.judgedAt === null ? null : `read ${escapeHtml(fmtDateTime(view.judgedAt))}`
        ].filter((part) => part !== null).join(' · ');
        return `<aside class="wat-model" aria-label="Model assessment">
            <p class="wat-model-head"><strong class="wat-model-title">Model assessment</strong>
                ${tone(view.materialLabel, view.materialTone, 'does this change alter what a holder owns, can do, or can have done to them?')}
                ${view.severity === null ? '' : tone(view.severity, view.severity, `model severity: ${view.severity}`)}</p>
            ${affects}
            <p class="wat-model-summary">${escapeHtml(view.summary)}</p>
            ${quotes}
            <p class="wat-model-meta">${meta}</p>
            <p class="wat-model-note">${escapeHtml(MODEL_ASSESSMENT_DISCLAIMER)}</p>
        </aside>`;
    }

    /**
     * The change feed's rows. The subject is whatever the event is about: a token links to its
     * card by SYMBOL (the card files are named by symbol, so a mint with no token row in the API
     * gets a shortened mint and no link rather than a 404), an issuer links to its dossier, a
     * source links to the document itself.
     */
    function changeRows(changes, context) {
        const list = Array.isArray(changes) ? changes : (Array.isArray(changes?.items) ? changes.items : []);
        const names = context?.names instanceof Map ? context.names : new Map();
        const sourceIndex = context?.sources instanceof Map ? context.sources : new Map();
        const tokens = context?.tokens instanceof Map ? context.tokens : new Map();
        return list.map((row) => {
            const subjectType = str(row?.subject_type) ?? 'issuer';
            const subjectId = str(row?.subject_id);
            const issuerSlug = resolveIssuerSlug(row?.issuer_slug, names);
            const severity = SEVERITIES.includes(str(row?.severity)) ? str(row.severity) : 'info';
            const kind = str(row?.kind) ?? 'unknown';
            let subjectLabel = subjectId === null ? DASH : subjectId;
            let subjectHref = null;
            let subjectNote = null;
            if (subjectType === 'token') {
                const token = tokens.get(subjectId) ?? null;
                const symbol = str(token?.symbol);
                subjectLabel = symbol ?? truncate(subjectId, 12).text;
                subjectHref = symbol === null ? null : cardHref(symbol, subjectId, token?.cardSlug);
                subjectNote = str(token?.name) ?? subjectId;
            } else if (subjectType === 'issuer') {
                subjectLabel = issuerSlug === null ? DASH : (names.get(issuerSlug) ?? humanizeSlug(issuerSlug));
                subjectHref = issuerSlug === null ? null : dossierHref(issuerSlug);
            } else if (subjectType === 'source') {
                const source = sourceIndex.get(subjectId) ?? null;
                subjectLabel = source?.title?.text ?? truncate(subjectId, 14).text;
                subjectHref = source?.href ?? null;
                subjectNote = source?.url ?? subjectId;
            }
            const shaped = {
                id: str(row?.id),
                detectedAt: str(row?.detected_at),
                kind,
                kindLabel: CHANGE_KIND_LABELS[kind] ?? humanizeSlug(kind),
                severity,
                subjectType,
                subjectId,
                subjectLabel,
                subjectHref,
                subjectNote,
                issuerSlug,
                issuerName: issuerSlug === null ? null : (names.get(issuerSlug) ?? humanizeSlug(issuerSlug)),
                issuerHref: issuerSlug === null || !names.has(issuerSlug) ? null : dossierHref(issuerSlug),
                // An `issuer` event's subject already IS the issuer, so naming it twice in one row
                // (the Backpack programme name repeated twice) says nothing the first
                // one did not.
                issuerIsSubject: subjectType === 'issuer',
                field: str(row?.field),
                before: shapeValue(row?.before, VALUE_MAX),
                after: shapeValue(row?.after, VALUE_MAX),
                summary: truncate(row?.summary, SUMMARY_MAX),
                acknowledgedAt: str(row?.acknowledged_at),
                evidence: changeEvidence(row, sourceIndex),
                assessment: modelAssessmentView(row?.modelAssessment)
            };
            shaped.impact = holderImpact({ ...row, ...shaped });
            return shaped;
        });
    }

    /**
     * Integer percentages that sum to exactly 100: floor everything, then hand the remainder to
     * the largest fractional parts. A bar whose segments sum to 99 leaves a sliver of background
     * showing, which reads as a category nobody named.
     */
    function sharesOf(counts, total) {
        const rows = counts.map((count) => (isNum(count) && count > 0 ? count : 0));
        const sum = isNum(total) && total > 0 ? total : 0;
        if (sum === 0) return rows.map(() => 0);
        const exact = rows.map((count) => (count / sum) * 100);
        const floored = exact.map((value) => Math.floor(value));
        let left = 100 - floored.reduce((a, b) => a + b, 0);
        const order = exact
            .map((value, index) => ({ index, frac: value - Math.floor(value) }))
            .sort((a, b) => b.frac - a.frac || a.index - b.index);
        for (const entry of order) {
            if (left <= 0) break;
            // Only a segment that exists at all may be rounded up.
            if (rows[entry.index] === 0) continue;
            floored[entry.index] += 1;
            left -= 1;
        }
        return floored;
    }

    /**
     * One freshness bar per issuer, from the per-issuer claim summary the API already computes.
     * `coverage` is the DOSSIER's own "fields that need a source" figure when a caller has it (the
     * `evidence` block in stocks-issuers.json); without it the denominator is the number of distinct
     * fields that carry a claim at all, and `basis` says which of the two is being shown so the
     * page can never present one as the other.
     */
    function freshnessBars(entries) {
        const list = Array.isArray(entries) ? entries : [];
        return list.map((entry) => {
            const summary = entry?.summary && typeof entry.summary === 'object' ? entry.summary : {};
            const slug = str(entry?.slug);
            const counts = {
                // Historical editorial corrections are current confirmed claims in the public
                // product. Their internal audit status must not become a reader-facing category.
                confirmed: (num(summary.confirmed) ?? 0) + (num(summary.corrected) ?? 0),
                changed: num(summary.changed) ?? 0,
                inference: num(summary.inference) ?? 0,
                unverified: num(summary.unverified) ?? 0,
                'source-gone': num(summary.source_gone) ?? 0
            };
            const claims = num(summary.claims) ?? CLAIM_STATUSES.reduce((sum, key) => sum + counts[key], 0);
            const shares = sharesOf(CLAIM_STATUSES.map((key) => counts[key]), claims);
            const coverage = entry?.coverage && typeof entry.coverage === 'object' ? entry.coverage : null;
            const sourced = coverage === null ? num(summary.fields_sourced) : num(coverage.sourced);
            const needed = coverage === null ? num(summary.fields_with_claims) : num(coverage.needed);
            return {
                slug,
                name: str(entry?.name) ?? (slug === null ? DASH : humanizeSlug(slug)),
                href: slug === null ? null : dossierHref(slug),
                claims,
                segments: CLAIM_STATUSES.map((key, index) => ({
                    status: key,
                    label: CLAIM_STATUS_LABELS[key] ?? key,
                    tone: CLAIM_STATUS_TONE[key] ?? 'info',
                    count: counts[key],
                    pct: shares[index]
                })).filter((segment) => segment.count > 0),
                sourced,
                needed,
                basis: coverage === null ? 'claims' : 'dossier',
                lastCheckedAt: str(summary.last_checked_at),
                lastAccessedAt: str(summary.last_accessed_at)
            };
        }).sort((a, b) => (b.claims - a.claims) || a.name.localeCompare(b.name));
    }

    /** One claim, shaped for the lookup list: the words, where they are, and when we looked. */
    function claimRows(claims) {
        const list = Array.isArray(claims) ? claims : (Array.isArray(claims?.items) ? claims.items : []);
        return list.map((row) => {
            const rawStatus = str(row?.status);
            const status = rawStatus === 'contradicted-corrected'
                ? 'confirmed'
                : CLAIM_STATUSES.includes(rawStatus) ? rawStatus : 'unverified';
            const url = str(row?.url);
            const archive = str(row?.source_archive_url);
            const rawTitle = str(row?.source_title);
            const sourceName = rawTitle !== null && !isFieldPathTitle(rawTitle) ? rawTitle : null;
            const value = row?.value === null || row?.value === undefined
                ? ''
                : (typeof row.value === 'string' ? row.value : JSON.stringify(row.value));
            return {
                id: str(row?.id),
                field: str(row?.field) ?? DASH,
                issuerSlug: str(row?.issuer_slug),
                subjectType: str(row?.subject_type),
                status,
                statusLabel: CLAIM_STATUS_LABELS[status] ?? status,
                tone: CLAIM_STATUS_TONE[status] ?? 'info',
                method: str(row?.method) ?? 'manual',
                value: truncate(value, VALUE_MAX),
                quote: truncate(row?.quote, QUOTE_MAX),
                note: truncate(row?.note, SUMMARY_MAX),
                // Same treatment as the registry list: a "title" that is only the dossier field
                // path is not a document's name, so the URL is shown instead.
                sourceTitle: truncate(sourceName ?? urlLabel(url) ?? url, TITLE_MAX),
                citedAs: sourceName === null ? str(row?.source_title) : null,
                sourceHref: isSafeUrl(url) ? url : null,
                archiveHref: isSafeUrl(archive) ? archive : null,
                locator: truncate(row?.locator, VALUE_MAX * 2),
                accessedAt: str(row?.accessed_at),
                recordedAt: str(row?.recorded_at),
                lastCheckedAt: str(row?.last_checked_at),
                lastConfirmedAt: str(row?.last_confirmed_at)
            };
        });
    }

    /**
     * The claims lookup's text filter, over the FIELD PATH, case-insensitively. It runs here rather
     * than in SQL because `/api/claims?field=` is an exact match: `redemption` would return nothing
     * while the field is `redemption.rails`. Empty text is every row, never zero rows.
     */
    function filterClaimRows(rows, text) {
        const list = Array.isArray(rows) ? rows : [];
        const needle = (str(text) ?? '').toLowerCase();
        if (needle === '') return list;
        return list.filter((row) => String(row?.field ?? '').toLowerCase().includes(needle));
    }

    /** The deliberately small public journal shape. Unknown fields never become executable HTML. */
    function journalRows(payload) {
        const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.items) ? payload.items : []);
        return list.map((row) => {
            const shaped = {
            id: str(row?.id),
            date: str(row?.date),
            eventAt: str(row?.eventAt),
            effectiveAt: str(row?.effectiveAt),
            firstObservedAt: str(row?.firstObservedAt),
            reviewedAt: str(row?.reviewedAt),
            category: str(row?.category) ?? 'actor-change',
            kind: str(row?.kind) ?? 'change',
            severity: SEVERITIES.includes(str(row?.severity)) ? str(row.severity) : 'info',
            title: str(row?.title) ?? 'Recorded change',
            summary: str(row?.summary),
            whyItMatters: str(row?.whyItMatters),
            consequence: str(row?.consequence) ?? str(row?.whyItMatters),
            actor: str(row?.actor),
            affectedHolders: (Array.isArray(row?.affectedHolders) ? row.affectedHolders : []).map(str).filter(Boolean),
            before: row?.before === null || row?.before === undefined ? null : String(row.before),
            after: row?.after === null || row?.after === undefined ? null : String(row.after),
            href: isSafeUrl(row?.href) ? row.href : null,
            assets: (Array.isArray(row?.assets) ? row.assets : []).map((asset) => ({
                mint: str(asset?.mint), symbol: str(asset?.symbol), name: str(asset?.name),
                operationalStatus: str(asset?.operationalStatus),
                href: isSafeUrl(asset?.href) ? asset.href : null
            })),
            sources: (Array.isArray(row?.sources) ? row.sources : []).map((source) => ({
                label: str(source?.label) ?? 'Source',
                url: isSafeUrl(source?.url) ? source.url : null
            })).filter((source) => source.url !== null)
            };
            shaped.impact = holderImpact({ ...row, ...shaped });
            return shaped;
        });
    }

    /**
     * True only when an event carries NO evidence at all. A slot or an account with no document
     * behind it is still evidence, so a row must not print "no evidence recorded" beside one —
     * which is exactly what the chain watcher's first rows did.
     */
    function evidenceIsEmpty(evidence) {
        if (!evidence || typeof evidence !== 'object') return true;
        const parts = Array.isArray(evidence.parts) ? evidence.parts : [];
        return evidence.label === null && parts.length === 0 && str(evidence.versionFetchedAt) === null;
    }

    /** One line saying which API call failed and how, so a red page names its own cause. */
    function describeApiFailure({ path, status, message } = {}) {
        const where = str(path) ?? 'the API';
        if (isNum(status)) return `${where} answered HTTP ${status}.`;
        const why = str(message);
        return why === null ? `${where} did not answer.` : `${where} did not answer: ${why}`;
    }

    /**
     * A monotonic request token. A change-feed filter can be clicked faster than the API answers,
     * and the slow earlier answer must not repaint a feed the reader has already moved off.
     */
    function createSequence() {
        let current = 0;
        return {
            next() {
                current += 1;
                return current;
            },
            isCurrent(token) {
                return token === current;
            }
        };
    }

    const api = {
        TONES,
        SOURCE_KINDS,
        SOURCE_STATUSES,
        UNATTRIBUTED,
        SOURCE_STATUS_TONE,
        SOURCE_STATUS_BLURBS,
        SOURCE_KIND_BLURBS,
        CHANGE_KINDS,
        CHANGE_KIND_LABELS,
        SEVERITIES,
        IMPACT_LEVELS,
        holderImpact,
        rankByHolderImpact,
        impactGroups,
        journalIdentity,
        journalTimeLabel,
        journalVisitSummary,
        CLAIM_STATUSES,
        CLAIM_STATUS_LABELS,
        CLAIM_STATUS_BLURBS,
        CLAIM_STATUS_TONE,
        SINCE_CHOICES,
        SOURCES_PER_CALL,
        CHANGES_PER_CALL,
        CLAIMS_PER_CALL,
        TITLE_MAX,
        QUOTE_MAX,
        VALUE_MAX,
        HASH_MAX,
        truncate,
        isHashLike,
        isFieldPathTitle,
        urlLabel,
        shapeValue,
        sinceIso,
        pageOffsets,
        issuerNames,
        resolveIssuerSlug,
        dossierHref,
        cardHref,
        laterIso,
        sourceTotals,
        sourceRow,
        sourcesByIssuer,
        changeEvidence,
        changeRows,
        MODEL_ASSESSMENT_DISCLAIMER,
        DIFF_EXCERPT_MAX,
        modelAssessmentView,
        modelAssessmentHtml,
        sharesOf,
        freshnessBars,
        claimRows,
        filterClaimRows,
        journalRows,
        evidenceIsEmpty,
        describeApiFailure,
        createSequence
    };

    // -----------------------------------------------------------------------
    // DOM section — only runs in a browser. Builds markup and wires events.
    // -----------------------------------------------------------------------

    if (typeof document === 'undefined') return api;

    const apiLib = (typeof __rwaApi !== 'undefined') ? __rwaApi : null;

    const state = {
        names: new Map(),
        sources: [],
        sourceIndex: new Map(),
        totals: null,
        groups: [],
        expanded: new Set(),
        changeItems: [],
        changes: [],
        changeTotal: 0,
        changeFilters: { kind: '', severity: '', issuer: '' },
        material: false,
        changeNote: null,
        since: 'all',
        tokens: new Map(),
        freshness: [],
        claimIssuer: null,
        claimRows: [],
        claimText: '',
        claimTotal: 0,
        journal: [],
        journalVisit: null,
        focusedWatches: []
    };

    const els = {};
    const changeSequence = createSequence();
    const claimSequence = createSequence();
    let base = '';

    /** One timestamped line per failure. Nothing else is logged: a healthy page is silent. */
    function logError(message, detail) {
        console.error(`[${new Date().toISOString()}] watch: ${message}`, detail ?? '');
    }

    function setStatus(message, isError) {
        if (!els.status) return;
        els.status.hidden = message === null;
        els.status.classList.toggle('status-error', Boolean(isError));
        els.status.textContent = message ?? '';
    }

    function apiFailure(url, status, message) {
        const err = new Error(describeApiFailure({ path: url, status, message }));
        err.api = { path: url, status, message };
        return err;
    }

    async function getJson(path, params) {
        const url = apiLib.apiUrl(path, params, base);
        let res;
        try {
            res = await fetch(url, { cache: 'no-store' });
        } catch (err) {
            throw apiFailure(url, null, err.message);
        }
        if (!res.ok) throw apiFailure(url, res.status, null);
        return res.json();
    }

    async function watchRequest(method, path, key = null, body = null) {
        const headers = { Accept: 'application/json' };
        if (key) headers['X-Watch-Key'] = key;
        if (body !== null) headers['Content-Type'] = 'application/json';
        const url = apiLib.apiUrl(`/api${path}`, {}, base);
        let res;
        try {
            res = await fetch(url, { method, headers, body: body === null ? undefined : JSON.stringify(body), cache: 'no-store' });
        } catch (err) {
            throw apiFailure(url, null, err.message);
        }
        const payload = res.status === 204 ? null : await res.json().catch(() => null);
        if (!res.ok) throw apiFailure(url, res.status, payload?.error?.message ?? null);
        return payload;
    }

    function focusedCredentials() {
        try {
            const rows = JSON.parse(window.localStorage.getItem('rwa-sonar-focused-watches-v1') || '[]');
            return Array.isArray(rows) ? rows.filter((row) => row?.watchId && row?.watchKey) : [];
        } catch (_) {
            return [];
        }
    }

    function storeFocusedCredentials(rows) {
        window.localStorage.setItem('rwa-sonar-focused-watches-v1', JSON.stringify(rows));
    }

    function watchTargetLabel(watch) {
        if (watch.type === 'token') return `Token ${watch.target?.mint ?? DASH}`;
        if (watch.type === 'issuer') return `Issuer ${watch.target?.issuerSlug ?? DASH}`;
        if (watch.type === 'protocol-market') {
            return `${watch.target?.integrationId ?? 'Protocol'} · ${watch.target?.marketKey ?? DASH} · token ${watch.target?.mint ?? DASH}`;
        }
        return `${watch.ticker ?? DASH} · ${(watch.issuers ?? []).join(', ')}`;
    }

    function focusedShareUrl(watchId, readKey) {
        const url = new URL(window.location.href);
        url.search = '';
        url.hash = `saved=${watchId}.${readKey}`;
        return url.toString();
    }

    function renderFocusedWatches() {
        if (!els.savedWatchList) return;
        if (state.focusedWatches.length === 0) {
            els.savedWatchList.innerHTML = '<p class="wat-empty">No focused watches are stored in this browser yet.</p>';
            return;
        }
        els.savedWatchList.innerHTML = state.focusedWatches.map(({ watch, credential }) => {
            const changes = Array.isArray(watch.changes) ? watch.changes : [];
            const status = watch.baselineRecorded
                ? changes.length ? `${changes.length} material change${changes.length === 1 ? '' : 's'} in the latest daily check.` : 'No material change in the latest daily check.'
                : 'The first daily baseline is pending.';
            const share = credential.readKey ? focusedShareUrl(watch.watchId, credential.readKey) : null;
            return `<article class="wat-saved-card" data-watch-id="${escapeHtml(watch.watchId)}">
                <h3>${escapeHtml(watch.title || watchTargetLabel(watch))}</h3>
                <p>${escapeHtml(watchTargetLabel(watch))}</p><p>${escapeHtml(status)}</p>
                <div class="wat-saved-actions">${share ? `<a data-copy-share href="${escapeHtml(share)}">Copy read-only link</a>` : ''}
                    <button type="button" data-delete-watch>Delete watch</button></div></article>`;
        }).join('');
    }

    function renderSharedWatch(watch) {
        if (!els.sharedWatchView) return;
        const changes = Array.isArray(watch.changes) ? watch.changes : [];
        els.sharedWatchView.hidden = false;
        els.sharedWatchView.innerHTML = `<h3>${escapeHtml(watch.title || watchTargetLabel(watch))}</h3>
            <p>${escapeHtml(watchTargetLabel(watch))}</p>
            <p>${watch.baselineRecorded ? `${fmtNumber(changes.length)} material change${changes.length === 1 ? '' : 's'} in the latest daily check.` : 'The first daily baseline is pending.'}</p>
            ${changes.length ? `<ul>${changes.map((change) => `<li>${escapeHtml(change.summary ?? String(change))}</li>`).join('')}</ul>` : ''}
            <p class="wat-muted">Read-only shared watch. Editing and deletion require the owner key, which is not in this link.</p>`;
    }

    function setFocusedFields() {
        const type = els.focusedWatchType.value;
        els.focusedMintField.hidden = type === 'issuer';
        els.focusedIssuerField.hidden = type !== 'issuer';
        els.focusedIntegrationField.hidden = type !== 'protocol-market';
        els.focusedMarketField.hidden = type !== 'protocol-market';
        els.focusedMint.required = type !== 'issuer';
        els.focusedIssuer.required = type === 'issuer';
        els.focusedIntegration.required = type === 'protocol-market';
        els.focusedMarket.required = type === 'protocol-market';
    }

    function focusedPayload() {
        const type = els.focusedWatchType.value;
        const target = type === 'issuer'
            ? { issuerSlug: els.focusedIssuer.value }
            : type === 'protocol-market'
                ? { mint: els.focusedMint.value.trim(), integrationId: els.focusedIntegration.value.trim(), marketKey: els.focusedMarket.value.trim() }
                : { mint: els.focusedMint.value.trim() };
        return { type, target, title: els.focusedTitle.value.trim() || null };
    }

    async function saveFocusedWatch(event) {
        event.preventDefault();
        els.focusedWatchSave.disabled = true;
        els.focusedWatchStatus.dataset.error = 'false';
        els.focusedWatchStatus.textContent = 'Saving the watch…';
        try {
            const watch = await watchRequest('POST', '/watchlists', null, focusedPayload());
            const credential = { watchId: watch.watchId, watchKey: watch.watchKey, readKey: watch.readKey };
            const rows = focusedCredentials().filter((row) => row.watchId !== watch.watchId);
            rows.push(credential);
            storeFocusedCredentials(rows);
            state.focusedWatches.push({ watch, credential });
            renderFocusedWatches();
            els.focusedWatchStatus.textContent = 'Saved. The next daily pass records its baseline; later material changes appear here.';
        } catch (err) {
            els.focusedWatchStatus.dataset.error = 'true';
            els.focusedWatchStatus.textContent = err.message;
        } finally {
            els.focusedWatchSave.disabled = false;
        }
    }

    async function loadFocusedWatches() {
        const credentials = focusedCredentials();
        const loaded = await Promise.all(credentials.map(async (credential) => {
            try {
                const watch = await watchRequest('GET', `/watchlists/${credential.watchId}`, credential.watchKey);
                return { watch, credential };
            } catch (err) {
                logError(`saved watch ${credential.watchId} did not answer`, err.message);
                return null;
            }
        }));
        state.focusedWatches = loaded.filter(Boolean);
        renderFocusedWatches();
        const shared = window.location.hash.match(/^#saved=([0-9a-f-]{36})\.([A-Za-z0-9_-]{24,80})$/i);
        if (shared) {
            try {
                renderSharedWatch(await watchRequest('GET', `/watchlists/${shared[1]}`, shared[2]));
            } catch (err) {
                els.sharedWatchView.hidden = false;
                els.sharedWatchView.textContent = `Could not open the shared watch: ${err.message}`;
            }
        }
    }

    /** A relative time with the exact instant on hover — the convention the other pages use. */
    function timeCell(iso) {
        if (str(iso) === null) return `<span class="wat-muted">${escapeHtml(DASH)}</span>`;
        return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(fmtDateTime(iso))}">${escapeHtml(fmtRelativeTime(iso))}</time>`;
    }

    function chip(text, tone, title) {
        const attr = str(title) === null ? '' : ` title="${escapeHtml(title)}"`;
        return `<span class="wat-chip wat-tone-${escapeHtml(tone ?? 'info')}"${attr}>${escapeHtml(text)}</span>`;
    }

    /** A value with its full text on hover when it was cut. Never silently shortened. */
    function cut(shape, className) {
        const cls = str(className) === null ? 'wat-cut' : `wat-cut ${className}`;
        if (!shape || shape.empty) return `<span class="wat-muted">${escapeHtml(DASH)}</span>`;
        const attr = shape.truncated ? ` title="${escapeHtml(shape.full)}"` : '';
        return `<span class="${escapeHtml(cls)}"${attr}>${escapeHtml(shape.text)}</span>`;
    }

    function link(href, text, className) {
        const label = escapeHtml(text);
        if (str(href) === null || !isSafeUrl(href)) return `<span class="${escapeHtml(className ?? '')}">${label}</span>`;
        return `<a class="${escapeHtml(className ?? '')}" href="${escapeHtml(href)}">${label}</a>`;
    }

    function renderDataLine() {
        const totals = state.totals;
        if (els.sourceCount) els.sourceCount.textContent = fmtNumber(totals?.total ?? null);
        if (els.claimCountLine) els.claimCountLine.textContent = fmtNumber(state.claimTotal || null);
        if (els.changeCountLine) els.changeCountLine.textContent = fmtNumber(state.changeTotal);
        if (els.lastSweep) {
            const iso = totals?.lastSweepAt ?? null;
            els.lastSweep.textContent = iso === null ? DASH : fmtRelativeTime(iso);
            els.lastSweep.setAttribute('datetime', iso ?? '');
            els.lastSweep.title = iso === null ? '' : fmtDateTime(iso);
        }
    }

    function renderSourceTiles() {
        const totals = state.totals;
        if (!els.sourceTiles) return;
        if (totals === null) {
            els.sourceTiles.innerHTML = '<p class="wat-empty">The source registry did not load.</p>';
            return;
        }
        const kindTiles = totals.byKind.map((tile) => `<div class="wat-tile wat-tile-kind">
            <span class="wat-tile-count">${escapeHtml(fmtNumber(tile.count))}</span>
            <span class="wat-tile-label">${escapeHtml(tile.label)}</span>
            <span class="wat-tile-blurb">${escapeHtml(tile.blurb)}</span>
        </div>`).join('');
        const statusTiles = totals.byStatus.map((tile) => `<div class="wat-tile wat-tile-${escapeHtml(tile.tone)}">
            <span class="wat-tile-count">${escapeHtml(fmtNumber(tile.count))}</span>
            <span class="wat-tile-label">${escapeHtml(tile.label)}</span>
            <span class="wat-tile-blurb">${escapeHtml(tile.blurb)}</span>
        </div>`).join('');
        els.sourceTiles.innerHTML = `<div class="wat-tiles">${kindTiles}</div>
            <h3 class="wat-subhead">And what the last sweep found</h3>
            <div class="wat-tiles">${statusTiles}</div>
            <p class="wat-tile-foot">${escapeHtml(fmtNumber(totals.versions))} stored versions ·
            ${escapeHtml(fmtNumber(totals.claims))} claims read from these sources ·
            ${escapeHtml(fmtNumber(totals.archived))} with a Wayback copy
            (${escapeHtml(fmtPct(totals.total === 0 ? null : (totals.archived / totals.total) * 100))}) ·
            ${escapeHtml(fmtNumber(totals.errors))} carrying a fetch error</p>`;
    }

    function sourceListItem(row) {
        const title = row.href === null
            ? cut(row.title, 'wat-source-title')
            : `<a class="wat-source-title" href="${escapeHtml(row.href)}"${row.title.truncated ? ` title="${escapeHtml(row.title.full)}"` : ''}>${escapeHtml(row.title.text)}</a>`;
        const archive = row.archiveHref === null
            ? ''
            : ` · <a class="wat-archive" href="${escapeHtml(row.archiveHref)}">archived copy</a>`;
        const error = row.error.empty
            ? ''
            : `<p class="wat-source-error">${cut(row.error)}</p>`;
        const capture = row.captureNote === null
            ? ''
            : `<p class="wat-source-meta wat-source-capture"${row.captureAt === null ? '' : ` title="${escapeHtml(row.captureAt)}"`}>${escapeHtml(row.captureNote)}</p>`;
        return `<li class="wat-source">
            ${title}
            <p class="wat-source-meta">${chip(row.kind, 'info', SOURCE_KIND_BLURBS[row.kind] ?? '')}
                ${chip(row.status, row.tone, SOURCE_STATUS_BLURBS[row.status] ?? '')}
                ${str(row.citedAs) === null ? '' : `cited as <code>${escapeHtml(row.citedAs)}</code> ·`}
                checked ${timeCell(row.lastCheckedAt)} ·
                ${escapeHtml(fmtNumber(row.versions))} version(s) ·
                ${escapeHtml(fmtNumber(row.claims))} claim(s)${archive}</p>
            ${capture}
            ${error}
        </li>`;
    }

    function renderIssuerRows() {
        if (!els.issuerRows) return;
        if (state.groups.length === 0) {
            els.issuerRows.innerHTML = '<li class="wat-empty">No source is registered yet.</li>';
            return;
        }
        els.issuerRows.innerHTML = state.groups.map((group) => {
            const open = state.expanded.has(group.slug);
            const panelId = `sources-${group.slug}`;
            const flags = [
                group.changed > 0 ? chip(`${fmtNumber(group.changed)} changed`, 'caution', 'the text moved since we last read it') : '',
                group.gone > 0 ? chip(`${fmtNumber(group.gone)} gone`, 'critical', 'nothing left to re-read') : '',
                group.blocked > 0 ? chip(`${fmtNumber(group.blocked)} blocked`, 'warning', 'the host refuses us') : '',
                group.errors > 0 ? chip(`${fmtNumber(group.errors)} error`, 'warning', 'the fetch failed') : ''
            ].join(' ');
            const name = `<span class="wat-issuer-name">${escapeHtml(group.name)}</span>`;
            const dossier = group.href === null
                ? ''
                : `<a class="wat-dossier" href="${escapeHtml(group.href)}">dossier &rarr;</a>`;
            return `<li class="wat-issuer">
                <button type="button" class="wat-issuer-head" data-slug="${escapeHtml(group.slug)}"
                    aria-expanded="${open ? 'true' : 'false'}" aria-controls="${escapeHtml(panelId)}">
                    <span class="wat-caret" aria-hidden="true">${open ? '▾' : '▸'}</span>
                    ${name}
                    <span class="wat-issuer-counts">
                        <span class="wat-issuer-figure">${escapeHtml(fmtNumber(group.count))} sources</span>
                        <span class="wat-issuer-figure">${escapeHtml(fmtNumber(group.archived))} archived</span>
                        <span class="wat-issuer-figure">checked ${timeCell(group.lastCheckedAt)}</span>
                        ${flags}
                    </span>
                </button>
                ${dossier}
                <div class="wat-issuer-body" id="${escapeHtml(panelId)}"${open ? '' : ' hidden'}>
                    <ul class="wat-source-list">${open ? group.items.map(sourceListItem).join('') : ''}</ul>
                </div>
            </li>`;
        }).join('');
    }

    function renderSinceChips() {
        if (!els.sinceChips) return;
        els.sinceChips.innerHTML = SINCE_CHOICES.map((choice) => `<button type="button"
            class="wat-since${choice.key === state.since ? ' wat-since-active' : ''}"
            data-since="${escapeHtml(choice.key)}" aria-pressed="${choice.key === state.since ? 'true' : 'false'}"
            >${escapeHtml(choice.label)}</button>`).join('');
    }

    function renderJournal() {
        if (!els.journalList) return;
        const unseen = new Set((state.journalVisit?.unseen ?? []).map(journalIdentity));
        els.journalList.innerHTML = state.journal.length === 0
            ? '<li class="wat-empty">No public changes are recorded yet.</li>'
            : impactGroups(state.journal).map((group) => `<li class="wat-impact-heading wat-impact-${escapeHtml(group.key)}">
                <strong>${escapeHtml(group.label)}</strong><span>${fmtNumber(group.items.length)} change${group.items.length === 1 ? '' : 's'}</span></li>` +
              group.items.map((row) => {
                const isNew = unseen.has(journalIdentity(row));
                const title = row.href ? `<a href="${escapeHtml(row.href)}">${escapeHtml(row.title)}</a>` : escapeHtml(row.title);
                const moved = row.before === null && row.after === null ? '' : `<div class="wat-journal-move">
                    <span>${escapeHtml(row.before ?? DASH)}</span><span aria-hidden="true">→</span><span>${escapeHtml(row.after ?? DASH)}</span></div>`;
                const assetLink = (asset) => {
                    const label = asset.symbol ?? asset.name ?? asset.mint ?? 'token';
                    const linked = asset.href ? `<a href="${escapeHtml(asset.href)}">${escapeHtml(label)}</a>` : escapeHtml(label);
                    const status = asset.operationalStatus ? ` · ${escapeHtml(humanizeSlug(asset.operationalStatus))}` : '';
                    return `${linked}${status}`;
                };
                const visibleAssets = row.assets.slice(0, 6);
                const hiddenAssets = row.assets.slice(6);
                const assets = row.assets.length === 0 ? '' : `<div class="wat-journal-assets">Affected: ${visibleAssets.map(assetLink).join(' · ')}
                    ${hiddenAssets.length === 0 ? '' : `<details><summary>Show ${fmtNumber(hiddenAssets.length)} more exact token addresses</summary><div class="wat-journal-asset-list">${hiddenAssets.map(assetLink).join(' · ')}</div></details>`}</div>`;
                const sources = row.sources.length === 0 ? '' : `<p class="wat-journal-source">${row.sources.map((source) =>
                    `<a href="${escapeHtml(source.url)}">${escapeHtml(source.label)}</a>`).join(' · ')}</p>`;
                const decisionScope = `<p class="wat-journal-scope"><strong>Actor:</strong> ${escapeHtml(row.actor ?? DASH)} · <strong>Affected:</strong> ${escapeHtml(row.affectedHolders.length ? row.affectedHolders.join('; ') : 'holder class not established')}</p>`;
                const anchor = row.id ? `journal-${row.id.replace(/[^A-Za-z0-9_-]/g, '-')}` : '';
                return `<li${anchor ? ` id="${escapeHtml(anchor)}"` : ''} class="wat-journal-item wat-journal-${escapeHtml(row.severity)}${isNew ? ' wat-journal-new' : ''}">
                    <p class="wat-journal-meta">${escapeHtml(journalTimeLabel(row))} · ${isNew ? `${chip('new since your last visit', 'accent', 'This browser had not seen this public journal entry')} · ` : ''}${chip(humanizeSlug(row.kind), row.severity, row.category)} · ${chip(`${row.impact.key} holder impact`, row.impact.key === 'high' ? 'critical' : row.impact.key === 'medium' ? 'caution' : 'info', row.impact.label)}</p>
                    <h3>${title}</h3>
                    ${row.summary ? `<p class="wat-journal-meta">${escapeHtml(row.summary)}</p>` : ''}${moved}
                    ${decisionScope}<p class="wat-journal-why"><strong>Consequence:</strong> ${escapeHtml(row.consequence || row.impact.reason)}</p>
                    ${assets}${sources}</li>`;
            }).join('')).join('');
        const requested = new URLSearchParams(window.location.search).get('journal');
        if (requested) {
            const anchor = `journal-${requested.replace(/[^A-Za-z0-9_-]/g, '-')}`;
            const target = document.getElementById(anchor);
            if (target) {
                target.classList.add('wat-journal-target');
                target.scrollIntoView({ block: 'center' });
            }
        }
        if (els.journalCount) els.journalCount.textContent = `${fmtNumber(state.journal.length)} entries`;
        renderJournalVisit();
    }

    function renderJournalVisit() {
        if (!els.journalVisit || state.journalVisit === null) return;
        const summary = state.journalVisit;
        if (summary.firstVisit) {
            els.journalVisit.innerHTML = '<strong>Your baseline starts here.</strong><span>On your next visit, this browser will show which public, outside-world changes are new. No account or personal data is used.</span>';
            return;
        }
        const when = summary.previousVisitedAt
            ? ` since ${escapeHtml(fmtDateTime(summary.previousVisitedAt))}` : ' since your last visit';
        if (summary.newCount === 0) {
            els.journalVisit.innerHTML = `<strong>You are caught up.</strong><span>No new recorded external changes${when}.</span>`;
            return;
        }
        const high = summary.highImpactCount === 0 ? 'none ranked high impact'
            : `${fmtNumber(summary.highImpactCount)} ranked high impact`;
        els.journalVisit.innerHTML = `<strong>${fmtNumber(summary.newCount)} new change${summary.newCount === 1 ? '' : 's'}${when}</strong><span>${escapeHtml(high)}. New items are included in the impact-ranked journal below.</span>`;
    }

    function readJournalVisit() {
        try {
            const value = JSON.parse(localStorage.getItem('rwa-sonar:journal-visit') || 'null');
            return value && Array.isArray(value.identities) ? value : null;
        } catch {
            return null;
        }
    }

    function writeJournalVisit(summary) {
        try {
            localStorage.setItem('rwa-sonar:journal-visit', JSON.stringify({
                visitedAt: new Date().toISOString(), identities: summary.currentIdentities.slice(0, 1000)
            }));
        } catch {
            // Private browsing or a blocked storage API must not stop the public journal rendering.
        }
    }

    async function loadJournal() {
        const url = './stocks-change-journal.json';
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}.`);
        state.journal = journalRows(await res.json());
        const previous = readJournalVisit();
        state.journalVisit = {
            ...journalVisitSummary(state.journal, previous?.identities),
            previousVisitedAt: str(previous?.visitedAt)
        };
        renderJournal();
        writeJournalVisit(state.journalVisit);
    }

    function changeListItem(row) {
        const subject = row.subjectHref === null
            ? `<span class="wat-subject">${escapeHtml(row.subjectLabel)}</span>`
            : `<a class="wat-subject" href="${escapeHtml(row.subjectHref)}"${str(row.subjectNote) === null ? '' : ` title="${escapeHtml(row.subjectNote)}"`}>${escapeHtml(row.subjectLabel)}</a>`;
        const issuer = row.issuerName === null || row.issuerIsSubject
            ? ''
            : ` · ${link(row.issuerHref, row.issuerName, 'wat-issuer-link')}`;
        const field = row.field === null ? '' : `<dt>field</dt><dd><code>${escapeHtml(row.field)}</code></dd>`;
        const moved = row.before.empty && row.after.empty
            ? ''
            : `<dt>moved</dt><dd class="wat-moved">${cut(row.before, row.before.hashLike ? 'wat-hash' : '')}
                <span class="wat-arrow" aria-hidden="true">&rarr;</span>
                ${cut(row.after, row.after.hashLike ? 'wat-hash' : '')}</dd>`;
        const summary = row.summary.empty ? '' : `<dt>summary</dt><dd>${cut(row.summary)}</dd>`;
        const ev = row.evidence;
        // Built as a list and joined, so a row with a slot but no document never starts with a
        // stray separator and never says "no evidence recorded" beside evidence it does have.
        const evidenceText = ev.sameAsSubject ? 'the version of this document we read' : ev.label?.text;
        const pieces = [];
        if (ev.label !== null) {
            pieces.push(ev.href === null
                ? cut(ev.label)
                : `<a href="${escapeHtml(ev.href)}" title="${escapeHtml(ev.label.full)}">${escapeHtml(evidenceText)}</a>`);
        } else if (evidenceIsEmpty(ev)) {
            pieces.push(`<span class="wat-muted">no evidence recorded</span>`);
        }
        if (ev.parts.length > 0) pieces.push(escapeHtml(ev.parts.join(' · ')));
        if (ev.versionFetchedAt !== null) pieces.push(`read ${timeCell(ev.versionFetchedAt)}`);
        if (ev.archiveHref !== null) pieces.push(`<a href="${escapeHtml(ev.archiveHref)}">archived copy</a>`);
        const evidence = pieces.join(' · ');
        // The diff is what the model read, so it sits directly above the model's reading of it.
        const diff = ev.diffExcerpt === null
            ? ''
            : `<details class="wat-diff"><summary>diff excerpt</summary><pre>${escapeHtml(truncate(ev.diffExcerpt, DIFF_EXCERPT_MAX).text)}</pre></details>`;
        return `<li class="wat-change wat-change-${escapeHtml(row.severity)}">
            <p class="wat-change-head">${timeCell(row.detectedAt)}
                ${chip(row.severity, row.severity, `severity: ${row.severity}`)}
                ${chip(`${row.impact.key} holder impact`, row.impact.key === 'high' ? 'critical' : row.impact.key === 'medium' ? 'caution' : 'info', row.impact.label)}
                ${chip(row.kindLabel, 'info', row.kind)}
                ${subject}${issuer}</p>
            <p class="wat-impact-reason">${escapeHtml(row.impact.reason)}</p>
            <dl class="wat-change-body">${field}${moved}${summary}
                <dt>evidence</dt><dd>${evidence}</dd>
            </dl>
            ${diff}${modelAssessmentHtml(row.assessment)}
        </li>`;
    }

    function renderChanges() {
        if (!els.changeList) return;
        els.changeList.innerHTML = impactGroups(state.changes).map((group) =>
            `<li class="wat-impact-heading wat-impact-${escapeHtml(group.key)}"><strong>${escapeHtml(group.label)}</strong>` +
            `<span>${fmtNumber(group.items.length)} event${group.items.length === 1 ? '' : 's'}</span></li>` +
            group.items.map(changeListItem).join('')).join('');
        const filtered = state.changeFilters.kind !== '' || state.changeFilters.severity !== ''
            || state.changeFilters.issuer !== '' || state.since !== 'all' || state.material;
        if (els.materialChip) {
            els.materialChip.setAttribute('aria-pressed', state.material ? 'true' : 'false');
            els.materialChip.classList.toggle('wat-since-active', state.material);
        }
        if (els.changeEmpty) {
            els.changeEmpty.hidden = state.changes.length > 0;
            const sweep = state.totals?.lastSweepAt ?? null;
            els.changeEmpty.textContent = state.material && state.changeNote !== null
                ? 'The change judge has not assessed any change on this server yet, so nothing can be filtered as material. Clear the chip to see every change.'
                : state.material
                ? 'No change in this window carries a model assessment that calls it material. The model has not read every change; clear the chip to see them all.'
                : filtered
                ? 'No change matches these filters. Widen the window or clear a filter.'
                : `The watchers have not seen a change yet; the first sweep ran ${sweep === null ? 'before this page could read it' : fmtDateTime(sweep)}.`;
        }
        if (els.changeCount) {
            els.changeCount.textContent = state.changes.length === state.changeTotal
                ? `${fmtNumber(state.changeTotal)} event(s)`
                : `${fmtNumber(state.changes.length)} of ${fmtNumber(state.changeTotal)} event(s)`;
        }
        renderDataLine();
    }

    function renderFreshness() {
        if (!els.freshnessList) return;
        if (state.freshness.length === 0) {
            els.freshnessList.innerHTML = '<li class="wat-empty">No claim has been recorded yet.</li>';
            return;
        }
        els.freshnessList.innerHTML = state.freshness.map((row) => {
            const bar = row.segments.map((segment) => `<span class="wat-bar-seg wat-tone-${escapeHtml(segment.tone)}"
                style="width:${segment.pct}%"
                title="${escapeHtml(`${segment.label}: ${fmtNumber(segment.count)} of ${fmtNumber(row.claims)} claims — ${CLAIM_STATUS_BLURBS[segment.status] ?? ''}`)}"></span>`).join('');
            const legend = row.segments.map((segment) => `<span class="wat-legend-item">
                <span class="wat-legend-dot wat-tone-${escapeHtml(segment.tone)}" aria-hidden="true"></span>
                ${escapeHtml(`${segment.label} ${fmtNumber(segment.count)} (${segment.pct}%)`)}</span>`).join('');
            const basis = row.basis === 'dossier'
                ? 'dossier fields that need a source'
                : 'distinct fields that carry a claim at all';
            return `<li class="wat-fresh">
                <p class="wat-fresh-head">${link(row.href, row.name, 'wat-fresh-name')}
                    <span class="wat-fresh-figure">${escapeHtml(fmtNumber(row.claims))} claims</span>
                    <span class="wat-fresh-figure" title="${escapeHtml(`denominator: ${basis}`)}">${escapeHtml(fmtNumber(row.sourced))} of ${escapeHtml(fmtNumber(row.needed))} fields sourced</span>
                    <span class="wat-fresh-figure">checked ${timeCell(row.lastCheckedAt)}</span></p>
                <span class="wat-bar" role="img"
                    aria-label="${escapeHtml(row.segments.map((s) => `${s.label} ${s.pct}%`).join(', '))}">${bar}</span>
                <p class="wat-legend">${legend}</p>
            </li>`;
        }).join('');
    }

    function claimListItem(row) {
        const source = row.sourceHref === null
            ? cut(row.sourceTitle)
            : `<a href="${escapeHtml(row.sourceHref)}"${row.sourceTitle.truncated ? ` title="${escapeHtml(row.sourceTitle.full)}"` : ''}>${escapeHtml(row.sourceTitle.text)}</a>`;
        const archive = row.archiveHref === null ? '' : ` · <a href="${escapeHtml(row.archiveHref)}">archived copy</a>`;
        const quote = row.quote.empty
            ? `<p class="wat-claim-quote wat-muted">No quote — ${escapeHtml(CLAIM_STATUS_BLURBS[row.status] ?? 'see the note')}</p>`
            : `<blockquote class="wat-claim-quote"${row.quote.truncated ? ` title="${escapeHtml(row.quote.full)}"` : ''}>${escapeHtml(row.quote.text)}</blockquote>`;
        const note = row.note.empty ? '' : `<p class="wat-claim-note">${cut(row.note)}</p>`;
        return `<li class="wat-claim">
            <p class="wat-claim-head"><code class="wat-field">${escapeHtml(row.field)}</code>
                ${chip(row.statusLabel, row.tone, CLAIM_STATUS_BLURBS[row.status] ?? '')}
                ${chip(row.method, 'info', 'how the claim was read')}
                <span class="wat-claim-value">${cut(row.value)}</span></p>
            ${quote}
            ${note}
            <p class="wat-claim-meta">${source}${archive} · ${cut(row.locator)}
                ${str(row.citedAs) === null ? '' : `· cited as <code>${escapeHtml(row.citedAs)}</code>`}
                · accessed ${timeCell(row.accessedAt)} · recorded ${timeCell(row.recordedAt)}
                · last checked ${timeCell(row.lastCheckedAt)}</p>
        </li>`;
    }

    function renderClaims() {
        if (!els.claimList) return;
        const rows = filterClaimRows(state.claimRows, state.claimText);
        els.claimList.innerHTML = rows.length === 0
            ? `<li class="wat-empty">${escapeHtml(state.claimRows.length === 0
                ? 'Choose an issuer to read its claims.'
                : `No field path contains “${state.claimText}”.`)}</li>`
            : rows.map(claimListItem).join('');
        if (els.claimCount) {
            els.claimCount.textContent = state.claimRows.length === 0
                ? ''
                : `${fmtNumber(rows.length)} of ${fmtNumber(state.claimRows.length)} claim(s)`;
        }
    }

    /** Every source, in as many calls as the registry needs. */
    async function loadSources() {
        const first = await getJson('/api/sources', { limit: SOURCES_PER_CALL, offset: 0, sort: 'issuer', order: 'asc' });
        const total = num(first?.total) ?? 0;
        const rest = pageOffsets(total, SOURCES_PER_CALL).slice(1);
        const pages = await Promise.all(rest.map((offset) => getJson('/api/sources',
            { limit: SOURCES_PER_CALL, offset, sort: 'issuer', order: 'asc' })));
        const items = [first, ...pages].flatMap((page) => (Array.isArray(page?.items) ? page.items : []));
        state.sources = items;
        state.totals = sourceTotals(items);
        state.groups = sourcesByIssuer(items, state.names);
        state.sourceIndex = new Map(items.map((src) => [str(src?.id), sourceRow(src)]));
        renderSourceTiles();
        renderIssuerRows();
        renderDataLine();
    }

    /** The card link on a token change event needs the mint's symbol, which only /api/tokens has. */
    async function loadTokensFor(rows) {
        const mints = [...new Set(rows
            .filter((row) => str(row?.subject_type) === 'token')
            .map((row) => str(row?.subject_id))
            .filter((mint) => mint !== null && !state.tokens.has(mint)))];
        if (mints.length === 0) return;
        const answers = await Promise.all(mints.map(async (mint) => {
            try {
                return await getJson(`/api/tokens/${encodeURIComponent(mint)}`, null);
            } catch (err) {
                logError(`no token row for ${mint}`, err.api ?? err.message);
                return null;
            }
        }));
        for (const [index, token] of answers.entries()) {
            if (token === null) continue;
            state.tokens.set(mints[index], { symbol: token.symbol ?? null, name: token.name ?? null, cardSlug: token.cardSlug ?? null });
        }
    }

    async function loadChanges() {
        const token = changeSequence.next();
        const params = {
            limit: CHANGES_PER_CALL,
            sort: 'detected_at',
            order: 'desc',
            since: sinceIso(state.since),
            kind: state.changeFilters.kind || null,
            severity: state.changeFilters.severity || null,
            issuer: state.changeFilters.issuer || null,
            material: state.material ? 'true' : null
        };
        try {
            const page = await getJson('/api/changes', params);
            state.changeNote = str(page?.modelAssessmentNote);
            if (!changeSequence.isCurrent(token)) return;
            const items = Array.isArray(page?.items) ? page.items : [];
            await loadTokensFor(items);
            if (!changeSequence.isCurrent(token)) return;
            state.changeTotal = num(page?.total) ?? items.length;
            state.changeItems = items;
            state.changes = changeRows(items, {
                names: state.names, sources: state.sourceIndex, tokens: state.tokens
            });
            renderChanges();
        } catch (err) {
            if (!changeSequence.isCurrent(token)) return;
            state.changeItems = [];
            state.changes = [];
            state.changeTotal = 0;
            logError('/api/changes did not answer', err.api ?? err.message);
            setStatus(err.message, true);
            renderChanges();
        }
    }

    /**
     * One summary call per issuer. `limit=1` because the route's payload is the claim LIST and all
     * this needs is the `summary` beside it; pulling all 1,264 claims would be ~1 MB for twelve bars.
     */
    async function loadFreshness() {
        const slugs = [...state.names.keys()];
        const answers = await Promise.all(slugs.map(async (slug) => {
            try {
                const page = await getJson(`/api/issuers/${encodeURIComponent(slug)}/claims`, { limit: 1 });
                return { slug, name: page?.name ?? state.names.get(slug), summary: page?.summary ?? null };
            } catch (err) {
                logError(`/api/issuers/${slug}/claims did not answer`, err.api ?? err.message);
                return null;
            }
        }));
        const entries = answers.filter((entry) => entry !== null && entry.summary !== null);
        state.freshness = freshnessBars(entries);
        state.claimTotal = state.freshness.reduce((sum, row) => sum + row.claims, 0);
        renderFreshness();
        renderDataLine();
    }

    async function loadClaims() {
        const token = claimSequence.next();
        const slug = state.claimIssuer;
        if (slug === null) {
            state.claimRows = [];
            renderClaims();
            return;
        }
        try {
            const page = await getJson('/api/claims', { issuer: slug, limit: CLAIMS_PER_CALL, sort: 'field', order: 'asc' });
            if (!claimSequence.isCurrent(token)) return;
            state.claimRows = claimRows(page);
            renderClaims();
        } catch (err) {
            if (!claimSequence.isCurrent(token)) return;
            state.claimRows = [];
            logError('/api/claims did not answer', err.api ?? err.message);
            setStatus(err.message, true);
            renderClaims();
        }
    }

    /** The two issuer selects, filled from /api/issuers so no slug is ever typed in by hand. */
    function fillIssuerSelects() {
        const options = [...state.names].map(([slug, name]) =>
            `<option value="${escapeHtml(slug)}">${escapeHtml(name)}</option>`).join('');
        if (els.changeIssuer) {
            els.changeIssuer.innerHTML = `<option value="">every issuer</option>${options}`;
        }
        if (els.claimIssuer) {
            els.claimIssuer.innerHTML = `<option value="">choose an issuer</option>${options}`;
        }
        if (els.focusedIssuer) els.focusedIssuer.innerHTML = options;
    }

    function fillChangeFilters() {
        if (els.changeKind) {
            els.changeKind.innerHTML = `<option value="">every kind</option>`
                + CHANGE_KINDS.map((kind) =>
                    `<option value="${escapeHtml(kind)}">${escapeHtml(CHANGE_KIND_LABELS[kind] ?? kind)}</option>`).join('');
        }
        if (els.changeSeverity) {
            els.changeSeverity.innerHTML = `<option value="">every severity</option>`
                + SEVERITIES.map((severity) =>
                    `<option value="${escapeHtml(severity)}">${escapeHtml(severity)}</option>`).join('');
        }
    }

    function wireEvents() {
        els.focusedWatchType.addEventListener('change', setFocusedFields);
        els.focusedWatchForm.addEventListener('submit', saveFocusedWatch);
        els.savedWatchList.addEventListener('click', async (event) => {
            const card = event.target.closest('[data-watch-id]');
            if (!card) return;
            const row = state.focusedWatches.find((entry) => entry.watch.watchId === card.dataset.watchId);
            if (!row) return;
            if (event.target.closest('[data-copy-share]')) {
                event.preventDefault();
                const href = event.target.closest('[data-copy-share]').href;
                try {
                    await navigator.clipboard.writeText(href);
                    els.focusedWatchStatus.textContent = 'Read-only link copied. The owner key remains only in this browser.';
                } catch (_) {
                    window.prompt('Copy this read-only watch link:', href);
                }
            }
            if (event.target.closest('[data-delete-watch]')) {
                event.target.closest('[data-delete-watch]').disabled = true;
                try {
                    await watchRequest('DELETE', `/watchlists/${row.watch.watchId}`, row.credential.watchKey);
                    state.focusedWatches = state.focusedWatches.filter((entry) => entry !== row);
                    storeFocusedCredentials(focusedCredentials().filter((entry) => entry.watchId !== row.watch.watchId));
                    renderFocusedWatches();
                    els.focusedWatchStatus.textContent = 'Watch deleted.';
                } catch (err) {
                    els.focusedWatchStatus.dataset.error = 'true';
                    els.focusedWatchStatus.textContent = err.message;
                    renderFocusedWatches();
                }
            }
        });
        els.issuerRows.addEventListener('click', (event) => {
            const button = event.target.closest('.wat-issuer-head[data-slug]');
            if (!button) return;
            const slug = button.dataset.slug;
            if (state.expanded.has(slug)) state.expanded.delete(slug);
            else state.expanded.add(slug);
            renderIssuerRows();
        });
        els.sinceChips.addEventListener('click', (event) => {
            const button = event.target.closest('[data-since]');
            if (!button) return;
            state.since = button.dataset.since;
            renderSinceChips();
            loadChanges();
        });
        for (const [el, key] of [[els.changeKind, 'kind'], [els.changeSeverity, 'severity'], [els.changeIssuer, 'issuer']]) {
            el.addEventListener('change', () => {
                state.changeFilters[key] = el.value;
                loadChanges();
            });
        }
        els.materialChip.addEventListener('click', () => {
            state.material = !state.material;
            // Kept in the address bar so a filtered feed can be shared as a link.
            const url = new URL(window.location.href);
            if (state.material) url.searchParams.set('material', 'true');
            else url.searchParams.delete('material');
            window.history.replaceState(null, '', url);
            loadChanges();
        });
        els.claimIssuer.addEventListener('change', () => {
            state.claimIssuer = els.claimIssuer.value === '' ? null : els.claimIssuer.value;
            loadClaims();
        });
        els.claimField.addEventListener('input', () => {
            state.claimText = els.claimField.value;
            renderClaims();
        });
    }

    async function boot() {
        els.status = document.getElementById('status');
        els.focusedWatchForm = document.getElementById('focusedWatchForm');
        els.focusedWatchType = document.getElementById('focusedWatchType');
        els.focusedMintField = document.getElementById('focusedMintField');
        els.focusedMint = document.getElementById('focusedMint');
        els.focusedIssuerField = document.getElementById('focusedIssuerField');
        els.focusedIssuer = document.getElementById('focusedIssuer');
        els.focusedIntegrationField = document.getElementById('focusedIntegrationField');
        els.focusedIntegration = document.getElementById('focusedIntegration');
        els.focusedMarketField = document.getElementById('focusedMarketField');
        els.focusedMarket = document.getElementById('focusedMarket');
        els.focusedTitle = document.getElementById('focusedTitle');
        els.focusedWatchSave = document.getElementById('focusedWatchSave');
        els.focusedWatchStatus = document.getElementById('focusedWatchStatus');
        els.sharedWatchView = document.getElementById('sharedWatchView');
        els.savedWatchList = document.getElementById('savedWatchList');
        els.sourceCount = document.getElementById('sourceCount');
        els.claimCountLine = document.getElementById('claimCountLine');
        els.changeCountLine = document.getElementById('changeCountLine');
        els.lastSweep = document.getElementById('lastSweep');
        els.sourceTiles = document.getElementById('sourceTiles');
        els.journalCount = document.getElementById('journalCount');
        els.journalVisit = document.getElementById('journalVisit');
        els.journalList = document.getElementById('journalList');
        els.issuerRows = document.getElementById('issuerRows');
        els.sinceChips = document.getElementById('sinceChips');
        els.changeKind = document.getElementById('changeKind');
        els.changeSeverity = document.getElementById('changeSeverity');
        els.changeIssuer = document.getElementById('changeIssuer');
        els.materialChip = document.getElementById('materialChip');
        els.changeCount = document.getElementById('changeCount');
        els.changeList = document.getElementById('changeList');
        els.changeEmpty = document.getElementById('changeEmpty');
        els.freshnessList = document.getElementById('freshnessList');
        els.claimIssuer = document.getElementById('claimIssuer');
        els.claimField = document.getElementById('claimField');
        els.claimCount = document.getElementById('claimCount');
        els.claimList = document.getElementById('claimList');

        if (apiLib === null) {
            setStatus('stocks/lib/api-base.js did not load, so this page cannot find the API.', true);
            logError('stocks/lib/api-base.js is missing', null);
            return;
        }
        base = apiLib.apiBase();

        const focusParams = new URLSearchParams(window.location.search);
        const requestedType = focusParams.get('type');
        if (['token', 'issuer', 'protocol-market'].includes(requestedType)) els.focusedWatchType.value = requestedType;
        els.focusedMint.value = focusParams.get('mint') ?? '';
        els.focusedIntegration.value = focusParams.get('integrationId') ?? '';
        els.focusedMarket.value = focusParams.get('marketKey') ?? '';
        state.material = focusParams.get('material') === 'true';
        // A shared link that filters the feed must show the feed, not a collapsed heading.
        const feed = document.getElementById('feedDisclosure');
        if (feed && state.material) feed.open = true;
        setFocusedFields();
        fillChangeFilters();
        renderSinceChips();
        wireEvents();

        try {
            const issuers = await getJson('/api/issuers', null);
            state.names = issuerNames(issuers);
            fillIssuerSelects();
            const issuerSlug = focusParams.get('issuerSlug');
            if (issuerSlug && state.names.has(issuerSlug)) els.focusedIssuer.value = issuerSlug;
        } catch (err) {
            logError('/api/issuers did not answer', err.api ?? err.message);
            setStatus(err.message, true);
        }

        // The five sections are independent: one failing must not blank the others.
        const loads = [
            loadJournal().catch((err) => {
                logError('stocks-change-journal.json did not answer', err.message);
                state.journal = [];
                renderJournal();
            }),
            loadSources().catch((err) => {
                logError('/api/sources did not answer', err.api ?? err.message);
                setStatus(err.message, true);
                state.totals = null;
                renderSourceTiles();
            }),
            loadChanges(),
            loadFreshness(),
            loadFocusedWatches()
        ];
        renderClaims();
        await Promise.all(loads);
        // A source-subject event takes its title and its archive link from the registry, which
        // loads in parallel and may land after the feed. Re-shape from the rows as they arrived,
        // never from the shaped output — a display cut must not become the input of a second pass.
        if (state.changeItems.length > 0) {
            state.changes = changeRows(state.changeItems, {
                names: state.names, sources: state.sourceIndex, tokens: state.tokens
            });
            renderChanges();
        }
        if (state.totals !== null) setStatus(null, false);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    return api;
}));
