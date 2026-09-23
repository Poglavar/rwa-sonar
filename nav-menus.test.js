// The shared header-menu closer: which open menus a click closes, and that every page with a
// header dropdown loads it (a <details> menu otherwise ignores Escape and outside clicks).
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { menusToClose } = require('./nav-menus.js');

const fakeMenu = (inside) => ({ contains: (node) => inside.includes(node) });

test('a click closes the menus it landed outside of and keeps the one it landed in', () => {
    const a = fakeMenu(['a-link']);
    const b = fakeMenu(['b-link']);
    expect(menusToClose([a, b], 'b-link')).toEqual([a]);
    expect(menusToClose([a, b], 'page-body')).toEqual([a, b]);
});

test('every page with a header dropdown loads nav-menus.js, and a hidden header link is in its menu', () => {
    for (const page of ['index.html', 'stocks.html', 'whatif.html', 'monitor.html', 'watch.html', 'live.html', 'graph.html']) {
        const html = readFileSync(join(__dirname, page), 'utf8');
        const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
        expect(header).toContain('<details');
        expect(html).toMatch(/<script src="nav-menus\.js\?v=/);
        // Learn is the link a phone-width header drops; the menu must carry it.
        expect(header).toMatch(/class="nav-compact-only" href="\.\/learn\/"/);
    }
});
