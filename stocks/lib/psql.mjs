// Running SQL through the `psql` client over a child process, which is how this pipeline talks to
// Postgres: it has zero npm dependencies, so there is no driver. Extracted from stocks/load-db.mjs
// so stocks/watch-sources.mjs loads the same way instead of growing a second copy. DATABASE_URL is
// passed to the child and never logged — `describeUrl` is what a run is allowed to print.

import { spawn } from 'node:child_process';

import { logWarn } from './io.mjs';

/** Host, port and database only — never the user, never the password. */
export function describeUrl(url) {
    try {
        const u = new URL(url);
        return `${u.hostname}:${u.port || '5432'}/${decodeURIComponent(u.pathname).replace(/^\//, '')}`;
    } catch {
        return '(DATABASE_URL is not a parseable URL)';
    }
}

/**
 * Run SQL through psql on stdin. ON_ERROR_STOP makes the first error abort, -X ignores any local
 * .psqlrc and -q keeps the output to what the SQL itself prints. A non-zero exit is thrown with
 * psql's own stderr attached; nothing is ever swallowed.
 */
export function psql(url, sqlText, label, extraArgs = []) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn('psql', ['-v', 'ON_ERROR_STOP=1', '-X', '-q', ...extraArgs, url], {
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => rejectPromise(new Error(`cannot run psql (${label}): ${e.message}`)));
        child.on('close', (code) => {
            if (code !== 0) {
                rejectPromise(new Error(`psql exited ${code} on ${label}\n${err.trim() || out.trim()}`));
                return;
            }
            if (err.trim()) logWarn(`${label}: ${err.trim()}`);
            resolvePromise(out);
        });
        child.stdin.on('error', (e) => rejectPromise(new Error(`psql stdin (${label}): ${e.message}`)));
        child.stdin.end(sqlText);
    });
}
