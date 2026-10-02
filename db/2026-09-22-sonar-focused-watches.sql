-- Extend anonymous saved comparisons into typed token, issuer and protocol-market watches, with
-- separate read-only share credentials and explicit daily-digest preferences.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE geo_user;

ALTER TABLE sonar.stock_watchlist
    ADD COLUMN IF NOT EXISTS watch_type text NOT NULL DEFAULT 'comparison',
    ADD COLUMN IF NOT EXISTS target jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS read_hash text,
    ADD COLUMN IF NOT EXISTS digest_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS digest_hour smallint NOT NULL DEFAULT 6,
    ADD COLUMN IF NOT EXISTS digest_timezone text NOT NULL DEFAULT 'UTC';

UPDATE sonar.stock_watchlist
SET target = jsonb_build_object('ticker', underlying_ticker, 'issuers', issuer_slugs)
WHERE watch_type = 'comparison' AND target = '{}'::jsonb;

ALTER TABLE sonar.stock_watchlist ALTER COLUMN underlying_ticker DROP NOT NULL;
ALTER TABLE sonar.stock_watchlist ALTER COLUMN issuer_slugs DROP NOT NULL;

DO $$
DECLARE constraint_row record;
BEGIN
    FOR constraint_row IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'sonar.stock_watchlist'::regclass
          AND contype = 'c'
          AND (pg_get_constraintdef(oid) LIKE '%cardinality(issuer_slugs)%'
               OR pg_get_constraintdef(oid) LIKE '%char_length(underlying_ticker)%')
    LOOP
        EXECUTE format('ALTER TABLE sonar.stock_watchlist DROP CONSTRAINT %I', constraint_row.conname);
    END LOOP;
END $$;

ALTER TABLE sonar.stock_watchlist
    DROP CONSTRAINT IF EXISTS stock_watchlist_type,
    DROP CONSTRAINT IF EXISTS stock_watchlist_target_shape,
    DROP CONSTRAINT IF EXISTS stock_watchlist_read_hash,
    DROP CONSTRAINT IF EXISTS stock_watchlist_digest_hour,
    DROP CONSTRAINT IF EXISTS stock_watchlist_digest_timezone;

ALTER TABLE sonar.stock_watchlist
    ADD CONSTRAINT stock_watchlist_type
        CHECK (watch_type IN ('comparison', 'token', 'issuer', 'protocol-market')),
    ADD CONSTRAINT stock_watchlist_target_shape CHECK (
        (watch_type = 'comparison'
            AND char_length(underlying_ticker) BETWEEN 1 AND 16
            AND cardinality(issuer_slugs) BETWEEN 1 AND 100)
        OR (watch_type <> 'comparison'
            AND underlying_ticker IS NULL
            AND COALESCE(cardinality(issuer_slugs), 0) = 0)
    ),
    ADD CONSTRAINT stock_watchlist_read_hash
        CHECK (read_hash IS NULL OR read_hash ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT stock_watchlist_digest_hour CHECK (digest_hour BETWEEN 0 AND 23),
    ADD CONSTRAINT stock_watchlist_digest_timezone CHECK (char_length(digest_timezone) BETWEEN 1 AND 64);

CREATE INDEX IF NOT EXISTS stock_watchlist_type_idx ON sonar.stock_watchlist (watch_type);
COMMIT;
