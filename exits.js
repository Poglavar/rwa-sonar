/**
 * DOM layer for exits.html. Loads ./stocks-exits.json (stocks/build-exits.mjs) and renders the
 * per-wrapper exit bars, the sortable exit-depth table and the DeFi-usage Sankey. All shaping is in
 * stocks/lib/exits-view.js and stocks/lib/sankey-layout.js (pure, jest-tested); this file only
 * builds markup from their output and wires events. The chosen underlying lives in `?u=` so a view
 * is a link. Wrapped in an IIFE so it declares no globals.
 */
(function () {
    'use strict';
    if (typeof document === 'undefined') return;

    const fmt = window.__rwaFmt;
    const view = window.__rwaExitsView;
    const sankey = window.__rwaSankey;
    const { escapeHtml: esc, fmtMoney, fmtDateTime, isSafeUrl } = fmt;

    const TABLE_PAGE = 60;
    const state = { data: null, rows: [], sort: 'depth', asc: false, filter: '', showAll: false, ticker: null };
    const $ = (id) => document.getElementById(id);

    function status(text, isError) {
        const el = $('status');
        el.hidden = !text;
        el.textContent = text || '';
        el.classList.toggle('status-error', Boolean(isError));
    }

    function link(url, label) {
        return typeof url === 'string' && isSafeUrl(url)
            ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>` : '';
    }

    function cardLink(slug, symbol) {
        return slug ? `<a href="./cards/${encodeURIComponent(slug)}.html">${esc(symbol)}</a>` : esc(symbol);
    }

    function dossierLink(slug, label) {
        return slug ? `<a href="./protocols/${encodeURIComponent(slug)}.html">${esc(label)}</a>` : esc(label);
    }

    function stageChip(stage, asOf) {
        const label = sankey.STAGE_LABELS[stage] ?? stage;
        return `<span class="ex-stage stage-${esc(stage)}" title="Proof stage as of ${esc(fmtDateTime(asOf))}">${esc(label)}</span>`;
    }

    // ---- evidence line -------------------------------------------------------------------------

    function renderEvidence(d) {
        const s = d.sources ?? {};
        $('evPools').textContent = `${s.venues?.provider ?? 'DexScreener'} · ${fmtDateTime(s.venues?.dexscreenerFetchedAt ?? s.venues?.fetchedAt)} · ${s.venues?.mintsCovered ?? '—'} of ${d.tokens.length} mints collected`;
        $('evUsage').textContent = `Exact-token registries and pools · ${fmtDateTime(s.defiUsage?.fetchedAt)}; decoded routes reviewed ${fmtDateTime(s.marketResearch?.reviewedAt)}`;
        $('evScan').textContent = s.redemptionObservations ? `Recurring on-chain scan · ${fmtDateTime(s.redemptionObservations.generatedAt)}` : 'Not available in this build';
        $('evBuilt').textContent = fmtDateTime(d.builtAt);
    }

    // ---- part 1: one underlying ----------------------------------------------------------------

    function renderPicker(options) {
        $('underlyingSelect').innerHTML = options.map((o) => `<option value="${esc(o.ticker)}"${o.ticker === state.ticker ? ' selected' : ''}>${esc(o.ticker)} — ${o.wrappers} wrapper${o.wrappers === 1 ? '' : 's'}${o.withPool ? `, ${o.withPool} with a pool` : ''}</option>`).join('');
    }

    function barSvg(bar, symbol) {
        if (!bar.segments.length) return '';
        const rects = bar.segments.map((s) => `<rect class="venue-${esc(s.slot)}" x="${s.x.toFixed(2)}" y="0" width="${s.w.toFixed(2)}" height="10" tabindex="0"><title>${esc(`${s.venueName}: ${fmtMoney(s.usd)} pool liquidity in ${s.pools} pool${s.pools === 1 ? '' : 's'}`)}</title></rect>`).join('');
        return `<svg class="ex-bar" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${esc(`${symbol}: observed DEX pool liquidity by venue`)}"><rect class="ex-bar-track" x="0" y="0" width="100" height="10"/>${rects}</svg>`;
    }

    function poolList(token) {
        return `<ul class="ex-pools">${token.pools.map((p) => {
            const direct = p.meteora ? ` <small>(Meteora's own API: ${esc(fmtMoney(p.meteora.liquidityUsd))}, ${esc(fmtDateTime(p.meteora.fetchedAt))})</small>` : '';
            return `<li><i class="ex-swatch venue-${esc(view.VENUE_SLOTS.includes(p.venue) ? p.venue : 'other')}" aria-hidden="true"></i><strong>${esc(p.venueName)}</strong> ${esc(token.symbol)}/${esc(p.quote ?? '?')} · ${esc(fmtMoney(p.liquidityUsd))} liquidity · ${esc(fmtMoney(p.volume24Usd))} 24 h volume${direct} ${link(p.url, 'pool')}</li>`;
        }).join('')}</ul>`;
    }

    function wrapperCard(token, scaleMax) {
        const issuer = state.data.issuers[token.issuer] ?? null;
        const bar = view.barSegments(token.pools, scaleMax);
        const defunct = issuer?.status === 'defunct' ? ' <span class="ex-flag">issuer defunct</span>' : '';
        let dex;
        if (token.venueCoverage === 'observed') {
            dex = `<p class="ex-depth"><strong>${esc(fmtMoney(token.dexLiquidityUsd))}</strong> observed pool liquidity in ${token.pools.length} pool${token.pools.length === 1 ? '' : 's'} <small>· DexScreener, ${esc(fmtDateTime(token.dexFetchedAt))}</small></p>${barSvg(bar, token.symbol)}${poolList(token)}`;
        } else if (token.venueCoverage === 'none-observed') {
            dex = `<p class="ex-missing">No DEX pool observed for this exact mint <small>· DexScreener, ${esc(fmtDateTime(token.dexFetchedAt))}</small></p>`;
        } else {
            dex = '<p class="ex-missing">Venues were not collected for this mint, so we do not know whether a pool exists.</p>';
        }
        const r = view.redemptionLane(token, issuer);
        const redemption = `<div class="ex-lane"><h4>Issuer redemption <span class="ex-route route-${esc(r.state)}">${esc(r.label)}</span></h4><ul>${r.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${r.url ? `<p>${link(r.url, 'Route source')}</p>` : ''}${r.minimum ? `<details><summary>Stated minimum and terms</summary><p>${esc(r.minimum)}</p></details>` : ''}</div>`;
        const lend = view.lendingLane(token);
        const lending = `<div class="ex-lane"><h4>Lending markets</h4>${lend.rows.length ? `<ul>${lend.rows.map((l) => `<li>${dossierLink(l.dossier, l.protocol)} ${stageChip(l.stage, l.stageAsOf)} ${esc(l.text)}${l.sizeUsd !== null ? ` · ${esc(fmtMoney(l.sizeUsd))} reported market size` : ''}</li>`).join('')}</ul>${lend.lenderExit ? `<p class="ex-lender"><strong>If you default, the lender's exit:</strong> ${esc(lend.lenderExit.label)} — ${esc(lend.lenderExit.reason)}</p>` : ''}` : '<p class="ex-missing">No checked lending market lists this exact token.</p>'}</div>`;
        return `<article class="ex-wrapper"><header><h3>${cardLink(token.cardSlug, token.symbol)}</h3><span>${esc(issuer?.name ?? token.issuer)}${defunct}</span><code title="Exact mint">${esc(token.mint)}</code></header><div class="ex-lane ex-lane-dex"><h4>DEX pools</h4>${dex}</div>${redemption}${lending}</article>`;
    }

    function renderUnderlying() {
        const wrappers = view.wrappersOf(state.data.tokens, state.ticker);
        const scaleMax = Math.max(0, ...wrappers.map((t) => (Number.isFinite(t.dexLiquidityUsd) ? t.dexLiquidityUsd : 0)));
        $('wrappers').innerHTML = wrappers.length ? wrappers.map((t) => wrapperCard(t, scaleMax)).join('') : '<p class="ex-missing">No wrapper of this stock is catalogued.</p>';
        const venues = new Map();
        for (const t of wrappers) for (const v of view.venueTotals(t.pools)) venues.set(v.slot, v.slot === 'other' ? 'Other venue' : v.venueName);
        $('venueKey').innerHTML = [...venues].map(([slot, name]) => `<li><i class="ex-swatch venue-${esc(slot)}" aria-hidden="true"></i>${esc(name)}</li>`).join('');
        $('venueKey').hidden = venues.size === 0;
        $('deepLink').href = `./exits.html?u=${encodeURIComponent(state.ticker)}`;
    }

    // ---- part 1b: table ------------------------------------------------------------------------

    function renderTable() {
        const rows = view.sortRows(view.filterRows(state.rows, state.filter), state.sort, state.asc);
        const shown = state.showAll ? rows : rows.slice(0, TABLE_PAGE);
        $('tableCount').textContent = `(${rows.length} of ${state.rows.length})`;
        document.querySelector('#depthTable tbody').innerHTML = shown.map((r) => {
            const depth = r.coverage === 'observed' ? esc(fmtMoney(r.depth))
                : `<span class="ex-missing" title="${esc(view.COVERAGE_LABELS[r.coverage])}">${r.coverage === 'none-observed' ? 'no pool observed' : 'not collected'}</span>`;
            const exact = r.routeExact === true ? ' <small>(this token seen)</small>' : '';
            return `<tr><th scope="row">${cardLink(r.cardSlug, r.symbol)}${r.issuerStatus === 'defunct' ? ' <span class="ex-flag">defunct</span>' : ''}</th><td>${r.underlying ? `<a href="?u=${encodeURIComponent(r.underlying)}" data-u="${esc(r.underlying)}">${esc(r.underlying)}</a>` : '<span class="ex-missing" title="No underlying ticker recorded">—</span>'}</td><td>${esc(r.issuerName)}</td><td class="num">${depth}</td><td class="num">${r.pools === null ? '<span class="ex-missing">—</span>' : r.pools}</td><td>${esc(r.topVenue ?? '—')}</td><td><span class="ex-route route-${esc(r.route)}">${esc(r.routeLabel)}</span>${exact}</td><td class="num">${r.lending}</td></tr>`;
        }).join('');
        $('showAll').hidden = state.showAll || rows.length <= TABLE_PAGE;
        $('showAll').textContent = `Show all ${rows.length}`;
        for (const th of document.querySelectorAll('#depthTable th[data-key]')) {
            th.setAttribute('aria-sort', th.dataset.key === state.sort ? (state.asc ? 'ascending' : 'descending') : 'none');
        }
    }

    // ---- part 2: Sankey ------------------------------------------------------------------------

    function issuerNames() {
        return Object.fromEntries(Object.values(state.data.issuers).map((i) => [i.slug, i.name]));
    }

    function renderSankey() {
        const box = $('sankey');
        const graph = sankey.aggregateFlows(state.data.flows, { issuerNames: issuerNames() });
        const width = Math.round(box.clientWidth || 0);
        const narrow = width < 640;
        const labelSide = Math.min(190, Math.max(120, width * 0.19));
        const layout = narrow ? null : sankey.layoutSankey(graph, { width, height: sankey.suggestHeight(graph, { min: 420 }), labelLeft: labelSide, labelRight: labelSide });
        const legible = layout !== null && sankey.sankeyLegible(layout, width);
        // The box stays in the layout (only emptied) so its width can still be measured on resize.
        box.innerHTML = legible ? sankey.sankeySvg(layout, { protocolHref: './protocols/' }) : '';
        $('sankeyNarrow').hidden = legible;
    }

    function renderFlowList() {
        const paths = sankey.rankedPaths(state.data.flows, { issuerNames: issuerNames() });
        $('flowList').innerHTML = paths.map((p) => {
            const usd = sankey.money(p.usd);
            const basis = p.bases.map((b) => sankey.BASIS_LABELS[b] ?? b).join(' + ');
            const n = p.usdRows + p.noUsdRows;
            const amount = usd === null ? '<span class="ex-missing">USD not reported</span>' : `${esc(usd)} <small>${esc(basis)}${p.noUsdRows ? ` · +${p.noUsdRows} without USD` : ''}</small>`;
            const tokens = p.rows.map((r) => `<li>${dossierLink(r.dossier, r.symbol)}${r.usd !== null ? ` · ${esc(fmtMoney(r.usd))}` : ''}${r.via?.length ? ` <small>· routed via ${esc(r.via.join(', '))}; overlaps that lending link</small>` : ''} <small>· as of ${esc(fmtDateTime(r.stageAsOf))}</small></li>`).join('');
            return `<li class="stage-edge stage-${esc(p.stage)}"><div class="ex-flow-head"><span class="ex-flow-path">${esc(p.issuerName)} → ${esc(p.protocol)} → ${esc(p.actionLabel)}</span><span class="ex-flow-usd">${amount}</span></div>${stageChip(p.stage, p.rows[0]?.stageAsOf)}<details><summary>${n} exact-token integration${n === 1 ? '' : 's'}</summary><ul>${tokens}</ul></details></li>`;
        }).join('');
    }

    function renderStageKey() {
        const used = new Set(state.data.flows.map((f) => f.stage));
        $('stageKey').innerHTML = sankey.STAGES.map((s) => `<li${used.has(s) ? '' : ' class="ex-unused"'}><i class="ex-swatch stage-${esc(s)}" aria-hidden="true"></i>${esc(sankey.STAGE_LABELS[s])}${used.has(s) ? '' : ' <small>(none yet)</small>'}</li>`).join('')
            + '<li><i class="ex-swatch ex-swatch-dashed" aria-hidden="true"></i>No USD reported</li>';
    }

    // ---- wiring --------------------------------------------------------------------------------

    function choose(ticker, push) {
        state.ticker = ticker;
        $('underlyingSelect').value = ticker;
        renderUnderlying();
        if (push) history.pushState({ u: ticker }, '', `?u=${encodeURIComponent(ticker)}`);
    }

    function wire(options) {
        $('underlyingSelect').addEventListener('change', (e) => choose(e.target.value, true));
        window.addEventListener('popstate', () => choose(view.selectedUnderlying(location.search, options), false));
        $('tableFilter').addEventListener('input', (e) => { state.filter = e.target.value; renderTable(); });
        $('showAll').addEventListener('click', () => { state.showAll = true; renderTable(); });
        for (const th of document.querySelectorAll('#depthTable th[data-key]')) {
            th.querySelector('button').addEventListener('click', () => {
                const key = th.dataset.key;
                state.asc = state.sort === key ? !state.asc : ['symbol', 'underlying', 'issuer', 'venue', 'route'].includes(key);
                state.sort = key;
                renderTable();
            });
        }
        document.querySelector('#depthTable tbody').addEventListener('click', (e) => {
            const a = e.target.closest('a[data-u]');
            if (!a || !a.dataset.u) return;
            e.preventDefault();
            choose(a.dataset.u, true);
            $('exitSection').scrollIntoView({ block: 'start' });
        });
        let lastWidth = $('sankey').clientWidth;
        window.addEventListener('resize', () => {
            const w = $('sankey').clientWidth;
            if (w !== lastWidth) { lastWidth = w; renderSankey(); }
        });
    }

    async function main() {
        status('Loading exit routes…');
        let data;
        try {
            const res = await fetch('./stocks-exits.json', { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            data = await res.json();
        } catch (err) {
            status(`Could not load stocks-exits.json (${err.message}). Nothing is shown below.`, true);
            throw err;
        }
        state.data = data;
        state.rows = view.tableRows(data.tokens, data.issuers);
        const options = view.underlyingOptions(data.tokens);
        state.ticker = view.selectedUnderlying(location.search, options);
        renderEvidence(data);
        renderPicker(options);
        renderUnderlying();
        renderTable();
        renderStageKey();
        renderSankey();
        renderFlowList();
        wire(options);
        status('');
    }

    main();
})();
