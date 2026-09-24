/*
 * The one site header: brand, the four primary links, the "Research" menu and the theme switch, in
 * the markup and order every page family uses (app-shell.css styles it; theme.js drives the switch,
 * and themeScriptHtml() is the tag that loads it in every page's <head>). The ESM builders (cards, issuers, legal
 * templates, protocol dossiers, weekly) render it with siteHeaderHtml(); the hand-written pages carry
 * the same markup and site-header.test.js fails when one of them drifts from it. UMD-wrapped like
 * fmt.js, so a classic script could read window.__rwaSiteNav without a bare global.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaSiteNav = factory();
})(this, function () {
    /** The primary row. `id` is kept stable: tests and older links address the Changes link by it. */
    const PRIMARY = [
        { id: 'nav-stocks', href: 'stocks.html?view=assets', label: 'Explore' },
        { href: 'stocks.html?view=compare', label: 'Compare' },
        { id: 'nav-watch', href: 'watch.html', label: 'Changes' },
        { href: 'learn/', label: 'Learn' }
    ];

    /** The label of the header dropdown, on every page. */
    const MENU_LABEL = 'Research';

    /** The dropdown, grouped by question: meaning first, then evidence, then live monitoring, then about. */
    const RESEARCH = [
        { href: 'methodology.html', label: 'Methodology' },
        { id: 'nav-graph', href: 'graph.html', label: 'Trust map' },
        { href: 'powers.html', label: 'Who holds the keys' },
        { id: 'nav-whatif', href: 'whatif.html', label: 'Failure scenarios' },
        { id: 'nav-templates', href: 'templates/', label: 'Legal templates' },
        { href: 'issuers/', label: 'Issuer dossiers' },
        { href: 'exits.html', label: 'Exit routes' },
        { href: 'flows.html', label: 'Flows & float' },
        { href: 'tracking.html', label: 'Premium & concentration' },
        { href: 'economics.html', label: 'Fees & incentives' },
        { id: 'nav-monitor', href: 'monitor.html', label: 'Health monitor' },
        { id: 'nav-live', href: 'live.html', label: 'Live trades' },
        { id: 'nav-review', href: 'review.html', label: 'Review queue' },
        { href: 'weekly/latest.html', label: 'This week' },
        { href: 'assets.html', label: 'All RWAs' },
        { href: 'pitch/', label: 'Pitch' },
        { href: 'https://github.com/Poglavar/rwa-sonar', label: 'Code', external: true }
    ];

    const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ESCAPES[c]);

    /** Cache-busting stamps for theme.js and its icon sprite. Bump when the file changes. */
    const THEME_JS_VERSION = '20260924y';
    const THEME_ICONS_VERSION = '20260924y';
    /** What the switch says before theme.js has read the stored choice (it relabels on load). */
    const THEME_LABEL = 'Theme: Auto (follows your device)';

    /**
     * theme.js, synchronous, for the <head> of every page BEFORE its first stylesheet: it sets
     * <html data-theme> before first paint, which every stylesheet's dark rules key on.
     */
    function themeScriptHtml(root = './') {
        return `<script src="${root}theme.js?v=${THEME_JS_VERSION}"></script>`;
    }

    /**
     * The theme switch: an icon button at the end of the header row (all three icons, CSS shows the
     * current mode's) and a text copy at the end of the Research menu, which takes its place on a
     * screen too narrow for both (app-shell.css). theme.js cycles the mode on a click of either.
     */
    function themeSwitchHtml(root) {
        const use = (id) => `<use class="theme-icon-${id}" href="${root}images/theme-icons.svg?v=${THEME_ICONS_VERSION}#${id}"/>`;
        return `<button class="theme-switch" type="button" aria-label="${THEME_LABEL}" title="${THEME_LABEL}">`
            + `<svg class="theme-icon" aria-hidden="true" focusable="false">${use('auto')}${use('light')}${use('dark')}</svg></button>`;
    }
    const THEME_MENU_HTML = '<button class="theme-switch theme-switch-menu" type="button">Theme: <span class="theme-switch-state">Auto</span></button>';

    /**
     * The header for a page `root` ('./' or '../') whose own nav entry is `current` (an href from
     * PRIMARY or RESEARCH, e.g. 'watch.html'; null when the page has none).
     */
    function siteHeaderHtml(root = './', current = null) {
        const link = (item, extraClass = '') => {
            const href = item.external ? item.href : root + item.href;
            const attrs = [
                extraClass ? `class="${extraClass}"` : '',
                item.id && !extraClass ? `id="${item.id}"` : '',
                item.href === current ? 'aria-current="page"' : '',
                `href="${esc(href)}"`
            ].filter(Boolean).join(' ');
            return `<a ${attrs}>${esc(item.label)}</a>`;
        };
        const inMenu = RESEARCH.some((item) => item.href === current);
        const learn = PRIMARY.find((item) => item.href === 'learn/');
        return `<header class="app-header">`
            + `<a class="app-brand" href="${root}index.html"><span class="app-brand-mark" aria-hidden="true"></span><span>RWA Sonar</span></a>`
            + `<nav class="app-nav" aria-label="Site navigation">`
            + PRIMARY.map((item) => link(item)).join('')
            + `<details class="app-nav-menu"><summary${inMenu ? ' aria-current="page"' : ''}>${MENU_LABEL}</summary><div>`
            + link(learn, 'nav-compact-only')
            + RESEARCH.map((item) => link(item)).join('')
            + THEME_MENU_HTML
            + `</div></details>${themeSwitchHtml(root)}</nav></header>`;
    }

    return { PRIMARY, RESEARCH, MENU_LABEL, THEME_JS_VERSION, siteHeaderHtml, themeScriptHtml };
});
