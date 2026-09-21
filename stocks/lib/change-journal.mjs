// Pure shaping for the public change journal. Only real external changes and catalogue membership
// observations belong here; internal corrections and collection false alarms stay private.

function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function issuerHref(slug) {
    const safe = text(slug);
    return safe && /^[a-z0-9-]+$/.test(safe) ? `./issuers/${safe}.html` : null;
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

export function buildChangeJournal({ changes, curatedEvents, resolutions, identities, tokens, issuerNames } = {}) {
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
            severity: text(row.severity) ?? 'info', actor: text(row.actor), issuer,
            title: row.title, summary: text(row.summary), whyItMatters: text(row.whyItMatters),
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
        items.push({
            id: `curated-${row.date}-${issuer ?? 'sector'}-${kind}`, date: row.date,
            category: 'actor-change', kind, severity: kind === 'shortfall' || kind === 'wind-down' ? 'warning' : 'caution',
            actor: issuer, issuer, title: `${issuer ?? 'Sector'}: ${kind.replaceAll('-', ' ')}`,
            summary: row.summary, whyItMatters: null, before: null, after: null,
            assets: (Array.isArray(row.mints) ? row.mints : []).map((mint) => assetRef(mint, identityIndex)),
            sources: /^https?:\/\//.test(text(row.source) ?? '') ? [{ label: 'Primary record', url: row.source }] : [],
            sourceNote: text(row.source), href: issuerHref(issuer)
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
        const label = count === 1 ? (assets[0].symbol ?? assets[0].name ?? assets[0].mint) : `${count} ${text(issuerName) ?? issuer ?? 'asset'} mints`;
        items.push({
            id: `catalogue-${added ? 'new-mint' : 'removed-mint'}-${date}-${issuer ?? 'unknown'}`, date, category: 'catalogue',
            kind: added ? 'asset-added' : 'asset-removed', severity: 'info', actor: 'RWA Sonar catalogue',
            issuer,
            title: `${label} ${added ? 'entered' : 'left'} the tracked catalogue`,
            summary: added
                ? `RWA Sonar first confirmed and catalogued ${count === 1 ? 'this exact Solana mint' : `these ${count} exact Solana mints`} on ${date}. This is an observation date, not a claim that the issuer created the ${count === 1 ? 'token' : 'tokens'} that day.`
                : `${count === 1 ? 'This exact mint was' : `These ${count} exact mints were`} no longer carried by the catalogue on ${date}. That does not by itself mean ${count === 1 ? 'the token was' : 'the tokens were'} burned or ceased to exist on-chain.`,
            whyItMatters: added
                ? 'The headline asset count rises only when a specific mint has enough identity evidence to be included.'
                : 'A falling headline count can reflect an issuer registry or evidence change; the underlying token may still exist.',
            before: added ? 'Not in catalogue' : 'In catalogue',
            after: added ? 'In catalogue' : 'Not in catalogue',
            assets, sources: [], href: count === 1 ? assets[0].href ?? issuerHref(issuer) : issuerHref(issuer)
        });
    }

    return items.sort((a, b) => b.date.localeCompare(a.date)
        || String(a.category).localeCompare(String(b.category))
        || String(a.id).localeCompare(String(b.id)));
}
