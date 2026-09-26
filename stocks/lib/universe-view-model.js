/*
 * The universe view's model. Tokens are planets; the things tokens share are moons: the stock they
 * track, their issuer, legal form, jurisdiction, each shareholder right's status, custodians and
 * attestors, the keys that hold on-chain powers, the DeFi protocols that take them and the health
 * warnings they carry. A planet's moons are what it shares; a moon's orbit is every planet that
 * shares it. So the view is a walk through that graph: planet → moon → another planet → …
 *
 * This module decides which moons a token has (from its card JSON, cards/<slug>.json, plus its
 * issuer's entry in universe-view/index.json) and lays out the orbits the scene draws. Pure: no DOM,
 * no three.js, no fetch. UMD like the other stocks/lib/*.js files: the browser loads it as a classic
 * script and reads window.__rwaUniverseView; node requires it (stocks/lib/universe-view.mjs builds
 * the index with it; stocks/universe-view.test.js tests it).
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaUniverseView = factory();
})(this, function () {
    const TAU = Math.PI * 2;

    /** Moon dimensions: one ring each around a planet, inner to outer, each with its own colour. */
    const DIMENSIONS = [
        { id: 'identity', label: 'Stock and issuer', color: '#e2e8f0' },
        { id: 'legal', label: 'Legal structure', color: '#a78bfa' },
        { id: 'rights', label: 'Shareholder rights', color: '#f5c451' },
        { id: 'custody', label: 'Custody', color: '#2dd4bf' },
        { id: 'keys', label: 'On-chain keys', color: '#fb7185' },
        { id: 'defi', label: 'DeFi', color: '#60a5fa' },
        { id: 'health', label: 'Health warnings', color: '#f472b6' }
    ];

    /**
     * The attributes a token can be grouped on. A moon is one value of one attribute; its id is
     * `<attribute>:<value>`, so the attribute is always the part before the first colon. `none` names
     * the group of tokens that have no value for it. A token can have several values of a
     * multi-valued attribute (custodians, keys, protocols, health warnings).
     */
    const ATTRIBUTES = [
        { id: 'stock', dimension: 'identity', label: 'Stock', none: 'No listed stock' },
        { id: 'issuer', dimension: 'identity', label: 'Issuer', none: 'Issuer not recorded' },
        { id: 'form', dimension: 'legal', label: 'Legal form', none: 'Legal form not recorded' },
        { id: 'claim', dimension: 'legal', label: 'How close to the share', none: 'Not assessed' },
        { id: 'jurisdiction', dimension: 'legal', label: 'Jurisdiction', none: 'Jurisdiction not recorded' },
        { id: 'allowlist', dimension: 'legal', label: 'Who can hold it', none: 'Any wallet can hold it' },
        { id: 'right-dividends', dimension: 'rights', label: 'Dividends', none: 'Not recorded' },
        { id: 'right-voting', dimension: 'rights', label: 'Voting', none: 'Not recorded' },
        { id: 'right-information', dimension: 'rights', label: 'Reports & meetings', none: 'Not recorded' },
        { id: 'right-splits', dimension: 'rights', label: 'Splits', none: 'Not recorded' },
        { id: 'right-takeovers', dimension: 'rights', label: 'Takeovers', none: 'Not recorded' },
        { id: 'verification', dimension: 'custody', label: 'Reserve check', none: 'No reserve check' },
        { id: 'custodian', dimension: 'custody', label: 'Custodian', none: 'No custodian named' },
        { id: 'attestor', dimension: 'custody', label: 'Attestor', none: 'No attestor named' },
        { id: 'key', dimension: 'keys', label: 'Key holder', none: 'No key recorded' },
        { id: 'fee', dimension: 'keys', label: 'Transfer fee', none: 'No transfer fee' },
        { id: 'defi', dimension: 'defi', label: 'DeFi protocol', none: 'No DeFi protocol' },
        { id: 'health', dimension: 'health', label: 'Health warning', none: 'No health warning' }
    ];

    /** Tones colour a moon's dot: green is reassuring, amber needs care, red is a live risk. */
    const TONE_COLORS = {
        good: '#4ade80', info: '#7dd3fc', caution: '#fbbf24', warning: '#f87171', muted: '#94a3b8'
    };

    /** A fixed colour per issuer programme, so the big ones never share a hue; the palette covers new ones. */
    const ISSUER_COLORS = {
        'xstocks-backed': '#60a5fa', 'backpack-securities': '#f472b6', 'ondo-global-markets': '#fbbf24', prestocks: '#34d399',
        tessera: '#a78bfa', securitize: '#22d3ee', 'superstate-opening-bell': '#fb923c', bullish: '#a3e635', shift: '#f87171',
        'remora-markets': '#94a3b8', ventuals: '#e879f9', 'republic-mirror': '#facc15'
    };
    const ISSUER_PALETTE = ['#38bdf8', '#fda4af', '#fde68a', '#86efac', '#c4b5fd', '#fdba74', '#67e8f9', '#fca5a5'];

    const RIGHT_TONES = { yes: 'good', value: 'info', discretion: 'caution', no: 'warning', na: 'muted', unknown: 'muted' };
    const RIGHT_WORDS = { yes: 'yours', value: 'passed through', discretion: 'issuer decides', no: 'no', na: 'n/a', unknown: 'not stated' };
    const HEALTH_TONES = { good: 'good', caution: 'caution', warning: 'warning', unknown: 'muted' };
    const KEY_KINDS = {
        'hot-key': { label: 'One key', tone: 'warning' }, multisig: { label: 'Multisig', tone: 'caution' },
        program: { label: 'Program', tone: 'info' }, unknown: { label: 'Key', tone: 'muted' }
    };
    const ROLE_WORDS = { mint: 'mint', freeze: 'freeze', moveBurn: 'move or burn' };

    function isNum(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function str(value) {
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    }

    function words(slug) {
        const value = str(slug);
        if (value === null) return null;
        const spaced = value.replace(/[-_]+/g, ' ');
        return spaced.charAt(0).toUpperCase() + spaced.slice(1);
    }

    function usd(value) {
        if (!isNum(value)) return null;
        const abs = Math.abs(value);
        if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
        if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
        if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}k`;
        if (abs >= 1) return `$${value.toFixed(2)}`;
        return `$${value.toPrecision(3)}`;
    }

    function count(value) {
        return isNum(value) ? new Intl.NumberFormat('en-US').format(value) : null;
    }

    function shortAddress(address) {
        return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
    }

    function joinWords(list) {
        if (list.length <= 1) return list.join('');
        return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
    }

    /** Detail rows without the empty ones: a missing value is left out, never shown as zero. */
    function rows(pairs) {
        return pairs.filter(([, value]) => value !== null && value !== undefined && value !== '')
            .map(([key, value]) => [key, String(value)]);
    }

    // --- which moons a token has -----------------------------------------------------------------

    /**
     * The token's moons, each {id, dimension, label, tone, relation: {summary, details}}. The id is
     * what makes a moon shared: two tokens with the same freeze key, custodian or protocol get the
     * same id. `relation` is what the moon means for THIS token (its roles, its LTV, its right text).
     * `keyInfo` (address → {kind, threshold, timelock}, from stocks-power-map.json) only sharpens key
     * labels; without it the label falls back to the card's own key kind.
     */
    function tokenMoons(card, { planet = null, issuer = null, keyInfo = null, ruleLabels = null } = {}) {
        const out = new Map();
        const symbol = str(card?.symbol) ?? planet?.symbol ?? 'this token';
        const add = (moon) => {
            if (!out.has(moon.id)) {
                const attribute = attributeOf(moon.id);
                const dimension = ATTRIBUTES.find((a) => a.id === attribute)?.dimension;
                if (!dimension) throw new Error(`universe: moon ${moon.id} has no attribute in ATTRIBUTES`);
                out.set(moon.id, { tone: 'info', ...moon, attribute, dimension, relation: { summary: null, details: [], ...moon.relation } });
            }
        };

        // Stock and issuer
        const ticker = str(card?.underlyingTicker) ?? str(planet?.underlying);
        if (ticker) add({ id: `stock:${ticker}`, dimension: 'identity', label: ticker, relation: { summary: `${symbol} tracks ${ticker}.` } });
        const issuerSlug = str(card?.issuer?.slug) ?? str(planet?.issuer);
        const issuerName = str(issuer?.name) ?? str(card?.issuer?.name) ?? words(issuerSlug);
        if (issuerSlug) add({ id: `issuer:${issuerSlug}`, dimension: 'identity', label: issuerName, relation: { summary: `Issued by ${issuerName}.` } });

        // Legal structure
        const own = card?.ownership ?? {};
        if (str(own.legalForm)) add({ id: `form:${own.legalForm}`, dimension: 'legal', label: words(own.legalForm), relation: { summary: `${symbol} is a ${words(own.legalForm).toLowerCase()}.` } });
        if (isNum(own.claimRung) && str(own.claimLabel)) {
            add({
                id: `claim:${own.claimRung}`, dimension: 'legal', label: words(own.claimLabel),
                tone: own.claimRung >= 4 ? 'good' : own.claimRung >= 2 ? 'caution' : 'warning',
                relation: { summary: `How close to the share: ${own.claimRung} of 4.` }
            });
        }
        if (str(issuer?.entityJurisdiction)) {
            add({ id: `jurisdiction:${issuer.entityJurisdiction}`, dimension: 'legal', label: issuer.entityJurisdiction,
                relation: { summary: `The issuing entity sits in ${issuer.entityJurisdiction}.`, details: rows([['Issuing entity', issuer.issuingEntity], ['Governing law', issuer.governingLaw]]) } });
        }
        if (card?.control?.allowlist === true || own.transferRestrictions?.allowlist === true) {
            add({ id: 'allowlist:approved', dimension: 'legal', label: 'Allowlisted wallets only', tone: 'caution', relation: { summary: 'Only wallets the issuer has approved can hold it.' } });
        }

        // Shareholder rights: one moon per right and status, so "Voting: yours" gathers every token that votes.
        for (const right of Array.isArray(issuer?.holderRights) ? issuer.holderRights : []) {
            add({
                id: `right-${right.id}:${right.status}`, dimension: 'rights', label: `${right.label}: ${RIGHT_WORDS[right.status] ?? right.status}`,
                tone: RIGHT_TONES[right.status] ?? 'muted',
                relation: { summary: [right.statusLabel, right.summary].filter(Boolean).join('. '), details: rows([['Source', right.sourceUrl]]) }
            });
        }

        // Custody: how the reserve is checked, and who holds and attests it.
        const verification = card?.verification ?? {};
        if (str(verification.type) && verification.type !== 'none') {
            const strength = isNum(verification.strength) ? verification.strength : null;
            add({
                id: `verification:${verification.type}`, dimension: 'custody', label: `Reserve check: ${verification.label ?? words(verification.type)}`,
                tone: strength === null ? 'muted' : strength >= 3 ? 'good' : 'caution',
                relation: { summary: strength === null ? null : `Strength ${strength} of 4.`, details: rows([['Link', verification.link]]) }
            });
        }
        for (const node of Array.isArray(card?.trustChain?.nodes) ? card.trustChain.nodes : []) {
            if (node.actor !== 'custodian' && node.actor !== 'attestor') continue;
            for (const party of Array.isArray(node.parties) ? node.parties : []) {
                if (!str(party)) continue;
                add({ id: `${node.actor}:${party}`, dimension: 'custody', label: party,
                    relation: { summary: `${node.actor === 'custodian' ? 'Custodian' : 'Attestor'} in ${symbol}'s chain of trust.` } });
            }
        }

        // On-chain keys: one moon per address, with every power it holds on this token.
        const control = card?.control ?? {};
        const kinds = card?.keyGovernance ?? {};
        const roles = new Map();
        const hold = (address, role, kind) => {
            if (!str(address)) return;
            const entry = roles.get(address) ?? { roles: [], kind: null };
            entry.roles.push(role);
            entry.kind = entry.kind ?? kind ?? null;
            roles.set(address, entry);
        };
        hold(control.mintAuthority, 'mint', kinds.mint);
        hold(control.freezeAuthority, 'freeze', kinds.freeze);
        hold(control.permanentDelegate, 'moveBurn', kinds.delegate);
        for (const [address, entry] of roles) {
            const info = keyInfo?.get?.(address) ?? null;
            const kind = KEY_KINDS[info?.kind === 'single-key' ? 'hot-key' : info?.kind ?? entry.kind] ?? KEY_KINDS.unknown;
            const label = info?.threshold && (info.kind === 'multisig') ? `${info.threshold.replace(/ of /, '-of-')} multisig` : kind.label;
            add({
                id: `key:${address}`, dimension: 'keys', label: `${label} ${shortAddress(address)}`, tone: kind.tone,
                relation: {
                    summary: `On ${symbol} it can ${joinWords(entry.roles.map((role) => ROLE_WORDS[role]))}.`,
                    details: rows([['Address', address], ['Signers', info?.threshold], ['Time lock', info?.timelock]])
                }
            });
        }
        const fee = isNum(control.transferFeeBps) && control.transferFeeBps > 0 ? control.transferFeeBps : null;
        const scheduled = isNum(control.transferFeeScheduled?.bps) && control.transferFeeScheduled.bps > 0 ? control.transferFeeScheduled.bps : null;
        if (fee !== null || scheduled !== null) {
            const bps = fee ?? scheduled;
            add({ id: `fee:${bps}`, dimension: 'keys', label: `Transfer fee ${(bps / 100).toFixed(2)}%`, tone: 'caution',
                relation: { summary: [fee !== null && `${(fee / 100).toFixed(2)}% on every transfer now`, scheduled !== null && `${(scheduled / 100).toFixed(2)}% scheduled`].filter(Boolean).join('; ') + '.' } });
        }

        // DeFi: every protocol that takes or trades this exact token, with what it does with it.
        const integrations = Array.isArray(card?.defiUsage?.integrations) ? card.defiUsage.integrations : [];
        const lenders = Array.isArray(card?.closedMarket?.lenders) ? card.closedMarket.lenders.filter((l) => !l.hidden) : [];
        for (const id of [...new Set([...integrations.map((i) => i.protocolId), ...lenders.map((l) => l.protocolId)].filter(Boolean))]) {
            const use = integrations.find((i) => i.protocolId === id) ?? null;
            const lender = lenders.find((l) => l.protocolId === id) ?? null;
            const m = use?.metrics ?? {};
            const ltv = isNum(m.liquidationLtvMin) ? `${Math.round(m.liquidationLtvMin * 100)}%` : isNum(lender?.liquidationLtvPct) ? `${lender.liquidationLtvPct}%` : null;
            const actions = Array.isArray(use?.actions) && use.actions.length ? use.actions.join(', ') : null;
            add({
                id: `defi:${id}`, dimension: 'defi', label: str(use?.protocolName) ?? str(lender?.protocolName) ?? words(id),
                relation: {
                    summary: [actions && `Takes ${symbol} for ${actions}`, lender && `price while the US market is closed: ${lender.label}`].filter(Boolean).join('; ') + '.',
                    details: rows([['Size', usd(m.sizeUsd)], ['Liquidation at', ltv], ['Closed market', lender?.sentence], ['Open', use?.links?.use]])
                }
            });
        }

        // Health warnings: each failing check is a moon every token failing it shares.
        const labels = ruleLabels instanceof Map ? ruleLabels : new Map();
        for (const rule of Array.isArray(card?.health?.rules) ? card.health.rules : []) {
            if (rule.status !== 'warning' && rule.status !== 'caution') continue;
            add({ id: `health:${rule.id}:${rule.status}`, dimension: 'health', label: `${labels.get(rule.id) ?? words(rule.id)}: ${rule.status}`,
                tone: HEALTH_TONES[rule.status], relation: { summary: `${labels.get(rule.id) ?? words(rule.id)} is at ${rule.status} for ${symbol}.` } });
        }
        return [...out.values()];
    }

    /** The attribute a moon id belongs to: the part before its first colon. */
    function attributeOf(id) {
        const text = String(id ?? '');
        const at = text.indexOf(':');
        return at < 0 ? text : text.slice(0, at);
    }

    // --- the tables ------------------------------------------------------------------------------

    /** A columnar table ({columns, rows}) as a list of objects. */
    function readTable(table) {
        const columns = Array.isArray(table?.columns) ? table.columns : [];
        return (Array.isArray(table?.rows) ? table.rows : []).map((row) => Object.fromEntries(columns.map((column, i) => [column, row[i]])));
    }

    /**
     * Lookups over universe-view/index.json's tables: the tokens (biggest pool first, so a lower index
     * is a bigger pool), the values, and the token × value links in both directions. Everything the
     * view shows is a query on these: a planet's moons, a moon's planets, and any grouping.
     */
    function tableIndex(data) {
        const tables = data?.tables ?? {};
        const tokens = readTable(tables.tokens);
        const values = readTable(tables.values);
        const attributes = readTable(tables.attributes);
        const byToken = tokens.map(() => []);
        const byValue = values.map(() => []);
        for (const [token, value] of Array.isArray(tables.tokenValues?.rows) ? tables.tokenValues.rows : []) {
            if (!byToken[token] || !byValue[value]) throw new Error(`universe: token × value link [${token}, ${value}] points outside the tables`);
            byToken[token].push(value);
            byValue[value].push(token);
        }
        for (const list of byValue) list.sort((a, b) => a - b);
        const tokenBySlug = new Map(tokens.map((token, i) => [token.slug, i]));
        const valueById = new Map(values.map((value, i) => [value.id, i]));

        /** The tokens carrying every one of the given value indices (all tokens for none). */
        function tokensWhere(valueIndices) {
            if (!valueIndices.length) return tokens.map((_, i) => i);
            let result = byValue[valueIndices[0]] ?? [];
            for (const v of valueIndices.slice(1)) {
                const keep = new Set(byValue[v] ?? []);
                result = result.filter((t) => keep.has(t));
            }
            return result;
        }

        /**
         * `tokenSet` grouped on one attribute: a group per value (largest first), each with its tokens
         * in pool order, plus the tokens with no value for it. A token with several values of a
         * multi-valued attribute sits in several groups.
         */
        function groupBy(tokenSet, attributeId) {
            const members = new Map();
            for (const t of tokenSet) {
                for (const v of byToken[t]) {
                    if (values[v].attribute !== attributeId) continue;
                    if (!members.has(v)) members.set(v, []);
                    members.get(v).push(t);
                }
            }
            const covered = new Set([...members.values()].flat());
            const groups = [...members].map(([value, list]) => ({ value, tokens: list }))
                .sort((a, b) => b.tokens.length - a.tokens.length || String(values[a.value].label).localeCompare(String(values[b.value].label)));
            return { groups, none: tokenSet.filter((t) => !covered.has(t)) };
        }

        /**
         * A token's values split into those it shares with at least one other token (drawn as moons,
         * each leads somewhere) and those only it has (listed, since opening one would show it alone).
         */
        function sharedValues(t) {
            const shared = [];
            const single = [];
            for (const v of byToken[t] ?? []) (byValue[v].length > 1 ? shared : single).push(v);
            return { shared, single };
        }

        return { tokens, values, attributes, byToken, byValue, tokenBySlug, valueById, tokensWhere, groupBy, sharedValues };
    }

    /** Groups with several tokens (drawn as moons) and groups of one token (listed, opening the token itself). */
    function splitSingles(groups) {
        const list = Array.isArray(groups) ? groups : [];
        return { multi: list.filter((g) => g.tokens.length > 1), single: list.filter((g) => g.tokens.length === 1) };
    }

    /** Where a moon links: the issuer's dossier, the stock's wrapper comparison, the key map. */
    function moonHref(id) {
        const [kind, ...rest] = String(id).split(':');
        const value = rest.join(':');
        if (kind === 'issuer') return `./issuers/${encodeURIComponent(value)}.html`;
        if (kind === 'stock') return `./stocks.html?view=compare&compare=${encodeURIComponent(value)}`;
        if (kind === 'key' || kind === 'fee') return './powers.html';
        return null;
    }

    // --- sizes and orbits ------------------------------------------------------------------------

    /** Planet radius from pool liquidity on a log scale; a token with no measured pool is the smallest. */
    function planetRadius(liquidityUsd) {
        if (!isNum(liquidityUsd) || liquidityUsd <= 100) return 0.35;
        return 0.35 + 0.24 * Math.min(6, Math.log10(liquidityUsd) - 2);
    }

    /** A stable pseudo-random number in [0, 1) from a string, so a body keeps its place between visits. */
    function hash01(value, salt = 0) {
        let h = 2166136261 ^ salt;
        for (const ch of String(value)) {
            h ^= ch.codePointAt(0);
            h = Math.imul(h, 16777619);
        }
        return ((h >>> 0) % 100000) / 100000;
    }

    /** The members drawn as planets (the biggest pools, in the order given) and the rest, drawn as a belt. */
    function splitForView(members, limit = 48) {
        const list = Array.isArray(members) ? members : [];
        return { shown: list.slice(0, limit), rest: list.slice(limit) };
    }

    /** Where planet number `rank` orbits a centre of radius `centreRadius`: further out by rank, a stable angle and tilt. */
    function planetOrbit(rank, slug, centreRadius) {
        const radius = centreRadius * 2.2 + 1.8 + rank * 1.6;
        return {
            radius,
            angle: hash01(slug, 1) * TAU,
            tilt: (hash01(slug, 2) - 0.5) * 0.16,
            speed: 2.2 / Math.pow(radius, 1.5)
        };
    }

    /**
     * A planet's moons: one ring per dimension present, inner to outer in DIMENSIONS order, moons
     * spaced evenly round their ring. A ring grows when it has more moons than fit, and the next ring
     * starts outside it, so no two moons ever touch. Returns {size, rings[{dimension, radius, orbits}]}.
     */
    function moonRings(moons, centreRadius) {
        const size = centreRadius * 0.16;
        const gap = size * 3.4;
        const rings = [];
        let radius = centreRadius * 1.7;
        for (const dim of DIMENSIONS) {
            const own = moons.filter((moon) => moon.dimension === dim.id);
            if (own.length === 0) continue;
            // Neighbours on a ring sit at least 3 moon radii apart (chord of 2πR/n).
            const fit = (own.length * size * 3) / TAU;
            radius = Math.max(radius + gap, fit);
            const phase = hash01(dim.id, 4) * TAU;
            rings.push({
                dimension: dim.id,
                radius,
                orbits: own.map((moon, i) => ({
                    id: moon.id, radius, size,
                    angle: (phase + (i / own.length) * TAU) % TAU,
                    tilt: (hash01(dim.id, 5) - 0.5) * 0.18,
                    speed: 0.35 / Math.pow(radius / centreRadius, 1.2)
                }))
            });
        }
        return { size, rings };
    }

    /**
     * How far the camera stands to frame a centre and everything orbiting out to `extent`, for a
     * screen at least as wide as it is tall; a narrower screen (aspect < 1) stands back further.
     */
    function frameDistance(centreRadius, extent, aspect = 1) {
        const widen = typeof aspect === 'number' && aspect > 0 && aspect < 1 ? 1 / aspect : 1;
        return Math.max(centreRadius * 4, (isNum(extent) ? extent : centreRadius * 2.6) * 2.3) * widen;
    }

    function issuerColor(issuers, slug) {
        if (Object.prototype.hasOwnProperty.call(ISSUER_COLORS, slug)) return ISSUER_COLORS[slug];
        const position = (Array.isArray(issuers) ? issuers : []).findIndex((issuer) => issuer.slug === slug);
        return ISSUER_PALETTE[(position < 0 ? 0 : position) % ISSUER_PALETTE.length];
    }

    function dimensionOf(id) {
        return DIMENSIONS.find((dim) => dim.id === id) ?? null;
    }

    return {
        DIMENSIONS, ATTRIBUTES, TONE_COLORS, ISSUER_COLORS, ISSUER_PALETTE,
        tokenMoons, attributeOf, readTable, tableIndex, splitSingles, moonHref, dimensionOf, planetRadius, hash01, splitForView, planetOrbit, moonRings, frameDistance, issuerColor
    };
});
