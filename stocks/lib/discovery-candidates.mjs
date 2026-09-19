// Pure admission rules for newly discovered stock-like Solana mints. Search results are leads,
// not assets: an address enters the published universe only when an independent issuer/authority
// signal corroborates its identity. Everything else remains a reviewable candidate.

import {
    hasStockTag, issuerFromFreezeAuthority, issuerFromMintAuthority, issuerFromTags, underlyingTicker
} from './classify.mjs';

function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function list(value) {
    return Array.isArray(value) ? value : [];
}

const SPONSOR_ISSUERS = {
    prestocks: 'prestocks',
    tessera: 'tessera',
    superstate: 'superstate-opening-bell'
};

/** Exact mint claims from issuer-controlled registries. Ondo's current feed has tickers, not mints. */
export function sponsorMintIndex(sponsorApis) {
    const out = new Map();
    for (const [source, issuer] of Object.entries(SPONSOR_ISSUERS)) {
        for (const row of list(sponsorApis?.items?.[source])) {
            const mint = text(row?.mint);
            if (mint) out.set(mint, {
                issuer,
                source: `issuer registry: ${source}`,
                underlyingTicker: text(row?.ticker) ?? text(row?.symbol)
            });
        }
    }
    return out;
}

export function protocolMintIndex(protocolUsage) {
    return new Set(list(protocolUsage?.items)
        .filter((row) => list(row?.integrations).length > 0)
        .map((row) => text(row?.mint)).filter(Boolean));
}

function candidateSignals(token, { sponsorMints, protocolMints, manualMints }) {
    const tagIssuer = issuerFromTags(token?.tags);
    const mintAuthorityIssuer = issuerFromMintAuthority(token?.mintAuthority);
    const freezeAuthorityIssuer = issuerFromFreezeAuthority(token?.freezeAuthority);
    const sponsor = sponsorMints.get(token?.mint) ?? null;
    const manual = manualMints.get(token?.mint) ?? null;
    const proposedIssuer = manual?.issuer ?? sponsor?.issuer ?? tagIssuer ?? mintAuthorityIssuer ?? freezeAuthorityIssuer ?? token?.issuer ?? null;
    const issuerSignals = [manual?.issuer, sponsor?.issuer, tagIssuer, mintAuthorityIssuer, freezeAuthorityIssuer]
        .filter(Boolean);
    const issuerSet = new Set(issuerSignals);
    const directTickerIssuers = new Set(['superstate-opening-bell', 'bullish', 'securitize']);
    const ticker = sponsor?.underlyingTicker ?? underlyingTicker(token?.symbol, proposedIssuer)
        ?? (directTickerIssuers.has(proposedIssuer) ? text(token?.symbol) : null);
    const signals = {
        stockTag: hasStockTag(token?.tags),
        aggregatorVerified: token?.isVerified === true,
        tagIssuer,
        mintAuthorityIssuer,
        freezeAuthorityIssuer,
        sponsorIssuer: sponsor?.issuer ?? null,
        sponsorSource: sponsor?.source ?? null,
        manualIssuer: manual?.issuer ?? null,
        manualSource: text(manual?.source),
        protocolListed: protocolMints.has(token?.mint),
        underlyingTicker: ticker,
        tokenProgram: text(token?.tokenProgram)
    };
    return { signals, proposedIssuer, conflict: issuerSet.size > 1 };
}

/**
 * Decide whether a never-before-published mint is sufficiently identified to enter the universe.
 * A Jupiter stock tag is discovery evidence only. Automatic admission needs an issuer-controlled
 * exact-mint registry, a reviewed manual source, or concordant issuer tag + programme authority.
 */
export function assessDiscovery(token, context = {}) {
    const sponsorMints = context.sponsorMints instanceof Map ? context.sponsorMints : new Map();
    const protocolMints = context.protocolMints instanceof Set ? context.protocolMints : new Set();
    const manualMints = context.manualMints instanceof Map ? context.manualMints : new Map();
    const { signals, proposedIssuer, conflict } = candidateSignals(token, { sponsorMints, protocolMints, manualMints });
    const reasons = [];
    if (conflict) reasons.push('issuer signals disagree');
    if (!signals.stockTag) reasons.push('no recognised stock/equity discovery tag');
    if (!proposedIssuer) reasons.push('issuer programme is not identified');
    if (!signals.underlyingTicker && !['prestocks', 'tessera'].includes(proposedIssuer)) reasons.push('underlying ticker cannot be reconciled');

    let admittedBy = null;
    if (!conflict && signals.manualIssuer) admittedBy = 'reviewed manual source';
    else if (!conflict && signals.sponsorIssuer && (!signals.tagIssuer || signals.tagIssuer === signals.sponsorIssuer)) {
        admittedBy = 'issuer exact-mint registry';
    } else {
        const authorityIssuer = signals.mintAuthorityIssuer ?? signals.freezeAuthorityIssuer;
        if (!conflict && signals.stockTag && signals.aggregatorVerified && signals.tagIssuer
            && authorityIssuer === signals.tagIssuer) admittedBy = 'concordant issuer tag and known programme authority';
    }

    if (!admittedBy && reasons.length === 0) {
        if (!signals.sponsorIssuer && !signals.manualIssuer) reasons.push('no issuer-controlled exact-mint source');
        if (!signals.mintAuthorityIssuer && !signals.freezeAuthorityIssuer) reasons.push('programme authority is not recognised');
        if (!signals.aggregatorVerified) reasons.push('aggregator does not mark the address verified');
    }
    return {
        decision: admittedBy ? 'admit' : 'candidate',
        admittedBy,
        proposedIssuer,
        severity: conflict ? 'critical' : 'caution',
        reasons,
        signals
    };
}

/** Split one search run into publishable records and a durable candidate inbox. */
export function partitionDiscoveries({ previousItems = [], freshItems = [], manualItems = [], sponsorApis = null,
    protocolUsage = null, previousCandidates = [], fetchedAt }) {
    const previousMints = new Set(list(previousItems).map((row) => text(row?.mint)).filter(Boolean));
    const manualMints = new Map(list(manualItems).map((row) => [text(row?.mint), row]).filter(([mint]) => mint));
    const sponsorMints = sponsorMintIndex(sponsorApis);
    const protocolMints = protocolMintIndex(protocolUsage);
    const oldCandidates = new Map(list(previousCandidates).map((row) => [text(row?.mint), row]).filter(([mint]) => mint));
    const accepted = [];
    const candidates = new Map();

    for (const token of list(freshItems)) {
        const mint = text(token?.mint);
        if (!mint) continue;
        if (previousMints.has(mint)) {
            accepted.push(token);
            continue;
        }
        const assessment = assessDiscovery(token, { sponsorMints, protocolMints, manualMints });
        if (assessment.decision === 'admit') {
            accepted.push({
                ...token,
                issuer: assessment.proposedIssuer ?? token.issuer ?? null,
                underlyingTicker: assessment.signals.underlyingTicker ?? token.underlyingTicker ?? null,
                discovery: { status: 'confirmed', admittedBy: assessment.admittedBy, confirmedAt: fetchedAt }
            });
            continue;
        }
        const prior = oldCandidates.get(mint);
        candidates.set(mint, {
            mint,
            symbol: text(token?.symbol),
            name: text(token?.name),
            proposedIssuer: assessment.proposedIssuer,
            proposedUnderlyingTicker: assessment.signals.underlyingTicker,
            status: 'candidate',
            severity: assessment.severity,
            reasons: assessment.reasons,
            signals: assessment.signals,
            firstSeenAt: text(prior?.firstSeenAt) ?? fetchedAt,
            lastSeenAt: fetchedAt,
            seenInSearch: true
        });
    }

    // Keep unresolved candidates when ranking changes hide them; do not silently turn absence into rejection.
    for (const [mint, prior] of oldCandidates) {
        if (previousMints.has(mint) || candidates.has(mint)) continue;
        candidates.set(mint, { ...prior, seenInSearch: false });
    }
    const rows = [...candidates.values()].sort((a, b) => a.mint.localeCompare(b.mint));
    return {
        accepted,
        candidates: rows,
        summary: {
            total: rows.length,
            critical: rows.filter((row) => row.severity === 'critical').length,
            seenThisRun: rows.filter((row) => row.seenInSearch).length,
            admittedThisRun: accepted.filter((row) => row.discovery?.confirmedAt === fetchedAt).length
        }
    };
}
