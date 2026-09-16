/**
 * Renders monitor.html: the health monitor. The four status counts as filter tiles, the "by worst
 * rule" strip, the filterable and sortable table of all 441 mints, the day-over-day change log, the
 * curated event log and the Meteora pool table joined against the collected trade tape.
 *
 * The health RULES ARE NOT REIMPLEMENTED HERE. Every status on this page is read from
 * stocks-health.json, which stocks/build-health.mjs writes from stocks/lib/health.mjs — the one copy
 * of the ten checks. The same goes for the change kinds: their order and labels travel inside
 * stocks-changes.json, so this page groups by the same ordering the diff used. This file only shapes
 * rows, filters, sorts, joins and renders.
 *
 * Everything above the DOM section is pure — no DOM, no fetch, no clock — and is exported for jest
 * (monitor-page.test.js). The display formatters come from stocks/lib/fmt.js, the one copy shared
 * with the stock cards, so a number on this page is spelled exactly as it is spelled there. Wrapped
 * in a UMD factory so it declares no globals and cannot shadow a top-level name in another script.
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

    /** How bad a judged status is, for sorting. `unknown` sorts last, below the judged ones. */
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

    /** True for a non-empty string, trimmed. Anything else is treated as missing. */
    function str(value) {
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    }

    /** A finite number or null — a missing measurement never becomes 0 on the way to a cell. */
    function num(value) {
        return isNum(value) ? value : null;
    }

    /**
     * The per-mint card file name. `cards/index.json` wins when it names this mint, because only the
     * card builder sees the whole set and can break a symbol collision; otherwise the symbol is used
     * exactly as fmt.cardSlug computes it, which is what the builder starts from.
     */
    function cardHref(symbol, mint, cardIndex) {
        const named = cardIndex instanceof Map ? cardIndex.get(mint) : null;
        const slug = str(named) ?? str(cardSlug(symbol, mint));
        if (slug === null) return null;
        const href = `${CARDS_DIR}${encodeURIComponent(slug)}.html`;
        return isSafeUrl(href) ? href : null;
    }

    /**
     * `{mint: slug}` from whatever shape cards/index.json turns out to have: a list of records under
     * `cards`/`items`/the top level, or a plain mint→slug map. A shape this cannot read yields an
     * empty index and the page falls back to the symbol, rather than dropping every card link.
     */
    function buildCardIndex(json) {
        const out = new Map();
        const list = Array.isArray(json) ? json
            : Array.isArray(json?.cards) ? json.cards
                : Array.isArray(json?.items) ? json.items : null;
        if (list) {
            for (const entry of list) {
                const mint = str(entry?.mint);
                const slug = str(entry?.slug) ?? str(entry?.file)?.replace(/\.html$/, '') ?? null;
                if (mint !== null && slug !== null) out.set(mint, slug);
            }
            return out;
        }
        if (json && typeof json === 'object') {
            for (const [mint, value] of Object.entries(json)) {
                const slug = typeof value === 'string' ? str(value.replace(/\.html$/, '')) : str(value?.slug);
                if (str(mint) !== null && slug !== null) out.set(mint, slug);
            }
        }
        return out;
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

    /** `{id: label}` for the ten health rules, read from the health file itself. */
    function ruleLabels(health) {
        const out = new Map();
        for (const rule of Array.isArray(health?.rules) ? health.rules : []) {
            const id = str(rule?.id);
            if (id !== null) out.set(id, str(rule?.label) ?? id);
        }
        return out;
    }

    /**
     * One row per health item — health is the spine, because the statuses are the page. The market
     * numbers, the reference premium and the last trade come from stocks-tokens.json, the gap from
     * stocks-afterhours.json; a mint missing from either keeps nulls rather than zeros.
     *
     * @param {object} sources
     * @param {object|null} sources.health stocks-health.json
     * @param {object|null} sources.tokens stocks-tokens.json
     * @param {object|null} sources.afterhours stocks-afterhours.json
     * @param {Map|null} sources.cardIndex from buildCardIndex, or null
     */
    function monitorRows({ health, tokens, afterhours, cardIndex = null } = {}) {
        const byMint = new Map();
        for (const token of Array.isArray(tokens?.tokens) ? tokens.tokens : []) {
            const mint = str(token?.mint);
            if (mint !== null) byMint.set(mint, token);
        }
        const gapByMint = new Map();
        for (const item of Array.isArray(afterhours?.items) ? afterhours.items : []) {
            const mint = str(item?.mint);
            if (mint !== null) gapByMint.set(mint, item);
        }
        const names = issuerNames(tokens);
        const labels = ruleLabels(health);

        const rows = [];
        for (const item of Array.isArray(health?.items) ? health.items : []) {
            const mint = str(item?.mint);
            if (mint === null) continue;
            const token = byMint.get(mint) ?? null;
            const gap = gapByMint.get(mint) ?? null;
            const issuer = str(item?.issuer) ?? str(token?.issuer);
            const worstRuleId = str(item?.worstRuleId);
            const status = STATUS_RANK[item?.status] ? item.status : 'unknown';
            rows.push({
                mint,
                symbol: str(item?.symbol) ?? str(token?.symbol),
                name: str(token?.name),
                issuer,
                issuerName: issuerName(issuer, names),
                status,
                worstRuleId,
                worstRuleLabel: worstRuleId === null ? null : (labels.get(worstRuleId) ?? worstRuleId),
                rules: item?.rules && typeof item.rules === 'object' ? item.rules : {},
                liquidity: num(token?.market?.liquidity),
                vol24: num(token?.market?.vol24),
                premiumPct: num(token?.reference?.premiumPct),
                venueSpreadPct: num(token?.activity?.venueSpreadPct),
                gapPct: num(gap?.gapPct),
                top1SharePct: num(token?.holders?.top1SharePct),
                lastTradedAt: str(token?.activity?.lastTradedAt),
                href: cardHref(str(item?.symbol) ?? str(token?.symbol), mint, cardIndex)
            });
        }
        return rows;
    }

    /**
     * The four tiles. Counts come from the health file's own `counts`, so a tile can never disagree
     * with the file it filters; a count the file omits falls back to counting the rows.
     */
    function statusTiles(health, rows) {
        const counts = health?.counts && typeof health.counts === 'object' ? health.counts : {};
        return STATUSES.map((status) => ({
            status,
            label: status.charAt(0).toUpperCase() + status.slice(1),
            blurb: STATUS_BLURBS[status],
            count: isNum(counts[status]) ? counts[status] : (Array.isArray(rows) ? rows : []).filter((r) => r.status === status).length
        }));
    }

    /**
     * The "by worst rule" strip: how many tokens each rule is the WORST failing check for, biggest
     * first, rules that are nobody's worst left out. `share` is of the tokens that have a worst rule
     * at all, so the bars add to 100 % and an `unknown` token is not counted as a clean one.
     */
    function ruleStrip(health) {
        const by = health?.byWorstRule && typeof health.byWorstRule === 'object' ? health.byWorstRule : {};
        const labels = ruleLabels(health);
        const rows = Object.entries(by)
            .map(([id, count]) => ({ id, label: labels.get(id) ?? id, count: isNum(count) ? count : 0 }))
            .filter((row) => row.count > 0)
            .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
        const total = rows.reduce((sum, row) => sum + row.count, 0);
        return rows.map((row) => ({ ...row, share: total === 0 ? null : (row.count / total) * 100 }));
    }

    /** Every rule the health file declares, for the rule filter, in the file's own display order. */
    function ruleOptions(health) {
        return [...ruleLabels(health)].map(([id, label]) => ({ id, label }));
    }

    /** Every issuer present in the rows, by display name, sorted — for the issuer filter. */
    function issuerOptions(rows) {
        const out = new Map();
        for (const row of Array.isArray(rows) ? rows : []) {
            if (row.issuer !== null && !out.has(row.issuer)) out.set(row.issuer, row.issuerName ?? row.issuer);
        }
        return [...out].map(([slug, name]) => ({ slug, name })).sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * The rows a reader asked for. `rule` matches the WORST rule, which is what the strip and the
     * table column show — matching any rule at any status would make the filter mean something else.
     * `search` matches the symbol, the name, the issuer or the mint, case-insensitively.
     */
    function filterRows(rows, { status = 'all', issuer = 'all', rule = 'all', search = '' } = {}) {
        const needle = typeof search === 'string' ? search.trim().toLowerCase() : '';
        return (Array.isArray(rows) ? rows : []).filter((row) => {
            if (status !== 'all' && row.status !== status) return false;
            if (issuer !== 'all' && row.issuer !== issuer) return false;
            if (rule !== 'all' && row.worstRuleId !== rule) return false;
            if (needle === '') return true;
            return [row.symbol, row.name, row.issuer, row.issuerName, row.mint]
                .some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));
        });
    }

    /** How each sortable column is read off a row. A text key sorts as text, a number as a number. */
    const SORT_KEYS = {
        symbol: { text: (row) => row.symbol ?? '' },
        issuer: { text: (row) => row.issuerName ?? row.issuer ?? '' },
        // `unknown` is read as MISSING here, not as a fourth severity, so it sorts to the bottom in
        // both directions: descending severity must show the worst measured tokens first, not the
        // ones nothing is known about.
        status: { number: (row) => (row.status === 'unknown' ? null : (STATUS_RANK[row.status] ?? null)) },
        rule: { text: (row) => row.worstRuleLabel ?? '' },
        liquidity: { number: (row) => row.liquidity },
        premium: { number: (row) => row.premiumPct },
        spread: { number: (row) => row.venueSpreadPct },
        gap: { number: (row) => row.gapPct },
        top1: { number: (row) => row.top1SharePct },
        lastTrade: { text: (row) => row.lastTradedAt ?? '' }
    };

    /**
     * Sorted rows, ascending or descending. A row whose value is missing sorts LAST in both
     * directions: "we did not measure this" is not the smallest liquidity in the set, and letting it
     * head the descending list would put 24 unmeasured mints above the largest pool on the page.
     */
    function sortRows(rows, key, direction = 'asc') {
        const spec = SORT_KEYS[key];
        const list = [...(Array.isArray(rows) ? rows : [])];
        if (!spec) return list;
        const sign = direction === 'desc' ? -1 : 1;
        return list.sort((a, b) => {
            if (spec.number) {
                const left = spec.number(a);
                const right = spec.number(b);
                const leftMissing = !isNum(left);
                const rightMissing = !isNum(right);
                if (leftMissing && rightMissing) return (a.mint < b.mint ? -1 : 1);
                if (leftMissing) return 1;
                if (rightMissing) return -1;
                if (left !== right) return (left - right) * sign;
                return a.mint < b.mint ? -1 : 1;
            }
            const left = spec.text(a);
            const right = spec.text(b);
            const leftMissing = left === '';
            const rightMissing = right === '';
            if (leftMissing && rightMissing) return (a.mint < b.mint ? -1 : 1);
            if (leftMissing) return 1;
            if (rightMissing) return -1;
            const cmp = left.localeCompare(right, 'en', { sensitivity: 'base' });
            return cmp !== 0 ? cmp * sign : (a.mint < b.mint ? -1 : 1);
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

    const api = {
        STATUSES,
        STATUS_RANK,
        STATUS_BLURBS,
        SORT_KEYS,
        cardHref,
        buildCardIndex,
        issuerNames,
        issuerName,
        ruleLabels,
        monitorRows,
        statusTiles,
        ruleStrip,
        ruleOptions,
        issuerOptions,
        filterRows,
        sortRows,
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

    const PATHS = {
        health: './stocks-health.json',
        tokens: './stocks-tokens.json',
        afterhours: './stocks-afterhours.json',
        changes: './stocks-changes.json',
        meteora: './stocks/data/meteora.json',
        trades: './stocks-trades.json',
        cardIndex: './cards/index.json'
    };

    const state = {
        rows: [],
        health: null,
        changes: null,
        meteora: [],
        filters: { status: 'all', issuer: 'all', rule: 'all', search: '' },
        sort: { key: 'liquidity', direction: 'desc' }
    };

    const els = {};

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
        const tiles = statusTiles(state.health, state.rows);
        els.tiles.innerHTML = tiles.map((tile) => {
            const active = state.filters.status === tile.status;
            return `<button type="button" class="mon-tile mon-tile-${tile.status}${active ? ' mon-tile-active' : ''}"
                data-status="${tile.status}" aria-pressed="${active ? 'true' : 'false'}">
                <span class="mon-tile-count">${escapeHtml(fmtNumber(tile.count))}</span>
                <span class="mon-tile-label">${escapeHtml(tile.label)}</span>
                <span class="mon-tile-blurb">${escapeHtml(tile.blurb)}</span>
            </button>`;
        }).join('');
    }

    function renderRuleStrip() {
        const strip = ruleStrip(state.health);
        if (strip.length === 0) {
            els.ruleStrip.innerHTML = '<p class="mon-empty">No token has a worst failing rule.</p>';
            return;
        }
        els.ruleStrip.innerHTML = strip.map((rule) => {
            const active = state.filters.rule === rule.id;
            return `<button type="button" class="mon-rule${active ? ' mon-rule-active' : ''}" data-rule="${escapeHtml(rule.id)}"
                aria-pressed="${active ? 'true' : 'false'}">
                <span class="mon-rule-label">${escapeHtml(rule.label)}</span>
                <span class="mon-rule-count">${escapeHtml(fmtNumber(rule.count))}</span>
                <span class="mon-rule-bar"><span class="mon-rule-fill" style="width:${isNum(rule.share) ? rule.share.toFixed(1) : 0}%"></span></span>
            </button>`;
        }).join('');
    }

    function renderTable() {
        const filtered = filterRows(state.rows, state.filters);
        const sorted = sortRows(filtered, state.sort.key, state.sort.direction);
        els.tokenBody.innerHTML = sorted.length === 0
            ? '<tr><td colspan="10" class="mon-empty">No token matches these filters.</td></tr>'
            : sorted.map(tokenTableRow).join('');
        els.tokenCount.textContent = `${fmtNumber(sorted.length)} of ${fmtNumber(state.rows.length)} mints`;
        for (const th of els.tokenTable.querySelectorAll('th[data-sort]')) {
            const active = th.dataset.sort === state.sort.key;
            th.classList.toggle('sort-active', active);
            th.setAttribute('aria-sort', active ? (state.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
        }
    }

    function renderFilterControls() {
        for (const button of els.tiles.querySelectorAll('.mon-tile')) {
            const active = button.dataset.status === state.filters.status;
            button.classList.toggle('mon-tile-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
        for (const button of els.ruleStrip.querySelectorAll('.mon-rule')) {
            const active = button.dataset.rule === state.filters.rule;
            button.classList.toggle('mon-rule-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
        els.statusFilter.value = state.filters.status;
        els.ruleFilter.value = state.filters.rule;
        els.issuerFilter.value = state.filters.issuer;
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

    function changeRow(change) {
        const row = state.rows.find((candidate) => candidate.mint === change.mint) ?? null;
        const symbol = escapeHtml(change.symbol ?? change.mint ?? DASH);
        const link = row?.href ? `<a href="${escapeHtml(row.href)}">${symbol}</a>` : symbol;
        const before = change.before === null || change.before === undefined ? DASH : String(change.before);
        const after = change.after === null || change.after === undefined ? DASH : String(change.after);
        return `<li>
            <span class="mon-change-token">${link}</span>
            <span class="mon-change-issuer">${escapeHtml(change.issuer ?? '')}</span>
            <span class="mon-change-delta"><code>${escapeHtml(change.field ?? '')}</code> ${escapeHtml(before)} &rarr; ${escapeHtml(after)}</span>
            <span class="mon-change-note">${escapeHtml(change.note ?? '')}</span>
        </li>`;
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
            const row = state.rows.find((candidate) => candidate.mint === pool.mint) ?? null;
            const symbol = escapeHtml(pool.symbol ?? pool.mint ?? DASH);
            const link = row?.href ? `<a class="mon-symbol" href="${escapeHtml(row.href)}">${symbol}</a>` : `<span class="mon-symbol">${symbol}</span>`;
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

    function renderAll() {
        renderTiles();
        renderRuleStrip();
        renderFilterControls();
        renderTable();
        renderChanges();
        renderEvents();
        renderMeteora();
    }

    function setFilter(patch) {
        Object.assign(state.filters, patch);
        renderFilterControls();
        renderTable();
    }

    async function loadJson(path, { required = true } = {}) {
        const res = await fetch(path, { cache: 'no-store' });
        if (!res.ok) {
            if (required) throw new Error(`${path}: HTTP ${res.status}`);
            return null;
        }
        return res.json();
    }

    async function boot() {
        els.status = document.getElementById('status');
        els.dataAsOf = document.getElementById('dataAsOf');
        els.tiles = document.getElementById('statusTiles');
        els.ruleStrip = document.getElementById('ruleStrip');
        els.statusFilter = document.getElementById('statusFilter');
        els.issuerFilter = document.getElementById('issuerFilter');
        els.ruleFilter = document.getElementById('ruleFilter');
        els.searchFilter = document.getElementById('searchFilter');
        els.resetFilters = document.getElementById('resetFilters');
        els.tokenTable = document.getElementById('tokenTable');
        els.tokenBody = document.getElementById('tokenBody');
        els.tokenCount = document.getElementById('tokenCount');
        els.changeRange = document.getElementById('changeRange');
        els.changeStrip = document.getElementById('changeStrip');
        els.changeGroups = document.getElementById('changeGroups');
        els.eventList = document.getElementById('eventList');
        els.meteoraBody = document.getElementById('meteoraBody');
        els.meteoraCount = document.getElementById('meteoraCount');

        try {
            const [health, tokens, afterhours, changes, meteora, trades, cardIndexJson] = await Promise.all([
                loadJson(PATHS.health),
                loadJson(PATHS.tokens),
                loadJson(PATHS.afterhours, { required: false }),
                loadJson(PATHS.changes, { required: false }),
                loadJson(PATHS.meteora, { required: false }),
                loadJson(PATHS.trades, { required: false }),
                loadJson(PATHS.cardIndex, { required: false })
            ]);

            state.health = health;
            state.changes = changes;
            state.rows = monitorRows({ health, tokens, afterhours, cardIndex: buildCardIndex(cardIndexJson) });
            state.meteora = meteoraRows({ meteora, tokens, trades });

            els.issuerFilter.innerHTML = '<option value="all">All issuers</option>'
                + issuerOptions(state.rows).map((issuer) => `<option value="${escapeHtml(issuer.slug)}">${escapeHtml(issuer.name)}</option>`).join('');
            els.ruleFilter.innerHTML = '<option value="all">Any worst rule</option>'
                + ruleOptions(health).map((rule) => `<option value="${escapeHtml(rule.id)}">${escapeHtml(rule.label)}</option>`).join('');

            if (els.dataAsOf) {
                els.dataAsOf.textContent = fmtDateTime(health?.generatedAt);
                els.dataAsOf.setAttribute('datetime', health?.generatedAt ?? '');
            }
            renderAll();
            els.status.hidden = true;
        } catch (err) {
            els.status.hidden = false;
            els.status.classList.add('status-error');
            els.status.textContent = `Could not load the monitor data: ${err.message}`;
            throw err;
        }

        els.tiles.addEventListener('click', (event) => {
            const button = event.target.closest('.mon-tile');
            if (!button) return;
            setFilter({ status: state.filters.status === button.dataset.status ? 'all' : button.dataset.status });
        });
        els.ruleStrip.addEventListener('click', (event) => {
            const button = event.target.closest('.mon-rule');
            if (!button) return;
            setFilter({ rule: state.filters.rule === button.dataset.rule ? 'all' : button.dataset.rule });
        });
        els.statusFilter.addEventListener('change', () => setFilter({ status: els.statusFilter.value }));
        els.issuerFilter.addEventListener('change', () => setFilter({ issuer: els.issuerFilter.value }));
        els.ruleFilter.addEventListener('change', () => setFilter({ rule: els.ruleFilter.value }));
        els.searchFilter.addEventListener('input', () => setFilter({ search: els.searchFilter.value }));
        els.resetFilters.addEventListener('click', () => {
            els.searchFilter.value = '';
            setFilter({ status: 'all', issuer: 'all', rule: 'all', search: '' });
        });
        els.tokenTable.addEventListener('click', (event) => {
            const th = event.target.closest('th[data-sort]');
            if (!th) return;
            const key = th.dataset.sort;
            if (state.sort.key === key) {
                state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                state.sort.key = key;
                // A number reads most usefully largest-first; a name reads A–Z.
                state.sort.direction = SORT_KEYS[key]?.number ? 'desc' : 'asc';
            }
            renderTable();
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    return api;
}));
