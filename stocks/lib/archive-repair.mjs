function isTargetVersion(row, target) {
    return row
        && (row.archiveUrl ?? null) === target.archiveUrl
        && (row.contentHash ?? null) === target.contentHash;
}

/** Queue a failed capture only while the exact state row we attempted is still current. */
export async function markArchiveCapturePending({ target, readState, writeState }) {
    const state = await readState();
    const row = state?.[target.url];
    if (!isTargetVersion(row, target)) return { marked: false };
    if (row.archivePending === true) return { marked: true, changed: false };
    row.archivePending = true;
    await writeState(state);
    return { marked: true, changed: true };
}

/** Apply a captured URL only if the persisted source still matches the targeted version. */
export async function applyArchiveCapture({ target, archiveUrl, readState, writeState, persistDatabase = async () => {} }) {
    if (!isTargetVersion((await readState())?.[target.url], target)) return { applied: false };

    // Leave the local pending marker intact if Postgres fails. Retrying the archive-only pass is
    // safe: its SQL accepts the same capture URL if the database write succeeded previously.
    await persistDatabase(target, archiveUrl);

    // A full watch can advance state while the database call is in flight. Re-read before writing
    // so the archive repair never replaces a newer state snapshot with the one read above.
    const state = await readState();
    const row = state?.[target.url];
    if (!isTargetVersion(row, target)) return { applied: false };

    const history = Array.isArray(row.archiveHistory) ? [...row.archiveHistory] : [];
    const preserve = (oldUrl, contentHash) => {
        if (typeof oldUrl !== 'string' || oldUrl === '' || oldUrl === archiveUrl) return;
        const existing = history.find((entry) => entry?.archiveUrl === oldUrl);
        if (existing) {
            if (!existing.contentHash && contentHash) existing.contentHash = contentHash;
            return;
        }
        history.push({ archiveUrl: oldUrl, contentHash: contentHash ?? null });
    };
    // The source-level ref may have advanced independently of this version's own archive ref.
    // Keep both when they differ, along with the exact content hash for the version row's capture.
    preserve(row.archiveUrl, row.archiveContentHash ?? null);
    preserve(target.expectedVersionArchiveUrl, target.contentHash ?? null);
    row.archiveHistory = history;
    row.archiveUrl = archiveUrl;
    row.archiveContentHash = row.contentHash ?? target.contentHash;
    row.archivePending = false;
    await writeState(state);
    return { applied: true };
}
