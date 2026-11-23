// Split run verdicts for the watchers: INGEST (fetch and store what the source sent) is judged
// apart from PROCESSING (matching, comparison, events, every derived write), so a run's stats can
// say "everything was fetched and stored, the matcher failed" instead of one blended status. A
// processing failure never touches the ingest verdict. Pure: unit tested in run-stages.test.js.

/** A fresh tally for one stage. */
export function stageTally() {
    return { attempted: 0, ok: 0, failed: 0, skipped: 0, steps: {} };
}

/** Count one unit of work (a source, a task, a row) as ok. */
export function stageOk(tally, n = 1) {
    tally.attempted += n;
    tally.ok += n;
    return tally;
}

/** Count one unit of work as failed at `step` (the failing step's name, e.g. `store-notices`). */
export function stageFail(tally, step, n = 1) {
    tally.attempted += n;
    tally.failed += n;
    tally.steps[step] = (tally.steps[step] ?? 0) + n;
    return tally;
}

/** Count units not attempted at all (e.g. processing skipped because there was nothing to process). */
export function stageSkip(tally, n = 1) {
    tally.skipped += n;
    return tally;
}

/**
 * The stage's verdict: `ok` when nothing failed, `failed` when every attempted unit failed (or a
 * step failed with nothing attempted beside it), `partial` otherwise. `failingSteps` names each
 * failing step with its count, worst first.
 */
export function stageVerdict(tally) {
    const status = tally.failed === 0 ? 'ok' : (tally.ok === 0 ? 'failed' : 'partial');
    const failingSteps = Object.entries(tally.steps).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([step, count]) => ({ step, count }));
    return { status, attempted: tally.attempted, ok: tally.ok, failed: tally.failed, skipped: tally.skipped, failingSteps };
}

const RANK = { ok: 0, partial: 1, failed: 2 };

/** The worse of two stage statuses, for the existing single `watchStatus` field. */
export function worstStatus(...statuses) {
    return statuses.filter((s) => s in RANK).sort((a, b) => RANK[b] - RANK[a])[0] ?? 'ok';
}

/**
 * The stats fields every split watcher writes: `ingestStatus` / `processingStatus` (ok | partial |
 * failed) plus `ingest` / `processing` with the counts and the failing steps.
 */
export function stageStats(ingestTally, processingTally) {
    const ingest = stageVerdict(ingestTally);
    const processing = stageVerdict(processingTally);
    return { ingestStatus: ingest.status, processingStatus: processing.status, ingest, processing };
}
