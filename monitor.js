/**
 * Renders monitor.html: the health monitor, now an explorer over the read-only JSON API. The facet
 * panel lists every one of the API's 22 facets with its count, the status tiles and the worst-rule
 * strip are two of those facets rendered larger, and the table is one page of /api/tokens with the
 * sort and the filters applied in Postgres rather than here. The filter state lives in the page's
 * own query string, so a filtered view is a link.
 *
 * WHAT IS STILL A FILE: the change log, the curated events and the Meteora pool table read
 * stocks-changes.json, stocks/data/meteora.json, stocks-tokens.json and stocks-trades.json exactly
 * as before, and the after-hours gap column reads stocks-afterhours.json — the API's slim token row
 * does not carry it. Those sections are unaffected by the API being down; the table says so.
 *
 * The health RULES ARE NOT REIMPLEMENTED HERE, and neither are the statuses: every status and
 * worst-rule id on this page comes from the API, which serves what stocks/build-health.mjs wrote
 * from stocks/lib/health.mjs — the one copy of the ten checks. RULE_LABELS is the one thing the API
 * does not carry: the rules' DISPLAY names, which monitor-page.test.js locks against
 * stocks-health.json so the two cannot drift.
 *
 * Everything above the DOM section is pure — no DOM, no fetch, no clock — and is exported for jest
 * (monitor-page.test.js). The display formatters come from stocks/lib/fmt.js and the API base from
 * stocks/lib/api-base.js, the copies shared with the other pages. Wrapped in a UMD factory so it
 * declares no globals and cannot shadow a top-level name in another script.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__monitor = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const fmt = (typeof __rwaFmt !== 'undefined') ? __rwaFmt : require('./stocks/lib/fmt.js');
    const {
        DASH, escapeHtml, isNum, isSafeUrl, fmtMoney, fmtNumber, fmtPrice, fmtPct, fmtSignedPct,
        fmtDate, fmtDateTime, fmtRelativeTime, fmtVenueSpreadPct, humanizeSlug, cardSlug
    } = fmt;

    // -----------------------------------------------------------------------
    // Pure section — no DOM, no fetch, no Date.now(). Exported for jest.
    // -----------------------------------------------------------------------

    /** The four statuses, in the order the tiles read. `unknown` is a first-class answer, not a fault. */
    const STATUSES = ['good', 'caution', 'warning', 'unknown'];

    /** How bad a judged status is. Also the set of statuses a row may report. */
    const STATUS_RANK = { good: 1, caution: 2, warning: 3, unknown: 4 };

    /** What each tile says under its number, so a count is never a bare number without a claim. */
    const STATUS_BLURBS = {
        good: 'every measured check passed',
        caution: 'at least one check in its middle band',
        warning: 'at least one check failed outright',
        unknown: 'nothing measurable — not a clean bill of health'
    };

    /** Where the per-token cards live, relative to this page. */
    const CARDS_DIR = './cards/';

    /** Kinds of curated event, for the chip's tooltip when events.json does not describe one. */
    const DEFAULT_EVENT_KIND = 'An event recorded in the issuer dossiers.';

    /**
     * Every filter the API accepts, which is also every facet it reports — /api/facets with no `by`
     * returns exactly these. Locked against api/src/lib/query.js by a test, because a name this
     * page invents is a 400 (`unknown_filter`) and a name it forgets is a facet a reader cannot see.
     */
    const FACET_NAMES = [
        'issuer', 'instrument', 'recipe', 'program', 'health', 'worst_rule', 'reference',
        'legal_form', 'claim_rung', 'maturity_stage', 'verification_type', 'key_governance_mint',
        'key_governance_freeze', 'jurisdiction', 'pausable', 'paused', 'clawback', 'allowlist',
        'transfer_fee', 'hook_active', 'seen_in_search', 'first_seen_day'
    ];

    /** The panel's headings, and which facets sit under each. Every facet appears exactly once. */
    const FACET_GROUPS = [
        { id: 'issuer', heading: 'Issuer', facets: ['issuer'] },
        { id: 'instrument', heading: 'Instrument', facets: ['instrument'] },
        { id: 'recipe', heading: 'Recipe & program', facets: ['recipe', 'program'] },
        { id: 'health', heading: 'Health', facets: ['health', 'worst_rule'] },
        {
            id: 'issuer-shape',
            heading: 'Legal form, claim, maturity, verification, keys, jurisdiction',
            facets: [
                'legal_form', 'claim_rung', 'maturity_stage', 'verification_type',
                'key_governance_mint', 'key_governance_freeze', 'jurisdiction'
            ]
        },
        {
            id: 'control',
            heading: 'Control flags',
            facets: ['pausable', 'paused', 'clawback', 'allowlist', 'transfer_fee', 'hook_active']
        },
        { id: 'reference', heading: 'Reference source', facets: ['reference'] },
        { id: 'seen', heading: 'Seen', facets: ['seen_in_search', 'first_seen_day'] }
    ];

    /** What each facet is called in the panel. A facet with no entry falls back to its own name. */
    const FACET_TITLES = {
        issuer: 'Issuer',
        instrument: 'Instrument type',
        recipe: 'Recipe',
        program: 'Token program',
        health: 'Status',
        worst_rule: 'Worst failing rule',
        reference: 'Reference price source',
        legal_form: 'Legal form',
        claim_rung: 'Claim rung',
        maturity_stage: 'Maturity stage',
        verification_type: 'Reserve verification',
        key_governance_mint: 'Mint authority held by',
        key_governance_freeze: 'Freeze authority held by',
        jurisdiction: 'Jurisdiction',
        pausable: 'Pausable',
        paused: 'Paused',
        clawback: 'Clawback',
        allowlist: 'Allowlist',
        transfer_fee: 'Transfer fee',
        hook_active: 'Transfer hook active',
        seen_in_search: 'Seen in Jupiter search',
        first_seen_day: 'First seen'
    };

    /**
     * The ten health rules' DISPLAY names. The API serves the rule ID (`worst_rule`) and nothing
     * else, so this is the one label table the page has to hold. It is not a rule and not a
     * threshold — stocks/lib/health.mjs remains the only copy of those — and a test asserts this
     * map equals the `rules` array in stocks-health.json, so a renamed rule cannot slip past.
     */
    const RULE_LABELS = {
        tracking: 'Price tracking',
        liquidity: 'Pool liquidity',
        organic: 'Organic flow',
        failedTx: 'Failed swaps',
        concentration: 'Holder concentration',
        verification: 'Reserve verification',
        keyControl: 'Authority keys',
        paused: 'Trading pause',
        frozen: 'Frozen accounts',
        spread: 'Venue spread'
    };

    /**
     * The sort keys /api/tokens accepts. Anything else is a 400 there, so it is refused here.
     * 2026-09-18: `worst_rule`, `venue_spread_pct` and `top1_share_pct` joined the API's whitelist,
     * which is what lets this table finally offer those three columns as sortable; `health_status`
     * now orders by SEVERITY there rather than alphabetically, so the header means what it says.
     */
    const TOKEN_SORTS = [
        'symbol', 'liquidity_usd', 'volume24_usd', 'premium_pct', 'holder_count',
        'first_seen_at', 'last_traded_at', 'health_status',
        'worst_rule', 'venue_spread_pct', 'top1_share_pct'
    ];

    const DEFAULT_SORT = 'liquidity_usd';
    const DEFAULT_ORDER = 'desc';

    /** Rows per page. The API clamps `limit` to 500, so this is a reading choice, not a limit. */
    const PER_PAGE = 50;

    /** The literal the API reads as IS NULL, so the null bucket a facet reports is clickable. */
    const NULL_PARAM = 'null';

    /** What the null bucket is called in the panel. Never "null", never 0. */
    const MISSING_LABEL = 'not recorded';

    /** True for a non-empty string, trimmed. Anything else is treated as missing. */
    function str(value) {
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    }

    /** A finite number or null — a missing measurement never becomes 0 on the way to a cell. */
    function num(value) {
        return isNum(value) ? value : null;
    }

    /**
     * The per-mint card file name. fmt.cardSlug is what stocks/lib/cards.mjs starts from, and all
     * 471 current symbols are distinct case-insensitively, so the two agree and cards/index.json is
     * no longer fetched — a test compares the helper against every card the build wrote.
     */
    function cardHref(symbol, mint) {
        const slug = str(cardSlug(symbol, mint));
        if (slug === null) return null;
        const href = `${CARDS_DIR}${encodeURIComponent(slug)}.html`;
        return isSafeUrl(href) ? href : null;
    }

    /**
     * `{slug: displayName}` from stocks-tokens.json's `issuerIndex`, which is an ARRAY of
     * `{slug, name, …}` records — not, as its name suggests, an object keyed by slug. Both shapes are
     * read, because getting this wrong is invisible: the lookup simply misses and every issuer
     * silently falls back to a title-cased slug, so "Backed (xStocks)" renders as "Xstocks backed".
     */
    function issuerNames(tokens) {
        const index = tokens?.issuerIndex;
        const out = new Map();
        if (Array.isArray(index)) {
            for (const entry of index) {
                const slug = str(entry?.slug);
                if (slug !== null) out.set(slug, str(entry?.name) ?? humanizeSlug(slug));
            }
            return out;
        }
        if (index && typeof index === 'object') {
            for (const [slug, entry] of Object.entries(index)) {
                if (str(slug) === null) continue;
                out.set(slug, str(entry?.name) ?? str(entry) ?? humanizeSlug(slug));
            }
        }
        return out;
    }

    /** The display name for an issuer slug: the build's own name, else the slug made readable. */
    function issuerName(slug, names) {
        if (slug === null) return null;
        return (names instanceof Map ? names.get(slug) : null) ?? humanizeSlug(slug);
    }

    // ------------------------------------------------------------ filter state

    /**
     * How a facet VALUE travels as a filter parameter. `null` becomes the literal the API reads as
     * IS NULL; a boolean becomes true/false; a number and a date become their own text. Everything
     * the panel clicks and everything the query string carries goes through here, so a chip, a
     * button and a URL always spell the same value the same way.
     */
    function paramValue(value) {
        if (value === null || value === undefined) return NULL_PARAM;
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        return String(value);
    }

    /** What a facet value is CALLED: the API's own short label where it has one, else the value. */
    function facetValueLabel(facet, row) {
        const value = row?.value;
        if (value === null || value === undefined) return MISSING_LABEL;
        if (typeof value === 'boolean') return value ? 'yes' : 'no';
        if (facet === 'worst_rule') return RULE_LABELS[value] ?? String(value);
        if (facet === 'issuer') return str(row?.name) ?? humanizeSlug(String(value));
        if (facet === 'first_seen_day') return fmtDate(String(value));
        return str(row?.label) ?? String(value);
    }

    /**
     * The filter state a URL asks for. Only the 22 known facet names are read, so the page's own
     * parameters (`api`, `reduceMotion`) can never be forwarded to the API, which would 400 them.
     * A comma list and a repeated parameter both mean OR, and duplicates collapse.
     */
    function parseFilterState(search) {
        const params = new URLSearchParams(typeof search === 'string' ? search : '');
        const filters = {};
        for (const name of FACET_NAMES) {
            const values = [];
            for (const raw of params.getAll(name)) {
                for (const piece of String(raw).split(',')) {
                    const value = piece.trim();
                    if (value !== '' && !values.includes(value)) values.push(value);
                }
            }
            if (values.length > 0) filters[name] = values;
        }
        const sort = params.get('sort');
        const order = params.get('order');
        const page = Number.parseInt(params.get('page') ?? '', 10);
        return {
            filters,
            q: str(params.get('q')) ?? '',
            sort: TOKEN_SORTS.includes(sort) ? sort : DEFAULT_SORT,
            order: order === 'asc' ? 'asc' : DEFAULT_ORDER,
            page: Number.isFinite(page) && page > 1 ? page : 1
        };
    }

    /**
     * The query string that reproduces a state, `extras` (the page's own `api`, `reduceMotion`)
     * first so a shared link keeps pointing at the same API. A default is left out, so an unfiltered
     * page has a clean URL; the comma stays literal so the filter reads as the API's own syntax.
     */
    function filterStateToSearch(state, extras = {}) {
        const parts = [];
        const push = (name, value) => parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
        for (const [name, value] of Object.entries(extras && typeof extras === 'object' ? extras : {})) {
            if (value === null || value === undefined || value === '') continue;
            push(name, value);
        }
        const filters = state?.filters && typeof state.filters === 'object' ? state.filters : {};
        for (const name of FACET_NAMES) {
            const values = (Array.isArray(filters[name]) ? filters[name] : [])
                .map((value) => str(value))
                .filter((value) => value !== null);
            if (values.length === 0) continue;
            parts.push(`${encodeURIComponent(name)}=${values.map(encodeURIComponent).join(',')}`);
        }
        const q = str(state?.q);
        if (q !== null) push('q', q);
        if (TOKEN_SORTS.includes(state?.sort) && state.sort !== DEFAULT_SORT) push('sort', state.sort);
        if (state?.order === 'asc') push('order', 'asc');
        if (isNum(state?.page) && state.page > 1) push('page', String(Math.floor(state.page)));
        return parts.join('&');
    }

    /**
     * One value toggled inside one facet: adding a second value to the same facet is OR (the API
     * reads the comma list that way), and removing the last one drops the facet entirely rather
     * than sending an empty parameter. Returns a NEW filters object; the input is not mutated.
     */
    function toggleFilterValue(filters, facet, value) {
        const out = {};
        for (const [name, values] of Object.entries(filters && typeof filters === 'object' ? filters : {})) {
            if (Array.isArray(values) && values.length > 0) out[name] = [...values];
        }
        if (!FACET_NAMES.includes(facet) || str(value) === null) return out;
        const current = out[facet] ?? [];
        const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
        if (next.length === 0) delete out[facet];
        else out[facet] = next;
        return out;
    }

    /** The parameters /api/tokens is asked for: the filters, the search, the sort and the window. */
    function tokenRequestParams(state, perPage = PER_PAGE) {
        const page = isNum(state?.page) && state.page > 1 ? Math.floor(state.page) : 1;
        return {
            ...(state?.filters ?? {}),
            q: str(state?.q) ?? null,
            sort: TOKEN_SORTS.includes(state?.sort) ? state.sort : DEFAULT_SORT,
            order: state?.order === 'asc' ? 'asc' : DEFAULT_ORDER,
            limit: perPage,
            offset: (page - 1) * perPage
        };
    }

    /** The parameters /api/facets is asked for: the same filters, and no `by` — so all 22 come back. */
    function facetRequestParams(state) {
        return { ...(state?.filters ?? {}), q: str(state?.q) ?? null };
    }

    // ----------------------------------------------------------- facet shaping

    /** One facet's clickable rows: the API's value, its label, its count and whether it is on. */
    function buildFacet(name, rows, activeValues) {
        const selected = Array.isArray(activeValues) ? activeValues : [];
        return {
            name,
            title: FACET_TITLES[name] ?? humanizeSlug(name),
            values: (Array.isArray(rows) ? rows : []).map((row) => {
                const param = paramValue(row?.value);
                return {
                    param,
                    label: facetValueLabel(name, row),
                    count: isNum(row?.count) ? row.count : null,
                    active: selected.includes(param),
                    // The API reads a comma as the OR separator, so a value CONTAINING one (six of
                    // the nine jurisdiction blurbs do) cannot be asked for at all. It is still
                    // listed with its count — the reader deserves the number — but not offered as
                    // a filter, because clicking it would silently return zero tokens.
                    filterable: !param.includes(',')
                };
            })
        };
    }

    /**
     * The whole panel: the facets the API reported, under this page's headings, in this page's
     * order. A facet the response omits or reports empty is left out; a facet the API reports that
     * this page has NOT placed in a group is shown at the end rather than dropped, so a new facet
     * on the API appears here by itself instead of being invisible until someone notices.
     */
    function facetGroups(facets, filters) {
        const source = facets && typeof facets === 'object' ? facets : {};
        const active = filters && typeof filters === 'object' ? filters : {};
        const has = (name) => Array.isArray(source[name]) && source[name].length > 0;
        const groups = [];
        const placed = new Set();
        for (const group of FACET_GROUPS) {
            const built = [];
            for (const name of group.facets) {
                placed.add(name);
                if (has(name)) built.push(buildFacet(name, source[name], active[name]));
            }
            if (built.length > 0) groups.push({ id: group.id, heading: group.heading, facets: built });
        }
        const extra = Object.keys(source).filter((name) => !placed.has(name) && has(name));
        if (extra.length > 0) {
            groups.push({
                id: 'other',
                heading: 'Other',
                facets: extra.map((name) => buildFacet(name, source[name], active[name]))
            });
        }
        return groups;
    }

    /**
     * The removable chips above the table, in panel order, with the search first. A chip's label
     * comes from the facet response when the value is in it; when it is not (a filter that now
     * matches nothing, or a link someone shared), the raw value is shown rather than nothing.
     */
    function filterChips(state, facets) {
        const chips = [];
        const q = str(state?.q);
        if (q !== null) chips.push({ facet: 'q', value: q, title: 'Search', label: q });
        const filters = state?.filters && typeof state.filters === 'object' ? state.filters : {};
        for (const name of FACET_NAMES) {
            const rows = Array.isArray(facets?.[name]) ? facets[name] : [];
            for (const value of Array.isArray(filters[name]) ? filters[name] : []) {
                const row = rows.find((candidate) => paramValue(candidate?.value) === value) ?? null;
                chips.push({
                    facet: name,
                    value,
                    title: FACET_TITLES[name] ?? humanizeSlug(name),
                    label: row !== null ? facetValueLabel(name, row)
                        : (value === NULL_PARAM ? MISSING_LABEL : value)
                });
            }
        }
        return chips;
    }

    /**
     * The four tiles, from the `health` facet. All four always appear — a status the facet omits is
     * 0, not absent — and because a facet excludes its OWN filter, the counts keep showing what you
     * could switch to while a status filter is on, rather than collapsing to the one selected.
     */
    function statusTilesFromFacet(rows, activeValues) {
        const counts = new Map();
        for (const row of Array.isArray(rows) ? rows : []) {
            counts.set(paramValue(row?.value), isNum(row?.count) ? row.count : 0);
        }
        const selected = Array.isArray(activeValues) ? activeValues : [];
        return STATUSES.map((status) => ({
            status,
            label: status.charAt(0).toUpperCase() + status.slice(1),
            blurb: STATUS_BLURBS[status],
            count: counts.get(status) ?? 0,
            active: selected.includes(status)
        }));
    }

    /**
     * The "by worst rule" strip, from the `worst_rule` facet: biggest first, a rule that is nobody's
     * worst left out. `share` is of the tokens that HAVE a worst rule, so the bars add to 100 % and
     * the null bucket is not counted as a clean bill of health.
     */
    function ruleStripFromFacet(rows, activeValues) {
        const list = (Array.isArray(rows) ? rows : [])
            .filter((row) => str(row?.value) !== null && isNum(row?.count) && row.count > 0)
            .map((row) => ({
                id: String(row.value),
                label: RULE_LABELS[row.value] ?? String(row.value),
                count: row.count
            }))
            .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
        const total = list.reduce((sum, row) => sum + row.count, 0);
        const selected = Array.isArray(activeValues) ? activeValues : [];
        return list.map((row) => ({
            ...row,
            share: total === 0 ? null : (row.count / total) * 100,
            active: selected.includes(row.id)
        }));
    }

    // ------------------------------------------------------------ table paging

    /**
     * Which slice of `total` a page is, and what the pager may offer. The page is CLAMPED into the
     * range that exists, so `?page=99` on a 471-row set lands on the last page rather than showing
     * an empty table, and an empty result is one page with no rows rather than zero pages.
     */
    function pageMath({ total = 0, page = 1, perPage = PER_PAGE } = {}) {
        const size = isNum(perPage) && perPage >= 1 ? Math.floor(perPage) : PER_PAGE;
        const count = isNum(total) && total > 0 ? Math.floor(total) : 0;
        const pages = Math.max(1, Math.ceil(count / size));
        const current = Math.min(Math.max(isNum(page) ? Math.floor(page) : 1, 1), pages);
        const offset = (current - 1) * size;
        const from = count === 0 ? null : offset + 1;
        const to = count === 0 ? null : Math.min(offset + size, count);
        return {
            page: current,
            pages,
            perPage: size,
            total: count,
            offset,
            from,
            to,
            hasPrev: current > 1,
            hasNext: current < pages,
            label: count === 0
                ? 'no tokens match'
                : `${fmtNumber(from)}–${fmtNumber(to)} of ${fmtNumber(count)} · page ${fmtNumber(current)} of ${fmtNumber(pages)}`
        };
    }

    /**
     * The stale-response guard. Every request takes a number; only the newest number may render.
     * Without it a slow first response can land AFTER a fast second one and repaint the table with
     * the filter the reader has already moved off — the classic faceted-search flicker.
     */
    function createSequence() {
        let latest = 0;
        return {
            next() {
                latest += 1;
                return latest;
            },
            isCurrent(token) {
                return token === latest;
            },
            get value() {
                return latest;
            }
        };
    }

    /**
     * What the table says when a request failed. The path and the status are both in the sentence:
     * "unreachable" with no detail is indistinguishable from an empty result, and a 500 on
     * /api/tokens and a dead port are different problems with different fixes.
     */
    function describeApiFailure({ path = null, status = null, message = null } = {}) {
        const where = str(path) ?? 'the API';
        if (isNum(status)) return `API unreachable — GET ${where} answered HTTP ${status}.`;
        const why = str(message);
        return `API unreachable — GET ${where} did not answer${why === null ? '' : ` (${why})`}. `
            + 'Is the API running?';
    }

    /** `{mint: record}` from stocks-afterhours.json, for the one column the slim row cannot carry. */
    function gapIndex(afterhours) {
        const out = new Map();
        for (const item of Array.isArray(afterhours?.items) ? afterhours.items : []) {
            const mint = str(item?.mint);
            if (mint !== null) out.set(mint, item);
        }
        return out;
    }

    /**
     * One table row per slim token row the API returned, in the API's order — the sort happened in
     * Postgres and must not be re-decided here. The after-hours gap is joined in from
     * stocks-afterhours.json by mint; a mint that file does not carry keeps a null gap, never 0.
     */
    function tokenRowsFromApi(items, gaps) {
        const index = gaps instanceof Map ? gaps : new Map();
        return (Array.isArray(items) ? items : []).map((item) => {
            const mint = str(item?.mint);
            const symbol = str(item?.symbol);
            const issuer = str(item?.issuer_slug);
            const worstRuleId = str(item?.worst_rule);
            const gap = mint === null ? null : (index.get(mint) ?? null);
            return {
                mint,
                symbol,
                name: str(item?.name),
                issuer,
                issuerName: str(item?.issuer_name) ?? (issuer === null ? null : humanizeSlug(issuer)),
                status: STATUS_RANK[item?.health_status] ? item.health_status : 'unknown',
                worstRuleId,
                worstRuleLabel: worstRuleId === null ? null : (RULE_LABELS[worstRuleId] ?? worstRuleId),
                liquidity: num(item?.liquidity_usd),
                vol24: num(item?.volume24_usd),
                premiumPct: num(item?.premium_pct),
                venueSpreadPct: num(item?.venue_spread_pct),
                gapPct: num(gap?.gapPct),
                top1SharePct: num(item?.top1_share_pct),
                holderCount: num(item?.holder_count),
                lastTradedAt: str(item?.last_traded_at),
                href: cardHref(symbol, mint)
            };
        });
    }

    /**
     * The latest change list grouped into sections, in the ORDER THE DIFF DECLARES — `kinds` comes
     * from stocks-changes.json, so this page and lib/changes.mjs cannot disagree about what a kind
     * is called or where it belongs. A kind with no changes is left out; a kind the file does not
     * declare still gets a section, at the end, rather than being silently dropped.
     */
    function groupChanges(changes, kinds) {
        const list = Array.isArray(changes) ? changes : [];
        const declared = (Array.isArray(kinds) ? kinds : []).map((kind) => ({
            id: str(kind?.id),
            label: str(kind?.label) ?? str(kind?.id) ?? DASH
        })).filter((kind) => kind.id !== null);
        const seen = new Set(declared.map((kind) => kind.id));
        const extra = [...new Set(list.map((change) => str(change?.kind)).filter((id) => id !== null && !seen.has(id)))]
            .map((id) => ({ id, label: humanizeSlug(id) }));
        return [...declared, ...extra]
            .map((kind) => ({ ...kind, items: list.filter((change) => change?.kind === kind.id) }))
            .filter((group) => group.items.length > 0);
    }

    /** The per-day count strip: one entry per diffed pair, oldest first, with its total. */
    function dayCounts(history) {
        return (Array.isArray(history) ? history : []).map((pair) => {
            const counts = pair?.counts && typeof pair.counts === 'object' ? pair.counts : {};
            const entries = Object.entries(counts).filter(([, n]) => isNum(n) && n > 0);
            return {
                from: str(pair?.from),
                to: str(pair?.to),
                total: entries.reduce((sum, [, n]) => sum + n, 0),
                counts: entries.map(([kind, n]) => ({ kind, count: n }))
            };
        });
    }

    /**
     * One row per Meteora pool, joined to the token (for its reference price) and to the collected
     * trade tape (for the failed-transaction share and the newest trade on that pool).
     *
     * `premiumPct` is the pool's own price against the token's reference price — the same comparison
     * the tracking rule makes, but per pool rather than per mint, so a pool quoting a different price
     * from the venue aggregate is visible. `failedShare` is null, never 0, when no signatures were
     * sampled for the pool at all: 22 pools exist and the collector reached four of them.
     */
    function meteoraRows({ meteora, tokens, trades } = {}) {
        const byMint = new Map();
        for (const token of Array.isArray(tokens?.tokens) ? tokens.tokens : []) {
            const mint = str(token?.mint);
            if (mint !== null) byMint.set(mint, token);
        }
        const poolStats = new Map();
        for (const pool of Array.isArray(trades?.pools) ? trades.pools : []) {
            const pair = str(pool?.pair);
            if (pair !== null) poolStats.set(pair, pool);
        }
        const lastTradeByPair = new Map();
        for (const trade of Array.isArray(trades?.trades) ? trades.trades : []) {
            const pair = str(trade?.pair);
            const time = str(trade?.time);
            if (pair === null || time === null) continue;
            const current = lastTradeByPair.get(pair);
            if (current === undefined || time > current) lastTradeByPair.set(pair, time);
        }
        const names = issuerNames(tokens);

        return (Array.isArray(meteora?.items) ? meteora.items : []).map((item) => {
            const mint = str(item?.mint);
            const token = mint === null ? null : (byMint.get(mint) ?? null);
            const pair = str(item?.pairAddress);
            const stats = pair === null ? null : (poolStats.get(pair) ?? null);
            const signatures = num(stats?.signaturesSeen);
            const failed = num(stats?.failedTx);
            const price = num(item?.priceUsd);
            const refPrice = num(token?.reference?.price);
            const issuer = str(item?.issuer) ?? str(token?.issuer);
            return {
                mint,
                symbol: str(item?.symbol) ?? str(token?.symbol),
                issuer,
                issuerName: issuerName(issuer, names),
                pairAddress: pair,
                dexId: str(item?.dexId),
                poolType: str(item?.poolType),
                poolName: str(item?.poolName),
                binStep: num(item?.binStep),
                baseFeePct: num(item?.baseFeePct),
                maxFeePct: num(item?.maxFeePct),
                dynamicFeePct: num(item?.dynamicFeePct),
                liquidityUsd: num(item?.liquidityUsd),
                volume24Usd: num(item?.volume24Usd),
                fees24Usd: num(item?.fees24Usd),
                dexscreenerLiquidityUsd: num(item?.dexscreener?.liquidityUsd),
                dexscreenerVolume24Usd: num(item?.dexscreener?.volume24Usd),
                priceUsd: price,
                refPrice,
                refSource: str(token?.reference?.source),
                premiumPct: price === null || refPrice === null || refPrice === 0 ? null : (price / refPrice - 1) * 100,
                quoteSymbol: str(item?.quoteSymbol),
                signaturesSeen: signatures,
                failedTx: failed,
                failedShare: signatures === null || signatures === 0 || failed === null ? null : (failed / signatures) * 100,
                lastTradeAt: pair === null ? null : (lastTradeByPair.get(pair) ?? null),
                curve: item?.curve && typeof item.curve === 'object' ? item.curve : null,
                error: str(item?.error)
            };
        }).sort((a, b) => {
            const left = a.liquidityUsd;
            const right = b.liquidityUsd;
            if (!isNum(left) && !isNum(right)) return (a.symbol ?? '') < (b.symbol ?? '') ? -1 : 1;
            if (!isNum(left)) return 1;
            if (!isNum(right)) return -1;
            return right - left;
        });
    }

    /**
     * What a DBC pool's curve record actually establishes, in a reader's terms. The bonding-curve
     * account layout was NOT decoded by the fetcher, so this must not imply a progress figure that
     * nobody read: it reports existence, the owning program and the data length, and says the state
     * is undecoded when it is.
     */
    function curveSummary(curve) {
        if (!curve || typeof curve !== 'object') return null;
        const account = curve.account && typeof curve.account === 'object' ? curve.account : {};
        const parts = [];
        if (account.exists === true) parts.push('curve account exists');
        else if (account.exists === false) parts.push('no curve account at that address');
        if (isNum(account.dataLength)) parts.push(`${fmtNumber(account.dataLength)} bytes of state`);
        if (account.isDbcProgram === true) parts.push('owned by the DBC program');
        parts.push(curve.curveState === null ? 'state not decoded' : 'state decoded');
        if (curve.migrated === true) parts.push('migrated');
        else if (curve.migrated === false) parts.push('not migrated');
        return {
            address: str(curve.address),
            text: parts.join(' · '),
            note: str(curve.note),
            pairName: [str(curve.tokenX?.symbol), str(curve.tokenY?.symbol)].filter(Boolean).join(' / ') || null
        };
    }

    /** Curated events, newest first, defensively re-sorted so the page does not trust file order. */
    function sortEvents(events) {
        return (Array.isArray(events) ? events : [])
            .filter((event) => event && typeof event === 'object')
            .slice()
            .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
    }

    /** How long the "New on Solana" strip looks back when the feed does not say. */
    const NEW_MINTS_WINDOW_DAYS = 14;

    /**
     * The chips of the "New on Solana" strip, from stocks-changes.json's `newMints` feed: one row
     * per mint the universe crawl first saw inside the feed's window, kept in the order the feed
     * selected (newest first). `firstSeen` is a RELATIVE age against `nowMs`, which the caller
     * passes so this stays pure and the same feed always shapes the same way.
     *
     * A mint with no `firstSeenAt` keeps a null age rather than being dated now, and a mint with no
     * `cardSlug` gets a null href and renders as plain text — a chip never links to a card the build
     * did not write. An absent file, an absent `newMints` or a row with neither symbol nor mint
     * yields nothing: an empty strip is hidden, not an error.
     */
    function newMintChips(changes, nowMs) {
        const feed = Array.isArray(changes?.newMints) ? changes.newMints : [];
        const chips = [];
        for (const row of feed) {
            if (!row || typeof row !== 'object') continue;
            const mint = str(row.mint);
            const symbol = str(row.symbol) ?? mint;
            if (symbol === null) continue;
            const slug = str(row.cardSlug);
            const firstSeenAt = str(row.firstSeenAt);
            const issuerSlug = str(row.issuer);
            const name = str(row.name);
            const href = slug === null ? null : `${CARDS_DIR}${encodeURIComponent(slug)}.html`;
            chips.push({
                mint,
                symbol,
                issuer: str(row.issuerName) ?? (issuerSlug === null ? null : humanizeSlug(issuerSlug)),
                firstSeenAt,
                firstSeen: firstSeenAt === null ? null : fmtRelativeTime(firstSeenAt, nowMs),
                href: href !== null && isSafeUrl(href) ? href : null,
                title: `${name === null ? symbol : `${symbol} — ${name}`}`
                    + `${firstSeenAt === null ? '' : ` · first seen ${fmtDateTime(firstSeenAt)}`}`
            });
        }
        return chips;
    }

    /** How many days the feed looked back, as the strip's note and the header line should say it. */
    function newMintsWindowDays(changes) {
        const days = num(changes?.newMintWindowDays);
        return days !== null && days > 0 ? days : NEW_MINTS_WINDOW_DAYS;
    }

    const api = {
        STATUSES,
        STATUS_RANK,
        STATUS_BLURBS,
        FACET_NAMES,
        FACET_GROUPS,
        FACET_TITLES,
        RULE_LABELS,
        TOKEN_SORTS,
        DEFAULT_SORT,
        DEFAULT_ORDER,
        PER_PAGE,
        NULL_PARAM,
        MISSING_LABEL,
        NEW_MINTS_WINDOW_DAYS,
        paramValue,
        facetValueLabel,
        parseFilterState,
        filterStateToSearch,
        toggleFilterValue,
        tokenRequestParams,
        facetRequestParams,
        buildFacet,
        facetGroups,
        filterChips,
        statusTilesFromFacet,
        ruleStripFromFacet,
        pageMath,
        createSequence,
        describeApiFailure,
        gapIndex,
        tokenRowsFromApi,
        newMintChips,
        newMintsWindowDays,
        cardHref,
        issuerNames,
        issuerName,
        groupChanges,
        dayCounts,
        meteoraRows,
        curveSummary,
        sortEvents
    };

    // -----------------------------------------------------------------------
    // DOM section — only runs in a browser. Builds markup and wires events.
    // -----------------------------------------------------------------------

    if (typeof document === 'undefined') return api;

    const apiLib = (typeof __rwaApi !== 'undefined') ? __rwaApi : null;

    /** The sections that are still files, not API routes. */
    const FILES = {
        afterhours: './stocks-afterhours.json',
        changes: './stocks-changes.json',
        meteora: './stocks/data/meteora.json',
        tokens: './stocks-tokens.json',
        trades: './stocks-trades.json'
    };

    /** How long a burst of clicks or keystrokes is allowed to settle before a request goes out. */
    const DEBOUNCE_MS = 150;

    const state = {
        filters: {},
        q: '',
        sort: DEFAULT_SORT,
        order: DEFAULT_ORDER,
        page: 1,
        facets: null,
        items: [],
        rows: [],
        total: 0,
        loading: false,
        error: null,
        gaps: new Map(),
        changes: null,
        meteora: []
    };

    const els = {};
    const sequence = createSequence();
    let base = '';
    let debounceTimer = null;

    /** One timestamped line per failure. Nothing else is logged: a healthy page is silent. */
    function logError(message, detail) {
        console.error(`[${new Date().toISOString()}] monitor: ${message}`, detail ?? '');
    }

    /** A status chip: the word carries the verdict, the colour only reinforces it. */
    function statusChip(status) {
        const safe = STATUS_RANK[status] ? status : 'unknown';
        return `<span class="mon-chip mon-chip-${safe}">${escapeHtml(safe)}</span>`;
    }

    function tokenTableRow(row) {
        const symbol = escapeHtml(row.symbol ?? DASH);
        const link = row.href === null
            ? `<span class="mon-symbol">${symbol}</span>`
            : `<a class="mon-symbol" href="${escapeHtml(row.href)}">${symbol}</a>`;
        const premiumClass = !isNum(row.premiumPct) ? '' : row.premiumPct >= 0 ? ' num-up' : ' num-down';
        const gapClass = !isNum(row.gapPct) ? '' : row.gapPct >= 0 ? ' num-up' : ' num-down';
        return `<tr>
            <td class="cell-token">${link}<span class="mon-name">${escapeHtml(row.name ?? '')}</span></td>
            <td>${escapeHtml(row.issuerName ?? row.issuer ?? DASH)}</td>
            <td>${statusChip(row.status)}</td>
            <td>${escapeHtml(row.worstRuleLabel ?? DASH)}</td>
            <td class="num">${escapeHtml(fmtMoney(row.liquidity))}</td>
            <td class="num${premiumClass}">${escapeHtml(fmtSignedPct(row.premiumPct))}</td>
            <td class="num">${escapeHtml(fmtVenueSpreadPct(row.venueSpreadPct))}</td>
            <td class="num${gapClass}">${escapeHtml(fmtSignedPct(row.gapPct))}</td>
            <td class="num">${escapeHtml(fmtPct(row.top1SharePct))}</td>
            <td><span title="${escapeHtml(fmtDateTime(row.lastTradedAt))}">${escapeHtml(fmtRelativeTime(row.lastTradedAt))}</span></td>
        </tr>`;
    }

    function renderTiles() {
        const tiles = statusTilesFromFacet(state.facets?.health, state.filters.health);
        els.tiles.innerHTML = tiles.map((tile) => `<button type="button"
            class="mon-tile mon-tile-${tile.status}${tile.active ? ' mon-tile-active' : ''}"
            data-facet="health" data-value="${tile.status}" aria-pressed="${tile.active ? 'true' : 'false'}">
            <span class="mon-tile-count">${escapeHtml(fmtNumber(tile.count))}</span>
            <span class="mon-tile-label">${escapeHtml(tile.label)}</span>
            <span class="mon-tile-blurb">${escapeHtml(tile.blurb)}</span>
        </button>`).join('');
    }

    function renderRuleStrip() {
        const strip = ruleStripFromFacet(state.facets?.worst_rule, state.filters.worst_rule);
        if (strip.length === 0) {
            els.ruleStrip.innerHTML = '<p class="mon-empty">No token in this selection has a worst failing rule.</p>';
            return;
        }
        els.ruleStrip.innerHTML = strip.map((rule) => `<button type="button"
            class="mon-rule${rule.active ? ' mon-rule-active' : ''}"
            data-facet="worst_rule" data-value="${escapeHtml(rule.id)}" aria-pressed="${rule.active ? 'true' : 'false'}">
            <span class="mon-rule-label">${escapeHtml(rule.label)}</span>
            <span class="mon-rule-count">${escapeHtml(fmtNumber(rule.count))}</span>
            <span class="mon-rule-bar"><span class="mon-rule-fill" style="width:${isNum(rule.share) ? rule.share.toFixed(1) : 0}%"></span></span>
        </button>`).join('');
    }

    function facetValueHtml(facet, value) {
        const count = value.count === null ? DASH : fmtNumber(value.count);
        const inner = `<span class="mon-facet-label">${escapeHtml(value.label)}</span>`
            + `<span class="mon-facet-count">${escapeHtml(count)}</span>`;
        if (!value.filterable) {
            const why = 'The API reads a comma as the separator between OR-ed values, so this value '
                + 'cannot be asked for as a filter.';
            return `<li class="mon-facet-row"><span class="mon-facet-value mon-facet-value-blocked"
                title="${escapeHtml(why)}">${inner}</span></li>`;
        }
        return `<li class="mon-facet-row"><button type="button"
            class="mon-facet-value${value.active ? ' mon-facet-value-active' : ''}"
            data-facet="${escapeHtml(facet)}" data-value="${escapeHtml(value.param)}"
            aria-pressed="${value.active ? 'true' : 'false'}">${inner}</button></li>`;
    }

    function renderFacetPanel() {
        if (state.facets === null) {
            els.facetPanel.innerHTML = '<p class="mon-empty">The facets come from the API, which did not answer.</p>';
            return;
        }
        const groups = facetGroups(state.facets, state.filters);
        els.facetPanel.innerHTML = groups.map((group) => `<section class="mon-facet-group">
            <h3 class="mon-facet-heading">${escapeHtml(group.heading)}</h3>
            ${group.facets.map((facet) => `<div class="mon-facet" data-facet="${escapeHtml(facet.name)}">
                <h4 class="mon-facet-title">${escapeHtml(facet.title)}</h4>
                <ul class="mon-facet-values">${facet.values.map((value) => facetValueHtml(facet.name, value)).join('')}</ul>
            </div>`).join('')}
        </section>`).join('');
    }

    function renderChips() {
        const chips = filterChips(state, state.facets);
        els.chips.hidden = chips.length === 0;
        if (chips.length === 0) {
            els.chipList.innerHTML = '';
            return;
        }
        els.chipList.innerHTML = chips.map((chip) => `<li class="mon-filter-chip">
            <span class="mon-filter-facet">${escapeHtml(chip.title)}</span>
            <span class="mon-filter-value">${escapeHtml(chip.label)}</span>
            <button type="button" class="mon-filter-remove" data-facet="${escapeHtml(chip.facet)}"
                data-value="${escapeHtml(chip.value)}"
                aria-label="Remove the ${escapeHtml(chip.title)} filter ${escapeHtml(chip.label)}">&times;</button>
        </li>`).join('');
    }

    function renderTable() {
        const math = pageMath({ total: state.total, page: state.page });
        els.tokenBody.innerHTML = state.rows.length === 0
            ? `<tr><td colspan="10" class="mon-empty">${escapeHtml(state.error === null ? 'No token matches these filters.' : 'No rows — see the message above.')}</td></tr>`
            : state.rows.map(tokenTableRow).join('');
        els.tokenCount.textContent = state.error === null
            ? `${fmtNumber(state.total)} mint${state.total === 1 ? '' : 's'} match`
            : '';
        els.pageLabel.textContent = state.error === null ? math.label : '';
        els.prevPage.disabled = !math.hasPrev || state.error !== null;
        els.nextPage.disabled = !math.hasNext || state.error !== null;
        els.pager.hidden = state.error !== null || state.total === 0;
        els.tableMessage.hidden = state.error === null;
        els.tableMessage.textContent = state.error ?? '';
        els.tableWrap.classList.toggle('is-loading', state.loading);
        for (const th of els.tokenTable.querySelectorAll('th[data-sort]')) {
            const active = th.dataset.sort === state.sort;
            th.classList.toggle('sort-active', active);
            th.setAttribute('aria-sort', active ? (state.order === 'asc' ? 'ascending' : 'descending') : 'none');
        }
    }

    function changeRow(change) {
        const symbol = escapeHtml(change.symbol ?? change.mint ?? DASH);
        const href = cardHref(change.symbol, change.mint);
        const link = href === null ? symbol : `<a href="${escapeHtml(href)}">${symbol}</a>`;
        const before = change.before === null || change.before === undefined ? DASH : String(change.before);
        const after = change.after === null || change.after === undefined ? DASH : String(change.after);
        return `<li>
            <span class="mon-change-token">${link}</span>
            <span class="mon-change-issuer">${escapeHtml(change.issuer ?? '')}</span>
            <span class="mon-change-delta"><code>${escapeHtml(change.field ?? '')}</code> ${escapeHtml(before)} &rarr; ${escapeHtml(after)}</span>
            <span class="mon-change-note">${escapeHtml(change.note ?? '')}</span>
        </li>`;
    }

    function renderChanges() {
        const latest = state.changes?.latest ?? null;
        const groups = groupChanges(latest?.changes, state.changes?.kinds);
        const days = dayCounts(state.changes?.history);

        els.changeStrip.innerHTML = days.length === 0
            ? '<p class="mon-empty">Only one snapshot day so far — there is nothing to compare it with.</p>'
            : days.map((day) => `<span class="mon-day">
                <span class="mon-day-range">${escapeHtml(fmtDate(day.from))} &rarr; ${escapeHtml(fmtDate(day.to))}</span>
                <span class="mon-day-count">${escapeHtml(fmtNumber(day.total))} change${day.total === 1 ? '' : 's'}</span>
                <span class="mon-day-kinds">${escapeHtml(day.counts.map((c) => `${c.kind} ${c.count}`).join(' · ')) || 'nothing changed'}</span>
            </span>`).join('');

        if (latest === null) {
            els.changeRange.textContent = 'no pair of days to diff yet';
            els.changeGroups.innerHTML = '';
            return;
        }
        els.changeRange.textContent = `${fmtDate(latest.from)} → ${fmtDate(latest.to)}`;
        if (groups.length === 0) {
            els.changeGroups.innerHTML = '<p class="mon-empty">Nothing changed between those two days.</p>';
            return;
        }
        els.changeGroups.innerHTML = groups.map((group) => `<section class="mon-group">
            <h3>${escapeHtml(group.label)} <span class="mon-group-count">${escapeHtml(fmtNumber(group.items.length))}</span></h3>
            <ul class="mon-change-list">${group.items.map(changeRow).join('')}</ul>
        </section>`).join('');
    }

    function renderEvents() {
        const events = sortEvents(state.changes?.events);
        if (events.length === 0) {
            els.eventList.innerHTML = '<p class="mon-empty">No curated events.</p>';
            return;
        }
        els.eventList.innerHTML = events.map((event) => {
            const kind = typeof event.kind === 'string' ? event.kind : '';
            const kindNote = state.changes?.eventKinds?.[kind] ?? DEFAULT_EVENT_KIND;
            return `<li class="mon-event">
                <div class="mon-event-head">
                    <span class="mon-event-kind" title="${escapeHtml(kindNote)}">${escapeHtml(kind || DASH)}</span>
                    <time datetime="${escapeHtml(event.date ?? '')}">${escapeHtml(fmtDate(event.date))}</time>
                    <span class="mon-event-issuer">${escapeHtml(event.issuer ?? DASH)}</span>
                </div>
                <p class="mon-event-summary">${escapeHtml(event.summary ?? '')}</p>
                <p class="mon-event-source">${escapeHtml(event.source ?? '')}</p>
            </li>`;
        }).join('');
    }

    function renderMeteora() {
        if (state.meteora.length === 0) {
            els.meteoraBody.innerHTML = '<tr><td colspan="9" class="mon-empty">No Meteora pool records.</td></tr>';
            els.meteoraCount.textContent = '';
            return;
        }
        els.meteoraBody.innerHTML = state.meteora.map((pool) => {
            const symbol = escapeHtml(pool.symbol ?? pool.mint ?? DASH);
            const href = cardHref(pool.symbol, pool.mint);
            const link = href === null
                ? `<span class="mon-symbol">${symbol}</span>`
                : `<a class="mon-symbol" href="${escapeHtml(href)}">${symbol}</a>`;
            // The dynamic fee is only printed when it survives its own rounding: 3.2e-6 % renders as
            // "0.0000% dynamic", which reads as a fee that is there but zero rather than one too
            // small to show. Below that it is simply left out.
            const showsDynamic = isNum(pool.dynamicFeePct) && pool.dynamicFeePct >= 0.00005;
            const fee = isNum(pool.baseFeePct)
                ? `${fmtPct(pool.baseFeePct, 2)} base${showsDynamic ? ` + ${fmtPct(pool.dynamicFeePct, 4)} dynamic` : ''}`
                : DASH;
            const bin = isNum(pool.binStep) ? fmtNumber(pool.binStep) : DASH;
            const failed = isNum(pool.failedShare)
                ? `${fmtPct(pool.failedShare)} <span class="mon-sub">of ${fmtNumber(pool.signaturesSeen)}</span>`
                : `${DASH} <span class="mon-sub">not sampled</span>`;
            const premiumClass = !isNum(pool.premiumPct) ? '' : pool.premiumPct >= 0 ? ' num-up' : ' num-down';
            const curve = curveSummary(pool.curve);
            const curveLine = curve === null ? '' : `<tr class="mon-curve-row"><td colspan="9">
                <strong>Bonding curve</strong> ${escapeHtml(curve.text)}
                ${curve.pairName ? ` &middot; pair ${escapeHtml(curve.pairName)}` : ''}
                ${curve.note ? `<span class="mon-sub mon-curve-note">${escapeHtml(curve.note)}</span>` : ''}
            </td></tr>`;
            return `<tr>
                <td class="cell-token">${link}<span class="mon-name">${escapeHtml(pool.issuerName ?? pool.issuer ?? '')}</span></td>
                <td><span class="mon-pool-type">${escapeHtml((pool.poolType ?? DASH).toUpperCase())}</span></td>
                <td class="num">${escapeHtml(bin)}</td>
                <td>${fee}</td>
                <td class="num">${escapeHtml(fmtMoney(pool.liquidityUsd))}</td>
                <td class="num">${escapeHtml(fmtMoney(pool.volume24Usd))}</td>
                <td class="num">${escapeHtml(fmtMoney(pool.fees24Usd))}</td>
                <td class="num${premiumClass}">${escapeHtml(fmtSignedPct(pool.premiumPct))}<span class="mon-sub">${escapeHtml(isNum(pool.priceUsd) ? fmtPrice(pool.priceUsd) : DASH)}</span></td>
                <td class="num">${failed}<span class="mon-sub" title="${escapeHtml(fmtDateTime(pool.lastTradeAt))}">${escapeHtml(pool.lastTradeAt === null ? 'no trade seen' : `last ${fmtRelativeTime(pool.lastTradeAt)}`)}</span></td>
            </tr>${curveLine}`;
        }).join('');
        const sampled = state.meteora.filter((pool) => isNum(pool.failedShare)).length;
        els.meteoraCount.textContent = `${fmtNumber(state.meteora.length)} pools · ${fmtNumber(sampled)} reached by the trade collector`;
    }

    /** One chip: a link when the card exists, plain text when it does not. */
    function newMintChipHtml(chip, clone) {
        const parts = [`<span class="new-mint-symbol">${escapeHtml(chip.symbol)}</span>`];
        if (chip.issuer !== null) parts.push(`<span class="new-mint-issuer">${escapeHtml(chip.issuer)}</span>`);
        if (chip.firstSeen !== null) parts.push(`<span class="new-mint-age">first seen ${escapeHtml(chip.firstSeen)}</span>`);
        const inner = parts.join('<span aria-hidden="true">·</span>');
        const title = ` title="${escapeHtml(chip.title)}"`;
        if (chip.href === null) return `<li class="new-mint-chip"><span${title}>${inner}</span></li>`;
        // The clone exists only to make the loop seamless: it is aria-hidden, and its links are out
        // of the tab order, so every chip is reached exactly once by keyboard.
        const tab = clone ? ' tabindex="-1"' : '';
        return `<li class="new-mint-chip"><a href="${escapeHtml(chip.href)}"${tab}${title}>${inner}</a></li>`;
    }

    /**
     * The "New on Solana" strip plus its count in the data line. Nothing to show — no file, no feed,
     * no rows — hides both and says nothing: the strip is a bonus, not a fact the page owes.
     */
    function renderNewMints() {
        if (!els.newMints || !els.newMintsTrack || !els.newMintsClone) return;
        const chips = newMintChips(state.changes, Date.now());
        const days = newMintsWindowDays(state.changes);
        if (chips.length === 0) {
            els.newMints.hidden = true;
            if (els.newMintsSummary) els.newMintsSummary.hidden = true;
            return;
        }
        els.newMintsTrack.innerHTML = chips.map((chip) => newMintChipHtml(chip, false)).join('');
        els.newMintsClone.innerHTML = chips.map((chip) => newMintChipHtml(chip, true)).join('');
        if (els.newMintsWindow) els.newMintsWindow.textContent = String(days);
        els.newMints.hidden = false;
        if (els.newMintsSummaryLink) {
            els.newMintsSummaryLink.textContent = `${fmtNumber(chips.length)} new mint${chips.length === 1 ? '' : 's'} `
                + `in the last ${fmtNumber(days)} days`;
        }
        if (els.newMintsSummary) els.newMintsSummary.hidden = false;
    }

    /** Everything the API drives. The file-fed sections render once, when their files land. */
    function renderExplorer() {
        renderTiles();
        renderRuleStrip();
        renderFacetPanel();
        renderChips();
        renderTable();
    }

    /** The page's own parameters, kept in the URL so a shared link reaches the same API. */
    function urlExtras() {
        const params = new URLSearchParams(window.location.search);
        const extras = {};
        if (params.has('api')) extras.api = params.get('api');
        if (params.has('reduceMotion')) extras.reduceMotion = params.get('reduceMotion') || '1';
        return extras;
    }

    /** The URL now mirrors the filter state, so this view is a link someone can send. */
    function syncUrl() {
        const search = filterStateToSearch(state, urlExtras());
        const url = `${window.location.pathname}${search === '' ? '' : `?${search}`}`;
        window.history.replaceState(null, '', url);
    }

    function apiFailure(url, status, message) {
        const err = new Error(describeApiFailure({ path: url, status, message }));
        err.api = { path: url, status, message };
        return err;
    }

    async function getJson(url) {
        let res;
        try {
            res = await fetch(url, { cache: 'no-store' });
        } catch (err) {
            throw apiFailure(url, null, err.message);
        }
        if (!res.ok) throw apiFailure(url, res.status, null);
        return res.json();
    }

    /**
     * One round trip for the current state: the facet counts and the page of tokens, in parallel.
     * The sequence number is taken BEFORE the requests and checked after, so a slow earlier answer
     * cannot repaint a table the reader has already moved on from.
     */
    async function refresh() {
        const token = sequence.next();
        state.loading = true;
        els.tableWrap.classList.add('is-loading');
        syncUrl();

        const facetsUrl = apiLib.apiUrl('/api/facets', facetRequestParams(state), base);
        const tokensUrl = apiLib.apiUrl('/api/tokens', tokenRequestParams(state), base);
        try {
            const [facets, tokens] = await Promise.all([getJson(facetsUrl), getJson(tokensUrl)]);
            if (!sequence.isCurrent(token)) return;
            state.loading = false;
            state.error = null;
            state.facets = facets?.facets ?? null;
            state.items = Array.isArray(tokens?.items) ? tokens.items : [];
            state.total = isNum(tokens?.total) ? tokens.total : 0;
            state.rows = tokenRowsFromApi(state.items, state.gaps);
            // The API clamps nothing about `page`: an offset past the end is an empty page, so the
            // reader is moved onto the last page that exists instead of being shown a blank table.
            const math = pageMath({ total: state.total, page: state.page });
            if (math.page !== state.page) {
                state.page = math.page;
                refresh();
                return;
            }
            renderExplorer();
        } catch (err) {
            if (!sequence.isCurrent(token)) return;
            state.loading = false;
            state.error = err.message;
            state.facets = null;
            state.items = [];
            state.rows = [];
            state.total = 0;
            logError('the API did not answer', err.api ?? err.message);
            renderExplorer();
        }
    }

    /** Every state change goes through here, so a burst of clicks costs one round trip. */
    function scheduleRefresh() {
        renderExplorer();
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            refresh();
        }, DEBOUNCE_MS);
    }

    /** A facet value toggled: the page returns to the first page, since the set just changed. */
    function toggleFilter(facet, value) {
        if (facet === 'q') {
            state.q = '';
            els.searchFilter.value = '';
        } else {
            state.filters = toggleFilterValue(state.filters, facet, value);
        }
        state.page = 1;
        scheduleRefresh();
    }

    async function loadFile(path, { required = false } = {}) {
        try {
            const res = await fetch(path, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            if (required) throw err;
            logError(`${path} did not load`, err.message);
            return null;
        }
    }

    /**
     * The sections that are still files: the after-hours gap column, the change log, the events and
     * the Meteora pools. They are loaded beside the API calls and never block the table.
     */
    async function loadFileSections() {
        const [afterhours, changes, meteora, tokens, trades] = await Promise.all([
            loadFile(FILES.afterhours),
            loadFile(FILES.changes),
            loadFile(FILES.meteora),
            loadFile(FILES.tokens),
            loadFile(FILES.trades)
        ]);
        state.gaps = gapIndex(afterhours);
        state.changes = changes;
        state.meteora = meteoraRows({ meteora, tokens, trades });
        // The gap column belongs to rows that may already be on screen.
        state.rows = tokenRowsFromApi(state.items, state.gaps);
        renderTable();
        renderNewMints();
        renderChanges();
        renderEvents();
        renderMeteora();
    }

    async function loadApiHealth() {
        const url = apiLib.apiUrl('/api/health', null, base);
        try {
            const health = await getJson(url);
            if (els.dataAsOf) {
                els.dataAsOf.textContent = fmtDateTime(health?.latestBuildAt);
                els.dataAsOf.setAttribute('datetime', health?.latestBuildAt ?? '');
            }
            if (els.snapshotDate) els.snapshotDate.textContent = fmtDate(health?.latestSnapshotDate);
            if (els.tokenTotal) els.tokenTotal.textContent = fmtNumber(health?.counts?.tokens);
        } catch (err) {
            logError('/api/health did not answer', err.api ?? err.message);
            if (els.dataAsOf) els.dataAsOf.textContent = DASH;
            if (els.snapshotDate) els.snapshotDate.textContent = DASH;
            if (els.tokenTotal) els.tokenTotal.textContent = DASH;
        }
    }

    function wireEvents() {
        // One handler for every facet-shaped control: the tiles, the rule strip and the panel rows
        // all carry data-facet + data-value, so they cannot drift apart from each other.
        for (const el of [els.tiles, els.ruleStrip, els.facetPanel]) {
            el.addEventListener('click', (event) => {
                const button = event.target.closest('[data-facet][data-value]');
                if (!button || button.disabled) return;
                toggleFilter(button.dataset.facet, button.dataset.value);
            });
        }
        els.chipList.addEventListener('click', (event) => {
            const button = event.target.closest('.mon-filter-remove');
            if (!button) return;
            toggleFilter(button.dataset.facet, button.dataset.value);
        });
        els.clearFilters.addEventListener('click', () => {
            state.filters = {};
            state.q = '';
            els.searchFilter.value = '';
            state.page = 1;
            scheduleRefresh();
        });
        els.searchFilter.addEventListener('input', () => {
            state.q = els.searchFilter.value;
            state.page = 1;
            scheduleRefresh();
        });
        els.tokenTable.addEventListener('click', (event) => {
            const th = event.target.closest('th[data-sort]');
            if (!th || !TOKEN_SORTS.includes(th.dataset.sort)) return;
            if (state.sort === th.dataset.sort) {
                state.order = state.order === 'asc' ? 'desc' : 'asc';
            } else {
                state.sort = th.dataset.sort;
                // A number reads most usefully largest-first; the symbol reads A–Z.
                state.order = th.dataset.sort === 'symbol' ? 'asc' : 'desc';
            }
            state.page = 1;
            scheduleRefresh();
        });
        els.prevPage.addEventListener('click', () => {
            state.page = Math.max(1, state.page - 1);
            scheduleRefresh();
        });
        els.nextPage.addEventListener('click', () => {
            state.page += 1;
            scheduleRefresh();
        });
        // The back button is a filter change like any other, so a shared link and the history both
        // land on the same view.
        window.addEventListener('popstate', () => {
            Object.assign(state, parseFilterState(window.location.search));
            els.searchFilter.value = state.q;
            scheduleRefresh();
        });
    }

    async function boot() {
        els.status = document.getElementById('status');
        els.dataAsOf = document.getElementById('dataAsOf');
        els.snapshotDate = document.getElementById('snapshotDate');
        els.tokenTotal = document.getElementById('tokenTotal');
        els.newMints = document.getElementById('newMints');
        els.newMintsTrack = document.getElementById('newMintsTrack');
        els.newMintsClone = document.getElementById('newMintsClone');
        els.newMintsWindow = document.getElementById('newMintsWindow');
        els.newMintsSummary = document.getElementById('newMintsSummary');
        els.newMintsSummaryLink = document.getElementById('newMintsSummaryLink');
        els.tiles = document.getElementById('statusTiles');
        els.ruleStrip = document.getElementById('ruleStrip');
        els.facetPanel = document.getElementById('facetPanel');
        els.chips = document.getElementById('activeFilters');
        els.chipList = document.getElementById('filterChips');
        els.clearFilters = document.getElementById('clearFilters');
        els.searchFilter = document.getElementById('searchFilter');
        els.tableWrap = document.getElementById('tokenTableWrap');
        els.tableMessage = document.getElementById('tableMessage');
        els.tokenTable = document.getElementById('tokenTable');
        els.tokenBody = document.getElementById('tokenBody');
        els.tokenCount = document.getElementById('tokenCount');
        els.pager = document.getElementById('tokenPager');
        els.pageLabel = document.getElementById('pageLabel');
        els.prevPage = document.getElementById('prevPage');
        els.nextPage = document.getElementById('nextPage');
        els.changeRange = document.getElementById('changeRange');
        els.changeStrip = document.getElementById('changeStrip');
        els.changeGroups = document.getElementById('changeGroups');
        els.eventList = document.getElementById('eventList');
        els.meteoraBody = document.getElementById('meteoraBody');
        els.meteoraCount = document.getElementById('meteoraCount');

        // Reduced motion is an accessibility setting first and the test hook second: the only thing
        // that moves on this page is the "New on Solana" ticker, and the class turns it into a
        // static wrapping row (stocks.css). ?reduceMotion=1 forces the same for a driver that cannot
        // emulate the media query. Same class name live.js uses.
        const reduceMotion = new URLSearchParams(window.location.search).has('reduceMotion')
            || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (reduceMotion) document.body.classList.add('reduce-motion');

        if (apiLib === null) {
            els.status.hidden = false;
            els.status.classList.add('status-error');
            els.status.textContent = 'stocks/lib/api-base.js did not load, so this page cannot find the API.';
            logError('stocks/lib/api-base.js is missing', null);
            return;
        }
        base = apiLib.apiBase();

        Object.assign(state, parseFilterState(window.location.search));
        els.searchFilter.value = state.q;
        els.status.hidden = true;

        wireEvents();
        // The files and the API go out together; neither waits for the other.
        loadFileSections();
        loadApiHealth();
        await refresh();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    return api;
}));
