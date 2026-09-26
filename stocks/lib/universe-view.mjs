// Builds the universe view's data (universe-view/index.json) as tables, so the view can group the
// tokens on any attribute: `tokens` (one row per token with a card, biggest pool first), `values`
// (one row per thing tokens share: a stock, an issuer, a key, a custodian, a protocol, a right's
// status…, each tagged with its attribute), `tokenValues` (which token has which value), and the
// `attributes` and `dimensions` that name and colour them. Which values a token has is decided by
// tokenMoons in universe-view-model.js, from the token's card. Pure: stocks/build-universe-view.mjs
// does the file I/O.

import holderRightsLib from './holder-rights.js';
import model from './universe-view-model.js';
import { COMPOSABILITY_SCENARIOS } from './composability.mjs';
import { HEALTH_RULES } from './health.mjs';

const TOKEN_COLUMNS = ['slug', 'symbol', 'name', 'underlying', 'issuer', 'priceUsd', 'liquidityUsd', 'vol24Usd', 'holderCount', 'status', 'template'];

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function table(columns, rows) {
    return { columns, rows };
}

function issuerOf(issuer, rightsDoc) {
    const rows = holderRightsLib.holderRightsRows(rightsDoc?.issuers?.[issuer.slug] ?? null);
    return {
        slug: issuer.slug,
        name: text(issuer.name) ?? issuer.slug,
        status: text(issuer.status),
        issuingEntity: text(issuer.issuingEntity),
        entityJurisdiction: text(issuer.entityJurisdiction),
        governingLaw: text(issuer.governingLaw),
        regulatoryStatus: text(issuer.regulatoryStatus),
        holderRights: rows.map((row) => ({
            id: row.id, label: row.label, status: row.status, statusLabel: row.statusLabel,
            summary: row.summary, sourceUrl: row.source?.url ?? null
        }))
    };
}

/** address → {kind, threshold, timelock} for every key the power map names (stocks-power-map.json). */
export function keyInfoFromPowerMap(powerMap) {
    const info = new Map();
    for (const issuer of Array.isArray(powerMap?.issuers) ? powerMap.issuers : []) {
        for (const cell of Array.isArray(issuer.cells) ? issuer.cells : []) {
            for (const shown of Array.isArray(cell.addresses?.shown) ? cell.addresses.shown : []) {
                if (!text(shown?.address)) continue;
                // The same address can appear under several powers; merge them so a cell that names the
                // signer threshold or time lock is never hidden by one that does not.
                const known = info.get(shown.address) ?? {};
                info.set(shown.address, {
                    kind: known.kind ?? text(cell.kind),
                    threshold: known.threshold ?? text(cell.signerThreshold),
                    timelock: known.timelock ?? text(cell.timelock?.phrase)
                });
            }
        }
    }
    return info;
}

/** The reviewed DeFi scenario headline and explanation per issuer-plus-control template id. */
function templatesOf(doc) {
    const out = {};
    for (const template of Array.isArray(doc?.templates) ? doc.templates : []) {
        if (!text(template?.id)) continue;
        out[template.id] = Object.fromEntries(COMPOSABILITY_SCENARIOS.map((scenario) => {
            const row = template.scenarios?.[scenario.id] ?? {};
            return [scenario.id, { headline: text(row.headline), explanation: text(row.explanation) }];
        }));
    }
    return out;
}

export function buildUniverseIndex({ tokensDoc, issuersDoc, rightsDoc, templatesDoc, powerMap, cardIndex, cards, generatedAt }) {
    const tokenRows = Array.isArray(tokensDoc?.tokens) ? tokensDoc.tokens : null;
    if (tokenRows === null) throw new Error('universe: stocks-tokens.json has no tokens array');
    if (!Array.isArray(cardIndex)) throw new Error('universe: cards/index.json is not a list (run stocks/build-cards.mjs)');
    if (!(cards instanceof Map)) throw new Error('universe: the token cards were not read');
    const cardByMint = new Map(cardIndex.filter((row) => row?.mint && row?.slug).map((row) => [row.mint, row]));
    const issuers = (Array.isArray(issuersDoc?.issuers) ? issuersDoc.issuers : []).filter((row) => text(row?.slug)).map((row) => issuerOf(row, rightsDoc));
    const issuerBySlug = new Map(issuers.map((issuer) => [issuer.slug, issuer]));
    const keyInfo = keyInfoFromPowerMap(powerMap);
    const ruleLabels = new Map(HEALTH_RULES.map((rule) => [rule.id, rule.label]));

    // Tokens with a card, biggest pool first; a token with no measured pool goes last, never as zero.
    const planets = [];
    for (const token of tokenRows) {
        const entry = cardByMint.get(token?.mint);
        const card = entry ? cards.get(entry.slug) : null;
        if (!entry || !card) continue;
        const market = token.market ?? {};
        planets.push({
            card,
            row: {
                slug: entry.slug, symbol: text(token.symbol) ?? entry.slug, name: text(token.name), underlying: text(token.underlyingTicker),
                issuer: text(token.issuer), priceUsd: finite(market.usdPrice), liquidityUsd: finite(market.liquidity), vol24Usd: finite(market.vol24),
                holderCount: finite(market.holderCount), status: text(card.health?.levels?.token?.status) ?? text(entry.status) ?? 'unknown',
                template: text(card.composability?.id)
            }
        });
    }
    planets.sort((a, b) => (b.row.liquidityUsd ?? -1) - (a.row.liquidityUsd ?? -1) || a.row.symbol.localeCompare(b.row.symbol));

    const values = [];
    const valueIndex = new Map();
    const links = [];
    planets.forEach(({ card, row }, tokenIndex) => {
        const moons = model.tokenMoons(card, { planet: row, issuer: issuerBySlug.get(row.issuer) ?? null, keyInfo, ruleLabels });
        for (const moon of moons) {
            if (!valueIndex.has(moon.id)) {
                valueIndex.set(moon.id, values.length);
                values.push([moon.id, moon.attribute, moon.label, moon.tone]);
            }
            links.push([tokenIndex, valueIndex.get(moon.id)]);
        }
    });

    return {
        generatedAt,
        catalogueBuiltAt: text(tokensDoc.builtAt),
        tables: {
            tokens: table(TOKEN_COLUMNS, planets.map(({ row }) => TOKEN_COLUMNS.map((column) => row[column] ?? null))),
            values: table(['id', 'attribute', 'label', 'tone'], values),
            tokenValues: table(['token', 'value'], links),
            attributes: table(['id', 'dimension', 'label', 'none'], model.ATTRIBUTES.map((a) => [a.id, a.dimension, a.label, a.none])),
            dimensions: table(['id', 'label', 'color'], model.DIMENSIONS.map((d) => [d.id, d.label, d.color]))
        },
        issuers,
        scenarios: COMPOSABILITY_SCENARIOS.map(({ id, label, question }) => ({ id, label, question })),
        templates: templatesOf(templatesDoc),
        ruleLabels: Object.fromEntries(ruleLabels)
    };
}
