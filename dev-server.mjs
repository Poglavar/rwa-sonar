#!/usr/bin/env node
// Tiny no-cache static server for local development. It deliberately serves only this repository
// and has no production role; API-backed pages use the separately started api/ service.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname);
const port = Number(process.env.PORT) || 8113;
const mime = {
    '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.xml': 'application/xml; charset=utf-8'
};

createServer(async (req, res) => {
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
}).listen(port, '127.0.0.1', () => {
    console.log(`RWA Sonar: http://127.0.0.1:${port}/stocks.html`);
});
