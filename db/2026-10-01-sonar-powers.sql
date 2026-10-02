-- The issuer-power watcher's tables in schema `sonar` (stocks/watch-powers.mjs, hourly): every USE
-- of an issuer power found in a transaction signed by a mint's authority key — a freeze or thaw of
-- one account, a permanent-delegate transfer or burn out of someone else's account, a pause or
-- resume, a transfer-fee change, a default-account-state change, a set-authority — and every
-- configuration change of the Squads v4 multisigs that hold those keys. The chain watcher
-- (sonar.mint_state) sees what a mint IS each hour; this sees what its keys DID, per transaction.
--
-- Routine operations (a mint, a scaled-UI multiplier update, a fee withdrawal, or a delegate
-- action on an account the issuer itself holds) run at thousands a day for some issuers — every
-- Ondo purchase is a mintTo, every Backpack trade an updateMultiplier — so they are counted per
-- UTC day, mint, authority and action in `power_use_daily` instead of stored one row each. The
-- chain watcher already reports the supply and multiplier moves those operations add up to.
--
-- Every time column is the chain's own block time; `listed_at` (when we last listed an address)
-- is operational.
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
-- One row per non-routine power use. `ix_index` is the instruction's position in the
-- transaction's execution order (each top-level instruction, then its inner instructions), so two
-- freezes in one transaction are two rows. `action`:
--   freeze, thaw                     FreezeAccount / ThawAccount by the mint's freeze authority
--   forced-transfer, forced-burn     Transfer(Checked) / Burn(Checked) by the permanent delegate
--                                    out of an account whose owner is not an issuer wallet
--   pause, resume                    Token-2022 Pausable
--   transfer-fee-set                 TransferFee SetTransferFee
--   default-state-set                DefaultAccountState Update (new accounts frozen or not)
--   set-authority                    SetAuthority on the mint by one of its authorities
--   squads-config-proposed           Squads v4 config_transaction_create (actions in `detail`)
--   squads-config-executed           Squads v4 config_transaction_execute (the change takes effect)
--   squads-config-direct             multisig_add_member / remove / change_threshold / set_time_lock
--                                    / set_config_authority by the multisig's config authority
-- `authority` is the key that signed (for Squads rows, the multisig account); `via_multisig` the
-- Squads v4 multisig whose vault it is, when it executed through one. `target_owner` is read from
-- the transaction's own token balances; `target_label` is the repo's label for that owner
-- (issuer-authority, issuer-inventory, burn-address, issuer-wallet) or NULL = not an issuer wallet
-- we can name. `holder_affecting` is true when the action reached an account we cannot attribute
-- to the issuer, or every holder at once (a pause, a fee change).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.power_use (
    signature        text NOT NULL,
    ix_index         int NOT NULL,
    slot             bigint NOT NULL,
    block_time       timestamptz NOT NULL,
    mint             text,
    symbol           text,
    issuer           text,
    authority        text NOT NULL,
    authority_role   text,
    via_multisig     text,
    action           text NOT NULL,
    target_account   text,
    target_owner     text,
    target_label     text,
    amount_raw       numeric,
    amount           numeric,
    holder_affecting bool NOT NULL,
    severity         text NOT NULL,
    program_id       text NOT NULL,
    detail           jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT power_use_pkey PRIMARY KEY (signature, ix_index),
    CONSTRAINT power_use_severity_check CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE INDEX IF NOT EXISTS power_use_time_idx ON sonar.power_use (block_time DESC);
CREATE INDEX IF NOT EXISTS power_use_mint_idx ON sonar.power_use (mint, block_time DESC);
CREATE INDEX IF NOT EXISTS power_use_holder_idx ON sonar.power_use (block_time DESC) WHERE holder_affecting;

-- ---------------------------------------------------------------------------------------------
-- Routine uses, counted per UTC day (of the block time), mint, authority and action:
--   mint                     MintTo(Checked) by the mint authority (target_kind: issuer / other)
--   multiplier-update        ScaledUiAmount UpdateMultiplier
--   fee-withdraw             TransferFee WithdrawWithheldTokensFrom{Mint,Accounts}
--   delegate-transfer, delegate-burn, freeze, thaw
--                            the same powers used on an account an issuer wallet owns
-- A use is counted only while the listing of ITS authority is processed, and that address's
-- checkpoint moves in the same database transaction, so each use is counted exactly once.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.power_use_daily (
    day              date NOT NULL,
    mint             text NOT NULL,
    authority        text NOT NULL,
    action           text NOT NULL,
    target_kind      text NOT NULL,
    uses             int NOT NULL,
    amount_raw       numeric,
    first_signature  text NOT NULL,
    last_signature   text NOT NULL,
    first_block_time timestamptz NOT NULL,
    last_block_time  timestamptz NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT power_use_daily_pkey PRIMARY KEY (day, mint, authority, action, target_kind)
);

-- ---------------------------------------------------------------------------------------------
-- One row per watched address: an authority key (roles, issuers) or a Squads v4 multisig found
-- behind a vault. `last_signature` is the checkpoint every run lists back to; `backfill_from`
-- is where coverage actually starts (the --since window, or later when the first listing hit the
-- page cap, which the run says). `state` holds the Squads discovery result and a multisig's
-- decoded configuration as last read.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.power_scan (
    address          text PRIMARY KEY,
    kind             text NOT NULL,
    roles            text[],
    issuers          text[],
    backfill_from    timestamptz NOT NULL,
    last_signature   text,
    last_slot        bigint,
    last_block_time  timestamptz,
    state            jsonb,
    signatures_seen  bigint NOT NULL DEFAULT 0,
    listed_at        timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT power_scan_kind_check CHECK (kind IN ('authority', 'squads-multisig'))
);

DO $$
DECLARE
    t text;
BEGIN
    IF pg_has_role(current_user, 'geo_user', 'MEMBER') OR current_user = 'geo_user' THEN
        FOREACH t IN ARRAY ARRAY['power_use', 'power_use_daily', 'power_scan']
        LOOP
            EXECUTE format('ALTER TABLE sonar.%I OWNER TO geo_user', t);
        END LOOP;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Examples.
-- ---------------------------------------------------------------------------------------------
--
-- 1. Holder-affecting uses, newest first.
--
--    SELECT block_time, issuer, symbol, action, target_owner, amount, severity, signature
--      FROM sonar.power_use WHERE holder_affecting ORDER BY block_time DESC LIMIT 50;
--
-- 2. Squads configuration changes that took effect.
--
--    SELECT block_time, authority AS multisig, detail->'actions' FROM sonar.power_use
--     WHERE action IN ('squads-config-executed', 'squads-config-direct') ORDER BY block_time DESC;
--
-- 3. Routine volume per issuer key and day.
--
--    SELECT day, authority, action, target_kind, sum(uses) FROM sonar.power_use_daily
--     GROUP BY 1, 2, 3, 4 ORDER BY 1 DESC, 5 DESC;
--
-- 4. How far behind each watched address is (the outcome check reads max(listed_at)).
--
--    SELECT kind, count(*), min(last_block_time), max(listed_at) FROM sonar.power_scan GROUP BY 1;
