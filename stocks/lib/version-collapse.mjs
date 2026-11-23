// Which stored document versions were only noise: consecutive sonar.source_version rows of one
// source whose kept copies read the same under the current normaliser (lib/watch.mjs) were made by
// live numbers around the document (prices, counters, render stamps), not by the document, and
// collapse into the earliest of them. Used by stocks/collapse-noise-versions.mjs; the plan is pure
// and unit tested in version-collapse.test.js, `versionText` reads a version's kept raw file.

import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { storedReading, stripPublisherChrome } from './watch.mjs';

/**
 * The versions to delete, as [{ id, sourceId, keptId }]. `versions` are one source's rows sorted
 * oldest first, each { id, sourceId, text } where `text` is the version read again under the
 * current normaliser, or null when it cannot be (its files were pruned, or it is a PDF). A version
 * is deleted only when the version before it was read again too and reads the same, so a chain is
 * never collapsed across a version nobody can read. Never deleted: the newest version (the state
 * file and sonar.source stand on it) and any id in `protectedIds` (versions a change_event cites,
 * and the versions just before them, which the change judge reads as "before").
 */
export function planCollapse(versions, { protectedIds = new Set() } = {}) {
    const doomed = [];
    let anchor = null;
    versions.forEach((v, i) => {
        const newest = i === versions.length - 1;
        if (v.text === null || v.text === undefined) {
            anchor = null;
            return;
        }
        if (anchor && anchor.text === v.text && !newest && !protectedIds.has(v.id)) {
            doomed.push({ id: v.id, sourceId: v.sourceId, keptId: anchor.id });
            return;
        }
        anchor = v;
    });
    return doomed;
}

/**
 * The ids `planCollapse` must keep for the change events: each cited version, found by source and
 * fetch time to the second, and the version before it. `versionsBySource` maps a source id to its
 * rows oldest first ({ id, fetchedAt }); `citations` are [{ sourceId, versionFetchedAt }].
 */
export function protectedVersionIds(versionsBySource, citations) {
    const ids = new Set();
    const second = (iso) => Math.floor(Date.parse(iso) / 1000);
    for (const { sourceId, versionFetchedAt } of citations) {
        const rows = versionsBySource.get(sourceId) ?? [];
        const at = second(versionFetchedAt);
        const i = rows.findIndex((r) => second(r.fetchedAt) === at);
        if (i < 0) continue;
        ids.add(rows[i].id);
        if (i > 0) ids.add(rows[i - 1].id);
    }
    return ids;
}

/** Readers whose stored copy `storedReading` reads back the way the watcher read it. */
const REREADABLE_VIA = new Set(['html', 'api', 'next-flight', 'notion', 'wayback']);

/**
 * A version's text under the current normaliser, read from its kept raw file (`rawPath`, relative
 * to `root`), or null when it cannot be read the way the watcher read it: the file is gone, it is a
 * PDF/DOCX (whose text needs pdftotext, and whose normaliser did not change), or its reader
 * (sonar.source_version.read_via) is not one `storedReading` reproduces (a companion API's own
 * reader, a binary marker, or no recorded reader).
 */
export async function versionText({ root, rawPath, readVia = null, url }) {
    if (typeof rawPath !== 'string' || rawPath === '' || !REREADABLE_VIA.has(readVia)) return null;
    const rawExt = extname(rawPath).slice(1);
    if (rawExt !== 'html' && rawExt !== 'json') return null;
    let payload;
    try {
        payload = await readFile(join(root, rawPath), 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    const read = storedReading({ rawExt, via: readVia, payload });
    return read === null ? null : stripPublisherChrome(url, read.text);
}
