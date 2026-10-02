-- Allow useful standalone stock watches and many wrappers. This only relaxes the old count
-- constraint: existing watches stay valid and no rows or columns are removed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE geo_user;
DO $$
DECLARE old_constraint record;
BEGIN
    -- PostgreSQL names an unnamed CHECK from its column; identify the exact expression instead
    -- of relying on a name that differs between originally-created and restored databases.
    FOR old_constraint IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'sonar.stock_watchlist'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%cardinality(issuer_slugs)%'
          AND conname <> 'stock_watchlist_issuer_count'
    LOOP
        EXECUTE format('ALTER TABLE sonar.stock_watchlist DROP CONSTRAINT %I', old_constraint.conname);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid = 'sonar.stock_watchlist'::regclass AND conname = 'stock_watchlist_issuer_count') THEN
        ALTER TABLE sonar.stock_watchlist ADD CONSTRAINT stock_watchlist_issuer_count
            CHECK (cardinality(issuer_slugs) BETWEEN 1 AND 100);
    END IF;
END $$;
COMMIT;
