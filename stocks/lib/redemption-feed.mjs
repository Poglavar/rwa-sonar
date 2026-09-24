// The rolling redemption-observation feed (stocks/observe-redemptions.mjs): pure checkpoint,
// coverage and summary logic, plus the merge the builder applies to an issuer's `redemption` block.
// Nothing here touches the network or the disk, so the rules that keep a failed scan from reading
// as "no redemptions" are unit tested (stocks/redemption-feed.test.js).
//
// The one idea everything rests on: a count means something only over COVERAGE — the block-time
// intervals whose every relevant transaction was actually read. Zero redemptions inside coverage
// is a finding; zero outside it is nothing, and is never written as a zero.

export const RETENTION_DAYS = 30;
export const RECENT_SAMPLE = 10;
export const STALE_HOURS = 48;
const DAY_MS = 86400000;

const ms = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN);
const iso = (value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** ISO day of a timestamp. */
export function dayOf(time) {
    return iso(ms(time)).slice(0, 10);
}

/**
 * Choose what to consume this run from a newest-first signature listing (getSignaturesForAddress
 * down to the checkpoint). Consumption runs OLDEST-first, so the checkpoint only ever advances over
 * a contiguous prefix and a budget cut or a kill loses nothing. A listed signature newer than
 * `horizon` is left for the next run; `needsFetch(entry)` decides which consumed ones cost a
 * getTransaction (failed signatures and, for the xStocks treasury, those outside every settlement
 * window cost nothing). Returns the batch oldest-first, the budget backlog and what the horizon held back.
 */
export function selectBatch(listed, { budget, needsFetch = (entry) => !entry.err, horizon = null } = {}) {
    const oldestFirst = [...(Array.isArray(listed) ? listed : [])].reverse();
    const batch = [];
    let fetches = 0;
    let heldBack = 0;
    for (const [index, entry] of oldestFirst.entries()) {
        if (horizon !== null && finite(entry.blockTime) && entry.blockTime * 1000 > ms(horizon)) {
            heldBack = oldestFirst.length - index;
            break;
        }
        const fetch = needsFetch(entry);
        if (fetch && fetches >= budget) break;
        if (fetch) fetches += 1;
        batch.push({ ...entry, fetch });
    }
    // `backlog` is what the BUDGET left unread (a lagging scan); `heldBack` is what lies past the
    // horizon on purpose and is not a lag.
    return { batch, fetches, heldBack, backlog: oldestFirst.length - batch.length - heldBack };
}

/**
 * The interval this run covered for one address. Nothing left behind: covered to the moment the
 * listing was taken (`listedAt`, our `date -u` clock) or to `horizon` when one capped it. Something
 * left behind: covered only to the last consumed block time. `from` is the previous coverage end;
 * on a first run it is the oldest consumed block time (never earlier than what was read), unless
 * the listing held the address's complete history (`completeHistorySince`).
 */
export function runInterval({ previousThrough = null, consumed = [], backlog, listedAt, horizon = null, reachedCheckpoint = true, completeHistorySince = null }) {
    const times = consumed.map((entry) => entry.blockTime).filter(finite).map((t) => t * 1000);
    const last = times.length ? Math.max(...times) : null;
    let to;
    if (backlog === 0) to = horizon !== null ? Math.min(ms(horizon), ms(listedAt)) : ms(listedAt);
    else to = last ?? (previousThrough !== null ? ms(previousThrough) : null);
    let from = previousThrough !== null && reachedCheckpoint ? ms(previousThrough) : (times.length ? Math.min(...times) : null);
    // A first listing that returned the address's ENTIRE history (fewer rows than asked for) read
    // every transaction there ever was, so it covers back to whenever the caller asks.
    if (previousThrough === null && completeHistorySince !== null && backlog === 0) from = Math.min(from ?? Infinity, ms(completeHistorySince));
    if (from === null && to !== null && backlog === 0) from = to;
    if (from === null || to === null || to < from) return null;
    return { from: iso(from), to: iso(to) };
}

/** Merge overlapping or touching intervals, oldest first. */
export function mergeIntervals(list) {
    const sorted = (Array.isArray(list) ? list : []).filter((i) => i && ms(i.from) <= ms(i.to))
        .map((i) => ({ from: i.from, to: i.to })).sort((a, b) => ms(a.from) - ms(b.from));
    const out = [];
    for (const interval of sorted) {
        const prev = out.at(-1);
        if (prev && ms(interval.from) <= ms(prev.to)) {
            if (ms(interval.to) > ms(prev.to)) prev.to = interval.to;
        } else out.push(interval);
    }
    return out;
}

/** Drop coverage before `cutoff`, clipping an interval that straddles it. */
export function pruneIntervals(list, cutoff) {
    const c = ms(cutoff);
    return mergeIntervals(list).filter((i) => ms(i.to) >= c).map((i) => (ms(i.from) < c ? { from: iso(c), to: i.to } : i));
}

/** Coverage every one of the lists shares: an issuer is covered only where all its addresses are. */
export function intersectCoverage(lists) {
    if (!lists.length) return [];
    let acc = mergeIntervals(lists[0]);
    for (const list of lists.slice(1)) {
        const other = mergeIntervals(list);
        const next = [];
        for (const a of acc) {
            for (const b of other) {
                const from = Math.max(ms(a.from), ms(b.from));
                const to = Math.min(ms(a.to), ms(b.to));
                if (from <= to) next.push({ from: iso(from), to: iso(to) });
            }
        }
        acc = mergeIntervals(next);
    }
    return acc;
}

/** True when [from, to] lies inside one coverage interval. */
export function covers(list, from, to) {
    return mergeIntervals(list).some((i) => ms(i.from) <= ms(from) && ms(to) <= ms(i.to));
}

/** Hours of `day` (YYYY-MM-DD) inside coverage. */
export function coveredHoursOn(list, day) {
    const start = ms(`${day}T00:00:00Z`);
    const end = start + DAY_MS;
    let total = 0;
    for (const i of mergeIntervals(list)) {
        const from = Math.max(start, ms(i.from));
        const to = Math.min(end, ms(i.to));
        if (to > from) total += to - from;
    }
    return Math.round((total / 3600000) * 10) / 10;
}

/** Add `n` to a counter inside daily[day] (and to a nested reason map when `reason` is given). */
export function bump(daily, time, field, n = 1, reason = null) {
    const day = dayOf(time);
    daily[day] ??= {};
    if (reason === null) daily[day][field] = (daily[day][field] ?? 0) + n;
    else {
        daily[day][field] ??= {};
        daily[day][field][reason] = (daily[day][field][reason] ?? 0) + n;
    }
}

/**
 * Creation/redemption AMOUNTS for the flows page (stocks/build-flows.mjs), beside the counters:
 * daily[day].flows[direction][mint] = {n, units, usd, usdUnits, unmeasured}. `direction` is
 * 'created' or 'redeemed'; `units` are token base units / 10^decimals (before any scaled-UI
 * multiplier). `usd` accumulates only events that carried a dollar value — a stablecoin leg in the
 * same transaction, or a DEX reference price at the event time — and `usdUnits` the units it covers,
 * so an unpriced event is priced later or shown as unpriced, never as $0; `priced` counts the priced
 * events per `usdSource` ('settlement' or 'dex-tape'). An event whose units the
 * transaction did not show counts in `n` and `unmeasured`, never as zero units.
 */
export function addFlow(daily, time, direction, mint, units, usd = null, usdSource = null) {
    if (direction !== 'created' && direction !== 'redeemed') throw new Error(`addFlow: unknown direction ${direction}`);
    const day = dayOf(time);
    daily[day] ??= {};
    daily[day].flows ??= {};
    daily[day].flows[direction] ??= {};
    const key = typeof mint === 'string' && mint ? mint : 'unknown-mint';
    const cell = daily[day].flows[direction][key] ??= { n: 0, units: 0, usd: 0, usdUnits: 0, unmeasured: 0 };
    cell.n += 1;
    if (!finite(units) || units < 0) { cell.unmeasured += 1; return cell; }
    cell.units += units;
    if (finite(usd) && usd >= 0) {
        cell.usd += usd;
        cell.usdUnits += units;
        if (usdSource) { cell.priced ??= {}; cell.priced[usdSource] = (cell.priced[usdSource] ?? 0) + 1; }
    }
    return cell;
}

/** Keep the last RETENTION_DAYS days of daily counters. */
export function pruneDaily(daily, now) {
    const cutoff = dayOf(iso(ms(now) - RETENTION_DAYS * DAY_MS));
    return Object.fromEntries(Object.entries(daily ?? {}).filter(([day]) => day >= cutoff).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Newest-first sample of accepted redemptions, deduplicated by id. */
export function pushRecent(recent, rows, limit = RECENT_SAMPLE) {
    const byId = new Map();
    for (const row of [...rows, ...(recent ?? [])]) if (!byId.has(row.id)) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => ms(b.blockTime) - ms(a.blockTime)).slice(0, limit);
}

/**
 * xStocks: settle each pending holder deposit once the scans can answer for it, or keep it pending.
 * A deposit is decided only when the redemption-address AND treasury coverage both contain its whole
 * settlement window [t, t + maxSeconds]; before that it waits (a payout not read yet is not a
 * missing payout). `pair` is lib/redemption-observation.mjs pairXstocksRedemption, `priceFor(deposit)`
 * the independent reference price or null, `priceReadyFor(deposit)` whether the price collector has
 * run past the deposit's price window yet (a price not collected yet is not a missing price). A deposit still undecided after `maxPendingSeconds`
 * (its window fell into a coverage gap) is rejected as unscanned, never as unredeemed.
 */
export function resolveXstocksDeposits({ deposits, sweeps, payouts, coverage, pair, priceFor, priceReadyFor = () => true, now, maxSeconds = 180, maxPendingSeconds = 2 * 86400 }) {
    const accepted = [];
    const rejected = [];
    const pending = [];
    const usedSweeps = new Set();
    const usedPayouts = new Set();
    for (const deposit of [...deposits].sort((a, b) => ms(a.blockTime) - ms(b.blockTime))) {
        const t = ms(deposit.blockTime);
        const windowEnd = iso(t + maxSeconds * 1000);
        const windowCovered = covers(coverage, deposit.blockTime, windowEnd);
        const priceReady = priceReadyFor(deposit);
        if (!windowCovered || !priceReady) {
            if ((ms(now) - t) / 1000 > maxPendingSeconds) {
                rejected.push({ deposit, reason: windowCovered ? 'reference prices were never collected for the deposit time' : 'settlement window not covered by a completed scan' });
            } else pending.push(deposit);
            continue;
        }
        const sweep = sweeps.filter((s) => !usedSweeps.has(s.signature) && s.tokenMint === deposit.tokenMint
            && Math.abs(s.tokenAmount - deposit.tokenAmount) < 1e-9 && ms(s.blockTime) >= t && ms(s.blockTime) <= t + maxSeconds * 1000)
            .sort((a, b) => ms(a.blockTime) - ms(b.blockTime))[0] ?? null;
        if (!sweep) {
            rejected.push({ deposit, reason: 'no sweep of the deposited amount to the treasury inside the window' });
            continue;
        }
        const result = pair({ deposit, sweep, payouts: payouts.filter((p) => !usedPayouts.has(p.signature)), referencePriceUsd: priceFor(deposit), maxSeconds });
        if (result.accepted) {
            usedSweeps.add(sweep.signature);
            usedPayouts.add(result.legs.payout);
            accepted.push({ deposit, sweep, result });
        } else rejected.push({ deposit, reason: result.reason });
    }
    return { accepted, rejected, pending };
}

/**
 * The feed's verdict for one issuer, computed from coverage — never from the wall clock alone.
 * `scan-failed` whenever the last scan failed (whatever older facts say), `stale` when coverage
 * ends more than STALE_HOURS ago, `not-yet-covered` before any complete interval, else `observed`
 * when an accepted redemption lies inside the retained coverage or `none-observed` with the length
 * of the CONTINUOUS coverage since the last one (or since coverage began).
 */
export function summariseFeed(entry, { now, staleHours = STALE_HOURS } = {}) {
    const coverage = mergeIntervals(entry?.coverage ?? []);
    const lastScan = entry?.lastScan ?? null;
    const coveredFrom = coverage[0]?.from ?? null;
    const coveredThrough = coverage.at(-1)?.to ?? null;
    const counts = { redemptions: 0 };
    const rejected = {};
    for (const day of Object.values(entry?.daily ?? {})) {
        for (const [field, value] of Object.entries(day)) {
            if (finite(value)) counts[field] = (counts[field] ?? 0) + value;
            else if (field === 'rejected' && value && typeof value === 'object') {
                for (const [reason, n] of Object.entries(value)) rejected[reason] = (rejected[reason] ?? 0) + n;
            }
        }
    }
    const lastObserved = entry?.lastObserved ?? null;
    const base = {
        coveredFrom, coveredThrough, coverageIntervals: coverage.length, counts30d: counts, rejected30d: rejected,
        lastObservedAt: lastObserved?.blockTime ?? null, lastScanAt: lastScan?.at ?? null,
        lastScanStatus: lastScan?.status ?? null, backlog: lastScan?.backlog ?? null, noRedemptionDays: null, since: null
    };
    if (lastScan?.status === 'failed') {
        return { ...base, state: 'scan-failed',
            message: `Last scan failed (${lastScan.error ?? 'unknown error'}); nothing is stated about redemptions after ${coveredThrough ?? 'the last good scan'}.` };
    }
    if (coveredThrough === null) return { ...base, state: 'not-yet-covered', message: 'No completed scan interval yet.' };
    if ((ms(now) - ms(coveredThrough)) / 3600000 > staleHours) {
        return { ...base, state: 'stale', message: `Coverage ends ${coveredThrough}, more than ${staleHours} h ago; not a statement that redemptions stopped.` };
    }
    const lagging = lastScan?.status === 'partial' ? ` Scan is behind by ${lastScan.backlog ?? '?'} signature(s).` : '';
    const tail = coverage.at(-1);
    if (lastObserved && ms(lastObserved.blockTime) >= ms(coveredFrom)) {
        const since = ms(lastObserved.blockTime) >= ms(tail.from) ? lastObserved.blockTime : tail.from;
        const days = Math.round(((ms(coveredThrough) - ms(since)) / DAY_MS) * 10) / 10;
        return { ...base, state: 'observed', noRedemptionDays: days, since,
            message: `Last observed redemption ${lastObserved.blockTime}; ${counts.redemptions} in the retained coverage.${lagging}` };
    }
    const days = Math.round(((ms(coveredThrough) - ms(tail.from)) / DAY_MS) * 10) / 10;
    // Absence needs a real stretch of coverage behind it: "none in 0 days" read as a finding.
    if (days < MIN_ABSENCE_DAYS) {
        return { ...base, state: 'not-yet-covered',
            message: `Continuous coverage is only ${days} day(s) (${tail.from} to ${coveredThrough}); too short to say redemptions are absent.${lagging}` };
    }
    return { ...base, state: 'none-observed', noRedemptionDays: days, since: tail.from,
        message: `No redemption observed in ${days} day(s) of continuous coverage (${tail.from} to ${coveredThrough}).${lagging}` };
}

/** Shortest continuous coverage, in days, that can support "no redemption observed". */
export const MIN_ABSENCE_DAYS = 1;

/** The public, compact feed record the builder attaches to an issuer's redemption block. */
export function publicFeed(entry, { now } = {}) {
    if (!entry) return null;
    if (entry.observable === false) {
        return { observable: false, mechanism: entry.mechanism ?? null, whyNotObservable: entry.whyNotObservable ?? null,
            tripwire: entry.tripwire ?? null, checkedAt: entry.lastScan?.at ?? null, source: 'stocks/data/redemption-observations.json' };
    }
    const summary = summariseFeed(entry, { now });
    return {
        observable: true,
        mechanism: entry.mechanism ?? null,
        completionObservable: entry.completionObservable !== false,
        ...summary,
        lastObserved: entry.lastObserved ?? null,
        // Per-mint flow amounts stay in the observation file (stocks/build-flows.mjs reads them);
        // the issuer record carries the counters only.
        daily: Object.fromEntries(Object.entries(entry.daily ?? {}).map(([day, { flows, ...counts }]) => [day,
            { ...counts, coveredHours: coveredHoursOn(entry.coverage ?? [], day) }])),
        source: 'stocks/data/redemption-observations.json'
    };
}

/**
 * The builder's merge. Documented route, operational availability and observed execution stay
 * separate fields: this only ever adds `observationFeed` and, when the recurring scan holds an
 * accepted redemption newer than the dossier's one-off snapshot, replaces the OBSERVED-EXECUTION
 * evidence with it (the snapshot is kept as `supersedes`). A failed or stale scan never removes an
 * observation; it only changes what the feed says about the recent past.
 */
export function mergeObservationIntoRedemption(redemption, entry, { now } = {}) {
    if (!redemption || typeof redemption !== 'object' || !entry) return redemption;
    const feed = publicFeed(entry, { now });
    const out = { ...redemption, observationFeed: feed };
    const snapshot = redemption.successfulRedemptionEvidence ?? null;
    const latest = entry.lastObserved ?? null;
    const snapshotTo = ms(snapshot?.searchWindow?.to);
    // A programme whose completion happens off-chain (Superstate's book-entry credit) shows its
    // on-chain leg in the feed only; it never becomes "successful redemption observed".
    if (!feed.observable || entry.completionObservable === false || !latest || !(Array.isArray(entry.recent) && entry.recent.length)) return out;
    if (Number.isFinite(snapshotTo) && ms(latest.blockTime) <= snapshotTo) return out;
    const rejected = Object.entries(feed.rejected30d ?? {}).map(([reason, count]) => ({ count, reason }));
    out.successfulRedemptionObserved = true;
    out.successfulRedemptionEvidence = {
        status: 'observed-onchain-recurring-scan',
        checkedAt: feed.lastScanAt,
        chain: 'solana',
        route: snapshot?.route ?? entry.route ?? null,
        settlement: snapshot?.settlement ?? entry.settlement ?? null,
        searchWindow: { from: feed.coveredFrom, to: feed.coveredThrough },
        acceptedCount: feed.counts30d.redemptions,
        latestObservedAt: latest.blockTime,
        observedProducts: Object.values(entry.byProduct ?? {}).map((p) => p.symbol).filter(Boolean).sort(),
        scanned: `Recurring scan (stocks/observe-redemptions.mjs) of every new transaction at ${Object.keys(entry.addresses ?? {}).length} address(es) since its checkpoint, classified by stocks/lib/redemption-observation.mjs; ${feed.counts30d.redemptions} accepted in ${feed.coverageIntervals} coverage interval(s) from ${feed.coveredFrom} to ${feed.coveredThrough}.`,
        accepted: entry.recent,
        rejected,
        caveats: snapshot?.caveats ?? null,
        source: 'stocks/data/redemption-observations.json',
        supersedes: snapshot ? { status: snapshot.status ?? null, checkedAt: snapshot.checkedAt ?? null, searchWindow: snapshot.searchWindow ?? null } : null
    };
    return out;
}
