-- Persistent, shareable comparison watchlists. The browser receives a random owner key once;
-- only its SHA-256 hash is stored. The URL fragment carries the key across devices without
-- putting it in access logs or query strings.

SET client_min_messages = warning;

DO $$
BEGIN
    IF current_user <> 'geo_user' AND pg_has_role(current_user, 'geo_user', 'MEMBER') THEN
        EXECUTE 'SET ROLE geo_user';
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS sonar.stock_watchlist (
    watch_id uuid PRIMARY KEY,
    owner_hash text NOT NULL CHECK (owner_hash ~ '^[0-9a-f]{64}$'),
    title text,
    underlying_ticker text NOT NULL,
    issuer_slugs text[] NOT NULL,
    filters jsonb NOT NULL DEFAULT '[]'::jsonb,
    baseline jsonb,
    last_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_checked_at timestamptz,
    CHECK (cardinality(issuer_slugs) BETWEEN 2 AND 12),
    CHECK (char_length(underlying_ticker) BETWEEN 1 AND 16),
    CHECK (title IS NULL OR char_length(title) <= 80)
);

CREATE INDEX IF NOT EXISTS stock_watchlist_ticker_idx
    ON sonar.stock_watchlist (underlying_ticker);
CREATE INDEX IF NOT EXISTS stock_watchlist_updated_idx
    ON sonar.stock_watchlist (updated_at DESC);

DO $$
BEGIN
    IF pg_has_role(current_user, 'geo_user', 'MEMBER') OR current_user = 'geo_user' THEN
        ALTER TABLE sonar.stock_watchlist OWNER TO geo_user;
    END IF;
END
$$;
