// Writes the current catalogue counts into marked regions of hand-authored pages (the landing hero
// and the pitch's built-state slide), so their static HTML never says "Loading…" or carries a number
// typed weeks ago. Pure: the builder (stocks/build-static-snapshot.mjs) does the file I/O.
import counts from './catalogue-counts.js';
import fmt from './fmt.js';

const { escapeHtml, fmtDate, fmtNumber } = fmt;
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

/** Shapes the counts from the built files; throws rather than writing a guessed number. */
export function snapshotFacts({ tokens, issuers, templates, health, defi }) {
    const tokenRows = tokens?.tokens;
    if (!Array.isArray(tokenRows)) throw new Error('static snapshot: stocks-tokens.json has no tokens[]');
    if (!Array.isArray(issuers?.issuers)) throw new Error('static snapshot: stocks-issuers.json has no issuers[]');
    return {
        tokenCount: tokenRows.length,
        builtAt: requireDate(tokens.builtAt, 'stocks-tokens.json builtAt'),
        programmes: issuerProgrammeSummary(issuers.issuers),
        templateCount: Array.isArray(templates?.templates) ? templates.templates.length : null,
        healthRuleCount: Array.isArray(health?.rules) ? health.rules.length : null,
        defiConfirmed: typeof defi?.counts?.withAnyConfirmedUse === 'number' ? defi.counts.withAnyConfirmedUse : null,
        defiFetchedAt: defi?.fetchedAt ?? null
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
    requireDate(facts.defiFetchedAt, 'defi-usage.json fetchedAt');
    return `<article><strong data-live-token-count>${escapeHtml(fmtNumber(tokens))}</strong><span>exact Solana token addresses in the ${escapeHtml(fmtDate(facts.builtAt))} public snapshot</span></article>`
        + `<article><strong>${escapeHtml(fmtNumber(templates))}</strong><span>reviewed legal and technology templates covering the catalogue</span></article>`
        + `<article><strong>${escapeHtml(fmtNumber(rules))}</strong><span>health checks split across market, control, legal/evidence and DeFi use</span></article>`
        + `<article><strong>${escapeHtml(fmtNumber(defi))}</strong><span>assets with confirmed DeFi use in the ${escapeHtml(fmtDate(facts.defiFetchedAt))} composability snapshot</span></article>`;
}

/** Applies every region to its page. Returns { path: html } for the pages in STATIC_SNAPSHOT_PAGES. */
export function renderStaticSnapshots(pages, facts) {
    return {
        'index.html': replaceMarkedRegion(pages['index.html'], 'landing', landingSnapshotHtml(facts)),
        'pitch/index.html': replaceMarkedRegion(pages['pitch/index.html'], 'pitch-proof', pitchProofHtml(facts))
    };
}
