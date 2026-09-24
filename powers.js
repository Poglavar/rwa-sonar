/**
 * Renders powers.html — "Who can touch your tokens": the issuer programmes down the page, the
 * powers that can reach a holder's balance across it, and in every cell who holds that power as
 * stocks/build-power-map.mjs shaped it (stocks-power-map.json). Tapping a cell opens its detail:
 * the exact addresses with explorer links and their on/off-curve reading, the reviewed controller,
 * threshold, timelock and upgrade path, the source and observation date, and whether use is on
 * record.
 *
 * Everything above the DOM section is pure — no DOM, no fetch, no clock — and exported for jest
 * (powers-page.test.js). Wrapped in a UMD factory so it declares no globals.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.__powers = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const fmt = (typeof __rwaFmt !== 'undefined') ? __rwaFmt : require('./stocks/lib/fmt.js');
    const { escapeHtml } = fmt;

    // -----------------------------------------------------------------------
    // Pure section
    // -----------------------------------------------------------------------

    const DATA_PATH = './stocks-power-map.json';

    /** What each holder kind is called in a cell, and what it claims in the legend. */
    const KIND_LABEL = {
        'single-key': 'One key',
        multisig: 'Multisig',
        program: 'Program',
        none: 'Not installed',
        unknown: 'Unknown'
    };
    const KIND_MEANING = {
        'single-key': 'one private key (or a 1-of-n multisig, or a program whose upgrade key is one signer) can use this power alone',
        multisig: 'a threshold of several signers must approve; the threshold and any timelock are in the detail',
        program: 'a program or its PDA signs; whoever can upgrade that program controls it, shown underneath',
        none: 'the power is not installed on any of the programme’s mints read from the chain',
        unknown: 'the research has not established who holds it, so it is shown as unknown'
    };
    const KINDS = ['single-key', 'multisig', 'program', 'none', 'unknown'];

    /** "2 of 5 eligible voters (7 members…)" -> "2-of-5"; null when no m-of-n is stated. */
    function thresholdShort(text) {
        const match = typeof text === 'string' ? /(\d+)\s*of\s*(\d+)/.exec(text) : null;
        return match ? `${match[1]}-of-${match[2]}` : null;
    }

    /** 0 -> "no timelock", 900 -> "15 min timelock", 7200 -> "2 h timelock". */
    function timelockShort(timelock) {
        const seconds = timelock?.seconds;
        if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
        if (seconds === 0) return 'no timelock';
        if (seconds % 3600 === 0) return `${seconds / 3600} h timelock`;
        if (seconds % 60 === 0) return `${seconds / 60} min timelock`;
        return `${seconds} s timelock`;
    }

    function powerById(map, id) {
        return (Array.isArray(map?.powers) ? map.powers : []).find((power) => power.id === id) ?? null;
    }

    /**
     * The words a cell prints: its kind, then the qualifiers that change what the kind means —
     * threshold and timelock for a multisig, the upgrade path for a program, "on k of n mints" when
     * only some mints carry the power, and where an inherited reading came from.
     */
    function cellWords(cell, map) {
        let head = KIND_LABEL[cell.kind] ?? KIND_LABEL.unknown;
        if (cell.kind === 'multisig' && thresholdShort(cell.signerThreshold)) head = `${thresholdShort(cell.signerThreshold)} multisig`;
        const details = [];
        if (cell.kind === 'multisig' || cell.kind === 'single-key') {
            const lock = timelockShort(cell.timelock);
            if (lock) details.push(lock);
        }
        if (cell.viaProgramUpgrade) details.push('via the program’s upgrade key');
        if (cell.kind === 'program') {
            details.push(cell.upgradeGovernance === 'multisig' ? 'upgrade: multisig'
                : cell.upgradeGovernance ? `upgrade: ${cell.upgradeGovernance}` : 'upgrade control unknown');
        }
        if (cell.capability?.state === 'some') details.push(`on ${cell.capability.present} of ${cell.capability.total} mints`);
        if (cell.capability?.state === 'unobserved' && cell.kind !== 'unknown') details.push('no mint read');
        if (cell.inheritedFrom) details.push(`same address as ${powerById(map, cell.inheritedFrom)?.short ?? cell.inheritedFrom}`);
        return { head, details };
    }

    /** A cell's use badge: only when use is on record or its effect is on chain. */
    function usageBadge(usage) {
        if (usage?.state === 'recorded') return { cls: 'pm-used-recorded', text: 'used' };
        if (usage?.state === 'effect-observed') return { cls: 'pm-used-effect', text: 'in effect' };
        return null;
    }

    function dossierHref(slug) {
        return `./issuers/${encodeURIComponent(slug)}.html`;
    }

    function whatifHref(slug) {
        return `./whatif.html?issuer=${encodeURIComponent(slug)}`;
    }

    function explorerHref(address) {
        return `https://solscan.io/account/${encodeURIComponent(address)}`;
    }

    /** "2026-09-20" from an ISO time; the raw string when it is not one; null for nothing. */
    function day(iso) {
        if (typeof iso !== 'string' || iso === '') return null;
        return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso;
    }

    function cellTitle(row, cell, map) {
        const words = cellWords(cell, map);
        const power = powerById(map, cell.power);
        return `${row.name} — ${power?.label ?? cell.power}: ${[words.head, ...words.details].join(', ')}`;
    }

    function cellHtml(row, cell, map) {
        const words = cellWords(cell, map);
        const badge = usageBadge(cell.usage);
        const power = powerById(map, cell.power);
        return `<button type="button" class="pm-cell pm-k-${escapeHtml(cell.kind)}" `
            + `data-issuer="${escapeHtml(row.slug)}" data-power="${escapeHtml(cell.power)}" `
            + `aria-label="${escapeHtml(cellTitle(row, cell, map))}" aria-haspopup="dialog">`
            + `<span class="pm-cell-p">${escapeHtml(power?.short ?? cell.power)}</span>`
            + `<span class="pm-cell-k">${escapeHtml(words.head)}</span>`
            + (words.details.length ? `<span class="pm-cell-d">${escapeHtml(words.details.join(' · '))}</span>` : '')
            + (badge ? `<span class="pm-used ${badge.cls}">${escapeHtml(badge.text)}</span>` : '')
            + '</button>';
    }

    function rowHtml(row, map) {
        const read = row.chainReadAt ? `<span class="pm-nowrap">mints read ${escapeHtml(day(row.chainReadAt.to))}</span>` : 'no mint readable on chain';
        const status = row.status && row.status !== 'live' ? `<span class="pm-status">${escapeHtml(row.status)}</span>` : '';
        return `<section class="pm-row" aria-label="${escapeHtml(row.name)}">`
            + `<div class="pm-issuer"><h3>${escapeHtml(row.name)}${status}</h3>`
            + `<p class="pm-meta">${escapeHtml(String(row.mints))} mint${row.mints === 1 ? '' : 's'} · ${read}</p>`
            + `<p class="pm-links"><a href="${escapeHtml(dossierHref(row.slug))}">Dossier</a>`
            + `<a href="${escapeHtml(whatifHref(row.slug))}">What if…</a></p></div>`
            + `<div class="pm-cells">${row.cells.map((cell) => cellHtml(row, cell, map)).join('')}</div>`
            + '</section>';
    }

    function headHtml(map) {
        return '<div class="pm-head" aria-hidden="true"><div>Programme</div>'
            + (map.powers ?? []).map((power) => `<div title="${escapeHtml(power.label)}">${escapeHtml(power.short)}</div>`).join('')
            + '</div>';
    }

    function gridHtml(map) {
        const rows = Array.isArray(map?.issuers) ? map.issuers : [];
        if (rows.length === 0) return '<p class="pm-empty">The power map holds no programmes.</p>';
        return headHtml(map) + rows.map((row) => rowHtml(row, map)).join('');
    }

    function legendHtml() {
        return KINDS.map((kind) => `<li><span class="pm-swatch pm-k-${kind}" aria-hidden="true"></span>`
            + `<strong>${escapeHtml(KIND_LABEL[kind])}</strong> — ${escapeHtml(KIND_MEANING[kind])}</li>`).join('')
            + '<li><span class="pm-used pm-used-recorded">used</span> a dossier finding records the power being exercised</li>'
            + '<li><span class="pm-used pm-used-effect">in effect</span> the chain read shows its effect now (a multiplier ≠ 1, a fee, a pause, minted supply)</li>';
    }

    /** "18 powers sit with one key · 15 behind a multisig · …" over every cell. */
    function summaryText(map) {
        const counts = map?.counts ?? {};
        const n = (kind) => (Number.isFinite(counts[kind]) ? counts[kind] : 0);
        const cells = KINDS.reduce((sum, kind) => sum + n(kind), 0);
        return `${cells} cells (${(map?.issuers ?? []).length} programmes × ${(map?.powers ?? []).length} powers): `
            + `${n('single-key')} one key · ${n('multisig')} multisig · ${n('program')} program · `
            + `${n('none')} not installed · ${n('unknown')} unknown`;
    }

    /** Where each input came from and when it was observed, for the data line. */
    function sourcesText(map) {
        const s = map?.sources ?? {};
        const parts = [];
        parts.push(`chain: ${s.chain?.method ?? 'mint read'} of ${s.chain?.mintsRead ?? '—'} mints, fetched ${day(s.chain?.fetchedAt) ?? 'unknown'}`);
        parts.push(`governance: issuer dossiers as built ${day(s.issuers?.builtAt) ?? 'unknown'}`);
        parts.push(`map built ${day(map?.builtAt) ?? 'unknown'}`);
        return parts.join(' · ');
    }

    function fact(label, value) {
        if (value === null || value === undefined || value === '') return '';
        return `<div class="pm-fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`;
    }

    function curveText(onCurve) {
        if (onCurve === true) return 'on the ed25519 curve: a private key can exist for it';
        if (onCurve === false) return 'off the curve: a program-derived address with no private key';
        return 'curve not determined';
    }

    function addressesHtml(cell) {
        const shown = Array.isArray(cell.addresses?.shown) ? cell.addresses.shown : [];
        if (shown.length === 0) {
            return '<p class="pm-sub">No authority address for this power was read from the chain'
                + (cell.power === 'upgrade' ? ' (programme upgrade authorities are not part of the mint read).' : '.') + '</p>';
        }
        const items = shown.map((row) => `<li><a class="pm-addr" href="${escapeHtml(explorerHref(row.address))}" target="_blank" rel="noopener noreferrer">`
            + `${escapeHtml(row.address)}</a><span class="pm-sub">${escapeHtml(row.role)} on ${escapeHtml(String(row.mints))} mint${row.mints === 1 ? '' : 's'} · ${escapeHtml(curveText(row.onCurve))}</span></li>`).join('');
        const more = cell.addresses.distinct > shown.length
            ? `<p class="pm-sub">${cell.addresses.distinct - shown.length} more distinct address${cell.addresses.distinct - shown.length === 1 ? '' : 'es'} not listed (${cell.addresses.distinct} in all).</p>` : '';
        return `<ul class="pm-addrs">${items}</ul>${more}`;
    }

    function capabilityText(capability) {
        if (!capability) return null;
        if (capability.state === 'unobserved') return 'no mint of this programme could be read on chain';
        if (capability.state === 'unknown') return `not established on ${capability.unknown} of ${capability.total} mints`;
        return `installed on ${capability.present} of ${capability.total} mints`;
    }

    /** The full detail for one cell, flat, for the dialog. */
    function detailHtml(row, cell, map) {
        const power = powerById(map, cell.power);
        const words = cellWords(cell, map);
        const parts = [];
        parts.push(`<p class="pm-detail-who"><span class="pm-swatch pm-k-${escapeHtml(cell.kind)}" aria-hidden="true"></span>`
            + `<strong>${escapeHtml([words.head, ...words.details].join(' · '))}</strong></p>`);
        parts.push(`<p class="pm-sub">${escapeHtml(KIND_MEANING[cell.kind] ?? KIND_MEANING.unknown)}.</p>`);
        if (cell.inheritedFrom) {
            const from = row.cells.find((other) => other.power === cell.inheritedFrom);
            parts.push(`<p class="pm-sub">The research does not characterise this authority directly. On every mint that carries it, its address is the same address that holds <strong>${escapeHtml(powerById(map, cell.inheritedFrom)?.label ?? cell.inheritedFrom)}</strong>, so it has the same holder`
                + `${from?.controller ? ` (${escapeHtml(from.controller)})` : ''}.</p>`);
        } else if (cell.kind === 'unknown' && Array.isArray(cell.sameAddressAs) && cell.sameAddressAs.length > 0) {
            parts.push(`<p class="pm-sub">Its address is shared with ${escapeHtml(cell.sameAddressAs.map((id) => powerById(map, id)?.short ?? id).join(', '))}, whose holders are characterised differently, so no holder is inherited.</p>`);
        }
        parts.push('<dl class="pm-facts">'
            + fact('Capability', capabilityText(cell.capability))
            + fact('Controller', cell.controller)
            + fact('Signer threshold', cell.signerThreshold)
            + fact('Timelock', cell.timelock ? `${timelockShort(cell.timelock)} (“${cell.timelock.phrase}”)` : null)
            + fact('Upgrade authority', cell.upgradeAuthority)
            + fact('Upgrade governance', cell.upgradeGovernance ?? (cell.kind === 'program' ? 'not established' : null))
            + fact('Model governance label', cell.governanceType)
            + fact('Last rotated', cell.lastRotatedAt)
            + fact('Observed', cell.observedAt)
            + fact('Source', cell.source)
            + '</dl>');
        if (cell.technicalNotes) parts.push(`<p class="pm-note">${escapeHtml(cell.technicalNotes)}</p>`);
        if (cell.contractualCircumstances) parts.push(`<p class="pm-note">${escapeHtml(cell.contractualCircumstances)}</p>`);
        parts.push('<h3 class="pm-h">Addresses on chain</h3>');
        parts.push(addressesHtml(cell));
        if (row.chainReadAt) parts.push(`<p class="pm-sub">Mint accounts read ${escapeHtml(day(row.chainReadAt.from))}${row.chainReadAt.to.slice(0, 10) !== row.chainReadAt.from.slice(0, 10) ? `–${escapeHtml(day(row.chainReadAt.to))}` : ''} (${escapeHtml(map?.sources?.chain?.method ?? 'mint read')}).</p>`);
        parts.push('<h3 class="pm-h">Has it been used?</h3>');
        const usage = cell.usage ?? {};
        if (usage.finding) {
            parts.push(`<p>${escapeHtml(usage.finding.statement ?? 'A dossier finding records its use.')}</p>`
                + `<p class="pm-sub">Finding <code>${escapeHtml(usage.finding.schema)}</code>${usage.finding.observedAt ? `, observed ${escapeHtml(usage.finding.observedAt)}` : ''}${usage.finding.evidence ? ` · evidence: ${escapeHtml(usage.finding.evidence)}` : ''}</p>`);
        }
        for (const effect of Array.isArray(usage.effects) ? usage.effects : []) parts.push(`<p>On chain: ${escapeHtml(effect)}.</p>`);
        if (usage.check) {
            // A reviewed search of the authority's history (authorityFacts.<power>.useCheck): what it
            // found over a stated window, never a promise about later use.
            parts.push(`<p>${escapeHtml(usage.check.statement)}</p>`
                + `<p class="pm-sub">Searched through ${escapeHtml(usage.check.through)}${usage.check.source ? ` · source: ${escapeHtml(usage.check.source)}` : ''}</p>`
                + '<p class="pm-sub">A search of a stated window. It does not limit future use.</p>');
        } else if (!usage.finding && !(usage.effects ?? []).length) {
            parts.push('<p class="pm-sub">No use is on record in our data. The power may still have been used.</p>');
        }
        if (row.governanceEvidence) {
            parts.push('<details class="pm-evidence"><summary>The dossier’s key-governance evidence (verbatim)</summary>'
                + `<p>${escapeHtml(row.governanceEvidence)}</p></details>`);
        }
        parts.push(`<p class="pm-links"><a href="${escapeHtml(dossierHref(row.slug))}">${escapeHtml(row.name)} dossier →</a>`
            + `<a href="${escapeHtml(whatifHref(row.slug))}">Its failure scenarios →</a></p>`);
        return { title: `${row.name}: ${power?.label ?? cell.power}`, html: parts.join('') };
    }

    function findCell(map, slug, powerId) {
        const row = (map?.issuers ?? []).find((candidate) => candidate.slug === slug) ?? null;
        const cell = row?.cells.find((candidate) => candidate.power === powerId) ?? null;
        return row && cell ? { row, cell } : null;
    }

    const api = {
        DATA_PATH, KIND_LABEL, KIND_MEANING, KINDS,
        thresholdShort, timelockShort, cellWords, usageBadge, dossierHref, whatifHref, explorerHref,
        cellHtml, rowHtml, gridHtml, legendHtml, summaryText, sourcesText, detailHtml, findCell
    };

    // -----------------------------------------------------------------------
    // Page
    // -----------------------------------------------------------------------

    if (typeof document === 'undefined') return api;

    const els = {};
    let map = null;
    let opener = null;

    function logError(what, detail) {
        console.error(`[${new Date().toISOString()}] ${what}${detail ? `: ${detail}` : ''}`);
    }

    function setStatus(message, isError) {
        els.status.textContent = message ?? '';
        els.status.hidden = !message;
        els.status.classList.toggle('status-error', Boolean(isError));
    }

    function openDetail(slug, powerId, button) {
        const found = findCell(map, slug, powerId);
        if (!found) return;
        const detail = detailHtml(found.row, found.cell, map);
        els.title.textContent = detail.title;
        els.body.innerHTML = detail.html;
        els.body.scrollTop = 0;
        opener = button;
        if (typeof els.dialog.showModal === 'function') els.dialog.showModal();
        else els.dialog.setAttribute('open', '');
    }

    function closeDetail() {
        if (typeof els.dialog.close === 'function') els.dialog.close();
        else els.dialog.removeAttribute('open');
    }

    async function boot() {
        els.status = document.getElementById('status');
        els.summary = document.getElementById('summary');
        els.sources = document.getElementById('sources');
        els.legend = document.getElementById('legend');
        els.grid = document.getElementById('grid');
        els.dialog = document.getElementById('detailPanel');
        els.title = document.getElementById('detailTitle');
        els.body = document.getElementById('detailBody');
        els.legend.innerHTML = legendHtml();
        document.getElementById('detailClose').addEventListener('click', closeDetail);
        els.dialog.addEventListener('click', (event) => { if (event.target === els.dialog) closeDetail(); });
        els.dialog.addEventListener('close', () => { if (opener) opener.focus(); });
        els.grid.addEventListener('click', (event) => {
            const button = event.target.closest('button.pm-cell');
            if (button) openDetail(button.getAttribute('data-issuer'), button.getAttribute('data-power'), button);
        });
        setStatus('Loading the power map…', false);
        try {
            const res = await fetch(DATA_PATH, { headers: { accept: 'application/json' } });
            if (!res.ok) throw new Error(`${DATA_PATH} answered HTTP ${res.status}`);
            map = await res.json();
        } catch (err) {
            logError('power map did not load', err.message);
            setStatus(`${err.message}. We show nothing instead of a partial map.`, true);
            return;
        }
        els.summary.textContent = summaryText(map);
        els.sources.textContent = sourcesText(map);
        els.grid.style.setProperty('--pm-cols', String((map.powers ?? []).length));
        els.grid.innerHTML = gridHtml(map);
        setStatus(null, false);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    return api;
}));
