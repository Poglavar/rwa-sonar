// Every classic <script> a public page loads shares one global scope with the others: a top-level
// `function foo(){}` or `const foo` in one file is a global, so a second declaration elsewhere
// either silently wins for every caller (functions — the last file loaded is the one that runs) or
// throws "Identifier has already been declared" and kills the page (const/let/class). This parses
// every classic script the public pages and the page builders load and fails on any top-level name
// declared in more than one of them. The allowlist holds the duplicates that existed when the test
// was written (2026-09-23, next-steps.md F11) and may only shrink: an entry that is no longer
// duplicated fails too, so it gets deleted rather than left to hide a new collision.
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { join, dirname, normalize } = require('node:path');
// @babel/parser ships with jest (babel-jest), so parsing needs no dependency of its own.
const { parse } = require('@babel/parser');

const REPO = __dirname;

/**
 * Known duplicates, name -> the files declaring it. New shared code must be UMD-wrapped instead
 * (see stocks/lib/*.js), so this list only ever loses entries.
 */
const ALLOWED_DUPLICATES = {
    // stocks.js takes it from stocks/lib/fmt.js; assets.js keeps its own. Different pages.
    escapeHtml: ['assets.js', 'stocks.js'],
    // A live collision: assets.html loads assets.js (which declares it twice itself) and then
    // asset-modal.js, whose copy therefore wins for both files. stocks.js is on another page.
    isSafeUrl: ['asset-modal.js', 'assets.js', 'stocks.js']
};

/** Top-level names a classic script declares: functions, classes, and every var/let/const binding. */
function topLevelNames(source) {
    const ast = parse(source, { sourceType: 'script', errorRecovery: false });
    const names = [];
    const bind = (id) => {
        if (!id) return;
        if (id.type === 'Identifier') names.push(id.name);
        else if (id.type === 'ObjectPattern') id.properties.forEach((p) => bind(p.type === 'RestElement' ? p.argument : p.value));
        else if (id.type === 'ArrayPattern') id.elements.forEach(bind);
        else if (id.type === 'AssignmentPattern') bind(id.left);
        else if (id.type === 'RestElement') bind(id.argument);
    };
    for (const node of ast.program.body) {
        if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') bind(node.id);
        else if (node.type === 'VariableDeclaration') node.declarations.forEach((d) => bind(d.id));
    }
    return names;
}

/** The public pages: every .html the site serves from its own tree (not design drafts or fixtures). */
function publicPages() {
    const pages = readdirSync(REPO).filter((file) => file.endsWith('.html'));
    for (const dir of ['learn', 'pitch']) {
        if (!existsSync(join(REPO, dir))) continue;
        pages.push(...readdirSync(join(REPO, dir)).filter((file) => file.endsWith('.html')).map((file) => `${dir}/${file}`));
    }
    return pages;
}

/** Repo-relative paths of the local classic scripts one page loads (modules and CDNs skipped). */
function scriptsOf(page, html) {
    const out = [];
    for (const [tag] of html.matchAll(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g)) {
        if (/\btype="module"/.test(tag)) continue;
        const src = /\bsrc="([^"?#]+)/.exec(tag)[1];
        if (/^(?:[a-z]+:)?\/\//i.test(src) || src.startsWith('/')) continue;
        out.push(normalize(join(dirname(page), src)));
    }
    return out;
}

/** Scripts the generated pages (cards/, issuers/, protocols/ …) load, from the builders' templates. */
function builderScripts() {
    const out = [];
    for (const dir of ['stocks', 'stocks/lib']) {
        for (const file of readdirSync(join(REPO, dir)).filter((name) => name.endsWith('.mjs'))) {
            const source = readFileSync(join(REPO, dir, file), 'utf8');
            // Generated pages live one directory down, so `../x.js` is the repo's x.js.
            for (const m of source.matchAll(/<script src="\.\.\/([^"?$]+)/g)) out.push(normalize(m[1]));
        }
    }
    return out;
}

function declarationsByName(files) {
    const byName = new Map();
    for (const file of files) {
        for (const name of new Set(topLevelNames(readFileSync(join(REPO, file), 'utf8')))) {
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push(file);
        }
    }
    return byName;
}

describe('top-level names in the public classic scripts', () => {
    const files = [...new Set([
        ...publicPages().flatMap((page) => scriptsOf(page, readFileSync(join(REPO, page), 'utf8'))),
        ...builderScripts()
    ])].sort();
    const byName = declarationsByName(files);
    const duplicates = Object.fromEntries([...byName].filter(([, where]) => where.length > 1)
        .map(([name, where]) => [name, where.slice().sort()]));

    it('finds the scripts it is meant to guard', () => {
        for (const file of ['stocks.js', 'stocks/lib/fmt.js', 'stocks/lib/issuer-labels.js', 'card.js', 'whatif.js']) {
            expect(files).toContain(file);
        }
        for (const file of files) expect(existsSync(join(REPO, file))).toBe(true);
    });

    it('declares no top-level name in two scripts, beyond the known duplicates', () => {
        const unexpected = Object.entries(duplicates)
            .filter(([name, where]) => JSON.stringify(ALLOWED_DUPLICATES[name]) !== JSON.stringify(where));
        expect(Object.fromEntries(unexpected)).toEqual({});
    });

    it('lets the allowlist only shrink: every entry is still a real duplicate', () => {
        const stale = Object.keys(ALLOWED_DUPLICATES).filter((name) => !duplicates[name]);
        expect(stale).toEqual([]);
    });

    it('catches a collision when there is one, whatever kind of declaration makes it', () => {
        expect(topLevelNames('function a() {}\nconst { b, c: [d] } = x;\nlet e;\nclass F {}\nif (x) { const g = 1; }'))
            .toEqual(['a', 'b', 'd', 'e', 'F']);
        // A UMD module declares nothing at top level, which is the point of wrapping it.
        expect(topLevelNames(readFileSync(join(REPO, 'stocks/lib/issuer-labels.js'), 'utf8'))).toEqual([]);
    });
});
