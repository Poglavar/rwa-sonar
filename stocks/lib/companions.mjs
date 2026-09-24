// Host-specific machine-readable companions for cited pages a plain fetch cannot read: the SAME
// publisher's own API for the page a browser would render. npmjs.com answers every scripted
// client with a Cloudflare challenge (403) while npm's registry serves the package document —
// description, dist-tags and README — as JSON; crates.io renders its crate page in the browser
// (an empty Ember shell to a fetch) while its documented API serves the crate record. The watcher
// reads the companion only after the live page refused or rendered nothing, keeps the cited URL
// as the source, and records the companion URL beside the result, so a companion read is never
// mistaken for a read of the page itself. securitize.io is a React app whose disclosures are
// Builder.io CMS entries fetched in the browser; the same entries come from Builder's content API.
// A Solscan transaction page (403 bot wall, never archived) describes an on-chain transaction; the
// chain itself is the primary record, so its companion is Solana RPC `getTransaction`, rendered as
// the text a reader of the explorer page relies on (logs, decoded instructions, balance changes).
// Pure: no network here (watch-sources.mjs does the IO).

import { htmlToText } from './watch.mjs';

/**
 * securitize.io's PUBLIC Builder.io API key, as shipped in its own bundle
 * (`REACT_APP_BUILDER_PUBLIC_API_KEY` in https://securitize.io/static/js/main.*.js, read
 * 2026-09-23). It is the key every visitor's browser uses to load these pages, not a credential of
 * ours. A 401/403 from the content API means Securitize rotated it: read the new one from the bundle.
 */
const SECURITIZE_BUILDER_KEY = 'd39b51a544e84e2fbb2445f58c6c6f2c';
const BUILDER_CONTENT = 'https://cdn.builder.io/api/v3/content';

/** `{url, reader}` for a cited page with a same-publisher companion, or null. */
export function companionFor(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'www.npmjs.com' || host === 'npmjs.com') {
        // /package/<name> or /package/@scope/<name>; nothing else on npmjs.com is a package page.
        const m = parsed.pathname.match(/^\/package\/((?:@[^/]+\/)?[^/]+)\/?$/);
        if (!m) return null;
        const name = decodeURIComponent(m[1]);
        return { url: `https://registry.npmjs.org/${name.replace('/', '%2f')}`, reader: 'npm-registry' };
    }
    if (host === 'securitize.io' || host === 'www.securitize.io') {
        // /disclosure/<name> is an entry of the `legal` model named by that slug; the library page
        // is the single `disclosure-library` entry (its list of linked disclosures).
        const legal = parsed.pathname.match(/^\/disclosure\/([a-z0-9-]+)\/?$/);
        if (legal) {
            return { url: `${BUILDER_CONTENT}/legal?apiKey=${SECURITIZE_BUILDER_KEY}&query.name=${legal[1]}&limit=1`, reader: 'builder-content' };
        }
        if (/^\/disclosure-library\/?$/.test(parsed.pathname)) {
            return { url: `${BUILDER_CONTENT}/disclosure-library?apiKey=${SECURITIZE_BUILDER_KEY}&limit=1`, reader: 'builder-content' };
        }
        return null;
    }
    if (host === 'solscan.io' || host === 'www.solscan.io') {
        // /tx/<signature>: a base58 signature (64 bytes -> 86-88 characters). The companion is an
        // RPC call, not a URL: `url` is a key-free descriptor for the checkpoint and state file,
        // and the watcher sends `rpc` to the Solana RPC configured in .env (SOLANA_RPC_URL).
        const m = parsed.pathname.match(/^\/tx\/([1-9A-HJ-NP-Za-km-z]{64,90})\/?$/);
        if (!m) return null;
        return {
            url: `solana-rpc:getTransaction:${m[1]}`,
            reader: 'solana-tx',
            rpc: { method: 'getTransaction', params: [m[1], { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }] }
        };
    }
    if (host === 'crates.io') {
        const m = parsed.pathname.match(/^\/crates\/([A-Za-z0-9_-]+)\/?$/);
        if (!m) return null;
        return { url: `https://crates.io/api/v1/crates/${m[1]}`, reader: 'crates-api' };
    }
    return null;
}

const line = (label, value) => (typeof value === 'string' && value.trim() !== '' ? `${label}: ${value.trim()}` : null);

/**
 * The companion's JSON -> the text a reader of the cited page sees, without the fields that move
 * on every publish of anything (download counts, `time.modified`, `updated_at`). Throws on a body
 * that is not the expected document, so a changed API shape is an error, not an empty "document".
 */
export function companionText(reader, body) {
    const doc = typeof body === 'string' ? JSON.parse(body) : body;
    if (reader === 'npm-registry') {
        if (typeof doc?.name !== 'string') throw new Error('npm registry: no package name in the answer');
        const latest = doc['dist-tags']?.latest ?? null;
        const version = latest ? doc.versions?.[latest] : null;
        return [
            line('package', doc.name),
            line('description', doc.description ?? version?.description),
            line('latest version', latest),
            line('license', typeof doc.license === 'string' ? doc.license : version?.license),
            line('repository', typeof doc.repository === 'string' ? doc.repository : doc.repository?.url),
            line('homepage', doc.homepage),
            typeof doc.readme === 'string' ? doc.readme : null
        ].filter((x) => x !== null).join('\n');
    }
    if (reader === 'crates-api') {
        const crate = doc?.crate;
        if (typeof crate?.name !== 'string') throw new Error('crates.io api: no crate name in the answer');
        return [
            line('crate', crate.name),
            line('description', crate.description),
            line('newest version', crate.max_stable_version ?? crate.newest_version ?? crate.max_version),
            line('repository', crate.repository),
            line('homepage', crate.homepage),
            line('documentation', crate.documentation)
        ].filter((x) => x !== null).join('\n');
    }
    if (reader === 'builder-content') {
        const entry = Array.isArray(doc?.results) ? doc.results[0] : null;
        if (!entry?.data || typeof entry.data !== 'object') throw new Error('builder content: no entry in the answer');
        const html = [];
        const visit = (node) => {
            if (Array.isArray(node)) {
                node.forEach(visit);
                return;
            }
            if (!node || typeof node !== 'object') return;
            // Text components carry the page's words as HTML; everything else is layout.
            if (node.component?.name === 'Text' && typeof node.component.options?.text === 'string') html.push(node.component.options.text);
            if (Array.isArray(node.children)) visit(node.children);
            if (Array.isArray(node.blocks)) visit(node.blocks);
        };
        visit(entry.data.blocks);
        const links = Array.isArray(entry.data.links)
            ? entry.data.links.filter((l) => typeof l?.label === 'string').map((l) => `${l.label} — ${l.url ?? ''}`.trim())
            : [];
        const text = [line('title', entry.data.title), ...links, html.length ? htmlToText(html.join('\n'), { forQuotes: true }) : null]
            .filter((x) => x !== null && x !== '').join('\n');
        if (html.length === 0 && links.length === 0) throw new Error('builder content: the entry has no text blocks or links');
        return text;
    }
    if (reader === 'solana-tx') return solanaTxText(doc);
    throw new Error(`unknown companion reader ${reader}`);
}

/** A base-unit integer string at `decimals` as a plain decimal string, trailing zeros trimmed. */
export function formatUnits(amount, decimals) {
    const raw = BigInt(amount);
    const negative = raw < 0n;
    const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
    const whole = digits.slice(0, digits.length - decimals);
    const fraction = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** One decoded instruction's fields: the amount first, then the rest by key, one `key value` each. */
function instructionFields(info) {
    if (!info || typeof info !== 'object') return '';
    const value = (v) => {
        if (v && typeof v === 'object') {
            if (typeof v.uiAmountString === 'string') return v.uiAmountString;
            return JSON.stringify(v);
        }
        return String(v);
    };
    const amountKey = ['tokenAmount', 'amount'].find((k) => info[k] !== undefined);
    const fields = amountKey ? [`amount ${value(info[amountKey])}`] : [];
    for (const key of Object.keys(info).sort()) {
        if (key === amountKey) continue;
        fields.push(`${key} ${value(info[key])}`);
    }
    return fields.join(', ');
}

function instructionLine(tag, ix) {
    if (ix?.parsed && typeof ix.parsed === 'object') {
        return `${tag} ${ix.program ?? ix.programId} ${ix.parsed.type}: ${instructionFields(ix.parsed.info)}`;
    }
    // A program without a public IDL in the RPC's parser: its data bytes mean nothing as text.
    return `${tag} program ${ix?.programId ?? 'unknown'} (not decoded)`;
}

/**
 * A `getTransaction` (jsonParsed) answer -> text, in a fixed order a quote can rely on: identity
 * (signature, slot, block time from the chain's own `blockTime`, status, signers), every program
 * log line verbatim, every top-level and inner instruction with its decoded fields, and each token
 * account's balance change. A finalized transaction never changes, so neither does this text.
 * Throws on a null answer (not found, or not yet finalized): that is not an empty document.
 */
export function solanaTxText(tx) {
    if (!tx || typeof tx !== 'object' || !tx.transaction?.message) throw new Error('solana rpc: transaction not found');
    const message = tx.transaction.message;
    const keys = Array.isArray(message.accountKeys) ? message.accountKeys : [];
    const pubkey = (k) => (typeof k === 'string' ? k : k?.pubkey);
    const signers = keys.filter((k) => k?.signer === true).map(pubkey);
    const lines = [
        `transaction ${tx.transaction.signatures?.[0] ?? ''}`.trim(),
        `slot ${tx.slot}`,
        typeof tx.blockTime === 'number' ? `block time ${new Date(tx.blockTime * 1000).toISOString().replace('.000Z', 'Z')}` : null,
        `status ${tx.meta?.err ? `failed: ${JSON.stringify(tx.meta.err)}` : 'success'}`,
        keys.length ? `fee payer ${pubkey(keys[0])}` : null,
        signers.length ? `signers ${signers.join(', ')}` : null,
        'program logs:',
        ...(Array.isArray(tx.meta?.logMessages) ? tx.meta.logMessages : []),
        'instructions:'
    ];
    const inner = new Map((tx.meta?.innerInstructions ?? []).map((group) => [group.index, group.instructions ?? []]));
    (message.instructions ?? []).forEach((ix, i) => {
        lines.push(instructionLine(`#${i + 1}`, ix));
        (inner.get(i) ?? []).forEach((child, j) => lines.push(instructionLine(`#${i + 1}.${j + 1}`, child)));
    });
    lines.push('token balance changes:');
    const pre = new Map((tx.meta?.preTokenBalances ?? []).map((b) => [b.accountIndex, b]));
    const post = new Map((tx.meta?.postTokenBalances ?? []).map((b) => [b.accountIndex, b]));
    for (const index of [...new Set([...pre.keys(), ...post.keys()])].sort((a, b) => a - b)) {
        const before = pre.get(index);
        const after = post.get(index);
        const ref = after ?? before;
        const decimals = ref.uiTokenAmount?.decimals ?? 0;
        const a = BigInt(before?.uiTokenAmount?.amount ?? '0');
        const b = BigInt(after?.uiTokenAmount?.amount ?? '0');
        if (a === b) continue;
        const delta = formatUnits((b - a).toString(), decimals);
        lines.push(`owner ${ref.owner}, mint ${ref.mint}, account ${pubkey(keys[index]) ?? index}: `
            + `${formatUnits(a.toString(), decimals)} -> ${formatUnits(b.toString(), decimals)} (${b > a ? '+' : ''}${delta})`);
    }
    return lines.filter((x) => x !== null).join('\n');
}

/**
 * Only a page that did not give us its text qualifies: a refusal (401/403, a bot wall) or a
 * JavaScript-only shell. Never a 404 (the package is gone, and saying so is the finding) or a 429.
 */
export function wantsCompanion({ status, reason = '', httpStatus = null, botWall = false } = {}) {
    if (status !== 'blocked') return false;
    return httpStatus === 401 || httpStatus === 403 || botWall === true || /^javascript-only page/.test(String(reason));
}

/** The run-log/checkpoint line for a companion read: what the live page did, where the text came from. */
export function companionNote({ liveReason, reader, url }) {
    return `live page unreadable (${liveReason}); text read from the publisher's ${reader} companion — ${url}`;
}
