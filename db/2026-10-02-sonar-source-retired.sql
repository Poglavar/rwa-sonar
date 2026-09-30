-- Adds the `retired` source status: a cited URL that is gone for good (a wound-down issuer's dead
-- domain), listed with a date and a reason in stocks/data/retired-sources.json. The document
-- watcher no longer fetches it and writes its row as `retired`, with "retired <date>: <reason>" in
-- `error`; the row, its versions and its change events stay, so the evidence history stays
-- explainable. Written by stocks/watch-sources.mjs (lib/watch-rows.mjs). Idempotent. Needs
-- db/2026-09-18-sonar-evidence.sql first.
--
-- Supersedes db/2026-09-24-sonar-source-unreadable.sql: this list is that one plus `retired`, and
-- stocks/apply-schema.mjs applies THIS file instead of it, because re-applying the narrower list
-- after the first `retired` row exists would fail the ADD CONSTRAINT.
-- Apply BEFORE deploying a watcher that writes the new status (the deploy runs apply-schema before
-- anything else), or the source load fails the check.

SET client_min_messages = warning;

DO $$
BEGIN
    IF current_user <> 'geo_user' AND pg_has_role(current_user, 'geo_user', 'MEMBER') THEN
        EXECUTE 'SET ROLE geo_user';
    END IF;
END
$$;

ALTER TABLE sonar.source DROP CONSTRAINT IF EXISTS source_status_check;
ALTER TABLE sonar.source ADD CONSTRAINT source_status_check
    CHECK (status IN ('new', 'ok', 'changed', 'gone', 'blocked', 'unreadable', 'reachable-unverified', 'retired', 'error'));
