// Pure SQL-text builders for stocks/load-db.mjs: each takes one parsed JSON document from the
// stocks pipeline and returns the single `INSERT … ON CONFLICT DO UPDATE` statement that loads it
// into schema `sonar`, with the whole document embedded as one dollar-quoted jsonb literal. No
// database, no filesystem and no npm dependency is involved, so every statement is unit-testable
// as text (see ../db-load.test.js). Two properties matter and are tested: the dollar tag can never
// collide with the document's own bytes, and the ON CONFLICT guard compares every loaded column
// with IS DISTINCT FROM so a re-load of unchanged data does not touch `updated_at`.
//
// The one exception to "no dependency" is the claims section at the bottom, which needs sha1 for
// the deterministic claim id and the shared field-path helpers from ./evidence.mjs. Both are pure
// functions of their arguments, so the statements stay testable as text.

import { createHash } from 'node:crypto';

import { dossierClaims, normaliseField, valueAtPath } from './evidence.mjs';

export const DEFAULT_TAG = 'sonar';

/** Identifiers this schema uses that are reserved words and must be double-quoted. */
const RESERVED = new Set([
    'all', 'and', 'array', 'asc', 'case', 'check', 'column', 'constraint', 'default', 'desc',
    'end', 'from', 'group', 'in', 'is', 'limit', 'not', 'null', 'offset', 'on', 'or', 'order',
    'primary', 'references', 'row', 'select', 'table', 'time', 'true', 'false', 'unique',
    'user', 'when', 'where', 'with'
]);

/** Quote an identifier only when it needs it, so the generated SQL stays readable. */
export function ident(name) {
    if (typeof name !== 'string' || name === '') throw new Error(`bad identifier: ${JSON.stringify(name)}`);
    if (RESERVED.has(name.toLowerCase()) || !/^[a-z_][a-z0-9_]*$/.test(name)) {
        return `"${name.replace(/"/g, '""')}"`;
    }
    return name;
}

/**
 * Choose a dollar-quoting tag that does not occur in `text`. `$sonar$` is the default; if the
 * document itself contains that byte sequence the tag becomes `$sonar1$`, `$sonar2$` … so the
 * literal can never be terminated early by its own content. Throws rather than guessing if a
 * document somehow contains every candidate — a silent wrong tag would be a SQL injection.
 */
export function pickDollarTag(text, base = DEFAULT_TAG) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(base)) throw new Error(`bad dollar tag base: ${base}`);
    for (let i = 0; i <= 999; i += 1) {
        const tag = i === 0 ? base : `${base}${i}`;
        if (!text.includes(`$${tag}$`)) return tag;
    }
    throw new Error(`no safe dollar tag found for base ${base}`);
}

/** Embed a JS value as a dollar-quoted `::jsonb` literal, with a tag proven safe for its bytes. */
export function jsonbLiteral(value, base = DEFAULT_TAG) {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') throw new Error('value is not JSON-serialisable');
    const tag = pickDollarTag(json, base);
    return `$${tag}$${json}$${tag}$::jsonb`;
}

/**
 * Render one upsert. `columns` is an ordered list of [column, sqlExpression]; `update` names the
 * columns a conflicting row may have refreshed. The guard repeats those columns as
 * `tgt.c IS DISTINCT FROM EXCLUDED.c`, which makes the whole statement a no-op — not even an
 * `updated_at` bump — when nothing about the row changed.
 */
export function renderUpsert({ table, alias = 'tgt', ctes = [], from, columns, conflict, update }) {
    if (!columns?.length) throw new Error('renderUpsert needs columns');
    if (!update?.length) throw new Error('renderUpsert needs update columns');
    const known = new Set(columns.map(([c]) => c));
    for (const c of update) if (!known.has(c)) throw new Error(`update column not loaded: ${c}`);

    const with_ = ctes.length ? `WITH ${ctes.join(',\n     ')}\n` : '';
    const colList = columns.map(([c]) => ident(c)).join(', ');
    const selectList = columns.map(([c, expr]) => `       ${expr} AS ${ident(c)}`).join(',\n');
    const setList = [...update.map((c) => `       ${ident(c)} = EXCLUDED.${ident(c)}`),
        '       updated_at = now()'].join(',\n');
    const guard = update.map((c) => `${alias}.${ident(c)} IS DISTINCT FROM EXCLUDED.${ident(c)}`)
        .join('\n        OR ');

    return `${with_}INSERT INTO ${table} AS ${alias} (${colList})\n`
        + `SELECT\n${selectList}\n`
        + `  FROM ${from}\n`
        + `ON CONFLICT (${conflict}) DO UPDATE SET\n${setList}\n`
        + `  WHERE ${guard};\n`;
}

// --- issuers ---------------------------------------------------------------------------------

const ISSUER_COLUMNS = [
    ['slug', "r->>'slug'"],
    ['name', "r->>'name'"],
    ['status', "r->>'status'"],
    ['legal_form', "r->>'legalForm'"],
    ['holder_claim', "r->>'holderClaim'"],
    ['claim_rung', "(r->'grades'->>'claimRung')::int"],
    ['claim_label', "r->'grades'->>'claimLabel'"],
    ['maturity_stage', "(r->'grades'->>'maturityStageNum')::int"],
    ['maturity_score', "(r->'grades'->>'maturityScore')::int"],
    ['verification_strength', "(r->'grades'->>'verificationStrength')::int"],
    ['verification_type', "r->'grades'->>'verificationLabel'"],
    ['key_governance_mint', "r->'keyGovernance'->>'mint'"],
    ['key_governance_freeze', "r->'keyGovernance'->>'freeze'"],
    ['key_governance_delegate', "r->'keyGovernance'->>'delegate'"],
    ['issuing_entity', "r->>'issuingEntity'"],
    ['entity_jurisdiction', "r->>'entityJurisdiction'"],
    ['governing_law', "r->>'governingLaw'"],
    ['mint_count', "CASE WHEN jsonb_typeof(r->'tokenMints') = 'array' THEN jsonb_array_length(r->'tokenMints') ELSE NULL END"],
    ['recipes', "CASE WHEN jsonb_typeof(r->'recipes') = 'array' THEN r->'recipes' ELSE NULL END"],
    ['record', 'r'],
    ['built_at', 'built_at']
];

/** Count distinct values of `key`, which is what the DISTINCT ON in the statement will insert. */
function distinctCount(items, key) {
    const seen = new Set();
    for (const it of items) if (it && it[key] != null) seen.add(String(it[key]));
    return seen.size;
}

export function buildIssuerSql(doc, { tag = DEFAULT_TAG } = {}) {
    const items = Array.isArray(doc?.issuers) ? doc.issuers : [];
    const sql = renderUpsert({
        table: 'sonar.stock_issuer',
        ctes: [
            `doc AS (SELECT ${jsonbLiteral(doc, tag)} AS d)`,
            "src AS (SELECT DISTINCT ON (x.r->>'slug') (d->>'builtAt')::timestamptz AS built_at, x.r"
            + "\n              FROM doc, jsonb_array_elements(d->'issuers') WITH ORDINALITY AS x(r, ord)"
            + "\n             ORDER BY x.r->>'slug', x.ord DESC)"
        ],
        from: 'src',
        columns: ISSUER_COLUMNS,
        conflict: 'slug',
        update: ISSUER_COLUMNS.map(([c]) => c).filter((c) => c !== 'slug')
    });
    return { table: 'sonar.stock_issuer', rows: distinctCount(items, 'slug'), sql };
}

// --- tokens ----------------------------------------------------------------------------------

const TOKEN_COLUMNS = [
    ['mint', "r->>'mint'"],
    ['symbol', "r->>'symbol'"],
    ['name', "r->>'name'"],
    ['issuer_slug', "r->>'issuer'"],
    ['underlying_ticker', "r->>'underlyingTicker'"],
    ['instrument_type', "r->>'instrumentType'"],
    ['token_program', "r->>'tokenProgram'"],
    ['recipe_label', "r->'recipe'->>'label'"],
    ['recipe_extensions', "CASE WHEN jsonb_typeof(r->'recipe'->'extensions') = 'array'"
        + "\n              THEN ARRAY(SELECT jsonb_array_elements_text(r->'recipe'->'extensions')) ELSE NULL END"],
    ['decimals', "(r->>'decimals')::int"],
    ['supply_raw', "(r->>'supplyRaw')::numeric"],
    ['ui_multiplier', "(r->>'uiMultiplier')::numeric"],
    ['supply_ui', "(r->>'supplyUi')::double precision"],
    ['clawback', "(r->'control'->>'clawback')::bool"],
    ['pausable', "(r->'control'->>'pausable')::bool"],
    ['paused', "(r->'control'->>'paused')::bool"],
    ['allowlist', "(r->'control'->>'allowlist')::bool"],
    ['transfer_fee_bps', "(r->'control'->>'transferFeeBps')::int"],
    ['hook_active', "(r->'control'->>'hookActive')::bool"],
    ['freeze_authority', "r->'control'->>'freezeAuthority'"],
    ['usd_price', "(r->'market'->>'usdPrice')::double precision"],
    ['liquidity_usd', "(r->'market'->>'liquidity')::double precision"],
    ['volume24_usd', "(r->'market'->>'vol24')::double precision"],
    ['holder_count', "(r->'market'->>'holderCount')::int"],
    ['organic_share_pct', "(r->'market'->>'organicSharePct')::double precision"],
    ['trades24', "(r->'activity'->>'trades24')::int"],
    ['traders24', "(r->'activity'->>'traders24')::int"],
    ['trades_per_trader', "(r->'activity'->>'tradesPerTrader')::double precision"],
    ['venue_count', "(r->'activity'->>'venueCount')::int"],
    ['venue_spread_pct', "(r->'activity'->>'venueSpreadPct')::double precision"],
    ['last_traded_at', "(r->'activity'->>'lastTradedAt')::timestamptz"],
    ['reference_source', "r->'reference'->>'source'"],
    ['reference_price', "(r->'reference'->>'price')::double precision"],
    ['premium_pct', "(r->'reference'->>'premiumPct')::double precision"],
    ['top1_share_pct', "(r->'holders'->>'top1SharePct')::double precision"],
    ['top20_share_pct', "(r->'holders'->>'top20SharePct')::double precision"],
    ['distinct_owners_top20', "(r->'holders'->>'distinctOwnersTop20')::int"],
    ['frozen_top20', "(r->'holders'->>'frozenAccountsTop20')::int"],
    ['health_status', 'health.status'],
    ['worst_rule', 'health.worst_rule'],
    ['first_seen_at', "(r->>'firstSeenAt')::timestamptz"],
    ['last_seen_at', "(r->>'lastSeenAt')::timestamptz"],
    ['seen_in_search', "(r->>'seenInSearch')::bool"],
    ['record', 'r'],
    ['built_at', 'built_at']
];

/**
 * Tokens carry their per-mint verdict from a second document (stocks-health.json), so both are
 * embedded and joined inside the one statement — the health verdict is optional, hence LEFT JOIN.
 */
export function buildTokenSql({ tokensDoc, healthDoc = null }, { tag = DEFAULT_TAG } = {}) {
    const items = Array.isArray(tokensDoc?.tokens) ? tokensDoc.tokens : [];
    const health = healthDoc && Array.isArray(healthDoc.items) ? healthDoc : { items: [] };
    const sql = renderUpsert({
        table: 'sonar.stock_token',
        ctes: [
            `doc AS (SELECT ${jsonbLiteral(tokensDoc, tag)} AS d)`,
            `health_doc AS (SELECT ${jsonbLiteral(health, tag)} AS h)`,
            "health AS (SELECT DISTINCT ON (x.r->>'mint') x.r->>'mint' AS mint, x.r->>'status' AS status,"
            + "\n                  x.r->>'worstRuleId' AS worst_rule"
            + "\n             FROM health_doc, jsonb_array_elements(h->'items') WITH ORDINALITY AS x(r, ord)"
            + "\n            ORDER BY x.r->>'mint', x.ord DESC)",
            "src AS (SELECT DISTINCT ON (x.r->>'mint') (d->>'builtAt')::timestamptz AS built_at, x.r"
            + "\n              FROM doc, jsonb_array_elements(d->'tokens') WITH ORDINALITY AS x(r, ord)"
            + "\n             ORDER BY x.r->>'mint', x.ord DESC)"
        ],
        from: "src LEFT JOIN health ON health.mint = src.r->>'mint'",
        columns: TOKEN_COLUMNS,
        conflict: 'mint',
        update: TOKEN_COLUMNS.map(([c]) => c).filter((c) => c !== 'mint')
    });
    return { table: 'sonar.stock_token', rows: distinctCount(items, 'mint'), sql };
}

// --- daily snapshots -------------------------------------------------------------------------

const SNAPSHOT_COLUMNS = [
    ['snapshot_date', 'snapshot_date'],
    ['mint', "r->>'mint'"],
    ['symbol', "r->>'symbol'"],
    ['issuer', "r->>'issuer'"],
    ['supply_raw', "(r->>'supplyRaw')::numeric"],
    ['ui_multiplier', "(r->>'uiMultiplier')::numeric"],
    ['paused', "(r->>'paused')::bool"],
    ['pausable', "(r->>'pausable')::bool"],
    ['clawback', "(r->>'clawback')::bool"],
    ['allowlist', "(r->>'allowlist')::bool"],
    ['transfer_fee_bps', "(r->>'transferFeeBps')::int"],
    ['hook_active', "(r->>'hookActive')::bool"],
    ['liquidity', "(r->>'liquidity')::double precision"],
    ['vol24', "(r->>'vol24')::double precision"],
    ['holder_count', "(r->>'holderCount')::int"],
    ['premium_pct', "(r->>'premiumPct')::double precision"],
    ['venue_spread_pct', "(r->>'venueSpreadPct')::double precision"],
    ['top1_share_pct', "(r->>'top1SharePct')::double precision"],
    ['top20_share_pct', "(r->>'top20SharePct')::double precision"],
    ['frozen_accounts_top20', "(r->>'frozenAccountsTop20')::int"],
    ['health', "r->>'health'"],
    ['worst_rule_id', "r->>'worstRuleId'"],
    ['first_seen_at', "(r->>'firstSeenAt')::timestamptz"],
    ['seen_in_search', "(r->>'seenInSearch')::bool"],
    ['row', 'r'],
    ['built_at', 'built_at']
];

/** One statement per history directory; the date comes from the document, never from the clock. */
export function buildSnapshotSql(doc, { tag = DEFAULT_TAG } = {}) {
    const items = Array.isArray(doc?.items) ? doc.items : [];
    if (!doc?.date) throw new Error('snapshot document has no `date`');
    const sql = renderUpsert({
        table: 'sonar.stock_token_snapshot',
        ctes: [
            `doc AS (SELECT ${jsonbLiteral(doc, tag)} AS d)`,
            "src AS (SELECT DISTINCT ON (x.r->>'mint') (d->>'date')::date AS snapshot_date,"
            + "\n                    (d->>'builtAt')::timestamptz AS built_at, x.r"
            + "\n              FROM doc, jsonb_array_elements(d->'items') WITH ORDINALITY AS x(r, ord)"
            + "\n             ORDER BY x.r->>'mint', x.ord DESC)"
        ],
        from: 'src',
        columns: SNAPSHOT_COLUMNS,
        conflict: 'snapshot_date, mint',
        update: SNAPSHOT_COLUMNS.map(([c]) => c).filter((c) => c !== 'snapshot_date' && c !== 'mint')
    });
    return { table: 'sonar.stock_token_snapshot', date: doc.date, rows: distinctCount(items, 'mint'), sql };
}

// --- trades ----------------------------------------------------------------------------------

const TRADE_COLUMNS = [
    ['sig', "r->>'sig'"],
    ['time', "(r->>'time')::timestamptz"],
    ['mint', "r->>'mint'"],
    ['symbol', "r->>'symbol'"],
    ['dex', "r->>'dex'"],
    ['pair', "r->>'pair'"],
    ['side', "r->>'side'"],
    ['size', "(r->>'size')::double precision"],
    ['quote_amount', "(r->>'quoteAmount')::double precision"],
    ['quote_symbol', "r->>'quoteSymbol'"],
    ['price_quote', "(r->>'priceQuote')::double precision"],
    ['price_usd', "(r->>'priceUsd')::double precision"],
    ['fee_payer', "r->>'feePayer'"],
    ['routed', "(r->>'routed')::bool"],
    ['program_count', "(r->>'programCount')::int"],
    ['suspect', "r->>'suspect'"]
];

/**
 * The trade tape is a rolling 24 h file loaded into a table that deliberately accumulates past
 * that window, so a settled trade is never rewritten: only `suspect` may be refreshed, because a
 * trade can be re-flagged once its neighbours are known. Rows with no `time` are skipped rather
 * than given an invented one — the column is NOT NULL for that reason.
 */
export function buildTradeSql(doc, { tag = DEFAULT_TAG } = {}) {
    const all = Array.isArray(doc?.trades) ? doc.trades : [];
    const usable = all.filter((t) => t && typeof t.sig === 'string' && typeof t.time === 'string');
    const sql = renderUpsert({
        table: 'sonar.stock_trade',
        ctes: [
            `doc AS (SELECT ${jsonbLiteral(doc, tag)} AS d)`,
            "src AS (SELECT DISTINCT ON (x.r->>'sig') x.r"
            + "\n              FROM doc, jsonb_array_elements(d->'trades') WITH ORDINALITY AS x(r, ord)"
            + "\n             WHERE x.r->>'sig' IS NOT NULL AND x.r->>'time' IS NOT NULL"
            + "\n             ORDER BY x.r->>'sig', x.ord DESC)"
        ],
        from: 'src',
        columns: TRADE_COLUMNS,
        conflict: 'sig',
        update: ['suspect']
    });
    return {
        table: 'sonar.stock_trade',
        rows: distinctCount(usable, 'sig'),
        skipped: all.length - usable.length,
        sql
    };
}

/** Wrap statements in one explicit transaction, so a table either loads whole or not at all. */
export function wrapTransaction(statements) {
    const list = Array.isArray(statements) ? statements : [statements];
    return `BEGIN;\n${list.join('\n')}\nCOMMIT;\n`;
}

// --- claims ----------------------------------------------------------------------------------

const CLAIM_COLUMNS = [
    ['id', "r->>'id'"],
    ['subject_type', "r->>'subjectType'"],
    ['subject_id', "r->>'subjectId'"],
    ['issuer_slug', "r->>'issuerSlug'"],
    ['field', "r->>'field'"],
    // A JSON null must land as SQL NULL, not as the jsonb literal `null` — otherwise "no value at
    // that path" and "the value is null" become indistinguishable in the column.
    ['value', "NULLIF(r->'value', 'null'::jsonb)"],
    ['quote', "r->>'quote'"],
    ['url', "r->>'url'"],
    // Resolved by EXACT url against the source registry, inside the same statement, so a claim
    // never carries a source id the registry does not have. No match leaves it null: the URL is
    // still on the row, and extract-sources.mjs can register it later.
    ['source_id', 's.id'],
    ['locator', "r->>'locator'"],
    ['recorded_at', 'now()'],
    ['accessed_at', "(r->>'accessedAt')::timestamptz"],
    ['last_checked_at', "(r->>'accessedAt')::timestamptz"],
    ['last_confirmed_at',
        "CASE WHEN r->>'status' = 'confirmed' THEN (r->>'accessedAt')::timestamptz ELSE NULL END"],
    ['status', "r->>'status'"],
    ['method', "r->>'method'"],
    ['note', "r->>'note'"]
];

/**
 * The columns the loader must NOT refresh on a re-load:
 *  - `recorded_at` is when we FIRST wrote the claim, so a second load must not move it;
 *  - `last_checked_at` and `last_confirmed_at` belong to stocks/watch-sources.mjs, which measures
 *    them by actually re-reading the source. Seeding them from `accessedAt` on insert is the
 *    researcher's own reading; overwriting a watcher's later reading with that older value would
 *    make a stale claim look freshly checked.
 */
const CLAIM_INSERT_ONLY = new Set(['id', 'recorded_at', 'last_checked_at', 'last_confirmed_at']);

/** `<issuer_slug>:<field>:<first 8 hex of sha1(url|quote)>` — see db/2026-09-18-sonar-claims.sql. */
export function claimId(issuerSlug, field, url, quote) {
    const slug = typeof issuerSlug === 'string' ? issuerSlug : '';
    const path = normaliseField(field);
    const digest = createHash('sha1')
        .update(`${typeof url === 'string' ? url : ''}|${typeof quote === 'string' ? quote : ''}`)
        .digest('hex')
        .slice(0, 8);
    return `${slug}:${path}:${digest}`;
}

/**
 * Every claim row one dossier produces: its own `claims[]` plus the quote-bearing findings,
 * incidents and attestations (lib/evidence.js decides what counts), each with its deterministic
 * id, the dossier's value at that field path, and the method derived from the locator. A dossier
 * with no `claims` array yields the quoted entries and no error — the research pass fills that
 * array issuer by issuer, and a partial pass must load rather than fail.
 */
export function claimRowsForDossier(slug, dossier) {
    return dossierClaims(slug, dossier).map((claim) => ({
        id: claimId(slug, claim.field, claim.url, claim.quote),
        subjectType: claim.subjectType,
        subjectId: claim.subjectId,
        issuerSlug: claim.issuerSlug,
        field: claim.field,
        value: valueAtPath(dossier, claim.field),
        quote: claim.quote,
        url: claim.url,
        locator: claim.locator,
        accessedAt: claim.accessedAt,
        status: claim.status,
        method: claim.method,
        note: claim.note
    }));
}

/** The same over many dossiers, sorted by id so a rebuild embeds byte-identical SQL. */
export function claimRows(dossiers) {
    const rows = [];
    for (const entry of Array.isArray(dossiers) ? dossiers : []) {
        if (!entry || typeof entry.slug !== 'string') continue;
        rows.push(...claimRowsForDossier(entry.slug, entry.dossier));
    }
    return rows.sort((a, b) => byStringId(a.id, b.id));
}

function byStringId(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/**
 * Claims in the table for these issuers that this run did NOT offer. A claim id is content-
 * addressed (`<slug>:<field>:<sha1 of url|quote>`), so EDITING a quote or a URL produces a new
 * row and leaves the old one behind: the first real load left exactly one such orphan. This is a
 * SELECT and never a DELETE — EVIDENCE.md is explicit that a claim whose words have moved becomes
 * `changed` for a human to decide, not something a loader quietly removes — but an orphan nobody
 * is told about is how a stale quote survives in the API for months, so the run reports them.
 */
export function buildClaimOrphanSql(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const ids = [...new Set(list.map((r) => r.id).filter((id) => typeof id === 'string'))];
    const slugs = [...new Set(list.map((r) => r.issuerSlug).filter((s) => typeof s === 'string'))];
    const text = `WITH offered AS (SELECT jsonb_array_elements_text(${jsonbLiteral(ids)}) AS id),
     loaded AS (SELECT jsonb_array_elements_text(${jsonbLiteral(slugs)}) AS slug)
SELECT c.issuer_slug, count(*)::int AS orphans, min(c.recorded_at)::date AS oldest
  FROM sonar.claim c
 WHERE c.issuer_slug IN (SELECT slug FROM loaded)
   AND c.id NOT IN (SELECT id FROM offered)
 GROUP BY 1
 ORDER BY 2 DESC;
`;
    return { text, ids: ids.length, slugs: slugs.length };
}

/**
 * One statement for every claim. `source_id` is resolved by exact URL against sonar.source in the
 * same statement (LEFT JOIN, so an unregistered URL keeps the claim), and the ON CONFLICT guard is
 * the usual IS DISTINCT FROM list, so re-loading unchanged dossiers touches nothing.
 */
export function buildClaimSql(rows, { tag = DEFAULT_TAG, builtAt = null } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const doc = { builtAt, claims: list };
    const sql = renderUpsert({
        table: 'sonar.claim',
        ctes: [
            `doc AS (SELECT ${jsonbLiteral(doc, tag)} AS d)`,
            "src AS (SELECT DISTINCT ON (x.r->>'id') x.r"
            + "\n              FROM doc, jsonb_array_elements(d->'claims') WITH ORDINALITY AS x(r, ord)"
            + "\n             WHERE x.r->>'id' IS NOT NULL"
            + "\n             ORDER BY x.r->>'id', x.ord DESC)"
        ],
        from: "src LEFT JOIN sonar.source s ON s.url = src.r->>'url'",
        columns: CLAIM_COLUMNS,
        conflict: 'id',
        update: CLAIM_COLUMNS.map(([c]) => c).filter((c) => !CLAIM_INSERT_ONLY.has(c))
    });
    return { table: 'sonar.claim', rows: distinctCount(list, 'id'), sql };
}

// --- what-if ---------------------------------------------------------------------------------

const FAILURE_MODE_COLUMNS = [
    ['id', "r->>'id'"],
    ['actor', "r->>'actor'"],
    ['flow', "r->>'flow'"],
    ['question', "r->>'question'"],
    ['look_for', "r->>'lookFor'"],
    ['ord', "(r->>'ord')::int"]
];

/**
 * The shared catalogue of failure modes (stocks/data/trust-chain.json `failureModes`) as one
 * upsert. `ord` is the mode's position in the FILE, which is the display order everywhere: the
 * file groups the modes by actor, and an id sort would scatter that grouping. It is taken from the
 * array index rather than from a hand-written field, so it can never disagree with the file.
 */
export function buildFailureModeSql(catalogue, { tag = DEFAULT_TAG } = {}) {
    const modes = Array.isArray(catalogue?.failureModes) ? catalogue.failureModes : [];
    const rows = modes
        .filter((mode) => mode && typeof mode.id === 'string' && mode.id.trim() !== '')
        .map((mode, index) => ({
            id: mode.id.trim(),
            actor: mode.actor ?? null,
            flow: mode.flow ?? null,
            question: mode.question ?? null,
            lookFor: mode.lookFor ?? null,
            ord: index
        }));
    const sql = renderUpsert({
        table: 'sonar.failure_mode',
        ctes: [
            `doc AS (SELECT ${jsonbLiteral({ modes: rows }, tag)} AS d)`,
            "src AS (SELECT DISTINCT ON (x.r->>'id') x.r"
            + "\n              FROM doc, jsonb_array_elements(d->'modes') WITH ORDINALITY AS x(r, ord)"
            + "\n             ORDER BY x.r->>'id', x.ord DESC)"
        ],
        from: 'src',
        columns: FAILURE_MODE_COLUMNS,
        conflict: 'id',
        update: FAILURE_MODE_COLUMNS.map(([c]) => c).filter((c) => c !== 'id')
    });
    return { table: 'sonar.failure_mode', rows: distinctCount(rows, 'id'), sql };
}

const WHAT_IF_COLUMNS = [
    ['id', "r->>'id'"],
    ['issuer_slug', "r->>'issuerSlug'"],
    ['mode_id', "r->>'mode'"],
    ['status', "r->>'status'"],
    ['outcome', "r->>'outcome'"],
    ['quote', "r->>'quote'"],
    ['url', "r->>'url'"],
    // Resolved by EXACT url against the source registry, inside the same statement, so an answer
    // never carries a source id the registry does not have. No match leaves it null: the URL is
    // still on the row, and extract-sources.mjs can register it later.
    ['source_id', 's.id'],
    ['locator', "r->>'locator'"],
    ['accessed_at', "(r->>'accessedAt')::timestamptz"],
    // `cases` and `searched` are NOT NULL arrays in the table, so an absent or non-array value
    // becomes `[]` here rather than a SQL NULL the constraint would reject.
    ['cases', "CASE WHEN jsonb_typeof(r->'cases') = 'array' THEN r->'cases' ELSE '[]'::jsonb END"],
    ['searched', "CASE WHEN jsonb_typeof(r->'searched') = 'array' THEN r->'searched' ELSE '[]'::jsonb END"],
    ['note', "r->>'note'"]
];

/** `<issuer_slug>:<mode>` — see db/2026-09-18-sonar-whatif.sql. */
export function whatIfId(issuerSlug, mode) {
    return `${typeof issuerSlug === 'string' ? issuerSlug : ''}:${typeof mode === 'string' ? mode : ''}`;
}

/**
 * Every what_if row one dossier offers. A dossier with no `whatIf` array yields nothing and no
 * error — the research pass fills it issuer by issuer, and a partial pass must load, not fail.
 * An entry with no `mode` is DROPPED (the row would have no primary key and no mode to join to)
 * and counted, so the loader can say how many were dropped rather than losing them silently.
 *
 * Nothing here judges an answer: stocks/lib/trustchain.js `validateWhatIf()` does that, the test
 * suite runs it over every real dossier, and the table's own CHECK constraints are the last line.
 */
export function whatIfRowsForDossier(slug, dossier) {
    const entries = Array.isArray(dossier?.whatIf) ? dossier.whatIf : [];
    const rows = [];
    let dropped = 0;
    for (const entry of entries) {
        const mode = typeof entry?.mode === 'string' && entry.mode.trim() !== '' ? entry.mode.trim() : null;
        if (mode === null) {
            dropped += 1;
            continue;
        }
        rows.push({
            id: whatIfId(slug, mode),
            issuerSlug: slug,
            mode,
            status: entry.status ?? null,
            outcome: entry.outcome ?? null,
            quote: entry.quote ?? null,
            url: entry.url ?? null,
            locator: entry.locator ?? null,
            accessedAt: entry.accessedAt ?? null,
            cases: Array.isArray(entry.cases) ? entry.cases : [],
            searched: Array.isArray(entry.searched) ? entry.searched : [],
            note: entry.note ?? null
        });
    }
    return { rows, dropped };
}

/** The same over many dossiers, sorted by id so a rebuild embeds byte-identical SQL. */
export function whatIfRows(dossiers) {
    const rows = [];
    let dropped = 0;
    for (const entry of Array.isArray(dossiers) ? dossiers : []) {
        if (!entry || typeof entry.slug !== 'string') continue;
        const built = whatIfRowsForDossier(entry.slug, entry.dossier);
        rows.push(...built.rows);
        dropped += built.dropped;
    }
    return { rows: rows.sort((a, b) => byStringId(a.id, b.id)), dropped };
}

/** One statement for every answer, `source_id` resolved by exact URL against sonar.source. */
export function buildWhatIfSql(rows, { tag = DEFAULT_TAG, builtAt = null } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const doc = { builtAt, whatIf: list };
    const sql = renderUpsert({
        table: 'sonar.what_if',
        ctes: [
            `doc AS (SELECT ${jsonbLiteral(doc, tag)} AS d)`,
            "src AS (SELECT DISTINCT ON (x.r->>'id') x.r"
            + "\n              FROM doc, jsonb_array_elements(d->'whatIf') WITH ORDINALITY AS x(r, ord)"
            + "\n             WHERE x.r->>'id' IS NOT NULL"
            + "\n             ORDER BY x.r->>'id', x.ord DESC)"
        ],
        from: "src LEFT JOIN sonar.source s ON s.url = src.r->>'url'",
        columns: WHAT_IF_COLUMNS,
        conflict: 'id',
        update: WHAT_IF_COLUMNS.map(([c]) => c).filter((c) => c !== 'id')
    });
    return { table: 'sonar.what_if', rows: distinctCount(list, 'id'), sql };
}

/**
 * Answers in the table that this run's dossiers no longer offer, DELETED — and here a delete is
 * right, where the claim loader only reports orphans. The difference is the id: a claim id is
 * content-addressed, so editing a quote leaves a stale row that still records something a human
 * must judge; a what_if id is `<issuer>:<mode>`, so the only way a row becomes unoffered is the
 * researcher having REMOVED that answer from the dossier. Keeping it would serve a withdrawn
 * answer from the API for ever, which is the opposite of the evidence discipline.
 *
 * Scoped to the issuers this run actually loaded (`--only=whatif` over a directory holding one
 * dossier must not wipe every other issuer's answers) and to the modes that issuer still offers.
 */
export function buildWhatIfDeleteSql(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const ids = [...new Set(list.map((r) => r.id).filter((id) => typeof id === 'string'))].sort();
    const slugs = [...new Set(list.map((r) => r.issuerSlug).filter((s) => typeof s === 'string'))].sort();
    const text = `WITH offered AS (SELECT jsonb_array_elements_text(${jsonbLiteral(ids)}) AS id),
     loaded AS (SELECT jsonb_array_elements_text(${jsonbLiteral(slugs)}) AS slug)
DELETE FROM sonar.what_if w
 WHERE w.issuer_slug IN (SELECT slug FROM loaded)
   AND w.id NOT IN (SELECT id FROM offered)
RETURNING w.issuer_slug, w.mode_id;
`;
    return { text, ids: ids.length, slugs: slugs.length };
}
