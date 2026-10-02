// Minimal .env reader for the one secret this pipeline needs (PYTH_API_KEY), so nothing has to be
// exported into the shell before a run and no npm dependency is added. Parsing is pure and unit
// tested (see ../pyth.test.js); a missing file is not an error, it just yields no variables.
// Values are never logged anywhere — callers only ever report whether a key was present.

import { readFile } from 'node:fs/promises';

/**
 * Parse `KEY=value` lines. Blank lines and `#` comments are skipped, a leading `export ` is
 * tolerated, surrounding single/double quotes are stripped and an unquoted value is trimmed.
 * The first `=` splits, so a value may itself contain `=`. Later duplicates win, as in a shell.
 */
export function parseEnv(text) {
    const out = {};
    if (typeof text !== 'string') return out;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;
        const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
        const eq = withoutExport.indexOf('=');
        if (eq <= 0) continue;
        const key = withoutExport.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        let value = withoutExport.slice(eq + 1).trim();
        const quote = value[0];
        if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

/** Read and parse a .env file. An absent file yields `{}`; any other read error throws. */
export async function readEnvFile(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
    }
    return parseEnv(text);
}
