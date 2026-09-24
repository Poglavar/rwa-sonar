/**
 * Renders flows.html from ./stocks-flows.json (stocks/build-flows.mjs): daily creation/redemption
 * flows per issuer on Solana, drawn as up/down bars with a coverage strip, and the xStocks public
 * float (supply minus issuer inventory). Everything above the DOM section is pure — strings in,
 * strings out, no fetch, no clock — and is exported for jest (flows-page.test.js). Wrapped in a UMD
 * factory so it declares no globals; charts are inline SVG like stocks/lib/history-charts.js.
 *
 * A day the observer did not read is drawn as MISSING (hatched), never as a zero bar; a partly read
 * day shows its covered hours; a dollar total with unpriced units is marked as a lower bound.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__rwaFlows = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const fmt = (typeof __rwaFmt !== 'undefined') ? __rwaFmt : require('./stocks/lib/fmt.js');
    const { escapeHtml: esc, fmtMoney, fmtNumber, fmtPct, fmtDateTime } = fmt;
    const DASH = '—';
    const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

    /** Coverage state of one side of one day: missing (not read), partial, full. */
    function coverageState(side) {
        if (!side || !isNum(side.coveredHours) || side.coveredHours <= 0) return 'missing';
        return side.coveredHours >= 24 ? 'full' : 'partial';
    }

    /** "$1.2M", "≥ $1.2M" for a lower bound, "count only", "not read". */
    function sideLabel(side) {
        if (!side) return 'not collected';
        if (coverageState(side) === 'missing') return 'not read';
        if (!side.value) return `${fmtNumber(side.count)} tx · amounts not recorded`;
        const usd = `${side.value.complete ? '' : '≥ '}${fmtMoney(side.value.usd)}`;
        return `${usd} · ${fmtNumber(side.count)} tx`;
    }

    function shortDate(day) { return String(day).slice(5); }

    /** Text for one day's readout (tooltip, focus readout and aria-label share it). */
    function dayReadout(issuer, day) {
        const parts = [`${issuer.name} · ${day.date}`];
        const cov = (side) => (coverageState(side) === 'missing' ? 'not read' : `${side.coveredHours} h of 24 read`);
        if (day.created) parts.push(`created ${sideLabel(day.created)} (${cov(day.created)})`);
        else parts.push('created: not collected');
        if (day.redeemed) parts.push(`redeemed ${sideLabel(day.redeemed)} (${cov(day.redeemed)})`);
        if (isNum(day.netUsd)) parts.push(`net ${day.netUsd >= 0 ? '+' : '−'}${fmtMoney(Math.abs(day.netUsd))}`);
        const top = day.redeemed?.value?.top?.[0];
        if (top) parts.push(`largest redeemed: ${top.symbol ?? 'unknown'} ${fmtNumber(top.units, 2)} units`);
        return parts.join(' · ');
    }

    /** Symmetric scale: the largest created or redeemed USD in the window (null when nothing priced). */
    function flowScale(issuers) {
        let max = 0;
        for (const issuer of issuers) for (const day of issuer.days ?? []) {
            for (const side of [day.created, day.redeemed]) if (isNum(side?.value?.usd)) max = Math.max(max, side.value.usd);
        }
        return max > 0 ? max : null;
    }

    /**
     * One issuer's chart: created above the zero line, redeemed below, one column per day, and a
     * coverage strip underneath. `scale` is the issuer's own max so small programmes stay legible;
     * the axis labels say the scale.
     */
    function flowChartSvg(issuer, { width = 720 } = {}) {
        const days = issuer.days ?? [];
        // Drawn at the container's own width so 12px text stays 12px on a phone.
        const W = Math.max(300, Math.min(1100, Math.round(width))), H = W < 520 ? 200 : 236, L = 50, R = 8, T = 14, STRIP = 16, B = 40;
        const plotH = H - T - B - STRIP - 8;
        const mid = T + plotH / 2;
        const slot = (W - L - R) / Math.max(days.length, 1);
        const bw = Math.max(4, Math.min(28, slot * 0.62));
        const max = flowScale([issuer]);
        const h = (usd) => (max && isNum(usd) ? Math.max(1.5, (usd / max) * (plotH / 2 - 4)) : 0);
        const x = (i) => L + i * slot + (slot - bw) / 2;
        const stripY = T + plotH + 8;
        const cols = days.map((day, i) => {
            const c = day.created; const r = day.redeemed;
            const bars = [];
            if (c?.value && isNum(c.value.usd) && c.value.usd > 0) {
                bars.push(`<rect class="fl-bar fl-created${c.value.complete ? '' : ' fl-lower'}" x="${x(i).toFixed(1)}" y="${(mid - h(c.value.usd)).toFixed(1)}" width="${bw.toFixed(1)}" height="${h(c.value.usd).toFixed(1)}" rx="3"/>`);
            }
            if (r?.value && isNum(r.value.usd) && r.value.usd > 0) {
                bars.push(`<rect class="fl-bar fl-redeemed${r.value.complete ? '' : ' fl-lower'}" x="${x(i).toFixed(1)}" y="${mid.toFixed(1)}" width="${bw.toFixed(1)}" height="${h(r.value.usd).toFixed(1)}" rx="3"/>`);
            }
            if (isNum(day.netUsd)) {
                const ny = mid - (day.netUsd >= 0 ? h(day.netUsd) : -h(-day.netUsd));
                bars.push(`<line class="fl-net" x1="${(x(i) - 3).toFixed(1)}" x2="${(x(i) + bw + 3).toFixed(1)}" y1="${ny.toFixed(1)}" y2="${ny.toFixed(1)}"/>`);
            }
            // Coverage strip: the side that is collected decides it (redeemed is always collected).
            const state = coverageState(r ?? c);
            const hours = (r ?? c)?.coveredHours ?? 0;
            const strip = `<rect class="fl-cov fl-cov-${state}" x="${x(i).toFixed(1)}" y="${stripY}" width="${bw.toFixed(1)}" height="${STRIP - 4}" rx="2"/>`
                + (state === 'partial' && slot >= 30 ? `<text class="fl-cov-h" x="${(x(i) + bw / 2).toFixed(1)}" y="${stripY + STRIP + 8}" text-anchor="middle">${Math.round(hours)}h</text>` : '');
            const readout = dayReadout(issuer, day);
            // The hit target is the whole column, bigger than any bar, and keyboard focusable.
            const hit = `<rect class="fl-hit" x="${(L + i * slot).toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${(stripY + STRIP - T).toFixed(1)}" tabindex="0" role="img" aria-label="${esc(readout)}" data-readout="${esc(readout)}"><title>${esc(readout)}</title></rect>`;
            return `<g>${strip}${bars.join('')}${hit}</g>`;
        }).join('');
        const axis = max
            ? `<text x="${L - 6}" y="${T + 8}" text-anchor="end">${esc(fmtMoney(max))}</text><text x="${L - 6}" y="${mid + 4}" text-anchor="end">$0</text><text x="${L - 6}" y="${T + plotH}" text-anchor="end">${esc(fmtMoney(max))}</text>`
            : `<text x="${L - 6}" y="${mid + 4}" text-anchor="end">$0</text>`;
        const sideNames = `<text class="fl-side" x="${L + 4}" y="${T + 10}">${issuer.created?.counted ? 'created ↑' : 'creations not collected'}</text><text class="fl-side" x="${L + 4}" y="${T + plotH - 2}">redeemed ↓</text>`;
        const xl = days.length ? [0, Math.floor((days.length - 1) / 2), days.length - 1]
            .map((i, k) => `<text x="${(x(i) + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}">${esc(shortDate(days[i].date))}</text>`).join('') : '';
        const empty = max ? '' : `<text class="fl-empty" x="${(L + W - R) / 2}" y="${mid - 8}" text-anchor="middle">No priced amounts in this window</text>`;
        return `<svg class="fl-svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(issuer.name)} daily flows, ${days.length} days">`
            + `<g class="fl-axis"><line x1="${L}" x2="${W - R}" y1="${mid}" y2="${mid}"/>${axis}${xl}<text x="${L - 6}" y="${stripY + 10}" text-anchor="end">read</text></g>`
            + `${sideNames}${empty}${cols}</svg>`;
    }

    function legendHtml() {
        return '<ul class="fl-legend">'
            + '<li><i class="fl-key fl-created"></i>Created (USD)</li>'
            + '<li><i class="fl-key fl-redeemed"></i>Redeemed (USD)</li>'
            + '<li><i class="fl-key fl-lower-key"></i>Lower bound: some units unpriced</li>'
            + '<li><i class="fl-key fl-net-key"></i>Net, where both sides were read all day</li>'
            + '<li><i class="fl-key fl-cov-full"></i>Day fully read</li>'
            + '<li><i class="fl-key fl-cov-partial"></i>Partly read</li>'
            + '<li><i class="fl-key fl-cov-missing"></i>Not read (missing, not zero)</li>'
            + '</ul>';
    }

    function sourcesText(value) {
        const names = { settlement: 'stablecoin leg', 'dex-tape': 'DEX tape', 'daily-snapshot': 'day snapshot', 'same-day-catalogue': 'same-day catalogue' };
        const entries = Object.entries(value?.sources ?? {});
        return entries.length ? entries.map(([k, n]) => `${names[k] ?? k} ${n}`).join(', ') : DASH;
    }

    /** The accessible table view of one issuer's days (newest first, read days only plus missing ones marked). */
    function flowTableHtml(issuer) {
        const rows = [...(issuer.days ?? [])].reverse().map((day) => {
            const side = (s) => {
                if (!s) return '<td class="fl-na">not collected</td>';
                if (coverageState(s) === 'missing') return '<td class="fl-missing">not read</td>';
                return `<td>${esc(sideLabel(s))}${s.value && !s.value.complete ? `<br><small>unpriced: ${esc(s.value.unpricedMints.join(', ') || (s.value.unmeasured ? `${s.value.unmeasured} tx without amounts` : ''))}</small>` : ''}</td>`;
            };
            const cov = (issuer.created?.counted ? [day.created, day.redeemed] : [day.redeemed]).map((s) => (coverageState(s) === 'missing' ? '0' : String(s.coveredHours)))[0];
            return `<tr><th scope="row">${esc(day.date)}</th><td class="n">${esc(cov)} h</td>${side(day.created)}${side(day.redeemed)}`
                + `<td class="n">${isNum(day.netUsd) ? esc((day.netUsd >= 0 ? '+' : '−') + fmtMoney(Math.abs(day.netUsd))) : DASH}</td>`
                + `<td><small>${esc(sourcesText(day.redeemed?.value))}</small></td></tr>`;
        }).join('');
        return `<div class="fl-scroll"><table class="fl-table"><thead><tr><th scope="col">Day (UTC)</th><th scope="col">Read</th><th scope="col">Created</th><th scope="col">Redeemed</th><th scope="col">Net</th><th scope="col">Redeemed priced by</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    function issuerHtml(issuer, width) {
        if (issuer.state === 'no-observation-file') {
            return `<article class="fl-issuer" id="flow-${esc(issuer.slug)}"><h3>${esc(issuer.name)}</h3><p class="fl-missing">No observation for this programme in the observer file.</p></article>`;
        }
        const failed = issuer.state === 'scan-failed'
            ? `<p class="fl-alert">Last scan failed (${esc(issuer.lastScanError ?? 'unknown error')}): nothing is stated after ${esc(fmtDateTime(issuer.coveredThrough))}.</p>` : '';
        const amounts = issuer.amountsFrom === null ? 'Amounts not recorded yet (counts only).'
            : issuer.amountsFrom === 'first-coverage' ? 'Amounts recorded from the start of coverage.'
                : `Amounts recorded from ${fmtDateTime(issuer.amountsFrom)}; earlier days carry counts only.`;
        const what = (side, label) => `<li><strong>${label}:</strong> ${side.counted ? esc(side.what) : `<span class="fl-na">not collected.</span> ${esc(side.why)}`}</li>`;
        return `<article class="fl-issuer" id="flow-${esc(issuer.slug)}">`
            + `<h3>${esc(issuer.name)}</h3>`
            + `<p class="fl-meta">Last scan ${esc(fmtDateTime(issuer.lastScanAt))} (${esc(issuer.lastScanStatus ?? DASH)}) · ${esc(amounts)}</p>${failed}`
            + `<div class="fl-chart">${flowChartSvg(issuer, { width })}</div>`
            + `<ul class="fl-what">${what(issuer.created, 'Created')}${what(issuer.redeemed, 'Redeemed')}</ul>`
            + `<details class="fl-details"><summary>Daily numbers</summary>${flowTableHtml(issuer)}</details>`
            + '</article>';
    }

    function floatChartSvg(float, { count = 12, width = 720 } = {}) {
        const rows = (float?.top ?? []).slice(0, count);
        const t = float?.totals;
        const all = t && isNum(t.floatUsd) ? [{ symbol: `All ${t.pricedMints} priced`, floatUsd: t.floatUsd, inventoryUsd: t.inventoryUsd, aggregate: true }] : [];
        const list = [...all, ...rows];
        if (!list.length) return '<p class="fl-missing">No float read yet.</p>';
        const W = Math.max(300, Math.min(1100, Math.round(width))), L = W < 520 ? 80 : 118, R = 74, rowH = 26, T = 6;
        const H = T + list.length * rowH + 6;
        const bars = list.map((row, i) => {
            const total = (row.floatUsd ?? 0) + (row.inventoryUsd ?? 0);
            const y = T + i * rowH;
            const width = W - L - R;
            const fw = total > 0 ? (row.floatUsd / total) * width : 0;
            const readout = `${row.symbol}: outside issuer wallets ${fmtMoney(row.floatUsd)}, issuer inventory ${fmtMoney(row.inventoryUsd)} (${fmtPct(total > 0 ? (row.inventoryUsd / total) * 100 : null)} of supply value)`;
            return `<g${row.aggregate ? ' class="fl-agg"' : ''}><text class="fl-lab" x="${L - 8}" y="${y + 16}" text-anchor="end">${esc(row.symbol)}</text>`
                + `<rect class="fl-float" x="${L}" y="${y + 4}" width="${Math.max(0, fw - 1).toFixed(1)}" height="${rowH - 10}" rx="3"/>`
                + `<rect class="fl-inv" x="${(L + fw + 1).toFixed(1)}" y="${y + 4}" width="${Math.max(0, width - fw - 1).toFixed(1)}" height="${rowH - 10}" rx="3"/>`
                + `<text class="fl-val" x="${W - R + 6}" y="${y + 16}">${esc(fmtMoney(row.floatUsd))}</text>`
                + `<rect class="fl-hit" x="0" y="${y}" width="${W}" height="${rowH}" tabindex="0" role="img" aria-label="${esc(readout)}" data-readout="${esc(readout)}"><title>${esc(readout)}</title></rect></g>`;
        }).join('');
        return `<svg class="fl-svg fl-float-svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="Public float versus issuer inventory, share of supply value">${bars}</svg>`;
    }

    function floatTableHtml(float) {
        const rows = (float?.top ?? []).map((r) => {
            const change = isNum(r.floatChangeUi) ? `${r.floatChangeUi >= 0 ? '+' : '−'}${fmtNumber(Math.abs(r.floatChangeUi), 2)}` : DASH;
            const por = isNum(r.porCirculatingAllChains)
                ? `${fmtNumber(r.porCirculatingAllChains, 0)}${r.floatExceedsPor ? ' <span class="fl-flag" title="below our Solana figure">▼</span>' : ''}` : DASH;
            return `<tr><th scope="row">${esc(r.symbol ?? r.mint)}</th><td class="n">${esc(fmtNumber(r.supplyUi, 2))}</td><td class="n">${esc(fmtNumber(r.inventoryUi, 2))}</td>`
                + `<td class="n"><strong>${esc(fmtNumber(r.floatUi, 2))}</strong></td><td class="n">${esc(fmtPct(r.inventorySharePct))}</td><td class="n">${esc(fmtMoney(r.floatUsd))}</td>`
                + `<td class="n">${esc(change)}</td><td class="n">${por}</td></tr>`;
        }).join('');
        return `<div class="fl-scroll"><table class="fl-table"><thead><tr><th scope="col">Token</th><th scope="col">Raw supply</th><th scope="col">Issuer inventory</th><th scope="col">Outside issuer wallets</th><th scope="col">Inventory share</th><th scope="col">Float value</th><th scope="col">Float change since previous day</th><th scope="col">Issuer-reported circulating, all chains</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    function floatSectionHtml(float, width) {
        if (!float) return '<p class="fl-missing">The float has not been read yet (stocks/fetch-xstocks-float.mjs).</p>';
        const t = float.totals ?? {};
        const tiles = [
            ['Raw supply value', fmtMoney(t.supplyUsd)],
            ['In issuer wallets', `${fmtMoney(t.inventoryUsd)} · ${fmtPct(t.inventorySharePct)}`],
            ['Outside issuer wallets (float, upper bound)', fmtMoney(t.floatUsd)],
            ['Median inventory share, all mints', fmtPct(float.medianInventorySharePct)]
        ].map(([k, v]) => `<div><small>${esc(k)}</small><strong>${esc(v)}</strong></div>`).join('');
        const wallets = (float.wallets ?? []).map((w) => `<li><code title="${esc(w.address)}">${esc(w.address.slice(0, 6))}…${esc(w.address.slice(-4))}</code> <strong>${esc(w.role)}</strong> — ${esc(w.basis)} <small>${esc(fmtNumber(w.xstockAccountsWithBalance))} xStock balance(s) at the read; cited ${esc(fmtNumber(w.dossierCitations))}× in the dossier (${esc((w.dossierPaths ?? []).slice(0, 2).join(', '))})</small></li>`).join('');
        const conflicts = float.porConflicts?.length
            ? `<p class="fl-finding"><strong>The float is an upper bound.</strong> For ${esc(fmtNumber(float.porConflicts.length))} of ${esc(fmtNumber(float.porCompared))} tokens the issuer's own all-chain circulating supply (proof-of-reserves feed) is smaller than what sits outside the issuer-attributed wallets on Solana alone. Tokens in wallets our research has not attributed (issuer-side, exchange or not-yet-activated inventory) count as float here. Where the issuer-reported column exists, it is the tighter figure.</p>` : '';
        return `<div class="fl-tiles">${tiles}</div>`
            + `<p class="fl-meta">Read ${esc(fmtDateTime(float.readAt))}${float.slots ? ` (slots ${esc(String(float.slots.min))}–${esc(String(float.slots.max))})` : ''}. Dollar values use ${esc(float.priceSource)} observed ${esc(fmtDateTime(float.priceObservedAt))}: ${esc(fmtNumber(float.pricedMints))} of ${esc(fmtNumber(float.mints))} mints have a price; ${esc(fmtNumber(float.unpricedWithFloat))} unpriced mints with a public float are left out, so the totals are lower bounds. Previous-day baseline: ${esc(float.previousReadAt ? fmtDateTime(float.previousReadAt) : 'none yet (first read)')}.</p>`
            + `<h3>Largest xStocks by public float</h3><p class="fl-meta">Bar = share of each token's supply value: <span class="fl-swatch fl-float"></span> outside issuer wallets (public float, upper bound), <span class="fl-swatch fl-inv"></span> issuer inventory.</p>`
            + `${conflicts}<div class="fl-chart">${floatChartSvg(float, { width })}</div>`
            + `<details class="fl-details"><summary>Table: top ${esc(String(float.top?.length ?? 0))} by float value</summary>${floatTableHtml(float)}<p class="fl-meta">Issuer-reported circulating supply comes from ${esc(float.por?.source ?? DASH)} (all chains, read ${esc(fmtDateTime(float.por?.fetchedAt))}); our figure is Solana only, so where it is larger (▼) the difference sits in wallets we have not attributed.</p></details>`
            + `<h3>Issuer-attributed wallets</h3><p class="fl-note">${esc(float.attributionCaveat ?? '')}</p><ul class="fl-wallets">${wallets}</ul>`;
    }

    function contextHtml(data) {
        const f = data.flows;
        const cells = [
            ['Observer last run', f?.lastRun ? `${fmtDateTime(f.lastRun.endedAt)} · ${f.lastRun.status}` : 'no observation file'],
            ['Float read', data.float ? fmtDateTime(data.float.readAt) : 'not read yet'],
            ['Window', f?.window?.length ? `${f.window[0]} to ${f.window.at(-1)} (UTC days)` : DASH],
            ['Built', fmtDateTime(data.builtAt)]
        ];
        return cells.map(([k, v]) => `<span><small>${esc(k)}</small><strong>${esc(v)}</strong></span>`).join('');
    }

    function flowsSectionHtml(flows, width) {
        if (!flows) return '<p class="fl-missing">No redemption-observer file was available to this build, so no flows are shown (not zero flows).</p>';
        const notObs = (flows.notObservable ?? []).map((n) => `<li><strong>${esc(n.slug)}</strong> — ${esc(n.mechanism ?? '')}: ${esc(String(n.why ?? '').slice(0, 360))}${String(n.why ?? '').length > 360 ? '…' : ''}</li>`).join('');
        return legendHtml() + (flows.issuers ?? []).map((issuer) => issuerHtml(issuer, width)).join('')
            + (notObs ? `<h3>Not observable on-chain</h3><ul class="fl-what">${notObs}</ul>` : '');
    }

    const api = { coverageState, sideLabel, dayReadout, flowScale, flowChartSvg, flowTableHtml, issuerHtml, floatChartSvg, floatTableHtml, floatSectionHtml, flowsSectionHtml, contextHtml };
    if (typeof document === 'undefined') return api;

    // --- DOM ------------------------------------------------------------------------------------
    const $ = (id) => document.getElementById(id);
    function showReadout(target) {
        const text = target?.getAttribute?.('data-readout');
        const out = target?.closest?.('section')?.querySelector('.fl-readout');
        if (text && out) out.textContent = text;
    }
    async function main() {
        const status = $('status');
        let data;
        try {
            const res = await fetch('./stocks-flows.json?v=' + Date.now().toString(36), { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            data = await res.json();
        } catch (err) {
            status.hidden = false;
            status.classList.add('status-error');
            status.textContent = `Could not load stocks-flows.json: ${err.message}`;
            return;
        }
        $('context').innerHTML = contextHtml(data);
        let drawnWidth = null;
        const draw = () => {
            const width = $('flowsBody').clientWidth;
            if (width === drawnWidth) return;
            drawnWidth = width;
            const open = [...document.querySelectorAll('.fl-details')].map((d) => d.open);
            $('flowsBody').innerHTML = flowsSectionHtml(data.flows, width);
            $('floatBody').innerHTML = floatSectionHtml(data.float, width);
            document.querySelectorAll('.fl-details').forEach((d, i) => { if (open[i]) d.open = true; });
        };
        draw();
        window.addEventListener('resize', draw);
        $('caveatList').innerHTML = (data.caveats ?? []).map((c) => `<li>${esc(c)}</li>`).join('');
        for (const type of ['focusin', 'mouseover']) document.addEventListener(type, (event) => {
            if (event.target?.classList?.contains('fl-hit')) showReadout(event.target);
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
    else main();
    return api;
}));
