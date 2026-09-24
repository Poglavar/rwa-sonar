-- Adds the `reachable-unverified` source status (stocks/lib/watch.mjs `quotelessRefusal`): a source
-- whose host refused us or rendered nothing, but which no dossier quote relies on (a homepage in a
-- `website` field, a listing in a what-if's `searched` trail, a folder cited as "the series"). The
-- host answered, which is all such a citation needs; its content was not read. Written by
-- stocks/watch-sources.mjs. Idempotent. Needs db/2026-09-18-sonar-evidence.sql first.
-- Apply BEFORE deploying a watcher that writes the new status, or the source load fails the check.
-- SUPERSEDED by db/2026-09-24-sonar-source-unreadable.sql (the same list plus `unreadable`), which
-- stocks/watch-sources.mjs --ddl applies instead. Do not re-apply this file once any source row is
-- `unreadable`: its narrower CHECK would fail against those rows.

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
    CHECK (status IN ('new', 'ok', 'changed', 'gone', 'blocked', 'reachable-unverified', 'error'));
