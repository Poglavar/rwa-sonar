// Assets page logic: pillar keys, catalogue rendering, tabs and tooltips. Moved out of assets.html
// (2026-09-23) so the site can run under a Content-Security-Policy without 'unsafe-inline' scripts.
const PILLAR_KEYS = [
    'blockchainIsMainLedger',
    'unconditionalTransfers',
    'bearerRedemption',
    'forcedTransfers'
];

const PILLAR_LABELS = {
    blockchainIsMainLedger: 'Blockchain is Main Ledger',
    unconditionalTransfers: 'Unconditional Transfers',
    bearerRedemption: 'Bearer Redemption',
    forcedTransfers: 'Forced Transfers'
};

const GENERAL_FIELDS = new Set([
    'name', 'ticker', 'type', 'description', 'website',
    'blockchain', 'blockchain_logo', 'asset_image', 'asset_image_background',
    'contractAddress', 'tokenStandard', 'recipe',
    '_links', '_maturityStage', '_maturityScore'
]);

const TABLE_COLUMNS = [
    { key: 'blockchain', label: '' },
    { key: 'asset_image', label: '' },
    { key: 'name', label: 'Name' },
    { key: '_maturityStage', label: 'Maturity Stage', computed: true },
    { key: 'type', label: 'Type' },
    { key: '_links', label: 'Links', computed: true },
    { key: '_maturityScore', label: 'Maturity Score', computed: true },
    { key: 'blockchainIsMainLedger', label: 'Blockchain is Main Ledger' },
    { key: 'unconditionalTransfers', label: 'Unconditional Transfers' },
    { key: 'bearerRedemption', label: 'Bearer Redemption' },
    { key: 'forcedTransfers', label: 'Forced Transfers' }
];

let currentSort = { key: '_maturityStage', ascending: true };
let assetsData = null;

async function loadAssets() {
    const status = document.getElementById('status');
    const tableWrap = document.getElementById('tableWrap');
    const thead = document.querySelector('#assetsTable thead');
    const tbody = document.querySelector('#assetsTable tbody');

    try {
        const res = await fetch('./rwa-assets-db.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();

        const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.assets) ? raw.assets : [];
        if (!rows.length) {
            status.textContent = 'No asset records found in rwa-assets-db.json';
            return;
        }

        assetsData = rows;

        thead.innerHTML = `<tr>${TABLE_COLUMNS.map(col =>
            `<th style="cursor:pointer;user-select:none;" data-key="${escapeHtml(col.key)}">${escapeHtml(col.label)}<span class="sort-indicator"></span></th>`
        ).join('')}</tr>`;

        thead.querySelectorAll('th').forEach(th => {
            th.addEventListener('click', () => sortByColumn(th.getAttribute('data-key')));
        });

        sortByColumn('_maturityStage');
        status.textContent = `Loaded ${rows.length} assets`;
        tableWrap.hidden = false;
        setupScrollHint();
    } catch (err) {
        status.textContent = `Failed to load rwa-assets-db.json: ${err.message}`;
    }
}

function sortByColumn(key) {
    if (currentSort.key === key) {
        currentSort.ascending = !currentSort.ascending;
    } else {
        currentSort.key = key;
        currentSort.ascending = true;
    }

    assetsData.sort((a, b) => {
        let aVal, bVal;
        if (key === '_maturityScore') {
            aVal = computeMaturityScore(a);
            bVal = computeMaturityScore(b);
        } else if (key === '_maturityStage') {
            aVal = computeMaturityStageNum(a);
            bVal = computeMaturityStageNum(b);
        } else {
            aVal = a?.[key];
            bVal = b?.[key];
        }

        if (aVal == null && bVal == null) return 0;
        if (aVal == null) return 1;
        if (bVal == null) return -1;

        const aNum = Number(aVal);
        const bNum = Number(bVal);
        if (!isNaN(aNum) && !isNaN(bNum)) {
            return currentSort.ascending ? aNum - bNum : bNum - aNum;
        }

        const cmp = String(aVal).toLowerCase().localeCompare(String(bVal).toLowerCase());
        return currentSort.ascending ? cmp : -cmp;
    });

    renderTableBody(document.querySelector('#assetsTable tbody'));
    updateSortIndicators();
}

function renderTableBody(tbody) {
    tbody.innerHTML = assetsData.map(row => `<tr${row?.status === 'defunct' ? ' class="asset-defunct"' : ''}>${TABLE_COLUMNS.map(col => {
        if (col.key === '_maturityStage') return `<td>${formatMaturityStageCell(computeMaturityStage(row))}</td>`;
        if (col.key === '_maturityScore') return `<td>${formatMaturityScoreCell(row)}</td>`;
        if (col.key === '_links') return `<td>${formatLinksCell(row)}</td>`;
        if (col.key === 'blockchain') return `<td>${formatBlockchainCell(row)}</td>`;
        if (col.key === 'asset_image') return `<td>${formatImageCell(row)}</td>`;
        if (PILLAR_KEYS.includes(col.key)) return `<td>${formatPillarCell(row?.[col.key])}</td>`;
        if (col.key === 'name') return `<td>${formatNameCell(row)}</td>`;
        return `<td>${escapeHtml(String(row?.[col.key] ?? ''))}</td>`;
    }).join('')}</tr>`).join('');
}

function updateSortIndicators() {
    document.querySelectorAll('#assetsTable th').forEach(th => {
        const key = th.getAttribute('data-key');
        const indicator = th.querySelector('.sort-indicator');
        const isActive = key === currentSort.key;
        indicator.textContent = isActive
            ? (currentSort.ascending ? ' ↑' : ' ↓')
            : '';
        th.classList.toggle('sort-active', isActive);
    });
}

function formatBlockchainCell(row) {
    const logo = row?.blockchain_logo;
    const name = escapeHtml(row?.blockchain ?? '');
    if (logo && isSafeUrl(logo)) {
        return `<img src="${escapeHtml(logo)}" alt="${name}" title="${name}" loading="lazy" style="max-width:24px;max-height:24px;object-fit:contain;display:block" />`;
    }
    return name;
}

function formatImageCell(row) {
    const src = row?.asset_image;
    if (!src || !isSafeUrl(src)) return '';
    const stage = computeMaturityStageNum(row);
    const badge = stage > 0 ? `<span class="stage-badge">${stage}</span>` : '';
    const wrapperStyle = 'position:relative;display:inline-block;line-height:0';
    const needsLightBg = row?.asset_image_background === 'light';
    const imageClass = row?.asset_image_background === 'light'
        ? 'table-asset-logo asset-logo--needs-light-bg'
        : 'table-asset-logo';
    const imageStyle = [
        'max-width:48px',
        'max-height:48px',
        'object-fit:contain',
        'display:block',
        needsLightBg ? 'background:rgba(255,255,255,0.96)' : '',
        needsLightBg ? 'border-radius:12px' : '',
        needsLightBg ? 'padding:4px' : '',
        needsLightBg ? 'box-sizing:border-box' : '',
        needsLightBg ? 'box-shadow:0 0 0 1px rgba(148,163,184,0.18)' : ''
    ].filter(Boolean).join(';');
    return `<div style="${wrapperStyle}"><img src="${escapeHtml(src)}" alt="" loading="lazy" class="${imageClass}" style="${imageStyle}" />${badge}</div>`;
}

function formatNameCell(row) {
    const name = escapeHtml(row?.name ?? '');
    const ticker = row?.ticker ? `<span style="opacity:0.6;font-size:0.85em;margin-left:4px">${escapeHtml(row.ticker)}</span>` : '';
    return name + ticker;
}

function formatLinksCell(row) {
    const pills = [];
    const website = row?.website;
    const ticker = row?.ticker;

    if (website && isSafeUrl(website)) {
        pills.push(`<a class="link-pill" href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer" title="Issuer website">🌐 Web</a>`);
    }

    if (ticker) {
        const t = encodeURIComponent(ticker);
        const tLower = ticker.toLowerCase();
        pills.push(`<a class="link-pill" href="https://www.coingecko.com/en/coins/${escapeHtml(tLower)}" target="_blank" rel="noopener noreferrer" title="CoinGecko">🦎 CG</a>`);
        pills.push(`<a class="link-pill" href="https://defillama.com/rwa/asset/${escapeHtml(tLower)}" target="_blank" rel="noopener noreferrer" title="DefiLlama">🦙 DL</a>`);
        pills.push(`<a class="link-pill" href="https://app.rwa.xyz/assets/${escapeHtml(ticker)}" target="_blank" rel="noopener noreferrer" title="RWA.xyz">📊 RWA</a>`);
    }

    if (!pills.length) return '';
    return `<div class="link-pills">${pills.join('')}</div>`;
}

function formatPillarCell(value) {
    const yes = isYes(value);
    const no = isNo(value);
    if (yes) return '<span class="pillar-yes" title="Yes">&#x2714;</span>';
    if (no) return '<span class="pillar-no" title="No">&#x2718;</span>';
    return '<span class="pillar-unknown" title="Unknown">—</span>';
}

function isYes(value) {
    return ['yes', 'y', '1', 'true'].includes(String(value ?? '').trim().toLowerCase());
}

function isNo(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return ['no', 'n', '0', 'false'].includes(v);
}

function isSafeUrl(url) {
    if (!url) return false;
    const lowerUrl = url.trim().toLowerCase();
    return lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://');
}

function isPropertyField(key) {
    return !GENERAL_FIELDS.has(key);
}

function computeMaturityStageNum(row) {
    if (!row) return 0;
    if (!isYes(row.blockchainIsMainLedger)) return 0;
    if (!isYes(row.unconditionalTransfers)) return 1;
    if (!isYes(row.bearerRedemption)) return 2;
    if (!isYes(row.forcedTransfers)) return 3;
    return 4;
}

function computeMaturityStage(row) {
    return `Level ${computeMaturityStageNum(row)}`;
}

function computeMaturityScore(row) {
    if (!row || typeof row !== 'object') return 0;
    let score = 0;
    for (const [key, value] of Object.entries(row)) {
        if (!isPropertyField(key)) continue;
        if (isYes(value)) score++;
        else if (isNo(value)) score--;
    }
    return score;
}

function getYesNoCounts(row) {
    if (!row || typeof row !== 'object') return { yes: 0, no: 0 };
    let yes = 0, no = 0;
    for (const [key, value] of Object.entries(row)) {
        if (!isPropertyField(key)) continue;
        if (isYes(value)) yes++;
        else if (isNo(value)) no++;
    }
    return { yes, no };
}

function formatMaturityStageCell(stage) {
    const num = parseInt(stage.replace('Level ', ''), 10) || 0;
    const cls = `level-${Math.min(num, 4)}`;
    return `<span class="maturity-pill ${cls}">${escapeHtml(stage)}</span>`;
}

function formatMaturityScoreCell(row) {
    const score = computeMaturityScore(row);
    const counts = getYesNoCounts(row);
    const green = '▪'.repeat(counts.yes);
    const red = '▪'.repeat(counts.no);
    return `<div class="maturity-meter">
        <span class="maturity-score">${score}</span>
        <div class="maturity-marks">
            <span class="pillar-yes">${green}</span>
            <span class="pillar-no">${red}</span>
        </div>
    </div>`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Checks if a URL starts with a safe protocol (http:// or https://).
 * @param {string} url The URL to check.
 * @returns {boolean} True if the URL is safe, false otherwise.
 */
function isSafeUrl(url) {
    if (!url) return false;
    const trimmedUrl = url.trim().toLowerCase();
    return trimmedUrl.startsWith('http://') ||
           trimmedUrl.startsWith('https://') ||
           trimmedUrl.startsWith('/') ||
           trimmedUrl.startsWith('./') ||
           trimmedUrl.startsWith('../') ||
           trimmedUrl.startsWith('mailto:');
}

function setupDescriptionTooltip() {
    const tip = document.getElementById('descTooltip');
    let active = null;

    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest('.desc-clamp');
        if (!el) return;
        active = el;
        tip.textContent = el.getAttribute('data-full') || '';
        tip.style.display = 'block';
        tip.setAttribute('aria-hidden', 'false');
    });

    document.addEventListener('mousemove', (e) => {
        if (!active) return;
        tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
        tip.style.top = `${Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8)}px`;
    });

    document.addEventListener('mouseout', (e) => {
        if (!active) return;
        if (e.relatedTarget?.closest?.('.desc-clamp') === active) return;
        active = null;
        tip.style.display = 'none';
        tip.setAttribute('aria-hidden', 'true');
    });
}

function setupTabs() {
    const tabAssets = document.getElementById('tab-assets');
    const tabVocabulary = document.getElementById('tab-vocabulary');
    const tabHowto = document.getElementById('tab-howto');
    const panelAssets = document.getElementById('panel-assets');
    const panelVocabulary = document.getElementById('panel-vocabulary');
    const panelHowto = document.getElementById('panel-howto');

    function setActiveTab(tab) {
        const assetsActive = tab === 'assets';
        const vocabularyActive = tab === 'vocabulary';
        const howtoActive = tab === 'howto';
        tabAssets.setAttribute('aria-selected', assetsActive ? 'true' : 'false');
        tabVocabulary.setAttribute('aria-selected', vocabularyActive ? 'true' : 'false');
        tabHowto.setAttribute('aria-selected', howtoActive ? 'true' : 'false');
        panelAssets.hidden = !assetsActive;
        panelVocabulary.hidden = !vocabularyActive;
        panelHowto.hidden = !howtoActive;
    }

    tabAssets.addEventListener('click', () => setActiveTab('assets'));
    tabVocabulary.addEventListener('click', () => setActiveTab('vocabulary'));
    tabHowto.addEventListener('click', () => setActiveTab('howto'));
}

function setupScrollHint() {
    const tableWrap = document.getElementById('tableWrap');
    const tableOuter = document.getElementById('tableOuter');
    if (!tableWrap || !tableOuter) return;
    function update() {
        const atEnd = tableWrap.scrollLeft + tableWrap.clientWidth >= tableWrap.scrollWidth - 4;
        tableOuter.classList.toggle('scroll-end', atEnd);
    }
    tableWrap.addEventListener('scroll', update, { passive: true });
    update();
}

loadAssets();
setupDescriptionTooltip();
setupTabs();
