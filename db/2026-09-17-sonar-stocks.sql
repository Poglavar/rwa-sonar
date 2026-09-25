-- Schema `sonar` in the one shared `geodata` database: the tokenized-stocks database that
-- stocks/build-stocks-db.mjs produces as JSON, mirrored into Postgres so it can be grouped,
-- joined and asked questions the static files cannot answer (facets across issuers, snapshot
-- history per day, and a trade table that accumulates past the 24 h window the JSON keeps).
-- Loaded by stocks/load-db.mjs. Idempotent: re-running this file is a no-op.

-- `IF NOT EXISTS` emits a NOTICE per already-present object, which on a re-run is a screenful of
-- noise in the refresh log and nothing else. Quiet only NOTICE; warnings and errors still speak.
SET client_min_messages = warning;

-- Every object must end up owned by `geo_user`. The connecting role (zagreb_user / magician) is
-- a member, so switch to it; if we already ARE geo_user, or are a superuser that is not a member,
-- the guard leaves the session alone rather than failing the whole run.
DO $$
BEGIN
    IF current_user <> 'geo_user' AND pg_has_role(current_user, 'geo_user', 'MEMBER') THEN
        EXECUTE 'SET ROLE geo_user';
    END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS sonar;

COMMENT ON SCHEMA sonar IS
    'RWA Sonar: tokenized-equity issuers, mints, daily snapshots and the live trade tape.';

-- ---------------------------------------------------------------------------------------------
-- Issuers. One row per issuer slug from stocks-issuers.json. The flattened columns are the
-- facets worth grouping by; `record` keeps the whole researched record (sources, findings,
-- attestations, documents, open questions) so nothing is lost by flattening.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.stock_issuer (
    slug                    text PRIMARY KEY,
    name                    text,
    status                  text,
    legal_form              text,
    holder_claim            text,
    claim_rung              int,
    claim_label             text,
    maturity_stage          int,
    maturity_score          int,
    verification_strength   int,
    verification_type       text,
    key_governance_mint     text,
    key_governance_freeze   text,
    key_governance_delegate text,
    issuing_entity          text,
    entity_jurisdiction     text,
    governing_law           text,
    mint_count              int,
    recipes                 jsonb,
    record                  jsonb NOT NULL,
    built_at                timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_issuer_legal_form_idx ON sonar.stock_issuer (legal_form);
CREATE INDEX IF NOT EXISTS stock_issuer_status_idx     ON sonar.stock_issuer (status);
CREATE INDEX IF NOT EXISTS stock_issuer_claim_rung_idx ON sonar.stock_issuer (claim_rung);

-- ---------------------------------------------------------------------------------------------
-- Tokens. One row per mint from stocks-tokens.json, with the per-mint verdict from
-- stocks-health.json folded in (health_status, worst_rule). `record` keeps the full token record.
-- Issuer-level facets (legal form, claim rung, maturity) are reached by joining stock_issuer.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.stock_token (
    mint                  text PRIMARY KEY,
    symbol                text,
    name                  text,
    issuer_slug           text REFERENCES sonar.stock_issuer(slug),
    underlying_ticker     text,
    instrument_type       text,
    token_program         text,
    recipe_label          text,
    recipe_extensions     text[],
    decimals              int,
    supply_raw            numeric,
    ui_multiplier         numeric,
    supply_ui             double precision,
    clawback              bool,
    pausable              bool,
    paused                bool,
    allowlist             bool,
    transfer_fee_bps      int,
    hook_active           bool,
    freeze_authority      text,
    usd_price             double precision,
    liquidity_usd         double precision,
    volume24_usd          double precision,
    holder_count          int,
    organic_share_pct     double precision,
    trades24              int,
    traders24             int,
    trades_per_trader     double precision,
    venue_count           int,
    venue_spread_pct      double precision,
    last_traded_at        timestamptz,
    reference_source      text,
    reference_price       double precision,
    premium_pct           double precision,
    top1_share_pct        double precision,
    top20_share_pct       double precision,
    distinct_owners_top20 int,
    frozen_top20          int,
    health_status         text,
    worst_rule            text,
    market_health         text,
    control_health        text,
    legal_health          text,
    composability_health  text,
    programme_health      text,
    programme_worst_rule  text,
    token_health          text,
    token_worst_rule      text,
    token_checks_passed   int,
    token_checks_judged   int,
    token_health_rank     int,
    first_seen_at         timestamptz,
    last_seen_at          timestamptz,
    seen_in_search        bool,
    record                jsonb NOT NULL,
    built_at              timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_token_issuer_slug_idx     ON sonar.stock_token (issuer_slug);
CREATE INDEX IF NOT EXISTS stock_token_instrument_type_idx ON sonar.stock_token (instrument_type);
CREATE INDEX IF NOT EXISTS stock_token_health_status_idx   ON sonar.stock_token (health_status);
CREATE INDEX IF NOT EXISTS stock_token_recipe_label_idx    ON sonar.stock_token (recipe_label);
-- CREATE TABLE IF NOT EXISTS does not add a new column to an existing installation. Keep this
-- upgrade guard before the index; the dated health-dimensions migration repeats it deliberately.
ALTER TABLE sonar.stock_token ADD COLUMN IF NOT EXISTS composability_health text;
CREATE INDEX IF NOT EXISTS stock_token_composability_health_idx ON sonar.stock_token (composability_health);
CREATE INDEX IF NOT EXISTS stock_token_first_seen_at_idx   ON sonar.stock_token (first_seen_at);
-- 2026-09-25: the headline health split (stocks/lib/health.mjs `levels`) — the programme's verdict,
-- the same for every token of an issuer, and this token's, with the checks it passed of those that
-- could be judged and the rank the monitor sorts by. Same upgrade guard as above.
ALTER TABLE sonar.stock_token ADD COLUMN IF NOT EXISTS programme_health text;
ALTER TABLE sonar.stock_token ADD COLUMN IF NOT EXISTS programme_worst_rule text;
ALTER TABLE sonar.stock_token ADD COLUMN IF NOT EXISTS token_health text;
ALTER TABLE sonar.stock_token ADD COLUMN IF NOT EXISTS token_worst_rule text;
ALTER TABLE sonar.stock_token ADD COLUMN IF NOT EXISTS token_checks_passed int;
ALTER TABLE sonar.stock_token ADD COLUMN IF NOT EXISTS token_checks_judged int;
ALTER TABLE sonar.stock_token ADD COLUMN IF NOT EXISTS token_health_rank int;
CREATE INDEX IF NOT EXISTS stock_token_programme_health_idx ON sonar.stock_token (programme_health);
CREATE INDEX IF NOT EXISTS stock_token_token_health_idx ON sonar.stock_token (token_health);
CREATE INDEX IF NOT EXISTS stock_token_token_worst_rule_idx ON sonar.stock_token (token_worst_rule);
CREATE INDEX IF NOT EXISTS stock_token_token_health_rank_idx ON sonar.stock_token (token_health_rank);

-- ---------------------------------------------------------------------------------------------
-- Daily snapshots. The slim per-day rows written by stocks/snapshot.mjs into
-- stocks/data/history/<date>/tokens.json — one row per (date, mint), so a column can be
-- differenced across days without keeping every full build.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.stock_token_snapshot (
    snapshot_date        date NOT NULL,
    mint                 text NOT NULL,
    symbol               text,
    issuer               text,
    underlying_ticker    text,
    issuer_status        text,
    active               bool,
    supply_raw           numeric,
    supply_ui            double precision,
    ui_multiplier        numeric,
    paused               bool,
    pausable             bool,
    clawback             bool,
    allowlist            bool,
    transfer_fee_bps     int,
    hook_active          bool,
    liquidity            double precision,
    vol24                double precision,
    market_value_usd     double precision,
    holder_count         int,
    premium_pct          double precision,
    venue_spread_pct     double precision,
    top1_share_pct       double precision,
    top20_share_pct      double precision,
    frozen_accounts_top20 int,
    health               text,
    worst_rule_id        text,
    market_health        text,
    control_health       text,
    legal_health         text,
    composability_health text,
    defi_protocol_count  int,
    defi_integration_count int,
    first_seen_at        timestamptz,
    seen_in_search       bool,
    "row"                jsonb NOT NULL,
    built_at             timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (snapshot_date, mint)
);

CREATE INDEX IF NOT EXISTS stock_token_snapshot_mint_idx   ON sonar.stock_token_snapshot (mint);
CREATE INDEX IF NOT EXISTS stock_token_snapshot_issuer_idx ON sonar.stock_token_snapshot (issuer);

-- ---------------------------------------------------------------------------------------------
-- Trades. Loaded from stocks-trades.json `.trades[]`, which is a rolling 24 h window: this
-- table deliberately ACCUMULATES beyond it, which is the point — the tape becomes history.
-- A re-seen signature only ever has `suspect` refreshed (a trade can be re-flagged once its
-- neighbours are known); nothing else about a settled trade can change.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.stock_trade (
    sig           text PRIMARY KEY,
    "time"        timestamptz NOT NULL,
    mint          text,
    symbol        text,
    dex           text,
    pair          text,
    side          text,
    size          double precision,
    quote_amount  double precision,
    quote_symbol  text,
    price_quote   double precision,
    price_usd     double precision,
    fee_payer     text,
    routed        bool,
    program_count int,
    suspect       text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_trade_mint_time_idx ON sonar.stock_trade (mint, "time" DESC);
CREATE INDEX IF NOT EXISTS stock_trade_time_idx      ON sonar.stock_trade ("time");

-- A table created by some other role in an earlier run would silently break the next
-- `CREATE INDEX IF NOT EXISTS` (DDL needs ownership even when the index already exists), so
-- make ownership explicit and idempotent rather than assuming the SET ROLE above did it.
DO $$
DECLARE
    t text;
BEGIN
    IF pg_has_role(current_user, 'geo_user', 'MEMBER') OR current_user = 'geo_user' THEN
        FOREACH t IN ARRAY ARRAY['stock_issuer', 'stock_token', 'stock_token_snapshot', 'stock_trade']
        LOOP
            EXECUTE format('ALTER TABLE sonar.%I OWNER TO geo_user', t);
        END LOOP;
        EXECUTE 'ALTER SCHEMA sonar OWNER TO geo_user';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Examples. The queries this schema exists for; they are also in stocks/README.md.
-- ---------------------------------------------------------------------------------------------
--
-- 1. Mints, liquidity and 24 h volume by issuer.
--
--    SELECT i.slug, i.name, count(*) AS mints,
--           round(sum(t.liquidity_usd)::numeric, 0) AS liquidity_usd,
--           round(sum(t.volume24_usd)::numeric, 0)  AS vol24_usd
--      FROM sonar.stock_token t
--      JOIN sonar.stock_issuer i ON i.slug = t.issuer_slug
--     GROUP BY i.slug, i.name
--     ORDER BY mints DESC;
--
-- 2. Mints by the issuer's legal form (the join is what the issuer facets are for).
--
--    SELECT i.legal_form, i.claim_rung, count(*) AS mints, count(DISTINCT i.slug) AS issuers
--      FROM sonar.stock_token t
--      JOIN sonar.stock_issuer i ON i.slug = t.issuer_slug
--     GROUP BY i.legal_form, i.claim_rung
--     ORDER BY mints DESC;
--
-- 3. Mints by token recipe (program + extensions).
--
--    SELECT coalesce(recipe_label, '(none)') AS recipe, count(*) AS mints,
--           count(DISTINCT issuer_slug) AS issuers
--      FROM sonar.stock_token
--     GROUP BY 1
--     ORDER BY mints DESC;
--
-- 4. Health status crossed with issuer.
--
--    SELECT issuer_slug,
--           count(*) FILTER (WHERE health_status = 'good')    AS good,
--           count(*) FILTER (WHERE health_status = 'caution') AS caution,
--           count(*) FILTER (WHERE health_status = 'warning') AS warning,
--           count(*) AS mints
--      FROM sonar.stock_token
--     GROUP BY issuer_slug
--     ORDER BY warning DESC;
--
-- 5. Mints by instrument type.
--
--    SELECT instrument_type, count(*) AS mints,
--           round(avg(premium_pct)::numeric, 3) AS avg_premium_pct
--      FROM sonar.stock_token
--     GROUP BY instrument_type
--     ORDER BY mints DESC;
--
-- 6. New mints first seen in the last 14 days.
--
--    SELECT first_seen_at::date AS day, count(*) AS new_mints,
--           string_agg(symbol, ', ' ORDER BY symbol) AS symbols
--      FROM sonar.stock_token
--     WHERE first_seen_at >= now() - interval '14 days'
--     GROUP BY 1
--     ORDER BY 1 DESC;
--
-- 7. Trades per day per dex, from the accumulating tape.
--
--    SELECT "time"::date AS day, dex, count(*) AS trades,
--           count(DISTINCT mint) AS mints,
--           count(*) FILTER (WHERE suspect IS NOT NULL) AS suspect
--      FROM sonar.stock_trade
--     GROUP BY 1, 2
--     ORDER BY 1 DESC, trades DESC;
