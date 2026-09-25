/*
 * The workspace and token-table state stocks.html keeps in its URL: which workspace view a URL
 * opens, search matching and filtering, column presets, the token view state it reads from and
 * writes to the URL, paging arithmetic, the list API's query parameters and row shape, and the
 * shared loading/empty/failed data-state block.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). Pure: no DOM, no fetch, no clock. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaTokenView; jest requires it. Tested in stocks/token-view.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./discovery.js'), require('./fmt.js'));
    else root.__rwaTokenView = factory(root.__rwaDiscovery, root.__rwaFmt);
})(this, function (discovery, fmt) {
    const { tokenSearchText } = discovery;
    const { escapeHtml, humanizeSlug, isNum, isSafeUrl } = fmt;

    /** Case-insensitive match of a query against token identity, underlying, issuer slug and mint. */
    function tokenMatchesQuery(token, query) {
        const q = String(query === null || query === undefined ? '' : query).trim().toLowerCase();
        if (!q) return true;
        if (!token) return false;
        return tokenSearchText(token, null).includes(q);
    }

    /** Applies the issuer / instrument / search controls to the token list. */
    function filterTokens(tokens, filters) {
        if (!Array.isArray(tokens)) return [];
        const f = filters || {};
        return tokens.filter((token) => {
            if (f.issuer && token.issuer !== f.issuer) return false;
            if (f.instrumentType && token.instrumentType !== f.instrumentType) return false;
            return tokenMatchesQuery(token, f.query);
        });
    }

    /** The workspace views stocks.html has, and the old section anchors that now open one of them. */
    const WORKSPACE_VIEWS = new Set(['overview', 'assets', 'compare', 'discrepancies', 'issuers', 'defi']);
    const LEGACY_VIEW_BY_HASH = {
        '#tokensSection': 'assets',
        '#activitySection': 'assets',
        '#comparisonSection': 'compare',
        '#discrepanciesSection': 'discrepancies',
        '#issuersSection': 'issuers',
        '#gridSection': 'issuers',
        '#funnelSection': 'issuers',
        '#defiUsageSection': 'defi',
        '#composabilitySection': 'defi'
    };

    /** The view a page URL asks for: ?view=, else a legacy #section anchor, else ?compare=, else overview. */
    // `fallback` is the view for a URL that names none: stocks.js passes "assets" (Find a stock) for a
    // first-time visitor, who has no briefing to continue, and "overview" for a returning reader.
    function workspaceViewFromUrl(href, fallback = 'overview') {
        const url = new URL(href);
        const requested = url.searchParams.get('view');
        if (WORKSPACE_VIEWS.has(requested)) return requested;
        if (LEGACY_VIEW_BY_HASH[url.hash]) return LEGACY_VIEW_BY_HASH[url.hash];
        if (url.searchParams.has('compare')) return 'compare';
        return WORKSPACE_VIEWS.has(fallback) ? fallback : 'overview';
    }

    const TOKEN_PAGE_SIZE = 50;
    const TOKEN_COLUMN_PRESETS = {
        overview: ['token', 'issuer', 'underlying', 'price', 'liquidity', 'detail'],
        legal: ['token', 'issuer', 'underlying', 'instrument', 'control', 'detail'],
        market: ['token', 'price', 'reference', 'premium', 'liquidity', 'volume', 'organic', 'trades', 'traders', 'spread', 'holders', 'concentration', 'last-trade', 'detail'],
        control: ['token', 'issuer', 'underlying', 'instrument', 'control', 'detail'],
        defi: ['token', 'issuer', 'underlying', 'liquidity', 'defi', 'detail'],
        all: ['token', 'issuer', 'underlying', 'instrument', 'price', 'reference', 'premium', 'liquidity', 'volume', 'organic', 'trades', 'traders', 'spread', 'holders', 'concentration', 'last-trade', 'defi', 'control', 'detail']
    };
    const TOKEN_API_SORTS = {
        price: 'usd_price',
        premium: 'premium_pct',
        liquidity: 'liquidity_usd',
        vol24: 'volume24_usd',
        trades24: 'trades24',
        traders24: 'traders24',
        spread: 'venue_spread_pct',
        holders: 'holder_count',
        lastTrade: 'last_traded_at'
    };

    function tokenViewStateFromUrl(value) {
        let params;
        try {
            if (value instanceof URLSearchParams) params = value;
            else params = new URL(String(value), 'https://rwasonar.local/').searchParams;
        } catch (_) {
            params = new URLSearchParams();
        }
        const preset = Object.hasOwn(TOKEN_COLUMN_PRESETS, params.get('columns'))
            ? params.get('columns') : 'overview';
        const sortKey = Object.hasOwn(TOKEN_API_SORTS, params.get('tokenSort'))
            ? params.get('tokenSort') : 'liquidity';
        const page = Number.parseInt(params.get('tokenPage'), 10);
        return {
            filters: {
                issuer: params.get('tokenIssuer') || '',
                instrumentType: params.get('tokenInstrument') || '',
                query: params.get('tokenQuery') || ''
            },
            searchQuery: params.get('search') || params.get('tokenQuery') || '',
            preset,
            sort: { key: sortKey, ascending: params.get('tokenOrder') === 'asc' },
            page: Number.isInteger(page) && page > 0 ? page : 1
        };
    }

    function tokenViewStateParams(viewState) {
        const params = new URLSearchParams();
        const filters = viewState?.filters ?? {};
        const preset = Object.hasOwn(TOKEN_COLUMN_PRESETS, viewState?.preset)
            ? viewState.preset : 'overview';
        const sortKey = Object.hasOwn(TOKEN_API_SORTS, viewState?.sort?.key)
            ? viewState.sort.key : 'liquidity';
        if (filters.issuer) params.set('tokenIssuer', filters.issuer);
        if (filters.instrumentType) params.set('tokenInstrument', filters.instrumentType);
        if (filters.query?.trim()) params.set('tokenQuery', filters.query.trim());
        if (viewState?.searchQuery?.trim() && viewState.searchQuery.trim() !== filters.query?.trim()) {
            params.set('search', viewState.searchQuery.trim());
        }
        if (preset !== 'overview') params.set('columns', preset);
        if (sortKey !== 'liquidity') params.set('tokenSort', sortKey);
        if (viewState?.sort?.ascending) params.set('tokenOrder', 'asc');
        if (Number.isInteger(viewState?.page) && viewState.page > 1) params.set('tokenPage', String(viewState.page));
        return params;
    }

    const DATA_STATE_KINDS = new Set(['loading', 'none-exists', 'none-confirmed', 'none-source-listed', 'not-collected', 'stale', 'failed', 'filtered-empty']);

    function dataStateHtml(kind, title, detail, actions = []) {
        const stateKind = DATA_STATE_KINDS.has(kind) ? kind : 'not-collected';
        const controls = (Array.isArray(actions) ? actions : []).map((action) => {
            if (!action?.label) return '';
            if (action.href && (/^(?:\.\.?\/|\/|#)/.test(action.href) || isSafeUrl(action.href))) {
                return `<a href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`;
            }
            if (action.action && /^[a-z0-9-]+$/.test(action.action)) {
                return `<button type="button" data-state-action="${escapeHtml(action.action)}">${escapeHtml(action.label)}</button>`;
            }
            return '';
        }).join('');
        return `<div class="data-state data-state-${stateKind}" role="status"><span>${escapeHtml(humanizeSlug(stateKind))}</span>`
            + `<strong>${escapeHtml(title || 'Status unavailable')}</strong>`
            + `<p>${escapeHtml(detail || '')}</p>${controls ? `<nav>${controls}</nav>` : ''}</div>`;
    }

    function tokenPageMath(total, page, perPage = TOKEN_PAGE_SIZE) {
        const count = isNum(total) && total > 0 ? Math.floor(total) : 0;
        const size = isNum(perPage) && perPage > 0 ? Math.floor(perPage) : TOKEN_PAGE_SIZE;
        const pages = Math.max(1, Math.ceil(count / size));
        const current = Math.min(Math.max(isNum(page) ? Math.floor(page) : 1, 1), pages);
        const from = count === 0 ? null : (current - 1) * size + 1;
        const to = count === 0 ? null : Math.min(current * size, count);
        return {
            page: current,
            pages,
            offset: (current - 1) * size,
            from,
            to,
            total: count,
            hasPrev: current > 1,
            hasNext: current < pages
        };
    }

    function tokenApiParams(filters, sort, page) {
        const paging = tokenPageMath(Number.MAX_SAFE_INTEGER, page);
        return {
            issuer: filters?.issuer || null,
            instrument: filters?.instrumentType || null,
            q: filters?.query?.trim() || null,
            sort: TOKEN_API_SORTS[sort?.key] ?? 'liquidity_usd',
            order: sort?.ascending ? 'asc' : 'desc',
            limit: TOKEN_PAGE_SIZE,
            offset: paging.offset
        };
    }

    /** Adapt the API's typed, snake_case list row to the existing table renderer's token shape. */
    function tokenFromApiRow(row) {
        const r = row ?? {};
        return {
            mint: r.mint ?? null,
            symbol: r.symbol ?? null,
            cardSlug: r.card_slug ?? null,
            name: r.name ?? null,
            issuer: r.issuer_slug ?? null,
            underlyingTicker: r.underlying_ticker ?? null,
            instrumentType: r.instrument_type ?? null,
            market: {
                usdPrice: r.usd_price ?? null,
                liquidity: r.liquidity_usd ?? null,
                vol24: r.volume24_usd ?? null,
                organicSharePct: r.organic_share_pct ?? null,
                holderCount: r.holder_count ?? null,
                top10HolderPct: r.top10_holder_pct ?? null
            },
            reference: {
                source: r.reference_source ?? null,
                price: r.reference_price ?? null,
                premiumPct: r.premium_pct ?? null
            },
            activity: {
                trades24: r.trades24 ?? null,
                traders24: r.traders24 ?? null,
                venueSpreadPct: r.venue_spread_pct ?? null,
                lastTradedAt: r.last_traded_at ?? null
            },
            control: {
                clawback: r.clawback ?? null,
                freezeAuthority: r.freeze_authority ?? null,
                pausable: r.pausable ?? null,
                paused: r.paused ?? null,
                allowlist: r.allowlist ?? null,
                transferFee: r.transfer_fee_configured ?? null,
                transferFeeBps: r.transfer_fee_bps ?? null,
                transferFeeConfigAuthority: r.transfer_fee_config_authority ?? null,
                transferFeeWithdrawAuthority: r.transfer_fee_withdraw_authority ?? null,
                hookActive: r.hook_active ?? null
            }
        };
    }

    return {
        WORKSPACE_VIEWS,
        LEGACY_VIEW_BY_HASH,
        workspaceViewFromUrl,
        tokenMatchesQuery,
        filterTokens,
        TOKEN_PAGE_SIZE,
        TOKEN_COLUMN_PRESETS,
        TOKEN_API_SORTS,
        tokenViewStateFromUrl,
        tokenViewStateParams,
        DATA_STATE_KINDS,
        dataStateHtml,
        tokenPageMath,
        tokenApiParams,
        tokenFromApiRow
    };
});
