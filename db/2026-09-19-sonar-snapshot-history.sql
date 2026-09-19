-- Extends the daily token snapshot with the aggregate inputs used by the public historical charts.
-- Idempotent: every column and index can be applied repeatedly during the scheduled refresh.

SET client_min_messages = warning;

DO $$
BEGIN
    IF current_user <> 'geo_user' AND pg_has_role(current_user, 'geo_user', 'MEMBER') THEN
        EXECUTE 'SET ROLE geo_user';
    END IF;
END
$$;

ALTER TABLE sonar.stock_token_snapshot ADD COLUMN IF NOT EXISTS underlying_ticker text;
ALTER TABLE sonar.stock_token_snapshot ADD COLUMN IF NOT EXISTS issuer_status text;
ALTER TABLE sonar.stock_token_snapshot ADD COLUMN IF NOT EXISTS active bool;
ALTER TABLE sonar.stock_token_snapshot ADD COLUMN IF NOT EXISTS supply_ui double precision;
ALTER TABLE sonar.stock_token_snapshot ADD COLUMN IF NOT EXISTS market_value_usd double precision;
ALTER TABLE sonar.stock_token_snapshot ADD COLUMN IF NOT EXISTS market_health text;
ALTER TABLE sonar.stock_token_snapshot ADD COLUMN IF NOT EXISTS control_health text;
ALTER TABLE sonar.stock_token_snapshot ADD COLUMN IF NOT EXISTS legal_health text;
ALTER TABLE sonar.stock_token_snapshot ADD COLUMN IF NOT EXISTS composability_health text;
ALTER TABLE sonar.stock_token_snapshot ADD COLUMN IF NOT EXISTS defi_protocol_count int;
ALTER TABLE sonar.stock_token_snapshot ADD COLUMN IF NOT EXISTS defi_integration_count int;

CREATE INDEX IF NOT EXISTS stock_token_snapshot_underlying_idx
    ON sonar.stock_token_snapshot (underlying_ticker);

DO $$
BEGIN
    IF pg_has_role(current_user, 'geo_user', 'MEMBER') OR current_user = 'geo_user' THEN
        ALTER TABLE sonar.stock_token_snapshot OWNER TO geo_user;
    END IF;
END
$$;
