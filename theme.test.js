// The site-wide theme switch (theme.js): the pure mode logic, the browser wiring run against a fake
// document (storage that throws included), and the invariants the switch depends on — no stylesheet
// or page template keys on prefers-color-scheme any more, and every page, hand-written or generated,
// loads theme.js in its <head> before its first stylesheet and carries the switch in its header.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MODES, STORAGE_KEY, modeLabel, nextMode, normalizeMode, resolveTheme } = require('./theme.js');
const { THEME_JS_VERSION, siteHeaderHtml, themeScriptHtml } = require('./stocks/lib/site-nav.js');

const ROOT = __dirname;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const THEME_SOURCE = read('theme.js');

describe('mode logic', () => {
    test('Auto follows the device; Light and Dark ignore it', () => {
        expect(resolveTheme('auto', true)).toBe('dark');
        expect(resolveTheme('auto', false)).toBe('light');
        expect(resolveTheme('light', true)).toBe('light');
        expect(resolveTheme('dark', false)).toBe('dark');
    });

    test('nothing stored, or anything unrecognised, is Auto', () => {
        for (const value of [null, undefined, '', 'Dark', 'sepia', 42]) expect(normalizeMode(value)).toBe('auto');
        expect(resolveTheme(null, true)).toBe('dark');
        expect(resolveTheme('sepia', false)).toBe('light');
    });

    test('a click cycles Auto → Light → Dark → Auto', () => {
        expect(MODES).toEqual(['auto', 'light', 'dark']);
        expect(nextMode('auto')).toBe('light');
        expect(nextMode('light')).toBe('dark');
        expect(nextMode('dark')).toBe('auto');
        expect(nextMode(null)).toBe('light');
    });

    test('the label names the mode, and Auto says it follows the device', () => {
        expect(modeLabel('auto')).toBe('Theme: Auto (follows your device)');
        expect(modeLabel('light')).toBe('Theme: Light');
        expect(modeLabel('dark')).toBe('Theme: Dark');
    });
});

/**
 * Runs theme.js as the browser would, against a fake document with two switches (row and menu copy).
 * `storage` is a Map-backed localStorage, or 'throws' for one whose every access throws.
 */
function boot({ stored = null, systemDark = false, storage = 'map' } = {}) {
    class Element {
        constructor(isSwitch) { this.isSwitch = isSwitch; this.attrs = {}; this.title = ''; this.state = { textContent: '' }; }
        setAttribute(name, value) { this.attrs[name] = String(value); }
        closest(selector) { return selector === '.theme-switch' && this.isSwitch ? this : null; }
        querySelector(selector) { return selector === '.theme-switch-state' ? this.state : null; }
    }
    const html = new Element(false);
    const switches = [new Element(true), new Element(true)];
    const listeners = {};
    const on = (target) => (type, fn) => { listeners[`${target}:${type}`] = fn; };
    const media = { matches: systemDark, addEventListener: on('media') };
    const values = new Map(stored === null ? [] : [[STORAGE_KEY, stored]]);
    const localStorage = storage === 'throws'
        ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } }
        : { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
    const document = {
        documentElement: html,
        readyState: 'complete',
        querySelectorAll: (selector) => (selector === '.theme-switch' ? switches : []),
        addEventListener: on('document')
    };
    const window = { localStorage, matchMedia: () => media, addEventListener: on('window') };
    vm.runInNewContext(THEME_SOURCE, { window, document, Element });
    return {
        theme: () => html.attrs['data-theme'],
        mode: () => html.attrs['data-theme-mode'],
        labels: () => switches.map((button) => button.attrs['aria-label']),
        stored: () => values.get(STORAGE_KEY) ?? null,
        storeElsewhere: (value) => values.set(STORAGE_KEY, value),
        fire: (name, event) => listeners[`window:${name}`](event),
        click: (target = switches[0]) => listeners['document:click']({ target }),
        systemChange: (dark) => { media.matches = dark; listeners['media:change'](); },
        outside: new Element(false),
        menuText: () => switches[1].state.textContent
    };
}

describe('browser wiring', () => {
    test('a stored choice wins over the device, before anything paints', () => {
        const page = boot({ stored: 'dark', systemDark: false });
        expect(page.theme()).toBe('dark');
        expect(page.mode()).toBe('dark');
        expect(page.labels()).toEqual(['Theme: Dark', 'Theme: Dark']);
        expect(page.menuText()).toBe('Dark');
        expect(boot({ stored: 'light', systemDark: true }).theme()).toBe('light');
    });

    test('Auto follows a live device change; a forced theme does not', () => {
        const auto = boot({ systemDark: true });
        expect([auto.mode(), auto.theme()]).toEqual(['auto', 'dark']);
        auto.systemChange(false);
        expect(auto.theme()).toBe('light');
        const forced = boot({ stored: 'dark', systemDark: true });
        forced.systemChange(false);
        expect(forced.theme()).toBe('dark');
    });

    test('a click on either switch cycles the mode and remembers it; Auto clears the memory', () => {
        const page = boot({ systemDark: true });
        page.click();
        expect([page.mode(), page.theme(), page.stored()]).toEqual(['light', 'light', 'light']);
        page.click();
        expect([page.mode(), page.theme(), page.stored()]).toEqual(['dark', 'dark', 'dark']);
        page.click();
        expect([page.mode(), page.theme(), page.stored()]).toEqual(['auto', 'dark', null]);
        page.click(page.outside);
        expect(page.mode()).toBe('auto');
        expect(page.labels()).toEqual(['Theme: Auto (follows your device)', 'Theme: Auto (follows your device)']);
    });

    test('a choice made in another tab, or on a page left by Back, reaches this page', () => {
        const page = boot({ systemDark: false });
        page.storeElsewhere('dark');
        page.fire('pageshow', { persisted: false });
        expect(page.theme()).toBe('light');
        page.fire('pageshow', { persisted: true });
        expect(page.theme()).toBe('dark');
        page.storeElsewhere('light');
        page.fire('storage', { key: STORAGE_KEY });
        expect(page.theme()).toBe('light');
    });

    test('storage that throws on every access still gives a theme and a working switch', () => {
        const page = boot({ storage: 'throws', systemDark: true });
        expect(page.theme()).toBe('dark');
        expect(() => page.click()).not.toThrow();
        expect(page.theme()).toBe('light');
    });
});

/** Every file under `dir` with one of `exts`, skipping dependencies, fixtures, fetched third-party
 *  documents (stocks/data) and the generated families (checked from their builders below). */
function walk(dir, exts, out = []) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (['node_modules', '.git', 'fixtures', 'data', 'tmp', 'cards', 'weekly', 'templates', 'issuers', 'protocols'].includes(entry.name)) continue;
            walk(rel, exts, out);
        } else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(rel);
    }
    return out;
}

describe('the theme is the attribute, not the media query', () => {
    const sheets = walk('.', ['.css']);

    test.each(sheets)('%s has no prefers-color-scheme rule', (file) => {
        expect(read(file)).not.toContain('prefers-color-scheme');
    });

    test('the page builders and every hand-written page keep no prefers-color-scheme either', () => {
        expect(sheets.length).toBeGreaterThan(20);
        const sources = [...walk('stocks/lib', ['.mjs', '.js']), ...walk('.', ['.html'])].filter((file) => !file.endsWith('.test.js'));
        const offenders = sources.filter((file) => read(file).includes('prefers-color-scheme'));
        expect(offenders).toEqual([]);
    });

    test('dark rules key on data-theme with the specificity they had', () => {
        const shell = read('app-shell.css');
        expect(shell).toContain(':root:where([data-theme="dark"]) {\n    --rwa-ink: #f4f1e9;');
        expect(shell).toContain(':where(html[data-theme="dark"]) body.app-page {');
        expect(shell).toMatch(/:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
    });
});

/** theme.js loaded synchronously in <head>, before the first stylesheet. */
function expectThemeFirst(html, root) {
    const head = html.slice(0, html.indexOf('</head>'));
    const script = head.indexOf(themeScriptHtml(root));
    expect(script).toBeGreaterThan(-1);
    const firstSheet = head.search(/<link rel="stylesheet"/);
    expect(firstSheet).toBeGreaterThan(script);
    expect(head.match(/theme\.js\?v=/g)).toHaveLength(1);
}

/** The header carries the icon switch in its row and the text copy in its Research menu. */
function expectSwitch(html) {
    const header = (html.match(/<header class="app-header">[\s\S]*?<\/header>/) || [''])[0];
    expect(header).toContain('<button class="theme-switch" type="button" aria-label="Theme: Auto (follows your device)"');
    expect(header).toContain('<button class="theme-switch theme-switch-menu" type="button">');
    expect(header).toMatch(/images\/theme-icons\.svg\?v=\d{8}[a-z]#auto/);
}

describe('every page loads theme.js first and carries the switch', () => {
    const rootPages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html') && f !== 'sonar-animation.html');
    const learnPages = fs.readdirSync(path.join(ROOT, 'learn')).filter((f) => f.endsWith('.html')).map((f) => `learn/${f}`);
    const rootOf = (file) => (file === '404.html' ? '/' : file.includes('/') ? '../' : './');
    // The card shim has no header (it redirects), and the pitch deck keeps its own deck bar and
    // fixed dark stage (README "UI roles"): both load theme.js, neither shows a switch.
    const NO_SWITCH = new Set(['card.html', 'pitch/index.html']);

    test.each([...rootPages, ...learnPages, 'pitch/index.html'])('%s', (file) => {
        const html = read(file);
        expectThemeFirst(html, rootOf(file));
        if (NO_SWITCH.has(file)) expect(html).not.toContain('theme-switch');
        else expectSwitch(html);
    });

    test('the one header renders the switch with icons from the page root, and theme.js is stamped', () => {
        expect(THEME_JS_VERSION).toMatch(/^\d{8}[a-z]$/);
        expectSwitch(siteHeaderHtml('../'));
        expect(siteHeaderHtml('../')).toContain('href="../images/theme-icons.svg?v=');
        expect(siteHeaderHtml('/')).toContain('href="/images/theme-icons.svg?v=');
        for (const id of ['auto', 'light', 'dark']) expect(read('images/theme-icons.svg')).toContain(`<symbol id="${id}"`);
    });
});

describe('generated families load theme.js first and carry the switch', () => {
    const { assignSlugs, buildCard, renderCard } = require('./stocks/lib/cards.mjs');
    const { renderIssuerIndex, renderIssuerPage } = require('./stocks/lib/issuer-pages.mjs');
    const { renderTemplateIndex, renderTemplatePage } = require('./stocks/lib/template-pages.mjs');
    const { buildProtocolDossiers, renderProtocolDossier, renderProtocolIndex } = require('./stocks/lib/protocol-dossiers.mjs');
    const { buildWeek, renderWeekPage, renderWeeklyIndex, weekFromId } = require('./stocks/lib/weekly.mjs');
    const json = (file) => JSON.parse(read(file));
    const tokenDb = json('stocks-tokens.json');
    const issuerDb = json('stocks-issuers.json');
    const templates = json('stocks-legal-templates.json').templates;
    const options = { baseUrl: 'https://rwasonar.com', version: 'test' };

    const token = tokenDb.tokens.find((row) => row.symbol === 'NVDAx');
    const issuer = issuerDb.issuers.find((row) => row.slug === token.issuer);
    const dossiers = buildProtocolDossiers({ tokens: tokenDb.tokens, issuers: issuerDb.issuers, usage: json('stocks/data/defi-usage.json'),
        templates: json('stocks/data/composability-templates.json').templates });
    const week = buildWeek(weekFromId('2026-W39'), weekFromId('2026-W38'), '2026-09-24T12:00:00Z', {
        snapshots: [], diffs: [], tokens: [], issuers: [], journal: [], material: [], events: [], trades: null,
        sources: {}, recordsBeginOn: '2026-09-16', slugs: {}, protocolPages: {}
    });
    const pages = [
        ['card', renderCard(buildCard({ token, issuer, slug: assignSlugs(tokenDb.tokens).get(token.mint), builtAt: '2026-09-24T00:00:00Z' }), options)],
        ['issuer dossier', renderIssuerPage({ issuer, tokens: tokenDb.tokens.filter((t) => t.issuer === issuer.slug), templates, builtAt: issuerDb.builtAt }, options)],
        ['issuer index', renderIssuerIndex(issuerDb.issuers, options)],
        ['legal template', renderTemplatePage(templates[0], options)],
        ['template index', renderTemplateIndex(templates, options)],
        ['protocol dossier', renderProtocolDossier(dossiers[0], options)],
        ['protocol index', renderProtocolIndex(dossiers, options)],
        ['weekly digest', renderWeekPage(week, options)],
        ['weekly index', renderWeeklyIndex([week], options)]
    ];

    test.each(pages)('%s', (_, html) => {
        expectThemeFirst(html, '../');
        expectSwitch(html);
        expect(html).not.toContain('prefers-color-scheme');
    });
});
