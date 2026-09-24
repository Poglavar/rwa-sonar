/**
 * Renders tracking.html from the static build stocks-tracking.json (stocks/build-tracking.mjs):
 *   1. the premium/discount tracker — for one underlying (`?u=NVDA`), every Solana wrapper's
 *      observed premium to the share's reference price as POINTS over time (never joined by a
 *      line: nothing is known between two observations), with the underlying market's closed
 *      stretches shaded, and each point's kind, reference source and observation count on it;
 *   2. the holder-concentration-vs-liquidity scatter — every token with both values, log x, the
 *      "one wallet, nowhere to sell" corner shaded, a tap on a dot opening that token's card, and
 *      every token lacking a value counted and listed rather than drawn at zero.
 *
 * Everything above the DOM section is pure (no DOM, no fetch, no clock) and exported for jest
 * (tracking-page.test.js). UMD-wrapped so it declares no globals beside window.__tracking.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__tracking = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const fmt = (typeof __rwaFmt !== 'undefined') ? __rwaFmt : require('./stocks/lib/fmt.js');
    const { escapeHtml, cardSlug: fallbackSlug } = fmt;

    const DATA_PATH = './stocks-tracking.json';
    const CARDS_DIR = './cards/';
    const DEFAULT_UNDERLYING = 'NVDA';
    const HOUR_MS = 3600 * 1000;
    const DAY_MS = 24 * HOUR_MS;

    /** Categorical slots (tracking.css --trk-s1..s8), assigned in fixed order, never cycled. */
    const SERIES_SLOTS = 8;
    /** Scatter colours: the three largest programmes get a slot, everything else folds to "other". */
    const SCATTER_ISSUER_SLOTS = ['xstocks-backed', 'ondo-global-markets', 'backpack-securities'];

    const KIND_LABELS = {
        trades: 'on-chain trades (hourly median)',
        quote: 'Jupiter quote vs reference, same fetch',
        snapshot: 'daily snapshot'
    };
    const SOURCE_LABELS = {
        pyth: 'Pyth (entitled feed)',
        'ondo-implied': 'issuer-implied (Ondo market cap / shares outstanding)',
        'issuer-mark': 'issuer mark price'
    };
    const SESSION_LABELS = {
        open: 'US market open',
        closed: 'US market closed',
        holiday: 'US market holiday',
        unknown: 'market hours unknown'
    };

    // --- pure helpers ------------------------------------------------------------------------

    function isNum(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function ms(iso) {
        if (typeof iso !== 'string') return null;
        const out = Date.parse(iso);
        return Number.isFinite(out) ? out : null;
    }

    /** "2026-09-23 22:19 UTC" — the page states times in UTC so every reader sees the same instant. */
    function fmtUtc(iso) {
        const t = ms(iso);
        if (t === null) return '—';
        return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    }

    function fmtSignedPct(value, digits = 2) {
        if (!isNum(value)) return '—';
        return (value > 0 ? '+' : value < 0 ? '−' : '±') + Math.abs(value).toFixed(digits) + '%';
    }

    function fmtUsd(value) {
        if (!isNum(value)) return '—';
        if (value >= 1000) return '$' + Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
        if (value >= 1) return '$' + (Number.isInteger(value) || value >= 100 ? Math.round(value) : value.toFixed(2));
        return '$' + Number(value.toPrecision(1));
    }

    function sourceLabel(src) {
        if (src === null || src === undefined || src === '') return 'not recorded in the daily snapshot';
        return String(src).split('+').map((s) => SOURCE_LABELS[s] ?? s).join(' + ');
    }

    function slugFor(row) {
        const slug = typeof row?.cardSlug === 'string' && row.cardSlug !== '' ? row.cardSlug : fallbackSlug(row?.symbol, row?.mint);
        return slug || null;
    }

    function cardHref(row) {
        const slug = slugFor(row);
        return slug === null ? null : `${CARDS_DIR}${encodeURIComponent(slug)}.html`;
    }

    /** The underlying the page shows: `?u=` when the data has it, else NVDA, else the best covered. */
    function pickUnderlying(underlyings, search) {
        const list = Array.isArray(underlyings) ? underlyings : [];
        const params = new URLSearchParams(typeof search === 'string' ? search : '');
        const asked = (params.get('u') || '').trim().toUpperCase();
        const find = (ticker) => list.find((u) => String(u.ticker).toUpperCase() === ticker) ?? null;
        return {
            asked: asked || null,
            found: asked ? find(asked) !== null : null,
            ticker: (asked && find(asked)?.ticker) || find(DEFAULT_UNDERLYING)?.ticker || list[0]?.ticker || null
        };
    }

    /** Point counts per kind for one wrapper, for the legend line. */
    function countKinds(points) {
        const out = { total: 0, trades: 0, tradeCount: 0, quote: 0, snapshot: 0 };
        for (const p of Array.isArray(points) ? points : []) {
            out.total += 1;
            if (p.kind === 'trades') { out.trades += 1; out.tradeCount += isNum(p.n) ? p.n : 0; }
            else if (p.kind === 'quote') out.quote += 1;
            else if (p.kind === 'snapshot') out.snapshot += 1;
        }
        return out;
    }

    /** Evenly spaced "nice" ticks covering [lo, hi]. */
    function niceTicks(lo, hi, count = 5) {
        if (!isNum(lo) || !isNum(hi)) return [];
        if (lo === hi) return [lo];
        const raw = (hi - lo) / Math.max(1, count - 1);
        const mag = 10 ** Math.floor(Math.log10(raw));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
        const out = [];
        for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
        return out;
    }

    // --- premium chart -----------------------------------------------------------------------

    /** Chart boxes in SVG units: wide for desktop, narrow for phones so text stays legible. */
    const PREMIUM_DIMS = { wide: { W: 760, H: 300, L: 54, R: 14, T: 14, B: 40 }, compact: { W: 380, H: 280, L: 46, R: 8, T: 12, B: 38 } };
    const SCATTER_DIMS = { wide: { W: 760, H: 440, L: 50, R: 14, T: 14, B: 42 }, compact: { W: 380, H: 400, L: 42, R: 8, T: 12, B: 40 } };

    /**
     * Geometry for one underlying: x = time (UTC), y = premium %. The y domain always contains 0
     * (the reference itself); the x domain runs from the first observation to the build time.
     * Returns null when the underlying has no observation at all.
     */
    function premiumModel(underlying, schedule, generatedAt, compact = false) {
        const { W: PW, H: PH, L: PL, R: PR, T: PT, B: PB } = PREMIUM_DIMS[compact ? 'compact' : 'wide'];
        const wrappers = Array.isArray(underlying?.wrappers) ? underlying.wrappers : [];
        const pts = [];
        wrappers.forEach((w, wi) => {
            (w.points ?? []).forEach((p, pi) => {
                const t = ms(p.t);
                if (t === null || !isNum(p.p)) return;
                pts.push({ ...p, tMs: t, wrapper: wi, index: pi, symbol: w.symbol });
            });
        });
        if (pts.length === 0) return null;
        const endMs = ms(generatedAt) ?? Math.max(...pts.map((p) => p.tMs));
        let x0 = Math.min(...pts.map((p) => p.tMs));
        x0 = Math.floor(x0 / DAY_MS) * DAY_MS;
        const x1 = Math.max(endMs, x0 + DAY_MS);
        let y0 = Math.min(0, ...pts.map((p) => p.p));
        let y1 = Math.max(0, ...pts.map((p) => p.p));
        const pad = Math.max((y1 - y0) * 0.08, 0.1);
        y0 -= pad; y1 += pad;
        const x = (t) => PL + (t - x0) / (x1 - x0) * (PW - PL - PR);
        const y = (v) => PT + (y1 - v) / (y1 - y0) * (PH - PT - PB);
        const bands = (Array.isArray(schedule?.closed) ? schedule.closed : [])
            .map(([from, to, holiday]) => ({ from: Math.max(ms(from), x0), to: Math.min(ms(to), x1), holiday: holiday === 1 }))
            .filter((b) => isNum(b.from) && isNum(b.to) && b.to > b.from)
            .map((b) => ({ ...b, x: x(b.from), w: x(b.to) - x(b.from) }));
        const days = [];
        for (let d = x0; d <= x1; d += DAY_MS) days.push(d);
        return {
            dims: { PW, PH, PL, PR, PT, PB }, compact,
            x0, x1, y0, y1,
            points: pts.map((p) => ({ ...p, cx: x(p.tMs), cy: y(p.p) })),
            bands,
            hoursKnown: Array.isArray(schedule?.closed),
            zeroY: y(0),
            yTicks: niceTicks(y0, y1, 5).map((v) => ({ v, y: y(v) })),
            xTicks: days.map((d) => ({ t: d, x: x(d) }))
        };
    }

    function markSvg(p, slot) {
        const cls = `trk-pt trk-s${slot} trk-kind-${escapeHtml(p.kind)}`;
        const cx = p.cx.toFixed(1), cy = p.cy.toFixed(1);
        // Kind is shape, wrapper is colour: identity never rests on colour alone.
        let shape;
        if (p.kind === 'quote') shape = `<rect x="${(p.cx - 4.5).toFixed(1)}" y="${(p.cy - 4.5).toFixed(1)}" width="9" height="9" rx="1.5"/>`;
        else if (p.kind === 'snapshot') shape = `<path d="M${cx} ${(p.cy - 6).toFixed(1)}L${(p.cx + 6).toFixed(1)} ${cy}L${cx} ${(p.cy + 6).toFixed(1)}L${(p.cx - 6).toFixed(1)} ${cy}Z"/>`;
        else {
            const r = 4 + Math.min(4, Math.log2(Math.max(1, p.n ?? 1)));
            shape = `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}"/>`;
        }
        const label = `${p.symbol} · ${fmtUtc(p.t)} · ${fmtSignedPct(p.p)} · ${KIND_LABELS[p.kind] ?? p.kind}${p.kind === 'trades' ? ` (n=${p.n})` : ''}`;
        return `<g class="${cls}" tabindex="0" role="button" data-w="${p.wrapper}" data-i="${p.index}" aria-label="${escapeHtml(label)}">`
            + `<circle class="trk-hit" cx="${cx}" cy="${cy}" r="12"/>${shape}<title>${escapeHtml(label)}</title></g>`;
    }

    function renderPremiumSvg(model) {
        if (model === null) return '<p class="trk-empty">No premium observation for this underlying yet.</p>';
        const { PW, PH, PL, PR, PT, PB } = model.dims;
        const compact = model.compact;
        const bands = model.bands.map((b) => `<rect class="trk-band${b.holiday ? ' trk-band-holiday' : ''}" x="${b.x.toFixed(1)}" y="${PT}" width="${b.w.toFixed(1)}" height="${PH - PT - PB}"/>`).join('');
        const grid = model.yTicks.map((t) => `<line x1="${PL}" x2="${PW - PR}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/><text x="${PL - 6}" y="${(t.y + 4).toFixed(1)}" text-anchor="end">${escapeHtml(fmtSignedPct(t.v, Math.abs(t.v) < 1 && t.v !== 0 ? 1 : 0))}</text>`).join('');
        const every = compact ? Math.ceil(model.xTicks.length / 4) : Math.ceil(model.xTicks.length / 9);
        const xt = model.xTicks.map((t, i) => {
            const label = new Date(t.t).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });
            return `<line class="trk-day" x1="${t.x.toFixed(1)}" x2="${t.x.toFixed(1)}" y1="${PH - PB}" y2="${PH - PB + 4}"/>`
                + (i % every === 0 ? `<text x="${t.x.toFixed(1)}" y="${PH - PB + 17}" text-anchor="middle">${escapeHtml(label)}</text>` : '');
        }).join('');
        const marks = model.points.map((p) => markSvg(p, (p.wrapper % SERIES_SLOTS) + 1)).join('');
        return `<svg class="trk-svg" viewBox="0 0 ${PW} ${PH}" role="group" aria-label="Premium or discount of each wrapper to the reference price, over time">`
            + `<g class="trk-bands">${bands}</g><g class="trk-grid">${grid}</g>`
            + `<line class="trk-zero" x1="${PL}" x2="${PW - PR}" y1="${model.zeroY.toFixed(1)}" y2="${model.zeroY.toFixed(1)}"/>`
            + `<text class="trk-zero-label" x="${PL + 4}" y="${(model.zeroY - 5).toFixed(1)}">reference price</text>`
            + `<g class="trk-axis">${xt}<text x="${PW - PR}" y="${PH - 4}" text-anchor="end">UTC</text></g>`
            + `<g class="trk-marks">${marks}</g></svg>`;
    }

    /** The detail text for one tapped point. */
    function pointDetailHtml(wrapper, point) {
        if (!wrapper || !point) return '';
        const href = cardHref(wrapper);
        const rows = [
            ['Premium', `<strong>${escapeHtml(fmtSignedPct(point.p))}</strong>`],
            ['Observed', escapeHtml(point.kind === 'trades' ? `${fmtUtc(point.hour)} hour, median trade at ${fmtUtc(point.t)}` : fmtUtc(point.t))],
            ['Market', escapeHtml(SESSION_LABELS[point.session] ?? SESSION_LABELS.unknown)],
            ['Kind', escapeHtml(KIND_LABELS[point.kind] ?? point.kind)],
            ['Observations', point.kind === 'trades'
                ? escapeHtml(`${point.n} trade${point.n === 1 ? '' : 's'}, range ${fmtSignedPct(point.lo)} to ${fmtSignedPct(point.hi)}`)
                : '1'],
            ['Reference', escapeHtml(sourceLabel(point.src))]
        ];
        if (point.kind === 'quote') {
            rows.push(['Prices', escapeHtml(`Jupiter ${fmtUsd(point.price)} vs reference ${fmtUsd(point.ref)}`)]);
            rows.push(['Reference time', escapeHtml(point.atBasis === 'publish-time' ? 'Pyth publish time' : 'time the reference was fetched (the source gives none)')]);
        }
        if (point.kind === 'trades') {
            rows.push(['Paired with', escapeHtml(`reference fetched ${(point.refAt ?? []).map(fmtUtc).join(', ') || '—'} (${point.basis === 'same-closed-session' ? 'same closed session: the reference could not move' : 'within 10 minutes'})`)]);
        }
        if (point.kind === 'snapshot') rows.push(['Snapshot', escapeHtml(`daily snapshot ${point.date ?? ''}, time = snapshot build time`)]);
        return `<h3>${escapeHtml(wrapper.symbol ?? wrapper.mint)}${href ? ` <a href="${escapeHtml(href)}">open card</a>` : ''}</h3>`
            + `<dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
    }

    function legendHtml(underlying, issuers) {
        return (underlying?.wrappers ?? []).map((w, wi) => {
            const c = countKinds(w.points);
            const href = cardHref(w);
            const name = issuers?.[w.issuer] ?? w.issuer ?? 'issuer unknown';
            const counts = c.total === 0
                ? '<span class="trk-missing">no observation</span>'
                : `${c.total} point${c.total === 1 ? '' : 's'}: ${c.trades} trade-hour${c.trades === 1 ? '' : 's'} (${c.tradeCount} trades), ${c.quote} quote${c.quote === 1 ? '' : 's'}, ${c.snapshot} snapshot${c.snapshot === 1 ? '' : 's'}`;
            const symbol = escapeHtml(w.symbol ?? w.mint);
            return `<li><i class="trk-swatch trk-s${(wi % SERIES_SLOTS) + 1}" aria-hidden="true"></i>`
                + `<span><strong>${href ? `<a href="${escapeHtml(href)}">${symbol}</a>` : symbol}</strong> · ${escapeHtml(name)}`
                + `<small>${counts} · reference now: ${escapeHtml(w.refSource ? sourceLabel(w.refSource) : 'none')}</small></span></li>`;
        }).join('');
    }

    function tableHtml(underlying) {
        const rows = [];
        (underlying?.wrappers ?? []).forEach((w) => (w.points ?? []).forEach((p) => rows.push({ w, p })));
        rows.sort((a, b) => (a.p.t < b.p.t ? 1 : a.p.t > b.p.t ? -1 : 0));
        if (!rows.length) return '';
        return `<table class="trk-table"><thead><tr><th scope="col">Observed (UTC)</th><th scope="col">Wrapper</th><th scope="col">Premium</th><th scope="col">Kind</th><th scope="col">n</th><th scope="col">Reference</th><th scope="col">Market</th></tr></thead><tbody>`
            + rows.map(({ w, p }) => `<tr><td>${escapeHtml(fmtUtc(p.t))}</td><td>${escapeHtml(w.symbol ?? w.mint)}</td><td class="trk-num">${escapeHtml(fmtSignedPct(p.p))}</td><td>${escapeHtml(p.kind)}</td><td class="trk-num">${escapeHtml(String(p.n ?? 1))}</td><td>${escapeHtml(p.src ?? 'not recorded')}</td><td>${escapeHtml(p.session ?? 'unknown')}</td></tr>`).join('')
            + '</tbody></table>';
    }

    function optionsHtml(underlyings, selected) {
        return (underlyings ?? []).map((u) => `<option value="${escapeHtml(u.ticker)}"${u.ticker === selected ? ' selected' : ''}>${escapeHtml(u.ticker)} — ${u.wrappers.length} wrapper${u.wrappers.length === 1 ? '' : 's'}, ${u.observations} obs.</option>`).join('');
    }

    // --- scatter -----------------------------------------------------------------------------


    function issuerSlot(issuer) {
        const i = SCATTER_ISSUER_SLOTS.indexOf(issuer);
        return i === -1 ? 'other' : String(i + 1);
    }

    /** Radius from holder count (log), or null when the count is unknown (drawn as a hollow ring). */
    function radiusFor(holderCount) {
        if (!isNum(holderCount) || holderCount < 0) return null;
        return 3 + 1.1 * Math.log10(holderCount + 1);
    }

    function scatterModel(concentration, compact = false) {
        const { W: SW, H: SH, L: SL, R: SR, T: ST, B: SB } = SCATTER_DIMS[compact ? 'compact' : 'wide'];
        const rows = Array.isArray(concentration?.plotted) ? concentration.plotted.filter((r) => isNum(r.liquidityUsd) && r.liquidityUsd > 0 && isNum(r.top1SharePct)) : [];
        if (!rows.length) return null;
        const corner = concentration.corner ?? { minTop1SharePct: 50, maxLiquidityUsd: 10000 };
        const lx0 = Math.floor(Math.log10(Math.min(...rows.map((r) => r.liquidityUsd), corner.maxLiquidityUsd)));
        const lx1 = Math.ceil(Math.log10(Math.max(...rows.map((r) => r.liquidityUsd), corner.maxLiquidityUsd * 10)));
        const x = (v) => SL + (Math.log10(v) - lx0) / (lx1 - lx0) * (SW - SL - SR);
        const y = (v) => ST + (100 - Math.min(100, Math.max(0, v))) / 100 * (SH - ST - SB);
        const dots = rows.map((r) => ({ ...r, cx: x(r.liquidityUsd), cy: y(r.top1SharePct), r: radiusFor(r.holderCount), slot: issuerSlot(r.issuer) }))
            // Big dots first so small ones stay on top and tappable.
            .sort((a, b) => (b.r ?? 0) - (a.r ?? 0));
        const xTicks = [];
        for (let e = lx0; e <= lx1; e += 1) xTicks.push({ v: 10 ** e, x: x(10 ** e) });
        return {
            dims: { SW, SH, SL, SR, ST, SB }, compact,
            dots,
            corner: { ...corner, x: SL, y: ST, w: x(corner.maxLiquidityUsd) - SL, h: y(corner.minTop1SharePct) - ST },
            xTicks,
            yTicks: [0, 25, 50, 75, 100].map((v) => ({ v, y: y(v) }))
        };
    }

    function renderScatterSvg(model, issuers) {
        if (model === null) return '<p class="trk-empty">No token has both a liquidity and a holder figure.</p>';
        const { SW, SH, SL, SR, ST, SB } = model.dims;
        const c = model.corner;
        const grid = model.yTicks.map((t) => `<line x1="${SL}" x2="${SW - SR}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/><text x="${SL - 6}" y="${(t.y + 4).toFixed(1)}" text-anchor="end">${t.v}%</text>`).join('')
            + model.xTicks.map((t, i) => `<line x1="${t.x.toFixed(1)}" x2="${t.x.toFixed(1)}" y1="${ST}" y2="${SH - SB}"/>`
                + ((!model.compact || (model.xTicks.length - 1 - i) % 2 === 0) ? `<text x="${t.x.toFixed(1)}" y="${SH - SB + 16}" text-anchor="middle">${escapeHtml(fmtUsd(t.v))}</text>` : '')).join('');
        const dots = model.dots.map((d) => {
            const href = cardHref(d);
            const label = `${d.symbol ?? d.mint} (${issuers?.[d.issuer] ?? d.issuer ?? 'issuer unknown'}): top unlabelled wallet ${d.top1SharePct.toFixed(1)}% of supply, liquidity ${fmtUsd(d.liquidityUsd)} (${d.liquiditySource}), ${isNum(d.holderCount) ? `${Math.round(d.holderCount).toLocaleString('en')} holders` : 'holder count unknown'}${d.corner ? ', in the one-wallet, thin-liquidity corner' : ''}`;
            const r = d.r ?? 3.5;
            const cls = `trk-dot trk-i${d.slot}${d.r === null ? ' trk-dot-nocount' : ''}${d.corner ? ' trk-dot-corner' : ''}`;
            const shape = `<circle class="${cls}" cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="${r.toFixed(1)}"/>`;
            return href
                ? `<a href="${escapeHtml(href)}" aria-label="${escapeHtml(label)}">${shape}<title>${escapeHtml(label)}</title></a>`
                : `<g aria-label="${escapeHtml(label)}">${shape}<title>${escapeHtml(label)}</title></g>`;
        }).join('');
        return `<svg class="trk-svg trk-scatter" viewBox="0 0 ${SW} ${SH}" role="group" aria-label="Top unlabelled holder share against pool liquidity, one dot per token">`
            + `<rect class="trk-corner" x="${c.x}" y="${c.y}" width="${c.w.toFixed(1)}" height="${c.h.toFixed(1)}"/>`
            + `<text class="trk-corner-label" x="${c.x + 6}" y="${c.y + 16}">${model.compact ? 'one wallet,' : 'one wallet, thin liquidity'}</text>`
            + (model.compact ? `<text class="trk-corner-label" x="${c.x + 6}" y="${c.y + 32}">thin liquidity</text>` : '')
            + `<g class="trk-grid">${grid}</g>`
            + `<text class="trk-axis-title" x="${SW - SR}" y="${SH - 4}" text-anchor="end">pool liquidity (log) →</text>`
            + `<text class="trk-axis-title" x="${SL + 4}" y="${ST + (SH - ST - SB) - 6}">↑ top unlabelled wallet</text>`
            + `<g class="trk-dots">${dots}</g></svg>`;
    }

    function scatterLegendHtml(concentration, issuers) {
        const counts = new Map();
        for (const r of concentration?.plotted ?? []) counts.set(issuerSlot(r.issuer), (counts.get(issuerSlot(r.issuer)) ?? 0) + 1);
        const others = [...new Set((concentration?.plotted ?? []).filter((r) => issuerSlot(r.issuer) === 'other').map((r) => issuers?.[r.issuer] ?? r.issuer))].sort();
        const items = SCATTER_ISSUER_SLOTS.map((slug, i) => ({ slot: String(i + 1), name: issuers?.[slug] ?? slug, n: counts.get(String(i + 1)) ?? 0 }));
        if (others.length) items.push({ slot: 'other', name: `Other issuers (${others.join(', ')})`, n: counts.get('other') ?? 0 });
        return items.map((it) => `<li><i class="trk-swatch trk-i${it.slot}" aria-hidden="true"></i><span>${escapeHtml(it.name)} <small>${it.n} plotted</small></span></li>`).join('')
            + '<li><i class="trk-swatch trk-swatch-ring" aria-hidden="true"></i><span>Hollow ring: holder count unknown <small>size otherwise grows with holder count (log)</small></span></li>';
    }

    function tokenLinks(rows) {
        return rows.map((r) => {
            const href = cardHref(r);
            const label = escapeHtml(r.symbol ?? r.mint);
            return href ? `<a href="${escapeHtml(href)}">${label}</a>` : `<span>${label}</span>`;
        }).join(', ');
    }

    function notPlottedSummary(concentration) {
        const rows = Array.isArray(concentration?.notPlotted) ? concentration.notPlotted : [];
        const has = (r, tag) => r.missing.includes(tag);
        const liqOnly = rows.filter((r) => (has(r, 'liquidity') || has(r, 'zero-liquidity')) && !has(r, 'holders'));
        const holdersOnly = rows.filter((r) => has(r, 'holders') && !has(r, 'liquidity') && !has(r, 'zero-liquidity'));
        const both = rows.filter((r) => has(r, 'holders') && (has(r, 'liquidity') || has(r, 'zero-liquidity')));
        return {
            total: rows.length,
            text: `Not plotted: ${rows.length} (missing liquidity: ${liqOnly.length}, missing holders: ${holdersOnly.length}, missing both: ${both.length})`,
            groups: [
                { label: 'Missing liquidity only', rows: liqOnly },
                { label: 'Missing holder data only', rows: holdersOnly },
                { label: 'Missing both', rows: both }
            ]
        };
    }

    const api = {
        DATA_PATH, DEFAULT_UNDERLYING, KIND_LABELS, SOURCE_LABELS, SCATTER_ISSUER_SLOTS,
        fmtUtc, fmtSignedPct, fmtUsd, sourceLabel, cardHref, pickUnderlying, countKinds, niceTicks,
        premiumModel, renderPremiumSvg, pointDetailHtml, legendHtml, tableHtml, optionsHtml,
        issuerSlot, radiusFor, scatterModel, renderScatterSvg, scatterLegendHtml, notPlottedSummary, tokenLinks
    };

    // --- DOM ----------------------------------------------------------------------------------

    if (typeof document === 'undefined') return api;

    const state = { data: null, ticker: null };
    const $ = (id) => document.getElementById(id);

    function log(...args) {
        console.log(`[${new Date().toISOString()}] tracking:`, ...args);
    }

    function setStatus(text, isError) {
        const el = $('status');
        el.hidden = !text;
        el.textContent = text || '';
        el.classList.toggle('status-error', Boolean(isError));
    }

    function currentUnderlying() {
        return (state.data?.premium?.underlyings ?? []).find((u) => u.ticker === state.ticker) ?? null;
    }

    function renderPremium() {
        const data = state.data;
        const underlying = currentUnderlying();
        const schedule = underlying && Number.isInteger(underlying.schedule) ? data.premium.schedules[underlying.schedule] : null;
        const compact = window.matchMedia('(max-width: 560px)').matches;
        const model = premiumModel(underlying, schedule, data.generatedAt, compact);
        $('premiumChart').innerHTML = renderPremiumSvg(model);
        $('premiumLegend').innerHTML = legendHtml(underlying, data.issuers);
        $('premiumTable').innerHTML = tableHtml(underlying);
        $('premiumDetail').innerHTML = '<p class="trk-hint">Tap or focus a point to see what it is made of.</p>';
        $('premiumHours').textContent = schedule?.closed
            ? 'Shaded: the US market for this share was closed (nights, weekends; darker = holiday). The reference price cannot move then; the token still trades.'
            : 'Market hours unknown for this underlying, so no hours are shaded.';
        const obs = underlying?.observations ?? 0;
        $('premiumCount').textContent = `${underlying?.ticker ?? '—'}: ${obs} observation${obs === 1 ? '' : 's'} across ${underlying?.wrappers.length ?? 0} wrapper${underlying?.wrappers.length === 1 ? '' : 's'}`;
    }

    function showPoint(target) {
        const g = target.closest('.trk-pt');
        if (!g) return;
        const underlying = currentUnderlying();
        const wrapper = underlying?.wrappers?.[Number(g.dataset.w)];
        const point = wrapper?.points?.[Number(g.dataset.i)];
        document.querySelectorAll('.trk-pt.is-selected').forEach((el) => el.classList.remove('is-selected'));
        g.classList.add('is-selected');
        $('premiumDetail').innerHTML = pointDetailHtml(wrapper, point);
    }

    function renderScatter() {
        const data = state.data;
        const c = data.concentration;
        const compact = window.matchMedia('(max-width: 560px)').matches;
        $('scatterChart').innerHTML = renderScatterSvg(scatterModel(c, compact), data.issuers);
        $('scatterLegend').innerHTML = scatterLegendHtml(c, data.issuers);
        const corner = (c.plotted ?? []).filter((r) => r.corner).sort((a, b) => b.top1SharePct - a.top1SharePct);
        $('cornerCount').textContent = `${corner.length} of ${c.counts.plotted} plotted tokens`;
        $('cornerList').innerHTML = corner.map((r) => `<li>${tokenLinks([r])} <small>${escapeHtml(r.top1SharePct.toFixed(1))}% in one wallet · ${escapeHtml(fmtUsd(r.liquidityUsd))} liquidity · ${escapeHtml(data.issuers?.[r.issuer] ?? r.issuer ?? '')}</small></li>`).join('') || '<li>None.</li>';
        const np = notPlottedSummary(c);
        $('notPlottedSummary').textContent = np.text;
        $('notPlottedList').innerHTML = np.groups.filter((g) => g.rows.length).map((g) => `<h4>${escapeHtml(g.label)} (${g.rows.length})</h4><p>${tokenLinks(g.rows)}</p>`).join('');
        $('scatterSources').textContent = `Holders read ${fmtUtc(c.holdersFetchedAt)} · Jupiter liquidity and holder counts read ${fmtUtc(c.universeFetchedAt)} · DexScreener pools read ${fmtUtc(c.venuesFetchedAt)} · liquidity source: Jupiter for ${c.counts.liquidityFromJupiter}, DexScreener pool sum for ${c.counts.liquidityFromDexScreener}.`;
    }

    function renderSources() {
        const d = state.data;
        const inp = d.inputs ?? {};
        const pc = d.premium?.counts ?? {};
        $('premiumSources').textContent = `Built ${fmtUtc(d.generatedAt)} · reference prices fetched ${fmtUtc(inp.referenceFetchedAt)} · trade tape ${fmtUtc(inp.tradesGeneratedAt)} (collecting since ${fmtUtc(inp.tradesCollectingSince)}) · daily snapshots ${(inp.historyDates ?? []).join(', ') || 'none'} · ${pc.pairedTrades ?? 0} trades paired with a contemporaneous reference; ${inp.unpairedTradesThisRun?.noContemporaneousReference ?? '—'} trades in this run had none and are not plotted.`;
    }

    function selectUnderlying(ticker, push) {
        state.ticker = ticker;
        const url = new URL(window.location.href);
        url.searchParams.set('u', ticker);
        if (push) window.history.replaceState(null, '', url);
        renderPremium();
    }

    async function boot() {
        try {
            const res = await fetch(DATA_PATH, { cache: 'no-store' });
            if (!res.ok) throw new Error(`${DATA_PATH} answered HTTP ${res.status}`);
            state.data = await res.json();
        } catch (err) {
            log('load failed', err.message);
            setStatus(`The tracking data did not load (${err.message}). Nothing is drawn.`, true);
            return;
        }
        const list = state.data.premium?.underlyings ?? [];
        const pick = pickUnderlying(list, window.location.search);
        if (pick.asked && !pick.found) setStatus(`No premium observation for “${pick.asked}” yet. Showing ${pick.ticker}.`, false);
        else setStatus(null, false);
        const select = $('underlyingSelect');
        select.innerHTML = optionsHtml(list, pick.ticker);
        select.addEventListener('change', () => selectUnderlying(select.value, true));
        const chart = $('premiumChart');
        chart.addEventListener('click', (e) => showPoint(e.target));
        chart.addEventListener('focusin', (e) => showPoint(e.target));
        chart.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showPoint(e.target); }
        });
        state.ticker = pick.ticker;
        renderSources();
        renderPremium();
        renderScatter();
        window.matchMedia('(max-width: 560px)').addEventListener('change', () => { renderPremium(); renderScatter(); });
        log(`rendered ${list.length} underlyings, scatter ${state.data.concentration?.counts?.plotted ?? 0} dots`);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    return api;
}));
