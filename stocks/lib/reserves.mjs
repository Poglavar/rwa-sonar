// Reserves vs supply ("proof of reserve") for stocks/watch-reserves.mjs: which issuer programmes
// publish a machine-readable reserve figure, the parsers for each source's own payload, and the
// coverage/status rules. No network, no disk, no database: stocks/reserves.test.js covers it with
// saved real payloads (stocks/fixtures/reserves/).
//
// Two comparisons per token, both in units of the underlying share:
//   coverage_issuer = reserve / the issuer's own circulating figure (all chains) — the issuer's
//                     claim about itself, which is what an honest-but-short issuer would reveal;
//   coverage_chain  = reserve / what is outstanding on SOLANA (mint supply − issuer-held wallets,
//                     × the scaled-UI multiplier in force) — a bound the chain proves: a multi-chain
//                     reserve can never be smaller than one chain's outstanding tokens.
// A missing figure stays null through every step (AGENTS.md "null that arithmetic turns into
// zero"): an absent reserve is `unreadable`, never a reserve of 0 and never a shortfall.

import { createHash } from 'node:crypto';

/** Relative slack before a shortfall is called: rounding in the feeds is far below 0.1 %. */
export const SHORTFALL_TOLERANCE = 0.001;

export const STATUSES = ['covered', 'shortfall', 'stale', 'unreadable', 'not-published', 'nothing-outstanding'];

/**
 * What each programme publishes, researched 2026-09-30 (the report in the watcher's usage names
 * the URLs). `access`:
 *   keyless              a public source this watcher reads every run
 *   credentials-required a machine-readable figure exists but needs credentials we do not hold
 *   none                 no machine-readable reserve figure is published (PDFs, claims, nothing)
 * Keys are the catalogue's `issuer` values (stocks-tokens.json).
 */
export const PROGRAMMES = {
    'xstocks-backed': {
        access: 'keyless',
        source: 'xstocks-por-api',
        sourceKind: 'issuer-api',
        url: 'https://api.xstocks.fi/api/v2/public/proof-of-reserves',
        // "Updated daily, or whenever reserve volume changes by more than 10%" (Backed); 72 h lets a
        // weekend pass without calling a live feed stale.
        staleAfterHours: 72,
        note: 'Issuer-served (Backed/xStocks), per symbol: sharesHeld (per custody provider: Alpaca, GTN), all-chain circulatingSupply and its own timestamp. '
            + 'The Chainlink PoR behind it (LedgerLens / The Network Firm, e.g. TSLAx feedId 0x0009f112…a9f2) is a Data Streams (DataLink) report: credentials required, not read.'
    },
    'superstate-opening-bell': {
        access: 'keyless',
        source: 'superstate-instruments-api',
        sourceKind: 'transfer-agent-register',
        url: 'https://api.superstate.com/v2/instruments',
        // The API carries no publish time of its own, so staleness cannot be judged (never invented).
        staleAfterHours: null,
        note: 'SEC-registered transfer agent\'s circulating_supply per instrument (the tokenized part of the register). No per-figure timestamp.'
    },
    tessera: {
        access: 'credentials-required',
        source: 'chainlink-data-streams',
        sourceKind: 'chainlink-por',
        url: 'https://docs.tessera.pe/technicals/proof-of-reserve-por',
        note: 'Chainlink SmartData (DataLink) asset-count streams (tSpaceX feedId 0x00094fe4…daff, tKalshi, tOpenAI): Data Streams API credentials required; data.chain.link sits behind a bot checkpoint.'
    },
    'ondo-global-markets': {
        access: 'none',
        sourceKind: 'daily-verification-agent',
        url: 'https://www.dropbox.com/scl/fo/jzkrw308mrhsasauqrjqq/AJxJak0F90kcwkADSN3DCD4?rlkey=nik1v5slekrzx5fbi0zan5sk3&dl=0',
        note: 'Ankura Trust daily attestation PDFs in a public Dropbox folder; the assets API (app.ondo.finance/api/v2/assets) has no reserve field; Chainlink "Ondo API" feeds are prices only.'
    },
    prestocks: {
        access: 'none',
        sourceKind: 'auditor-attestation',
        url: 'https://prestocks.com/faq',
        note: 'Attestations promised, never published; prestocks.com/api/prestocks gives only the issuer\'s own token supply.'
    },
    'backpack-securities': { access: 'none', sourceKind: 'none', url: null, note: 'No reserve figure, feed or attestation for the equity pool.' },
    securitize: { access: 'none', sourceKind: 'transfer-agent-register', url: null, note: 'Register kept by transfer agents, not public.' },
    bullish: { access: 'none', sourceKind: 'transfer-agent-register', url: 'https://www.bullish.com/us/news-insights/bullish-tokenizes-its-shares-bringing-blsh-onchain', note: 'Equiniti register, not public.' },
    shift: { access: 'none', sourceKind: 'issuer-statement', url: 'https://shiftrwa.gitbook.io/shift_education/shift_learn-4', note: 'Claims a Chainlink PoR feed that does not exist in Chainlink\'s directory.' },
    'remora-markets': { access: 'none', sourceKind: 'none', url: null, note: 'Wound down; "monthly PoR audits" never located.' }
};

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A decimal string or finite number → canonical decimal string; anything else → null (never 0). */
export function decimalOrNull(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return DECIMAL.test(text) ? text : null;
}

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (text) => (text === null || text === undefined ? null : Number(text));

/** ISO timestamp → canonical ISO, or null when absent/unparseable. */
export function isoOrNull(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The xStocks proof-of-reserves payload(s) → Map(symbol → reading). Accepts one page
 * ({nodes, page}) or an array of pages. A symbol listed twice keeps its newest timestamp.
 * Figures stay strings; an unparseable figure is null and the row records why.
 */
export function parseXstocksPor(pages) {
    const list = Array.isArray(pages) ? pages : [pages];
    const out = new Map();
    for (const page of list) {
        if (!page || !Array.isArray(page.nodes)) throw new Error('xStocks proof-of-reserves: expected {nodes:[...]}');
        for (const node of page.nodes) {
            const symbol = typeof node?.symbol === 'string' ? node.symbol : null;
            if (!symbol) continue;
            const reading = {
                symbol,
                sourceTime: isoOrNull(node.timestamp),
                reserve: decimalOrNull(node.sharesHeld),
                issuerCirculating: decimalOrNull(node.circulatingSupply),
                holdings: Array.isArray(node.holdings) ? node.holdings.map((h) => ({
                    provider: h?.provider ?? null, quantity: decimalOrNull(h?.quantity), symbol: h?.symbol ?? null
                })) : []
            };
            const prev = out.get(symbol);
            if (!prev || (reading.sourceTime ?? '') > (prev.sourceTime ?? '')) out.set(symbol, reading);
        }
    }
    return out;
}

/** Whether the paginated xStocks feed has another page (its totalNodes over-counts; hasNextPage does not). */
export function xstocksHasNextPage(page) {
    return page?.page?.hasNextPage === true && Array.isArray(page.nodes) && page.nodes.length > 0;
}

const SUPERSTATE_SOLANA_CHAIN_ID = '900';

/**
 * Superstate's instrument registry (object keyed by ticker) → Map(Solana mint → reading) for the
 * equities. The reserve is the transfer agent's circulating supply (shares, all chains); no
 * publish time exists in the payload, so sourceTime is null. The Solana burn address is where
 * holders send tokens to leave the chain; tokens sitting there are not outstanding.
 */
export function parseSuperstateInstruments(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Superstate instruments: expected an object keyed by ticker');
    const out = new Map();
    for (const instrument of Object.values(json)) {
        if (instrument?.instrument_domain !== 'Equities') continue;
        const mint = instrument.deploy_status_by_chain?.by_chain?.[SUPERSTATE_SOLANA_CHAIN_ID]?.token_address ?? null;
        if (!mint) continue;
        out.set(mint, {
            symbol: instrument.instrument_symbol ?? null,
            sourceTime: null,
            reserve: decimalOrNull(instrument.circulating_supply),
            issuerCirculating: null,
            registerTotal: decimalOrNull(instrument.total_supply),
            splitMultiplier: decimalOrNull(instrument.equity_info?.current_split_multiplier?.multiplier),
            burnAddress: instrument.equity_burn_addresses_by_chain?.[SUPERSTATE_SOLANA_CHAIN_ID] ?? null,
            chains: Object.keys(instrument.deploy_status_by_chain?.by_chain ?? {})
        });
    }
    return out;
}

/**
 * Supply, decimals and the scaled-UI multiplier IN FORCE at `nowSeconds` from one jsonParsed
 * mint account; nulls, never zeros, when the account does not say.
 */
export function mintSupply(account, nowSeconds) {
    const info = account?.data?.parsed?.type === 'mint' ? account.data.parsed.info : null;
    if (!info) return { supplyRaw: null, decimals: null, uiMultiplier: null };
    const scaled = (info.extensions ?? []).find((e) => e?.extension === 'scaledUiAmountConfig')?.state ?? null;
    let uiMultiplier = '1';
    if (scaled) {
        const due = Number(scaled.newMultiplierEffectiveTimestamp);
        uiMultiplier = decimalOrNull(String(Number.isFinite(due) && due > 0 && due <= nowSeconds ? scaled.newMultiplier : scaled.multiplier));
    }
    return {
        supplyRaw: typeof info.supply === 'string' && /^\d+$/.test(info.supply) ? info.supply : null,
        decimals: Number.isInteger(info.decimals) ? info.decimals : null,
        uiMultiplier
    };
}

/**
 * Outstanding on Solana in underlying-share units: (supply − excluded raw) / 10^decimals × multiplier.
 * Null when any input is missing, or when the exclusion exceeds supply (reads straddled a mint/burn).
 */
export function chainOutstanding({ supplyRaw, decimals, uiMultiplier, excludedRaw = '0' }) {
    if (supplyRaw === null || supplyRaw === undefined || !Number.isInteger(decimals) || decimalOrNull(uiMultiplier) === null) return null;
    if (!/^\d+$/.test(String(excludedRaw))) return null;
    const outstanding = BigInt(supplyRaw) - BigInt(excludedRaw);
    if (outstanding < 0n) return null;
    return (Number(outstanding) / 10 ** decimals) * Number(uiMultiplier);
}

function ratio(numerator, denominator) {
    if (!finite(numerator) || !finite(denominator) || denominator <= 0) return null;
    return numerator / denominator;
}

/**
 * The status of one token's reading. Inputs are decimal strings / numbers or null:
 *   reserve            the published figure (shares)
 *   issuerCirculating  the issuer's own circulating figure, all chains (null when not published)
 *   outstanding        Solana outstanding in shares (null when the mint could not be read)
 *   sourceTime         the SOURCE's own time for the figure (null when it publishes none)
 * Priority: shortfall (either comparison) > stale > covered. `stale` is also returned as a flag,
 * so a stale-and-short reading says both.
 */
export function assessReading({ reserve, issuerCirculating = null, outstanding = null, sourceTime = null, now,
    staleAfterHours = null, tolerance = SHORTFALL_TOLERANCE }) {
    const reserveN = num(decimalOrNull(reserve));
    const circN = num(decimalOrNull(issuerCirculating));
    const outN = finite(outstanding) ? outstanding : null;
    const base = { coverageIssuer: null, coverageChain: null, stale: null, shortfallBasis: null, reasons: [] };
    if (reserveN === null) return { ...base, status: 'unreadable', reasons: ['no reserve figure in the source row'] };
    if (circN === null && outN === null) return { ...base, status: 'unreadable', reasons: ['nothing to compare: no issuer circulating figure and no Solana supply'] };

    const nowMs = Date.parse(now);
    let stale = null;
    if (staleAfterHours !== null) {
        const t = sourceTime ? Date.parse(sourceTime) : NaN;
        stale = Number.isFinite(t) ? (nowMs - t) > staleAfterHours * 3600000 : null;
    }
    const coverageIssuer = ratio(reserveN, circN);
    const coverageChain = ratio(reserveN, outN);
    const reasons = [];
    const short = (need) => need > 0 && reserveN < need * (1 - tolerance);
    const issuerShort = circN !== null && short(circN);
    const chainShort = outN !== null && short(outN);
    if (issuerShort) reasons.push(`reserve ${reserveN} < issuer circulating ${circN}`);
    if (chainShort) reasons.push(`reserve ${reserveN} < Solana outstanding ${round(outN, 6)}`);
    if (circN !== null && outN !== null && outN > circN * (1 + tolerance)) {
        reasons.push(`Solana outstanding ${round(outN, 6)} exceeds the issuer's all-chain circulating ${circN}`);
    }
    // `issuer`: the issuer's own figures do not balance (the SpaceX class). `chain`: the reserve
    // is below what one chain proves outstanding — depends on which wallets count as issuer-held.
    const shortfallBasis = issuerShort && chainShort ? 'both' : issuerShort ? 'issuer' : chainShort ? 'chain' : null;
    const out = { coverageIssuer, coverageChain, stale, shortfallBasis, reasons };
    if (shortfallBasis) return { ...out, status: 'shortfall' };
    const nothing = (circN === null || circN === 0) && (outN === null || outN === 0);
    if (stale === true && !nothing) return { ...out, status: 'stale', reasons: [...reasons, `source time ${sourceTime} older than ${staleAfterHours} h`] };
    if (staleAfterHours !== null && stale === null && !nothing) return { ...out, status: 'unreadable', reasons: [...reasons, 'the source row carries no timestamp'] };
    if (nothing) return { ...out, status: 'nothing-outstanding' };
    return { ...out, status: 'covered' };
}

export function round(x, digits = 6) {
    if (!finite(x)) return null;
    const f = 10 ** digits;
    return Math.round(x * f) / f;
}

/**
 * The fields that make two readings "the same reading". A row is inserted only when these differ
 * from the latest stored row for (mint, source); otherwise that row's last_seen_at /
 * latest_source_time move. Times are deliberately NOT part of it: an unchanged figure re-stamped
 * by the source every day is one reading seen for longer.
 */
export function readingHash(row) {
    const parts = [row.status, row.shortfallBasis, row.reserve, row.issuerCirculating, row.supplyRaw, row.excludedRaw, row.uiMultiplier,
        row.stale === null || row.stale === undefined ? '' : String(row.stale)];
    return createHash('sha256').update(parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('\n')).digest('hex');
}

/** Split this run's rows into inserts (new readings) and touches (unchanged since the latest row). */
export function planWrites(rows, latestByKey) {
    const inserts = [];
    const touches = [];
    for (const row of rows) {
        const latest = latestByKey.get(`${row.mint}|${row.source}`);
        if (latest && latest.readingHash === row.readingHash) touches.push({ ...row, id: latest.id });
        else inserts.push({ ...row, previousStatus: latest?.status ?? null });
    }
    return { inserts, touches };
}

/** Status transitions worth an event: into shortfall/stale/unreadable, and back out to covered. */
export function transitions(inserts) {
    const out = [];
    for (const row of inserts) {
        const prev = row.previousStatus;
        // A credentials-only feed is unreadable by construction, not by an event.
        if (prev === row.status || row.detail?.restricted) continue;
        if (['shortfall', 'stale', 'unreadable'].includes(row.status)) out.push({ kind: `reserve-${row.status}`, row, from: prev });
        else if (row.status === 'covered' && ['shortfall', 'stale', 'unreadable'].includes(prev)) out.push({ kind: 'reserve-restored', row, from: prev });
    }
    return out;
}

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const qn = (v) => (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? 'NULL' : String(v));
const qb = (v) => (v === true ? 'true' : v === false ? 'false' : 'NULL');

/** INSERTs for new readings and last_seen UPDATEs for unchanged ones, as one statement list. */
export function buildWriteSql({ inserts, touches }, { seenAt }) {
    const lines = [];
    for (const r of inserts) {
        lines.push('INSERT INTO sonar.reserve_observation (mint, symbol, issuer, source, source_kind, source_url, status, shortfall_basis, stale, '
            + 'reserve, issuer_circulating, source_time, latest_source_time, supply_raw, excluded_raw, decimals, ui_multiplier, '
            + 'chain_outstanding, supply_slot, supply_block_time, coverage_issuer, coverage_chain, reasons, detail, reading_hash, '
            + `first_seen_at, last_seen_at) VALUES (${[q(r.mint), q(r.symbol), q(r.issuer), q(r.source), q(r.sourceKind), q(r.sourceUrl),
                q(r.status), q(r.shortfallBasis), qb(r.stale), qn(r.reserve), qn(r.issuerCirculating), q(r.sourceTime), q(r.sourceTime), qn(r.supplyRaw),
                qn(r.excludedRaw), qn(r.decimals), qn(r.uiMultiplier), qn(r.outstanding), qn(r.supplySlot), q(r.supplyBlockTime),
                qn(r.coverageIssuer), qn(r.coverageChain), `${q(JSON.stringify(r.reasons ?? []))}::jsonb`,
                `${q(JSON.stringify(r.detail ?? {}))}::jsonb`, q(r.readingHash), q(seenAt), q(seenAt)].join(', ')});`);
    }
    for (const r of touches) {
        lines.push(`UPDATE sonar.reserve_observation SET last_seen_at = ${q(seenAt)}, `
            + `latest_source_time = GREATEST(latest_source_time, ${q(r.sourceTime)}::timestamptz), updated_at = now() WHERE id = ${qn(r.id)};`);
    }
    return lines.join('\n');
}

export const LATEST_QUERY = `COPY (SELECT DISTINCT ON (mint, source) id, mint, source, status, reading_hash
    FROM sonar.reserve_observation ORDER BY mint, source, id DESC) TO STDOUT WITH (FORMAT csv)`;

/** psql CSV of LATEST_QUERY → Map("mint|source" → {id, status, readingHash}). */
export function parseLatest(text) {
    const out = new Map();
    for (const line of String(text).split('\n')) {
        if (!line.trim()) continue;
        const [id, mint, source, status, hash] = line.split(',');
        out.set(`${mint}|${source}`, { id: Number(id), status, readingHash: hash });
    }
    return out;
}

/** The single Telegram summary, or null when there is nothing to say. */
export function formatSummary({ rows, failures, restricted, transitionsList, durationMs }) {
    const short = rows.filter((r) => r.status === 'shortfall');
    const stale = rows.filter((r) => r.status === 'stale');
    if (!short.length && !stale.length && !failures.length) return null;
    const lines = [`RWA Sonar reserves watch: ${short.length} shortfall, ${stale.length} stale, ${failures.length} failure(s)`
        + ` · ${rows.length} token(s) · ${(durationMs / 1000).toFixed(0)} s`];
    const newly = new Set(transitionsList.filter((t) => t.kind === 'reserve-shortfall').map((t) => t.row.mint));
    const list = (rs) => `${rs.slice(0, 8).map((r) => `${r.symbol}${newly.has(r.mint) ? ' NEW' : ''} ${fmtRatio(r)}`).join(', ')}${rs.length > 8 ? ', …' : ''}`;
    const byIssuer = short.filter((r) => r.shortfallBasis === 'issuer' || r.shortfallBasis === 'both');
    const byChain = short.filter((r) => r.shortfallBasis === 'chain');
    if (byIssuer.length) lines.push(`Reserve below the issuer's OWN circulating figure: ${list(byIssuer)}`);
    if (byChain.length) lines.push(`Reserve below Solana outstanding (unattributed holders?): ${list(byChain)}`);
    if (stale.length) lines.push(`Stale: ${stale.slice(0, 8).map((r) => `${r.symbol} (${r.sourceTime ?? 'no time'})`).join(', ')}${stale.length > 8 ? ', …' : ''}`);
    if (failures.length) lines.push(`Failures: ${failures.slice(0, 5).join(' | ')}`);
    if (restricted) lines.push(`${restricted} token(s) with a credentials-only feed were not read.`);
    return lines.join('\n');
}

function fmtRatio(r) {
    const parts = [];
    if (finite(r.coverageIssuer)) parts.push(`${(r.coverageIssuer * 100).toFixed(2)}% of issuer circ`);
    if (finite(r.coverageChain)) parts.push(`${(r.coverageChain * 100).toFixed(2)}% of Solana`);
    return parts.length ? `(${parts.join(', ')})` : '';
}
