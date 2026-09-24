// Pure shaping for the public change journal. Only real external changes and catalogue membership
// observations belong here; internal corrections and collection false alarms stay private.

function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function issuerHref(slug) {
    const safe = text(slug);
    return safe && /^[a-z0-9-]+$/.test(safe) ? `./issuers/${safe}.html` : null;
}

/**
 * The issuer a curated event's programme slug belongs to: `backpack-securities-spcx` is the
 * Backpack SPCX programme, whose dossier is `backpack-securities`. The longest known issuer that
 * is the slug or a `<issuer>-` prefix of it; null when none is, so no link points at a page that
 * does not exist (one did, on watch.html, 2026-09-23).
 */
export function canonicalIssuer(slug, issuerNames) {
    const raw = text(slug);
    if (raw === null) return null;
    const known = issuerNames instanceof Map ? [...issuerNames.keys()] : Object.keys(issuerNames ?? {});
    let best = null;
    for (const candidate of known) {
        if ((raw === candidate || raw.startsWith(`${candidate}-`)) && (best === null || candidate.length > best.length)) best = candidate;
    }
    return best;
}

function issuerName(slug, issuerNames) {
    return slug === null ? null : text(issuerNames instanceof Map ? issuerNames.get(slug) : issuerNames?.[slug]);
}

function assetRef(mint, index) {
    const identity = index.get(mint) ?? {};
    return {
        mint,
        symbol: text(identity.symbol),
        name: text(identity.name),
        issuer: text(identity.issuer),
        operationalStatus: text(identity.operationalStatus),
        href: text(identity.cardSlug) ? `./cards/${identity.cardSlug}.html` : null
    };
}

/** A discrepancy source with its evidence kept: where, what exactly, and when it was read. */
function evidenceSource(source) {
    return { label: text(source?.label), url: text(source?.url), locator: text(source?.locator), accessedAt: text(source?.accessedAt) };
}

function evidenceSide(side) {
    return {
        text: text(side?.text),
        sources: (Array.isArray(side?.sources) ? side.sources : []).map(evidenceSource).filter((source) => source.url)
    };
}

/**
 * `protocolDiscrepancies` are protocol-market docs-vs-chain findings as flattened by
 * discrepancy-view.js protocolDiscrepancyRecords. Each is dated by the day it was recorded
 * (`observedAt`); a record without that date is left out rather than given one.
 */
export function buildChangeJournal({ changes, defiChanges, curatedEvents, resolutions, identities, tokens, issuerNames, protocolDiscrepancies } = {}) {
    const identityIndex = new Map();
    for (const row of Array.isArray(identities) ? identities : []) {
        if (text(row?.mint)) identityIndex.set(row.mint, row);
    }
    for (const row of Array.isArray(tokens) ? tokens : []) {
        if (!text(row?.mint)) continue;
        identityIndex.set(row.mint, { ...(identityIndex.get(row.mint) ?? {}), ...row });
    }

    const items = [];
    for (const row of Array.isArray(resolutions) ? resolutions : []) {
        if (row?.public !== true || !text(row?.date) || !text(row?.title)) continue;
        const issuer = text(row.issuerSlug);
        items.push({
            id: text(row.id), date: row.date, category: 'actor-change', kind: text(row.kind),
            eventAt: text(row.eventAt), effectiveAt: text(row.effectiveAt),
            firstObservedAt: text(row.firstObservedAt) ?? row.date, reviewedAt: text(row.reviewedAt),
            severity: text(row.severity) ?? 'info', actor: text(row.actor), issuer,
            title: row.title, summary: text(row.summary), whyItMatters: text(row.whyItMatters),
            consequence: text(row.consequence) ?? text(row.whyItMatters),
            affectedHolders: (Array.isArray(row.affectedHolders) ? row.affectedHolders : [])
                .map(text).filter(Boolean),
            before: row.before ?? null, after: row.after ?? null,
            assets: (Array.isArray(row.affectedMints) ? row.affectedMints : []).map((mint) => assetRef(mint, identityIndex)),
            sources: (Array.isArray(row.sources) ? row.sources : []).map((source) => ({
                label: text(source?.label), url: text(source?.url)
            })).filter((source) => source.url),
            href: issuerHref(issuer)
        });
    }

    for (const row of Array.isArray(curatedEvents) ? curatedEvents : []) {
        if (!text(row?.date) || !text(row?.summary)) continue;
        const issuer = text(row.issuer);
        const kind = text(row.kind) ?? 'event';
        const canonical = canonicalIssuer(issuer, issuerNames);
        const label = issuerName(canonical, issuerNames) ?? issuer ?? 'Sector';
        items.push({
            id: `curated-${row.date}-${issuer ?? 'sector'}-${kind}`, date: row.date,
            eventAt: row.date, effectiveAt: text(row.effectiveAt), firstObservedAt: text(row.firstObservedAt),
            reviewedAt: text(row.reviewedAt),
            category: 'actor-change', kind, severity: kind === 'shortfall' || kind === 'wind-down' ? 'warning' : 'caution',
            actor: issuer, issuer, title: `${label}: ${kind.replaceAll('-', ' ')}`,
            summary: row.summary, whyItMatters: null, before: null, after: null,
            consequence: text(row.consequence),
            affectedHolders: (Array.isArray(row.affectedHolders) ? row.affectedHolders : [])
                .map(text).filter(Boolean),
            assets: (Array.isArray(row.mints) ? row.mints : []).map((mint) => assetRef(mint, identityIndex)),
            sources: /^https?:\/\//.test(text(row.source) ?? '') ? [{ label: 'Primary record', url: row.source }] : [],
            sourceNote: text(row.source), href: issuerHref(canonical)
        });
    }

    for (const row of Array.isArray(protocolDiscrepancies) ? protocolDiscrepancies : []) {
        const date = text(row?.observedAt);
        if (!date || !text(row?.id) || !text(row?.title)) continue;
        const protocolName = text(row.protocolName) ?? text(row.protocolId) ?? 'Protocol';
        const claim = evidenceSide(row.claim);
        const reality = evidenceSide(row.reality);
        const slug = text(row.dossierSlug);
        const symbol = text(row.symbol);
        items.push({
            id: `protocol-discrepancy-${row.id}`, date, category: 'protocol-change', kind: 'docs-vs-chain',
            eventAt: null, effectiveAt: null, firstObservedAt: date, reviewedAt: text(row.reviewedAt),
            severity: ['info', 'caution', 'warning', 'critical'].includes(row.severity) ? row.severity : 'caution',
            actor: protocolName, issuer: null,
            title: `${protocolName}: ${row.title}`,
            summary: reality.text, whyItMatters: text(row.impact), consequence: text(row.impact),
            affectedHolders: [`users of the ${protocolName} ${symbol ?? 'token'} market`],
            before: null, after: null,
            claim, reality, resolutionCondition: text(row.resolutionCondition),
            assets: text(row.tokenMint) ? [assetRef(row.tokenMint, identityIndex)] : [],
            sources: [...claim.sources, ...reality.sources],
            href: slug && /^[a-z0-9-]+$/.test(slug) ? `./protocols/${slug}.html` : null
        });
    }

    const catalogueGroups = new Map();
    for (const row of Array.isArray(changes) ? changes : []) {
        const mint = text(row?.mint);
        const date = text(row?.date);
        if (!mint || !date || !['new-mint', 'removed-mint'].includes(row.kind)) continue;
        const asset = assetRef(mint, identityIndex);
        const added = row.kind === 'new-mint';
        const issuer = text(row.issuer) ?? asset.issuer;
        const key = `${date}|${row.kind}|${issuer ?? 'unknown'}`;
        if (!catalogueGroups.has(key)) catalogueGroups.set(key, { date, added, issuer, assets: [] });
        catalogueGroups.get(key).assets.push(asset);
    }
    for (const group of catalogueGroups.values()) {
        const { date, added, issuer, assets } = group;
        assets.sort((a, b) => String(a.symbol ?? a.name ?? a.mint).localeCompare(String(b.symbol ?? b.name ?? b.mint)));
        const count = assets.length;
        const issuerName = issuerNames instanceof Map ? issuerNames.get(issuer) : issuerNames?.[issuer];
        const label = count === 1 ? (assets[0].symbol ?? assets[0].name ?? assets[0].mint) : `${count} ${text(issuerName) ?? issuer ?? 'asset'} token addresses`;
        items.push({
            id: `catalogue-${added ? 'new-mint' : 'removed-mint'}-${date}-${issuer ?? 'unknown'}`, date, category: 'catalogue',
            eventAt: null, effectiveAt: null, firstObservedAt: date, reviewedAt: null,
            kind: added ? 'asset-added' : 'asset-removed', severity: 'info', actor: 'RWA Sonar catalogue',
            issuer,
            title: `${label} ${added ? 'entered' : 'left'} the tracked catalogue`,
            summary: added
                ? `RWA Sonar first confirmed and catalogued ${count === 1 ? 'this exact Solana token address' : `these ${count} exact Solana token addresses`} on ${date}. This is an observation date, not a claim that the issuer created the ${count === 1 ? 'token' : 'tokens'} that day.`
                : `${count === 1 ? 'This exact token address was' : `These ${count} exact token addresses were`} no longer carried by the catalogue on ${date}. That does not by itself mean ${count === 1 ? 'the token was' : 'the tokens were'} burned or ceased to exist on-chain.`,
            whyItMatters: added
                ? 'The headline asset count rises only when a specific token address has enough identity evidence to be included.'
                : 'A falling headline count can reflect an issuer registry or evidence change; the underlying token may still exist.',
            consequence: added
                ? 'This address can now be searched and compared in the tracked catalogue.'
                : 'The address no longer appears in current catalogue views; the token may still exist on-chain.',
            affectedHolders: ['people researching this exact token address'],
            before: added ? 'Not in catalogue' : 'In catalogue',
            after: added ? 'In catalogue' : 'Not in catalogue',
            assets, sources: [], href: count === 1 ? assets[0].href ?? issuerHref(issuer) : issuerHref(issuer)
        });
    }

    const protocolGroups = new Map();
    const protocolLatest = defiChanges?.latest;
    for (const row of Array.isArray(protocolLatest?.events) ? protocolLatest.events : []) {
        const date = text(protocolLatest.to);
        const mint = text(row?.mint);
        const kind = text(row?.kind);
        const protocolId = text(row?.protocolId);
        // An unknown program holding a token is a review candidate, not yet a public protocol change.
        if (!date || !mint || !kind || !protocolId || kind === 'defi-integration-candidate') continue;
        const key = `${date}|${kind}|${protocolId}`;
        if (!protocolGroups.has(key)) protocolGroups.set(key, { date, kind, protocolId, rows: [] });
        protocolGroups.get(key).rows.push(row);
    }
    for (const group of protocolGroups.values()) {
        const { date, kind, protocolId, rows } = group;
        const protocolName = text(rows[0]?.protocolName) ?? protocolId;
        const assets = rows.map((row) => assetRef(row.mint, identityIndex));
        const count = assets.length;
        const verb = kind === 'token-added' ? 'entered'
            : kind === 'market-added' ? 'gained a new market in'
            : kind === 'market-removed' ? 'lost a market in'
            : kind === 'defi-integration-added' ? 'is now held on-chain by'
            : kind === 'defi-integration-removed' ? 'no longer visibly held by'
            : kind === 'token-removed' ? 'left'
                : kind === 'ltv-changed' ? 'changed LTV in'
                    : kind === 'market-inactive' ? 'became inactive in' : 'changed in';
        const severity = rows.some((row) => row.severity === 'critical') ? 'critical'
            : rows.some((row) => row.severity === 'warning') ? 'warning'
                : rows.some((row) => row.severity === 'caution') ? 'caution' : 'info';
        const why = kind === 'defi-integration-added'
            ? 'A protocol program was observed holding this exact token on-chain; that is where an integration shows up first, before or without a registry listing. It does not prove a user transaction succeeds.'
            : kind === 'defi-integration-removed'
                ? 'A protocol program no longer holds a visible balance of this exact token; the use may have ended or shrunk below the visible largest accounts.'
                : kind === 'token-removed'
            ? 'A removed exact-token listing may eliminate a confirmed use or exit path; it does not prove positions were liquidated.'
            : kind === 'ltv-changed' || kind === 'collateral-value-drop'
                ? 'Borrow capacity or liquidation exposure changed in the checked protocol registry.'
                : kind === 'market-inactive'
                    ? 'A configured market no longer showed active collateral value in consecutive daily observations.'
                    : 'A new exact-token registry or pool observation establishes current support, not a successful user transaction.';
        items.push({
            id: `protocol-${kind}-${date}-${protocolId}`, date, category: 'protocol-change', kind,
            eventAt: null, effectiveAt: null, firstObservedAt: date, reviewedAt: null,
            severity, actor: protocolName, issuer: null,
            title: `${count === 1 ? (assets[0].symbol ?? assets[0].name ?? 'One token address') : `${count} token addresses`} ${verb} ${protocolName}`,
            summary: count === 1 ? text(rows[0]?.summary) : `Daily exact-token registry comparison grouped ${count} ${protocolName} changes of the same kind.`,
            whyItMatters: why,
            consequence: why,
            affectedHolders: kind === 'token-added' || kind === 'defi-integration-added' || kind === 'market-added'
                ? ['users considering this exact protocol route']
                : ['current or prospective users of this exact protocol route'],
            before: count === 1 ? rows[0].before ?? null : null,
            after: count === 1 ? rows[0].after ?? null : null,
            assets,
            sources: [{ label: 'Protocol monitor evidence', url: './monitor.html#defiChangesSection' }],
            href: './monitor.html#defiChangesSection'
        });
    }

    return items.sort((a, b) => b.date.localeCompare(a.date)
        || String(a.category).localeCompare(String(b.category))
        || String(a.id).localeCompare(String(b.id)));
}
