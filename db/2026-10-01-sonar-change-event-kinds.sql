-- The one statement of which kinds sonar.change_event accepts. Every watcher that writes events adds
-- its kind HERE and nowhere else, and this file is applied LAST (stocks/lib/schema.mjs), so a file
-- applied earlier can never narrow the list and fail against another watcher's stored rows (30 Sep
-- 2026: three files each restated a fixed list; a narrower one dropped the constraint and failed to
-- re-add it). One transaction, so a failure leaves the previous list in place, never none.
-- Writers: chain watcher (authority-key, extension-toggle, rebase, supply, treasury, metadata, status),
-- document watcher (legal-term, document-gone, quote-lost), refresh (holder-concentration, venue,
-- float, liquidity), case law (litigation), entities (entity-status, insolvency), regulators
-- (regulator-notice), reserves (reserve), corporate actions (corporate-action). stocks/schema.test.js checks every kind a watcher writes is listed.

SET client_min_messages = warning;

BEGIN;

DO $$
BEGIN
    IF current_user <> 'geo_user' AND pg_has_role(current_user, 'geo_user', 'MEMBER') THEN
        EXECUTE 'SET LOCAL ROLE geo_user';
    END IF;
END
$$;

ALTER TABLE sonar.change_event DROP CONSTRAINT IF EXISTS change_event_kind_check;
ALTER TABLE sonar.change_event ADD CONSTRAINT change_event_kind_check CHECK (kind IN (
    'legal-term', 'document-gone', 'quote-lost', 'authority-key', 'extension-toggle', 'rebase',
    'supply', 'treasury', 'holder-concentration', 'venue', 'float', 'liquidity', 'metadata', 'status',
    'litigation', 'entity-status', 'insolvency', 'regulator-notice', 'reserve', 'corporate-action'));

COMMIT;
