#!/usr/bin/env node
// Applies MODEL.md §4 to the two site data files: upserts one rwa-assets-db.json record per stock
// issuer from its dossier, and replaces that record's rows in attestations-db.json with the
// dossier's positive attestations. DRY RUN BY DEFAULT — it prints every field it would change and
// every attestation row it would delete or insert, and only `--apply` writes anything. Both files
// are rewritten with their own existing indentation and with untouched records left where they are.

import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { log, logError, logWarn, parseArgs, readJson } from './lib/io.mjs';
import { NON_SITE_BOOLEANS, SITE_BOOLEANS, isNo, isYes } from './lib/grade.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const ISSUERS_DIR = join(HERE, 'data', 'issuers');
const ASSETS_DB = join(REPO_ROOT, 'rwa-assets-db.json');
const ATTESTATIONS_DB = join(REPO_ROOT, 'attestations-db.json');
const ATTESTATION_TYPES = join(REPO_ROOT, 'attestation-types.json');
const SPONSOR_APIS = join(HERE, 'data', 'sponsor-apis.json');

export const MAX_DESCRIPTION = 320;

/**
 * A neutral placeholder in the style placeholder-db.json already uses (same four-colour palette,
 * inline SVG data URI, no external request): a share certificate, deliberately generic because we
 * do not have the issuer's mark.
 */
export const NEUTRAL_ASSET_IMAGE = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><rect width='64' height='64' fill='%23264653'/><rect x='12' y='16' width='40' height='32' rx='2' fill='%23e9c46a'/><rect x='18' y='24' width='28' height='3' fill='%23264653'/><rect x='18' y='31' width='20' height='3' fill='%23264653'/><circle cx='44' cy='40' r='6' fill='%232a9d8f'/></svg>";

const SOLANA_LOGO = './images/solana-logo.svg';
const HYPERLIQUID_LOGO = './images/hyperliquid-logo.jpg';

/**
 * MODEL.md §4, one row per issuer programme, plus the three values the table does not spell out:
 * the short `issuer` label the existing records already use, the issuer's own site (taken from the
 * domain its dossier documents are served from) and which dossier file to read. `status` here is
 * only the fallback — a dossier that carries its own `status` wins.
 */
export const REPAIRS = [
    {
        slug: 'xstocks-backed',
        dossier: 'xstocks-backed.json',
        name: 'Kraken xStocks',
        type: 'Tokenized Equity (Tracker Certificates)',
        status: 'live',
        issuer: 'Kraken',
        website: 'https://xstocks.com'
    },
    {
        slug: 'ondo-global-markets',
        dossier: 'ondo-global-markets.json',
        name: 'Ondo Global Markets',
        type: 'Tokenized Equity (Structured Notes)',
        status: 'live',
        issuer: 'Ondo',
        website: 'https://ondo.finance/global-markets'
    },
    {
        slug: 'backpack-securities',
        dossier: 'backpack-securities-spcx.json',
        name: 'Backpack Securities SPCX',
        type: 'Tokenized Equity (Trust Claim)',
        status: 'live',
        issuer: 'Backpack',
        website: 'https://backpack.exchange'
    },
    {
        slug: 'superstate-opening-bell',
        dossier: 'superstate-opening-bell.json',
        name: 'Opening Bell by Superstate',
        type: 'Tokenized Equity (Registered Shares)',
        status: 'live',
        issuer: 'Superstate',
        website: 'https://superstate.com'
    },
    {
        slug: 'shift',
        dossier: 'shift.json',
        name: 'Shift leveraged tokens',
        type: 'Tokenized Leveraged ETF Exposure (Derivative)',
        status: 'live',
        issuer: 'SHIFT DAO LLC',
        website: 'https://www.shiftrwa.xyz'
    },
    {
        slug: 'bullish',
        dossier: 'bullish-blsh.json',
        name: 'Bullish BLSH',
        type: 'Tokenized Equity (Registered Shares)',
        status: 'live',
        issuer: 'Bullish',
        website: 'https://www.bullish.com'
    },
    {
        slug: 'securitize',
        dossier: 'securitize-secz.json',
        name: 'Securitize SECZ',
        type: 'Tokenized Equity (Registered Shares)',
        status: 'live',
        issuer: 'Securitize',
        website: 'https://securitize.io'
    },
    {
        slug: 'prestocks',
        dossier: 'prestocks.json',
        name: 'PreStocks',
        type: 'Tokenized Pre-IPO Exposure (Synthetic)',
        status: 'live',
        issuer: 'PreStocks',
        website: 'https://prestocks.com'
    },
    {
        slug: 'tessera',
        dossier: 'tessera.json',
        name: 'Tessera',
        type: 'Pre-IPO Loan Participation',
        status: 'live',
        issuer: 'Tessera',
        website: 'https://tessera.pe'
    },
    {
        slug: 'remora-markets',
        dossier: 'remora-markets.json',
        name: 'Remora Markets',
        type: 'Tokenized Equity',
        status: 'defunct',
        issuer: 'Remora',
        website: 'https://remoramarkets.xyz'
    },
    {
        slug: 'ventuals',
        dossier: 'ventuals.json',
        name: 'Ventuals Pre-IPO',
        type: 'Pre-IPO Perpetual Futures (Derivative)',
        status: 'defunct',
        issuer: 'Ventuals',
        website: 'https://ventuals.com',
        blockchain: 'Hyperliquid',
        blockchainLogo: HYPERLIQUID_LOGO,
        tokenStandard: 'n/a (perpetual positions)'
    }
];

function usage() {
    console.log(`sync-assets-db.mjs — apply MODEL.md §4 to rwa-assets-db.json and attestations-db.json

USAGE
  node stocks/sync-assets-db.mjs [--apply] [options]

OPTIONS
  (no flags)     Dry run: print every record and field that would change, and every
                 attestation row that would be deleted or inserted. Writes nothing.
  --apply        Write both files. Each keeps its own indentation, untouched records keep
                 their position, and new records are appended.
  --only=<a,b>   Restrict to these issuer slugs (${REPAIRS.map((r) => r.slug).join(', ')}).
  --out-dir=<d>  With --apply, write both files into <d> instead of the repo root. A rehearsal:
                 it exercises the real write path and leaves the site data untouched.
  --help         This text.

WHAT IT WRITES
  Per issuer: type, status, blockchain, tokenStandard, contractAddress, description (<= ${MAX_DESCRIPTION}
  chars, from the dossier's holderClaim) and the TEN site booleans from the dossier vocabulary.
  A boolean the dossier records as "unknown" has its key removed rather than written, and the
  three non-site booleans (${NON_SITE_BOOLEANS.join(', ')}) are
  removed if present — index.html sums every non-general field, so storing them shifts the score.
  An existing record keeps its name, asset_image, asset_image_background and website; a new record
  gets the issuer's site and, for its image, the sponsor API's own logo when the issuer publishes
  one, else a neutral SVG data URI. No network I/O: token metadata JSON is never fetched.
  Attestations: every existing row for the record name is deleted and the dossier's positive
  attestations are inserted in its place. A schema still carrying a "NEW:" prefix, or one absent
  from attestation-types.json, is skipped and reported — findings are never written here.`);
}

// ---------------------------------------------------------------- pure formatting helpers

/** Indentation of a pretty-printed JSON file, read from its first indented line. */
export function detectIndent(text, fallback = 2) {
    const match = /\n([ \t]+)\S/.exec(String(text ?? ''));
    if (!match) return fallback;
    return match[1][0] === '\t' ? '\t' : match[1].length;
}

/** Re-serialises a value with the indentation and trailing newline the original file had. */
export function stringifyLike(value, originalText) {
    const indent = detectIndent(originalText);
    const trailing = String(originalText ?? '').endsWith('\n') ? '\n' : '';
    return `${JSON.stringify(value, null, indent)}${trailing}`;
}

/**
 * A factual description no longer than `max`, cut at a sentence end where one falls in the second
 * half of the budget and otherwise at a word boundary with an ellipsis, so a truncation is visible.
 */
export function truncateDescription(text, max = MAX_DESCRIPTION) {
    if (typeof text !== 'string') return null;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean === '') return null;
    if (clean.length <= max) return clean;

    const head = clean.slice(0, max);
    const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    if (sentenceEnd >= Math.floor(max / 2)) return head.slice(0, sentenceEnd + 1);

    const cut = head.slice(0, max - 1);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The TEN site booleans as the record should store them: only a definite "yes"/"no" is written,
 * and everything else (unknown, absent, a free-text value) is listed for removal instead.
 */
export function siteBooleans(vocabulary) {
    const write = [];
    const remove = [];
    for (const key of SITE_BOOLEANS) {
        const entry = vocabulary?.[key];
        const value = entry && typeof entry === 'object' ? entry.value : entry;
        if (isYes(value)) write.push([key, 'yes']);
        else if (isNo(value)) write.push([key, 'no']);
        else remove.push(key);
    }
    return { write, remove };
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The first sample mint that actually looks like an address — dossiers also list authority keys. */
export function firstSampleMint(dossier) {
    for (const sample of dossier?.sampleMints ?? []) {
        const mint = typeof sample?.mint === 'string' ? sample.mint.trim() : '';
        if (BASE58_ADDRESS.test(mint)) return mint;
    }
    return null;
}

function hasValue(value) {
    if (value === null || value === undefined) return false;
    return typeof value === 'string' ? value.trim() !== '' : true;
}

/**
 * Merges one desired record into the existing one. `fields` is an ordered list of
 * `[key, value, mode]`, where mode "set" always writes and mode "fill" writes only where the
 * record has no value yet; `remove` names keys to delete. Existing keys keep their position and
 * genuinely new keys are appended in the order given, so an update diffs minimally.
 */
export function mergeRecord(existing, { fields = [], remove = [] }) {
    const created = existing === null || existing === undefined;
    const source = created ? {} : existing;

    const desired = new Map();
    for (const [key, value, mode] of fields) {
        if (value === undefined) continue;
        if (mode === 'fill' && hasValue(source[key])) continue;
        desired.set(key, value);
    }
    const removeSet = new Set(remove);

    const record = {};
    const changes = [];
    for (const [key, value] of Object.entries(source)) {
        if (removeSet.has(key)) {
            changes.push({ field: key, from: value, to: undefined, removed: true });
            continue;
        }
        if (desired.has(key)) {
            const next = desired.get(key);
            if (next !== value) changes.push({ field: key, from: value, to: next });
            record[key] = next;
            desired.delete(key);
            continue;
        }
        record[key] = value;
    }
    for (const [key, value] of desired) {
        record[key] = value;
        changes.push({ field: key, from: undefined, to: value, added: true });
    }
    return { record, changes, created };
}

/** Upserts each spec into `rows`, matched on `name`; a new record is appended. */
export function mergeRecords(rows, specs) {
    const out = [...rows];
    const diffs = [];
    for (const spec of specs) {
        const index = out.findIndex((row) => row?.name === spec.name);
        const merged = mergeRecord(index === -1 ? null : out[index], spec);
        diffs.push({ name: spec.name, slug: spec.slug, ...merged });
        if (index === -1) out.push(merged.record);
        else out[index] = merged.record;
    }
    return { rows: out, diffs };
}

/**
 * Deletes every row for each group's `assetName` and inserts the group's rows where the first
 * deleted row sat, so a re-synced record does not migrate to the end of the file. A group with no
 * existing rows is appended.
 */
export function replaceAttestations(rows, groups) {
    let out = [...rows];
    const summary = [];
    for (const group of groups) {
        const deleted = out.filter((row) => row?.assetName === group.assetName);
        const kept = out.filter((row) => row?.assetName !== group.assetName);
        const firstIndex = out.findIndex((row) => row?.assetName === group.assetName);
        const insertAt = firstIndex === -1
            ? kept.length
            : out.slice(0, firstIndex).filter((row) => row?.assetName !== group.assetName).length;
        out = [...kept.slice(0, insertAt), ...group.rows, ...kept.slice(insertAt)];
        summary.push({ assetName: group.assetName, deleted, inserted: group.rows });
    }
    return { rows: out, summary };
}

/** One attestation row in the shape and key order attestations-db.json already uses. */
export function attestationRow(assetName, attestation) {
    return {
        assetName,
        schema: attestation.schema,
        attestor: attestation.attestor ?? '',
        attestationDate: attestation.attestationDate ?? '',
        expiryDate: attestation.expiryDate ?? '',
        status: attestation.status ?? 'valid',
        onchain: attestation.onchain === true,
        link: attestation.link ?? '#',
        statement: attestation.statement ?? ''
    };
}

/**
 * Splits a dossier's attestations into the rows that can be written and the ones that cannot,
 * because their schema is still a `NEW:` proposal or is not in attestation-types.json (MODEL.md §5).
 */
export function selectAttestations(assetName, attestations, knownSchemas) {
    const rows = [];
    const skipped = [];
    for (const attestation of attestations ?? []) {
        const schema = typeof attestation?.schema === 'string' ? attestation.schema.trim() : '';
        if (schema === '') {
            skipped.push({ schema: '(none)', reason: 'no schema' });
            continue;
        }
        if (schema.startsWith('NEW:')) {
            skipped.push({ schema, reason: 'still a NEW: proposal, not yet in attestation-types.json' });
            continue;
        }
        if (knownSchemas && !knownSchemas.has(schema)) {
            skipped.push({ schema, reason: 'not in attestation-types.json' });
            continue;
        }
        rows.push(attestationRow(assetName, attestation));
    }
    return { rows, skipped };
}

// ---------------------------------------------------------------- spec building

function statusOf(repair, dossier) {
    const own = typeof dossier.status === 'string' ? dossier.status.trim() : '';
    if (own === '') {
        logWarn(`dossier ${repair.dossier} has no "status" — using the MODEL.md §4 value "${repair.status}"`);
        return repair.status;
    }
    if (own !== repair.status) {
        logWarn(`dossier ${repair.dossier} says status "${own}" where MODEL.md §4 says "${repair.status}" — writing the dossier's value`);
    }
    return own;
}

/** Only PreStocks publishes a per-token logo in its own API; everything else falls back. */
function sponsorImage(slug, sponsorItems) {
    const items = slug === 'prestocks' ? sponsorItems?.prestocks ?? [] : [];
    for (const item of items) {
        if (typeof item?.image === 'string' && item.image.startsWith('http')) return item.image;
    }
    return null;
}

function buildSpec(repair, dossier, sponsorItems) {
    const booleans = siteBooleans(dossier.vocabulary);
    const blockchain = repair.blockchain ?? 'Solana';
    const contractAddress = firstSampleMint(dossier);
    if (contractAddress === null && blockchain === 'Solana') {
        logWarn(`dossier ${repair.dossier} has no usable sampleMints[].mint — contractAddress is left as it is`);
    }

    return {
        slug: repair.slug,
        name: repair.name,
        fields: [
            ['name', repair.name, 'fill'],
            ['ticker', '', 'fill'],
            ['asset_image', sponsorImage(repair.slug, sponsorItems) ?? NEUTRAL_ASSET_IMAGE, 'fill'],
            ['type', repair.type, 'set'],
            ['description', truncateDescription(dossier.holderClaim), 'set'],
            ['website', repair.website, 'fill'],
            ['blockchain', blockchain, 'set'],
            ['blockchain_logo', repair.blockchainLogo ?? SOLANA_LOGO, 'fill'],
            ['contractAddress', contractAddress ?? undefined, 'set'],
            ['tokenStandard', repair.tokenStandard ?? 'Token-2022', 'set'],
            ['status', statusOf(repair, dossier), 'set'],
            ...booleans.write.map(([key, value]) => [key, value, 'set']),
            ['issuer', repair.issuer, 'set']
        ],
        remove: [...booleans.remove, ...NON_SITE_BOOLEANS]
    };
}

// ---------------------------------------------------------------- reporting

function show(value) {
    if (value === undefined) return '(absent)';
    if (value === null) return 'null';
    if (typeof value !== 'string') return JSON.stringify(value);
    const oneLine = value.replace(/\s+/g, ' ');
    return oneLine.length > 120 ? `"${oneLine.slice(0, 117)}..."` : `"${oneLine}"`;
}

function reportRecordDiff(diff) {
    if (diff.created) log(`  CREATE ${diff.name} (${diff.slug}) — ${diff.changes.length} field(s):`);
    else if (diff.changes.length === 0) log(`  UNCHANGED ${diff.name} (${diff.slug})`);
    else log(`  UPDATE ${diff.name} (${diff.slug}) — ${diff.changes.length} field(s) change:`);

    for (const change of diff.changes) {
        if (change.removed) log(`      ${change.field}: ${show(change.from)} -> (key removed)`);
        else if (change.added) log(`      ${change.field}: (absent) -> ${show(change.to)}`);
        else log(`      ${change.field}: ${show(change.from)} -> ${show(change.to)}`);
    }
}

/** Atomic write (tmp + rename), preserving the file's own indentation — which io.writeJson cannot. */
async function writeLike(path, value, originalText) {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, stringifyLike(value, originalText), 'utf8');
    await rename(tmp, path);
    return path;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help) {
        usage();
        return 0;
    }

    const apply = flags.apply === true;
    const only = typeof flags.only === 'string'
        ? new Set(flags.only.split(',').map((s) => s.trim()).filter(Boolean))
        : null;
    const repairs = only ? REPAIRS.filter((r) => only.has(r.slug)) : REPAIRS;
    if (only) {
        const unknown = [...only].filter((slug) => !REPAIRS.some((r) => r.slug === slug));
        if (unknown.length) throw new Error(`--only names unknown slug(s): ${unknown.join(', ')}`);
    }
    log(apply ? 'APPLY mode: both files will be written' : 'DRY RUN: nothing is written (pass --apply to write)');

    const assetsText = await readFile(ASSETS_DB, 'utf8');
    const attestationsText = await readFile(ATTESTATIONS_DB, 'utf8');
    const assetRows = JSON.parse(assetsText);
    const attestationRows = JSON.parse(attestationsText);
    if (!Array.isArray(assetRows)) throw new Error(`${ASSETS_DB} is not an array`);
    if (!Array.isArray(attestationRows)) throw new Error(`${ATTESTATIONS_DB} is not an array`);

    const types = await readJson(ATTESTATION_TYPES);
    const knownSchemas = new Set((Array.isArray(types) ? types : []).map((t) => t.schema).filter(Boolean));
    const sponsorItems = (await readJson(SPONSOR_APIS, { items: {} })).items ?? {};
    log(`read ${assetRows.length} asset record(s) (indent ${detectIndent(assetsText)}), ${attestationRows.length} attestation row(s) (indent ${detectIndent(attestationsText)}), ${knownSchemas.size} attestation type(s)`);

    const specs = [];
    const groups = [];
    const allSkipped = [];
    for (const repair of repairs) {
        const dossier = await readJson(join(ISSUERS_DIR, repair.dossier));
        specs.push(buildSpec(repair, dossier, sponsorItems));
        const selected = selectAttestations(repair.name, dossier.attestations, knownSchemas);
        groups.push({ assetName: repair.name, rows: selected.rows });
        for (const skip of selected.skipped) allSkipped.push({ slug: repair.slug, ...skip });
    }

    const merged = mergeRecords(assetRows, specs);
    const replaced = replaceAttestations(attestationRows, groups);

    log(`rwa-assets-db.json — ${merged.diffs.filter((d) => d.created).length} record(s) created, ${merged.diffs.filter((d) => !d.created && d.changes.length).length} updated, ${merged.diffs.filter((d) => !d.created && !d.changes.length).length} unchanged:`);
    for (const diff of merged.diffs) reportRecordDiff(diff);

    log('attestations-db.json — rows deleted and inserted per record:');
    let deleted = 0;
    let inserted = 0;
    for (const row of replaced.summary) {
        deleted += row.deleted.length;
        inserted += row.inserted.length;
        log(`  ${row.assetName}: delete ${row.deleted.length}, insert ${row.inserted.length}`);
        for (const schema of row.deleted.map((r) => r.schema)) log(`      - ${schema}`);
        for (const schema of row.inserted.map((r) => r.schema)) log(`      + ${schema}`);
    }
    log(`attestations total: ${attestationRows.length} -> ${replaced.rows.length} (${deleted} deleted, ${inserted} inserted)`);

    if (allSkipped.length) {
        logWarn(`${allSkipped.length} dossier attestation(s) are NOT writable and were skipped (MODEL.md §5):`);
        for (const skip of allSkipped) logWarn(`  ${skip.slug}: ${skip.schema} — ${skip.reason}`);
    }

    if (!apply) {
        log('DRY RUN finished — rwa-assets-db.json and attestations-db.json are untouched');
        return 0;
    }

    const outDir = typeof flags['out-dir'] === 'string' ? flags['out-dir'] : REPO_ROOT;
    const assetsOut = join(outDir, 'rwa-assets-db.json');
    const attestationsOut = join(outDir, 'attestations-db.json');
    await writeLike(assetsOut, merged.rows, assetsText);
    await writeLike(attestationsOut, replaced.rows, attestationsText);
    log(`wrote ${assetsOut} (${merged.rows.length} record(s)) and ${attestationsOut} (${replaced.rows.length} row(s))`);
    return 0;
}

// Guarded, so sync.test.js can import the pure helpers above without running the CLI.
const invokedDirectly = typeof process.argv[1] === 'string'
    && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
    main().then((code) => process.exit(code), (err) => {
        logError(err.stack ?? String(err));
        process.exit(1);
    });
}
