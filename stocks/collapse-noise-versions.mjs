#!/usr/bin/env node
// One-off migration: delete the sonar.source_version rows (and their kept files) that were only
// noise, i.e. consecutive versions of a source that read the same under the current normaliser
// (lib/watch.mjs, 2026-11-23: prices, counters, render stamps and a news page's rotating frame
// outside its <article> or past its publisher's cut-off no longer make a version). The
// plan is lib/version-collapse.mjs: only versions whose raw file is still kept can be read again
// (the watcher keeps the last five per source), the newest version of a source is never deleted,
// and neither is a version a change_event cites or the one just before it. Dry run by default
// (prints counts and bytes), --apply deletes; idempotent: a second run finds nothing.

import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { wrapTransaction } from './lib/db-load.mjs';
import { readEnvFile } from './lib/env.mjs';
import { log, logError, parseArgs } from './lib/io.mjs';
import { describeUrl, psql } from './lib/psql.mjs';
import { planCollapse, protectedVersionIds, versionText } from './lib/version-collapse.mjs';
import { sourceId } from './lib/watch.mjs';

const REPO = join(import.meta.dirname, '..');

function usage() {
    console.log(`collapse-noise-versions.mjs — delete stored document versions that differ only by noise

USAGE
  node stocks/collapse-noise-versions.mjs [--apply] [--source=<id>]

  Without --apply: prints what would be deleted (rows, kept files, bytes) and deletes nothing.
  --apply           Delete those sonar.source_version rows, then their files under stocks/data/sources/.
  --source=<id>     Only this source id.
  --help            This text.

KEEPS
  The newest version of every source, every version a change_event cites and the one before it,
  and every version whose raw file is gone (it cannot be read again) or that is a PDF/DOCX.
  DATABASE_URL from .env.`);
}

const VERSIONS_SQL = (only) => `SELECT coalesce(json_agg(json_build_object(
    'id', v.id, 'sourceId', v.source_id, 'url', s.url, 'readVia', v.read_via, 'rawPath', v.raw_path, 'textPath', v.text_path,
    'bytes', v.bytes, 'fetchedAt', to_char(v.fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    ORDER BY v.source_id, v.fetched_at), '[]')
  FROM sonar.source_version v JOIN sonar.source s ON s.id = v.source_id${only ? ` WHERE v.source_id = '${only.replace(/'/g, "''")}'` : ''};`;

const CITATIONS_SQL = `SELECT coalesce(json_agg(json_build_object(
    'subjectType', subject_type, 'subjectId', subject_id, 'url', evidence->>'url', 'versionFetchedAt', evidence->>'versionFetchedAt')), '[]')
  FROM sonar.change_event WHERE evidence ? 'versionFetchedAt';`;

async function queryJson(url, sql, label) {
    const out = await psql(url, sql, label, ['-At']);
    return JSON.parse(out.trim() || 'null');
}

async function fileBytes(path) {
    try {
        return (await stat(join(REPO, path))).size;
    } catch (err) {
        if (err.code === 'ENOENT') return 0;
        throw err;
    }
}

/**
 * The plan over version rows and event citations (both as the SQL above returns them), reading
 * the kept files under `root`. Returns { doomed, checked, unreadable, sources }: `doomed` rows
 * carry { id, sourceId, keptId, rawPath, textPath, bytes }.
 */
export async function planFromRows(rows, citations, { root = REPO } = {}) {
    const bySource = new Map();
    for (const r of rows) {
        if (!bySource.has(r.sourceId)) bySource.set(r.sourceId, []);
        bySource.get(r.sourceId).push(r);
    }
    for (const list of bySource.values()) list.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.id - b.id);
    const cited = citations.map((c) => ({
        sourceId: c.subjectType === 'source' ? c.subjectId : (c.url ? sourceId(c.url) : null),
        versionFetchedAt: c.versionFetchedAt
    })).filter((c) => c.sourceId && c.versionFetchedAt);
    const protectedIds = protectedVersionIds(bySource, cited);
    const doomed = [];
    let checked = 0;
    let unreadable = 0;
    for (const [id, list] of bySource) {
        const read = [];
        for (const r of list) {
            const text = await versionText({ root, rawPath: r.rawPath, readVia: r.readVia, url: r.url });
            if (text === null) unreadable += 1;
            else checked += 1;
            read.push({ id: r.id, sourceId: id, text });
        }
        const byId = new Map(list.map((r) => [r.id, r]));
        for (const d of planCollapse(read, { protectedIds })) {
            const r = byId.get(d.id);
            doomed.push({ ...d, rawPath: r.rawPath, textPath: r.textPath, bytes: r.bytes, fetchedAt: r.fetchedAt });
        }
    }
    return { doomed, checked, unreadable, sources: bySource.size, protectedCount: protectedIds.size };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help) {
        usage();
        return;
    }
    const env = await readEnvFile(join(REPO, '.env'));
    const dbUrl = process.env.DATABASE_URL || env.DATABASE_URL;
    if (!dbUrl) throw new Error(`DATABASE_URL is not set in ${join(REPO, '.env')}`);
    log(`db: ${describeUrl(dbUrl)}`);
    const only = typeof flags.source === 'string' ? flags.source : null;
    const rows = await queryJson(dbUrl, VERSIONS_SQL(only), 'source versions');
    const citations = await queryJson(dbUrl, CITATIONS_SQL, 'event citations');
    const plan = await planFromRows(rows, citations);
    let fileTotal = 0;
    for (const d of plan.doomed) fileTotal += (await fileBytes(d.rawPath)) + (await fileBytes(d.textPath));
    const perSource = {};
    for (const d of plan.doomed) perSource[d.sourceId] = (perSource[d.sourceId] ?? 0) + 1;
    log(`${rows.length} version row(s) of ${plan.sources} source(s): ${plan.checked} read again, ${plan.unreadable} not readable`
        + ` (files pruned, PDF/DOCX or another reader), ${plan.protectedCount} kept for change events`);
    for (const [id, n] of Object.entries(perSource).sort((a, b) => b[1] - a[1]).slice(0, 20)) log(`    ${id}: ${n} noise version(s)`);
    log(`${plan.doomed.length} noise version row(s) in ${Object.keys(perSource).length} source(s); kept files ${(fileTotal / 1048576).toFixed(1)} MB`);
    if (!flags.apply) {
        log('dry run: nothing deleted — pass --apply');
        return;
    }
    if (!plan.doomed.length) {
        log('nothing to delete');
        return;
    }
    const ids = plan.doomed.map((d) => Number(d.id)).filter(Number.isInteger);
    if (ids.length !== plan.doomed.length) throw new Error('a version id is not an integer; nothing deleted');
    await psql(dbUrl, wrapTransaction(`DELETE FROM sonar.source_version WHERE id IN (${ids.join(', ')});`), 'delete noise versions');
    // Rows first: a file that survives a failed rm is pruned with the source's next versions.
    for (const d of plan.doomed) {
        for (const path of [d.rawPath, d.textPath]) {
            // Only ever a version file of this source.
            if (typeof path === 'string' && path.startsWith(`stocks/data/sources/${d.sourceId}/`) && !path.includes('..')) {
                await rm(join(REPO, path), { force: true });
            }
        }
    }
    log(`deleted ${ids.length} version row(s) and their files (${(fileTotal / 1048576).toFixed(1)} MB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        logError(err.stack || err.message);
        process.exitCode = 1;
    });
}
