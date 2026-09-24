// PURE construction of stocks-closed-market.json: per tokenized stock, what each Solana lending
// market that accepts it as collateral does when the US market is closed (the price it uses, its
// liquidation threshold, one sentence of what that means for a borrower), the market's collateral
// price freezes in the last 30 days, the lender's Monday gap, the Solana depth that moves the token
// 5 % and 10 %, and — only where a lender prices from the token's own 24/7 trading (Nest) — the
// weekend move in that price. No I/O and no clock: every instant comes from the inputs, so the
// whole view is unit-tested headlessly (../closed-market.test.js). stocks/build-closed-market.mjs
// reads the files and the database and writes the output.
//
// Sources, in the order they are trusted: the structured research in
// stocks/data/protocol-market-research.json (`oraclePricing`, read on-chain 2026-09-24), the lending
// watcher's live rows (sonar.lending_price_freeze / lending_scan, stocks/watch-lending.mjs), the
// Kamino keyless hourly reserve history (stocks/fetch-lender-price-history.mjs), Jupiter keyless
// quotes (stocks/fetch-solana-depth.mjs) and the premium tracking build (stocks-tracking.json).
// A source that was not read is reported as not collected, never as zero or "none".

import { FREEZE_FLOOR_MS, normaliseFreeze } from './events.mjs';
import { median } from './grade.mjs';

export const SCHEMA = 'rwa-sonar-closed-market-v1';
/** Freeze episodes are listed for this many days back from the build's as-of instant. */
export const FREEZE_WINDOW_DAYS = 30;
/** Monday gaps shown per lender market, newest first. */
export const GAP_WEEKS_SHOWN = 3;
/** A depth sample older than this is not shown as the current depth. */
export const DEPTH_MAX_AGE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The five labels the site uses for "the price a lender uses when the US market is closed". */
export const LABEL_KINDS = {
    'frozen-at-close': 'frozen at close',
    'overnight-24x5': '24/5 overnight',
    'token-24x7': '24/7 token price',
    'signed-quote': 'signed quote',
    stale: 'stale since',
    'not-researched': 'not researched'
};

/** When each label's price is re-marked to the stock after a weekend. */
const REMARK = {
    'frozen-at-close': 'Monday 09:30 ET, in one step',
    'overnight-24x5': 'Sunday 20:00 ET, when the overnight session reopens',
    'token-24x7': 'none: it moves with the token all weekend',
    'signed-quote': 'none: it moves with the quote all weekend',
    stale: 'never, while the price is stale',
    'not-researched': null
};

/** Watcher causes that mean an operator suspended the price (corporate-action windows). */
const SUSPENSION_CAUSES = new Set(['scope-suspension', 'operator-suspension']);

const PROTOCOL_NAMES = { kamino: 'Kamino', 'jupiter-lend': 'Jupiter Lend', nest: 'Nest', loopscale: 'Loopscale' };

/** The finding types this view emits (finding-types.json), with the rule that decides each. */
export const FINDING_SCHEMAS = {
    tokenTrading: 'collateral-priced-from-token-trading',
    corporateAction: 'collateral-oracle-suspended-around-corporate-action',
    staleOracle: 'collateral-oracle-stale-blocks-liquidation',
    docsFallback: 'protocol-docs-oracle-fallback-contradicted'
};

function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timeMs(iso) {
    if (typeof iso !== 'string') return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

function isoOf(ms) {
    return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

function round(value, digits = 2) {
    if (!Number.isFinite(value)) return null;
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

/** `kamino:xstocks-pool:oracle` → `kamino:xstocks-pool`, the id the lending watcher stores. */
export function marketIdOf(id) {
    return typeof id === 'string' ? id.replace(/:oracle$/, '') : null;
}

/** "26 Aug 2026" from an ISO instant (UTC), for the stale label. */
export function dayText(iso) {
    const ms = timeMs(iso);
    if (ms === null) return null;
    const d = new Date(ms);
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

/**
 * The label kind for one market, from the research's `whenMarketClosed.behaviour` and its price
 * source. A signed quote is told apart from a feed that follows the token because the borrower
 * cannot check it against anything public. An unknown behaviour is `not-researched`, never a guess.
 */
export function labelKindOf(market) {
    if (text(market?.priceSource?.kind) === 'protocol-signed-quote') return 'signed-quote';
    switch (text(market?.whenMarketClosed?.behaviour)) {
    case 'frozen-at-regular-close':
    case 'frozen-at-session-close':
    case 'daily-price':
        return 'frozen-at-close';
    case 'moves-24x5-frozen-at-weekend':
        return 'overnight-24x5';
    case 'moves-24x7-with-token':
        return 'token-24x7';
    case 'stale':
        return 'stale';
    default:
        return 'not-researched';
    }
}

/**
 * The live freeze rows for one market and mint, newest start first. The watcher's rows are what
 * say whether a price the research found stale is STILL stale.
 */
function rowsFor(freezeRows, marketId, mint) {
    return (Array.isArray(freezeRows) ? freezeRows : [])
        .filter((row) => row?.market_id === marketId && row?.mint === mint)
        .sort((a, b) => (timeMs(b?.started_at) ?? 0) - (timeMs(a?.started_at) ?? 0));
}

/**
 * The stale label's date and whether the watcher still sees it stale. The research's publish time
 * is the fallback; an ongoing watcher episode for the same market and mint wins (it is newer), and
 * an episode that has ENDED turns the label back into what the price source does when it works.
 */
export function staleState(collateral, freezeRows, marketId, freezesRead) {
    const researched = text(collateral?.lastPublish);
    if (!freezesRead) return { since: researched, stillAt: null, ended: null, basis: 'research' };
    const rows = rowsFor(freezeRows, marketId, collateral?.mint);
    const ongoing = rows.find((row) => row?.ended_at === null || row?.ended_at === undefined) ?? null;
    if (ongoing !== null) {
        return { since: text(ongoing.started_at) ?? researched, stillAt: text(ongoing.last_seen_stale_at), ended: null, basis: 'watcher' };
    }
    const sameEpisode = rows.find((row) => text(row?.started_at) === researched) ?? null;
    if (sameEpisode !== null && text(sameEpisode.ended_at) !== null) {
        return { since: researched, stillAt: null, ended: text(sameEpisode.ended_at), basis: 'watcher' };
    }
    return { since: researched, stillAt: null, ended: null, basis: 'research' };
}

/** Short names for the markets whose research name is a description; a card pays for every byte. */
const SHORT_NAMES = {
    'jupiter-lend:xstocks-vaults': 'Jupiter Lend xStock vaults',
    'nest:xstocks-pyth-lazer': 'Nest xStock markets',
    'nest:jupiter-signed': 'Nest signed-price markets',
    'loopscale:xstocks-orca-vaults': 'Loopscale Orca vaults',
    'loopscale:secz-usdc-rwa': 'Loopscale USDC RWA vault'
};

/** "Kamino xStocks Pool", or the market name alone when it already starts with the protocol's. */
export function displayNameOf(protocolName, marketName, marketId = null) {
    if (marketId !== null && SHORT_NAMES[marketId]) return SHORT_NAMES[marketId];
    if (!marketName) return protocolName;
    return marketName.toLowerCase().startsWith(String(protocolName).toLowerCase()) ? marketName : `${protocolName} ${marketName}`;
}

/** The first evidence URL a market carries, for the "source" link on its row. */
function firstEvidence(market) {
    const list = Array.isArray(market?.evidence) ? market.evidence : [];
    const hit = list.find((e) => text(e?.url)) ?? null;
    return hit === null ? null : { url: text(hit.url), label: text(hit.label), accessedAt: text(hit.accessedAt) };
}

/**
 * Freeze episodes for one market and mint inside the window, each with its length as a range (the
 * events feed's normaliseFreeze), longest first. Episodes that certainly lasted under
 * FREEZE_FLOOR_MS are keeper hiccups: counted, not listed. `read: false` means the watcher's rows
 * were not read in this build, which is not the same as "no freezes".
 */
export function freezeSummary({ freezeRows, scanRows, marketId, mint, protocolId, freezesRead, asOf, windowDays = FREEZE_WINDOW_DAYS }) {
    const watched = protocolId === 'kamino' || protocolId === 'jupiter-lend' || protocolId === 'loopscale';
    if (!watched) return { read: freezesRead, watched: false, coverage: null, episodes: [], shorter: 0 };
    if (!freezesRead) return { read: false, watched: true, coverage: null, episodes: [], shorter: 0 };
    const asOfMs = timeMs(asOf);
    const fromMs = asOfMs === null ? null : asOfMs - windowDays * DAY_MS;
    const episodes = [];
    let shorter = 0;
    for (const row of rowsFor(freezeRows, marketId, mint)) {
        const ep = normaliseFreeze(row);
        if (ep.startedAt === null || ep.highMs === null) continue;
        const endMs = timeMs(ep.endedAt) ?? asOfMs;
        if (fromMs !== null && endMs !== null && endMs < fromMs && !ep.ongoing) continue;
        if (ep.lowMs < FREEZE_FLOOR_MS) {
            shorter += 1;
            continue;
        }
        episodes.push({
            startedAt: ep.startedAt,
            endedAt: ep.endedAt,
            ongoing: ep.ongoing,
            lowHours: round(ep.lowMs / HOUR_MS, 1),
            highHours: round(ep.highMs / HOUR_MS, 1),
            cause: ep.cause,
            observation: text(row?.observation),
            endSignature: text(row?.end_signature)
        });
    }
    episodes.sort((a, b) => (timeMs(b.startedAt) ?? 0) - (timeMs(a.startedAt) ?? 0));
    return { read: true, watched: true, coverage: coverageFor(scanRows, marketId, mint), episodes, shorter };
}

/**
 * How far the watcher has read for this market and mint: transactions read up to `readTo` (Kamino
 * reserves and Jupiter Lend caches, backfilled oldest first) or the Pyth account last checked at
 * `checkedAt` (Loopscale). Null when the watcher has no row for it.
 */
export function coverageFor(scanRows, marketId, mint) {
    const rows = (Array.isArray(scanRows) ? scanRows : [])
        .filter((row) => row?.market_id === marketId && row?.mint === mint && ['kamino-reserve', 'jl-cache', 'pyth-price'].includes(row?.role));
    if (rows.length === 0) return null;
    const reads = rows.map((row) => text(row.last_block_time)).filter(Boolean).sort();
    const checks = rows.map((row) => text(row.checked_at)).filter(Boolean).sort();
    return {
        readTo: reads.length ? reads[0] : null,
        checkedAt: checks.length ? checks.at(-1) : null,
        since: rows.map((row) => text(row.backfill_from)).filter(Boolean).sort()[0] ?? null
    };
}

/** The lender market's Monday gaps (lender-price-gaps.json weekends[]), newest first. */
export function gapsFor(gapDoc, marketId, mint, weeks = GAP_WEEKS_SHOWN) {
    return (Array.isArray(gapDoc?.weekends) ? gapDoc.weekends : [])
        .filter((row) => row?.marketId === marketId && row?.mint === mint && finite(row?.gapPct) !== null)
        .sort((a, b) => (timeMs(b.reopenAt) ?? 0) - (timeMs(a.reopenAt) ?? 0))
        .slice(0, weeks)
        .map((row) => ({
            closeAt: text(row.closeAt), closeValue: finite(row.closeValue), reopenAt: text(row.reopenAt),
            reopenValue: finite(row.reopenValue), gapPct: round(row.gapPct, 2), movedWhileClosedPct: round(finite(row.movedWhileClosedPct), 2)
        }));
}

/**
 * One row per lending market that takes this mint: from the research's structured markets, then any
 * lending integration the DeFi collector saw that the research did not price (labelled
 * `not-researched`, so the page never implies it knows how that market prices the token).
 */
export function lenderRowsFor(mint, { oraclePricing, defiUsageItem, freezeRows, scanRows, freezesRead, gapDoc, gapsRead, asOf }) {
    const rows = [];
    const researchedProtocols = new Set();
    for (const market of Array.isArray(oraclePricing?.markets) ? oraclePricing.markets : []) {
        const collateral = (Array.isArray(market?.collateral) ? market.collateral : []).find((c) => c?.mint === mint) ?? null;
        if (collateral === null) continue;
        const marketId = marketIdOf(market.id);
        const protocolId = text(market.protocolId);
        researchedProtocols.add(protocolId);
        let kind = labelKindOf(market);
        let staleSince = null;
        let staleStillAt = null;
        let staleEnded = null;
        if (kind === 'stale') {
            const state = staleState(collateral, freezeRows, marketId, freezesRead);
            staleSince = state.since;
            staleStillAt = state.stillAt;
            staleEnded = state.ended;
            // The price is flowing again: a Pyth equity account that only updates in market hours.
            if (staleEnded !== null) kind = 'frozen-at-close';
        }
        const label = kind === 'stale' ? `stale since ${dayText(staleSince) ?? 'an unknown date'}` : LABEL_KINDS[kind];
        const protocolName = PROTOCOL_NAMES[protocolId] ?? protocolId;
        rows.push({
            protocolId,
            protocolName,
            marketId,
            marketName: text(market.marketName),
            displayName: displayNameOf(protocolName, text(market.marketName), marketId),
            labelKind: kind,
            label,
            staleSince,
            staleStillAt,
            staleEndedAt: staleEnded,
            maxLtvPct: finite(collateral.maxLtvPct),
            liquidationLtvPct: finite(collateral.liquidationLtvPct),
            hidden: collateral.reserveStatus === 'hidden',
            remark: REMARK[kind],
            sentence: text(market.borrowerSentence),
            source: firstEvidence(market),
            freezes: freezeSummary({ freezeRows, scanRows, marketId, mint, protocolId, freezesRead, asOf }),
            // Kamino's hourly history measures its gap; Jupiter Lend re-marks on Sunday evening from
            // the overnight session and no keyless history of its price is collected, so it says so.
            mondayGaps: protocolId === 'kamino' ? { read: gapsRead, weeks: gapsRead ? gapsFor(gapDoc, marketId, mint) : [] }
                : kind === 'overnight-24x5' ? { read: true, weeks: [], unmeasured: 're-marked Sunday 20:00 ET; not measured' } : null
        });
    }
    for (const integration of Array.isArray(defiUsageItem?.integrations) ? defiUsageItem.integrations : []) {
        if (integration?.category !== 'lending') continue;
        const protocolId = text(integration.protocolId);
        if (protocolId === null || researchedProtocols.has(protocolId)) continue;
        researchedProtocols.add(protocolId);
        const protocolName = text(integration.protocolName) ?? PROTOCOL_NAMES[protocolId] ?? protocolId;
        rows.push({
            protocolId,
            protocolName,
            marketId: text(integration.id),
            marketName: null,
            displayName: protocolName,
            labelKind: 'not-researched',
            label: LABEL_KINDS['not-researched'],
            staleSince: null, staleStillAt: null, staleEndedAt: null,
            maxLtvPct: null, liquidationLtvPct: null, hidden: false,
            remark: null,
            sentence: 'Seen taking this token; the price it uses when the market is closed has not been researched.',
            source: null,
            freezes: { read: freezesRead, watched: false, coverage: null, episodes: [], shorter: 0 },
            mondayGaps: null
        });
    }
    // Same order everywhere: the research's protocol order, then the market id.
    const order = ['kamino', 'jupiter-lend', 'nest', 'loopscale'];
    const rank = (id) => (order.indexOf(id) === -1 ? order.length : order.indexOf(id));
    return rows.sort((a, b) => rank(a.protocolId) - rank(b.protocolId) || String(a.marketId).localeCompare(String(b.marketId)));
}

/** The session a depth sample was taken in, coarse: weekday (open or not) or weekend. */
function depthBucket(sample) {
    return sample?.session === 'weekend' ? 'weekend' : 'weekday';
}

/**
 * The newest weekday and the newest weekend depth sample for a mint (solana-depth.json samples[]),
 * each no older than DEPTH_MAX_AGE_DAYS. The thresholds are the collector's, never recomputed here.
 */
export function depthFor(depthDoc, mint, asOf) {
    const asOfMs = timeMs(asOf);
    const out = { read: depthDoc !== null && depthDoc !== undefined, weekday: null, weekend: null };
    for (const sample of Array.isArray(depthDoc?.samples) ? depthDoc.samples : []) {
        if (sample?.mint !== mint) continue;
        const at = timeMs(sample.at);
        if (at === null) continue;
        if (asOfMs !== null && asOfMs - at > DEPTH_MAX_AGE_DAYS * DAY_MS) continue;
        const bucket = depthBucket(sample);
        if (out[bucket] === null || at > timeMs(out[bucket].at)) {
            out[bucket] = {
                at: sample.at,
                session: text(sample.session),
                priceUsd: finite(sample.priceUsd),
                noPrice: sample.noPrice === true,
                at5Pct: sample.at5Pct ?? null,
                at10Pct: sample.at10Pct ?? null
            };
        }
    }
    return out;
}

/**
 * The latest completed weekend (a closed stretch of the US schedule that contains a UTC Saturday)
 * in the tracking build, or null.
 */
export function latestWeekend(tracking) {
    const stretches = (Array.isArray(tracking?.premium?.schedules) ? tracking.premium.schedules : [])
        .flatMap((schedule) => (Array.isArray(schedule?.closed) ? schedule.closed : []));
    let best = null;
    for (const stretch of stretches) {
        const from = timeMs(stretch?.[0]);
        const to = timeMs(stretch?.[1]);
        if (from === null || to === null || to <= from) continue;
        // A weekend stretch contains a whole UTC Saturday; a weeknight never does.
        let saturday = false;
        for (let t = from; t <= to; t += HOUR_MS) {
            if (new Date(t).getUTCDay() === 6) {
                saturday = true;
                break;
            }
        }
        if (!saturday || to - from < 36 * HOUR_MS) continue;
        if (best === null || from > best.fromMs) best = { fromMs: from, toMs: to, from: stretch[0], to: stretch[1] };
    }
    return best;
}

/**
 * The weekend move in the price a 24/7-priced lender uses: every tracking point for this mint
 * inside the latest weekend, as the premium to the frozen Friday reference. Nest values xStocks
 * from the token's 24/7 feed and its other markets from a quote on the token, so the token's own
 * weekend price against Friday's close is how far that lender's price moved. Null when there is no
 * point — a missing measurement, not a flat weekend.
 */
export function weekendMoveFor(tracking, mint, weekend) {
    if (weekend === null) return null;
    const points = [];
    for (const underlying of Array.isArray(tracking?.premium?.underlyings) ? tracking.premium.underlyings : []) {
        for (const wrapper of Array.isArray(underlying?.wrappers) ? underlying.wrappers : []) {
            if (wrapper?.mint !== mint) continue;
            for (const point of Array.isArray(wrapper.points) ? wrapper.points : []) {
                const t = timeMs(point?.t);
                const p = finite(point?.p);
                if (t === null || p === null || t < weekend.fromMs || t >= weekend.toMs) continue;
                points.push({ t, p, n: finite(point?.n) ?? 1, kind: text(point?.kind) });
            }
        }
    }
    if (points.length === 0) return null;
    const values = points.map((point) => point.p);
    let widest = points[0];
    for (const point of points) if (Math.abs(point.p) > Math.abs(widest.p)) widest = point;
    return {
        weekendFrom: weekend.from,
        weekendTo: weekend.to,
        observations: points.length,
        trades: points.filter((point) => point.kind === 'trades').reduce((sum, point) => sum + point.n, 0),
        medianPct: round(median(values), 2),
        widestPct: round(widest.p, 2),
        widestAt: isoOf(widest.t)
    };
}

/** One finding-type entry by slug, or null. */
function findingType(findingTypes, schema) {
    return (Array.isArray(findingTypes) ? findingTypes : []).find((t) => t?.schema === schema) ?? null;
}

/**
 * The findings this token's lending markets carry, derived from the same structured evidence the
 * rows show (the issuer dossiers carry the programme-level versions). One per schema and market.
 */
export function tokenFindings({ mint, symbol, lenders, oraclePricing, findingTypes }) {
    const out = [];
    // `short` is the one-line form a byte-capped card shows; `statement` is the full sentence.
    const push = (schema, market, statement, source, short) => {
        const type = findingType(findingTypes, schema);
        if (type === null) return;
        out.push({ schema, name: type.name, severity: type.defaultSeverity, marketId: market, short, statement, source });
    };
    for (const lender of lenders) {
        const where = lender.displayName ?? lender.protocolName;
        if (lender.labelKind === 'token-24x7' || lender.labelKind === 'signed-quote') {
            push(FINDING_SCHEMAS.tokenTrading, lender.marketId,
                lender.labelKind === 'token-24x7'
                    ? `${where} values ${symbol} from the token's own 24/7 price, so weekend and night trading in the token can liquidate borrowers whatever the stock does.`
                    : `${where} values ${symbol} from a price it signs from a Jupiter quote on the token, around the clock.`,
                lender.source, lender.protocolName);
        }
        if (lender.labelKind === 'stale') {
            push(FINDING_SCHEMAS.staleOracle, lender.marketId,
                `${where}'s ${symbol} price was last published ${dayText(lender.staleSince) ?? 'on an unknown date'}${lender.staleStillAt ? ` and was still stale at ${lender.staleStillAt}` : ''}; loans against it can neither roll nor be liquidated.`,
                lender.source, `${lender.protocolName}, since ${dayText(lender.staleSince) ?? 'an unknown date'}`);
        }
    }
    // Corporate-action suspensions: the research's dated episodes for this token…
    const dated = new Set();
    for (const event of Array.isArray(oraclePricing?.freezeEvents) ? oraclePricing.freezeEvents : []) {
        if (!/corporate-action/.test(String(event?.cause))) continue;
        const tokens = String(event?.token ?? '').split(',').map((s) => s.trim());
        if (!tokens.includes(symbol)) continue;
        const markets = (Array.isArray(event.markets) ? event.markets : []).filter((id) => lenders.some((l) => l.marketId === id));
        if (markets.length === 0) continue;
        const hours = round((timeMs(event.to) - timeMs(event.from)) / HOUR_MS, 0);
        const names = [...new Set(markets.map((id) => lenders.find((l) => l.marketId === id)?.protocolName).filter(Boolean))];
        const evidence = (Array.isArray(event.evidence) ? event.evidence : []).find((e) => text(e?.url)) ?? null;
        for (const id of markets) dated.add(id);
        push(FINDING_SCHEMAS.corporateAction, markets[0],
            `${names.join(' and ')} stopped updating the ${symbol} collateral price for about ${hours} h (${event.from} to ${event.to}) around a corporate action; borrowing, withdrawing against debt and liquidation were blocked until an operator resumed it.`,
            evidence === null ? null : { url: text(evidence.url), label: text(evidence.label), accessedAt: text(evidence.accessedAt) },
            `${names.join(' and ')}, about ${hours} h from ${dayText(event.from)}`);
    }
    // …and from the watcher's own episodes: a Scope corporate-action suspension (resumed by the Scope
    // admin) or a Jupiter Lend operator suspension, on a market the research had not already dated.
    for (const lender of lenders) {
        if (dated.has(lender.marketId)) continue;
        const episode = (lender.freezes?.episodes ?? []).find((e) => SUSPENSION_CAUSES.has(e.cause));
        if (!episode) continue;
        dated.add(lender.marketId);
        const length = episode.ongoing ? `since ${episode.startedAt}` : `for about ${round(episode.highHours, 0)} h from ${episode.startedAt}`;
        push(FINDING_SCHEMAS.corporateAction, lender.marketId,
            `${lender.displayName} stopped updating the ${symbol} collateral price ${length} under an operator suspension (the lending watcher's record); borrowing, withdrawing against debt and liquidation were blocked meanwhile.`,
            episode.endSignature ? { url: `https://solscan.io/tx/${episode.endSignature}`, label: 'Transaction that resumed the price', accessedAt: null } : null,
            `${lender.protocolName}, ${episode.ongoing ? `since ${dayText(episode.startedAt)}` : `about ${round(episode.highHours, 0)} h from ${dayText(episode.startedAt)}`}`);
    }
    // Kamino's docs promise a fallback that its configured MostRecentOf chain does not have.
    const kaminoGate = lenders.find((l) => l.protocolId === 'kamino' && l.labelKind === 'frozen-at-close'
        && (oraclePricing?.markets ?? []).some((m) => marketIdOf(m.id) === l.marketId && (m.collateral ?? []).some((c) => c.mint === mint && Number.isInteger(c.mostRecentOfEntry))));
    if (kaminoGate) {
        const docs = (oraclePricing.markets ?? []).flatMap((m) => m.evidence ?? []).find((e) => /kamino\.com\/docs\/security\/oracles/.test(String(e?.url))) ?? null;
        push(FINDING_SCHEMAS.docsFallback, kaminoGate.marketId,
            `Kamino's docs say Scope falls back to the next-best source when a feed goes stale; the ${symbol} price chain (MostRecentOf) errors instead, and Kamino xStock reserves have been observed stale for hours to days.`,
            docs === null ? null : { url: text(docs.url), label: text(docs.label), accessedAt: text(docs.accessedAt) }, 'Kamino');
    }
    return out;
}

/**
 * The whole per-mint item. `lenders` empty means no lending market takes the token (as far as the
 * research and the DeFi collector know), which the card says in one line.
 */
export function closedMarketItem(token, ctx) {
    const mint = token?.mint;
    const symbol = text(token?.symbol) ?? mint;
    const lenders = lenderRowsFor(mint, { ...ctx, defiUsageItem: ctx.defiUsage?.get?.(mint) ?? null });
    const priced24x7 = lenders.some((l) => l.labelKind === 'token-24x7' || l.labelKind === 'signed-quote');
    return {
        mint,
        symbol,
        lenders,
        depth: lenders.length ? depthFor(ctx.depthDoc, mint, ctx.asOf) : null,
        // The weekend premium survives only where a lender's price follows the token (Nest).
        weekendMove: priced24x7 ? { read: ctx.tracking !== null && ctx.tracking !== undefined, move: weekendMoveFor(ctx.tracking, mint, ctx.weekend) } : null,
        findings: tokenFindings({ mint, symbol, lenders, oraclePricing: ctx.oraclePricing, findingTypes: ctx.findingTypes })
    };
}

/** Every token's item plus the counts the run log and the page need. */
export function buildClosedMarket({ tokens, oraclePricing, defiUsage, freezeRows, scanRows, freezesRead, gapDoc, depthDoc, tracking, findingTypes, asOf }) {
    const defiIndex = new Map((Array.isArray(defiUsage?.items) ? defiUsage.items : []).map((item) => [item?.mint, item]));
    const ctx = {
        oraclePricing, defiUsage: defiIndex, freezeRows, scanRows, freezesRead: Boolean(freezesRead),
        gapDoc: gapDoc ?? null, gapsRead: gapDoc !== null && gapDoc !== undefined,
        depthDoc: depthDoc ?? null, tracking: tracking ?? null, weekend: latestWeekend(tracking), findingTypes, asOf
    };
    const items = [];
    for (const token of Array.isArray(tokens) ? tokens : []) {
        if (typeof token?.mint !== 'string') continue;
        const item = closedMarketItem(token, ctx);
        if (item.lenders.length) items.push(item);
    }
    items.sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    return { items, weekend: ctx.weekend === null ? null : { from: ctx.weekend.from, to: ctx.weekend.to } };
}

/** Counts for the run log. */
export function summarize(items) {
    const list = Array.isArray(items) ? items : [];
    const byKind = {};
    for (const item of list) for (const lender of item.lenders) byKind[lender.labelKind] = (byKind[lender.labelKind] ?? 0) + 1;
    return {
        tokens: list.length,
        lenderRows: list.reduce((sum, item) => sum + item.lenders.length, 0),
        byKind,
        freezeEpisodes: list.reduce((sum, item) => sum + item.lenders.reduce((s, l) => s + l.freezes.episodes.length, 0), 0),
        findings: list.reduce((sum, item) => sum + item.findings.length, 0),
        withDepth: list.filter((item) => item.depth?.weekday || item.depth?.weekend).length,
        withWeekendMove: list.filter((item) => item.weekendMove?.move).length
    };
}

/**
 * The SQL (psql form) that reads the watcher's freeze episodes touching the window and its scan
 * coverage, as one JSON document {freezes, scan}. `since` must be an ISO UTC instant; it is inlined.
 */
export function closedMarketRowsPsql({ since }) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(String(since))) {
        throw new Error(`closedMarketRowsPsql: since must be an ISO UTC instant, got ${since}`);
    }
    const utc = (column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
    return `SELECT json_build_object(
  'freezes', COALESCE((SELECT json_agg(row_to_json(f)) FROM (
      SELECT protocol, market_id, mint, symbol, ${utc('started_at')} AS started_at, ${utc('ended_at')} AS ended_at,
             ${utc('last_seen_stale_at')} AS last_seen_stale_at, observation, cause, evidence->>'endBasis' AS end_basis,
             start_signature, end_signature
        FROM sonar.lending_price_freeze
       WHERE ended_at IS NULL OR ended_at >= '${since}'::timestamptz OR started_at >= '${since}'::timestamptz
       ORDER BY started_at DESC
       LIMIT 5000) f), '[]'::json),
  'scan', COALESCE((SELECT json_agg(row_to_json(s)) FROM (
      SELECT protocol, role, market_id, mint, ${utc('backfill_from')} AS backfill_from,
             ${utc('last_block_time')} AS last_block_time, ${utc('updated_at')} AS checked_at
        FROM sonar.lending_scan
       WHERE role IN ('kamino-reserve', 'jl-cache', 'pyth-price')) s), '[]'::json))::text;`;
}

/** Whether the watcher's tables exist here, as the psql probe prints it (`t`/`f`). */
export const CLOSED_MARKET_TABLE_PROBE = "SELECT to_regclass('sonar.lending_price_freeze') IS NOT NULL AND to_regclass('sonar.lending_scan') IS NOT NULL;";

/** The whole output file. */
export function buildPayload({ generatedAt, asOf, researchReviewedAt, inputs, weekend, items }) {
    return {
        schema: SCHEMA,
        generatedAt,
        asOf,
        researchReviewedAt: researchReviewedAt ?? null,
        freezeWindowDays: FREEZE_WINDOW_DAYS,
        labels: LABEL_KINDS,
        method: 'For each lending market that accepts a token: the price it uses while the US market is closed and its liquidation threshold, from on-chain reads recorded in stocks/data/protocol-market-research.json (oraclePricing); '
            + `collateral price freezes of ${FREEZE_FLOOR_MS / 60000} minutes or more in the last ${FREEZE_WINDOW_DAYS} days from the lending watcher (sonar.lending_price_freeze), with how far it has read; `
            + 'the Monday gap from Kamino\'s hourly reserve history (the lender\'s price at the second hourly reading after Friday\'s close against its first reading after the reopening); '
            + 'Solana depth as the USD sale to USDC at which Jupiter reports a 5 % and a 10 % average price impact; '
            + 'and, only for tokens a lender prices from the token\'s own 24/7 trading (Nest), the weekend move of the token against Friday\'s reference from stocks-tracking.json. '
            + 'Exposure (collateral within the gap of liquidation) is not measured.',
        inputs,
        weekend: weekend ?? null,
        items
    };
}
