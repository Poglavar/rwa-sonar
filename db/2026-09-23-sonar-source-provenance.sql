-- Read provenance for the document watcher (stocks/EVIDENCE.md §2.8): WHICH reader produced the
-- text of a source or a version, and — when that reader was the Wayback fallback — the capture's
-- own timestamp. Until 2026-09-23 an archived read was only recognisable from prose in
-- `sonar.source.error`, which also made every successful archived read count as a "fetch error".
-- Written by stocks/watch-sources.mjs (lib/watch.mjs `readViaFor`, `buildSourceSql`,
-- `buildVersionSql`); read by /api/sources and watch.html.
-- Idempotent: re-running this file is a no-op. Needs db/2026-09-18-sonar-evidence.sql first.

SET client_min_messages = warning;

-- Same ownership guard as db/2026-09-18-sonar-evidence.sql: DDL needs ownership, and every object
-- must end up owned by geo_user; a session that already is geo_user (or is a non-member superuser)
-- is left alone.
DO $$
BEGIN
    IF current_user <> 'geo_user' AND pg_has_role(current_user, 'geo_user', 'MEMBER') THEN
        EXECUTE 'SET ROLE geo_user';
    END IF;
END
$$;

-- `read_via` values are the readers the watcher actually records (stocks/watch-sources.mjs `via`):
--   html         the live page's markup
--   next-flight  the live page's Next.js flight payload (lib/nextflight.mjs), its markup being empty
--   pdf          the live response through pdftotext
--   api          the live JSON response, keys sorted
--   binary       the live response watched as bytes (a zip, an image)
--   notion       Notion's public loadPageChunk API behind a *.notion.site shell (lib/notion.mjs)
--   drive        a Google Drive file link fetched as its uc?export=download bytes
--   wayback      the live host refused us; the text is the newest Wayback capture (capture_at)
--   live         a live 304 Not Modified with no earlier reader on record: the host confirmed the
--                stored text is current, but no reader ran this time
-- NULL means nothing was read: a gone, blocked or errored fetch, or a row older than this file.
ALTER TABLE sonar.source         ADD COLUMN IF NOT EXISTS read_via   text;
ALTER TABLE sonar.source         ADD COLUMN IF NOT EXISTS capture_at timestamptz;
ALTER TABLE sonar.source_version ADD COLUMN IF NOT EXISTS read_via   text;
ALTER TABLE sonar.source_version ADD COLUMN IF NOT EXISTS capture_at timestamptz;

-- Re-stated as DROP+ADD so a later widening of the list reaches an existing database.
ALTER TABLE sonar.source DROP CONSTRAINT IF EXISTS source_read_via_check;
ALTER TABLE sonar.source ADD CONSTRAINT source_read_via_check CHECK (read_via IS NULL OR read_via IN (
    'live', 'html', 'next-flight', 'pdf', 'api', 'binary', 'notion', 'drive', 'wayback'));
ALTER TABLE sonar.source_version DROP CONSTRAINT IF EXISTS source_version_read_via_check;
ALTER TABLE sonar.source_version ADD CONSTRAINT source_version_read_via_check CHECK (read_via IS NULL OR read_via IN (
    'live', 'html', 'next-flight', 'pdf', 'api', 'binary', 'notion', 'drive', 'wayback'));

-- A capture time belongs to a capture: never on a live read. It is the CDX `timestamp` of the
-- capture that was read, never the time we fetched it (that is `last_checked_at`/`fetched_at`).
ALTER TABLE sonar.source DROP CONSTRAINT IF EXISTS source_capture_at_check;
ALTER TABLE sonar.source ADD CONSTRAINT source_capture_at_check
    CHECK (capture_at IS NULL OR read_via = 'wayback');
ALTER TABLE sonar.source_version DROP CONSTRAINT IF EXISTS source_version_capture_at_check;
ALTER TABLE sonar.source_version ADD CONSTRAINT source_version_capture_at_check
    CHECK (capture_at IS NULL OR read_via = 'wayback');

COMMENT ON COLUMN sonar.source.read_via IS 'reader that produced the stored text on the last check (html, next-flight, pdf, api, binary, notion, drive, wayback, live=304); NULL when nothing was read';
COMMENT ON COLUMN sonar.source.capture_at IS 'Wayback capture timestamp (CDX) the text was read from when read_via = wayback; NULL for live reads';
COMMENT ON COLUMN sonar.source_version.read_via IS 'reader that produced this version''s text; see sonar.source.read_via';
COMMENT ON COLUMN sonar.source_version.capture_at IS 'Wayback capture timestamp (CDX) of this version when read_via = wayback';

-- Example: sources whose current text is an archived capture, oldest capture first.
--
--    SELECT issuer_slug, url, capture_at, http_status
--      FROM sonar.source
--     WHERE read_via = 'wayback'
--     ORDER BY capture_at;
