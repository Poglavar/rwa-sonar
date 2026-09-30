-- Regulator-notice watch tables in schema `sonar` (stocks/watch-regulators.mjs): every regulator
-- publication (warning, enforcement action, trading suspension, public statement, register entry)
-- that names a watched party (`regulator_notice_match`, one row per regulator + notice + entity),
-- and every regulator source the watcher checked with when it last succeeded and failed
-- (`regulator_check`) — the second is what makes a source that went quiet, or that fails every
-- day, visible instead of silent. New matches become sonar.change_event rows of the new kind
-- `regulator-notice`, added below. An event is a candidate for a human to read, never a finding.
-- Idempotent: re-running this file is a no-op.

SET client_min_messages = warning;

-- Every object must end up owned by `geo_user` (see db/2026-09-18-sonar-evidence.sql).
DO $$
BEGIN
    IF current_user <> 'geo_user' AND pg_has_role(current_user, 'geo_user', 'MEMBER') THEN
        EXECUTE 'SET ROLE geo_user';
    END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS sonar;

-- ---------------------------------------------------------------------------------------------
-- Matches. One row per (regulator, notice id, entity): `entity` is the watched phrase normalised
-- (lib/caselaw.mjs normalisePhrase), so "Payward, Inc." and "Payward Inc" are one entity.
-- `published_at` / `published_date` are the NOTICE's own date as the regulator states it (never
-- our fetch time; null when the source gives none); `first_seen_at` / `last_seen_at` are when this
-- watcher saw it, which is all they claim to be.
--
-- `strength`: `strong` when the full legal name (with its corporate suffix, Ltd/Limited etc.
-- treated as one) appears; `weak` when only a brand, a bare name, or the legal name without its
-- suffix appears. `matched_in`: `subject` (the notice's named firm / title) or `text` (only in
-- its body or summary).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.regulator_notice_match (
    regulator       text NOT NULL,
    notice_id       text NOT NULL,
    entity          text NOT NULL,
    phrase          text NOT NULL,
    issuers         text[] NOT NULL DEFAULT '{}',
    strength        text NOT NULL,
    matched_in      text NOT NULL,
    notice_type     text,
    notice_title    text,
    notice_url      text,
    published_at    timestamptz,
    published_date  date,
    snippet         text,
    first_seen_at   timestamptz NOT NULL,
    last_seen_at    timestamptz NOT NULL,
    review_status   text NOT NULL DEFAULT 'candidate',
    review_note     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (regulator, notice_id, entity),
    CONSTRAINT regulator_notice_match_strength_check CHECK (strength IN ('strong', 'weak')),
    CONSTRAINT regulator_notice_match_in_check CHECK (matched_in IN ('subject', 'text')),
    CONSTRAINT regulator_notice_match_review_check
        CHECK (review_status IN ('candidate', 'dismissed', 'confirmed'))
);

CREATE INDEX IF NOT EXISTS regulator_notice_match_issuers_idx ON sonar.regulator_notice_match USING gin (issuers);
CREATE INDEX IF NOT EXISTS regulator_notice_match_date_idx    ON sonar.regulator_notice_match (published_date DESC);

-- ---------------------------------------------------------------------------------------------
-- Checks. One row per regulator source (`fca-news`, `sec-trading-suspensions`, …). A source with
-- no row has never run, so its first run is a baseline (matches recorded, no events).
-- `consecutive_failures` counts runs in a row that could not read it; `newest_published_at` is the
-- newest notice date it has ever shown, so a feed that stopped publishing is visible too.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.regulator_check (
    regulator            text PRIMARY KEY,
    label                text,
    url                  text,
    first_run_at         timestamptz NOT NULL,
    last_run_at          timestamptz NOT NULL,
    last_ok_at           timestamptz,
    last_status          text NOT NULL,
    last_error           text,
    consecutive_failures int NOT NULL DEFAULT 0,
    notices_read         int,
    matches              int,
    newest_published_at  timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT regulator_check_status_check CHECK (last_status IN ('ok', 'failed', 'stale', 'gap'))
);

DO $$
DECLARE
    t text;
BEGIN
    IF pg_has_role(current_user, 'geo_user', 'MEMBER') OR current_user = 'geo_user' THEN
        FOREACH t IN ARRAY ARRAY['regulator_notice_match', 'regulator_check']
        LOOP
            EXECUTE format('ALTER TABLE sonar.%I OWNER TO geo_user', t);
        END LOOP;
    END IF;
END
$$;

-- 2026-10-01: the regulator watcher raises `regulator-notice` events.
-- The allowed change_event kinds are stated in ONE place: db/2026-10-01-sonar-change-event-kinds.sql,
-- applied last (stocks/lib/schema.mjs). A kind list restated here would drop other watchers' kinds.


-- ---------------------------------------------------------------------------------------------
-- Examples.
-- ---------------------------------------------------------------------------------------------
--
-- 1. One issuer's regulator mentions, strong first, newest first.
--
--    SELECT strength, regulator, published_date, notice_title, notice_url
--      FROM sonar.regulator_notice_match
--     WHERE 'xstocks-backed' = ANY(issuers) AND review_status <> 'dismissed'
--     ORDER BY strength, published_date DESC NULLS LAST;
--
-- 2. Which sources were checked, and which are failing or quiet.
--
--    SELECT regulator, last_status, last_ok_at, consecutive_failures, notices_read, newest_published_at
--      FROM sonar.regulator_check ORDER BY last_status DESC, regulator;
