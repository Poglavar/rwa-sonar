// Dark-mode completeness for the shared app shell: any colour token that body.app-page sets to a
// literal hex value (instead of a --rwa-* palette variable, which flips on its own) must be
// overridden in the dark-mode block, or dark pages get light surfaces under light text.
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

function literalColourTokens(text) {
    return [...text.matchAll(/(--[\w-]+)\s*:\s*#[0-9a-f]{3,8}\b/gi)].map((m) => m[1]);
}

describe('app shell dark-mode tokens', () => {
    const light = block(css, /body\.app-page\s*\{/);
    const darkMedia = [...css.matchAll(/@media \(prefers-color-scheme: dark\)/g)]
        .map((m) => block(css.slice(m.index), /@media/)).join('\n');

    test('every literal colour token on app pages has a dark override', () => {
        const literal = literalColourTokens(light);
        expect(literal.length).toBeGreaterThan(0);
        const missing = literal.filter((token) => !new RegExp(`${token}\\s*:`).test(darkMedia));
        expect(missing).toEqual([]);
    });
});
