/* Thin DOM controller and testable HTML views for programme economics; no live-price calls. */
(function (root, factory) {
    const model = typeof module === 'object' && module.exports ? require('./stocks/lib/economics.js') : root.__rwaEconomics;
    const api = factory(model);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else { root.__rwaEconomicsPage = api; api.start(document, window); }
})(this, function (model) {
    const STAGES = [['enter', 'Enter'], ['hold', 'Hold'], ['transfer', 'Move'], ['defi', 'DeFi use'], ['exit', 'Exit'], ['tax', 'Tax drag'], ['stress', 'Wind-down']];
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const readable = value => value === null || value === undefined || value === '' ? 'Not established' : String(value);
    function safeSourceUrl(value) {
        if (typeof value !== 'string') return null;
        try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
    }
    function sourceList(profile, ids) {
        const sources = (profile.sources || []).filter(source => ids.includes(source.id));
        if (!sources.length) return '<p class="source-note">No supporting source is recorded for this item.</p>';
        return '<ul class="sources">' + sources.map(source => {
            const url = safeSourceUrl(source.url);
            const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(source.label)} ↗</a>` : esc(source.label);
            const dates = [source.publishedAt && `Published: ${source.publishedAt}`, source.updatedAt && `Page updated: ${source.updatedAt}`, source.observedAt && `Observed: ${source.observedAt}`, source.checkedAt && `Source checked: ${source.checkedAt}`].filter(Boolean);
            return `<li>${title}<span>${esc(source.locator || '')}</span><small>${esc(dates.join(' · ') || 'Evidence date not recorded')}</small>${source.note ? `<small>${esc(source.note)}</small>` : ''}</li>`;
        }).join('') + '</ul>';
    }
    function feeScope(fee) {
        const scope = fee.scope || {};
        return [scope.level === 'product' ? (scope.products || []).join(', ') + ' only' : scope.level === 'route' ? 'Route-specific' : 'Programme context', scope.route, scope.chain, scope.holder].filter(Boolean).join(' · ');
    }
    function evidenceDates(profile, ids) {
        return [...new Set((profile.sources || []).filter(source => ids.includes(source.id)).map(source => source.observedAt ? `Observed ${source.observedAt}` : source.checkedAt ? `Source checked ${source.checkedAt}` : 'Date not recorded'))].join(' · ');
    }
    function feeRow(profile, fee) {
        const kind = fee.kind === 'cap' ? (fee.scope?.level === 'product' ? 'Product-page ceiling' : 'Contractual cap') : fee.kind === 'tax' ? 'Tax, not issuer revenue' : fee.kind === 'spread' ? 'Variable spread' : fee.status === 'observed' ? 'Observed configuration' : fee.status === 'unknown' ? 'Not established' : fee.kind === 'unknown' ? 'Documented category · amount unknown' : 'Issuer-stated charge';
        const amount = fee.amountText ?? (fee.kind === 'spread' ? 'Variable · amount not recorded' : 'Amount not established');
        const scopeWarning = fee.applicability === 'not-applicable' ? '<p class="scope-warning">Other product or route: do not apply this figure to the selected context.</p>' : '';
        return `<details class="fee-row"><summary><span><strong>${esc(fee.label)}</strong><small>${esc(feeScope(fee))}</small><small>${esc(evidenceDates(profile, fee.sourceIds || []))}</small></span><span class="fee-amount">${esc(amount)}<small class="kind kind-${esc(fee.kind)}">${esc(kind)}</small></span></summary><div class="fee-detail">${scopeWarning}${fee.note ? `<p>${esc(fee.note)}</p>` : ''}<dl><div><dt>Who bears it</dt><dd>${esc(readable(fee.payer))}</dd></div><div><dt>Who receives it</dt><dd>${esc(readable(fee.payee))}</dd></div></dl>${sourceList(profile, fee.sourceIds || [])}</div></details>`;
    }
    function actorRow(profile, actor) {
        return `<details class="actor-row"><summary><span><small>${esc(actor.role)}</small><strong>${esc(actor.name)}</strong></span><span class="actor-payment">${esc(actor.payment ?? 'Payment not established')}</span></summary><div class="actor-detail">${actor.basis ? `<p><strong>Recorded basis:</strong> ${esc(actor.basis)}</p>` : ''}<p class="analysis-label">Incentive analysis · not a claim of intent</p><p>${esc(actor.alignment || 'Analysis not yet performed.')}</p>${actor.tradeoff ? `<p>${esc(actor.tradeoff)}</p>` : ''}${sourceList(profile, actor.sourceIds || [])}</div></details>`;
    }
    function renderProfile(profile, { productSymbol = null, compact = false } = {}) {
        const fees = model.selectFees(profile, { productSymbol, chain: 'Solana', collapseProductExamples: true });
        const gap = fees.find(fee => fee.applicability === 'no-exact-fee-confirmed');
        const sections = STAGES.map(([stage, label]) => {
            const rows = fees.filter(fee => fee.stage === stage);
            return rows.length ? `<section class="cost-stage"><h4>${label}</h4>${rows.map(fee => feeRow(profile, fee)).join('')}</section>` : '';
        }).join('');
        const unmapped = STAGES.filter(([stage]) => !fees.some(fee => fee.stage === stage)).map(([, label]) => label);
        const missingLayers = unmapped.length ? `<p class="section-note cost-coverage">Not yet mapped here: ${esc(unmapped.join(', '))}. Unmapped does not mean free.</p>` : '';
        const programmeLink = `./issuers/${encodeURIComponent(profile.id)}.html`;
        const content = `<section class="costs"><h3>What the holder pays</h3>${missingLayers}${gap ? `<p class="scope-warning"><strong>${esc(gap.label)}.</strong> ${esc(gap.note)}</p>` : ''}${sections || '<p class="unknown-block">No cost schedule has been reviewed here. This does not mean the product is free.</p>'}<p class="total-note">No all-in total: route, eligibility, current quotes and unreviewed costs can change the result.</p></section><section class="actors"><h3>Who gets paid and why it matters</h3><p class="section-note">The actors and payments we have identified. Others may exist.</p>${(profile.actors || []).map(actor => actorRow(profile, actor)).join('')}</section><details class="gaps"><summary>What remains unknown <span>${(profile.gaps || []).length}</span></summary><ul>${(profile.gaps || []).map(gap => `<li>${esc(gap)}</li>`).join('')}</ul><p>Research gaps are not accusations of missing disclosure.</p></details>`;
        return `<article class="economics-profile" id="profile-${esc(profile.id)}"><header><span class="coverage ${profile.coverage === 'not-reviewed' ? 'pending' : ''}">${profile.coverage === 'not-reviewed' ? 'Economics review pending' : 'Partial coverage · initial review'}</span><h2>${esc(profile.name)}</h2><p>${esc(profile.summary)}</p><a href="${esc(programmeLink)}">Issuer &amp; legal dossier →</a></header>${compact ? `<details class="profile-drilldown"><summary>Open costs, actors and sources</summary>${content}</details>` : content}</article>`;
    }
    function selectedProfiles(data, ids) {
        return [...new Set(ids)].map(id => model.selectProfile(data, id)).filter(Boolean);
    }
    function renderSelection(data, ids, options = {}) {
        const profiles = selectedProfiles(data, ids);
        if (!profiles.length) return '<p class="empty-selection">Choose one or more programmes above to inspect their economics.</p>';
        return profiles.map(profile => renderProfile(profile, { productSymbol: profiles.length === 1 ? options.productSymbol : null, compact: profiles.length > 1 })).join('');
    }
    async function start(doc, win) {
        const result = doc.getElementById('economicsResults');
        if (!result) return;
        const select = doc.getElementById('programmeSelect');
        const choices = doc.getElementById('programmeChoices');
        const coverage = doc.getElementById('coverageLine');
        const productContext = doc.getElementById('productContext');
        const count = doc.getElementById('selectionCount');
        try {
            const response = await win.fetch('./stocks/data/economics.json?v=20260922a', { cache: 'no-cache' });
            if (!response.ok) throw new Error(`Research request returned ${response.status}`);
            const data = await response.json();
            if (data.schemaVersion !== 1 || !Array.isArray(data.profiles) || !data.profiles.length) throw new Error('Economics research format is unavailable');
            const query = new URLSearchParams(win.location.search);
            const requested = query.has('issuers') ? query.get('issuers').split(',') : query.has('issuer') ? [query.get('issuer')] : [data.profiles[0].id];
            let ids = selectedProfiles(data, requested).map(profile => profile.id);
            let product = ids.length === 1 ? (query.get('product') || null) : null;
            const initialCount = data.profiles.filter(profile => profile.coverage === 'initial-review').length;
            coverage.textContent = `${initialCount} of ${data.profiles.length} programmes have initial fee research. The rest are marked as gaps.`;
            select.innerHTML = '<option value="">Custom selection</option>' + data.profiles.map(profile => `<option value="${esc(profile.id)}">${esc(profile.name)}${profile.coverage === 'not-reviewed' ? ' · review pending' : ''}</option>`).join('');
            select.disabled = false;
            choices.innerHTML = '<legend class="sr-only">Programmes in this comparison</legend>' + data.profiles.map(profile => `<label><input type="checkbox" value="${esc(profile.id)}">${esc(profile.name)}</label>`).join('');
            function render(updateUrl = true) {
                result.innerHTML = renderSelection(data, ids, { productSymbol: product });
                result.classList.toggle('comparison-mode', ids.length > 1);
                select.value = ids.length === 1 ? ids[0] : '';
                choices.querySelectorAll('input').forEach(input => { input.checked = ids.includes(input.value); });
                count.textContent = `· ${ids.length} selected`;
                productContext.hidden = !product;
                productContext.textContent = product ? `${product} · Solana. Other products’ fees are not inherited; route and holder eligibility still need checking.` : '';
                if (updateUrl) {
                    const url = new URL(win.location.href);
                    url.searchParams.delete('issuer');
                    url.searchParams.set('issuers', ids.join(','));
                    if (product) url.searchParams.set('product', product); else url.searchParams.delete('product');
                    win.history.replaceState(null, '', url);
                }
            }
            select.addEventListener('change', () => { ids = select.value ? [select.value] : []; product = null; render(); });
            choices.addEventListener('change', () => { ids = Array.from(choices.querySelectorAll('input:checked'), input => input.value); product = null; render(); });
            doc.getElementById('selectAll').addEventListener('click', () => { ids = data.profiles.map(profile => profile.id); product = null; render(); });
            doc.getElementById('clearSelection').addEventListener('click', () => { ids = []; product = null; render(); });
            render(false);
        } catch (error) {
            coverage.textContent = 'Economics research unavailable';
            result.innerHTML = '<p class="error-state">The fee research could not be loaded. <a href="./economics.html">Try again</a> or read the <a href="./issuers/">issuer dossiers</a>.</p>';
            console.error(`[${new Date().toISOString()}] Economics research load failed`, error);
        }
    }
    return { renderProfile, renderSelection, selectedProfiles, safeSourceUrl, start };
});
