// Dark-mode completeness for the shared app shell: any colour token that body.app-page sets to a
// literal hex value (instead of a --rwa-* palette variable, which flips on its own) must be
// overridden in a dark-theme rule (keyed on <html data-theme="dark">, set by theme.js), or dark
// pages get light surfaces under light text.
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, 'app-shell.css'), 'utf8');

function block(source, startPattern) {
    const start = source.search(startPattern);
    if (start < 0) return '';
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
    }
    return '';
}

/** Every rule that applies only in the dark theme (its selector names [data-theme="dark"]), joined. */
function darkRules(source) {
    return [...source.matchAll(/[^{}]*\[data-theme="dark"\][^{}]*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
}

function literalColourTokens(text) {
    return [...text.matchAll(/(--[\w-]+)\s*:\s*#[0-9a-f]{3,8}\b/gi)].map((m) => m[1]);
}

describe('app shell dark-mode tokens', () => {
    const light = block(css, /body\.app-page\s*\{/);
    const dark = darkRules(css);

    test('every literal colour token on app pages has a dark override', () => {
        const literal = literalColourTokens(light);
        expect(literal.length).toBeGreaterThan(0);
        const missing = literal.filter((token) => !new RegExp(`${token}\\s*:`).test(dark));
        expect(missing).toEqual([]);
    });
});

describe('skip link', () => {
    const stocks = fs.readFileSync(path.join(__dirname, 'stocks.css'), 'utf8');
    test('outranks the app-page link colour, and its focus rule outranks its own hidden position', () => {
        // `.app-page a` sets link colour at (0,1,1); a bare `.skip-link` (0,1,0) loses to it.
        expect(stocks).toMatch(/\.app-page \.skip-link\s*[,{][^}]*color:\s*var\(--card-bg\)/);
        expect(stocks).toMatch(/\.app-page \.skip-link:focus\s*\{[^}]*top:\s*12px/);
    });
});

describe('stocks page tokens (its own :root names, aliased to the shared palette)', () => {
    const stocks = fs.readFileSync(path.join(__dirname, 'stocks.css'), 'utf8');
    test('text on accent-filled buttons is the shared on-accent colour, which flips in dark mode', () => {
        expect(stocks).toMatch(/:root\s*\{[^}]*--button-text:\s*var\(--rwa-on-accent\)/);
        const darkBlocks = darkRules(css);
        expect(css).toMatch(/:root\s*\{[^}]*--rwa-on-accent:\s*#ffffff/);
        expect(darkBlocks).toMatch(/--rwa-on-accent:\s*#172033/);
    });
});
