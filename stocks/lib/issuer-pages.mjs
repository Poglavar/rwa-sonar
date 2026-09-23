// Static canonical issuer dossiers. The builder passes reviewed records; this module performs no
// I/O, reads no clock and never turns an unknown into a negative conclusion.

import fmt from './fmt.js';
import { shapeRedemptionUsability } from './redemption-usability.mjs';
import { shapeAuthorityAttribution, summarizeAuthorityAttribution } from './authority-attribution.mjs';

const { escapeHtml, isSafeUrl, fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtPct, cardSlug, humanizeSlug } = fmt;
const DASH = '—';

function esc(value, empty = DASH) {
    return escapeHtml(value === null || value === undefined || value === '' ? empty : String(value));
}

function firstSentence(value, fallback = 'Not established.') {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    const text = value.replace(/\s+/g, ' ').trim();
    const match = text.match(/^(.{1,320}?[.!?])(?:\s|$)/);
    return match ? match[1] : `${text.slice(0, 317)}${text.length > 317 ? '…' : ''}`;
}

function yesNo(value) {
    return value === true ? 'Yes' : value === false ? 'No' : 'Not established';
}

function safeLink(url, label) {
    return isSafeUrl(url) ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>` : '';
}

function controlSummary(control = {}) {
    const labels = [
        ['clawback', 'clawback'], ['freezeAuthority', 'freeze'], ['pausable', 'pause'],
        ['allowlist', 'allowlist'], ['hookActive', 'transfer hook']
    ];
    const active = labels.filter(([key]) => control[key] === true || (typeof control[key] === 'string' && control[key].trim()))
        .map(([, label]) => label);
    const allKnownOff = labels.every(([key]) => control[key] === false || control[key] === null || control[key] === 'none');
    return active.length ? `Issuer intervention is possible through ${active.join(', ')}.`
        : allKnownOff ? 'No listed override is active in the observed token recipes.'
            : 'The complete control surface is not established.';
}

function dataContext(issuer, builtAt) {
    const evidence = issuer.evidence || {};
    const coverage = evidence.coverage || {};
    return `<div class="evidence-context" aria-label="Dossier data context">
        <span><small>Observed</small><strong>${esc(fmtDateTime(evidence.lastCheckedAt || builtAt))}</strong></span>
        <span><small>Coverage</small><strong>${esc(fmtNumber(coverage.sourced))} of ${esc(fmtNumber(coverage.needed))} required fields sourced</strong></span>
        <span><small>Basis</small><strong>${esc(fmtNumber(evidence.claims))} structured claims · current reviewed understanding</strong></span>
        <span><small>Limit</small><strong>Unknown means not established, never “no”</strong></span>
    </div>`;
}

function discrepancyHtml(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    return `<section class="issuer-conflicts"><h2>Published claim ≠ observed reality</h2>
        <p>These are changes or conflicts in the outside world—not a history of edits to RWA Sonar’s own research.</p>
        <div class="issuer-conflict-grid">${rows.map((row) => `<article>
            <span>${esc(row.severity || 'caution')}</span><h3>${esc(row.title, 'Documented discrepancy')}</h3>
            <p><strong>Scope:</strong> ${esc(row.classification, Array.isArray(row.affectedMints) && row.affectedMints.length ? 'named token addresses' : 'issuer programme')}</p>
            <div><strong>Published claim</strong><p>${esc(row.claim?.text, 'Not recorded.')}</p></div>
            <div><strong>Observed reality</strong><p>${esc(row.reality?.text, 'Not recorded.')}</p></div>
            ${row.impact ? `<p><strong>Why it matters:</strong> ${esc(row.impact)}</p>` : ''}
            ${row.resolutionCondition ? `<p><strong>What resolves it:</strong> ${esc(row.resolutionCondition)}</p>` : ''}
            <nav>${[...(row.claim?.sources || []), ...(row.reality?.sources || [])].slice(0, 4)
                .map((source) => safeLink(source?.url, source?.label || source?.type || 'source ↗')).filter(Boolean).join(' · ')}</nav>
        </article>`).join('')}</div></section>`;
}

function fact(label, value) {
    const readable = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== '')
            .map(([key, item]) => `${key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}: ${Array.isArray(item) ? item.join(', ') : item}`).join(' · ')
        : Array.isArray(value) ? value.join('; ') : value;
    return `<dt>${escapeHtml(label)}</dt><dd>${esc(readable, 'Not established')}</dd>`;
}

function redemptionFact(answer) {
    const value = answer?.value === true ? 'Yes' : answer?.value === false ? 'No'
        : answer?.value === null || answer?.value === undefined ? 'Not established'
            : String(answer.summary ?? answer.value);
    const scope = answer?.scopeContext ?? {};
    const notes = [scope.source ? `Source scope: ${scope.source}` : null,
        scope.holders ? `Holder scope: ${scope.holders}` : null,
        scope.jurisdictions ? `Jurisdiction scope: ${scope.jurisdictions}` : null].filter(Boolean);
    const detail = typeof answer?.completeText === 'string' && answer.completeText
        ? `<details class="redemption-term"><summary>${esc(value)}</summary><p>${esc(answer.completeText)}</p>`
            + `${notes.length ? `<small>${esc(notes.join(' · '))}</small>` : ''}</details>`
        : `<strong>${esc(value)}</strong>`;
    return `<dt>${esc(answer?.label, 'Redemption term')}</dt><dd>${detail}<small class="evidence-state">${esc(answer?.evidence, 'unknown')}</small></dd>`;
}

function assetHtml(tokens, cardSlugs) {
    const all = Array.isArray(tokens) ? tokens : [];
    const items = all.slice(0, 36).map((token) => {
        const slug = cardSlugs?.get(token.mint) ?? cardSlug(token.symbol, token.mint);
        return `<li><a href="../cards/${encodeURIComponent(slug)}.html"><strong>${esc(token.symbol || token.name)}</strong>` +
            `<span>${esc(token.underlyingTicker || token.instrumentType)}</span></a></li>`;
    }).join('');
    if (!items) return '<li>No current Solana token address is recorded for this programme.</li>';
    const remaining = all.length - 36;
    return items + (remaining > 0 ? `<li class="asset-more"><a href="../stocks.html?view=assets"><strong>+${fmtNumber(remaining)} more</strong><span>Browse the complete catalogue</span></a></li>` : '');
}

function documentsHtml(issuer) {
    const docs = (Array.isArray(issuer.documents) ? issuer.documents : []).filter((doc) => isSafeUrl(doc?.url));
    if (!docs.length) return '<p>No document URL is recorded.</p>';
    return `<ul class="document-list">${docs.map((doc) => `<li>${safeLink(doc.url, doc.title || doc.type || 'Source document')}` +
        `${doc.effectiveDate ? `<span>effective ${esc(fmtDate(doc.effectiveDate))}</span>` : ''}</li>`).join('')}</ul>`;
}

/** `cardSlugs` is build-cards' collision-aware mint -> file-name map; a colliding symbol's card is not <symbol>.html. */
export function renderIssuerPage({ issuer, tokens = [], templates = [], builtAt = null }, { baseUrl = null, version = '', cardSlugs = null } = {}) {
    const origin = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim().replace(/\/+$/, '') : null;
    const canonical = origin ? `${origin}/issuers/${encodeURIComponent(issuer.slug)}.html` : null;
    const v = version ? `?v=${encodeURIComponent(version)}` : '';
    const grades = issuer.grades || {};
    const market = issuer.market || {};
    const issuerTemplates = templates.filter((template) => template?.issuer?.slug === issuer.slug);
    const redemption = issuer.redemption || {};
    const redemptionReview = issuerTemplates[0]?.redemption ?? null;
    const redemptionUsability = shapeRedemptionUsability({
        redemption,
        answerScope: 'programme',
        operationalRouteAvailable: redemptionReview?.operationalRouteAvailable,
        operationalRouteEvidence: redemptionReview?.operationalEvidence,
        successfulRedemptionObserved: redemptionReview?.successfulRedemptionObserved,
        reviewStatus: { reviewedAt: issuer.evidence?.lastCheckedAt ?? builtAt, pending: issuer.legalReview?.pending ?? null }
    });
    const eligibilityAnswer = redemptionUsability.fields.find((field) => field.id === 'eligibility-and-place');
    const authorityConclusion = summarizeAuthorityAttribution(shapeAuthorityAttribution({
        token: tokens[0] ?? null, issuer
    }));
    const authorityFacts = authorityConclusion.authorities.map((row) => fact(row.label,
        [row.governance?.type ? humanizeSlug(row.governance.type) : null,
            row.governance?.controller, row.governance?.signerThreshold].filter(Boolean).join(' · ')))
        .join('');
    const openQuestions = Array.isArray(issuer.openQuestions) ? issuer.openQuestions : [];
    const templateLinks = issuerTemplates.length ? issuerTemplates.map((template) => `<li><a href="../templates/${encodeURIComponent(template.id)}.html"><strong>${esc(template.legalTemplate)}</strong>` +
        `<span>${esc(template.technologyRecipe)} · ${fmtNumber(template.inheritance?.count)} exact tokens</span></a></li>`).join('')
        : '<li>No reviewed technology + legal template is published for this programme yet.</li>';
    return `<!doctype html>
<!-- Generated by stocks/build-legal-templates.mjs. Do not edit: rebuilt from the current reviewed dossier. -->
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(issuer.name)} issuer dossier — RWA Sonar</title>
<meta name="description" content="Claim, redemption, control, evidence and current Solana assets for ${esc(issuer.name)}." />
<meta property="og:site_name" content="RWA Sonar" /><meta name="twitter:card" content="summary" />
<meta name="twitter:site" content="@RWASonar" /><meta name="twitter:creator" content="@RWASonar" />
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}" />` : ''}<link rel="icon" type="image/svg+xml" href="../images/variant3.svg" />
<link rel="stylesheet" href="../templates.css${v}" /></head><body>
<header class="site-head"><a href="../">RWA Sonar</a><nav><a href="../stocks.html?view=assets">Explore</a><a href="../stocks.html?view=compare">Compare</a><a href="../watch.html">Changes</a><a href="../learn/">Learn</a></nav></header>
<main class="issuer-dossier"><p class="eyebrow">Issuer programme dossier</p><h1>${esc(issuer.name)}</h1>
<p class="lede">${esc(firstSentence(issuer.holderClaim))}</p>
<div class="hero-facts"><span>${esc(issuer.status)}</span><span>${esc(issuer.legalForm, 'legal form not established')}</span><span>${fmtNumber(tokens.length)} exact Solana token${tokens.length === 1 ? '' : 's'}</span><span>claim rung ${esc(grades.claimRung)} · ${esc(grades.claimLabel)}</span></div>
${dataContext(issuer, builtAt)}
<section><h2>The short answer</h2><div class="issuer-verdict-grid">
<article><small>What do you own?</small><strong>${esc(grades.claimLabel, 'Claim not established')}</strong><p>${esc(firstSentence(issuer.holderClaim))}</p><a class="concept-link" href="../learn/beneficial-ownership.html">Understand ownership →</a></article>
<article><small>Can you redeem?</small><strong>${yesNo(redemption.available)}</strong><p>${esc(redemptionReview?.evidenceLabel ?? eligibilityAnswer?.summary, 'Terms not established.')}</p><a class="concept-link" href="../learn/redemption.html">Understand redemption →</a></article>
<article><small>Can the issuer intervene?</small><strong>${controlSummary(issuer.control)}</strong><p>Control is reported as observed powers, not collapsed into a score.</p><a class="concept-link" href="../learn/issuer-control.html">Understand issuer powers →</a></article>
<article><small>Backing verification</small><strong>${esc(issuer.custodyVerification?.type, 'Not established')}</strong><p>${esc(firstSentence(issuer.custodyVerification?.notes))}</p><a class="concept-link" href="../learn/bankruptcy-remoteness.html">Understand insolvency protection →</a></article>
</div></section>
${discrepancyHtml(issuer.discrepancies)}
<section><h2>Technology + legal templates</h2><p>These conclusions apply only to the exact programme and observed control recipe shown.</p><ul class="template-link-list">${templateLinks}</ul></section>
<section><h2>Current Solana assets</h2><p>${fmtNumber(tokens.length)} exact token address${tokens.length === 1 ? '' : 'es'} currently inherit this issuer-level analysis unless an asset card records an exception. <a href="../watch.html?type=issuer&amp;issuerSlug=${encodeURIComponent(issuer.slug)}">Watch this issuer programme →</a></p><ul class="asset-chips">${assetHtml(tokens, cardSlugs)}</ul></section>
<details class="dossier-section" open><summary>Legal claim and issuing chain</summary><dl class="facts">${fact('Issuing entity', issuer.issuingEntity)}${fact('Entity jurisdiction', issuer.entityJurisdiction)}${fact('Governing law', issuer.governingLaw)}${fact('Regulatory status', issuer.regulatoryStatus)}${fact('Holder claim', issuer.holderClaim)}${fact('Underlying custodian', issuer.underlyingCustodian)}</dl></details>
<details class="dossier-section"><summary>Who can exercise token controls</summary><p>${esc(authorityConclusion.headline)}</p><p>This is the representative current exact-token recipe. Open the technology + legal templates above for recipe differences. Programme and PDA labels are traced to the effective signer where reviewed evidence permits. Thresholds apply only to the named role; initiate-only members are not counted as voters.</p><dl class="facts">${authorityFacts}</dl></details>
<details class="dossier-section"><summary>Redemption and holder eligibility</summary><p>Programme-level answer. Product examples remain labelled and do not establish another token’s terms.</p><dl class="facts">${redemptionUsability.fields.slice(0, 8).map(redemptionFact).join('')}${fact('Secondary-market exit', 'Asset-specific; inspect the exact-token report for current venues and liquidity.')}${fact('Timing / SLA', redemption.timing)}${fact('Transfer mechanism', issuer.transferRestrictions?.mechanism)}${fact('US persons excluded', yesNo(issuer.transferRestrictions?.usPersonsExcluded))}</dl></details>
<details class="dossier-section"><summary>Backing, custody and insolvency</summary><dl class="facts">${fact('Collateral ratio', issuer.collateral?.ratio)}${fact('Composition', issuer.collateral?.composition)}${fact('Rehypothecation', issuer.collateral?.rehypothecation)}${fact('Bankruptcy remote', yesNo(issuer.bankruptcyRemote))}${fact('Security interest', yesNo(issuer.securityInterest?.exists))}${fact('Verification type', issuer.custodyVerification?.type)}${fact('Verification agent', issuer.custodyVerification?.agent)}${fact('Verification frequency', issuer.custodyVerification?.frequency)}${fact('Verification notes', issuer.custodyVerification?.notes)}</dl><p><a class="concept-link" href="../learn/defi-custody.html">How custody affects DeFi enforcement →</a></p></details>
<details class="dossier-section"><summary>Corporate actions and economics</summary><p><a href="../economics.html?issuer=${encodeURIComponent(issuer.slug)}">Fees, who gets paid and long-term incentives →</a> · Initial programme research; coverage gaps remain explicit.</p><dl class="facts">${fact('Dividends', issuer.dividends)}${fact('Voting', issuer.voting)}${fact('Corporate actions', issuer.corporateActions)}${fact('Pricing', issuer.pricing)}</dl></details>
<details class="dossier-section"><summary>Primary documents and evidence</summary>${documentsHtml(issuer)}<p><a href="../watch.html">Inspect source freshness and individual claims →</a></p></details>
<details class="dossier-section"><summary>Open research questions (${openQuestions.length})</summary>${openQuestions.length ? `<ul>${openQuestions.map((question) => `<li>${esc(question)}</li>`).join('')}</ul>` : '<p>No open question is currently recorded.</p>'}</details>
<footer><p>Current reviewed understanding built ${esc(fmtDateTime(builtAt))}. This dossier is analysis, not investment or legal advice.</p><nav><a href="./index.html">All issuers</a><a href="../stocks.html?view=compare">Compare products</a><a href="../watch.html">See what changed</a><a href="https://x.com/RWASonar" target="_blank" rel="me noopener noreferrer">@RWASonar</a></nav></footer>
</main></body></html>\n`;
}

export function renderIssuerIndex(issuers, { baseUrl = null, version = '' } = {}) {
    const origin = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim().replace(/\/+$/, '') : null;
    const v = version ? `?v=${encodeURIComponent(version)}` : '';
    const cards = (Array.isArray(issuers) ? issuers : []).map((issuer) => `<article class="template-card"><span class="eyebrow">${esc(issuer.status)}</span><h2>${esc(issuer.name)}</h2><p>${esc(firstSentence(issuer.holderClaim))}</p><a class="open-template" href="./${encodeURIComponent(issuer.slug)}.html">Open issuer dossier →</a></article>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Issuer dossiers — RWA Sonar</title><meta name="description" content="Canonical legal, control and evidence dossiers for tokenized-stock issuer programmes on Solana." /><meta property="og:site_name" content="RWA Sonar" /><meta name="twitter:card" content="summary" /><meta name="twitter:site" content="@RWASonar" /><meta name="twitter:creator" content="@RWASonar" />${origin ? `<link rel="canonical" href="${escapeHtml(origin)}/issuers/" />` : ''}<link rel="icon" type="image/svg+xml" href="../images/variant3.svg" /><link rel="stylesheet" href="../templates.css${v}" /></head><body><header class="site-head"><a href="../">RWA Sonar</a><nav><a href="../stocks.html?view=assets">Explore</a><a href="../stocks.html?view=compare">Compare</a><a href="../watch.html">Changes</a><a href="../learn/">Learn</a></nav></header><main><p class="eyebrow">Issuer programmes</p><h1>Who stands behind the token?</h1><p class="lede">One stable dossier per issuer programme: current holder claim, redemption route, control surface, backing evidence, discrepancies and exact Solana assets.</p><div class="template-grid">${cards}</div><footer><a href="https://x.com/RWASonar" target="_blank" rel="me noopener noreferrer">@RWASonar on X</a></footer></main></body></html>\n`;
}
