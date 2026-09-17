-- The on-chain watcher's tables in schema `sonar` (stocks/EVIDENCE.md §2.4): one row per mint per
-- OBSERVED STATE (`mint_state`) and one row per labelled wallet balance reading (`wallet_balance`).
-- Written hourly by stocks/watch-chain.mjs, which compares the state it just read against the
-- latest stored row and writes sonar.change_event rows for the differences (kinds per §3:
-- authority-key, extension-toggle, rebase, supply, metadata, treasury).
--
-- "Per observed state", not "per read": a mint whose `state_hash` equals the latest stored hash
-- gets NO new row, so the table is a history of changes rather than 471 rows an hour. That is also
-- why `observed_at` is the time of the BATCH that read the account (paired with that batch's
-- `slot`) and never a single per-run clock value — see the note on slot below.
--
-- Idempotent: re-running this file is a no-op.

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

-- ---------------------------------------------------------------------------------------------
-- Mint state. Every column below is a value the RPC returned for that account, flattened out of
-- the Token-2022 extensions by lib/chainwatch.mjs `parseMintState()` — the same extensions
-- stocks/fetch-onchain.mjs reads, plus the fields a daily snapshot throws away: the fee
-- authorities, the withheld amount, the hook authority and the scheduled (not yet effective)
-- scaled-UI multiplier.
--
-- `slot` is the `context.slot` of the getMultipleAccounts response that carried this account, so
-- it is the chain's own statement of when the value was true. It is deliberately NOT part of
-- `state_hash`: it advances every run, and hashing it would make every mint "changed" hourly.
--
-- `metadata_hash` is sha256 of the JSON body at `metadata_uri`, or NULL when we have not fetched
-- it yet (the watcher fetches at most 50 per run, so a cold start fills in over ~10 runs). NULL
-- therefore means "unknown", never "empty": a NULL -> hash transition is a first observation and
-- raises no `metadata` change event, only a hash -> different hash does.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.mint_state (
    mint                        text NOT NULL,
    observed_at                 timestamptz NOT NULL,
    slot                        bigint,
    supply                      numeric,
    decimals                    int,
    mint_authority              text,
    freeze_authority            text,
    paused                      bool,
    pausable                    bool,
    default_frozen              bool,
    permanent_delegate          text,
    transfer_fee_bps            int,
    transfer_fee_max            numeric,
    withheld                    numeric,
    fee_config_authority        text,
    withdraw_withheld_authority text,
    hook_program                text,
    hook_authority              text,
    ui_multiplier               numeric,
    ui_multiplier_next          numeric,
    ui_multiplier_effective_at  timestamptz,
    ui_multiplier_authority     text,
    metadata_uri                text,
    metadata_update_authority   text,
    metadata_hash               text,
    state_hash                  text NOT NULL,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mint_state_pkey PRIMARY KEY (mint, observed_at)
);

CREATE INDEX IF NOT EXISTS mint_state_mint_observed_idx ON sonar.mint_state (mint, observed_at DESC);
CREATE INDEX IF NOT EXISTS mint_state_observed_idx      ON sonar.mint_state (observed_at DESC);

COMMENT ON COLUMN sonar.mint_state.slot IS 'context.slot of the getMultipleAccounts response that carried this account — the chain''s own clock, not ours';
COMMENT ON COLUMN sonar.mint_state.state_hash IS 'sha256 over the comparable columns (everything except mint, observed_at, slot and the row timestamps)';
COMMENT ON COLUMN sonar.mint_state.metadata_hash IS 'sha256 of the JSON body at metadata_uri; NULL = not fetched yet, never "empty"';

-- ---------------------------------------------------------------------------------------------
-- Labelled wallet balances (EVIDENCE.md §2.4, `treasury`). One row per (wallet, mint, reading):
-- `mint` is NULL for the wallet's native SOL balance, and `amount` is always in UI units (SOL, or
-- the token's own decimals applied) so a threshold reads the same for both.
--
-- `label` is the label lib/holders.mjs `buildOwnerLabels()` gave the address (issuer-authority,
-- burn-address) — this repo only ever labels an address a dossier or a sponsor API names, so an
-- unlabelled wallet is simply not watched here.
--
-- Deviation from the design note, and why: it asks for `PRIMARY KEY (wallet, mint, observed_at)`,
-- but a PRIMARY KEY column cannot be NULL in Postgres and `mint IS NULL` is exactly how a SOL row
-- is spelled. So uniqueness is an expression index over coalesce(mint, ''), the same shape
-- change_event_dedupe_idx already uses for its nullable `field`, and the table carries a surrogate
-- identity key like sonar.source_version does.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.wallet_balance (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    wallet      text NOT NULL,
    mint        text,
    label       text,
    observed_at timestamptz NOT NULL,
    amount      numeric,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_balance_reading_key
    ON sonar.wallet_balance (wallet, coalesce(mint, ''), observed_at);
CREATE INDEX IF NOT EXISTS wallet_balance_wallet_idx ON sonar.wallet_balance (wallet, observed_at DESC);
CREATE INDEX IF NOT EXISTS wallet_balance_mint_idx   ON sonar.wallet_balance (mint, observed_at DESC);

COMMENT ON COLUMN sonar.wallet_balance.mint IS 'NULL = the wallet''s native SOL balance';
COMMENT ON COLUMN sonar.wallet_balance.amount IS 'UI units: SOL, or the token amount with its decimals applied';

-- A table created by some other role in an earlier run would silently break the next
-- `CREATE INDEX IF NOT EXISTS` (DDL needs ownership even when the index already exists), so
-- make ownership explicit and idempotent rather than assuming the SET ROLE above did it.
DO $$
DECLARE
    t text;
BEGIN
    IF pg_has_role(current_user, 'geo_user', 'MEMBER') OR current_user = 'geo_user' THEN
        FOREACH t IN ARRAY ARRAY['mint_state', 'wallet_balance']
        LOOP
            EXECUTE format('ALTER TABLE sonar.%I OWNER TO geo_user', t);
        END LOOP;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Examples. The queries this schema exists for.
-- ---------------------------------------------------------------------------------------------
--
-- 1. The current state of every watched mint.
--
--    SELECT DISTINCT ON (mint) mint, observed_at, slot, supply, paused, transfer_fee_bps,
--           hook_program, ui_multiplier
--      FROM sonar.mint_state
--     ORDER BY mint, observed_at DESC;
--
-- 2. Mints whose state moved in the last 24 h, and how many times.
--
--    SELECT mint, count(*) AS states, min(observed_at), max(observed_at)
--      FROM sonar.mint_state
--     WHERE observed_at >= now() - interval '24 hours'
--     GROUP BY 1
--     ORDER BY states DESC;
--
-- 3. Authority rotations the watcher caught (the events it wrote from these rows).
--
--    SELECT detected_at, subject_id, field, before, after, severity
--      FROM sonar.change_event
--     WHERE kind IN ('authority-key', 'extension-toggle')
--     ORDER BY detected_at DESC
--     LIMIT 50;
--
-- 4. One labelled wallet's balance history in a token.
--
--    SELECT observed_at, amount
--      FROM sonar.wallet_balance
--     WHERE wallet = '2u8YwJTykTreziHBN5QwE7Bi2SyN8M2MicCscthtph9E'
--       AND mint = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB'
--     ORDER BY observed_at DESC;
--
-- 5. How fresh the chain watch is (the freshness an outcome check reads).
--
--    SELECT max(observed_at) AS last_state, now() - max(observed_at) AS age
--      FROM sonar.mint_state;
