// Pure records and static HTML for one observed exact-mint protocol integration. Generic registry
// records do not imply decoding or simulation; a separately retained exact-market review may
// promote only the configuration-decoded stage it actually established.
import { composabilityTemplateFor, indexComposabilityTemplates, lenderExitQuality } from './composability.mjs';
import fmt from './fmt.js';
import protocolProof from './protocol-proof.js';

const { escapeHtml, isSafeUrl } = fmt;
const text = (v, empty = 'Not performed / not established') => escapeHtml(v === null || v === undefined || v === '' ? empty : String(v));
const money = (v) => Number.isFinite(v) ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : 'Not reported';
const pct = (v) => Number.isFinite(v) ? `${(v * 100).toFixed(2).replace(/\.00$/, '')}%` : 'Not reported';
const safeLink = (url, label) => isSafeUrl(url) ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a>` : 'No link recorded';

export const { protocolProofModel } = protocolProof;

export function dossierSlug(item, integration, number = 0) {
    const core = [item?.symbol || 'token', integration?.protocolId || 'protocol', integration?.id || number]
        .join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `${core}-${String(item?.mint || '').slice(0, 6).toLowerCase()}`;
}

export function buildProtocolDossiers({ tokens = [], issuers = [], usage = {}, templates = [], marketResearch = {} }) {
    const tokenByMint = new Map(tokens.map((token) => [token.mint, token]));
    const issuerBySlug = new Map(issuers.map((issuer) => [issuer.slug, issuer]));
    const templateIndex = indexComposabilityTemplates(templates);
    const researchedMarkets = Array.isArray(marketResearch?.markets) ? marketResearch.markets : [];
    const rows = [];
    for (const item of usage.items ?? []) {
        const token = tokenByMint.get(item.mint) ?? { mint: item.mint, symbol: item.symbol, issuer: item.issuer };
        const template = composabilityTemplateFor(token, templateIndex);
        for (const [number, integration] of (item.integrations ?? []).entries()) {
            const proof = integration.proof ?? {};
            const accounts = integration.corroboration?.accounts ?? [];
            const marketVerifications = researchedMarkets.filter((market) => market?.tokenMint === item.mint
                && market?.protocolId === integration?.protocolId
                && (!market?.integrationId || market.integrationId === integration?.id));
            const decoded = marketVerifications.some((market) => market?.configurationDecoded === true);
            const decodedAt = marketVerifications.map((market) => market?.observedAt).filter(Boolean).sort().at(-1) ?? null;
            rows.push({
                slug: dossierSlug(item, integration, number), mint: item.mint, symbol: item.symbol ?? token.symbol ?? null,
                tokenName: token.name ?? null, issuer: item.issuer ?? token.issuer ?? null,
                cardSlug: token.cardSlug ?? token.symbol ?? item.symbol ?? null,
                integration, proof: {
                    sourceStatus: proof.sourceStatus ?? 'not established', accountExistence: proof.accountExistence ?? 'not-checked',
                    accountCount: proof.accountCount ?? null, existingAccountCount: proof.existingAccountCount ?? null,
                    configurationDecoded: proof.configurationDecoded === true || decoded, readOnlyExecutionSimulated: proof.readOnlyExecutionSimulated === true,
                    activityObserved: proof.activityObserved === true, activityBasis: proof.activityBasis ?? [],
                    observedAt: decodedAt ?? proof.observedAt ?? null, activityObservedAt: proof.activityObservedAt ?? null
                },
                accounts, marketVerifications,
                outcomes: template?.scenarios ?? null,
                lenderExit: lenderExitQuality(template, item.integrations ?? [],
                    issuerBySlug.get(token.issuer)?.redemption ?? null),
                templateId: template?.id ?? null,
                fetchedAt: proof.fetchedAt ?? usage.fetchedAt ?? null
            });
        }
    }
    return rows.sort((a, b) => a.slug.localeCompare(b.slug));
}

function wholeNumber(value) {
    return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 8 }) : 'Not established';
}

/** A market's recorded exit dependencies as list items: the statement, then its consequence. */
function exitDependenciesHtml(market) {
    return (market?.lenderExitDependencies ?? []).map((d) => `<li>${text(d?.statement)}`
        + `${d?.consequence ? ` <em>${text(d.consequence)}</em>` : ''}</li>`).join('');
}

function marketVerificationHtml(market) {
    const config = market?.configuration ?? {};
    const execution = market?.readOnlyExecution ?? {};
    const sources = (market?.sources ?? []).map((source) => `<li>${safeLink(source?.url, source?.label ?? source?.kind ?? 'Source')} · checked ${text(source?.accessedAt, 'at an unrecorded time')}</li>`).join('') || '<li>No source recorded.</li>';
    const limits = (market?.limits ?? []).map((limit) => `<li>${text(limit)}</li>`).join('') || '<li>No limitation recorded.</li>';
    // Where the protocol's own documentation and the chain disagree, and what a lender needs from
    // someone else before it can exit (e.g. an issuer thaw): both recorded per market in
    // protocol-market-research.json and shown here beside the decoded configuration.
    const discrepancies = (market?.discrepancies ?? []).map((d) => `<li><strong>${text(d?.severity, 'info')} · ${text(d?.title)}</strong>`
        + `${d?.impact ? ` — ${text(d.impact)}` : ''}${d?.observedAt ? ` <small>(observed ${text(d.observedAt)})</small>` : ''}</li>`).join('');
    const dependencies = exitDependenciesHtml(market);
    return `<article class="verified-market"><p class="eyebrow">Configuration decoded · ${text(market?.observedAt, 'time unrecorded')}</p><h3>${text(market?.routeLabel, 'Verified market route')}</h3><p>This is one specific collateral-to-debt route, not an aggregate across every market for the token.</p><dl class="terms"><dt>Market</dt><dd><code>${text(market?.marketAddress)}</code></dd><dt>Collateral reserve</dt><dd><code>${text(market?.collateralReserve)}</code></dd><dt>Debt reserve</dt><dd><code>${text(market?.debtReserve)}</code></dd><dt>Debt asset</dt><dd>${text(market?.debtSymbol)} · <code>${text(market?.debtMint)}</code></dd><dt>Reserve status</dt><dd>${text(config.reserveStatus)} (SDK code ${text(config.reserveStatusCode)})</dd><dt>Expected programme owner</dt><dd><code>${text(market?.expectedProgramOwner)}</code></dd><dt>Observed programme owner</dt><dd><code>${text(market?.observedProgramOwner)}</code> · ${market?.programOwnerMatches === true ? 'matches official mainnet programme ID' : 'match not established'}</dd><dt>Maximum LTV</dt><dd>${Number.isFinite(config.maxLtvPct) ? `${config.maxLtvPct}%` : 'Not established'}</dd><dt>Liquidation threshold</dt><dd>${Number.isFinite(config.liquidationLtvPct) ? `${config.liquidationLtvPct}%` : 'Not established'}</dd><dt>Liquidation bonus range</dt><dd>${Number.isFinite(config.minLiquidationBonusBps) && Number.isFinite(config.maxLiquidationBonusBps) ? `${config.minLiquidationBonusBps / 100}%–${config.maxLiquidationBonusBps / 100}%` : 'Not established'}</dd><dt>Collateral deposit cap</dt><dd>${wholeNumber(config.collateralDepositLimitTokens)} ${text(market?.collateralSymbol)}</dd><dt>Debt borrow cap</dt><dd>${wholeNumber(config.debtBorrowLimitTokens)} ${text(market?.debtSymbol)}</dd><dt>Oracle</dt><dd>${text(config.oracleProvider)} feed <code>${text(config.oraclePriceFeed)}</code> · price chain ${text((config.oraclePriceChain ?? []).join(' → '))} · TWAP chain ${text((config.oracleTwapChain ?? []).join(' → '))} · maximum age ${text(config.maxPriceAgeSeconds)}s</dd><dt>On-chain observation</dt><dd>confirmed slot ${text(market?.rpcSlot)} · reserve last updated at slot ${text(market?.reserveLastUpdateSlot)}</dd><dt>Decoder</dt><dd>${text(market?.decodedWith)}</dd><dt>Read-only execution simulation</dt><dd>${text(execution.status)} — ${text(execution.reason)}</dd></dl>${discrepancies ? `<h4>Documentation vs chain</h4><ul>${discrepancies}</ul>` : ''}${dependencies ? `<h4>What a lender's exit depends on</h4><ul>${dependencies}</ul>` : ''}<h4>Sources</h4><ul>${sources}</ul><h4>Limits</h4><ul>${limits}</ul></article>`;
}

function terms(metrics = {}) {
    const pairs = [
        ['Maximum LTV', metrics.maxLtvMin === metrics.maxLtvMax ? pct(metrics.maxLtvMin) : `${pct(metrics.maxLtvMin)}–${pct(metrics.maxLtvMax)}`],
        ['Liquidation LTV', metrics.liquidationLtvMin === metrics.liquidationLtvMax ? pct(metrics.liquidationLtvMin) : `${pct(metrics.liquidationLtvMin)}–${pct(metrics.liquidationLtvMax)}`],
        ['Liquidation penalty', metrics.liquidationPenaltyMin === metrics.liquidationPenaltyMax ? pct(metrics.liquidationPenaltyMin) : `${pct(metrics.liquidationPenaltyMin)}–${pct(metrics.liquidationPenaltyMax)}`],
        ['Configured / observed size', money(metrics.sizeUsd ?? metrics.liquidityUsd)], ['24 h volume', money(metrics.volume24Usd)],
        ['24 h transactions', Number.isFinite(metrics.txns24) ? metrics.txns24 : 'Not reported'],
        ['Oracle', Array.isArray(metrics.oracleProviders) && metrics.oracleProviders.length ? metrics.oracleProviders.join(', ') : 'Not reported']
    ];
    return pairs.map(([label, value]) => `<dt>${text(label)}</dt><dd>${text(value)}</dd>`).join('');
}

function scenario(label, row) {
    return `<article><h3>${text(label)}</h3><p><strong>${text(row?.headline, 'Not assessed')}</strong></p><p>${text(row?.explanation, 'The issuer/control template has not been matched, so this outcome is not established.')}</p></article>`;
}

export function renderProtocolDossier(dossier, { baseUrl = null, version = '' } = {}) {
    const i = dossier.integration; const canonical = baseUrl ? `${baseUrl.replace(/\/$/, '')}/protocols/${encodeURIComponent(dossier.slug)}.html` : null;
    const proofModel = protocolProofModel({ proof: dossier.proof, integration: i, fetchedAt: dossier.fetchedAt });
    const markets = (i.markets ?? []).map((m) => {
        const marketKey = m.marketAddress ?? m.reserveAddress ?? m.vaultAddress ?? m.bankAddress ?? m.collateralConfig ?? m.loanAddress ?? m.address ?? null;
        const watch = marketKey ? `<br><a href="../watch.html?type=protocol-market&amp;mint=${encodeURIComponent(dossier.mint)}&amp;integrationId=${encodeURIComponent(i.id)}&amp;marketKey=${encodeURIComponent(marketKey)}">Watch this exact market →</a>` : '';
        return `<li><strong>${text(m.name, 'Market / pool')}</strong><br><code>${text(marketKey, 'No address recorded')}</code>${m.debtMint ? `<br>Debt mint: <code>${text(m.debtMint)}</code>${m.debtSymbol ? ` (${text(m.debtSymbol)})` : ''}` : ''}${watch}</li>`;
    }).join('') || '<li>No market-level configuration was recorded.</li>';
    const accounts = dossier.accounts.map((a) => `<tr><td>${text(a.role)}</td><td><code>${text(a.address)}</code></td><td>${text(a.exists === true ? 'exists' : a.exists === false ? 'missing' : 'not checked')}</td><td><code>${text(a.expectedOwner, 'Not established')}</code></td><td><code>${text(a.owner)}</code></td></tr>`).join('') || '<tr><td colspan="5">No protocol account address was published in the checked source.</td></tr>';
    const evidence = (i.evidence ?? []).map((e) => `<li><strong>${text(e.type)}</strong>: ${text(e.note, 'No note recorded.')} ${safeLink(e.url, 'Open source')}</li>`).join('') || '<li>No evidence record.</li>';
    const description = `${dossier.symbol} on ${i.protocolName}: exact Solana address, proof stage, parameters and lender-exit limits.`;
    const sourceLinks = [i.links?.use ? safeLink(i.links.use, 'Open market / product') : '', i.links?.protocol ? safeLink(i.links.protocol, 'Protocol documentation') : ''].filter(Boolean).join(' · ') || 'No direct product link recorded.';
    const verifiedMarkets = (dossier.marketVerifications ?? []).map(marketVerificationHtml).join('');
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${text(dossier.symbol)} on ${text(i.protocolName)} — RWA Sonar</title><meta name="description" content="${text(description)}"><meta property="og:title" content="${text(dossier.symbol)} on ${text(i.protocolName)} — RWA Sonar"><meta property="og:description" content="${text(description)}"><meta property="og:type" content="article"><meta property="og:site_name" content="RWA Sonar">${canonical ? `<meta property="og:url" content="${text(canonical)}"><link rel="canonical" href="${text(canonical)}">` : ''}<meta name="twitter:card" content="summary"><meta name="twitter:site" content="@RWASonar"><meta name="twitter:creator" content="@RWASonar"><link rel="icon" type="image/svg+xml" href="../images/variant3.svg"><link rel="stylesheet" href="../protocols.css?v=${encodeURIComponent(version)}"></head><body><header class="site-head"><a class="brand" href="../index.html">RWA Sonar</a><nav aria-label="Site navigation"><a href="../stocks.html?view=assets">Explore</a><a href="../stocks.html?view=compare">Compare</a><a href="../watch.html">Changes</a><a href="../learn/">Learn</a></nav></header><main>
<a class="back" href="./">← All protocol dossiers</a><p class="eyebrow">Source fetched ${text(dossier.fetchedAt)}</p><h1>${text(dossier.symbol)} × ${text(i.protocolName)}</h1><p class="lead"><strong>${text(proofModel.headline)}</strong> Evidence for this stage was checked ${text(proofModel.asOf, 'at an unrecorded time')}. ${text(proofModel.detail)}</p><p><strong>Source-described use:</strong> ${text(i.summary)}</p><p class="note"><a href="../cards/${encodeURIComponent(dossier.cardSlug)}.html">Open ${text(dossier.symbol)} token report</a> · <a href="../issuers/${encodeURIComponent(dossier.issuer)}.html">Open ${text(dossier.issuer)} issuer dossier</a></p><section><h2>Exact token and source-described action</h2><dl><dt>Solana token address</dt><dd><code>${text(dossier.mint)}</code></dd><dt>Actions described by source</dt><dd>${text((i.actions ?? []).join(', '))}</dd><dt>Source-reported integration status</dt><dd>${text(i.status)}</dd><dt>Access limits</dt><dd>${text(i.accessNote, 'No access condition was recorded.')}</dd><dt>Direct links</dt><dd>${sourceLinks}</dd></dl></section>
<section><h2>Proof status — do not read a source listing as execution proof</h2><dl><dt>Achieved proof stage</dt><dd>${text(proofModel.stage)}</dd><dt>Source proof status</dt><dd>${text(dossier.proof.sourceStatus)}</dd><dt>Source fetched</dt><dd>${text(proofModel.fetchedAt)}</dd><dt>Activity observed</dt><dd>${text(proofModel.activityStatement)}</dd><dt>Account existence</dt><dd>${text(dossier.proof.accountExistence)} (${text(dossier.proof.existingAccountCount, '0')}/${text(dossier.proof.accountCount, '0')} referenced accounts)</dd><dt>Configuration decoded</dt><dd>${dossier.proof.configurationDecoded ? 'Performed' : 'Not performed'}${i.decoding ? ` — ${text(i.decoding.scope)} Decoded at slot ${text(i.decoding.slot)} with ${safeLink(i.decoding.idl, 'the published IDL')}.` : ''}</dd><dt>Read-only execution simulation</dt><dd>${dossier.proof.readOnlyExecutionSimulated ? 'Performed' : 'Not performed'}</dd></dl><h3>Source evidence</h3><ul>${evidence}</ul></section>
<section><h2>Referenced accounts and owners</h2><div class="table-scroll"><table><thead><tr><th>Role</th><th>Address</th><th>Existence check</th><th>Expected owner</th><th>Observed program owner</th></tr></thead><tbody>${accounts}</tbody></table></div><p class="note">The current source data records observed owners, not a separately published expected-owner assertion; where no such assertion exists, it remains not established. Account existence and owner corroborate the published reference but do not independently decode configuration or prove a user action can succeed.</p></section>
<section><h2>Recorded parameters</h2><dl class="terms">${terms(i.metrics ?? {})}</dl><h3>Markets and configured addresses</h3><ul>${markets}</ul></section>
${verifiedMarkets ? `<section><h2>Decoded market route</h2>${verifiedMarkets}<p class="note">A decoded active configuration is stronger than a registry listing, but it is still not proof that a particular borrow transaction succeeded.</p></section>` : ''}
<section><h2>Custody and default outcomes</h2><div class="scenarios">${scenario('Borrower default / seizure', dossier.outcomes?.borrowerDefault)}${scenario('Protocol hack custody', dossier.outcomes?.protocolHack)}${scenario('Access or key loss', dossier.outcomes?.accessLoss)}</div><p class="note">These are issuer-plus-control-recipe conclusions${dossier.templateId ? ` from <a href="../templates/${encodeURIComponent(dossier.templateId)}.html">the matched legal template</a>` : '; no matched reviewed template exists'} — not protocol simulation results.</p></section>
<section><h2>Lender exit after receiving the token</h2><p><strong>${text(dossier.lenderExit.label)}</strong> — ${text(dossier.lenderExit.reason)}</p>${(dossier.marketVerifications ?? []).map(exitDependenciesHtml).join('') ? `<p><strong>Market-specific dependencies:</strong></p><ul>${(dossier.marketVerifications ?? []).map(exitDependenciesHtml).join('')}</ul>` : ''}<dl><dt>Observed DEX liquidity</dt><dd>${money(dossier.lenderExit.routes.observedDexLiquidityUsd)}</dd><dt>Issuer redemption established</dt><dd>${dossier.lenderExit.routes.issuerRedemption ? 'yes' : 'no / not established'}</dd><dt>Key limit</dt><dd>Possession of the token does not itself establish eligibility, issuer recognition, redemption access, or enough executable market liquidity.</dd></dl></section>
</main></body></html>`;
}

export function renderProtocolIndex(dossiers, { baseUrl = null, version = '' } = {}) {
    const canonical = baseUrl ? `${baseUrl.replace(/\/$/, '')}/protocols/` : null;
    const grouped = new Map();
    for (const dossier of dossiers) {
        const key = dossier.integration.protocolId ?? dossier.integration.protocolName ?? 'protocol';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(dossier);
    }
    const rows = [...grouped.values()].sort((a, b) => String(a[0].integration.protocolName).localeCompare(String(b[0].integration.protocolName)))
        .map((group) => {
            const first = group[0];
            const actions = [...new Set(group.flatMap((row) => row.integration.actions ?? []))].sort();
            const tokens = group.sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)))
                .map((d) => `<li><a href="./${encodeURIComponent(d.slug)}.html"><strong>${text(d.symbol)}</strong><span>${text((d.integration.actions ?? []).join(', '))} · ${text(d.proof.sourceStatus)}</span></a></li>`).join('');
            return `<article><p class="eyebrow">${text(first.integration.category)} · ${text(actions.join(', '))}</p><h2>${text(first.integration.protocolName)}</h2><p>${group.length} exact-token integration${group.length === 1 ? '' : 's'} with a shareable proof record.</p><details><summary>Browse ${group.length} token dossier${group.length === 1 ? '' : 's'}</summary><ul class="token-list">${tokens}</ul></details></article>`;
        }).join('');
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Protocol and market dossiers — RWA Sonar</title><meta name="description" content="Exact Solana token integrations, supported actions, proof stages, protocol parameters and lender-exit limits."><meta property="og:site_name" content="RWA Sonar">${canonical ? `<link rel="canonical" href="${text(canonical)}">` : ''}<meta name="twitter:card" content="summary"><meta name="twitter:site" content="@RWASonar"><link rel="icon" type="image/svg+xml" href="../images/variant3.svg"><link rel="stylesheet" href="../protocols.css?v=${encodeURIComponent(version)}"></head><body><header class="site-head"><a class="brand" href="../index.html">RWA Sonar</a><nav aria-label="Site navigation"><a href="../stocks.html?view=assets">Explore</a><a href="../stocks.html?view=compare">Compare</a><a href="../watch.html">Changes</a><a href="../learn/">Learn</a></nav></header><main><a class="back" href="../stocks.html?view=defi">← DeFi research</a><p class="eyebrow">Exact-address evidence only</p><h1>Protocol and market dossiers</h1><p class="lead">One shareable record per observed integration. Unperformed decoding and simulation steps remain explicit.</p><div class="index">${rows}</div></main></body></html>`;
}
