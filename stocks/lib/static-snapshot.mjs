// Writes the current catalogue counts into marked regions of hand-authored pages (the landing hero,
// its float finding and redemption line, and the pitch's powers heading, sources and built-state
// numbers), so their static HTML never says "Loading…" or carries a number typed weeks ago that the
// page it links to contradicts. Pure: the builder (stocks/build-static-snapshot.mjs) does the file I/O.
import counts from './catalogue-counts.js';
import eventsView from './events-view.js';
import fmt from './fmt.js';

const { escapeHtml, fmtDate, fmtMoney, fmtNumber, fmtPct } = fmt;
const { issuerProgrammeSummary, programmeExceptions } = counts;

/** The pages this step rewrites, repo-relative. refresh-on-server.sh copies exactly these. */
export const STATIC_SNAPSHOT_PAGES = ['index.html', 'pitch/index.html'];

/**
 * Replaces everything between `<!-- snapshot:NAME:start -->` and `<!-- snapshot:NAME:end -->`.
 * Missing or repeated markers throw: a silently skipped region would leave stale numbers in place.
 */
export function replaceMarkedRegion(html, name, content) {
    const start = `<!-- snapshot:${name}:start -->`;
    const end = `<!-- snapshot:${name}:end -->`;
    const from = html.indexOf(start);
    const to = html.indexOf(end);
    if (from === -1 || to === -1 || to < from) throw new Error(`snapshot region "${name}" is not marked`);
    if (html.indexOf(start, from + 1) !== -1 || html.indexOf(end, to + 1) !== -1) {
        throw new Error(`snapshot region "${name}" is marked more than once`);
    }
    return html.slice(0, from + start.length) + content + html.slice(to);
}

function requireCount(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`static snapshot: ${label} is missing`);
    return value;
}

function requireDate(value, label) {
    if (fmtDate(value) === fmt.DASH) throw new Error(`static snapshot: ${label} is not a date`);
    return value;
}

/** How many of the newest events the landing page's box carries before any script runs. */
export const LANDING_EVENT_ROWS = 8;

function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The issuer whose flows the landing and pitch quote: the busiest programme the scan reads. */
const FLOW_ISSUER = 'ondo-global-markets';

/**
 * The newest day of `slug` the redemption scan actually read (covered hours > 0 and a counted
 * redemption total), as flows.html shows it. null when the window holds no such day: a day not read
 * is missing, never zero.
 */
function latestCoveredDay(flows, slug) {
    const issuer = (Array.isArray(flows?.flows?.issuers) ? flows.flows.issuers : []).find((row) => row?.slug === slug);
    const days = Array.isArray(issuer?.days) ? issuer.days : [];
    for (let i = days.length - 1; i >= 0; i -= 1) {
        const day = days[i];
        const hours = numberOrNull(day?.redeemed?.coveredHours);
        const count = numberOrNull(day?.redeemed?.count);
        if (hours === null || hours <= 0 || count === null) continue;
        const createdHours = numberOrNull(day?.created?.coveredHours);
        const created = numberOrNull(day?.created?.count);
        return {
            date: day.date,
            redeemed: { count, hours },
            created: created === null || createdHours === null || createdHours <= 0 ? null : { count: created, hours: createdHours }
        };
    }
    return null;
}

/** The xStocks public-float totals of stocks-flows.json, or null when the file carries none. */
function floatFacts(flows) {
    const float = flows?.float;
    const t = float?.totals;
    if (!float || !t) return null;
    return {
        readAt: float.readAt ?? null,
        sharePct: numberOrNull(t.inventorySharePct),
        supplyUsd: numberOrNull(t.supplyUsd),
        inventoryUsd: numberOrNull(t.inventoryUsd),
        floatUsd: numberOrNull(t.floatUsd),
        pricedMints: numberOrNull(t.pricedMints)
    };
}

/** Shapes the counts from the built files; throws rather than writing a guessed number. */
export function snapshotFacts({ tokens, issuers, templates, health, defi, events, flows = null, powerMap = null, sources = null }) {
    const tokenRows = tokens?.tokens;
    if (!Array.isArray(tokenRows)) throw new Error('static snapshot: stocks-tokens.json has no tokens[]');
    if (!Array.isArray(issuers?.issuers)) throw new Error('static snapshot: stocks-issuers.json has no issuers[]');
    if (!Array.isArray(events?.events)) throw new Error('static snapshot: stocks-events.json has no events[] (run stocks/build-events.mjs first)');
    return {
        events,
        tokenCount: tokenRows.length,
        builtAt: requireDate(tokens.builtAt, 'stocks-tokens.json builtAt'),
        programmes: issuerProgrammeSummary(issuers.issuers),
        templateCount: Array.isArray(templates?.templates) ? templates.templates.length : null,
        healthRuleCount: Array.isArray(health?.rules) ? health.rules.length : null,
        defiConfirmed: typeof defi?.counts?.withAnyConfirmedUse === 'number' ? defi.counts.withAnyConfirmedUse : null,
        defiIntegrations: numberOrNull(defi?.counts?.integrations),
        defiFetchedAt: defi?.fetchedAt ?? null,
        float: floatFacts(flows),
        flowDay: latestCoveredDay(flows, FLOW_ISSUER),
        powers: {
            programmes: Array.isArray(powerMap?.issuers) ? powerMap.issuers.length : null,
            powers: Array.isArray(powerMap?.powers) ? powerMap.powers.length : null
        },
        // stocks/data/sources.json: every distinct URL the dossiers cite (stocks/extract-sources.mjs),
        // the registry the daily document watcher re-reads.
        sourceCount: numberOrNull(sources?.count)
    };
}

/** The landing hero line. The spans carry ids the live fetch refines (landing.js). */
export function landingSnapshotHtml(facts) {
    const tokens = requireCount(facts.tokenCount, 'token count');
    const p = facts.programmes;
    const exceptions = programmeExceptions(p);
    const qualifier = p.total > p.withTokens
        ? ` <span class="snapshot-qualifier">(of ${escapeHtml(fmtNumber(p.total))} tracked${exceptions.length ? `: ${escapeHtml(exceptions.join('; '))}` : ''})</span>`
        : '';
    return `<span id="snapshotTokens">${escapeHtml(fmtNumber(tokens))}</span> exact Solana token addresses from `
        + `${escapeHtml(fmtNumber(p.withTokens))} issuer programmes with live tokens${qualifier} · `
        + `<span id="snapshotDateLabel">catalogue built</span> <time id="snapshotDate" datetime="${escapeHtml(facts.builtAt)}">${escapeHtml(fmtDate(facts.builtAt))}</time>`;
}

/** The pitch's built-state numbers, each dated to the file it came from. */
export function pitchProofHtml(facts) {
    const tokens = requireCount(facts.tokenCount, 'token count');
    const templates = requireCount(facts.templateCount, 'legal template count');
    const rules = requireCount(facts.healthRuleCount, 'health rule count');
    const defi = requireCount(facts.defiConfirmed, 'confirmed DeFi count');
    const integrations = requireCount(facts.defiIntegrations, 'confirmed DeFi integration count');
    requireDate(facts.defiFetchedAt, 'defi-usage.json fetchedAt');
    // defi-usage.json counts two things: token addresses with any confirmed use, and token–protocol
    // integrations (one token in three protocols is three). The weekly page shows the second.
    return `<article><strong data-live-token-count>${escapeHtml(fmtNumber(tokens))}</strong><span>exact Solana token addresses in the ${escapeHtml(fmtDate(facts.builtAt))} public snapshot</span></article>`
        + `<article><strong>${escapeHtml(fmtNumber(templates))}</strong><span>reviewed legal and technology templates covering the catalogue</span></article>`
        + `<article><strong>${escapeHtml(fmtNumber(rules))}</strong><span>health checks split across market, control, legal/evidence and DeFi use</span></article>`
        + `<article><strong>${escapeHtml(fmtNumber(defi))}</strong><span>token addresses with at least one confirmed DeFi integration `
        + `(${escapeHtml(fmtNumber(integrations))} token–protocol integrations in all) in the ${escapeHtml(fmtDate(facts.defiFetchedAt))} composability snapshot</span></article>`;
}

function requireFloat(facts) {
    const f = facts.float;
    if (!f) throw new Error('static snapshot: stocks-flows.json carries no xStocks float (run stocks/build-flows.mjs)');
    requireDate(f.readAt, 'xStocks float readAt');
    for (const key of ['sharePct', 'supplyUsd', 'inventoryUsd', 'floatUsd', 'pricedMints']) requireCount(f[key], `xStocks float ${key}`);
    return f;
}

/** The landing's float finding: kicker date, headline share and the dollar split, as flows.html shows them. */
export function landingFloatHtml(facts) {
    const f = requireFloat(facts);
    return `<p class="finding-kicker">Float · read on chain, ${escapeHtml(fmtDate(f.readAt))}</p>`
        + `<h3>${escapeHtml(fmtPct(f.sharePct))} of priced xStocks supply sits in issuer wallets.</h3>`
        + '<p>Redeemed xStocks are not burned: the prospectus defines de-activation as a transfer back to the issuer. '
        + `Across the ${escapeHtml(fmtNumber(f.pricedMints))} xStocks with a market price, ${escapeHtml(fmtMoney(f.inventoryUsd))} of ${escapeHtml(fmtMoney(f.supplyUsd))} of supply `
        + 'was held by issuer-attributed wallets, including an inventory wallet the issuer itself excludes from its circulating figure. '
        + `That leaves a public float of at most ${escapeHtml(fmtMoney(f.floatUsd))}. Supply overstates what the public holds; our float is an upper bound.</p>`;
}

const NO_FLOW_DAY = 'No Ondo day in the current window has been read by the scan yet.';

function hours(value) {
    return fmtNumber(value, Number.isInteger(value) ? 0 : 1);
}

/** "250 Ondo redemptions and 437 creations in the 20.9 hours it read", with each side's own hours when they differ. */
function flowCounts(day) {
    const r = day.redeemed;
    const c = day.created;
    if (c === null) return `${fmtNumber(r.count)} Ondo redemptions in the ${hours(r.hours)} hours it read`;
    if (c.hours === r.hours) return `${fmtNumber(r.count)} Ondo redemptions and ${fmtNumber(c.count)} creations in the ${hours(r.hours)} hours it read`;
    return `${fmtNumber(r.count)} Ondo redemptions in the ${hours(r.hours)} hours it read and ${fmtNumber(c.count)} creations in ${hours(c.hours)} hours`;
}

/** The landing's "Redemptions on chain" sentence, from the newest covered Ondo day. */
export function landingRedemptionsHtml(facts) {
    const day = facts.flowDay;
    if (!day) return NO_FLOW_DAY;
    return escapeHtml(`On ${fmtDate(day.date)} the scan saw ${flowCounts(day)}.`);
}

function requirePowers(facts) {
    const p = facts.powers ?? {};
    const programmes = p.programmes;
    const powers = p.powers;
    if (!(programmes > 0) || !(powers > 0)) throw new Error('static snapshot: stocks-power-map.json has no power map (run stocks/build-power-map.mjs)');
    return { programmes, powers };
}

/** "12 programmes × 7 powers." — the pitch's powers heading. */
export function pitchPowersHeadHtml(facts) {
    const p = requirePowers(facts);
    return escapeHtml(`${fmtNumber(p.programmes)} programmes × ${fmtNumber(p.powers)} powers.`);
}

/** The scheduled-jobs chip for the document watcher: the cited-source registry's size. */
export function pitchSourcesHtml(facts) {
    const count = requireCount(facts.sourceCount, 'cited source count (stocks/data/sources.json)');
    return escapeHtml(`Daily: ${fmtNumber(count)} cited source URLs re-read`);
}

/**
 * The newest events as the landing box's list items, written with dates rather than "2 h ago" (a
 * static page cannot know when it is read); latest-events.js turns them relative and adds the rest.
 */
export function landingEventsHtml(facts) {
    const rows = eventsView.listEvents(facts.events, LANDING_EVENT_ROWS);
    if (rows.length === 0) return '<li class="event-row event-empty">No events recorded in the last 30 days.</li>';
    return rows.map((event) => eventsView.eventRowHtml(event)).join('');
}

/** "Updated hourly · newest <time>" under the landing box, from the feed's newest event. */
export function landingEventsUpdatedHtml(facts) {
    return eventsView.updatedLineHtml(facts.events);
}

/** Applies every region to its page. Returns { path: html } for the pages in STATIC_SNAPSHOT_PAGES. */
export function renderStaticSnapshots(pages, facts) {
    let landing = replaceMarkedRegion(pages['index.html'], 'landing', landingSnapshotHtml(facts));
    landing = replaceMarkedRegion(landing, 'events', landingEventsHtml(facts));
    landing = replaceMarkedRegion(landing, 'events-updated', landingEventsUpdatedHtml(facts));
    landing = replaceMarkedRegion(landing, 'float-finding', landingFloatHtml(facts));
    landing = replaceMarkedRegion(landing, 'redemptions', landingRedemptionsHtml(facts));
    let pitch = replaceMarkedRegion(pages['pitch/index.html'], 'pitch-proof', pitchProofHtml(facts));
    pitch = replaceMarkedRegion(pitch, 'pitch-powers-head', pitchPowersHeadHtml(facts));
    pitch = replaceMarkedRegion(pitch, 'pitch-sources', pitchSourcesHtml(facts));
    return { 'index.html': landing, 'pitch/index.html': pitch };
}
