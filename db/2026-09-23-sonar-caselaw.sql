-- Case-law watch tables in schema `sonar` (stocks/watch-caselaw.mjs, next-steps.md "Next
-- engineering iteration" item 2): every court case, RECAP docket and SEC release that names a
-- watched party (`litigation_case`), and every search the watcher ran with when it first and last
-- ran it (`litigation_query`) — the second is what makes "we searched and found nothing" evidence
-- rather than silence. New cases and new docket entries become sonar.change_event rows of the new
-- kind `litigation`, added below. None of this sets a what-if answer to `litigated`: an event is a
-- candidate for a human to read, never a decision.
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
-- Cases. One row per (source, case/docket id); `id` is `<source>:<external id>`, e.g.
-- `courtlistener-r:73511778`, `courtlistener-o:10128187`, `sec-lr:LR-26645`. `date_filed` and
-- `latest_entry` are the SOURCE's own dates; `first_seen_at` / `last_seen_at` are when this watcher
-- saw the row, which is all they claim to be.
--
-- `match_level` is how firmly the case is tied to the watched name: `caption` (in the case name),
-- `party` (a listed party, not in the caption), `text` (only somewhere in the documents).
-- `review_status` comes from stocks/data/caselaw-reviewed.json: `dismissed` rows stay recorded
-- but raise no further events; `confirmed` rows have their docket followed for new entries.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.litigation_case (
    id                 text PRIMARY KEY,
    source             text NOT NULL,
    external_id        text NOT NULL,
    docket_id          bigint,
    case_name          text,
    court              text,
    court_id           text,
    date_filed         date,
    date_terminated    date,
    docket_number      text,
    url                text,
    parties            jsonb NOT NULL DEFAULT '[]'::jsonb,
    match_level        text NOT NULL,
    queries            jsonb NOT NULL DEFAULT '[]'::jsonb,
    issuers            text[] NOT NULL DEFAULT '{}',
    first_seen_at      timestamptz NOT NULL,
    last_seen_at       timestamptz NOT NULL,
    latest_entry       jsonb,
    latest_entry_date  date,
    entries_checked_at timestamptz,
    review_status      text NOT NULL DEFAULT 'candidate',
    review_note        text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT litigation_case_source_check
        CHECK (source IN ('courtlistener-o', 'courtlistener-r', 'sec-lr', 'sec-ap')),
    CONSTRAINT litigation_case_match_check CHECK (match_level IN ('caption', 'party', 'text')),
    CONSTRAINT litigation_case_review_check
        CHECK (review_status IN ('candidate', 'dismissed', 'confirmed'))
);

CREATE INDEX IF NOT EXISTS litigation_case_issuers_idx ON sonar.litigation_case USING gin (issuers);
CREATE INDEX IF NOT EXISTS litigation_case_filed_idx   ON sonar.litigation_case (date_filed DESC);
CREATE INDEX IF NOT EXISTS litigation_case_match_idx   ON sonar.litigation_case (match_level);

COMMENT ON COLUMN sonar.litigation_case.queries IS 'every watched phrase (or known docket) that returned this case';
COMMENT ON COLUMN sonar.litigation_case.latest_entry IS '{date, number, description, url} of the newest RECAP docket entry seen';

-- ---------------------------------------------------------------------------------------------
-- Searches. One row per (source, query): `courtlistener-o` / `courtlistener-r` per phrase,
-- `courtlistener-docket` per known docket, `sec-lr` / `sec-ap` per feed. A query with no row has
-- never run, so its first run is a baseline (hits recorded, no events) — adding a party does not
-- flood the change feed with its decades-old cases.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.litigation_query (
    source       text NOT NULL,
    query        text NOT NULL,
    issuers      text[] NOT NULL DEFAULT '{}',
    origins      jsonb NOT NULL DEFAULT '[]'::jsonb,
    first_run_at timestamptz NOT NULL,
    last_run_at  timestamptz NOT NULL,
    last_total   int,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, query)
);

CREATE INDEX IF NOT EXISTS litigation_query_issuers_idx ON sonar.litigation_query USING gin (issuers);

DO $$
DECLARE
    t text;
BEGIN
    IF pg_has_role(current_user, 'geo_user', 'MEMBER') OR current_user = 'geo_user' THEN
        FOREACH t IN ARRAY ARRAY['litigation_case', 'litigation_query']
        LOOP
            EXECUTE format('ALTER TABLE sonar.%I OWNER TO geo_user', t);
        END LOOP;
    END IF;
END
$$;

-- 2026-09-23: the case-law watcher raises `litigation` events (a new case or a new docket entry
-- naming an issuer's party). Re-stated as DROP+ADD so an existing database picks the wider list
-- up; the same list is carried by db/2026-09-18-sonar-evidence.sql's own restatement, so applying
-- that older file again later cannot narrow the constraint back and reject the stored rows.
ALTER TABLE sonar.change_event DROP CONSTRAINT IF EXISTS change_event_kind_check;
ALTER TABLE sonar.change_event ADD CONSTRAINT change_event_kind_check CHECK (kind IN (
    'legal-term', 'document-gone', 'quote-lost', 'authority-key', 'extension-toggle', 'rebase',
    'supply', 'treasury', 'holder-concentration', 'venue', 'float', 'liquidity', 'metadata', 'status',
    'litigation'));

-- ---------------------------------------------------------------------------------------------
-- Examples.
-- ---------------------------------------------------------------------------------------------
--
-- 1. One issuer's candidates, caption matches first.
--
--    SELECT match_level, date_filed, case_name, court, url
--      FROM sonar.litigation_case
--     WHERE 'securitize-secz' = ANY(issuers) AND review_status <> 'dismissed'
--     ORDER BY CASE match_level WHEN 'caption' THEN 0 WHEN 'party' THEN 1 ELSE 2 END, date_filed DESC;
--
-- 2. What was searched for an issuer, and when (the `searched[]` evidence for an `unknown`).
--
--    SELECT source, query, last_run_at, last_total FROM sonar.litigation_query
--     WHERE 'xstocks-backed' = ANY(issuers) ORDER BY query, source;
--
-- 3. The litigation feed.
--
--    SELECT detected_at, subject_id, severity, summary FROM sonar.change_event
--     WHERE kind = 'litigation' ORDER BY detected_at DESC LIMIT 50;
