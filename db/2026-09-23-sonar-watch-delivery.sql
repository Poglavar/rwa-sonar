-- Private Telegram delivery for saved watches (next-steps.md item 12). A watch's owner creates a
-- one-time, expiring binding token; the dedicated watch bot verifies the chat that sends
-- `/start <token>`; only then is the chat stored (AES-256-GCM ciphertext plus a keyed hash for
-- `/stop` lookups, never the plain id) and the morning digest may be enabled. Change events keep
-- what build-watchlist-changes.mjs found between digests; the digest log makes a day's send
-- idempotent. Idempotent DDL: every object is created only when absent.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF current_user <> 'geo_user' AND pg_has_role(current_user, 'geo_user', 'MEMBER') THEN
        EXECUTE 'SET LOCAL ROLE geo_user';
    END IF;
END
$$;

-- One verified private chat per watch. Deleting the watch deletes its delivery.
CREATE TABLE IF NOT EXISTS sonar.stock_watch_delivery (
    watch_id uuid PRIMARY KEY REFERENCES sonar.stock_watchlist (watch_id) ON DELETE CASCADE,
    channel text NOT NULL DEFAULT 'telegram' CHECK (channel = 'telegram'),
    chat_enc text NOT NULL CHECK (chat_enc ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
    chat_hash text NOT NULL CHECK (chat_hash ~ '^[0-9a-f]{64}$'),
    verified_at timestamptz NOT NULL,
    -- Set when the owner enables the digest: changes found before this are never sent.
    digest_since timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_watch_delivery_chat_idx ON sonar.stock_watch_delivery (chat_hash);

-- One-time binding tokens. Only the SHA-256 of the token is stored; the token itself exists
-- only in the t.me deep link handed to the owner.
CREATE TABLE IF NOT EXISTS sonar.stock_watch_binding (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    watch_id uuid NOT NULL REFERENCES sonar.stock_watchlist (watch_id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_watch_binding_watch_idx ON sonar.stock_watch_binding (watch_id);

-- Material changes found by build-watchlist-changes.mjs, kept between digests so a morning
-- digest covers everything since the last one even though the watch's baseline moves on.
CREATE TABLE IF NOT EXISTS sonar.stock_watch_event (
    event_id bigserial PRIMARY KEY,
    watch_id uuid NOT NULL REFERENCES sonar.stock_watchlist (watch_id) ON DELETE CASCADE,
    summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1000),
    -- When our daily check observed the change (the builder's run time), not an event time.
    detected_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_watch_event_watch_idx ON sonar.stock_watch_event (watch_id, detected_at);

-- At most one digest per watch per local calendar day. `sending` is claimed before the Telegram
-- call, so a crash mid-send can never produce a second message; only `failed` may be retried.
CREATE TABLE IF NOT EXISTS sonar.stock_watch_digest_log (
    watch_id uuid NOT NULL REFERENCES sonar.stock_watchlist (watch_id) ON DELETE CASCADE,
    digest_date date NOT NULL,
    status text NOT NULL CHECK (status IN ('sending', 'sent', 'no-change', 'failed')),
    change_count integer NOT NULL DEFAULT 0,
    covered_until timestamptz,
    attempts integer NOT NULL DEFAULT 1,
    error text CHECK (error IS NULL OR char_length(error) <= 200),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (watch_id, digest_date)
);

COMMIT;
