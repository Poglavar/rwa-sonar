#!/usr/bin/env node
// Builds stocks-graph.json (MODEL.md §10.4): one node per issuer programme, one per named party
// (from each dossier's `parties` object, §10.2) and one per trading venue (aggregated per programme
// from venues.json, §10.3), plus the typed edges between them. Every rule here is a pure function
// exported for stocks/graph.test.js; the CLI at the bottom only reads files, calls buildGraph and
// reports counts. Node ids are slugified canonical names, so a party named identically in two
// dossiers is one node with two edges.

import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { byString, log, logWarn, parseArgs, readJson, ts, writeJson } from './lib/io.mjs';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..');
const DATA_DIR = join(HERE, 'data');
const OUT_FILE = 'stocks-graph.json';

/**
 * Dossier file base → the issuer slug the machine data uses. Mirrors DOSSIER_SLUGS in
 * build-stocks-db.mjs: only the three dossiers whose filename carries a ticker need mapping.
 */
const DOSSIER_SLUGS = {
    'backpack-securities-spcx': 'backpack-securities',
    'bullish-blsh': 'bullish',
    'securitize-secz': 'securitize'
};

/**
 * One row per `parties` key (MODEL §10.2): which node type the party becomes, which edge type the
 * relation is, and which way the arrow points. `party-to-programme` reads "<party> <verb> <the
 * programme>"; `programme-to-party` reads "<the programme> <verb> <party>".
 *
 * `securitiesIssuers` is the one row whose edge depends on the programme: only a register-mirrored
 * programme's listed company actually issues the tokenized share. Everywhere else the listed
 * company is merely referenced and is not a participant, so the arrow is reversed and the relation
 * is `references` — see securitiesEdge().
 */
const ROLE_EDGES = [
    { key: 'securitiesIssuers', nodeType: 'security-issuer', edgeType: 'issues', direction: 'party-to-programme', legalFormDependent: true },
    { key: 'tokenIssuers', nodeType: 'token-issuer', edgeType: 'wraps', direction: 'party-to-programme' },
    { key: 'tokenizationProviders', nodeType: 'tokenization-provider', edgeType: 'tokenizes-for', direction: 'party-to-programme' },
    { key: 'transferAgents', nodeType: 'transfer-agent', edgeType: 'keeps-register', direction: 'party-to-programme' },
    { key: 'custodians', nodeType: 'custodian', edgeType: 'custodies', direction: 'party-to-programme' },
    { key: 'verificationAgents', nodeType: 'verification-agent', edgeType: 'verifies', direction: 'party-to-programme' },
    { key: 'distributors', nodeType: 'distributor', edgeType: 'distributes', direction: 'party-to-programme' },
    { key: 'regulators', nodeType: 'regulator', edgeType: 'regulated-by', direction: 'programme-to-party' },
    { key: 'parents', nodeType: 'parent', edgeType: 'owned-by', direction: 'programme-to-party' },
    { key: 'audience', nodeType: 'audience', edgeType: 'offered-to', direction: 'programme-to-party' }
];

const ROLE_BY_KEY = new Map(ROLE_EDGES.map((row) => [row.key, row]));

/** Every node type MODEL §10.4 allows, most specific first — this is the dedupe tie-break. */
const NODE_TYPE_PRECEDENCE = [
    'programme',
    'regulator',
    'security-issuer',
    'token-issuer',
    'tokenization-provider',
    'transfer-agent',
    'custodian',
    'verification-agent',
    'parent',
    'lending',
    'dex',
    'distributor',
    'audience'
];

const NODE_TYPES = new Set(NODE_TYPE_PRECEDENCE);

const EDGE_TYPES = new Set([
    'issues', 'references', 'wraps', 'tokenizes-for', 'keeps-register', 'custodies', 'verifies',
    'distributes', 'traded-on', 'lends-on', 'regulated-by', 'owned-by', 'offered-to'
]);

/** The one legal form whose listed company really issues the token (a mirrored share register). */
const REGISTER_MIRRORED_LEGAL_FORM = 'registered-share';

/**
 * Lending venues a dossier can name in prose. Only Kamino is named today (MODEL §10.4); the match
 * is deliberately a table rather than a free-text scan so a new venue is an explicit addition.
 */
const LENDING_VENUES = [
    { name: 'Kamino', pattern: /\bkamino\b/i }
];

/** Dossier fields whose prose may name a lending venue. */
const LENDING_TEXT_FIELDS = ['venues', 'pricing', 'collateral', 'holderClaim', 'products'];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** True only for a real, finite number — so a missing liquidity never becomes 0. */
export function isNum(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/** "Backed Assets (JE) Limited" -> "backed-assets-je-limited". Stable node id for a canonical name. */
export function slugify(name) {
    if (name === null || name === undefined) return '';
    return String(name)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** The more specific of two node types wins when one name arrives under two roles. */
export function preferNodeType(a, b) {
    const ia = NODE_TYPE_PRECEDENCE.indexOf(a);
    const ib = NODE_TYPE_PRECEDENCE.indexOf(b);
    if (ia === -1) return ib === -1 ? a : b;
    if (ib === -1) return a;
    return ia <= ib ? a : b;
}

/** Drops every key whose value is null, undefined or an empty string/array/object. */
export function compactMeta(meta) {
    const out = {};
    for (const key of Object.keys(meta || {}).sort(byString)) {
        const value = meta[key];
        if (value === null || value === undefined || value === '') continue;
        if (Array.isArray(value) && value.length === 0) continue;
        if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
        out[key] = value;
    }
    return out;
}

/** One programme node per issuer record: status and grades travel in meta (MODEL §10.4). */
export function programmeNodes(issuerRecords) {
    const nodes = [];
    for (const issuer of Array.isArray(issuerRecords) ? issuerRecords : []) {
        if (!issuer || !issuer.slug) continue;
        nodes.push({
            id: slugify(issuer.slug),
            label: issuer.name || issuer.slug,
            type: 'programme',
            meta: compactMeta({
                slug: issuer.slug,
                status: issuer.status || null,
                grades: issuer.grades || null,
                legalForm: issuer.legalForm || null,
                mints: Array.isArray(issuer.tokenMints) ? issuer.tokenMints.length : null
            })
        });
    }
    return nodes;
}

/**
 * slug -> the canonical party row, for looking a venue's authored name and type up by its id.
 * Venue nodes take their label from here so "raydium" renders as "Raydium" and an unlisted market
 * keeps the string the source actually used.
 */
export function canonicalIndex(canonicalParties) {
    const index = new Map();
    for (const party of Array.isArray(canonicalParties) ? canonicalParties : []) {
        if (!party || !party.name) continue;
        const slug = slugify(party.name);
        if (slug && !index.has(slug)) index.set(slug, party);
    }
    return index;
}

/**
 * Which relation a `securitiesIssuers` entry is. A register-mirrored programme (legalForm
 * `registered-share`: Opening Bell, Bullish, Securitize) tokenizes the listed company's own share,
 * so the company issues it. Every other programme — a wrapper, an SPV claim, a note, a perp —
 * only references that company's price, and the company is not a participant at all; drawing that
 * as `issues` would credit a party that never signed anything.
 */
export function securitiesEdge(legalForm) {
    return legalForm === REGISTER_MIRRORED_LEGAL_FORM
        ? { edgeType: 'issues', direction: 'party-to-programme' }
        : { edgeType: 'references', direction: 'programme-to-party' };
}

/**
 * Nodes and edges for one dossier's `parties` object. `programmeId` is the slugified issuer slug
 * and `legalForm` is that programme's legal form, which decides issues vs references; an entry
 * with no usable name is skipped rather than becoming an empty node.
 */
export function partyGraph(parties, programmeId, programmeSlug, legalForm) {
    const nodes = [];
    const edges = [];
    if (!parties || typeof parties !== 'object' || !programmeId) return { nodes, edges };

    for (const role of ROLE_EDGES) {
        const list = parties[role.key];
        if (!Array.isArray(list)) continue;
        const relation = role.legalFormDependent ? securitiesEdge(legalForm) : role;
        for (const party of list) {
            if (!party || typeof party !== 'object') continue;
            const id = slugify(party.name);
            if (!id) continue;
            nodes.push({
                id,
                label: String(party.name).trim(),
                type: role.nodeType,
                meta: compactMeta({
                    roles: [role.key],
                    jurisdiction: party.jurisdiction || null,
                    identifier: party.identifier || null,
                    note: party.note || null,
                    source: party.source || null
                })
            });
            const from = relation.direction === 'party-to-programme' ? id : programmeId;
            const to = relation.direction === 'party-to-programme' ? programmeId : id;
            edges.push({
                from,
                to,
                type: relation.edgeType,
                weight: 1,
                via: [programmeSlug],
                note: party.note ? String(party.note).trim() : null
            });
        }
    }
    return { nodes, edges };
}

/**
 * venues.json (MODEL §10.3) normalised to one row per mint: `{mint, issuer, dex[], cex[]}`. The
 * fetcher writes `{fetchedAt, source, items:[…]}` and carries the programme slug on every item as
 * `issuer`, so the join needs no mint index. A row with neither list is dropped — it is a mint the
 * fetcher looked up and found nothing for, not a venue.
 */
export function venueEntries(venuesFile) {
    if (!venuesFile || typeof venuesFile !== 'object') return [];
    const items = Array.isArray(venuesFile.items) ? venuesFile.items : null;
    if (!items) return [];
    const rows = [];
    for (const item of items) {
        if (!item || typeof item !== 'object' || typeof item.mint !== 'string' || !item.mint) continue;
        const dex = Array.isArray(item.dex) ? item.dex : [];
        const cex = Array.isArray(item.cex) ? item.cex : [];
        if (!dex.length && !cex.length) continue;
        rows.push({ mint: item.mint, issuer: typeof item.issuer === 'string' ? item.issuer : null, dex, cex });
    }
    return rows.sort((a, b) => byString(a.mint, b.mint));
}

/**
 * Which known DEX a CoinGecko market id belongs to, so a DEX reported as a "market" lands on the
 * DEX node instead of becoming a second, distributor-typed copy of it. CoinGecko decorates the id
 * with the pool flavour — `raydium-clmm`, `raydium2`, `meteora-damm-v2` — so a known id followed by
 * a hyphen or a digit counts. A letter may NOT follow: `meteoradbc` is its own DexScreener venue,
 * not Meteora, and must not be folded into it.
 */
export function dexIdForMarket(marketId, knownDexIds) {
    const id = slugify(marketId);
    if (!id) return null;
    const known = knownDexIds instanceof Set ? knownDexIds : new Set(knownDexIds || []);
    if (known.has(id)) return id;
    let best = null;
    for (const dexId of known) {
        if (!id.startsWith(dexId)) continue;
        const next = id.charAt(dexId.length);
        if (next !== '-' && !(next >= '0' && next <= '9')) continue;
        if (!best || dexId.length > best.length) best = dexId;
    }
    return best;
}

/**
 * `traded-on` nodes and edges: every pool and ticker of a programme's mints summed onto one edge
 * per (programme, venue).
 *
 * Weight is Σ liquidityUsd over that programme's mints on that venue, falling back to Σ volume24Usd
 * when no pool there reported liquidity — a CEX ticker never reports liquidity, so its weight is
 * always a volume. `meta.weightBasis` records which of the two it is, because a liquidity weight and
 * a volume weight are not the same measurement and the page must be able to say so.
 *
 * `canonicalLabels` maps a slug to the hand-kept canonical name (Raydium, Orca, Meteora, Kraken…);
 * a venue absent from that table keeps the raw dexId or market string as its label rather than being
 * given an invented one. A mint whose `issuer` is not a known programme is skipped and counted.
 */
export function aggregateVenues(entries, programmeIds, canonicalLabels) {
    const rows = Array.isArray(entries) ? entries : [];
    const known = programmeIds instanceof Set ? programmeIds : new Set(programmeIds || []);
    const labels = canonicalLabels instanceof Map ? canonicalLabels : new Map(Object.entries(canonicalLabels || {}));
    const byKey = new Map();
    const skipped = [];

    // Every DEX the pools name, plus every DEX the canonical table knows, so a CoinGecko market
    // can be recognised as one even when no DexScreener pool for it was returned.
    const knownDexIds = new Set();
    for (const [slug, entry] of labels) if (entry && entry.type === 'dex') knownDexIds.add(slug);
    for (const row of rows) {
        for (const pair of row.dex) {
            const id = slugify(pair && pair.dexId);
            if (id) knownDexIds.add(id);
        }
    }

    function labelFor(venueId, fallback) {
        const canonical = labels.get(venueId);
        return canonical && canonical.name ? canonical.name : String(fallback === null || fallback === undefined ? venueId : fallback);
    }

    function bucket(programmeId, venueId, label, nodeType) {
        const key = `${programmeId}|${venueId}`;
        if (!byKey.has(key)) {
            byKey.set(key, {
                programmeId, venueId, label, nodeType,
                liquidityUsd: 0, volume24Usd: 0, sawLiquidity: false,
                pools: 0, tickers: 0, mints: new Set()
            });
        }
        const row = byKey.get(key);
        // A venue seen as both a pool and a market stays a dex: that is what it is.
        row.nodeType = preferNodeType(row.nodeType, nodeType);
        return row;
    }

    for (const entry of rows) {
        const programmeId = entry.issuer ? slugify(entry.issuer) : '';
        if (!programmeId || !known.has(programmeId)) {
            skipped.push({ mint: entry.mint, issuer: entry.issuer || null });
            continue;
        }
        for (const pair of entry.dex) {
            const venueId = slugify(pair && pair.dexId);
            if (!venueId) continue;
            const row = bucket(programmeId, venueId, labelFor(venueId, pair.dexId), 'dex');
            if (isNum(pair.liquidityUsd) && pair.liquidityUsd > 0) {
                row.liquidityUsd += pair.liquidityUsd;
                row.sawLiquidity = true;
            }
            if (isNum(pair.volume24Usd)) row.volume24Usd += pair.volume24Usd;
            row.pools += 1;
            row.mints.add(entry.mint);
        }
        for (const ticker of entry.cex) {
            const asDex = dexIdForMarket(ticker && ticker.marketId, knownDexIds);
            const venueId = asDex || slugify(ticker && ticker.market);
            if (!venueId) continue;
            const row = bucket(programmeId, venueId, labelFor(venueId, asDex || ticker.market), asDex ? 'dex' : 'distributor');
            if (isNum(ticker.volume24Usd)) row.volume24Usd += ticker.volume24Usd;
            row.tickers += 1;
            row.mints.add(entry.mint);
        }
    }

    const nodesById = new Map();
    const edges = [];
    for (const row of byKey.values()) {
        const basis = row.sawLiquidity ? 'liquidity' : 'volume';
        const weight = row.sawLiquidity ? row.liquidityUsd : row.volume24Usd;
        const previous = nodesById.get(row.venueId);
        nodesById.set(row.venueId, {
            id: row.venueId,
            label: previous ? previous.label : row.label,
            type: previous ? preferNodeType(previous.type, row.nodeType) : row.nodeType,
            liquidityUsd: (previous ? previous.liquidityUsd : 0) + row.liquidityUsd,
            volume24Usd: (previous ? previous.volume24Usd : 0) + row.volume24Usd,
            pools: (previous ? previous.pools : 0) + row.pools,
            tickers: (previous ? previous.tickers : 0) + row.tickers,
            programmes: (previous ? previous.programmes : 0) + 1
        });
        const counted = [
            `${row.mints.size} mint${row.mints.size === 1 ? '' : 's'}`,
            row.pools ? `${row.pools} pool${row.pools === 1 ? '' : 's'}` : null,
            row.tickers ? `${row.tickers} ticker${row.tickers === 1 ? '' : 's'}` : null
        ].filter(Boolean).join(', ');
        edges.push({
            from: row.programmeId,
            to: row.venueId,
            type: 'traded-on',
            weight: isNum(weight) ? Math.round(weight) : null,
            via: [row.programmeId],
            note: counted + (basis === 'liquidity'
                ? ''
                : ' — weight is 24h volume, this venue reports no pool liquidity'),
            meta: compactMeta({
                mints: row.mints.size,
                liquidityUsd: row.liquidityUsd > 0 ? Math.round(row.liquidityUsd) : null,
                volume24Usd: row.volume24Usd > 0 ? Math.round(row.volume24Usd) : null,
                weightBasis: basis
            })
        });
    }

    const nodes = [...nodesById.values()].map((node) => ({
        id: node.id,
        label: node.label,
        type: node.type,
        meta: compactMeta({
            liquidityUsd: node.liquidityUsd > 0 ? Math.round(node.liquidityUsd) : null,
            volume24Usd: node.volume24Usd > 0 ? Math.round(node.volume24Usd) : null,
            pools: node.pools || null,
            tickers: node.tickers || null,
            programmes: node.programmes || null
        })
    }));

    return { nodes, edges, skipped, knownDexIds: [...knownDexIds].sort(byString) };
}

/**
 * `lends-on` for a lending venue a dossier names in prose. The weight stays null: the dossiers
 * quote a figure in a sentence, and a number parsed out of prose is not a measurement.
 */
export function lendingGraph(dossier, programmeId, programmeSlug) {
    const nodes = [];
    const edges = [];
    if (!dossier || !programmeId) return { nodes, edges };

    const texts = [];
    for (const field of LENDING_TEXT_FIELDS) {
        const value = dossier[field];
        if (typeof value === 'string') texts.push(value);
        else if (Array.isArray(value)) texts.push(...value.filter((item) => typeof item === 'string'));
        else if (value && typeof value === 'object') {
            texts.push(...Object.values(value).filter((item) => typeof item === 'string'));
        }
    }

    for (const venue of LENDING_VENUES) {
        const hit = texts.find((text) => venue.pattern.test(text));
        if (!hit) continue;
        nodes.push({ id: slugify(venue.name), label: venue.name, type: 'lending', meta: {} });
        edges.push({
            from: programmeId,
            to: slugify(venue.name),
            type: 'lends-on',
            weight: null,
            via: [programmeSlug],
            note: hit.length > 220 ? `${hit.slice(0, 217)}...` : hit
        });
    }
    return { nodes, edges };
}

/** Merges duplicate ids: most specific type wins, metas merge, `roles` unions. */
export function dedupeNodes(nodes) {
    const byId = new Map();
    for (const node of Array.isArray(nodes) ? nodes : []) {
        if (!node || !node.id) continue;
        const existing = byId.get(node.id);
        if (!existing) {
            byId.set(node.id, { id: node.id, label: node.label || node.id, type: node.type, meta: { ...(node.meta || {}) } });
            continue;
        }
        existing.type = preferNodeType(existing.type, node.type);
        if (!existing.label && node.label) existing.label = node.label;
        const roles = new Set([...(existing.meta.roles || []), ...((node.meta && node.meta.roles) || [])]);
        for (const [key, value] of Object.entries(node.meta || {})) {
            if (key === 'roles') continue;
            if (existing.meta[key] === undefined || existing.meta[key] === null || existing.meta[key] === '') {
                existing.meta[key] = value;
            }
        }
        if (roles.size) existing.meta.roles = [...roles].sort(byString);
    }
    return [...byId.values()].map((node) => ({ ...node, meta: compactMeta(node.meta) }));
}

/** Merges duplicate (from,to,type): weights sum, `via` unions, the first note is kept. */
export function dedupeEdges(edges) {
    const byKey = new Map();
    for (const edge of Array.isArray(edges) ? edges : []) {
        if (!edge || !edge.from || !edge.to || !edge.type) continue;
        const key = `${edge.from}|${edge.to}|${edge.type}`;
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, {
                from: edge.from,
                to: edge.to,
                type: edge.type,
                weight: isNum(edge.weight) ? edge.weight : null,
                via: [...new Set((edge.via || []).filter(Boolean))],
                note: edge.note || null,
                meta: edge.meta ? { ...edge.meta } : null
            });
            continue;
        }
        if (isNum(edge.weight)) existing.weight = isNum(existing.weight) ? existing.weight + edge.weight : edge.weight;
        existing.via = [...new Set([...existing.via, ...(edge.via || []).filter(Boolean)])];
        if (!existing.note && edge.note) existing.note = edge.note;
        // Numbers in a merged edge's meta add up; a weightBasis of "volume" is the weaker of the
        // two and wins, so a merged weight is never labelled better than its worst component.
        if (edge.meta) {
            const meta = existing.meta || (existing.meta = {});
            for (const [key2, value] of Object.entries(edge.meta)) {
                if (key2 === 'weightBasis') meta.weightBasis = meta.weightBasis === 'volume' || value === 'volume' ? 'volume' : value;
                else if (isNum(value)) meta[key2] = isNum(meta[key2]) ? meta[key2] + value : value;
                else if (meta[key2] === undefined) meta[key2] = value;
            }
        }
    }
    return [...byKey.values()].map((edge) => {
        const out = { ...edge, via: edge.via.sort(byString) };
        if (!out.meta || !Object.keys(out.meta).length) delete out.meta;
        return out;
    });
}

/**
 * Canonical type, jurisdiction, identifier, website and note onto the matching party node. The
 * canonical table's `type` WINS over the type derived from the dossier role: Kraken is named as a
 * tokenization provider in one prospectus and as a distributor everywhere else, and the hand-kept
 * table exists to settle exactly that. `alsoRoles` stays a separate field from the dossier-derived
 * `roles`, because the two use different vocabularies (node types vs `parties` keys).
 */
export function applyCanonicalMeta(nodes, canonicalParties) {
    const byId = new Map();
    for (const party of Array.isArray(canonicalParties) ? canonicalParties : []) {
        if (!party || !party.name) continue;
        byId.set(slugify(party.name), party);
    }
    return nodes.map((node) => {
        const party = byId.get(node.id);
        if (!party) return node;
        const canonicalType = NODE_TYPES.has(party.type) ? party.type : null;
        return {
            ...node,
            type: node.type === 'programme' || !canonicalType ? node.type : canonicalType,
            meta: compactMeta({
                ...node.meta,
                alsoRoles: Array.isArray(party.alsoRoles) ? [...party.alsoRoles].sort(byString) : null,
                jurisdiction: node.meta.jurisdiction || party.jurisdiction || null,
                identifier: node.meta.identifier || party.identifier || null,
                website: party.website || null,
                note: node.meta.note || party.note || null
            })
        };
    });
}

export function sortNodes(nodes) {
    return [...nodes].sort((a, b) => byString(a.id, b.id));
}

export function sortEdges(edges) {
    return [...edges].sort((a, b) =>
        byString(a.from, b.from) || byString(a.to, b.to) || byString(a.type, b.type));
}

/** {programme: 12, dex: 5, …}, in the declared type order so the log reads the same every run. */
export function countsByType(items, order) {
    const counts = Object.create(null);
    for (const item of items || []) {
        const key = item && item.type ? item.type : 'unknown';
        counts[key] = (counts[key] || 0) + 1;
    }
    const keys = order ? order.filter((key) => counts[key]) : Object.keys(counts).sort(byString);
    for (const key of Object.keys(counts)) if (!keys.includes(key)) keys.push(key);
    const out = {};
    for (const key of keys) out[key] = counts[key];
    return out;
}

/** Edges pointing at an id no node carries — a dangling edge is a build bug, not a display one. */
export function danglingEdges(nodes, edges) {
    const ids = new Set(nodes.map((node) => node.id));
    return edges.filter((edge) => !ids.has(edge.from) || !ids.has(edge.to));
}

/**
 * The whole graph from its four inputs. `dossiers` is `[{slug, dossier}]`, so the caller owns
 * filename → slug mapping and this stays pure.
 */
export function buildGraph({ issuers = [], dossiers = [], canonicalParties = [], venues = null, builtAt = null } = {}) {
    const nodes = programmeNodes(issuers);
    const edges = [];
    const programmeIds = new Set(nodes.map((node) => node.id));
    const legalForms = new Map((Array.isArray(issuers) ? issuers : [])
        .filter((issuer) => issuer && issuer.slug)
        .map((issuer) => [slugify(issuer.slug), issuer.legalForm || null]));

    for (const { slug, dossier } of dossiers) {
        const programmeId = slugify(slug);
        if (!programmeIds.has(programmeId)) continue;
        const parties = partyGraph(dossier && dossier.parties, programmeId, slug, legalForms.get(programmeId));
        nodes.push(...parties.nodes);
        edges.push(...parties.edges);
        const lending = lendingGraph(dossier, programmeId, slug);
        nodes.push(...lending.nodes);
        edges.push(...lending.edges);
    }

    const venueAgg = aggregateVenues(venueEntries(venues), programmeIds, canonicalIndex(canonicalParties));
    nodes.push(...venueAgg.nodes);
    edges.push(...venueAgg.edges);

    const finalNodes = sortNodes(applyCanonicalMeta(dedupeNodes(nodes), canonicalParties));
    const finalEdges = sortEdges(dedupeEdges(edges)).filter((edge) => EDGE_TYPES.has(edge.type));

    return {
        builtAt: builtAt || ts(),
        nodes: finalNodes,
        edges: finalEdges,
        venueStats: {
            mintsWithVenues: venueEntries(venues).length,
            venueNodes: venueAgg.nodes.length,
            tradedOnEdges: venueAgg.edges.length,
            dexNodes: venueAgg.nodes.filter((node) => node.type === 'dex').length,
            cexNodes: venueAgg.nodes.filter((node) => node.type === 'distributor').length,
            knownDexIds: venueAgg.knownDexIds,
            skipped: venueAgg.skipped
        }
    };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
    console.log(`build-graph.mjs — join the issuer records, dossier parties and venues into ${OUT_FILE}

USAGE
  node stocks/build-graph.mjs --run [options]

OPTIONS
  --run                Actually build. Without it this help is printed and nothing runs.
  --issuers=<file>     Issuer records (default ${join(REPO_ROOT, 'stocks-issuers.json')}).
  --dossiers=<dir>     Hand-researched dossiers (default ${join(DATA_DIR, 'issuers')}).
  --parties=<file>     Canonical party table (default ${join(DATA_DIR, 'canonical-parties.json')}).
  --venues=<file>      Per-mint venues (default ${join(DATA_DIR, 'venues.json')}).
  --out=<file>         Output path (default ${join(REPO_ROOT, OUT_FILE)}).
  --help               This text.

Missing venues.json or canonical-parties.json is not fatal: the graph is built without those
nodes and the run says so. A missing issuer file is fatal — programmes are the spine of the graph.`);
}

async function readDossiers(dir) {
    let files;
    try {
        files = await readdir(dir);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    const out = [];
    for (const file of files.filter((name) => name.endsWith('.json')).sort(byString)) {
        const base = file.replace(/\.json$/, '');
        const dossier = await readJson(join(dir, file));
        out.push({ slug: DOSSIER_SLUGS[base] || base, dossier });
    }
    return out;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help || !flags.run) {
        usage();
        return;
    }

    const issuersFile = flags.issuers || join(REPO_ROOT, 'stocks-issuers.json');
    const dossierDir = flags.dossiers || join(DATA_DIR, 'issuers');
    const partiesFile = flags.parties || join(DATA_DIR, 'canonical-parties.json');
    const venuesFile = flags.venues || join(DATA_DIR, 'venues.json');
    const outFile = flags.out || join(REPO_ROOT, OUT_FILE);

    log(`reading issuer records ${issuersFile}`);
    const issuersDb = await readJson(issuersFile, null);
    const issuers = issuersDb && Array.isArray(issuersDb.issuers) ? issuersDb.issuers : null;
    if (!issuers) {
        throw new Error(`${issuersFile} is missing or has no issuers[] — run "npm run stocks:build" first`);
    }

    const dossiers = await readDossiers(dossierDir);
    const canonicalParties = await readJson(partiesFile, null);
    const venues = await readJson(venuesFile, null);

    log(`${issuers.length} issuer records, ${dossiers.length} dossiers ` +
        `(${dossiers.filter((row) => row.dossier && row.dossier.parties).length} with parties)`);
    if (!canonicalParties) logWarn(`${partiesFile} absent — party nodes carry only what the dossiers say`);
    if (!venues) logWarn(`${venuesFile} absent — no traded-on edges in this build`);

    const graph = buildGraph({ issuers, dossiers, canonicalParties, venues });
    const { venueStats, ...output } = graph;

    const dangling = danglingEdges(output.nodes, output.edges);
    if (dangling.length) {
        logWarn(`${dangling.length} edge(s) point at an unknown node, e.g. ` +
            `${dangling[0].from} -> ${dangling[0].to} (${dangling[0].type})`);
    }

    if (venues) {
        const venueEdges = output.edges.filter((edge) => edge.type === 'traded-on');
        const byVolume = venueEdges.filter((edge) => edge.meta && edge.meta.weightBasis === 'volume').length;
        log(`venues ${venueStats.mintsWithVenues} mints with a venue -> ` +
            `${venueStats.tradedOnEdges} traded-on edges over ${venueStats.venueNodes} venues ` +
            `(${venueStats.dexNodes} dex, ${venueStats.cexNodes} cex); ` +
            `${venueEdges.length - byVolume} weighted by liquidity, ${byVolume} by volume`);
        if (venueStats.skipped.length) {
            const issuersSeen = [...new Set(venueStats.skipped.map((row) => row.issuer || 'no issuer'))].sort(byString);
            logWarn(`${venueStats.skipped.length} venue mint(s) name no known programme ` +
                `(${issuersSeen.join(', ')}) — skipped, e.g. ${venueStats.skipped[0].mint}`);
        }
    }

    await writeJson(outFile, output);

    log(`nodes ${output.nodes.length}: ` +
        Object.entries(countsByType(output.nodes, NODE_TYPE_PRECEDENCE)).map(([k, v]) => `${k} ${v}`).join(', '));
    log(`edges ${output.edges.length}: ` +
        Object.entries(countsByType(output.edges, [...EDGE_TYPES])).map(([k, v]) => `${k} ${v}`).join(', '));
    log(`wrote ${outFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error(`[${ts()}] ERROR`, err.message);
        process.exitCode = 1;
    });
}

export {
    ROLE_EDGES, ROLE_BY_KEY, NODE_TYPE_PRECEDENCE, NODE_TYPES, EDGE_TYPES, DOSSIER_SLUGS,
    LENDING_VENUES, REGISTER_MIRRORED_LEGAL_FORM
};
