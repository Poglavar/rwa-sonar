-- `sonar.claim` (stocks/EVIDENCE.md §1, build order step 2): one row per fact we assert about an
-- issuer or a token, with the verbatim words from the source, the locator that finds them again,
-- and the source registry row they came from. Written by stocks/load-db.mjs (--only=claims) from
-- the dossiers' own `claims[]` plus the quote-bearing findings, incidents and attestations;
-- re-checked later by stocks/watch-sources.mjs, which owns `last_checked_at`,
-- `last_confirmed_at` and the `changed` / `source-gone` statuses.
--
-- Apply AFTER db/2026-09-18-sonar-evidence.sql: the `source_id` foreign key needs sonar.source.
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
-- Claims. `id` is deterministic — `<issuer_slug>:<field>:<first 8 hex of sha1(url|quote)>` — so a
-- re-load addresses exactly the same row without looking anything up, and two researchers who
-- quote the same words from the same URL for the same field write one claim rather than two.
--
-- `status` extends EVIDENCE.md §1 with the two states a dossier can carry before anything is
-- re-checked: `unverified` (written down, nobody has looked since) and `inference` (our reading,
-- not the source's words). `changed` and `source-gone` are the watcher's to set. A claim whose
-- quote disappears from its source does NOT become false: it becomes `changed`, with a change
-- event beside it, and a human decides.
--
-- `value` is the structured dossier value at `field` AT LOAD TIME, as jsonb — which is what makes
-- a later diff meaningful: the quote says what the source said, `value` says what we published
-- from it.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.claim (
    id                text PRIMARY KEY,
    subject_type      text NOT NULL,
    subject_id        text NOT NULL,
    issuer_slug       text NOT NULL,
    field             text NOT NULL,
    value             jsonb,
    quote             text,
    url               text,
    source_id         text REFERENCES sonar.source(id) ON DELETE SET NULL,
    locator           text,
    recorded_at       timestamptz NOT NULL DEFAULT now(),
    accessed_at       timestamptz,
    last_checked_at   timestamptz,
    last_confirmed_at timestamptz,
    status            text NOT NULL DEFAULT 'unverified',
    method            text NOT NULL DEFAULT 'manual',
    note              text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT claim_subject_type_check CHECK (subject_type IN ('issuer', 'token')),
    CONSTRAINT claim_status_check CHECK (status IN (
        'confirmed', 'unverified', 'contradicted-corrected', 'inference', 'changed', 'source-gone')),
    CONSTRAINT claim_method_check CHECK (method IN ('manual', 'extracted', 'onchain')),
    -- A claim must SAY something: the source's words, a link to them, or a note explaining it.
    -- Not "quote OR url": an `inference` is our reading rather than the source's words and by
    -- construction has neither, and so does an `unverified` claim recording that a field was
    -- looked for and not found ("the terms never mention a security interest"). Measured over the
    -- real dossiers on 2026-09-18: 31 of 1263 claims carry neither a quote nor a URL, every one of
    -- them with a note, and a "quote OR url" check would have rejected the whole load.
    CONSTRAINT claim_has_evidence_check CHECK (
        quote IS NOT NULL OR url IS NOT NULL OR note IS NOT NULL),
    -- What CANNOT happen is claiming the source's own words were found without having them:
    -- `confirmed` means the quote was read verbatim, so it needs a quote or at least a link.
    CONSTRAINT claim_confirmed_has_source_check CHECK (
        status <> 'confirmed' OR quote IS NOT NULL OR url IS NOT NULL)
);

-- CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a CHANGED constraint
-- has to be re-stated. Drop-then-add is idempotent and, unlike the CREATE above, actually applies
-- on the second run — which is the whole point: both checks were widened on 2026-09-18, after the
-- table had been created with a stricter "quote OR url" that no inference claim could satisfy.
ALTER TABLE sonar.claim DROP CONSTRAINT IF EXISTS claim_has_evidence_check;
ALTER TABLE sonar.claim ADD CONSTRAINT claim_has_evidence_check CHECK (
    quote IS NOT NULL OR url IS NOT NULL OR note IS NOT NULL);
ALTER TABLE sonar.claim DROP CONSTRAINT IF EXISTS claim_confirmed_has_source_check;
ALTER TABLE sonar.claim ADD CONSTRAINT claim_confirmed_has_source_check CHECK (
    status <> 'confirmed' OR quote IS NOT NULL OR url IS NOT NULL);

CREATE INDEX IF NOT EXISTS claim_issuer_field_idx ON sonar.claim (issuer_slug, field);
CREATE INDEX IF NOT EXISTS claim_status_idx       ON sonar.claim (status);
CREATE INDEX IF NOT EXISTS claim_source_idx       ON sonar.claim (source_id);
CREATE INDEX IF NOT EXISTS claim_subject_idx      ON sonar.claim (subject_type, subject_id);

COMMENT ON TABLE sonar.claim IS
    'One asserted fact per row: the dossier field, the verbatim quote, the source and the locator.';
COMMENT ON COLUMN sonar.claim.id IS
    '<issuer_slug>:<field>:<left(sha1(url||''|''||quote), 8)> — deterministic, so a re-load is an upsert';
COMMENT ON COLUMN sonar.claim.value IS 'the structured dossier value at `field` when the claim was loaded';
COMMENT ON COLUMN sonar.claim.recorded_at IS 'when WE first wrote the claim (insert only; never refreshed)';
COMMENT ON COLUMN sonar.claim.accessed_at IS 'when the researcher read the source — the source''s own reading, not the clock';
COMMENT ON COLUMN sonar.claim.last_checked_at IS 'when a watcher last looked (stocks/watch-sources.mjs owns this)';
COMMENT ON COLUMN sonar.claim.last_confirmed_at IS 'when the quote was last found verbatim in the source';
COMMENT ON COLUMN sonar.claim.source_id IS 'sonar.source row matched on exact URL at load time; null when the registry has no such URL';

-- A table created by some other role in an earlier run would silently break the next
-- `CREATE INDEX IF NOT EXISTS` (DDL needs ownership even when the index already exists), so
-- make ownership explicit and idempotent rather than assuming the SET ROLE above did it.
DO $$
BEGIN
    IF pg_has_role(current_user, 'geo_user', 'MEMBER') OR current_user = 'geo_user' THEN
        EXECUTE 'ALTER TABLE sonar.claim OWNER TO geo_user';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Examples. The queries this table exists for.
-- ---------------------------------------------------------------------------------------------
--
-- 1. Evidence coverage per issuer: fields with a confirmed claim, and how many claims in total.
--
--    SELECT issuer_slug,
--           count(DISTINCT field) FILTER (WHERE status = 'confirmed') AS fields_sourced,
--           count(*) AS claims,
--           max(accessed_at) AS last_accessed
--      FROM sonar.claim
--     GROUP BY 1
--     ORDER BY fields_sourced DESC;
--
-- 2. What we assert with no source in the registry (so no watcher will ever re-read it).
--
--    SELECT issuer_slug, field, url
--      FROM sonar.claim
--     WHERE source_id IS NULL AND url IS NOT NULL
--     ORDER BY 1, 2;
--
-- 3. Claims whose source has moved or gone, worst first — the review queue.
--
--    SELECT c.issuer_slug, c.field, c.status, s.url, s.status AS source_status, s.last_checked_at
--      FROM sonar.claim c
--      LEFT JOIN sonar.source s ON s.id = c.source_id
--     WHERE c.status IN ('changed', 'source-gone') OR s.status IN ('gone', 'blocked')
--     ORDER BY c.issuer_slug, c.field;
--
-- 4. One issuer's claims, strongest first.
--
--    SELECT field, status, method, left(quote, 80) AS quote, locator, accessed_at
--      FROM sonar.claim
--     WHERE issuer_slug = 'prestocks'
--     ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'contradicted-corrected' THEN 1
--                          WHEN 'changed' THEN 2 WHEN 'unverified' THEN 3
--                          WHEN 'inference' THEN 4 ELSE 5 END, field;
