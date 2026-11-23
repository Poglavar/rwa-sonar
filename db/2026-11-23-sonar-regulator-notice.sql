-- Every notice a regulator or court feed published, as the watcher parsed it, stored ONCE per
-- distinct content and BEFORE anything is matched (stocks/watch-regulators.mjs, and the SEC
-- litigation feeds of stocks/watch-caselaw.mjs). Until 2026-11-23 a notice that named no watched
-- party was never kept, and the FCA warnings feed only ever shows its newest 20: a notice that
-- scrolled off before a matcher fix or a newly watched name was gone. Matching now reads from here.
--
-- One row per (source, notice id, content hash): a re-read of an unchanged notice only moves
-- `last_seen_at`; a notice whose content changed is a new version (new hash), never a copy.
-- `published_at` / `published_date` are the source's own date (null when it gives none);
-- `first_seen_at` / `last_seen_at` are when the watcher fetched it, which is all they claim.
-- `matched_at` is when a processing step matched this version against the watched names; null
-- means it is still waiting (a failed processing step leaves it null, and the next run matches it).
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

CREATE TABLE IF NOT EXISTS sonar.regulator_notice (
    source          text NOT NULL,
    notice_id       text NOT NULL,
    content_hash    text NOT NULL,
    notice          jsonb NOT NULL,
    published_at    timestamptz,
    published_date  date,
    first_seen_at   timestamptz NOT NULL,
    last_seen_at    timestamptz NOT NULL,
    matched_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, notice_id, content_hash)
);

-- The processing backlog: versions no matcher has read yet (normally none).
CREATE INDEX IF NOT EXISTS regulator_notice_unmatched_idx
    ON sonar.regulator_notice (source, notice_id) WHERE matched_at IS NULL;
CREATE INDEX IF NOT EXISTS regulator_notice_date_idx ON sonar.regulator_notice (source, published_date DESC);

DO $$
BEGIN
    IF pg_has_role(current_user, 'geo_user', 'MEMBER') OR current_user = 'geo_user' THEN
        EXECUTE 'ALTER TABLE sonar.regulator_notice OWNER TO geo_user';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Examples.
-- ---------------------------------------------------------------------------------------------
--
-- 1. What the FCA warnings feed published this week, matched or not.
--
--    SELECT published_date, notice->>'title' AS title, notice->>'url' AS url
--      FROM sonar.regulator_notice
--     WHERE source = 'fca-warnings' AND published_date >= current_date - 7
--     ORDER BY published_date DESC;
--
-- 2. Notices waiting for a matcher run (a processing step failed).
--
--    SELECT source, count(*) FROM sonar.regulator_notice WHERE matched_at IS NULL GROUP BY 1;
