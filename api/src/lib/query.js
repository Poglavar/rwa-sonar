// Pure SQL builders and parameter validation for the read-only sonar API. Nothing here touches
// the database or Hono: every function takes parsed query parameters and returns
// `{ text, values }` (or a validated value), so the whole surface is unit-testable without a
// server. User input never reaches the SQL text — filter names, facet names and sort keys are
// looked up in whitelists and only the *values* travel as $n parameters.

/** An error with an HTTP status and a stable machine code; the app renders it as JSON. */
export class ApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
    }
}

export function badRequest(code, message) {
    return new ApiError(400, code, message);
}

export function notFound(message) {
    return new ApiError(404, 'not_found', message);
}

// ---------------------------------------------------------------------------------------------
// Filters. One entry per query-parameter name the token surface accepts. `sql` is the expression
// the filter compares against (already qualified with the aliases of TOKEN_FROM below) and `kind`
// says how the comma-separated values are coerced. These same entries define the facets, so a
// facet and its filter can never drift apart.
//
// `first_seen_day` is written as `(first_seen_at AT TIME ZONE 'UTC')::date` rather than
// date_trunc(): date_trunc's day boundary depends on the session TimeZone, and a facet whose
// buckets move with the server's locale is not a fact about the data.
// ---------------------------------------------------------------------------------------------
export const TOKEN_FROM =
    'FROM sonar.stock_token t\n  LEFT JOIN sonar.stock_issuer i ON i.slug = t.issuer_slug';

export const FILTERS = {
    issuer: { sql: 't.issuer_slug', kind: 'text', extra: { name: 'i.name' } },
    instrument: { sql: 't.instrument_type', kind: 'text' },
    recipe: { sql: 't.recipe_label', kind: 'text' },
    program: { sql: 't.token_program', kind: 'text' },
    health: { sql: 't.health_status', kind: 'text' },
    market_health: { sql: 't.market_health', kind: 'text' },
    control_health: { sql: 't.control_health', kind: 'text' },
    legal_health: { sql: 't.legal_health', kind: 'text' },
    composability_health: { sql: 't.composability_health', kind: 'text' },
    worst_rule: { sql: 't.worst_rule', kind: 'text' },
    reference: { sql: 't.reference_source', kind: 'text' },
    legal_form: { sql: 'i.legal_form', kind: 'text' },
    claim_rung: { sql: 'i.claim_rung', kind: 'int' },
    maturity_stage: { sql: 'i.maturity_stage', kind: 'int' },
    verification_type: { sql: 'i.verification_type', kind: 'text' },
    key_governance_mint: { sql: 'i.key_governance_mint', kind: 'text' },
    key_governance_freeze: { sql: 'i.key_governance_freeze', kind: 'text' },
    jurisdiction: { sql: 'i.entity_jurisdiction', kind: 'text' },
    pausable: { sql: 't.pausable', kind: 'bool' },
    paused: { sql: 't.paused', kind: 'bool' },
    clawback: { sql: 't.clawback', kind: 'bool' },
    allowlist: { sql: 't.allowlist', kind: 'bool' },
    transfer_fee: { sql: '(coalesce(t.transfer_fee_bps, 0) > 0)', kind: 'bool' },
    hook_active: { sql: 't.hook_active', kind: 'bool' },
    seen_in_search: { sql: 't.seen_in_search', kind: 'bool' },
    first_seen_day: { sql: "(t.first_seen_at AT TIME ZONE 'UTC')::date", kind: 'date' }
};

export const FILTER_NAMES = Object.keys(FILTERS);

/** Postgres array cast per filter kind, so an empty array still types correctly. */
const ARRAY_CAST = { text: '::text[]', int: '::int[]', bool: '::bool[]', date: '::date[]' };

/**
 * Health status sorted by SEVERITY, not alphabetically. `t.health_status` alone orders
 * `caution, good, unknown, warning`, which puts the two ends of the scale in the middle and makes
 * the column useless as a sort — the monitor page could not offer it. Unrecognised/unknown values
 * become NULL, and the list query's NULLS LAST keeps "not measured" last in either direction.
 */
export const HEALTH_SEVERITY_ORDER = `CASE t.health_status
      WHEN 'good' THEN 0 WHEN 'caution' THEN 1 WHEN 'warning' THEN 2 END`;

function healthSeverityOrder(column) {
    return `CASE ${column}\n      WHEN 'good' THEN 0 WHEN 'caution' THEN 1 WHEN 'warning' THEN 2 END`;
}

/**
 * Sort keys the token list accepts, mapped to their expressions. `worst_rule`,
 * `venue_spread_pct` and `top1_share_pct` are here because the monitor table shows those columns
 * and could not sort them; every one of them is a real column on sonar.stock_token.
 */
export const TOKEN_SORTS = {
    symbol: 't.symbol',
    usd_price: 't.usd_price',
    liquidity_usd: 't.liquidity_usd',
    volume24_usd: 't.volume24_usd',
    trades24: 't.trades24',
    traders24: 't.traders24',
    premium_pct: 't.premium_pct',
    holder_count: 't.holder_count',
    first_seen_at: 't.first_seen_at',
    last_traded_at: 't.last_traded_at',
    health_status: HEALTH_SEVERITY_ORDER,
    market_health: healthSeverityOrder('t.market_health'),
    control_health: healthSeverityOrder('t.control_health'),
    legal_health: healthSeverityOrder('t.legal_health'),
    composability_health: healthSeverityOrder('t.composability_health'),
    worst_rule: 't.worst_rule',
    venue_spread_pct: 't.venue_spread_pct',
    top1_share_pct: 't.top1_share_pct'
};

export const DEFAULT_SORT = 'liquidity_usd';

/** The slim token row every list endpoint returns. One place, so the shape cannot drift. */
export const SLIM_TOKEN_COLUMNS = `t.mint, t.symbol, t.name, t.issuer_slug,
    i.name AS issuer_name, t.underlying_ticker, t.instrument_type, t.recipe_label,
    t.health_status, t.worst_rule, t.market_health, t.control_health, t.legal_health, t.composability_health,
    t.usd_price, t.liquidity_usd, t.volume24_usd, t.organic_share_pct, t.premium_pct,
    t.venue_spread_pct, t.top1_share_pct,
    (t.record->'market'->>'top10HolderPct')::double precision AS top10_holder_pct,
    t.holder_count, t.trades24, t.traders24, t.last_traded_at, t.first_seen_at,
    t.reference_source, t.reference_price, t.clawback, t.freeze_authority, t.pausable, t.paused,
    t.allowlist, t.transfer_fee_bps, t.hook_active`;

/** The issuer summary the issuer list returns. */
export const ISSUER_SUMMARY_COLUMNS = `i.slug, i.name, i.status, i.legal_form, i.holder_claim,
    i.claim_rung, i.claim_label, i.maturity_stage, i.maturity_score, i.verification_strength,
    i.verification_type, i.key_governance_mint, i.key_governance_freeze,
    i.key_governance_delegate, i.issuing_entity, i.entity_jurisdiction, i.governing_law,
    i.mint_count, i.recipes, i.built_at`;

/**
 * The same summary when it rides along with a token row. Every column is prefixed, because
 * `i.name` and `t.name` both arrive as `name` otherwise and node-postgres keeps the LAST one —
 * so an unaliased join silently reports the issuer's name as the token's.
 */
export const ISSUER_JOINED_COLUMNS = `i.slug AS issuer_slug, i.name AS issuer_name,
    i.status AS issuer_status, i.legal_form, i.holder_claim, i.claim_rung, i.claim_label,
    i.maturity_stage, i.maturity_score, i.verification_strength, i.verification_type`;

// ---------------------------------------------------------------------------------------------
// Value coercion and clamping.
// ---------------------------------------------------------------------------------------------

/**
 * Split a comma list into trimmed, non-empty values. `a,,b` is two values, not three. An ARRAY
 * (one entry per repeated occurrence of the parameter) is taken as one value per occurrence and
 * never split, which is the only way to pass a value that CONTAINS a comma.
 */
export function splitList(raw) {
    if (raw === undefined || raw === null) return [];
    if (Array.isArray(raw)) {
        return raw.length === 1
            ? splitList(raw[0])
            : raw.map((v) => String(v).trim()).filter((v) => v.length > 0);
    }
    return String(raw).split(',').map((v) => v.trim()).filter((v) => v.length > 0);
}

/**
 * The values of one query parameter, applying the three documented forms:
 *   ?x=a,b      one occurrence  -> comma list          (unchanged behaviour)
 *   ?x=a&x=b    repeated        -> one value each, not split
 *   ?x[]=a,b    literal form    -> ONE value, "a,b"
 * The `[]` form exists because six of the nine `jurisdiction` facet values contain a comma, so
 * before it there was no way to filter on them at all — the page listed them and could not offer
 * them. A repeated parameter is not split either: two occurrences are already two values, and
 * splitting them would make `?x=a,b&x=c` mean something different from `?x[]=a,b&x[]=c`.
 */
export function readParamValues(raw, { literal = false } = {}) {
    const occurrences = (Array.isArray(raw) ? raw : [raw])
        .filter((v) => v !== undefined && v !== null)
        .map((v) => String(v));
    if (occurrences.length === 0) return [];
    const values = (!literal && occurrences.length === 1)
        ? occurrences[0].split(',')
        : occurrences;
    return values.map((v) => v.trim()).filter((v) => v.length > 0);
}

const TRUE_WORDS = new Set(['true', 't', '1', 'yes', 'y']);
const FALSE_WORDS = new Set(['false', 'f', '0', 'no', 'n']);

/** Coerce one filter value, rejecting anything the column cannot hold. */
export function coerceValue(name, kind, raw) {
    if (kind === 'text') return raw;
    if (kind === 'bool') {
        const v = raw.toLowerCase();
        if (TRUE_WORDS.has(v)) return true;
        if (FALSE_WORDS.has(v)) return false;
        throw badRequest('bad_filter_value', `${name} must be true or false, got "${raw}"`);
    }
    if (kind === 'int') {
        if (!/^-?\d+$/.test(raw)) {
            throw badRequest('bad_filter_value', `${name} must be an integer, got "${raw}"`);
        }
        return Number(raw);
    }
    if (kind === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
            throw badRequest('bad_filter_value', `${name} must be YYYY-MM-DD, got "${raw}"`);
        }
        return raw;
    }
    throw badRequest('bad_filter_kind', `unknown filter kind ${kind}`);
}

/**
 * Read the recognised filters out of a query object. Unknown parameter names are rejected rather
 * than ignored, because a silently dropped filter returns a *wrong* answer that looks right.
 * `ignore` lists the non-filter parameters a route accepts (q, sort, limit, …).
 */
export function parseFilters(query, ignore = []) {
    return parseFilterEntries(query, FILTERS, ignore);
}

/**
 * The same, for any filter table (the claim, source and change-event surfaces have their own small
 * ones in lib/evidence.js). `query` may be Hono's single-value `c.req.query()` or its multi-value
 * `c.req.queries()`; a `name[]` key is read as the literal form of `name`.
 */
export function parseFilterEntries(query, definitions, ignore = []) {
    const skip = new Set(ignore);
    const known = Object.keys(definitions);
    const filters = {};
    for (const [rawName, raw] of Object.entries(query ?? {})) {
        const literal = rawName.endsWith('[]');
        const name = literal ? rawName.slice(0, -2) : rawName;
        if (skip.has(name)) continue;
        if (!Object.prototype.hasOwnProperty.call(definitions, name)) {
            throw badRequest(
                'unknown_filter',
                `unknown filter "${rawName}"; known filters: ${known.join(', ')}`
            );
        }
        const values = readParamValues(raw, { literal });
        if (values.length === 0) continue;
        filters[name] = [...(filters[name] ?? []), ...values];
    }
    return filters;
}

/** Clamp a limit into [1, max]; anything unparseable falls back to the default. */
export function clampLimit(raw, { def = 50, max = 500 } = {}) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return def;
    if (n < 1) return 1;
    if (n > max) return max;
    return n;
}

/** Clamp an offset to a non-negative integer. */
export function clampOffset(raw) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
}

/** Validate a sort key against the whitelist. Unknown keys are a 400, never a silent default. */
export function parseSort(raw, sorts = TOKEN_SORTS, fallback = DEFAULT_SORT) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (!Object.prototype.hasOwnProperty.call(sorts, raw)) {
        throw badRequest(
            'unknown_sort',
            `unknown sort "${raw}"; sortable: ${Object.keys(sorts).join(', ')}`
        );
    }
    return raw;
}

/** asc | desc, defaulting to desc (the interesting end of every numeric column here). */
export function parseOrder(raw, fallback = 'desc') {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const v = String(raw).toLowerCase();
    if (v !== 'asc' && v !== 'desc') {
        throw badRequest('unknown_order', `order must be asc or desc, got "${raw}"`);
    }
    return v;
}

/** `%`, `_` and `\` are LIKE metacharacters; a user typing one means the literal character. */
export function likePattern(q) {
    return `%${String(q).replace(/([\\%_])/g, '\\$1')}%`;
}

// ---------------------------------------------------------------------------------------------
// WHERE construction. A tiny accumulator keeps $n numbering and the values array in step; every
// builder below shares it, so a parameter can never be numbered by hand.
// ---------------------------------------------------------------------------------------------

export function createParams() {
    const values = [];
    return {
        values,
        /** Append a value and return its placeholder. */
        add(value) {
            values.push(value);
            return `$${values.length}`;
        }
    };
}

/**
 * One filter's condition. A comma list is OR; the literal value `null` means IS NULL, so the
 * null bucket a facet reports back is clickable like any other.
 */
export function filterCondition(name, values, params, definitions = FILTERS) {
    const def = definitions[name];
    if (!def) throw badRequest('unknown_filter', `unknown filter "${name}"`);
    const wantsNull = values.some((v) => v.toLowerCase() === 'null');
    const concrete = [...new Set(values.filter((v) => v.toLowerCase() !== 'null'))]
        .map((v) => coerceValue(name, def.kind, v));
    const parts = [];
    if (concrete.length > 0) {
        parts.push(`${def.sql} = ANY(${params.add(concrete)}${ARRAY_CAST[def.kind]})`);
    }
    if (wantsNull) parts.push(`${def.sql} IS NULL`);
    return `(${parts.join(' OR ')})`;
}

/** Every filter's condition over one table, in a stable (sorted) order. */
export function filterSetConditions(filters, definitions, params) {
    return Object.keys(filters).sort()
        .map((name) => filterCondition(name, filters[name], params, definitions));
}

/**
 * Build the WHERE conditions for a set of filters. `except` is the facet whose own filter must
 * be left out — that omission is the whole of faceted navigation: a facet counts the values you
 * could switch *to*, which means it cannot be narrowed by the value you are already on.
 */
export function filterConditions(filters, params, { except = null, q = null } = {}) {
    const conditions = [];
    for (const name of Object.keys(filters).sort()) {
        if (name === except) continue;
        conditions.push(filterCondition(name, filters[name], params));
    }
    if (q) {
        const p = params.add(likePattern(q));
        conditions.push(
            `(t.symbol ILIKE ${p} OR t.name ILIKE ${p} OR t.mint ILIKE ${p}` +
            ` OR t.underlying_ticker ILIKE ${p})`
        );
    }
    return conditions;
}

/** `WHERE a AND b`, or an empty string when nothing is filtered. */
export function whereClause(conditions) {
    return conditions.length === 0 ? '' : `WHERE ${conditions.join('\n    AND ')}`;
}

// ---------------------------------------------------------------------------------------------
// Statement builders.
// ---------------------------------------------------------------------------------------------

/** `SELECT count(*) AS total` over the tokens matching every filter (and `q`). */
export function buildTokenCountSql(filters, { q = null } = {}) {
    const params = createParams();
    const where = whereClause(filterConditions(filters, params, { q }));
    return {
        text: `SELECT count(*)::int AS total\n  ${TOKEN_FROM}\n  ${where}`.trimEnd(),
        values: params.values
    };
}

/** The slim token list: filters, free-text `q`, whitelisted sort, clamped window. */
export function buildTokenListSql(filters, opts = {}) {
    const { q = null, sort = DEFAULT_SORT, order = 'desc', limit = 50, offset = 0 } = opts;
    const expr = TOKEN_SORTS[sort];
    if (!expr) throw badRequest('unknown_sort', `unknown sort "${sort}"`);
    const params = createParams();
    const where = whereClause(filterConditions(filters, params, { q }));
    // NULLS LAST in both directions: a missing measurement is never the top answer. `t.mint` is
    // the tiebreaker so paging with OFFSET cannot repeat or skip a row between requests.
    const text = `SELECT ${SLIM_TOKEN_COLUMNS}\n  ${TOKEN_FROM}\n  ${where}\n  ` +
        `ORDER BY ${expr} ${order.toUpperCase()} NULLS LAST, t.mint ASC\n  ` +
        `LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}`;
    return { text, values: params.values };
}

/** One token's full record plus its issuer summary and two derived counts. */
export function buildTokenDetailSql(mint) {
    const params = createParams();
    const p = params.add(mint);
    const text = `SELECT t.record, t.mint, t.symbol, t.name, t.health_status, t.worst_rule,
    t.market_health, t.control_health, t.legal_health, t.composability_health,
    t.built_at, t.first_seen_at, t.last_seen_at,
    ${ISSUER_JOINED_COLUMNS},
    (SELECT count(*)::int FROM sonar.stock_token_snapshot s WHERE s.mint = t.mint)
        AS snapshot_dates,
    (SELECT count(*)::int FROM sonar.stock_trade tr WHERE tr.mint = t.mint) AS trades_in_db
  ${TOKEN_FROM}
  WHERE t.mint = ${p}`;
    return { text, values: params.values };
}

/** Snapshot history for one mint, oldest first, typed columns only (never the `row` jsonb). */
export function buildTokenHistorySql(mint, { days = null } = {}) {
    const params = createParams();
    const conditions = [`s.mint = ${params.add(mint)}`];
    if (days !== null) {
        conditions.push(`s.snapshot_date >= (current_date - ${params.add(days)}::int)`);
    }
    const text = `SELECT s.snapshot_date, s.symbol, s.issuer, s.supply_raw, s.ui_multiplier,
    s.paused, s.pausable, s.clawback, s.allowlist, s.transfer_fee_bps, s.hook_active,
    s.liquidity, s.vol24, s.holder_count, s.premium_pct, s.venue_spread_pct, s.top1_share_pct,
    s.top20_share_pct, s.frozen_accounts_top20, s.health, s.worst_rule_id, s.seen_in_search
  FROM sonar.stock_token_snapshot s
  WHERE ${conditions.join(' AND ')}
  ORDER BY s.snapshot_date ASC`;
    return { text, values: params.values };
}

export const TRADE_COLUMNS = `tr.sig, tr."time", tr.mint, tr.symbol, tr.dex, tr.pair, tr.side,
    tr.size, tr.quote_amount, tr.quote_symbol, tr.price_quote, tr.price_usd, tr.fee_payer,
    tr.routed, tr.program_count, tr.suspect`;

/**
 * Trades newest first. Keyset pagination on `("time", sig)` — the table's own index order and the
 * only pair that is unique, so a tape that keeps growing cannot shift rows under a paging client
 * the way OFFSET would. `before` is `{ time, sig }`; sig alone breaks ties inside one second.
 */
export function buildTradesSql({ mint = null, limit = 50, before = null } = {}) {
    const params = createParams();
    const conditions = [];
    if (mint) conditions.push(`tr.mint = ${params.add(mint)}`);
    if (before && before.time) {
        const t = params.add(before.time);
        if (before.sig) {
            conditions.push(`(tr."time", tr.sig) < (${t}::timestamptz, ${params.add(before.sig)})`);
        } else {
            conditions.push(`tr."time" < ${t}::timestamptz`);
        }
    }
    const text = `SELECT ${TRADE_COLUMNS}
  FROM sonar.stock_trade tr
  ${whereClause(conditions)}
  ORDER BY tr."time" DESC, tr.sig DESC
  LIMIT ${params.add(limit)}`;
    return { text, values: params.values };
}

/**
 * Trades per day per dex from the accumulating tape. `volume_usd` sums `size * price_usd`, which
 * skips the trades whose quote leg has no USD price at all; `trades_without_price` is reported
 * beside it so the gap is visible rather than implied.
 */
export function buildDailyTradesSql({ days = 30 } = {}) {
    const params = createParams();
    const p = params.add(days);
    const text = `SELECT (tr."time" AT TIME ZONE 'UTC')::date AS day, tr.dex,
    count(*)::int AS trades,
    sum(tr.size * tr.price_usd) AS volume_usd,
    count(*) FILTER (WHERE tr.price_usd IS NULL)::int AS trades_without_price,
    count(DISTINCT tr.fee_payer)::int AS traders,
    count(DISTINCT tr.mint)::int AS mints,
    count(*) FILTER (WHERE tr.suspect IS NOT NULL)::int AS suspect
  FROM sonar.stock_trade tr
  WHERE tr."time" >= (now() - (${p}::int * interval '1 day'))
  GROUP BY 1, 2
  ORDER BY 1 DESC, trades DESC`;
    return { text, values: params.values };
}

/** Parse `before=<iso>` or `before=<iso>,<sig>` into the keyset cursor. */
export function parseBefore(raw) {
    if (!raw) return null;
    const [time, sig] = String(raw).split(',').map((v) => v.trim());
    if (!time || Number.isNaN(Date.parse(time))) {
        throw badRequest('bad_before', `before must be an ISO timestamp, got "${raw}"`);
    }
    return { time, sig: sig || null };
}

/** `days=` is optional everywhere; absent means "all of it", not zero. */
export function parseDays(raw, { max = 3650 } = {}) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (!/^\d+$/.test(String(raw))) {
        throw badRequest('bad_days', `days must be a positive integer, got "${raw}"`);
    }
    return Math.min(Number(raw), max);
}
