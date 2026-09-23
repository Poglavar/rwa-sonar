// Hosting invariants: every public page runs under the Content-Security-Policy in
// deploy/nginx/rwasonar-headers.conf, which allows no inline scripts or inline event handlers, and the
// versioned nginx site keeps its security headers and real 404.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PAGES = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))
    .concat(['learn/index.html', 'pitch/index.html'])
    .map((f) => path.join(ROOT, f));

/** Executable inline scripts: a <script> with no src whose type is absent or a JavaScript type. */
function inlineScripts(html) {
    const found = [];
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const attrs = m[1];
        if (/\bsrc\s*=/.test(attrs)) continue;
        const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (type && !/javascript|module/i.test(type)) continue; // JSON data blocks never execute
        if (m[2].trim() !== '') found.push(m[2].trim().slice(0, 60));
    }
    return found;
}

describe('pages are compatible with a no-inline-script CSP', () => {
    test.each(PAGES.map((p) => [path.relative(ROOT, p), p]))('%s has no inline scripts or handlers', (_, file) => {
        const html = fs.readFileSync(file, 'utf8');
        expect(inlineScripts(html)).toEqual([]);
        expect(html.match(/\son[a-z]+\s*=\s*["']/gi) || []).toEqual([]);
    });

    test('the detector itself finds an inline script and ignores data blocks', () => {
        expect(inlineScripts('<script>alert(1)</script>')).toHaveLength(1);
        expect(inlineScripts('<script type="application/json">{"a":1}</script>')).toEqual([]);
        expect(inlineScripts('<script src="x.js"></script>')).toEqual([]);
    });
});

describe('versioned nginx config', () => {
    const site = fs.readFileSync(path.join(ROOT, 'deploy/nginx/rwasonar.conf'), 'utf8');
    const headers = fs.readFileSync(path.join(ROOT, 'deploy/nginx/rwasonar-headers.conf'), 'utf8');

    test('unknown paths get a real 404, not the landing page', () => {
        expect(site).toMatch(/error_page 404 \/404\.html;/);
        expect(site).not.toMatch(/try_files \$uri \$uri\/ \/index\.html/);
    });

    test('every location that sets add_header re-includes the security headers', () => {
        const blocks = site.split(/\n\s*location\b/).slice(1);
        for (const block of blocks) {
            const body = block.slice(0, block.indexOf('\n    }'));
            if (/add_header/.test(body)) expect(body).toMatch(/include snippets\/rwasonar-headers\.conf;/);
        }
    });

    test('the headers include HSTS, nosniff, frame and a CSP without unsafe-inline scripts', () => {
        expect(headers).toMatch(/Strict-Transport-Security/);
        expect(headers).toMatch(/X-Content-Type-Options "nosniff"/);
        const csp = headers.match(/Content-Security-Policy(?:-Report-Only)? "([^"]+)"/)[1];
        const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'));
        expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval/);
    });

    test('connect-src allows no Solana RPC host: the browser never talks to the chain', () => {
        const csp = headers.match(/Content-Security-Policy(?:-Report-Only)? "([^"]+)"/)[1];
        const connectSrc = csp.split(';').find((d) => d.trim().startsWith('connect-src'));
        expect(connectSrc).toBeDefined();
        expect(connectSrc).not.toMatch(/solana|publicnode|helius|alchemy|quicknode|triton|syndica|ankr|rpc|wss?:/i);
    });
});
