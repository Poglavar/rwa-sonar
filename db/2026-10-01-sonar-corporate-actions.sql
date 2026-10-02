-- The corporate-action reconciliation watcher's tables in schema `sonar`
-- (stocks/watch-corporate-actions.mjs, daily): the underlying stocks' splits and cash dividends as
-- the source lists them, and one verdict per (mint, action) or per unexplained multiplier step —
-- did the programme's Token-2022 scaled-UI multiplier move as the corporate action requires, on
-- time and by the right ratio, and does every multiplier move have a corporate action behind it?
--
-- Time columns are the sources' own: `event_at` is the source's event time (Yahoo: the exchange
-- open on the ex-date), `step_at` the mint's own newMultiplierEffectiveTimestamp. An update read
-- without a timestamp has `step_at` NULL and sits between `step_window_from` and `step_window_to`
-- (two chain-watcher readings). `fetched_at` and `checked_at` are ours and say so.
--
-- A NULL ratio, price, close or coverage bound means unknown, never 1 or 0: such a check carries
-- verdict `no-coverage`, `pending` or `unverifiable`, never `matched` or `missing`.
--
-- Idempotent: re-running this file is a no-op.

SET client_min_messages = warning;

DO $$
BEGIN
    IF current_user <> 'geo_user' AND pg_has_role(current_user, 'geo_user', 'MEMBER') THEN
        EXECUTE 'SET ROLE geo_user';
    END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS sonar;

-- ---------------------------------------------------------------------------------------------
-- One row per split or cash dividend of an underlying, keyed by the symbol the source lists it
-- under (0700.HK, LGEN.L, BRK-B). `ticker` is our underlyingTicker. A dividend carries the last
-- close strictly before its ex-date (`reference_close`, in the listing's currency, split-adjusted
-- like the amount) — the price the expected reinvestment is sized with; NULL when the source has
-- no bar before the ex-date.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.corporate_action (
    source_symbol        text NOT NULL,
    kind                 text NOT NULL,
    ex_date              date NOT NULL,
    ticker               text,
    event_at             timestamptz NOT NULL,
    amount               numeric,
    currency             text,
    split_numerator      numeric,
    split_denominator    numeric,
    reference_close      numeric,
    reference_close_date date,
    source               text NOT NULL,
    source_url           text,
    fetched_at           timestamptz NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT corporate_action_pkey PRIMARY KEY (source_symbol, kind, ex_date),
    CONSTRAINT corporate_action_kind_check CHECK (kind IN ('split', 'dividend')),
    CONSTRAINT corporate_action_shape_check CHECK (
        (kind = 'dividend' AND amount > 0) OR (kind = 'split' AND split_numerator > 0 AND split_denominator > 0))
);

CREATE INDEX IF NOT EXISTS corporate_action_ticker_idx ON sonar.corporate_action (ticker, ex_date DESC);

-- ---------------------------------------------------------------------------------------------
-- One verdict per mint per check. `check_key` is `<kind>:<source_symbol>:<ex_date>` for a
-- corporate action and `step:<effective time>:<new multiplier>` for a multiplier step no action
-- explains. Verdicts:
--   matched       a step of the expected ratio took effect within [ex − 2 d, ex + 3 d]
--   late          …of the expected ratio, but after ex + 3 d (up to ex + 45 d); lag_days says how late
--   wrong-ratio   a step on time whose ratio is outside the tolerance (net_fraction for a dividend)
--   missing       the programme says it passes the action through, the mint was read throughout the
--                 window, and no update took effect
--   pending       the on-time window has not closed within our readings yet
--   no-coverage   the mint's multiplier history does not reach back to the action (coverage_from)
--   unverifiable  an update on time whose size cannot be tested (no close, or its prior value unread)
--   unexplained   a multiplier step with no split or dividend of the underlying to explain it
-- `expected_on_chain` is what the programme's own documents say (stocks/lib/corporate-actions.mjs
-- PROGRAMME_POLICY); an action it does not pass through is recorded only when it explains a step.
-- `first_checked_at` is when this row was first written; `checked_at` the latest run that
-- produced it.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.corporate_action_check (
    mint              text NOT NULL,
    check_key         text NOT NULL,
    symbol            text,
    issuer            text,
    ticker            text,
    action_kind       text,
    source_symbol     text,
    ex_date           date,
    action_event_at   timestamptz,
    expected_on_chain boolean,
    verdict           text NOT NULL,
    severity          text NOT NULL,
    expected_ratio    numeric,
    expected_low      numeric,
    expected_high     numeric,
    step_before       numeric,
    step_after        numeric,
    step_ratio        numeric,
    step_at           timestamptz,
    step_window_from  timestamptz,
    step_window_to    timestamptz,
    step_time_basis   text,
    lag_days          numeric,
    net_fraction      numeric,
    coverage_from     timestamptz,
    coverage_to       timestamptz,
    coverage_basis    text,
    detail            text,
    first_checked_at  timestamptz NOT NULL DEFAULT now(),
    checked_at        timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT corporate_action_check_pkey PRIMARY KEY (mint, check_key),
    CONSTRAINT corporate_action_check_verdict_check CHECK (verdict IN (
        'matched', 'late', 'wrong-ratio', 'missing', 'pending', 'no-coverage', 'unverifiable', 'unexplained')),
    CONSTRAINT corporate_action_check_severity_check CHECK (severity IN ('info', 'caution', 'warning', 'critical')),
    CONSTRAINT corporate_action_check_kind_check CHECK (action_kind IS NULL OR action_kind IN ('split', 'dividend'))
);

CREATE INDEX IF NOT EXISTS corporate_action_check_verdict_idx ON sonar.corporate_action_check (verdict, checked_at DESC);
CREATE INDEX IF NOT EXISTS corporate_action_check_ticker_idx ON sonar.corporate_action_check (ticker, ex_date DESC);

DO $$
DECLARE
    t text;
BEGIN
    IF pg_has_role(current_user, 'geo_user', 'MEMBER') OR current_user = 'geo_user' THEN
        FOREACH t IN ARRAY ARRAY['corporate_action', 'corporate_action_check']
        LOOP
            EXECUTE format('ALTER TABLE sonar.%I OWNER TO geo_user', t);
        END LOOP;
    END IF;
END
$$;
