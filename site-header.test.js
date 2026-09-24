// Locks the site-wide UI roles (README.md, "UI roles"): every page carries the one site header from
// stocks/lib/site-nav.js and links the shared palette in app-shell.css, and no other stylesheet
// redefines a role or keeps its own copy of the palette. A page drifting from any of these fails here.
const fs = require('fs');
const path = require('path');
const { siteHeaderHtml, PRIMARY, RESEARCH, MENU_LABEL } = require('./stocks/lib/site-nav.js');

const ROOT = __dirname;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const learnPages = fs.readdirSync(path.join(ROOT, 'learn')).filter((f) => f.endsWith('.html')).map((f) => `learn/${f}`);

/** Hand-written pages with the site header: [file, link root, own nav entry]. */
const PAGES = [
    ['index.html', './', null], ['stocks.html', './', null], ['assets.html', './', 'assets.html'],
    ...['powers', 'flows', 'tracking', 'exits', 'whatif', 'watch', 'monitor', 'live', 'graph', 'economics', 'methodology', 'review']
        .map((name) => [`${name}.html`, './', `${name}.html`]),
    ...learnPages.map((file) => [file, '../', 'learn/']),
    ['404.html', '/', null]
];

const headerOf = (html) => (html.match(/<header[\s\S]*?<\/header>/) || [''])[0];

describe('the one site header', () => {
    test.each(PAGES)('%s carries the canonical header', (file, root, current) => {
        expect(headerOf(read(file))).toBe(siteHeaderHtml(root, current));
    });

    test.each(PAGES)('%s links the shared palette and the menu closer, cache-busted', (file, root) => {
        const html = read(file);
        const prefix = { './': '(\\./)?', '../': '\\.\\./', '/': '/' }[root];
        expect(html).toMatch(new RegExp(`href="${prefix}app-shell\\.css\\?v=\\d{8}[a-z]"`));
        expect(html).toMatch(/nav-menus\.js\?v=\d{8}[a-z]"/);
    });

    test('the header has the four primary links, the Research menu, and a compact Learn copy', () => {
        const header = siteHeaderHtml('./', 'watch.html');
        expect(PRIMARY.map((item) => item.label)).toEqual(['Explore', 'Compare', 'Changes', 'Learn']);
        expect(MENU_LABEL).toBe('Research');
        expect(header).toContain('<summary>Research</summary>');
        expect(header).toContain('<a class="nav-compact-only" href="./learn/">Learn</a>');
        expect(header).toContain('<a id="nav-watch" aria-current="page" href="./watch.html">Changes</a>');
        // A page in the menu marks the menu itself current, so the open section is visible when closed.
        expect(siteHeaderHtml('./', 'powers.html')).toContain('<summary aria-current="page">Research</summary>');
        // External links keep their absolute URL whatever the page depth.
        expect(siteHeaderHtml('../')).toContain('href="https://github.com/Poglavar/rwa-sonar"');
        expect(new Set(RESEARCH.map((item) => item.href)).size).toBe(RESEARCH.length);
    });

    test('the generated families render the same header and link the shared palette', () => {
        for (const lib of ['cards', 'issuer-pages', 'template-pages', 'weekly', 'protocol-dossiers']) {
            const source = read(`stocks/lib/${lib}.mjs`);
            expect(source).toContain('siteNav.siteHeaderHtml(');
            expect(source).not.toContain('class="site-head"');
            expect(source).toMatch(/app-shell\.css/);
        }
    });
});

describe('UI roles live in app-shell.css only', () => {
    const shell = read('app-shell.css');
    const sheets = [...fs.readdirSync(ROOT).filter((f) => f.endsWith('.css') && f !== 'app-shell.css'), 'pitch/pitch.css'];
    const pageSheets = sheets.filter((f) => f !== 'pitch/pitch.css'); // the deck keeps its own dark stage

    test('the shell defines the palette and every role class', () => {
        for (const token of ['--rwa-ink', '--rwa-paper', '--rwa-panel', '--rwa-cobalt', '--rwa-cobalt-dark', '--rwa-on-accent',
            '--rwa-coral-text', '--rwa-pressed-bg', '--rwa-focus', '--rwa-font', '--rwa-display']) {
            expect(shell).toMatch(new RegExp(`${token}:`));
        }
        for (const role of ['.button {', '.button-primary', '.eyebrow {', ':focus-visible { outline: var(--rwa-focus)']) expect(shell).toContain(role);
    });

    test.each(sheets)('%s does not redefine the shared palette', (file) => {
        expect(read(file)).not.toMatch(/--rwa-[\w-]+\s*:/);
    });

    test.each(pageSheets)('%s aliases its base colours instead of copying them', (file) => {
        const css = read(file);
        const roots = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
        const base = ['--ink', '--paper', '--panel', '--line', '--muted', '--bg', '--text', '--page-bg', '--page-text',
            '--panel-border', '--muted-text', '--card-bg', '--link-color', '--accent', '--control-bg', '--control-border'];
        const literal = base.filter((token) => new RegExp(`(^|[\\s;{])${token}\\s*:\\s*#`).test(roots));
        expect(literal).toEqual([]);
    });

    test.each(pageSheets)('%s keeps the role rules to the shell', (file) => {
        const css = read(file);
        // A base definition of a role (a rule that starts with it), not a contextual tweak like `.hero-actions .button`.
        expect(css).not.toMatch(/(^|\})\s*\.button(-primary)?\s*[,{]/m);
        expect(css).not.toMatch(/(^|\})\s*\.eyebrow\s*\{/m);
        expect(css).not.toMatch(/(^|\})\s*(:is\([^)]*\))?:focus-visible\s*\{/m);
        expect(css).not.toMatch(/body\s*\{[^}]*font-family:\s*system-ui/);
    });
});
