/**
 * Renders the "Tokenized stocks on Solana" page from the two built files (stocks/MODEL.md §10.1):
 * stocks-issuers.json feeds the claim-depth x ledger-maturity grid, the issuer cards and their
 * detail dialogs, and stocks-tokens.json feeds the token table with its filters and sorting. The
 * issuer file is fetched and rendered first, because the grid and the cards are the top of the
 * page and need nothing from the larger token file. This file is the page layer only — DOM
 * rendering and event wiring. Every pure helper it calls (formatting, grouping, filtering, scoring,
 * comparison shaping, URL/state parsing, markup builders) lives in a UMD module under stocks/lib/
 * that stocks.html loads before this script and jest tests on its own (next-steps.md F11).
 */

// ---------------------------------------------------------------------------
// The pure modules: window.__rwa* in the browser, require() under jest.
// ---------------------------------------------------------------------------

const fmt = (typeof __rwaFmt !== 'undefined') ? __rwaFmt : require('./stocks/lib/fmt.js');
const discovery = (typeof __rwaDiscovery !== 'undefined')
    ? __rwaDiscovery : require('./stocks/lib/discovery.js');
const sortValues = (typeof __rwaSortValues !== 'undefined')
    ? __rwaSortValues : require('./stocks/lib/sort-values.js');
const issuerLabels = (typeof __rwaIssuerLabels !== 'undefined')
    ? __rwaIssuerLabels : require('./stocks/lib/issuer-labels.js');
const tokenView = (typeof __rwaTokenView !== 'undefined')
    ? __rwaTokenView : require('./stocks/lib/token-view.js');
const activityLib = (typeof __rwaActivityRows !== 'undefined')
    ? __rwaActivityRows : require('./stocks/lib/activity-rows.js');
const funnelLib = (typeof __rwaFunnelLayout !== 'undefined')
    ? __rwaFunnelLayout : require('./stocks/lib/funnel-layout.js');
const evidenceView = (typeof __rwaEvidenceView !== 'undefined')
    ? __rwaEvidenceView : require('./stocks/lib/evidence-view.js');
const discrepancyView = (typeof __rwaDiscrepancyView !== 'undefined')
    ? __rwaDiscrepancyView : require('./stocks/lib/discrepancy-view.js');
const trustChainSection = (typeof __rwaTrustChainSection !== 'undefined')
    ? __rwaTrustChainSection : require('./stocks/lib/trustchain-section.js');
const defiView = (typeof __rwaDefiView !== 'undefined')
    ? __rwaDefiView : require('./stocks/lib/defi-view.js');
const comparisonShape = (typeof __rwaComparisonShape !== 'undefined')
    ? __rwaComparisonShape : require('./stocks/lib/comparison-shape.js');
const savedLib = (typeof __rwaSavedItems !== 'undefined')
    ? __rwaSavedItems : require('./stocks/lib/saved-items.js');
const searchResults = (typeof __rwaSearchResults !== 'undefined')
    ? __rwaSearchResults : require('./stocks/lib/search-results.js');
const panelMarkup = (typeof __rwaPanelMarkup !== 'undefined')
    ? __rwaPanelMarkup : require('./stocks/lib/panel-markup.js');

const {
    DASH, SLUG_SAFE, cardSlug, escapeHtml, fetchedAtOf, fmtAgeSeconds, fmtCountOfTotal, fmtDate,
    fmtDateTime, fmtMoney, fmtNumber, fmtPct, fmtPrice, fmtRelativeTime, fmtSignedPct,
    fmtTradesPerTrader, fmtVenueSpread, fmtVenueSpreadPct, humanizeSlug, isNum, isSafeUrl, isoToMillis,
    mintSuffix
} = fmt;
const {
    collectorHealth, laypersonVerdict, legalReviewStatus, parseStockSearch, sameUnderlyingGroups,
    underlyingGroups
} = discovery;
const {
    makeComparator
} = sortValues;
const {
    GRID_FIRST_DATA_COLUMN, GRID_LABEL_ROW, GRID_RUNGS, GRID_STAGES, MARKET_TOOLTIPS, cardLinkHtml,
    chipSize, claimAxisLabels, claimLabel, claimRungTooltip, coverageClass, coverageLabel, displayName,
    fmtFeeBps, gridCell, indexTypes, isControlOn, issuerDossierHref, issuerHeadline, labelForSchema,
    maturityLevelTooltip, newMintChipHtml, newMintChips, newMintsWindowDays, severityClass,
    sortIssuersForDisplay, transferFeeCapabilityLabel, verificationLabel, worstSeverity
} = issuerLabels;
const {
    TOKEN_COLUMN_PRESETS, TOKEN_PAGE_SIZE, WORKSPACE_VIEWS, dataStateHtml, filterTokens, tokenApiParams,
    tokenFromApiRow, tokenPageMath, tokenViewStateFromUrl, tokenViewStateParams, workspaceViewFromUrl
} = tokenView;
const {
    activityFlags, activityRows, venueRows
} = activityLib;
const {
    funnelLayout, funnelSvg, funnelTitle
} = funnelLib;
const {
    evidenceIndex, evidenceLineHtml, fieldChipHtml, provenanceHtml
} = evidenceView;
const {
    discrepanciesHtml, discrepancyCalloutHtml, discrepancyDirectoryHtml, discrepancyRows,
    filterDiscrepancyRows
} = discrepancyView;
const {
    chainSectionHtml, whatIfSectionHtml
} = trustChainSection;
const {
    DEFI_ACTION_LABELS, DEFI_ACTION_ORDER, composabilityTemplateForToken, composabilityTemplatesHtml,
    controlExplicitlyOff, defiActionText, defiNewStripHtml, defiProtocolDirectoryHtml, defiProtocolRows, defiSourceRows,
    defiUsageCompactHtml, defiUsageDetailHtml, defiUsageIndex, filterDefiProtocols,
    productDecisionProfile, redemptionUsabilitySummary
} = defiView;
const {
    comparisonBundleFilename, comparisonBundleMatches, comparisonRequirementsParam, comparisonTickerFromParams,
    conceptGuideRowHtml, conceptHelpHtml, filterComparisonModels, parseComparisonRequirements,
    sameStockComparisonHtml, sameStockComparisonModels
} = comparisonShape;
const {
    comparisonSnapshot, comparisonSnapshotChanges, normalizeSavedItems, personalJournalSummary,
    toggleSavedItem
} = savedLib;
const {
    groupedSearchResults, searchIntentLabels, underlyingDirectoryHtml
} = searchResults;
const {
    badge, controlValue, detailList, detailSection, freezeExercisedClass, freezeExercisedLabel,
    keyGovernanceSummary, linkHtml, metric, personalListHtml, redemptionAnswer, redemptionAnswerHtml,
    verificationBarHtml
} = panelMarkup;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        const ISSUERS_PATH = './stocks-issuers.json';
        const TOKENS_PATH = './stocks-tokens.json';
        const DISCOVERY_PATH = './stocks-discovery.json';
        const CHANGES_PATH = './stocks-changes.json';
        const FUNNEL_PATH = './stocks-funnel.json';
        const SAMPLE_ISSUERS_PATH = './stocks/fixtures/stocks-issuers.sample.json';
        const SAMPLE_TOKENS_PATH = './stocks/fixtures/stocks-tokens.sample.json';
        const VENUES_PATH = './stocks/data/venues.json';
        // The field-need list behind the hollow "§?" chip. One file, shared with the builders
        // (stocks/lib/evidence.mjs reads the same path), so the page can never disagree with the
        // coverage number the build wrote. Its absence only costs the fallback expansion.
        const CLAIM_FIELDS_PATH = './stocks/data/claim-fields.json';
        // The trust-chain catalogue, fetched for the same reason: the actor order and labels the
        // what-if groups read are in the file the builders and the API read, not in the API's rows.
        const TRUST_CHAIN_PATH = './stocks/data/trust-chain.json';
        const COMPOSABILITY_PATH = './stocks/data/composability-templates.json';
        const DEFI_USAGE_PATH = './stocks/data/defi-usage.json';
        // Protocol additions / removals / review candidates (stocks/build-defi-changes.mjs).
        const DEFI_NEW_PATH = './stocks-defi-new.json';
        const REVIEW_QUEUE_PATH = './stocks-review-queue.json';
        const JOURNAL_PATH = './stocks-change-journal.json';

        const BUILD_HINT = 'Build it with "npm run stocks:all && npm run stocks:build"';

        const initialTokenView = tokenViewStateFromUrl(window.location.href);
        const state = {
            builtAt: null,
            issuers: [],
            issuersBySlug: new Map(),
            tokens: [],
            tokensByMint: new Map(),
            tokensLoaded: false,
            fullCatalogueLoaded: false,
            fullCataloguePromise: null,
            discoveryProtocols: [],
            useSample: false,
            tokenPage: initialTokenView.page,
            tokenColumnPreset: initialTokenView.preset,
            globalQuery: initialTokenView.searchQuery,
            tokenTotal: 0,
            tokenRows: [],
            tokenRequestSeq: 0,
            venuesByMint: null,
            venuesLoaded: false,
            claimFields: [],
            changes: null,
            funnel: null,
            // The trust-chain catalogue (stocks/data/trust-chain.json), fetched like the claim-field
            // list beside it: the page needs its ACTOR ORDER and labels to group the what-if
            // answers, which the API's per-row `actor_label` cannot give.
            catalogue: null,
            composability: null,
            defiUsage: null,
            defiUsageByMint: new Map(),
            defiAction: 'all',
            // One answer sheet per issuer slug, kept so reopening a panel does not re-fetch:
            // an object is the sheet, a string is the failure that must be shown instead of it.
            whatIfBySlug: new Map(),
            // Which issuer's panel is open, so a sheet that lands after the reader has moved on is
            // dropped rather than written into whatever panel is showing now.
            openIssuerSlug: null,
            // The open issuer panel's chip index, set by detailHtml() and cleared by the token
            // panel, which renders on-chain facts rather than dossier claims.
            detailEvidence: null,
            detailReturnFocus: null,
            openTokenMint: null,
            findingTypes: Object.create(null),
            attestationTypes: Object.create(null),
            filters: initialTokenView.filters,
            comparisonGroups: [],
            comparisonModels: [],
            comparisonBundles: new Map(),
            comparisonRequest: 0,
            comparisonTicker: null,
            comparisonSelected: new Set(),
            comparisonFilters: new Set(),
            discrepancies: [],
            discrepancyFilters: { issuer: '', asset: '', impact: '', status: '' },
            savedItems: { tickers: [], issuers: [] },
            journal: [],
            journalVisit: null,
            underlyingExpanded: false,
            reviewP0ByIssuer: new Map(),
            historyRequest: 0,
            serverWatch: null,
            currentWorkspaceView: 'overview',
            renderedViews: new Set(),
            sharedWatchRestored: false,
            sort: initialTokenView.sort,
            activitySort: { key: 'trades24', ascending: false }
        };

        // Which token-table columns can be sorted, and what each one reads.
        const SORT_KEYS = {
            price: (t) => t.market && t.market.usdPrice,
            premium: (t) => t.reference && t.reference.premiumPct,
            liquidity: (t) => t.market && t.market.liquidity,
            vol24: (t) => t.market && t.market.vol24,
            trades24: (t) => t.activity && t.activity.trades24,
            traders24: (t) => t.activity && t.activity.traders24,
            spread: (t) => t.activity && t.activity.venueSpreadPct,
            holders: (t) => t.market && t.market.holderCount,
            lastTrade: (t) => isoToMillis(t.activity && t.activity.lastTradedAt)
        };

        // The Trading-activity table reads its already-shaped rows (issuerActivityRow), so a
        // column sorts on the same value the cell shows.
        const ACTIVITY_SORT_KEYS = {
            issuer: (row) => row.name,
            tokensTraded: (row) => row.tokensTraded24,
            trades24: (row) => row.trades24,
            traders24: (row) => row.traders24,
            tradesPerTrader: (row) => row.tradesPerTrader,
            organic: (row) => row.organicSharePct,
            venues: (row) => row.venueCount,
            venueSpread: (row) => row.venueSpreadMedianPct,
            lastTrade: (row) => isoToMillis(row.lastTradedAt)
        };

        // Compact per-token flag glyphs: [property, glyph, tooltip].
        const TOKEN_FLAGS = [
            ['clawback', 'C', 'Clawback: a permanent delegate can move this token out of any wallet'],
            ['freezeAuthority', 'F', 'Freeze authority is live: the issuer can freeze any account'],
            ['pausable', 'P', 'Pausable: the whole token can be halted'],
            ['allowlist', 'A', 'Allowlist: new accounts start frozen and must be onboarded'],
            ['hookActive', 'H', 'Transfer hook installed: a program runs on every transfer']
        ];

        const els = {
            status: document.getElementById('status'),
            dataAsOf: document.getElementById('dataAsOf'),
            sampleBanner: document.getElementById('sampleBanner'),
            newMints: document.getElementById('newMints'),
            newMintsTrack: document.getElementById('newMintsTrack'),
            newMintsClone: document.getElementById('newMintsClone'),
            newMintsWindow: document.getElementById('newMintsWindow'),
            funnelSection: document.getElementById('funnelSection'),
            funnelHeading: document.getElementById('funnelHeading'),
            funnelGraphic: document.getElementById('funnelGraphic'),
            grid: document.getElementById('claimGrid'),
            gridLegend: document.getElementById('gridLegend'),
            issuerCards: document.getElementById('issuerCards'),
            issuerQualifier: document.getElementById('issuerQualifier'),
            largestProgramme: document.getElementById('largestProgramme'),
            issuerCount: document.getElementById('issuerCount'),
            activityTableBody: document.querySelector('#activityTable tbody'),
            activityTableHead: document.querySelector('#activityTable thead'),
            activityHint: document.getElementById('activityHint'),
            tokenTableBody: document.querySelector('#tokenTable tbody'),
            tokenTableHead: document.querySelector('#tokenTable thead'),
            tokenCount: document.getElementById('tokenCount'),
            tokenPager: document.getElementById('tokenPager'),
            tokenPageLabel: document.getElementById('tokenPageLabel'),
            tokenPrev: document.getElementById('tokenPrev'),
            tokenNext: document.getElementById('tokenNext'),
            tokenTable: document.getElementById('tokenTable'),
            tokenColumnPresets: document.getElementById('tokenColumnPresets'),
            filterIssuer: document.getElementById('filterIssuer'),
            filterInstrument: document.getElementById('filterInstrument'),
            globalSearch: document.getElementById('globalSearch'),
            globalSearchResults: document.getElementById('globalSearchResults'),
            underlyingGrid: document.getElementById('underlyingGrid'),
            underlyingFilter: document.getElementById('underlyingFilter'),
            showAllUnderlyings: document.getElementById('showAllUnderlyings'),
            collectorHealth: document.getElementById('collectorHealth'),
            comparisonSection: document.getElementById('comparisonSection'),
            comparisonUnderlying: document.getElementById('comparisonUnderlying'),
            comparisonProducts: document.getElementById('comparisonProducts'),
            comparisonFilters: document.getElementById('comparisonFilters'),
            comparisonSelectionCount: document.getElementById('comparisonSelectionCount'),
            saveComparison: document.getElementById('saveComparison'),
            clearComparisonFilters: document.getElementById('clearComparisonFilters'),
            shareComparison: document.getElementById('shareComparison'),
            comparisonWatchStatus: document.getElementById('comparisonWatchStatus'),
            comparisonView: document.getElementById('comparisonView'),
            discrepanciesSection: document.getElementById('discrepanciesSection'),
            discrepancyIssuer: document.getElementById('discrepancyIssuer'),
            discrepancyAsset: document.getElementById('discrepancyAsset'),
            discrepancyImpact: document.getElementById('discrepancyImpact'),
            discrepancyStatus: document.getElementById('discrepancyStatus'),
            discrepancyCount: document.getElementById('discrepancyCount'),
            discrepancyGrid: document.getElementById('discrepancyGrid'),
            personalHome: document.getElementById('personalHome'),
            personalVisit: document.getElementById('personalVisit'),
            personalStocks: document.getElementById('personalStocks'),
            personalIssuers: document.getElementById('personalIssuers'),
            personalComparisons: document.getElementById('personalComparisons'),
            personalNewAssets: document.getElementById('personalNewAssets'),
            personalProtocolChanges: document.getElementById('personalProtocolChanges'),
            personalStockCount: document.getElementById('personalStockCount'),
            personalIssuerCount: document.getElementById('personalIssuerCount'),
            personalComparisonCount: document.getElementById('personalComparisonCount'),
            clearPersonalHome: document.getElementById('clearPersonalHome'),
            composabilitySection: document.getElementById('composabilitySection'),
            composabilityBody: document.getElementById('composabilityBody'),
            composabilityMethod: document.getElementById('composabilityMethod'),
            defiUsageSection: document.getElementById('defiUsageSection'),
            defiUsageStats: document.getElementById('defiUsageStats'),
            defiNewStrip: document.getElementById('defiNewStrip'),
            defiNewList: document.getElementById('defiNewList'),
            defiSourceCoverage: document.getElementById('defiSourceCoverage'),
            defiUsageMethod: document.getElementById('defiUsageMethod'),
            defiActionFilters: document.getElementById('defiActionFilters'),
            defiProtocolGrid: document.getElementById('defiProtocolGrid'),
            detail: document.getElementById('detailDialog'),
            detailBody: document.getElementById('detailBody'),
            detailTitle: document.getElementById('detailTitle'),
            detailClose: document.getElementById('detailClose')
        };

        function requestedWorkspaceView() {
            return workspaceViewFromUrl(window.location.href);
        }

        function writeTokenViewUrl() {
            const url = new URL(window.location.href);
            for (const key of ['tokenIssuer', 'tokenInstrument', 'tokenQuery', 'search', 'columns', 'tokenSort', 'tokenOrder', 'tokenPage']) {
                url.searchParams.delete(key);
            }
            const params = tokenViewStateParams({
                filters: state.filters,
                searchQuery: state.globalQuery,
                preset: state.tokenColumnPreset,
                sort: state.sort,
                page: state.tokenPage
            });
            for (const [key, value] of params) url.searchParams.set(key, value);
            window.history.replaceState(null, '', url);
        }

        function applyTokenColumnPreset(preset, { writeUrl = false } = {}) {
            const next = Object.hasOwn(TOKEN_COLUMN_PRESETS, preset) ? preset : 'overview';
            state.tokenColumnPreset = next;
            if (els.tokenTable) els.tokenTable.dataset.preset = next;
            els.tokenColumnPresets?.querySelectorAll('[data-token-preset]').forEach((button) => {
                button.setAttribute('aria-pressed', button.dataset.tokenPreset === next ? 'true' : 'false');
            });
            if (writeUrl) writeTokenViewUrl();
        }

        function applyTokenViewFromUrl() {
            const view = tokenViewStateFromUrl(window.location.href);
            state.filters = view.filters;
            state.globalQuery = view.searchQuery;
            state.sort = view.sort;
            state.tokenPage = view.page;
            if (els.filterIssuer) els.filterIssuer.value = view.filters.issuer;
            if (els.filterInstrument) els.filterInstrument.value = view.filters.instrumentType;
            if (els.globalSearch) els.globalSearch.value = view.searchQuery;
            applyTokenColumnPreset(view.preset);
        }

        /**
         * The tab buttons only. `<body data-workspace-view>` carries the same attribute for CSS, and
         * selecting it too made every click on the page a tab click (a history entry, a scroll jump).
         */
        function workspaceTabs() {
            return Array.from(document.querySelectorAll('.workspace-tabs [data-workspace-view]'));
        }

        /** Scrolls the tab strip sideways, never the page, so the selected tab is not cut off on a phone. */
        function revealTab(button) {
            const strip = button.closest('.workspace-tabs');
            if (!strip) return;
            const tab = button.getBoundingClientRect();
            const box = strip.getBoundingClientRect();
            if (tab.left < box.left) strip.scrollLeft -= box.left - tab.left + 12;
            else if (tab.right > box.right) strip.scrollLeft += tab.right - box.right + 12;
        }

        function setWorkspaceView(view, { writeUrl = false, scroll = false } = {}) {
            const next = WORKSPACE_VIEWS.has(view) ? view : 'overview';
            state.currentWorkspaceView = next;
            document.body.dataset.workspaceView = next;
            workspaceTabs().forEach((button) => {
                const selected = button.dataset.workspaceView === next;
                button.setAttribute('aria-selected', selected ? 'true' : 'false');
                button.tabIndex = selected ? 0 : -1;
                if (selected) revealTab(button);
            });
            if (writeUrl) {
                const url = new URL(window.location.href);
                url.searchParams.set('view', next);
                url.hash = '';
                window.history.pushState(null, '', url);
            }
            if (scroll) document.querySelector('.workspace-tabs')?.scrollIntoView({ block: 'start' });
            ensureWorkspaceView(next);
        }

        function initWorkspaceNavigation() {
            const tabs = workspaceTabs();
            setWorkspaceView(requestedWorkspaceView());
            tabs.forEach((button, index) => {
                button.addEventListener('click', () => setWorkspaceView(button.dataset.workspaceView, { writeUrl: true, scroll: true }));
                button.addEventListener('keydown', (event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                    const next = tabs[nextIndex];
                    next.focus();
                    setWorkspaceView(next.dataset.workspaceView, { writeUrl: true, scroll: false });
                });
            });
            document.querySelectorAll('[data-open-view]').forEach((button) => {
                button.addEventListener('click', () => setWorkspaceView(button.dataset.openView, { writeUrl: true, scroll: true }));
            });
            window.addEventListener('popstate', () => {
                setWorkspaceView(requestedWorkspaceView());
                applyTokenViewFromUrl();
                renderGlobalSearch();
                if (state.tokensLoaded) loadTokenPage();
            });
        }

        // Keep the shared reduced-motion hook even though the redesigned catalogue has no
        // auto-moving feed. It also suppresses small decorative transitions in the workspace.
        const reduceMotion = new URLSearchParams(window.location.search).has('reduceMotion')
            || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (reduceMotion) document.body.classList.add('reduce-motion');

        // Where the read-only API lives: same origin in production, `?api=<origin>` from a dev
        // server. Only the what-if answers are fetched from it — everything else on this page comes
        // from the built files — so its absence costs that one section and nothing more.
        const apiLib = (typeof __rwaApi !== 'undefined') ? __rwaApi : null;
        const apiBase = apiLib === null ? '' : apiLib.apiBase();
        let tokenSearchTimer = null;

        initWorkspaceNavigation();
        applyTokenColumnPreset(state.tokenColumnPreset);
        if (els.globalSearch) els.globalSearch.value = state.globalQuery;
        loadPage();

        /**
         * Two passes, in the order the page is read: the issuer file (grid, cards, issuer filter),
         * then the token file (the table). The second fetch only starts once the first has been
         * rendered, so the smaller file is never slowed down by the larger one.
         */
        async function loadPage() {
            const useSample = new URLSearchParams(window.location.search).get('db') === 'sample';
            state.useSample = useSample;
            state.savedItems = readSavedItems();
            if (!useSample) {
                await loadDiscoveryPage();
                return;
            }
            const issuersPath = useSample ? SAMPLE_ISSUERS_PATH : ISSUERS_PATH;
            const tokensPath = useSample ? SAMPLE_TOKENS_PATH : TOKENS_PATH;

            tokenTableMessage('loading', 'Loading token catalogue', 'Reading the current token snapshot and preparing the first page.');
            els.tokenCount.textContent = 'loading…';

            // The change log and the funnel are two more small files (~30 kB and ~7 kB) feeding one
            // section each, so they are fetched alongside the issuers and their absence is not an
            // error — the section hides itself. Neither has a sample fixture, so ?db=sample skips
            // both rather than mixing three live mints into twelve fixture ones.
            const [issuerDb, findingTypes, attestationTypes, changes, funnel, claimFields, catalogue, composability, defiUsage, reviewQueue, journal] =
                await Promise.all([
                    fetchJson(issuersPath),
                    fetchJson('./finding-types.json'),
                    fetchJson('./attestation-types.json'),
                    useSample ? Promise.resolve(null) : fetchJson(CHANGES_PATH),
                    useSample ? Promise.resolve(null) : fetchJson(FUNNEL_PATH),
                    fetchJson(CLAIM_FIELDS_PATH),
                    fetchJson(TRUST_CHAIN_PATH),
                    useSample ? Promise.resolve(null) : fetchJson(COMPOSABILITY_PATH),
                    useSample ? Promise.resolve(null) : fetchJson(DEFI_USAGE_PATH),
                    useSample ? Promise.resolve(null) : fetchJson(REVIEW_QUEUE_PATH),
                    useSample ? Promise.resolve(null) : fetchJson(JOURNAL_PATH)
                ]);

            state.claimFields = claimFields && Array.isArray(claimFields.fields) ? claimFields.fields : [];
            state.catalogue = catalogue;
            state.composability = composability;
            state.defiUsage = defiUsage;
            state.defiUsageByMint = defiUsageIndex(defiUsage);
            state.changes = changes;
            state.funnel = funnel;
            state.journal = Array.isArray(journal?.items) ? journal.items : [];
            state.journalVisit = personalJournalSummary(state.journal, readJournalVisit());
            state.reviewP0ByIssuer = new Map();
            for (const item of reviewQueue?.items ?? []) {
                if (item.priority !== 'P0' || !item.issuerSlug) continue;
                if (!state.reviewP0ByIssuer.has(item.issuerSlug)) state.reviewP0ByIssuer.set(item.issuerSlug, []);
                state.reviewP0ByIssuer.get(item.issuerSlug).push(item);
            }

            state.findingTypes = indexTypes(findingTypes);
            state.attestationTypes = indexTypes(attestationTypes);

            if (!issuerDb || !Array.isArray(issuerDb.issuers)) {
                els.status.textContent = `No data: ${issuersPath} could not be loaded or has no issuers. ` +
                    `${BUILD_HINT}, or append ?db=sample to this URL to view the bundled sample fixture.`;
                els.status.classList.add('status-error');
                els.tokenCount.textContent = DASH;
                tokenTableMessage('failed', 'Issuer research failed to load', `The token catalogue cannot be linked to issuer dossiers because ${issuersPath} is unavailable.`, [
                    { label: 'Retry page', action: 'reload-page' }, { label: 'Open health monitor', href: './monitor.html' }
                ]);
                return;
            }

            state.issuers = issuerDb.issuers;
            state.issuersBySlug = new Map(state.issuers.map((issuer) => [issuer.slug, issuer]));
            state.builtAt = issuerDb.builtAt;

            if (useSample && els.sampleBanner) els.sampleBanner.hidden = false;

            const fetchedAt = fetchedAtOf(issuerDb.sources && issuerDb.sources.universe);
            els.dataAsOf.textContent = fmtDateTime(fetchedAt);
            els.dataAsOf.setAttribute('datetime', fetchedAt || '');

            renderStatus('tokens loading…');
            renderCollectorHealth(issuerDb.sources);
            populateIssuerFilter(state.issuers);
            wireEvents();
            const requestedIssuer = new URLSearchParams(window.location.search).get('issuer');
            if (requestedIssuer) openDetail(requestedIssuer, { writeUrl: false });

            const tokenDb = await fetchJson(tokensPath);
            if (!tokenDb || !Array.isArray(tokenDb.tokens)) {
                els.tokenCount.textContent = DASH;
                tokenTableMessage('failed', 'Token snapshot failed to load', `${tokensPath} is unavailable, so we cannot say which tokens exist. ${BUILD_HINT}.`, [
                    { label: 'Retry page', action: 'reload-page' }, { label: 'Open health monitor', href: './monitor.html' }
                ]);
                renderStatus('tokens unavailable');
                return;
            }

            state.tokens = tokenDb.tokens;
            state.tokensByMint = new Map(state.tokens.map((token) => [token.mint, token]));
            state.tokensLoaded = true;
            state.fullCatalogueLoaded = true;
            populateInstrumentFilter(state.tokens);
            await ensureWorkspaceView(state.currentWorkspaceView);
            renderStatus(`${state.tokens.length} tokens`);
            writeJournalVisit(state.journalVisit);
        }

        async function loadDiscoveryPage() {
            tokenTableMessage('loading', 'Loading token catalogue', 'Reading the compact discovery index and preparing the first page.');
            els.tokenCount.textContent = 'loading…';
            // The scoped decision path needs identities, not the full change history. Briefing
            // data loads only when the briefing is opened; search remains available in every view.
            const discoveryDb = await fetchJson(DISCOVERY_PATH);
            if (!discoveryDb || !Array.isArray(discoveryDb.issuers) || !Array.isArray(discoveryDb.tokens)) {
                els.status.textContent = `No data: ${DISCOVERY_PATH} could not be loaded. ${BUILD_HINT}.`;
                els.status.classList.add('status-error');
                els.tokenCount.textContent = DASH;
                tokenTableMessage('failed', 'Discovery index failed to load', `${DISCOVERY_PATH} is unavailable, so we cannot say which tokens exist.`, [
                    { label: 'Retry page', action: 'reload-page' }, { label: 'Open health monitor', href: './monitor.html' }
                ]);
                return;
            }
            state.builtAt = discoveryDb.builtAt;
            state.issuers = discoveryDb.issuers;
            state.issuersBySlug = new Map(state.issuers.map((issuer) => [issuer.slug, issuer]));
            state.tokens = discoveryDb.tokens;
            state.tokensByMint = new Map(state.tokens.map((token) => [token.mint, token]));
            state.discoveryProtocols = Array.isArray(discoveryDb.protocols) ? discoveryDb.protocols : [];
            state.comparisonGroups = sameUnderlyingGroups(state.tokens, { includeSingle: true });
            state.tokensLoaded = true;

            const fetchedAt = fetchedAtOf(discoveryDb.sources && discoveryDb.sources.universe);
            els.dataAsOf.textContent = fmtDateTime(fetchedAt);
            els.dataAsOf.setAttribute('datetime', fetchedAt || '');
            renderCollectorHealth(discoveryDb.sources);
            populateIssuerFilter(state.issuers);
            populateInstrumentFilter(state.tokens);
            wireEvents();
            renderStatus(`${state.tokens.length} tokens`);

            const requestedIssuer = new URLSearchParams(window.location.search).get('issuer');
            if (requestedIssuer && await loadFullCatalogue()) openDetail(requestedIssuer, { writeUrl: false });
            await ensureWorkspaceView(state.currentWorkspaceView);
        }

        async function loadFullCatalogue() {
            if (state.fullCatalogueLoaded) return true;
            if (state.fullCataloguePromise) return state.fullCataloguePromise;
            state.fullCataloguePromise = (async () => {
                const [issuerDb, tokenDb, findingTypes, attestationTypes, claimFields, catalogue,
                    composability, defiUsage, reviewQueue, funnel] = await Promise.all([
                    fetchJson(ISSUERS_PATH), fetchJson(TOKENS_PATH), fetchJson('./finding-types.json'),
                    fetchJson('./attestation-types.json'), fetchJson(CLAIM_FIELDS_PATH),
                    fetchJson(TRUST_CHAIN_PATH), fetchJson(COMPOSABILITY_PATH), fetchJson(DEFI_USAGE_PATH),
                    fetchJson(REVIEW_QUEUE_PATH), fetchJson(FUNNEL_PATH)
                ]);
                if (!issuerDb || !Array.isArray(issuerDb.issuers) || !tokenDb || !Array.isArray(tokenDb.tokens)) {
                    return false;
                }
                state.issuers = issuerDb.issuers;
                state.issuersBySlug = new Map(state.issuers.map((issuer) => [issuer.slug, issuer]));
                state.tokens = tokenDb.tokens;
                state.tokensByMint = new Map(state.tokens.map((token) => [token.mint, token]));
                state.comparisonGroups = sameUnderlyingGroups(state.tokens, { includeSingle: true });
                state.builtAt = tokenDb.builtAt ?? issuerDb.builtAt;
                state.findingTypes = indexTypes(findingTypes);
                state.attestationTypes = indexTypes(attestationTypes);
                state.claimFields = claimFields && Array.isArray(claimFields.fields) ? claimFields.fields : [];
                state.catalogue = catalogue;
                state.composability = composability;
                state.defiUsage = defiUsage;
                state.defiUsageByMint = defiUsageIndex(defiUsage);
                state.funnel = funnel;
                state.reviewP0ByIssuer = new Map();
                for (const item of reviewQueue?.items ?? []) {
                    if (item.priority !== 'P0' || !item.issuerSlug) continue;
                    if (!state.reviewP0ByIssuer.has(item.issuerSlug)) state.reviewP0ByIssuer.set(item.issuerSlug, []);
                    state.reviewP0ByIssuer.get(item.issuerSlug).push(item);
                }
                state.fullCatalogueLoaded = true;
                if (state.renderedViews.has('overview')) renderPersonalHome();
                return true;
            })().finally(() => { state.fullCataloguePromise = null; });
            return state.fullCataloguePromise;
        }

        async function ensureWorkspaceView(view) {
            if (!state.tokensLoaded) return;
            const next = WORKSPACE_VIEWS.has(view) ? view : 'overview';
            if (state.renderedViews.has(next)) return;
            if (['discrepancies', 'issuers', 'defi'].includes(next)
                && !(await loadFullCatalogue())) {
                renderStatus('full research unavailable');
                return;
            }
            state.renderedViews.add(next);
            renderGlobalSearch();
            if (next === 'overview') {
                if (!state.useSample && !state.journalVisit) {
                    const [changes, journal] = await Promise.all([fetchJson(CHANGES_PATH), fetchJson(JOURNAL_PATH)]);
                    state.changes = changes;
                    state.journal = Array.isArray(journal?.items) ? journal.items : [];
                    state.journalVisit = personalJournalSummary(state.journal, readJournalVisit());
                    // A failed read must not replace the visitor's previous change baseline.
                    if (journal) writeJournalVisit(state.journalVisit);
                }
                renderNewMints(state.changes);
                renderGlobalSearch();
                renderPersonalHome();
                return;
            }
            if (next === 'assets') {
                renderGlobalSearch();
                renderUnderlyingDirectory();
                renderActivityTable();
                await loadTokenPage();
                return;
            }
            if (next === 'compare') {
                await renderComparison();
                if (!state.sharedWatchRestored) {
                    state.sharedWatchRestored = true;
                    await restoreSharedWatchFromHash();
                }
                return;
            }
            if (next === 'discrepancies') {
                initDiscrepancyDirectory();
                return;
            }
            if (next === 'issuers') {
                renderFunnel(state.funnel);
                renderGrid(state.issuers);
                renderIssuerCards(state.issuers);
                return;
            }
            if (next === 'defi') {
                renderDefiUsage();
                renderComposability();
                await renderDefiNewStrip();
            }
        }

        function renderUnderlyingDirectory() {
            if (!els.underlyingGrid || !Array.isArray(state.tokens)) return;
            const query = (els.underlyingFilter?.value ?? '').trim().toLowerCase();
            const groups = underlyingGroups(state.tokens).filter((group) => !query
                || group.ticker.toLowerCase().includes(query)
                || group.name.toLowerCase().includes(query)
                || group.issuers.some((issuer) => (state.issuersBySlug.get(issuer)?.name ?? issuer).toLowerCase().includes(query)));
            const limit = state.underlyingExpanded || query ? groups.length : 24;
            els.underlyingGrid.innerHTML = underlyingDirectoryHtml(groups, state.issuersBySlug, limit, new Set(state.savedItems.tickers))
                || '<p class="comparison-empty">No stock matches that search.</p>';
            if (els.showAllUnderlyings) {
                els.showAllUnderlyings.hidden = groups.length <= 24 || Boolean(query);
                els.showAllUnderlyings.textContent = state.underlyingExpanded ? 'Showing every stock' : `Show all ${fmtNumber(groups.length)} stocks`;
                els.showAllUnderlyings.disabled = state.underlyingExpanded;
            }
        }

        /** The one status line, written twice: once with the issuers, once when the mints land. */
        function renderStatus(mintsPhrase) {
            const headline = issuerHeadline(state.issuers, state.tokensLoaded ? state.tokens : null);
            els.status.textContent = `${headline.count} issuer programmes${headline.qualifier ? ` (${headline.qualifier})` : ''}, ` +
                `${mintsPhrase}. Built ${fmtDateTime(state.builtAt)}.`;
        }

        function renderComposability() {
            if (!state.composability || !Array.isArray(state.composability.templates)) return;
            const html = composabilityTemplatesHtml(state.composability, state.tokens, state.issuers);
            if (html === '') return;
            els.composabilityBody.innerHTML = html;
            const reviewed = state.composability.reviewedAt
                ? `Reviewed ${fmtDate(state.composability.reviewedAt)}. `
                : '';
            els.composabilityMethod.textContent = reviewed + (state.composability.methodology ?? '');
            els.composabilitySection.hidden = false;
        }

        /** "New in DeFi": the strip above the protocol directory; hidden when the feed is absent. */
        async function renderDefiNewStrip() {
            if (!els.defiNewStrip || !els.defiNewList || state.useSample) return;
            const feed = await fetchJson(DEFI_NEW_PATH);
            if (!feed) return;
            els.defiNewList.innerHTML = defiNewStripHtml(feed);
            els.defiNewStrip.hidden = false;
        }

        function renderDefiUsage() {
            const counts = state.defiUsage?.counts;
            if (!counts || !els.defiUsageSection) return;
            const tiles = [
                ['Any source-listed use', counts.withAnyConfirmedUse],
                ['Lending / collateral', counts.withLending],
                ['Yield vault', counts.withYieldVault],
                ['DEX pool', counts.withDexPool],
                ['Account existence checked', counts.withAccountExistenceChecked],
                ['None source-listed', counts.withNoneConfirmed]
            ];
            els.defiUsageStats.innerHTML = tiles.map(([label, value]) =>
                `<div><strong>${escapeHtml(fmtNumber(value))}</strong><span>${escapeHtml(label)}</span></div>`).join('');
            const protocols = defiProtocolRows(state.defiUsage);
            const availableActions = DEFI_ACTION_ORDER.filter((action) => protocols.some((row) => row.actions.includes(action)));
            if (els.defiActionFilters) {
                els.defiActionFilters.innerHTML = ['all', ...availableActions].map((action) =>
                    `<button type="button" data-defi-action="${escapeHtml(action)}" aria-pressed="${state.defiAction === action ? 'true' : 'false'}">` +
                    `${escapeHtml(action === 'all' ? `All ${protocols.length} protocols` : DEFI_ACTION_LABELS[action])}</button>`).join('');
            }
            if (els.defiProtocolGrid) {
                const visible = filterDefiProtocols(protocols, state.defiAction);
                els.defiProtocolGrid.innerHTML = defiProtocolDirectoryHtml(visible) || dataStateHtml(
                    'none-source-listed', 'No checked protocol source lists this action',
                    'The reviewed registries and products contain no exact-token support for this action. This does not mean every protocol was checked.',
                    [{ label: 'Show all source-listed protocols', action: 'clear-defi-filter' }]
                );
                const requestedProtocol = new URLSearchParams(window.location.search).get('protocol');
                const target = requestedProtocol ? document.getElementById(`protocol-${requestedProtocol}`) : null;
                if (target) {
                    target.classList.add('search-target');
                    target.scrollIntoView({ block: 'center' });
                }
            }
            const sourceRows = defiSourceRows(state.defiUsage.sources, Date.now());
            const fresh = sourceRows.filter((row) => row.fresh).length;
            els.defiSourceCoverage.innerHTML = `<div class="evidence-context" aria-label="DeFi data context">` +
                `<span><small>Observed</small><strong>${escapeHtml(fmtDateTime(state.defiUsage.fetchedAt))}</strong></span>` +
                `<span><small>Coverage</small><strong>${fresh}/${sourceRows.length} named sources current</strong></span>` +
                `<span><small>Limit</small><strong>Unchecked protocols are not implied absent</strong></span></div><ul>` +
                sourceRows.map((row) => `<li class="defi-source-${row.fresh ? 'fresh' : 'stale'}">` +
                    `<span><strong>${escapeHtml(row.label)}</strong> · ${escapeHtml(row.scope)}</span>` +
                    `<span>${row.rows === null ? '' : `${escapeHtml(fmtNumber(row.rows))} registry rows · `}` +
                    `${row.ageHours === null ? 'not collected' : escapeHtml(fmtAgeSeconds(row.ageHours * 3600))}</span></li>`).join('') +
                `</ul><p class="defi-source-note">Coverage means these sources were checked. It does not imply that unlisted protocols were checked and found empty.</p>`;
            els.defiUsageMethod.textContent = `Checked ${fmtDateTime(state.defiUsage.fetchedAt)}. ${state.defiUsage.methodology || ''}`;
            els.defiUsageSection.hidden = false;
        }

        function renderCollectorHealth(sources) {
            if (!els.collectorHealth) return;
            const health = collectorHealth(sources, Date.now());
            const noneCollected = health.rows.every((row) => row.ageHours === null);
            const rows = health.rows.map((row) => `<li class="collector-${row.fresh ? 'fresh' : 'stale'}">` +
                `<span>${escapeHtml(row.label)}</span><span>${row.ageHours === null ? 'not collected' : escapeHtml(fmtAgeSeconds(row.ageHours * 3600))}</span></li>`).join('');
            els.collectorHealth.innerHTML = `<details><summary><strong>Collector health:</strong> ` +
                `${health.fresh}/${health.total} core feeds refreshed within 48 hours` +
                `${health.healthy ? '' : ' · attention needed'}</summary><ul>${rows}</ul>` +
                `${health.healthy ? '<p>All named core feeds are within the current 48-hour window.</p>'
                    : dataStateHtml(noneCollected ? 'not-collected' : 'stale', noneCollected ? 'Core observations were not collected' : 'Some core observations are stale', 'Changes since the last successful collection are unknown.', [{ label: 'Inspect collector health', href: './monitor.html' }])}</details>`;
        }

        function renderGlobalSearch() {
            if (!els.globalSearchResults || !els.globalSearch) return;
            const query = els.globalSearch.value;
            const profiles = new Map(state.tokens.map((token) => {
                if (token.discoveryProfile) return [token.mint, token.discoveryProfile];
                const issuer = state.issuersBySlug.get(token.issuer) ?? {};
                const usage = state.defiUsageByMint.get(token.mint);
                const integrations = usage?.integrations ?? [];
                const template = composabilityTemplateForToken(state.composability, token);
                return [token.mint, productDecisionProfile(issuer, token, integrations, template)];
            }));
            const protocols = state.defiUsage ? defiProtocolRows(state.defiUsage) : state.discoveryProtocols;
            const results = groupedSearchResults(state.tokens, state.issuers, protocols, query, 6, profiles);
            if (!query.trim()) {
                els.globalSearchResults.innerHTML = '';
                els.globalSearch.setAttribute('aria-expanded', 'false');
                return;
            }
            const intentLabels = searchIntentLabels(results.intent);
            const groupHtml = (id, label, rows, render) => rows.length
                ? `<section class="search-result-group search-result-${id}" aria-labelledby="search-${id}-heading"><h3 id="search-${id}-heading">${escapeHtml(label)} <span>${rows.length}</span></h3><div>${rows.map(render).join('')}</div></section>`
                : '';
            const stockRows = groupHtml('stocks', 'Underlying stocks', results.stocks, ({ record: group, reason }) => {
                const first = group.tokens?.[0];
                const href = group.issuerCount > 1
                    ? `./stocks.html?view=compare&compare=${encodeURIComponent(group.ticker)}`
                    : `./cards/${encodeURIComponent(first?.cardSlug || cardSlug(first?.symbol, first?.mint))}.html`;
                return `<a href="${escapeHtml(href)}" class="search-underlying"><strong>${escapeHtml(group.ticker)} · ${escapeHtml(group.name)}</strong>`
                    + `<span>${group.issuerCount} wrapper${group.issuerCount === 1 ? '' : 's'} · ${group.tokenCount} exact token${group.tokenCount === 1 ? '' : 's'}</span><small>${escapeHtml(reason)}</small></a>`;
            });
            const tokenRows = groupHtml('tokens', 'Exact tokens', results.tokens, ({ record: token, reason }) => {
                const slug = token.cardSlug || cardSlug(token.symbol, token.mint);
                return `<a href="./cards/${encodeURIComponent(slug)}.html"><strong>${escapeHtml(token.symbol || token.name || mintSuffix(token.mint))}</strong>`
                    + `<span>${escapeHtml(token.underlyingTicker || 'underlying unknown')} · ${escapeHtml((state.issuersBySlug.get(token.issuer) || {}).name || token.issuer || 'issuer unknown')}</span><small>${escapeHtml(reason)}</small></a>`;
            });
            const issuerRows = groupHtml('issuers', 'Issuers', results.issuers, ({ record: issuer, reason }) =>
                `<a href="${escapeHtml(issuerDossierHref(issuer.slug))}"><strong>${escapeHtml(issuer.name)}</strong>`
                + `<span>${escapeHtml(issuer.legalForm || 'legal form not established')}</span><small>${escapeHtml(reason)}</small></a>`);
            const protocolRows = groupHtml('protocols', 'Protocols', results.protocols, ({ record: protocol, reason }) =>
                `<a href="./stocks.html?view=defi&protocol=${encodeURIComponent(protocol.id)}"><strong>${escapeHtml(protocol.name)}</strong>`
                + `<span>${escapeHtml(defiActionText(protocol.actions))} · ${fmtNumber(protocol.tokenCount)} exact token${protocol.tokenCount === 1 ? '' : 's'}</span><small>${escapeHtml(reason)}</small></a>`);
            const groups = stockRows + tokenRows + issuerRows + protocolRows;
            const intent = intentLabels.length
                ? `<p class="search-intent"><strong>Interpreted requirement:</strong> ${escapeHtml(intentLabels.join(' · '))}</p>`
                : '';
            els.globalSearchResults.innerHTML = intent + (groups || dataStateHtml('filtered-empty', 'No result matches this request', 'No stock, exact token, issuer or checked protocol matches both the identity terms and requested capabilities.', [
                { label: 'Clear search', action: 'clear-search' },
                { label: 'Browse every stock', href: './stocks.html?view=assets' }
            ]));
            els.globalSearch.setAttribute('aria-expanded', 'true');
        }

        async function renderComparison() {
            if (!els.comparisonSection || !els.comparisonUnderlying || !els.comparisonView) return;
            state.comparisonGroups = sameUnderlyingGroups(state.tokens, { includeSingle: true });
            if (!state.comparisonGroups.length) {
                els.comparisonSection.hidden = true;
                return;
            }
            els.comparisonSection.hidden = false;
            els.comparisonUnderlying.innerHTML = state.comparisonGroups.map((group) =>
                `<option value="${escapeHtml(group.ticker)}">${escapeHtml(group.ticker)} · ${group.issuerCount} issuers · ${group.tokenCount} tokens</option>`
            ).join('');
            const params = new URLSearchParams(window.location.search);
            const requested = comparisonTickerFromParams(params, state.comparisonGroups.map((group) => group.ticker));
            if (requested) els.comparisonUnderlying.value = requested;
            // The requirement checkboxes round-trip through `requires=` like the underlying and wrappers do.
            state.comparisonFilters = parseComparisonRequirements(params.get('requires'));
            await renderComparisonTable();
        }

        function initDiscrepancyDirectory() {
            if (!els.discrepancyGrid) return;
            state.discrepancies = discrepancyRows(state.issuers, state.tokens);
            if (els.discrepanciesSection) els.discrepanciesSection.hidden = false;
            const issuers = [...new Map(state.discrepancies.map((row) =>
                [row.issuerSlug, row.issuerName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
            if (els.discrepancyIssuer) {
                els.discrepancyIssuer.innerHTML = '<option value="">Every issuer</option>' + issuers.map(([slug, name]) =>
                    `<option value="${escapeHtml(slug)}">${escapeHtml(name)}</option>`).join('');
            }
            renderDiscrepancyDirectory();
        }

        function renderDiscrepancyDirectory() {
            if (!els.discrepancyGrid) return;
            const rows = filterDiscrepancyRows(state.discrepancies, state.discrepancyFilters);
            els.discrepancyGrid.innerHTML = discrepancyDirectoryHtml(rows);
            if (els.discrepancyCount) {
                const open = rows.filter((row) => row.status === 'open').length;
                els.discrepancyCount.textContent = `${fmtNumber(rows.length)} record${rows.length === 1 ? '' : 's'} shown · ${fmtNumber(open)} open`;
            }
        }

        function showComparisonLoading(ticker) {
            document.getElementById('comparisonHeading').textContent = `${ticker} · loading…`;
            document.getElementById('comparisonSelectionSummary').textContent = 'loading…';
            if (els.comparisonSelectionCount) els.comparisonSelectionCount.textContent = '';
            if (els.comparisonProducts) els.comparisonProducts.innerHTML = '<p class="comparison-loading">Loading this stock’s wrappers…</p>';
        }

        /** Writes the active requirement checkboxes to `requires=`, dropping the parameter when none is on. */
        function writeComparisonRequirements() {
            const url = new URL(window.location.href);
            const value = comparisonRequirementsParam(state.comparisonFilters);
            if (value) url.searchParams.set('requires', value);
            else url.searchParams.delete('requires');
            window.history.replaceState(null, '', url);
        }

        async function renderComparisonTable() {
            const group = state.comparisonGroups.find((item) => item.ticker === els.comparisonUnderlying.value)
                || state.comparisonGroups[0];
            if (!group) return;
            // A changed underlying must finish loading before a watch can be saved for it.
            if (els.saveComparison) els.saveComparison.disabled = true;
            const request = ++state.comparisonRequest;
            let bundle = null;
            if (!state.useSample) {
                bundle = state.comparisonBundles.get(group.ticker);
                if (!bundle) {
                    // Until this underlying's record arrives, nothing on screen may still describe the
                    // previous one: the heading, the counts and the wrapper checkboxes all say loading.
                    showComparisonLoading(group.ticker);
                    els.comparisonView.innerHTML = dataStateHtml('loading', `Loading ${group.ticker} research`, 'Reading only this underlying’s decision record.');
                    bundle = await fetchJson(`./comparisons/${comparisonBundleFilename(group.ticker)}`);
                    if (request !== state.comparisonRequest) return;
                    if (!comparisonBundleMatches(bundle, group, state.builtAt)) {
                        document.getElementById('comparisonHeading').textContent = `${group.ticker} · research unavailable`;
                        document.getElementById('comparisonSelectionSummary').textContent = '';
                        els.comparisonView.innerHTML = dataStateHtml('failed', 'This decision record is unavailable', 'The research for this stock could not be loaded or does not match the current catalogue, so its wrappers and risks are unknown here.', [{ label: 'Retry', action: 'retry-comparison' }]);
                        return;
                    }
                    state.comparisonBundles.set(group.ticker, bundle);
                }
            }
            const allModels = bundle?.models ?? sameStockComparisonModels(group, state.issuersBySlug, state.defiUsageByMint, state.composability);
            if (state.comparisonTicker !== group.ticker) {
                state.comparisonTicker = group.ticker;
                // Any cardinality is valid. All wrappers start selected, and the URL can name
                // an explicit subset (including none) without silently selecting a pair.
                const params = new URL(window.location.href).searchParams;
                const selected = params.has('wrappers') ? params.get('wrappers').split(',') : allModels.map((model) => model.issuerSlug);
                state.comparisonSelected = new Set(selected.filter((slug) => allModels.some((model) => model.issuerSlug === slug)));
            }
            state.comparisonModels = allModels;
            document.getElementById('comparisonHeading').textContent = `${group.ticker} · ${allModels.length === 1 ? 'understand the token' : 'compare wrappers'}`;
            if (els.comparisonProducts) {
                els.comparisonProducts.innerHTML = allModels.map((model) =>
                    `<label><input type="checkbox" value="${escapeHtml(model.issuerSlug)}" ${state.comparisonSelected.has(model.issuerSlug) ? 'checked' : ''}>` +
                    `<span><strong>${escapeHtml(model.issuerName)}</strong><small>${model.tokens.length} token${model.tokens.length === 1 ? '' : 's'} · ${escapeHtml(fmtMoney(model.liquidityUsd))} liquidity</small></span></label>`
                ).join('');
            }
            if (els.comparisonFilters) {
                els.comparisonFilters.querySelectorAll('input[type="checkbox"]').forEach((input) => {
                    input.checked = state.comparisonFilters.has(input.value);
                });
            }
            const models = filterComparisonModels(allModels, state.comparisonSelected, state.comparisonFilters);
            if (els.comparisonSelectionCount) {
                els.comparisonSelectionCount.textContent = `(${models.length} shown of ${allModels.length})`;
            }
            document.getElementById('comparisonSelectionSummary').textContent = `${models.length} of ${allModels.length} wrappers shown`;
            if (els.saveComparison) els.saveComparison.disabled = models.length === 0;
            const affected = models.filter((model) => bundle ? bundle.reviewPendingIssuers.includes(model.issuerSlug) : state.reviewP0ByIssuer.has(model.issuerSlug));
            const reviewBanner = affected.length ? `<div class="comparison-review-warning"><strong>Comparison inputs under review</strong><span>${escapeHtml(affected.map((model) => model.issuerName).join(', '))} ${affected.length === 1 ? 'has' : 'have'} priority-zero evidence changes. Marked legal conclusions are provisional.</span><a href="./review.html?priority=P0">Open review queue →</a></div>` : '';
            els.comparisonView.innerHTML = reviewBanner + (models.length >= 1
                ? sameStockComparisonHtml(group, models)
                : '<div class="comparison-empty"><strong>No wrappers selected or matching these requirements.</strong><p>Select one or more wrappers, or clear the requirements. We never add wrappers to your selection.</p></div>') +
                (models.length ? `<p class="comparison-note"><a href="./economics.html?issuers=${encodeURIComponent(models.map((model) => model.issuerSlug).join(','))}">Fees and incentives →</a> <span>Initial programme research; it does not include every cost.</span></p>` : '') +
                (models.length ? `<details class="comparison-history"><summary>${escapeHtml(group.ticker)} observed market history</summary><header><div><small>Daily measurements; gaps mean not measured. Markers are evidence or control changes.</small></div><label>Metric<select class="history-metric"></select></label></header><div class="history-chart" role="status">Open to load history.</div></details>` : '') +
                (bundle ? `<p class="comparison-note">Catalogue built ${escapeHtml(fmtDateTime(bundle.builtAt))} · DeFi collected ${escapeHtml(fmtDateTime(bundle.sources?.defiFetchedAt))}. Legal reviews have their own dates.</p>` : '');
            const history = els.comparisonView.querySelector('.comparison-history');
            history?.addEventListener('toggle', () => {
                if (history.open && !history.dataset.loaded) {
                    history.dataset.loaded = 'true';
                    loadComparisonHistory(group.ticker, new Set(models.map((model) => model.issuerSlug)));
                }
            });
            renderComparisonWatch(group, allModels);
        }

        async function loadComparisonHistory(ticker, selectedIssuers) {
            const panel = els.comparisonView.querySelector('.comparison-history');
            const charts = globalThis.__rwaHistoryCharts;
            if (!panel || !charts) return;
            const request = ++state.historyRequest;
            const select = panel.querySelector('.history-metric');
            const output = panel.querySelector('.history-chart');
            select.innerHTML = charts.optionsHtml('premium_pct');
            try {
                const url = apiLib.apiUrl(`/api/history/underlyings/${encodeURIComponent(ticker)}`, { days: 365 }, apiBase);
                const response = await fetch(url, { headers: { accept: 'application/json' } });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                if (request !== state.historyRequest || !panel.isConnected) return;
                const rows = (data.items ?? []).filter((row) => selectedIssuers.has(row.issuer));
                const draw = () => { output.innerHTML = charts.render(rows, data.events, select.value, { key: (row) => `${row.issuer} · ${row.symbol ?? row.mint.slice(0, 6)}` }); };
                select.addEventListener('change', draw); draw();
            } catch (_) {
                if (request === state.historyRequest && panel.isConnected) output.innerHTML = dataStateHtml(
                    'failed', 'History API unavailable', 'The historical series could not be loaded, so history is unknown (it is not zero or empty). Current conclusions are still shown.',
                    [{ label: 'Open health monitor', href: './monitor.html' }]
                );
            }
        }

        function readComparisonWatchlist() {
            try {
                const value = JSON.parse(window.localStorage.getItem('rwa-sonar-comparisons-v1') || '{}');
                return value && typeof value === 'object' ? value : {};
            } catch (_) {
                return {};
            }
        }

        function readSavedItems() {
            try {
                return normalizeSavedItems(JSON.parse(window.localStorage.getItem('rwa-sonar-saved-items-v1') || '{}'));
            } catch (_) {
                return normalizeSavedItems(null);
            }
        }

        function writeSavedItems() {
            try {
                window.localStorage.setItem('rwa-sonar-saved-items-v1', JSON.stringify(state.savedItems));
                return true;
            } catch (_) {
                return false;
            }
        }

        function readJournalVisit() {
            try {
                const value = JSON.parse(window.localStorage.getItem('rwa-sonar:journal-visit') || 'null');
                return value && Array.isArray(value.identities) ? value : null;
            } catch (_) {
                return null;
            }
        }

        function writeJournalVisit(summary) {
            if (!summary) return;
            try {
                window.localStorage.setItem('rwa-sonar:journal-visit', JSON.stringify({
                    visitedAt: new Date().toISOString(), identities: summary.currentIdentities.slice(0, 1000)
                }));
            } catch (_) {
                // Local storage is an enhancement. The public catalogue remains fully usable without it.
            }
        }

        function renderPersonalHome() {
            if (!els.personalHome || !state.tokensLoaded) return;
            const allGroups = underlyingGroups(state.tokens);
            const groupsByTicker = new Map(allGroups.map((group) => [group.ticker, group]));
            const stocks = state.savedItems.tickers.map((ticker) => groupsByTicker.get(ticker)).filter(Boolean);
            const issuers = state.savedItems.issuers.map((slug) => state.issuersBySlug.get(slug)).filter(Boolean);
            const watches = readComparisonWatchlist();
            const serverWatches = readServerWatchCredentials();
            const comparisons = Object.entries(watches).map(([ticker, saved]) => {
                const group = state.comparisonGroups.find((entry) => entry.ticker === ticker);
                if (!group) return { ticker, changes: [], missing: true, crossDevice: Boolean(serverWatches[ticker]) };
                if (!state.fullCatalogueLoaded) {
                    return { ticker, changes: [], missing: false, pending: true,
                        crossDevice: Boolean(serverWatches[ticker]) };
                }
                const models = sameStockComparisonModels(group, state.issuersBySlug, state.defiUsageByMint, state.composability);
                const selected = new Set(Array.isArray(saved?.selected) ? saved.selected : []);
                const current = comparisonSnapshot(ticker, models.filter((model) => selected.has(model.issuerSlug)));
                return { ticker, changes: comparisonSnapshotChanges(saved?.snapshot, current), missing: false,
                    crossDevice: Boolean(serverWatches[ticker]) };
            }).sort((a, b) => b.changes.length - a.changes.length || a.ticker.localeCompare(b.ticker));

            const visit = state.journalVisit ?? personalJournalSummary([], null);
            const unseenRows = visit.unseen.slice(0, 3).map((row) => {
                const href = isSafeUrl(row.href) ? row.href : './watch.html';
                return `<li><a href="${escapeHtml(href)}">${escapeHtml(row.title || 'Recorded external change')}</a>` +
                    `<small>${escapeHtml(row.date || 'date unavailable')} · ${escapeHtml(humanizeSlug(row.kind || 'change'))}</small></li>`;
            });
            const visitHeading = visit.firstVisit ? 'Your change baseline starts now.'
                : visit.unseen.length ? `${fmtNumber(visit.unseen.length)} public change${visit.unseen.length === 1 ? '' : 's'} since your last visit.`
                    : 'You are caught up.';
            const visitDetail = visit.firstVisit
                ? 'Return later and this browser will identify new issuer, venue, protocol and catalogue changes.'
                : visit.unseen.length ? `Last baseline ${fmtRelativeTime(visit.previousVisitedAt)}. The newest changes are listed below.`
                    : `No new external changes since ${fmtRelativeTime(visit.previousVisitedAt)}.`;
            els.personalVisit.innerHTML = `<strong>${escapeHtml(visitHeading)}</strong><span>${escapeHtml(visitDetail)}</span>` +
                (unseenRows.length ? `<ul class="personal-list">${unseenRows.join('')}</ul>` : '');

            els.personalStocks.innerHTML = personalListHtml(stocks.map((group) => {
                const href = group.issuerCount > 1 ? `./stocks.html?view=compare&compare=${encodeURIComponent(group.ticker)}`
                    : `./cards/${encodeURIComponent(group.tokens[0]?.cardSlug || cardSlug(group.tokens[0]?.symbol, group.tokens[0]?.mint))}.html`;
                return `<li><a href="${escapeHtml(href)}">${escapeHtml(group.ticker)} · ${escapeHtml(group.name)}</a>` +
                    `<button type="button" data-save-ticker="${escapeHtml(group.ticker)}">Remove</button>` +
                    `<small>${group.issuerCount} wrapper${group.issuerCount === 1 ? '' : 's'} · ${group.tokenCount} exact token${group.tokenCount === 1 ? '' : 's'}</small></li>`;
            }), 'Use “Save stock” in the stock browser to keep important underlyings here.');
            els.personalIssuers.innerHTML = personalListHtml(issuers.map((issuer) =>
                `<li><a href="${escapeHtml(issuerDossierHref(issuer.slug))}">${escapeHtml(issuer.name)}</a>` +
                `<button type="button" data-save-issuer="${escapeHtml(issuer.slug)}">Remove</button>` +
                `<small>${escapeHtml(issuer.legalForm ? humanizeSlug(issuer.legalForm) : 'Legal form not established')}</small></li>`),
            'Use “Save issuer” on an issuer card to keep its programme here.');
            els.personalComparisons.innerHTML = personalListHtml(comparisons.slice(0, 6).map((row) =>
                `<li><a href="./stocks.html?view=compare&amp;compare=${encodeURIComponent(row.ticker)}">${escapeHtml(row.ticker)} comparison</a>` +
                `<small>${row.missing ? 'Not found in the current catalogue' : row.pending ? 'Open to refresh this saved comparison' : row.changes.length ? `${row.changes.length} material change${row.changes.length === 1 ? '' : 's'} since saved` : 'No material difference from the saved baseline'}${row.crossDevice ? ' · daily cross-device watch active' : ' · browser-only baseline'}</small></li>`),
            'Save a same-stock comparison to watch its legal, market and DeFi conclusions.');

            const additionRows = visit.newAssets.slice(0, 4).map((row) => {
                const href = isSafeUrl(row.href) ? row.href : './watch.html';
                const count = Array.isArray(row.assets) ? row.assets.length : 0;
                return `<li><a href="${escapeHtml(href)}">${escapeHtml(row.title || 'Assets added')}</a><small>${escapeHtml(row.date || 'date unavailable')} · ${fmtNumber(count)} exact token${count === 1 ? '' : 's'}</small></li>`;
            });
            els.personalNewAssets.innerHTML = personalListHtml(additionRows, 'No catalogue additions are recorded in the current public journal.');
            const protocolRows = visit.protocolChanges.slice(0, 4).map((row) => {
                const href = isSafeUrl(row.href) ? row.href : './watch.html';
                return `<li><a href="${escapeHtml(href)}">${escapeHtml(row.title || 'Protocol support changed')}</a><small>${escapeHtml(row.date || 'date unavailable')} · ${escapeHtml(humanizeSlug(row.kind || 'protocol change'))}</small></li>`;
            });
            els.personalProtocolChanges.innerHTML = personalListHtml(protocolRows,
                'No source-listed protocol-support change is recorded in the current public journal.');

            els.personalStockCount.textContent = fmtNumber(stocks.length);
            els.personalIssuerCount.textContent = fmtNumber(issuers.length);
            els.personalComparisonCount.textContent = fmtNumber(comparisons.length);
            els.personalHome.hidden = false;
        }

        function togglePersonalItem(kind, id) {
            state.savedItems = toggleSavedItem(state.savedItems, kind, id);
            writeSavedItems();
            renderUnderlyingDirectory();
            renderIssuerCards(state.issuers);
            renderPersonalHome();
        }

        function readServerWatchCredentials() {
            try {
                const value = JSON.parse(window.localStorage.getItem('rwa-sonar-server-watches-v1') || '{}');
                return value && typeof value === 'object' ? value : {};
            } catch (_) {
                return {};
            }
        }

        function storeServerWatchCredential(ticker, credential) {
            const saved = readServerWatchCredentials();
            saved[ticker] = credential;
            window.localStorage.setItem('rwa-sonar-server-watches-v1', JSON.stringify(saved));
        }

        function sharedWatchUrl(watchId, readKey, ticker) {
            const url = new URL(window.location.href);
            url.searchParams.set('compare', ticker);
            url.hash = `watch=${watchId}.${readKey}`;
            return url.toString();
        }

        function showShareLink(watchId, readKey, ticker) {
            if (!els.shareComparison) return;
            els.shareComparison.hidden = !readKey;
            if (readKey) els.shareComparison.href = sharedWatchUrl(watchId, readKey, ticker);
        }

        async function watchApi(method, path, watchKey = null, body = null) {
            if (!apiLib) throw new Error('API URL helper unavailable');
            const headers = { Accept: 'application/json' };
            if (watchKey) headers['X-Watch-Key'] = watchKey;
            if (body !== null) headers['Content-Type'] = 'application/json';
            const res = await fetch(apiLib.apiUrl(`/api${path}`, {}, apiBase), {
                method, headers, body: body === null ? undefined : JSON.stringify(body), cache: 'no-store'
            });
            const payload = res.status === 204 ? null : await res.json().catch(() => null);
            if (!res.ok) {
                const error = new Error(payload?.error?.message || `watch API returned HTTP ${res.status}`);
                error.status = res.status;
                throw error;
            }
            return payload;
        }

        function applyServerWatch(watch, credential = {}) {
            if (!watch || !state.comparisonGroups.some((group) => group.ticker === watch.ticker)) return false;
            els.comparisonUnderlying.value = watch.ticker;
            state.comparisonTicker = watch.ticker;
            state.comparisonSelected = new Set(watch.issuers ?? []);
            state.comparisonFilters = new Set(watch.filters ?? []);
            state.serverWatch = { ...watch, ...credential };
            if (watch.access === 'owner' && credential.watchKey) {
                storeServerWatchCredential(watch.ticker, {
                    watchId: watch.watchId,
                    watchKey: credential.watchKey,
                    readKey: credential.readKey ?? null
                });
            }
            showShareLink(watch.watchId, credential.readKey, watch.ticker);
            writeComparisonRequirements();
            renderComparisonTable();
            return true;
        }

        async function restoreSharedWatchFromHash() {
            const match = window.location.hash.match(/^#watch=([0-9a-f-]{36})\.([A-Za-z0-9_-]{24,80})$/i);
            if (!match) return;
            try {
                const watch = await watchApi('GET', `/watchlists/${match[1]}`, match[2]);
                if (!applyServerWatch(watch, { readKey: match[2] })) throw new Error('the watched ticker is not in the current catalogue');
                els.comparisonWatchStatus.textContent = watch.changes?.length
                    ? `${watch.changes.length} material change${watch.changes.length === 1 ? '' : 's'} in the latest daily check.`
                        : watch.baselineRecorded ? 'Read-only shared watch · no material change in the latest daily check.'
                            : 'Read-only shared watch · its first daily baseline is pending.';
            } catch (err) {
                els.comparisonWatchStatus.className = 'watch-changed';
                els.comparisonWatchStatus.textContent = `Could not open the shared watch: ${err.message}`;
            }
        }

        function renderComparisonWatch(group, allModels) {
            if (!els.comparisonWatchStatus) return;
            if (state.serverWatch?.ticker === group.ticker) {
                const changes = state.serverWatch.changes ?? [];
                els.comparisonWatchStatus.className = changes.length ? 'watch-changed' : 'watch-current';
                els.comparisonWatchStatus.textContent = changes.length
                    ? `${changes.length} material change${changes.length === 1 ? '' : 's'} in the latest daily server check.`
                    : state.serverWatch.baselineRecorded ? 'Server watch active · no material change in the latest daily check.'
                        : 'Server watch active · its first daily baseline is pending.';
                return;
            }
            if (els.shareComparison) els.shareComparison.hidden = true;
            const saved = readComparisonWatchlist()[group.ticker];
            if (!saved) {
                els.comparisonWatchStatus.textContent = 'Not saved in this browser.';
                els.comparisonWatchStatus.className = '';
                return;
            }
            const selected = new Set(Array.isArray(saved.selected) ? saved.selected : []);
            const current = comparisonSnapshot(group.ticker, allModels.filter((model) => selected.has(model.issuerSlug)));
            const changes = comparisonSnapshotChanges(saved.snapshot, current);
            els.comparisonWatchStatus.className = changes.length ? 'watch-changed' : 'watch-current';
            els.comparisonWatchStatus.textContent = changes.length
                ? `${changes.length} material change${changes.length === 1 ? '' : 's'} since saved: ${changes.slice(0, 3).join('; ')}`
                : `Saved ${fmtRelativeTime(saved.snapshot?.savedAt)} · no material change detected.`;
        }

        async function saveCurrentComparison() {
            const ticker = state.comparisonTicker;
            if (!ticker || ticker !== els.comparisonUnderlying.value || els.saveComparison?.disabled || state.comparisonSelected.size < 1) return;
            const watchlist = readComparisonWatchlist();
            const selectedModels = state.comparisonModels.filter((model) => state.comparisonSelected.has(model.issuerSlug));
            watchlist[ticker] = {
                selected: [...state.comparisonSelected],
                snapshot: comparisonSnapshot(ticker, selectedModels)
            };
            try {
                window.localStorage.setItem('rwa-sonar-comparisons-v1', JSON.stringify(watchlist));
                renderComparisonWatch({ ticker }, state.comparisonModels);
                renderPersonalHome();
            } catch (_) {
                els.comparisonWatchStatus.textContent = 'This browser blocked local saving.';
            }
            const body = {
                ticker,
                issuers: [...state.comparisonSelected],
                filters: [...state.comparisonFilters],
                title: `${ticker} comparison`
            };
            const existing = readServerWatchCredentials()[ticker];
            els.saveComparison.disabled = true;
            els.comparisonWatchStatus.textContent = 'Saving the cross-device watch…';
            try {
                let watch;
                let watchKey;
                let readKey = existing?.readKey ?? null;
                if (existing?.watchId && existing?.watchKey) {
                    try {
                        watch = await watchApi('PUT', `/watchlists/${existing.watchId}`, existing.watchKey, body);
                        watchKey = existing.watchKey;
                    } catch (err) {
                        if (err.status !== 404) throw err;
                        watch = await watchApi('POST', '/watchlists', null, body);
                        watchKey = watch.watchKey;
                        readKey = watch.readKey;
                    }
                } else {
                    watch = await watchApi('POST', '/watchlists', null, body);
                    watchKey = watch.watchKey;
                    readKey = watch.readKey;
                }
                if (!readKey) {
                    const share = await watchApi('POST', `/watchlists/${watch.watchId}/share`, watchKey);
                    readKey = share.readKey;
                }
                applyServerWatch(watch, { watchKey, readKey });
                els.comparisonWatchStatus.textContent = watch.baselineRecorded
                    ? 'Saved on the server · checked daily for material changes.'
                    : 'Saved on the server · the next daily check will record its baseline.';
            } catch (err) {
                els.comparisonWatchStatus.className = 'watch-changed';
                els.comparisonWatchStatus.textContent = `Saved in this browser only; server watch failed: ${err.message}`;
            } finally {
                els.saveComparison.disabled = false;
            }
        }

        async function fetchJson(path) {
            try {
                const res = await fetch(path, { cache: 'no-store' });
                if (!res.ok) return null;
                return await res.json();
            } catch (err) {
                return null;
            }
        }

        /**
         * The "New on Solana" strip. Nothing to show — no file, no feed, no rows — leaves it hidden
         * and says nothing: it is a bonus on this page, not a fact it owes the reader.
         */
        function renderNewMints(changes) {
            if (!els.newMints || !els.newMintsTrack || !els.newMintsClone) return;
            const chips = newMintChips(changes, Date.now());
            if (chips.length === 0) {
                els.newMints.hidden = true;
                return;
            }
            els.newMintsTrack.innerHTML = chips.slice(0, 8).map(newMintChipHtml).join('');
            els.newMintsClone.innerHTML = chips.map(newMintChipHtml).join('');
            if (els.newMintsWindow) els.newMintsWindow.textContent = String(newMintsWindowDays(changes));
            els.newMints.hidden = false;
        }

        // --- the funnel ----------------------------------------------------

        /**
         * Nothing to draw — no funnel file, or a funnel with no nodes — hides the section instead of
         * heading an empty box with a number nobody measured. The heading itself is written from the
         * funnel's totals, never hard-coded.
         */
        function renderFunnel(funnel) {
            if (!els.funnelSection || !els.funnelGraphic) return;
            const title = funnelTitle(funnel);
            const layout = funnelLayout(funnel, {});
            if (title === null || layout.nodes.length === 0) {
                els.funnelSection.hidden = true;
                return;
            }
            if (els.funnelHeading) els.funnelHeading.textContent = title;
            els.funnelGraphic.innerHTML = funnelSvg(layout);
            els.funnelSection.hidden = false;
        }

        // --- the grid ------------------------------------------------------

        function renderGrid(issuers) {
            const labels = claimAxisLabels(issuers);
            const parts = [];

            // The row and column labels carry the ladder definition itself: role="img" plus
            // aria-label so a screen reader reads the definition rather than the bare "Level 2",
            // and the same string in title for a hover.
            for (let stage = GRID_STAGES - 1; stage >= 0; stage--) {
                const tip = escapeHtml(maturityLevelTooltip(stage));
                parts.push(
                    `<div class="grid-axis grid-axis-y" style="grid-column:1;grid-row:${GRID_STAGES - stage}">` +
                    `<span class="maturity-pill level-${stage}" role="img" title="${tip}" aria-label="${tip}">` +
                    `Level ${stage}</span></div>`
                );
            }

            for (let rung = 0; rung < GRID_RUNGS; rung++) {
                const tip = escapeHtml(claimRungTooltip(rung));
                parts.push(
                    `<div class="grid-axis grid-axis-x" style="grid-column:${rung + GRID_FIRST_DATA_COLUMN};grid-row:${GRID_LABEL_ROW}" ` +
                    `role="img" title="${tip}" aria-label="${tip}">` +
                    `<span class="grid-axis-rung">${rung}</span> ${escapeHtml(labels[rung])}</div>`
                );
            }

            const placed = new Map();
            const unplaced = [];
            for (const issuer of issuers) {
                if (issuer.status !== 'live') continue;
                const grades = issuer.grades || {};
                const cell = gridCell(grades.claimRung, grades.maturityStageNum);
                if (!cell) {
                    unplaced.push(issuer);
                    continue;
                }
                const key = `${cell.column}:${cell.row}`;
                if (!placed.has(key)) placed.set(key, { cell, issuers: [] });
                placed.get(key).issuers.push(issuer);
            }

            for (let rung = 0; rung < GRID_RUNGS; rung++) {
                for (let stage = GRID_STAGES - 1; stage >= 0; stage--) {
                    const cell = gridCell(rung, stage);
                    const key = `${cell.column}:${cell.row}`;
                    const bucket = placed.get(key);
                    const chips = bucket ? bucket.issuers.map(chipHtml).join('') : '';
                    parts.push(
                        `<div class="grid-cell${bucket ? ' grid-cell-filled' : ''}" ` +
                        `style="grid-column:${cell.column};grid-row:${cell.row}" ` +
                        `title="Claim depth ${rung} · Ledger maturity Level ${stage}">${chips}</div>`
                    );
                }
            }

            els.grid.innerHTML = parts.join('');
            renderGridLegend(issuers.filter((issuer) => issuer.status !== 'live'), unplaced);
        }

        function chipHtml(issuer) {
            const liquidity = issuer.market ? issuer.market.dexLiquidityUsd : null;
            const size = chipSize(liquidity);
            const tip = `${issuer.name} · DEX liquidity ${fmtMoney(liquidity)} · ` +
                `${fmtNumber(issuer.market && issuer.market.tokens)} tokens`;
            return `<button type="button" class="grid-chip" data-slug="${escapeHtml(issuer.slug)}" ` +
                `title="${escapeHtml(tip)}">` +
                `<span class="grid-chip-dot" style="width:${size}px;height:${size}px"></span>` +
                `<span class="grid-chip-name">${escapeHtml(displayName(issuer.name, 28))}</span></button>`;
        }

        function renderGridLegend(offGrid, unplaced) {
            const items = [];
            for (const issuer of unplaced) {
                items.push(
                    `<button type="button" class="legend-chip" data-slug="${escapeHtml(issuer.slug)}" ` +
                    `title="${escapeHtml(issuer.name)} · claim depth could not be established from the documents">` +
                    `${escapeHtml(displayName(issuer.name, 32))} <span class="legend-note">claim depth unknown</span></button>`
                );
            }
            for (const issuer of offGrid) {
                items.push(
                    `<button type="button" class="legend-chip legend-chip-defunct" data-slug="${escapeHtml(issuer.slug)}" ` +
                    `title="${escapeHtml(issuer.name)} — ${escapeHtml(issuer.status)}, excluded from the grid and from every headline total">` +
                    `${escapeHtml(displayName(issuer.name, 32))} <span class="legend-note">${escapeHtml(issuer.status)}</span></button>`
                );
            }
            els.gridLegend.innerHTML = items.length
                ? `<span class="legend-label">Off the grid:</span> ${items.join('')}`
                : '';
        }

        // --- trading activity ----------------------------------------------

        /**
         * One row per live programme (MODEL §11.3). Defunct issuers are not in `activityRows` at
         * all, and a field the build has not produced renders as a dash — so the shape of the
         * table is honest about what is missing instead of printing a zero.
         */
        function renderActivityTable() {
            if (!els.activityTableBody) return;
            const rows = activityRows(state.issuers);
            const getValue = ACTIVITY_SORT_KEYS[state.activitySort.key];
            if (getValue) rows.sort(makeComparator(getValue, state.activitySort.ascending));

            renderActivitySortIndicators();
            els.activityTableBody.innerHTML = rows.length
                ? rows.map(activityRowHtml).join('')
                : '<tr><td class="token-table-message" colspan="10">No live programmes to report on.</td></tr>';

            // A build from before §11.2/§11.3 has no activity object at all; say so once rather
            // than leaving a table of dashes looking like a rendering fault.
            if (els.activityHint) {
                const anyActivity = state.issuers.some((issuer) => issuer && issuer.status === 'live' && issuer.activity);
                els.activityHint.hidden = anyActivity;
            }
        }

        function activityRowHtml(row) {
            const flagged = row.flags.length > 0;
            const badges = row.flags
                .map((flag) => `<span class="act-badge act-badge-${escapeHtml(flag.code)}" ` +
                    `title="${escapeHtml(flag.detail)}" aria-label="${escapeHtml(flag.label + ': ' + flag.detail)}">` +
                    `<span aria-hidden="true">${escapeHtml(flag.glyph)}</span> ${escapeHtml(flag.label)}</span>`)
                .join('');
            const venueTip = row.venuesTop.length
                ? row.venuesTop
                    .map((venue) => `${venue && venue.name ? venue.name : DASH} (${venue && venue.kind ? venue.kind : '?'}, ${fmtMoney(venue && venue.volume24Usd)} 24h)`)
                    .join(' · ')
                : MARKET_TOOLTIPS.venues;

            return `<tr${flagged ? ' class="activity-flagged"' : ''}>` +
                `<td class="cell-issuer"><a class="issuer-link" href="${escapeHtml(issuerDossierHref(row.slug))}" ` +
                `title="${escapeHtml(row.name)} — open the dossier">${escapeHtml(displayName(row.name, 30))}</a></td>` +
                `<td class="num" title="Tokens with at least one trade in 24h, out of the programme’s token addresses">` +
                `${escapeHtml(fmtCountOfTotal(row.tokensTraded24, row.tokens))}</td>` +
                `<td class="num">${escapeHtml(fmtNumber(row.trades24))}</td>` +
                `<td class="num">${escapeHtml(fmtNumber(row.traders24))}</td>` +
                `<td class="num">${escapeHtml(fmtTradesPerTrader(row.tradesPerTrader))}</td>` +
                `<td class="num">${escapeHtml(fmtPct(row.organicSharePct))}</td>` +
                `<td class="num" title="${escapeHtml(venueTip)}">${escapeHtml(fmtNumber(row.venueCount))}</td>` +
                `<td class="num" title="${escapeHtml(MARKET_TOOLTIPS.venueSpread)}">${escapeHtml(fmtVenueSpreadPct(row.venueSpreadMedianPct))}</td>` +
                `<td title="${escapeHtml(row.lastTradedAt ? row.lastTradedAt + (row.lastTradedVenue ? ' · ' + row.lastTradedVenue : '') : MARKET_TOOLTIPS.lastTrade)}">` +
                `${escapeHtml(fmtRelativeTime(row.lastTradedAt))}</td>` +
                `<td class="cell-act-flags">${badges}</td>` +
                '</tr>';
        }

        function renderActivitySortIndicators() {
            if (!els.activityTableHead) return;
            els.activityTableHead.querySelectorAll('th[data-sort]').forEach((th) => {
                const isActive = th.getAttribute('data-sort') === state.activitySort.key;
                th.classList.toggle('sort-active', isActive);
                th.setAttribute('aria-sort', isActive ? (state.activitySort.ascending ? 'ascending' : 'descending') : 'none');
                const indicator = th.querySelector('.sort-indicator');
                if (indicator) indicator.textContent = isActive ? (state.activitySort.ascending ? ' ↑' : ' ↓') : '';
            });
        }

        // --- issuer cards --------------------------------------------------

        function renderIssuerCards(issuers) {
            const ordered = sortIssuersForDisplay(issuers);
            els.issuerCards.innerHTML = ordered.map(issuerCardHtml).join('');
            const headline = issuerHeadline(issuers, state.tokensLoaded ? state.tokens : null);
            els.issuerCount.textContent = headline.count;
            if (els.issuerQualifier) {
                els.issuerQualifier.textContent = headline.qualifier;
                els.issuerQualifier.hidden = headline.qualifier === '';
            }
            if (els.largestProgramme) els.largestProgramme.textContent = headline.largest;
        }

        function issuerCardHtml(issuer) {
            const grades = issuer.grades || {};
            const market = issuer.market || {};
            const control = issuer.control || {};
            const findings = Array.isArray(issuer.findings) ? issuer.findings : [];
            const attestations = Array.isArray(issuer.attestations) ? issuer.attestations : [];
            const defunct = issuer.status !== 'live';
            const stage = Number.isInteger(grades.maturityStageNum) ? grades.maturityStageNum : null;
            const worst = worstSeverity(findings);
            const verdict = laypersonVerdict({
                claimRung: grades.claimRung,
                redemptionAvailable: issuer.redemption && issuer.redemption.available,
                control
            });
            const review = legalReviewStatus(issuer);
            const issuerSaved = state.savedItems.issuers.includes(issuer.slug);
            const p0Review = state.reviewP0ByIssuer.get(issuer.slug) ?? [];
            const issuerTokens = state.tokens.filter((token) => token.issuer === issuer.slug);
            const issuerIntegrations = issuerTokens.flatMap((token) => state.defiUsageByMint.get(token.mint)?.integrations ?? []);
            const hasCollateral = issuerIntegrations.some((entry) => entry?.category === 'lending'
                && Array.isArray(entry.actions) && entry.actions.includes('collateral'));
            const controlValues = [control.freezeAuthority, control.pausable, control.clawback];
            const hasOverride = controlValues.some(isControlOn);
            const controlsKnownOff = controlValues.every(controlExplicitlyOff);
            const health = [
                ['Market', isNum(market.dexLiquidityUsd) ? market.dexLiquidityUsd >= 50_000 ? 'healthy' : market.dexLiquidityUsd > 0 ? 'thin' : 'no depth' : 'unknown', market.dexLiquidityUsd >= 50_000 ? 'good' : isNum(market.dexLiquidityUsd) ? 'caution' : 'unknown'],
                ['Control', hasOverride ? 'issuer powers' : controlsKnownOff ? 'no override found' : 'not established', hasOverride ? 'caution' : controlsKnownOff ? 'good' : 'unknown'],
                ['Legal', p0Review.length ? 'under review' : review.pending ? 'review pending' : 'reviewed', p0Review.length || review.pending ? 'caution' : 'good'],
                ['DeFi', hasCollateral ? 'collateral listed' : issuerIntegrations.length ? 'other listed use' : 'none source-listed', hasCollateral ? 'good' : 'unknown']
            ];
            const healthHtml = health.map(([label, value, status]) =>
                `<span class="issuer-health issuer-health-${status}"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`).join('');

            const controlBadges = [
                badge('Clawback', coverageLabel(control.clawback), coverageClass(control.clawback),
                    'A permanent delegate can move the token out of any wallet without the holder'),
                badge('Freeze', coverageLabel(control.freezeAuthority), coverageClass(control.freezeAuthority),
                    'A live freeze authority can freeze any account'),
                badge('Pause', coverageLabel(control.pausable), coverageClass(control.pausable),
                    'The whole token can be paused'),
                badge('Allowlist', coverageLabel(control.allowlist), coverageClass(control.allowlist),
                    'New accounts start frozen; a holder must be onboarded before receiving'),
                badge('Fee', fmtFeeBps(control.transferFeeBps), 'cov-neutral',
                    'Transfer-fee extension values configured on the tokens (0 bps still reserves the right to charge)'),
                badge('Hook', coverageLabel(control.hookActive), coverageClass(control.hookActive),
                    'A transfer-hook program is installed and runs on every transfer'),
                badge('Keys', keyGovernanceSummary(control.keyGovernance || issuer.keyGovernance), 'cov-neutral',
                    'How the mint, freeze, delegate and rebase authorities are held: multisig, program, or a plain hot wallet'),
                badge('Freeze used', freezeExercisedLabel(control.freezeExercised), freezeExercisedClass(control.freezeExercised),
                    'Whether the freeze authority has been exercised. "Unknown" is never "no".')
            ].join('');

            const metrics = [
                metric('Tokens', fmtNumber(market.tokens)),
                metric('DEX liquidity', fmtMoney(market.dexLiquidityUsd)),
                metric('Volume 24h', fmtMoney(market.vol24Usd)),
                metric('Organic', fmtPct(market.organicSharePct)),
                metric('Holders', fmtNumber(market.holdersSum)),
                metric('Median top-10', fmtPct(market.medianTop10Pct)),
                metric('Median premium', fmtSignedPct(market.premiumMedianPct),
                    `over ${fmtNumber(market.premiumSampleSize)} tokens above $50k liquidity`)
            ].join('');

            return `<article class="issuer-card${defunct ? ' issuer-card-defunct' : ''}" id="issuer-${escapeHtml(issuer.slug)}">
    <header class="issuer-card-head">
        <h3 class="issuer-name" title="${escapeHtml(issuer.name)}"><a href="${escapeHtml(issuerDossierHref(issuer.slug))}">${escapeHtml(displayName(issuer.name, 52))}</a></h3>
        ${defunct ? `<span class="status-chip">${escapeHtml(issuer.status)}</span>` : ''}
        <span class="legal-form">${escapeHtml(issuer.legalForm || 'unknown')}</span>
    </header>
    <div class="lay-verdict issuer-card-verdict">
        <span><small>What do you own?</small><strong>${escapeHtml(verdict.ownership)}</strong></span>
    </div>
    ${conceptHelpHtml('ownership')}
    ${provenanceHtml(issuer, { compact: true })}
    <div class="issuer-health-row" aria-label="Issuer health by dimension">${healthHtml}</div>
    ${discrepancyCalloutHtml(issuer)}
    ${p0Review.length ? `<p class="review-status review-p0"><strong>Under review:</strong> ${p0Review.length} priority-zero evidence change${p0Review.length === 1 ? '' : 's'} may affect these conclusions. <a href="./review.html?priority=P0&issuer=${encodeURIComponent(issuer.slug)}">Inspect them →</a></p>` : ''}
    <details class="issuer-card-more">
        <summary>Claim, evidence, controls and metrics</summary>
    <div class="lay-verdict lay-verdict-more">
        <span><small>Who must cooperate?</small>${escapeHtml(verdict.cooperation)}</span>
        <span><small>Primary structural dependency</small>${escapeHtml(verdict.mainFailure)}</span>
    </div>
    <p class="review-status ${review.pending ? 'review-pending' : 'review-complete'}" title="${escapeHtml(review.detail)}">${escapeHtml(review.label)} · ${escapeHtml(review.detail)}</p>
    <div class="grade-row">
        <span class="maturity-pill level-${stage === null ? 0 : stage}">${escapeHtml(grades.maturityStage || (stage === null ? DASH : 'Level ' + stage))}</span>
        <span class="grade-score" title="Sum over the ten site booleans: +1 yes, -1 no">score ${isNum(grades.maturityScore) ? (grades.maturityScore > 0 ? '+' : '') + grades.maturityScore : DASH}</span>
        <span class="claim-rung" title="What the holder legally owns (claim depth 0-4)">rung ${Number.isInteger(grades.claimRung) ? grades.claimRung : DASH} · ${escapeHtml(claimLabel(grades.claimRung, grades.claimLabel))}</span>
    </div>
    <p class="claim-rung-explainer"><strong>Why this rung?</strong> ${escapeHtml(claimRungTooltip(grades.claimRung) || 'The available evidence does not establish where this claim belongs on the ownership ladder.')}</p>
    ${conceptGuideRowHtml(['claim', 'control', 'insolvency', 'redemption', 'defi'])}
    <div class="verification-row">
        ${verificationBarHtml(grades.verificationStrength)}
        <span class="verification-label">${escapeHtml(verificationLabel(grades.verificationStrength, grades.verificationLabel))}</span>
        ${grades.machineReadableVerification ? '<span class="tag-machine" title="The verification is published in a machine-readable form">machine-readable</span>' : ''}
    </div>
    <div class="badge-row">${controlBadges}</div>
    <dl class="metric-grid">${metrics}</dl>
    </details>
    <footer class="issuer-card-foot">
        <span class="count-chip" title="Positive statements by a named attestor">${attestations.length} attestation${attestations.length === 1 ? '' : 's'}</span>
        <span class="count-chip ${worst ? severityClass(worst) : 'sev-none'}" title="Observed facts, negative or neutral, recorded by rwa-sonar">${findings.length} finding${findings.length === 1 ? '' : 's'}${worst ? ' · worst: ' + escapeHtml(worst) : ''}</span>
        <button type="button" class="save-item" data-save-issuer="${escapeHtml(issuer.slug)}" aria-pressed="${issuerSaved ? 'true' : 'false'}">${issuerSaved ? 'Saved issuer' : 'Save issuer'}</button>
        <a class="detail-button" href="${escapeHtml(issuerDossierHref(issuer.slug))}">Open dossier</a>
    </footer>
</article>`;
        }

        // --- detail dialog -------------------------------------------------

        function openDetail(slug, { writeUrl = true } = {}) {
            const issuer = state.issuersBySlug.get(slug);
            if (!issuer) return;
            if (writeUrl) {
                const url = new URL(window.location.href);
                url.searchParams.set('issuer', slug);
                window.history.pushState(null, '', url);
            }
            state.openIssuerSlug = slug;
            els.detailTitle.textContent = issuer.name;
            els.detailBody.innerHTML = detailHtml(issuer);
            showDetail();
            loadWhatIf(slug);
            // Schematics (redemption, creation, who is involved) come from stocks-schematics.json via
            // schematics-hook.js, which fills the #schematicBody placeholder detailHtml wrote.
            if (typeof __rwaSchematicHook !== 'undefined') __rwaSchematicHook.fill(els.detailBody);
        }

        /**
         * The what-if answers for the open panel. They are the one thing on this panel that is NOT
         * in stocks-issuers.json — 38 answers with their quotes, case citations and search records
         * are prose, and inlining them for twelve issuers would multiply the built file — so they
         * come from /api/issuers/:slug/what-if and are cached per slug for the session.
         *
         * A failure is written into the section in words. It must never look like "this issuer has
         * no answers": the API being unreachable and a researched gap are different findings.
         */
        async function loadWhatIf(slug) {
            const known = state.whatIfBySlug.get(slug);
            if (known !== undefined) {
                fillWhatIf(slug, known);
                return;
            }
            if (apiLib === null) {
                const failure = 'stocks/lib/api-base.js did not load, so this page cannot find the API';
                state.whatIfBySlug.set(slug, failure);
                fillWhatIf(slug, failure);
                return;
            }
            const url = apiLib.apiUrl(`/api/issuers/${encodeURIComponent(slug)}/what-if`, null, apiBase);
            try {
                const res = await fetch(url, { headers: { accept: 'application/json' } });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const sheet = await res.json();
                state.whatIfBySlug.set(slug, sheet);
                fillWhatIf(slug, sheet);
            } catch (err) {
                const failure = `${url} — ${err.message}`;
                console.error(`[${new Date().toISOString()}] what-if sheet for ${slug} failed: ${failure}`);
                state.whatIfBySlug.set(slug, failure);
                fillWhatIf(slug, failure);
            }
        }

        /** Writes a sheet (or a failure string) into the open panel, if that panel is still open. */
        function fillWhatIf(slug, sheet) {
            if (state.openIssuerSlug !== slug) return;
            const host = els.detailBody.querySelector('#whatIfBody');
            if (!host) return;
            host.innerHTML = typeof sheet === 'string'
                ? whatIfSectionHtml(null, state.catalogue, { failure: sheet })
                : whatIfSectionHtml(sheet, state.catalogue);
        }

        /**
         * The same dialog serves both panels, so the token detail inherits the issuer panel's
         * behaviour for free: showModal() traps focus, closes on Escape, and returns focus to the
         * row's Details button when it closes.
         */
        function showDetail() {
            if (!els.detail.contains(document.activeElement)) state.detailReturnFocus = document.activeElement;
            els.detailBody.scrollTop = 0;
            if (typeof els.detail.showModal === 'function') els.detail.showModal();
            else els.detail.setAttribute('open', '');
            els.detailClose.focus();
        }

        function finalizeDetailClose() {
            if (state.openIssuerSlug) {
                const url = new URL(window.location.href);
                url.searchParams.delete('issuer');
                window.history.replaceState(null, '', url);
            }
            state.openIssuerSlug = null;
            state.openTokenMint = null;
            const returnTarget = state.detailReturnFocus;
            state.detailReturnFocus = null;
            if (returnTarget && returnTarget.isConnected && typeof returnTarget.focus === 'function') returnTarget.focus();
        }

        function closeDetail() {
            if (typeof els.detail.close === 'function') els.detail.close();
            else els.detail.removeAttribute('open');
            finalizeDetailClose();
        }

        function detailHtml(issuer) {
            const grades = issuer.grades || {};
            const sections = [];
            const verdict = laypersonVerdict({
                claimRung: grades.claimRung,
                redemptionAvailable: issuer.redemption && issuer.redemption.available,
                control: issuer.control || {}
            });
            const review = legalReviewStatus(issuer);
            // The chip index for this panel. `documents` rides along so a claim's URL can be shown
            // under the title the dossier gave it rather than as a bare link.
            state.detailEvidence = evidenceIndex(issuer, state.claimFields);
            state.detailEvidence.documents = Array.isArray(issuer.documents) ? issuer.documents : [];
            sections.push(`<div class="lay-verdict detail-verdict"><strong>${escapeHtml(verdict.headline)}</strong>` +
                `<span>${escapeHtml(verdict.redemption)} ${escapeHtml(verdict.controlNote)}</span>` +
                `<span class="review-status ${review.pending ? 'review-pending' : 'review-complete'}">${escapeHtml(review.label)} · ${escapeHtml(review.detail)}</span></div>`);
            sections.push(provenanceHtml(issuer));
            sections.push(`<aside class="detail-concept-guide"><strong>Start with the legal meaning</strong>` +
                `<p>${escapeHtml(claimRungTooltip(grades.claimRung) || 'The claim depth is not yet established from the reviewed evidence.')}</p>` +
                `${conceptGuideRowHtml(['claim', 'ownership', 'control', 'insolvency', 'redemption', 'defi'])}</aside>`);
            sections.push(evidenceLineHtml(issuer.evidence));
            sections.push(discrepanciesHtml(issuer));

            const legalTemplates = (state.composability?.templates ?? [])
                .filter((template) => template?.issuer === issuer.slug);
            if (legalTemplates.length) {
                sections.push('<section class="detail-section"><h4>Technology + legal template</h4><ul class="detail-list">' +
                    legalTemplates.map((template) => `<li><a href="templates/${encodeURIComponent(template.id)}.html">` +
                        `${escapeHtml(template.legalTemplate ?? template.id)}</a>` +
                        `<div class="item-meta">${escapeHtml(template.recipe ?? '')}</div></li>`).join('') +
                    '</ul></section>');
            }

            sections.push(detailSection('Issuing entity', [
                field('Lifecycle status', issuer.status, false, 'status'),
                field('Entity', issuer.issuingEntity, false, 'issuingEntity'),
                field('Jurisdiction', issuer.entityJurisdiction, false, 'entityJurisdiction'),
                field('Governing law', issuer.governingLaw, false, 'governingLaw'),
                field('Regulatory status', issuer.regulatoryStatus, false, 'regulatoryStatus'),
                field('Legal form', issuer.legalForm, false, 'legalForm'),
                field('Claim depth', `rung ${Number.isInteger(grades.claimRung) ? grades.claimRung : DASH} — ${claimLabel(grades.claimRung, grades.claimLabel)}`),
                field('What the holder owns', issuer.holderClaim, false, 'holderClaim'),
                field('Token program (as the issuer states it)', issuer.tokenProgram, false, 'tokenProgram'),
                field('Chains', Array.isArray(issuer.chains) ? issuer.chains.join(', ') : null),
                field('Products', Array.isArray(issuer.products) ? issuer.products.join(' · ') : null),
                field('Confidence in this dossier', issuer.confidence)
            ]));

            const custody = issuer.custodyVerification || {};
            sections.push(detailSection('Custody and verification', [
                field('Underlying custodian', issuer.underlyingCustodian, false, 'underlyingCustodian'),
                field('Verification type', `${custody.type || DASH} — strength ${Number.isInteger(grades.verificationStrength) ? grades.verificationStrength : DASH}/5 (${verificationLabel(grades.verificationStrength, grades.verificationLabel)})`, false, 'custodyVerification.type'),
                field('Agent', custody.agent, false, 'custodyVerification.agent'),
                field('Frequency', custody.frequency, false, 'custodyVerification.frequency'),
                field('Machine-readable', custody.machineReadable === true ? 'yes' : custody.machineReadable === false ? 'no' : null),
                field('Endpoint', custody.endpoint),
                field('Notes', custody.notes),
                field('Evidence', linkHtml(custody.link), true)
            ]));

            const collateral = issuer.collateral || {};
            const security = issuer.securityInterest || {};
            sections.push(detailSection('Collateral', [
                field('Ratio', collateral.ratio, false, 'collateral.ratio'),
                field('Composition', collateral.composition, false, 'collateral.composition'),
                field('Rehypothecation', collateral.rehypothecation, false, 'collateral.rehypothecation'),
                field('On-loan amount disclosed', collateral.onLoanDisclosed === true ? 'yes' : collateral.onLoanDisclosed === false ? 'no' : null, false, 'collateral.onLoanDisclosed'),
                field('Security interest', security.exists === true ? 'yes' : security.exists === false ? 'no' : null, false, 'securityInterest.exists'),
                field('Security holder', security.holder, false, 'securityInterest.holder'),
                field('Priority', security.priority, false, 'securityInterest.priority'),
                field('Bankruptcy remote', issuer.bankruptcyRemote === true ? 'yes' : issuer.bankruptcyRemote === false ? 'no' : null, false, 'bankruptcyRemote')
            ]));

            const redemptionUsability = redemptionUsabilitySummary(issuer, null);
            const redemptionAnswers = redemptionUsability.model;
            sections.push(detailSection('Redemption', [
                field('Contractual right', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'contractual-right')), true, 'redemption.available'),
                field('Eligibility', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'eligibility-and-place')), true, 'redemption.eligibility'),
                field('Rails', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'timing-and-settlement')), true, 'redemption.rails'),
                field('Fees', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'fees')), true, 'redemption.fees'),
                field('KYC', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'kyc')), true, 'redemption.kyc'),
                field('Minimum', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'minimum')), true, 'redemption.minimum'),
                field('Route currently available', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'route-currently-available')), true),
                field('Successful redemption independently observed', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'successful-redemption')), true),
                field('Recurring on-chain scan', redemptionUsability.feed?.text ?? null),
                field('Secondary-market exit', 'Asset-specific. See the exact-token report.'),
                field('Notes', issuer.redemption?.notes, false, 'redemption.notes')
            ]));

            const restrictions = issuer.transferRestrictions || {};
            sections.push(detailSection('Transfer restrictions', [
                field('Allowlist', restrictions.allowlist === true ? 'yes' : restrictions.allowlist === false ? 'no' : null, false, 'transferRestrictions.allowlist'),
                field('KYC to hold', restrictions.kycToHold === true ? 'yes' : restrictions.kycToHold === false ? 'no' : null, false, 'transferRestrictions.kycToHold'),
                field('US persons excluded', restrictions.usPersonsExcluded === true ? 'yes' : restrictions.usPersonsExcluded === false ? 'no' : null, false, 'transferRestrictions.usPersonsExcluded'),
                field('Mechanism', restrictions.mechanism, false, 'transferRestrictions.mechanism')
            ]));

            sections.push(detailSection('Rights', [
                field('Dividends', issuer.dividends, false, 'dividends'),
                field('Voting', issuer.voting, false, 'voting'),
                field('Corporate actions', issuer.corporateActions, false, 'corporateActions'),
                field('Pricing reference', issuer.pricing && issuer.pricing.referenceMarket, false, 'pricing.referenceMarket'),
                field('Arbitrageable', issuer.pricing && issuer.pricing.arbitrageable === true ? 'yes' : issuer.pricing && issuer.pricing.arbitrageable === false ? 'no' : null, false, 'pricing.arbitrageable'),
                field('Pricing notes', issuer.pricing && issuer.pricing.notes, false, 'pricing.notes'),
                field('Venues', Array.isArray(issuer.venues) && issuer.venues.length ? issuer.venues.join(', ') : null)
            ]));

            const keyGovernance = issuer.keyGovernance || (issuer.control && issuer.control.keyGovernance) || {};
            sections.push(detailSection('Key governance', [
                field('Mint authority', keyGovernance.mint, false, 'keyGovernance.mint'),
                field('Freeze authority', keyGovernance.freeze, false, 'keyGovernance.freeze'),
                field('Permanent delegate', keyGovernance.delegate, false, 'keyGovernance.delegate'),
                // The fourth authority (MODEL.md §2.7): the Token-2022 scaled-UI-amount key, one
                // signature from which restates every holder's displayed balance.
                field('Rebase authority', keyGovernance.rebase, false, 'keyGovernance.rebase'),
                field('Evidence', keyGovernance.evidence)
            ]));

            // The twelve maturity questions (MODEL §3.1). They drive the grid's stage and every one
            // of them is on the claim-field list, so without this section a third of what needs a
            // source would have nowhere to show a chip. The `reason` prose rides along as the row's
            // hover title; the chip carries the quote that backs the answer.
            const vocabulary = issuer.vocabulary && typeof issuer.vocabulary === 'object'
                ? issuer.vocabulary
                : {};
            sections.push(detailSection('Ledger maturity vocabulary',
                Object.keys(vocabulary).sort().map((key) => {
                    const entry = vocabulary[key] || {};
                    const value = entry.value === null || entry.value === undefined || entry.value === ''
                        ? DASH
                        : String(entry.value);
                    return `<div class="detail-field"${entry.reason ? ` title="${escapeHtml(String(entry.reason))}"` : ''}>` +
                        `<dt>${escapeHtml(humanizeSlug(key))}</dt>` +
                        `<dd>${escapeHtml(value)}${chipFor_(`vocabulary.${key}.value`, humanizeSlug(key))}</dd></div>`;
                })));

            // The trust chain and the what-if answers (stocks/EVIDENCE.md §6). The diagram is drawn
            // from the record's own `chain`, so it is there the moment the panel opens; the answers
            // are fetched (loadWhatIf) into #whatIfBody, because 38 answers with their quotes are
            // prose the built file deliberately does not carry.
            sections.push('<section class="detail-section" id="schematicSection"><h4>How it works, step by step</h4>'
                + `<div id="schematicBody" data-schematic="issuer:${escapeHtml(issuer.slug)}" data-schematic-grid>`
                + '<p class="fd-empty">Loading the schematics…</p></div></section>');
            sections.push(`<section class="detail-section" id="trustChainSection">`
                + '<h4>Trust chain</h4>'
                + `${chainSectionHtml(issuer)}</section>`);
            const modeCount = Array.isArray(state.catalogue?.failureModes)
                ? state.catalogue.failureModes.length
                : null;
            sections.push('<section class="detail-section" id="whatIfSection">'
                + `<h4>What if…${modeCount === null ? '' : ` <span class="detail-count">${modeCount}</span>`}</h4>`
                + '<div id="whatIfBody">'
                + `${whatIfSectionHtml(null, state.catalogue)}</div></section>`);

            sections.push(detailList('Documents', issuer.documents, (doc) => {
                const label = escapeHtml(doc.title || doc.url || DASH);
                const type = doc.type ? ` <span class="doc-type">${escapeHtml(doc.type)}</span>` : '';
                return isSafeUrl(doc.url)
                    ? `<a href="${escapeHtml(doc.url)}" target="_blank" rel="noopener noreferrer">${label}</a>${type}`
                    : `${label}${type}`;
            }));

            sections.push(detailList('Incidents', issuer.incidents, (incident) =>
                `<span class="item-date">${escapeHtml(fmtDate(incident.date))}</span> ${escapeHtml(incident.summary)}` +
                (isSafeUrl(incident.source) ? ` <a href="${escapeHtml(incident.source)}" target="_blank" rel="noopener noreferrer">source</a>` : '')
            ));

            sections.push(detailList('Open questions', issuer.openQuestions, (q) => escapeHtml(q)));

            sections.push(detailList('Attestations', issuer.attestations, (att) => {
                const name = escapeHtml(labelForSchema(att.schema, state.attestationTypes));
                const status = att.status ? `<span class="att-status att-status-${escapeHtml(String(att.status).toLowerCase())}">${escapeHtml(att.status)}</span>` : '';
                const link = isSafeUrl(att.link)
                    ? ` <a href="${escapeHtml(att.link)}" target="_blank" rel="noopener noreferrer">evidence</a>`
                    : '';
                return `<div class="item-head"><strong>${name}</strong> ${status}</div>` +
                    `<div class="item-meta">${escapeHtml(att.attestor || DASH)} · ${escapeHtml(fmtDate(att.attestationDate))}` +
                    `${att.onchain ? ' · on-chain' : ''}${link}</div>` +
                    (att.statement ? `<div class="item-body">${escapeHtml(att.statement)}</div>` : '');
            }));

            sections.push(detailList('Findings', issuer.findings, (finding) => {
                const name = escapeHtml(labelForSchema(finding.schema, state.findingTypes));
                const sev = `<span class="sev-chip ${severityClass(finding.severity)}">${escapeHtml(finding.severity || 'unknown')}</span>`;
                const evidence = isSafeUrl(finding.evidence)
                    ? ` <a href="${escapeHtml(finding.evidence)}" target="_blank" rel="noopener noreferrer">evidence</a>`
                    : finding.evidence ? ` <code>${escapeHtml(finding.evidence)}</code>` : '';
                return `<div class="item-head">${sev} <strong>${name}</strong></div>` +
                    (finding.statement ? `<div class="item-body">${escapeHtml(finding.statement)}</div>` : '') +
                    `<div class="item-meta">${escapeHtml(finding.observer || DASH)} · ${escapeHtml(fmtDate(finding.observedAt))}${evidence}</div>`;
            }));

            sections.push(detailList('Sources', issuer.sources, (src) =>
                isSafeUrl(src)
                    ? `<a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${escapeHtml(src)}</a>`
                    : escapeHtml(src)
            ));

            return sections.filter(Boolean).join('');
        }

        /**
         * The evidence chip for one dossier field path, or '' when the open panel has no chip index
         * (the token panel) or the field neither carries nor needs a claim. `path` is the dotted
         * dossier path, e.g. `redemption.rails` — the same string a claim names.
         */
        function chipFor_(path, label) {
            if (!path || !state.detailEvidence) return '';
            return fieldChipHtml(state.detailEvidence, path, label);
        }

        /** One dt/dd pair, dropped entirely when the dossier has nothing for it. */
        function field(label, value, isHtml, path) {
            if (value === null || value === undefined || value === '' || value === DASH) return '';
            return `<div class="detail-field"><dt>${escapeHtml(label)}</dt>` +
                `<dd>${isHtml ? value : escapeHtml(String(value))}${chipFor_(path, label)}</dd></div>`;
        }

        /** Like field(), but keeps the row and prints a dash: for a field whose absence is news. */
        function fieldAlways(label, value, tip, path) {
            const text = value === null || value === undefined || value === '' ? DASH : String(value);
            return `<div class="detail-field"${tip ? ` title="${escapeHtml(tip)}"` : ''}>` +
                `<dt>${escapeHtml(label)}</dt>` +
                `<dd>${escapeHtml(text)}${chipFor_(path, label)}</dd></div>`;
        }

        // --- token detail dialog -------------------------------------------

        async function openTokenDetail(mint) {
            if (!state.fullCatalogueLoaded && !(await loadFullCatalogue())) return;
            const token = state.tokensByMint.get(mint);
            if (!token) return;
            const title = token.symbol
                ? `${token.symbol}${token.name ? ' — ' + token.name : ''}`
                : (token.name || token.mint);
            els.detailTitle.innerHTML = `${escapeHtml(title)} ${cardLinkHtml(token)}`;
            state.openTokenMint = mint;
            // This panel shows on-chain and market readings, not a dossier, so no issuer's answer
            // sheet belongs in it — and a sheet still in flight must not be written over it.
            state.openIssuerSlug = null;
            els.detailBody.innerHTML = tokenDetailHtml(token);
            showDetail();

            // Per-mint venue detail is its own 700 kB file (MODEL §10.3) and only the panel needs
            // it, so it is fetched on the first panel open and the body is re-rendered when it
            // lands — unless the token record already carries its venues inline.
            if (!tokenVenueSource(token) && !state.venuesLoaded) {
                await loadVenues();
                if (state.openTokenMint === mint && els.detail.open) {
                    els.detailBody.innerHTML = tokenDetailHtml(token);
                }
            }
        }

        /** Venues from the token record when the build embeds them, else from venues.json. */
        function tokenVenueSource(token) {
            if (token.venues) return token.venues;
            if (token.venueDetail) return token.venueDetail;
            if (token.activity && token.activity.venues) return token.activity.venues;
            return state.venuesByMint ? state.venuesByMint.get(token.mint) || null : null;
        }

        async function loadVenues() {
            state.venuesLoaded = true;
            const db = await fetchJson(VENUES_PATH);
            const items = db && Array.isArray(db.items) ? db.items : [];
            state.venuesByMint = new Map(items
                .filter((item) => item && typeof item.mint === 'string')
                .map((item) => [item.mint, item]));
        }

        function tokenDetailHtml(token) {
            // A token panel shows on-chain and market readings, not dossier claims, so no chip is
            // drawn here — and leaving a stale index in place would draw the previous ISSUER's.
            state.detailEvidence = null;
            const market = token.market || {};
            const reference = token.reference || {};
            const control = token.control || {};
            const activity = token.activity || {};
            const issuer = state.issuersBySlug.get(token.issuer);
            const sections = [];

            if (issuer) {
                const verdict = laypersonVerdict({
                    claimRung: issuer.grades && issuer.grades.claimRung,
                    redemptionAvailable: issuer.redemption && issuer.redemption.available,
                    control: token.control || issuer.control || {}
                });
                const review = legalReviewStatus(issuer);
                sections.push(`<div class="lay-verdict detail-verdict"><strong>${escapeHtml(verdict.headline)}</strong>` +
                    `<span>${escapeHtml(verdict.redemption)} ${escapeHtml(verdict.controlNote)}</span>` +
                    `<span class="review-status ${review.pending ? 'review-pending' : 'review-complete'}">${escapeHtml(review.label)} · ${escapeHtml(review.detail)}</span></div>`);
                sections.push(provenanceHtml(issuer));
                sections.push(`<aside class="detail-concept-guide"><strong>How to read this token</strong>` +
                    `<p>${escapeHtml(claimRungTooltip(issuer.grades && issuer.grades.claimRung) || 'The claim depth is not yet established from the reviewed evidence.')}</p>` +
                    `${conceptGuideRowHtml(['ownership', 'control', 'redemption', 'defi'])}</aside>`);
                sections.push(discrepanciesHtml(issuer));
            }

            sections.push(detailSection('Identity & on-chain', [
                field('Token address (Solana mint)', `<code>${escapeHtml(token.mint)}</code>`, true),
                field('Symbol', token.symbol),
                field('Name', token.name),
                field('Issuer programme', issuer ? issuer.name : token.issuer),
                field('Underlying ticker', token.underlyingTicker),
                field('Instrument', token.instrumentType ? humanizeSlug(token.instrumentType) : null),
                field('Token program', token.tokenProgram ? `<code>${escapeHtml(token.tokenProgram)}</code>` : null, true),
                field('Decimals', isNum(token.decimals) ? String(token.decimals) : null),
                field('Supply (UI-adjusted)', isNum(token.supplyUi)
                    ? `${fmtNumber(token.supplyUi, 2)}${isNum(token.uiMultiplier) && token.uiMultiplier !== 1 ? ` · scaled-UI multiplier ${fmtNumber(token.uiMultiplier, 2)}` : ''}`
                    : null),
                field('Listed on Jupiter', token.listedOnJupiter === true ? 'yes' : token.listedOnJupiter === false ? 'no' : null),
                field('Identity evidence', token.identity?.status ? humanizeSlug(token.identity.status) : null),
                field('Issuer registry', token.identity?.currentIssuerRegistry ? humanizeSlug(token.identity.currentIssuerRegistry) : null),
                field('Operational state', token.identity?.operationalStatus ? humanizeSlug(token.identity.operationalStatus) : null),
                field('Mint authority', controlValue(control.mintAuthority)),
                field('Clawback (permanent delegate)', controlValue(control.clawback)),
                field('Permanent-delegate address', controlValue(control.permanentDelegate)),
                field('Freeze authority', controlValue(control.freezeAuthority)),
                field('Pausable', controlValue(control.pausable)),
                field('Paused now', controlValue(control.paused)),
                field('Allowlist (default frozen)', controlValue(control.allowlist)),
                field('Transfer fee', transferFeeCapabilityLabel(control)),
                field('Transfer hook', controlValue(control.hookActive)),
                field('Metadata URI', linkHtml(token.metadataUri), true)
            ]));

            if (issuer) {
                const redemptionUsability = redemptionUsabilitySummary(issuer, token);
                const redemptionAnswers = redemptionUsability.model;
                sections.push(detailSection('Redemption usability', [
                    field('Contractual right', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'contractual-right')), true),
                    field('Eligible holder and route', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'eligibility-and-place')), true),
                    field('KYC / AML', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'kyc')), true),
                    field('Minimum', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'minimum')), true),
                    field('Fees', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'fees')), true),
                    field('Timing and settlement asset', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'timing-and-settlement')), true),
                    field('Route currently available', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'route-currently-available')), true),
                    field('Successful redemption independently observed', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'successful-redemption')), true),
                    field('Recurring on-chain scan (programme)', redemptionUsability.feed?.text ?? null),
                    field('Secondary-market exit', redemptionAnswerHtml(redemptionAnswer(redemptionAnswers, 'secondary-market-exit')), true)
                ]));
            }

            sections.push(detailSection('Market', [
                field('Price', fmtPrice(market.usdPrice)),
                field('Market cap', fmtMoney(market.mcap)),
                field('Liquidity (DEX pool reserves)', fmtMoney(market.liquidity)),
                field('Volume 24h', fmtMoney(market.vol24)),
                field('Organic volume 24h', fmtMoney(market.organicVol24)),
                field('Organic share', fmtPct(market.organicSharePct)),
                field('Holders', fmtNumber(market.holderCount)),
                field('Top-10 share of supply', fmtPct(market.top10HolderPct)),
                field('First pool', fmtDateTime(market.firstPoolAt))
            ]));

            const flagBadges = activityFlags({
                tradesPerTrader: activity.tradesPerTrader,
                organicSharePct: isNum(activity.organicSharePct) ? activity.organicSharePct : market.organicSharePct
            });
            // No activity record at all is its own statement, and a section of dashes would hide it.
            sections.push(!token.activity ? detailSection('Trading activity (24h)', [
                field('Collected', 'No activity record for this token in this build.')
            ]) : detailSection('Trading activity (24h)', [
                field('Buys', fmtNumber(activity.buys24)),
                field('Sells', fmtNumber(activity.sells24)),
                field('Trades', fmtNumber(activity.trades24)),
                field('Traders', fmtNumber(activity.traders24)),
                field('Organic buyers', fmtNumber(activity.organicBuyers24)),
                field('Trades per trader', fmtTradesPerTrader(activity.tradesPerTrader)),
                field('DEX pairs', fmtNumber(activity.dexPairs)),
                field('DEX transactions', fmtNumber(activity.dexTxns24)),
                field('CEX markets', fmtNumber(activity.cexMarkets)),
                field('Venues', fmtNumber(activity.venueCount)),
                fieldAlways('Venue spread', fmtVenueSpread(activity), MARKET_TOOLTIPS.venueSpread),
                field('Last trade', activity.lastTradedAt
                    ? `${fmtRelativeTime(activity.lastTradedAt)} · ${escapeHtml(activity.lastTradedAt)}${activity.lastTradedVenue ? ' · ' + escapeHtml(activity.lastTradedVenue) : ''}`
                    : null, true),
                flagBadges.length
                    ? field('Flags', flagBadges.map((flag) =>
                        `<span class="act-badge act-badge-${escapeHtml(flag.code)}" title="${escapeHtml(flag.detail)}">` +
                        `<span aria-hidden="true">${escapeHtml(flag.glyph)}</span> ${escapeHtml(flag.label)}</span>`).join(' '), true)
                    : ''
            ]));

            sections.push(defiUsageDetailHtml(
                state.defiUsageByMint.get(token.mint) ?? null,
                state.defiUsage?.fetchedAt ?? null,
                composabilityTemplateForToken(state.composability, token),
                issuer
            ));

            sections.push(venuesSectionHtml(token));

            sections.push(detailSection('Reference', [
                field('Source', reference.source),
                field('Reference price', fmtPrice(reference.price)),
                field('Premium', fmtSignedPct(reference.premiumPct)),
                field('Underlying market', reference.marketOpen === true ? 'open' : reference.marketOpen === false ? 'closed' : null),
                field('Reference age', fmtAgeSeconds(reference.ageSeconds)),
                field('Note', reference.note)
            ]));

            return sections.filter(Boolean).join('');
        }

        /** Every DEX pair and CEX market this mint trades on, busiest first, each one linked. */
        function venuesSectionHtml(token) {
            const rows = venueRows(tokenVenueSource(token));
            if (!rows.length) {
                return '<section class="detail-section"><h4>Venues</h4>' +
                    `<p class="detail-empty">${state.venuesLoaded
                        ? 'None collected. Venues come from DexScreener pairs and CoinGecko tickers; a token ' +
                        'with no pool and no exchange listing has neither.'
                        : 'Loading venue detail…'}</p></section>`;
            }
            const body = rows.map((row) => {
                const name = escapeHtml(row.name);
                const label = row.url
                    ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${name}</a>`
                    : name;
                return '<tr>' +
                    `<td><span class="venue-kind venue-kind-${row.kind}">${row.kind}</span> ${label}</td>` +
                    `<td${row.pairFull && row.pairFull !== row.pair ? ` title="${escapeHtml(row.pairFull)}"` : ''}>` +
                    `${escapeHtml(row.pair || DASH)}</td>` +
                    `<td class="num">${escapeHtml(fmtPrice(row.priceUsd))}</td>` +
                    `<td class="num">${escapeHtml(fmtMoney(row.liquidityUsd))}</td>` +
                    `<td class="num">${escapeHtml(fmtMoney(row.volume24Usd))}</td>` +
                    `<td class="num">${escapeHtml(fmtNumber(row.txns24))}</td>` +
                    `<td title="${escapeHtml(row.lastTradedAt || '')}">${escapeHtml(fmtRelativeTime(row.lastTradedAt))}</td>` +
                    '</tr>';
            }).join('');
            return `<section class="detail-section"><h4>Venues <span class="detail-count">${rows.length}</span></h4>` +
                '<div class="venue-wrap"><table class="venue-table"><thead><tr>' +
                '<th scope="col">Venue</th><th scope="col">Pair</th><th scope="col">Price</th>' +
                '<th scope="col">Liquidity</th>' +
                '<th scope="col">Vol 24h</th><th scope="col">Trades 24h</th><th scope="col">Last trade</th>' +
                `</tr></thead><tbody>${body}</tbody></table></div></section>`;
        }

        // --- token table ---------------------------------------------------

        /** From the issuer file: one option per programme, in the card order. */
        function populateIssuerFilter(issuers) {
            els.filterIssuer.insertAdjacentHTML('beforeend', sortIssuersForDisplay(issuers)
                .map((issuer) => `<option value="${escapeHtml(issuer.slug)}">${escapeHtml(displayName(issuer.name, 40))}</option>`)
                .join(''));
            els.filterIssuer.value = state.filters.issuer;
            if (els.filterIssuer.value !== state.filters.issuer) state.filters.issuer = '';
        }

        /** From the token file: the instrument types actually present in the mints. */
        function populateInstrumentFilter(tokens) {
            const types = [...new Set(tokens.map((t) => t.instrumentType).filter(Boolean))].sort();
            els.filterInstrument.insertAdjacentHTML('beforeend', types
                .map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(humanizeSlug(type))}</option>`)
                .join(''));
            els.filterInstrument.value = state.filters.instrumentType;
            if (els.filterInstrument.value !== state.filters.instrumentType) state.filters.instrumentType = '';
        }

        /** A loading or error line in place of the rows, spanning the table's own column count. */
        function tokenTableMessage(kind, title, detail, actions = []) {
            const columns = els.tokenTableHead.querySelectorAll('th').length || 1;
            els.tokenTableBody.innerHTML =
                `<tr><td class="token-table-message" colspan="${columns}">${dataStateHtml(kind, title, detail, actions)}</td></tr>`;
        }

        function localTokenPage() {
            const rows = filterTokens(state.tokens, state.filters);
            const getValue = SORT_KEYS[state.sort.key];
            if (getValue) rows.sort(makeComparator(getValue, state.sort.ascending));
            const paging = tokenPageMath(rows.length, state.tokenPage);
            state.tokenPage = paging.page;
            return { rows: rows.slice(paging.offset, paging.offset + TOKEN_PAGE_SIZE), total: rows.length };
        }

        async function loadTokenPage() {
            renderSortIndicators();
            if (!state.tokensLoaded) return;
            const request = ++state.tokenRequestSeq;
            tokenTableMessage('loading', 'Loading this page', 'Applying the current filters and sort to the API-backed token catalogue.');

            if (state.useSample) {
                const local = localTokenPage();
                state.tokenRows = local.rows;
                state.tokenTotal = local.total;
                renderTokenTable();
                return;
            }

            try {
                if (apiLib === null) throw new Error('API URL helper unavailable');
                const params = tokenApiParams(state.filters, state.sort, state.tokenPage);
                const url = apiLib.apiUrl('/api/tokens', params, apiBase);
                const res = await fetch(url, { cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = await res.json();
                if (request !== state.tokenRequestSeq) return;
                state.tokenRows = (Array.isArray(body?.items) ? body.items : []).map(tokenFromApiRow);
                state.tokenTotal = Number(body?.total) || 0;
            } catch (err) {
                if (request !== state.tokenRequestSeq) return;
                console.error(`[${new Date().toISOString()}] stocks: /api/tokens unavailable`, err);
                state.tokenRows = [];
                state.tokenTotal = 0;
                tokenTableMessage('failed', 'Token API unavailable', 'The request failed, so we cannot say whether matching tokens exist.', [
                    { label: 'Retry token API', action: 'retry-token-table' },
                    { label: 'Open health monitor', href: './monitor.html' }
                ]);
                els.tokenCount.textContent = 'Token API unavailable';
                els.tokenPager.hidden = true;
                els.tokenPageLabel.textContent = 'Unavailable';
                els.tokenPrev.disabled = true;
                els.tokenNext.disabled = true;
                return;
            }
            renderTokenTable();
        }

        function renderTokenTable() {
            renderSortIndicators();
            if (!state.tokensLoaded) return;
            const paging = tokenPageMath(state.tokenTotal, state.tokenPage);
            state.tokenPage = paging.page;
            if (state.tokenRows.length) {
                els.tokenTableBody.innerHTML = state.tokenRows.map(tokenRowHtml).join('');
            } else {
                const filtered = Boolean(state.filters.issuer || state.filters.instrumentType || state.filters.query);
                tokenTableMessage(filtered ? 'filtered-empty' : 'none-exists',
                    filtered ? 'No token matches these filters' : 'No token exists in this catalogue page',
                    filtered ? 'The catalogue loaded successfully, but the current issuer, instrument and search combination returned no rows.' : 'The catalogue loaded successfully and returned no admitted token addresses.',
                    filtered ? [{ label: 'Clear token filters', action: 'clear-token-filters' }] : [{ label: 'Review collection coverage', href: './methodology.html' }]);
            }
            els.tokenCount.textContent = state.useSample
                ? `${paging.total} tokens · bundled sample`
                : `${paging.total} tokens · API-backed`;
            els.tokenPager.hidden = paging.total <= TOKEN_PAGE_SIZE;
            els.tokenPageLabel.textContent = paging.total === 0
                ? 'No matches'
                : `${paging.from}–${paging.to} of ${paging.total} · page ${paging.page} of ${paging.pages}`;
            els.tokenPrev.disabled = !paging.hasPrev;
            els.tokenNext.disabled = !paging.hasNext;
        }

        function renderSortIndicators() {
            els.tokenTableHead.querySelectorAll('th[data-sort]').forEach((th) => {
                const isActive = th.getAttribute('data-sort') === state.sort.key;
                th.classList.toggle('sort-active', isActive);
                const indicator = th.querySelector('.sort-indicator');
                if (indicator) indicator.textContent = isActive ? (state.sort.ascending ? ' ↑' : ' ↓') : '';
            });
        }

        function tokenRowHtml(token) {
            const market = token.market || {};
            const reference = token.reference || {};
            const control = token.control || {};
            const issuer = state.issuersBySlug.get(token.issuer);
            const defunct = issuer && issuer.status !== 'live';
            const premium = reference.premiumPct;
            const premiumClass = !isNum(premium) ? '' : premium > 0 ? ' num-up' : premium < 0 ? ' num-down' : '';

            const flags = TOKEN_FLAGS
                .filter(([prop]) => isControlOn(control[prop]))
                .map(([, glyph, tip]) => `<abbr class="flag" title="${escapeHtml(tip)}">${glyph}</abbr>`);
            const feeCapability = transferFeeCapabilityLabel(control);
            if (feeCapability) {
                flags.push(`<abbr class="flag" title="${escapeHtml(feeCapability)}">%</abbr>`);
            }
            if (control.paused === true) {
                flags.push('<abbr class="flag flag-alert" title="This token is paused right now: transfers are halted">||</abbr>');
            }

            const activity = token.activity || {};

            return `<tr class="token-row${defunct ? ' asset-defunct' : ''}" data-mint="${escapeHtml(token.mint)}">` +
                `<td class="cell-token" data-column="token"><span class="token-symbol">${escapeHtml(token.symbol || DASH)}</span>` +
                cardLinkHtml(token) +
                `<span class="token-name">${escapeHtml(token.name || '')}</span></td>` +
                `<td data-column="issuer" title="${escapeHtml(issuer ? issuer.name : '')}">${escapeHtml(issuer ? displayName(issuer.name, 28) : token.issuer || DASH)}</td>` +
                `<td data-column="underlying">${escapeHtml(token.underlyingTicker || DASH)}</td>` +
                `<td data-column="instrument">${escapeHtml(humanizeSlug(token.instrumentType))}</td>` +
                `<td class="num" data-column="price">${escapeHtml(fmtPrice(market.usdPrice))}</td>` +
                `<td class="cell-ref" data-column="reference"><span class="ref-source">${escapeHtml(reference.source || 'none')}</span>` +
                `<span class="ref-price">${escapeHtml(fmtPrice(reference.price))}</span></td>` +
                `<td class="num${premiumClass}" data-column="premium">${escapeHtml(fmtSignedPct(premium))}</td>` +
                `<td class="num" data-column="liquidity">${escapeHtml(fmtMoney(market.liquidity))}</td>` +
                `<td class="num" data-column="volume">${escapeHtml(fmtMoney(market.vol24))}</td>` +
                `<td class="num" data-column="organic">${escapeHtml(fmtPct(market.organicSharePct))}</td>` +
                `<td class="num" data-column="trades">${escapeHtml(fmtNumber(activity.trades24))}</td>` +
                `<td class="num" data-column="traders">${escapeHtml(fmtNumber(activity.traders24))}</td>` +
                `<td class="num" data-column="spread" title="${escapeHtml(fmtVenueSpread(activity) === DASH ? MARKET_TOOLTIPS.venueSpread : fmtVenueSpread(activity))}">` +
                `${escapeHtml(fmtVenueSpreadPct(activity.venueSpreadPct))}</td>` +
                `<td class="num" data-column="holders">${escapeHtml(fmtNumber(market.holderCount))}</td>` +
                `<td class="num" data-column="concentration">${escapeHtml(fmtPct(market.top10HolderPct))}</td>` +
                `<td data-column="last-trade" title="${escapeHtml(activity.lastTradedAt || MARKET_TOOLTIPS.lastTrade)}">` +
                `${escapeHtml(fmtRelativeTime(activity.lastTradedAt))}</td>` +
                `<td class="cell-defi" data-column="defi">${defiUsageCompactHtml(state.defiUsageByMint.get(token.mint) ?? null)}</td>` +
                `<td class="cell-flags" data-column="control">${flags.join('')}</td>` +
                `<td class="cell-detail" data-column="detail"><button type="button" class="row-detail" data-mint="${escapeHtml(token.mint)}" ` +
                `aria-label="Details for ${escapeHtml(token.symbol || token.mint)}">Details</button></td>` +
                '</tr>';
        }

        // --- events --------------------------------------------------------

        function wireEvents() {
            // Evidence chips. `toggle` does not bubble, so the listener is CAPTURING — which does
            // reach a non-bubbling event on a descendant, and survives every re-render of the
            // panel body (an element-level listener would not). Two jobs: keep one popover open at
            // a time, and scroll it into view, because the panel body is a scroll container and a
            // popover on a field near its bottom edge would otherwise be clipped by it.
            els.detailBody.addEventListener('toggle', (event) => {
                const chip = event.target;
                if (!chip.classList || !chip.classList.contains('ev-chip') || !chip.open) return;
                for (const other of els.detailBody.querySelectorAll('details.ev-chip[open]')) {
                    if (other !== chip) other.open = false;
                }
                const pop = chip.querySelector('.ev-pop');
                // Instant, not smooth: an agent (or a test) cannot observe a scroll animation,
                // and there is nothing here worth animating.
                if (pop) pop.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }, true);

            // Tapping a lane in the trust-chain diagram opens that flow's row in the list below it,
            // which is where its summary and fields are. The list is the accessible copy and works
            // on its own, so this only shortens the journey; the lane's own <title> still gives the
            // one-line hover.
            els.detailBody.addEventListener('click', (event) => {
                const lane = event.target.closest ? event.target.closest('g.tc-lane[data-flow]') : null;
                if (!lane) return;
                const flow = lane.getAttribute('data-flow');
                // Catalogue ids are slugs; anything else is not looked up rather than interpolated
                // into a selector.
                if (!SLUG_SAFE.test(flow || '')) return;
                const row = els.detailBody.querySelector(`details.tc-flow[data-flow="${flow}"]`);
                if (!row) return;
                row.open = true;
                row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            });

            document.addEventListener('click', (event) => {
                const stateAction = event.target.closest('[data-state-action]');
                if (stateAction) {
                    const action = stateAction.dataset.stateAction;
                    if (action === 'reload-page') window.location.reload();
                    if (action === 'retry-comparison') renderComparisonTable();
                    if (action === 'retry-token-table') loadTokenPage();
                    if (action === 'clear-search') {
                        els.globalSearch.value = '';
                        state.globalQuery = '';
                        state.filters.query = '';
                        state.tokenPage = 1;
                        writeTokenViewUrl();
                        renderGlobalSearch();
                        loadTokenPage();
                        els.globalSearch.focus();
                    }
                    if (action === 'clear-token-filters') {
                        state.filters = { issuer: '', instrumentType: '', query: '' };
                        state.globalQuery = '';
                        state.tokenPage = 1;
                        els.filterIssuer.value = '';
                        els.filterInstrument.value = '';
                        els.globalSearch.value = '';
                        writeTokenViewUrl();
                        renderGlobalSearch();
                        loadTokenPage();
                    }
                    if (action === 'clear-defi-filter') {
                        state.defiAction = 'all';
                        renderDefiUsage();
                    }
                    return;
                }
                const saveTicker = event.target.closest('[data-save-ticker]');
                if (saveTicker) {
                    togglePersonalItem('ticker', saveTicker.getAttribute('data-save-ticker'));
                    return;
                }
                const saveIssuer = event.target.closest('[data-save-issuer]');
                if (saveIssuer) {
                    togglePersonalItem('issuer', saveIssuer.getAttribute('data-save-issuer'));
                    return;
                }
                // A "Card ↗" link sits inside a row that is itself a [data-mint] trigger, so the
                // link has to be let through or the dialog opens over the navigation.
                if (event.target.closest('a.card-link')) return;
                // data-mint before data-slug: a token row's Details button sits inside a table
                // whose issuer column carries no slug, but the order makes the intent explicit.
                const mintTrigger = event.target.closest('[data-mint]');
                if (mintTrigger) {
                    openTokenDetail(mintTrigger.getAttribute('data-mint'));
                    return;
                }
                const trigger = event.target.closest('[data-slug]');
                if (trigger) {
                    openDetail(trigger.getAttribute('data-slug'));
                    return;
                }
                const th = event.target.closest('#tokenTable th[data-sort]');
                if (th) {
                    const key = th.getAttribute('data-sort');
                    if (state.sort.key === key) state.sort.ascending = !state.sort.ascending;
                    else state.sort = { key, ascending: false };
                    state.tokenPage = 1;
                    writeTokenViewUrl();
                    loadTokenPage();
                    return;
                }
                const activityTh = event.target.closest('#activityTable th[data-sort]');
                if (activityTh) {
                    const key = activityTh.getAttribute('data-sort');
                    if (state.activitySort.key === key) state.activitySort.ascending = !state.activitySort.ascending;
                    else state.activitySort = { key, ascending: key !== 'issuer' ? false : true };
                    renderActivityTable();
                }
            });

            // The funnel's issuer circles are SVG groups, not buttons, so Enter and Space have to be
            // wired by hand; the click itself is already handled by the [data-slug] delegate above.
            if (els.funnelGraphic) {
                els.funnelGraphic.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    const trigger = event.target.closest('[data-slug]');
                    if (!trigger) return;
                    event.preventDefault();
                    openDetail(trigger.getAttribute('data-slug'));
                });
            }

            els.detailClose.addEventListener('click', closeDetail);
            els.detail.addEventListener('close', finalizeDetailClose);
            // Clicking the backdrop: the dialog element itself is the only hit target outside the panel.
            els.detail.addEventListener('click', (event) => {
                if (event.target === els.detail) closeDetail();
            });

            els.filterIssuer.addEventListener('change', () => {
                state.filters.issuer = els.filterIssuer.value;
                state.tokenPage = 1;
                writeTokenViewUrl();
                loadTokenPage();
            });
            els.filterInstrument.addEventListener('change', () => {
                state.filters.instrumentType = els.filterInstrument.value;
                state.tokenPage = 1;
                writeTokenViewUrl();
                loadTokenPage();
            });
            els.globalSearch.addEventListener('input', () => {
                const parsed = parseStockSearch(els.globalSearch.value);
                state.globalQuery = els.globalSearch.value;
                // The global results apply capability intent. The paged API receives only the
                // identity words it understands, so “NVIDIA usable as collateral” still opens the
                // NVIDIA rows instead of trying to match that whole sentence literally.
                state.filters.query = parsed.terms.join(' ');
                renderGlobalSearch();
                state.tokenPage = 1;
                writeTokenViewUrl();
                if (tokenSearchTimer !== null) clearTimeout(tokenSearchTimer);
                tokenSearchTimer = setTimeout(() => {
                    tokenSearchTimer = null;
                    loadTokenPage();
                }, 150);
            });
            els.globalSearch.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    els.globalSearch.value = '';
                    state.globalQuery = '';
                    state.filters.query = '';
                    state.tokenPage = 1;
                    writeTokenViewUrl();
                    renderGlobalSearch();
                    if (state.tokensLoaded) loadTokenPage();
                    return;
                }
                if (event.key !== 'ArrowDown') return;
                const first = els.globalSearchResults.querySelector('a, button');
                if (!first) return;
                event.preventDefault();
                first.focus();
            });
            els.globalSearchResults.addEventListener('keydown', (event) => {
                if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
                if (event.key === 'Escape') {
                    event.preventDefault();
                    els.globalSearch.focus();
                    return;
                }
                const controls = Array.from(els.globalSearchResults.querySelectorAll('a, button'));
                const index = controls.indexOf(document.activeElement);
                if (index < 0) return;
                event.preventDefault();
                controls[(index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length].focus();
            });
            if (els.underlyingFilter) els.underlyingFilter.addEventListener('input', renderUnderlyingDirectory);
            for (const [element, key, eventName] of [
                [els.discrepancyIssuer, 'issuer', 'change'],
                [els.discrepancyAsset, 'asset', 'input'],
                [els.discrepancyImpact, 'impact', 'change'],
                [els.discrepancyStatus, 'status', 'change']
            ]) {
                if (!element) continue;
                element.addEventListener(eventName, () => {
                    state.discrepancyFilters[key] = element.value.trim();
                    renderDiscrepancyDirectory();
                });
            }
            if (els.defiActionFilters) els.defiActionFilters.addEventListener('click', (event) => {
                const button = event.target.closest('[data-defi-action]');
                if (!button) return;
                state.defiAction = button.dataset.defiAction || 'all';
                renderDefiUsage();
            });
            if (els.showAllUnderlyings) els.showAllUnderlyings.addEventListener('click', () => {
                state.underlyingExpanded = true;
                renderUnderlyingDirectory();
            });
            if (els.clearPersonalHome) els.clearPersonalHome.addEventListener('click', () => {
                state.savedItems = normalizeSavedItems(null);
                writeSavedItems();
                renderUnderlyingDirectory();
                renderIssuerCards(state.issuers);
                renderPersonalHome();
            });
            els.tokenPrev.addEventListener('click', () => {
                state.tokenPage = Math.max(1, state.tokenPage - 1);
                writeTokenViewUrl();
                loadTokenPage();
            });
            els.tokenNext.addEventListener('click', () => {
                state.tokenPage += 1;
                writeTokenViewUrl();
                loadTokenPage();
            });
            if (els.tokenColumnPresets && els.tokenTable) {
                els.tokenColumnPresets.addEventListener('click', (event) => {
                    const button = event.target.closest('[data-token-preset]');
                    if (!button) return;
                    applyTokenColumnPreset(button.dataset.tokenPreset, { writeUrl: true });
                });
            }
            els.comparisonUnderlying.addEventListener('change', () => {
                const url = new URL(window.location.href);
                url.searchParams.set('compare', els.comparisonUnderlying.value);
                url.searchParams.delete('wrappers');
                window.history.replaceState(null, '', url);
                renderComparisonTable();
            });
            const writeComparisonSelection = () => {
                const url = new URL(window.location.href);
                url.searchParams.set('wrappers', [...state.comparisonSelected].join(','));
                window.history.replaceState(null, '', url);
            };
            document.getElementById('selectAllComparison')?.addEventListener('click', () => {
                state.comparisonSelected = new Set(state.comparisonModels.map((model) => model.issuerSlug));
                writeComparisonSelection();
                renderComparisonTable();
            });
            document.getElementById('clearComparisonSelection')?.addEventListener('click', () => {
                state.comparisonSelected.clear();
                writeComparisonSelection();
                renderComparisonTable();
            });
            if (els.comparisonProducts) {
                els.comparisonProducts.addEventListener('change', (event) => {
                    const input = event.target.closest('input[type="checkbox"]');
                    if (!input) return;
                    if (input.checked) state.comparisonSelected.add(input.value);
                    else state.comparisonSelected.delete(input.value);
                    writeComparisonSelection();
                    renderComparisonTable();
                });
            }
            if (els.comparisonFilters) {
                els.comparisonFilters.addEventListener('change', (event) => {
                    const input = event.target.closest('input[type="checkbox"]');
                    if (!input) return;
                    if (input.checked) state.comparisonFilters.add(input.value);
                    else state.comparisonFilters.delete(input.value);
                    writeComparisonRequirements();
                    renderComparisonTable();
                });
            }
            if (els.clearComparisonFilters) {
                els.clearComparisonFilters.addEventListener('click', () => {
                    state.comparisonFilters.clear();
                    els.comparisonFilters.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
                    writeComparisonRequirements();
                    renderComparisonTable();
                });
            }
            if (els.saveComparison) els.saveComparison.addEventListener('click', saveCurrentComparison);
            if (els.shareComparison) {
                els.shareComparison.addEventListener('click', async (event) => {
                    event.preventDefault();
                    try {
                        await navigator.clipboard.writeText(els.shareComparison.href);
                        els.comparisonWatchStatus.textContent = 'Read-only cross-device watch link copied. The owner key stays in this browser.';
                    } catch (_) {
                        window.prompt('Copy this cross-device watch link:', els.shareComparison.href);
                    }
                });
            }
        }
    });
}
