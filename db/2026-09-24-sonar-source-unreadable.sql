-- Adds the `unreadable` source status (stocks/lib/unreadable.mjs, next-steps.md item 11): the host
-- answered 2xx, but not with the document — a region-restriction page served to the server's region,
-- a script-only shell, an RPC endpoint's info page, a text file hashed as bytes, no text at
-- all. The watcher records no version and no change event for such a read and keeps the last
-- readable version as the baseline; `sonar.source.error` carries "couldn't read (<reason>): …".
-- Written by stocks/watch-sources.mjs. Idempotent. Needs db/2026-09-18-sonar-evidence.sql first.
--
-- Supersedes db/2026-09-24-sonar-source-reachable.sql: this list is that one plus `unreadable`, and
-- watch-sources.mjs --ddl applies THIS file instead of it, because re-applying the narrower list
-- after the first `unreadable` row exists would fail the ADD CONSTRAINT and the whole load.
-- Apply BEFORE deploying a watcher that writes the new status (the daily `rwa-watch` app passes
-- --ddl, which applies it at the start of the database load), or the source load fails the check.

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
    CHECK (status IN ('new', 'ok', 'changed', 'gone', 'blocked', 'unreadable', 'reachable-unverified', 'error'));
