#!/usr/bin/env node
// Tiny no-cache static server for local development. It deliberately serves only this repository
// and has no production role; API-backed pages use the separately started api/ service.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname);
const port = Number(process.env.PORT) || 8113;
const apiPort = Number(process.env.API_PORT) || 3300;
const args = new Set(process.argv.slice(2));
const withApi = args.has('--with-api');
const mime = {
    '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.xml': 'application/xml; charset=utf-8'
};

let apiChild = null;

const staticServer = createServer(async (req, res) => {
    try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        let file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (file !== root && !file.startsWith(root + sep)) throw new Error('outside root');
        if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
    } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Not found\n');
    }
});

function pollJson(url, { timeoutMs = 8000 } = {}) {
    const started = Date.now();
    return new Promise((resolvePoll, rejectPoll) => {
        async function check() {
            try {
                const res = await fetch(url, { headers: { accept: 'application/json' } });
                if (res.ok) {
                    resolvePoll(await res.json().catch(() => ({})));
                    return;
                }
            } catch (_) {
                // Keep polling until timeout; the child may still be probing the database.
            }
            if (Date.now() - started >= timeoutMs) {
                rejectPoll(new Error(`${url} did not become ready within ${timeoutMs} ms`));
                return;
            }
            setTimeout(check, 250);
        }
        check();
    });
}

function startApi() {
    apiChild = spawn(process.execPath, ['--env-file-if-exists=.env', 'api/src/server.js'], {
        cwd: root,
        env: { ...process.env, PORT: String(apiPort) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    apiChild.stdout.on('data', (chunk) => process.stdout.write(`[api] ${chunk}`));
    apiChild.stderr.on('data', (chunk) => process.stderr.write(`[api] ${chunk}`));
    apiChild.on('exit', (code, signal) => {
        apiChild = null;
        console.error(`[dev] api exited ${signal || code}`);
    });
    return pollJson(`http://127.0.0.1:${apiPort}/api/health`)
        .then((body) => {
            const counts = body && body.counts ? body.counts : {};
            console.log(`[dev] API ready: http://127.0.0.1:${apiPort}/api/health `
                + `(${counts.tokens ?? '?'} tokens, ${counts.issuers ?? '?'} issuers)`);
        }, (err) => {
            console.error(`[dev] API not ready: ${err.message}`);
            console.error('[dev] static site is still available; API-backed panels will show their unavailable state.');
        });
}

function closeAll(signal = 'SIGTERM') {
    if (apiChild) apiChild.kill(signal);
    staticServer.close(() => process.exit(0));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => closeAll(signal));
}

staticServer.on('error', (err) => {
    console.error(`[dev] static not ready on http://127.0.0.1:${port}: ${err.message}`);
    if (apiChild) apiChild.kill('SIGTERM');
    process.exit(1);
});

staticServer.listen(port, '127.0.0.1', async () => {
    console.log(`[dev] static ready: http://127.0.0.1:${port}/stocks.html`);
    if (withApi) await startApi();
    console.log(`[dev] open: http://127.0.0.1:${port}/stocks.html?api=http://127.0.0.1:${apiPort}`);
});
