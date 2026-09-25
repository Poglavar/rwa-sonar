// Unit tests for stocks/lib/fold-rows.mjs: the compact expandable row the generated pages use for
// lists that grow over time (markup of the shared .fold-* styles in app-shell.css).

const { foldAnchor, foldListHtml, foldPlain, foldRowHtml, foldToneClass, foldWhen } = require('./lib/fold-rows.mjs');

describe('fold rows', () => {
    it('renders one row: tone, id, a two-line summary and the full body', () => {
        const html = foldRowHtml({ id: 'discrepancy-a', tone: 'warning', when: '23 Sep 2026', chip: 'warning', title: 'Docs say 3 of 5', meta: 'Loopscale', line2: 'The chain is stricter.', body: '<p>Full <a href="https://example.com">source</a></p>' });
        expect(html).toBe('<li id="discrepancy-a" class="fold-row fold-warning"><details><summary>'
            + '<span class="fold-line1">23 Sep 2026 · <b class="fold-chip">warning</b> <strong class="fold-title">Docs say 3 of 5</strong> · Loopscale</span>'
            + '<span class="fold-line2">The chain is stricter.</span></summary>'
            + '<div class="fold-body"><p>Full <a href="https://example.com">source</a></p></div></details></li>');
    });

    it('escapes every plain-text field and leaves out what is missing', () => {
        const html = foldRowHtml({ title: '<img src=x onerror=alert(1)>', line2: '<script>', meta: '"quoted"', chip: '<b>', body: '' });
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).toContain('&quot;quoted&quot;');
        expect(foldRowHtml({ title: 'T', body: 'B' })).toBe('<li class="fold-row"><details><summary><span class="fold-line1"><strong class="fold-title">T</strong></span></summary><div class="fold-body">B</div></details></li>');
    });

    it('opens a row on request and takes a page\'s own chip and line-2 markup', () => {
        const html = foldRowHtml({ title: 'T', chipHtml: '<span class="cm-l">stale</span>', line2Html: 'a &amp; b', body: 'B', open: true });
        expect(html).toContain('<details open>');
        expect(html).toContain('<span class="cm-l">stale</span> <strong');
        expect(html).toContain('<span class="fold-line2">a &amp; b</span>');
    });

    it('maps only known severities to a tone and makes safe anchors', () => {
        expect(foldToneClass('critical')).toBe(' fold-critical');
        expect(foldToneClass('bogus')).toBe('');
        expect(foldToneClass(null)).toBe('');
        expect(foldAnchor('discrepancy', 'proof-of-reserves coverage/2')).toBe('discrepancy-proof-of-reserves-coverage-2');
        expect(foldAnchor('material', null)).toBeNull();
        expect(foldAnchor('material', 139)).toBe('material-139');
    });

    it('formats a short date, or none, and strips tags for a summary line', () => {
        expect(foldWhen('2026-09-23')).toBe('23 Sep 2026');
        expect(foldWhen('2026-09-22T16:47:12Z')).toBe('22 Sep 2026');
        expect(foldWhen(null)).toBeNull();
        expect(foldWhen('not a date')).toBeNull();
        expect(foldPlain('<b>Nest</b> values it at <a href="x">Pyth</a>, &amp; more')).toBe('Nest values it at Pyth, &amp; more');
    });

    it('wraps rows in the list, and renders nothing for no rows', () => {
        expect(foldListHtml([{ title: 'A', body: '' }], { className: 'cm-f' })).toMatch(/^<ul class="fold-list cm-f"><li class="fold-row">/);
        expect(foldListHtml([])).toBe('');
    });
});
