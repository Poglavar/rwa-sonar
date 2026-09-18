-- `sonar.failure_mode` and `sonar.what_if` (stocks/data/trust-chain.json, stocks/EVIDENCE.md
-- "Trust chain and what-if"): the 38 questions every issuer is asked about what happens when
-- something goes wrong, and each issuer's answer to each of them. `failure_mode` is the shared
-- catalogue — one row per question, so the SAME question is asked of every issuer and a gap shows
-- as a gap; `what_if` is one row per (issuer, mode) answer, with the source's own words, the
-- locator that finds them again and, when a court decided the case, the cases it cites.
--
-- Written by stocks/load-db.mjs (--only=whatif) from stocks/data/trust-chain.json and every
-- dossier's `whatIf[]`. A mode with no answer has NO ROW: the absence is the finding, and the API
-- reports it as `status: 'missing'` rather than storing an invented row that says "we don't know"
-- — those two are different answers (`unknown` means we looked and the documents do not say, and
-- it has to say where we looked).
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
-- The catalogue. `actor` and `flow` are the trust-chain actor and rights flow the mode belongs
-- to; they are plain text rather than foreign keys because the actor and flow lists live in
-- stocks/data/trust-chain.json and are read by the page and the builders, not stored as tables —
-- there is nothing for a key to reference, and inventing two more tables to hold 13 and 9 labels
-- would put the catalogue in two places.
--
-- `ord` is the mode's position in the catalogue file, which is the order every page and every API
-- response lists them in. Taken from the file, never from an id sort: the file groups the modes by
-- actor (holder first, then the venue, the token program, the issuer …), and an alphabetical sort
-- would scatter that grouping.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.failure_mode (
    id         text PRIMARY KEY,
    actor      text NOT NULL,
    flow       text NOT NULL,
    question   text NOT NULL,
    look_for   text,
    ord        int  NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS failure_mode_actor_idx ON sonar.failure_mode (actor);
CREATE INDEX IF NOT EXISTS failure_mode_flow_idx  ON sonar.failure_mode (flow);
CREATE INDEX IF NOT EXISTS failure_mode_ord_idx   ON sonar.failure_mode (ord);

COMMENT ON TABLE sonar.failure_mode IS
    'The shared catalogue of failure modes from stocks/data/trust-chain.json: one question per row, asked of every issuer.';
COMMENT ON COLUMN sonar.failure_mode.actor IS 'trust-chain actor id (holder, token-program, custodian, …) — the catalogue''s own value';
COMMENT ON COLUMN sonar.failure_mode.flow IS 'trust-chain rights-flow id (transfer, ownership, dividends, …)';
COMMENT ON COLUMN sonar.failure_mode.look_for IS 'what a researcher should look for — the brief, not an answer';
COMMENT ON COLUMN sonar.failure_mode.ord IS 'position in trust-chain.json, which is the display order (never an id sort)';

-- ---------------------------------------------------------------------------------------------
-- The answers. `id` is `<issuer_slug>:<mode>`, so a re-load addresses exactly the same row and
-- one issuer can answer one mode exactly once.
--
-- The three CHECKs below are the evidence discipline of stocks/EVIDENCE.md turned into something
-- the database will not let a loader break, because each of them is a way of claiming more than
-- was found:
--   * `documented` and `litigated` both assert that somebody else's words say this, so at least
--     the quote or the link to them has to be on the row;
--   * `litigated` asserts that a court or regulator DECIDED it, which is worthless without the
--     decision — so `cases` cannot be empty;
--   * `unknown` is only evidence if it says where we looked, which is what `searched` holds. An
--     `unknown` with an empty `searched` is indistinguishable from nobody having tried.
-- `inferred` deliberately needs none of them: it is our reading of the structure, and the note is
-- where the inference chain goes. `not-applicable` needs none either — nothing was read.
--
-- `accessed_at` is the researcher's own reading time from the dossier, never the load clock: a
-- fetch time written as an event time is fabricated data that looks real.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sonar.what_if (
    id          text PRIMARY KEY,
    issuer_slug text NOT NULL,
    mode_id     text NOT NULL REFERENCES sonar.failure_mode(id) ON DELETE CASCADE,
    status      text NOT NULL,
    outcome     text,
    quote       text,
    url         text,
    source_id   text REFERENCES sonar.source(id) ON DELETE SET NULL,
    locator     text,
    accessed_at timestamptz,
    cases       jsonb NOT NULL DEFAULT '[]'::jsonb,
    searched    jsonb NOT NULL DEFAULT '[]'::jsonb,
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT what_if_issuer_mode_key UNIQUE (issuer_slug, mode_id),
    CONSTRAINT what_if_status_check CHECK (status IN (
        'documented', 'inferred', 'litigated', 'unknown', 'not-applicable')),
    CONSTRAINT what_if_cases_is_array_check    CHECK (jsonb_typeof(cases) = 'array'),
    CONSTRAINT what_if_searched_is_array_check CHECK (jsonb_typeof(searched) = 'array'),
    CONSTRAINT what_if_sourced_check CHECK (
        status NOT IN ('documented', 'litigated') OR quote IS NOT NULL OR url IS NOT NULL),
    CONSTRAINT what_if_litigated_has_cases_check CHECK (
        status <> 'litigated' OR jsonb_array_length(cases) > 0),
    CONSTRAINT what_if_unknown_has_searched_check CHECK (
        status <> 'unknown' OR jsonb_array_length(searched) > 0)
);

-- CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a CHANGED constraint
-- has to be re-stated to actually apply on a second run. Drop-then-add is idempotent and is the
-- same pattern db/2026-09-18-sonar-claims.sql uses for exactly this reason.
ALTER TABLE sonar.what_if DROP CONSTRAINT IF EXISTS what_if_sourced_check;
ALTER TABLE sonar.what_if ADD CONSTRAINT what_if_sourced_check CHECK (
    status NOT IN ('documented', 'litigated') OR quote IS NOT NULL OR url IS NOT NULL);
ALTER TABLE sonar.what_if DROP CONSTRAINT IF EXISTS what_if_litigated_has_cases_check;
ALTER TABLE sonar.what_if ADD CONSTRAINT what_if_litigated_has_cases_check CHECK (
    status <> 'litigated' OR jsonb_array_length(cases) > 0);
ALTER TABLE sonar.what_if DROP CONSTRAINT IF EXISTS what_if_unknown_has_searched_check;
ALTER TABLE sonar.what_if ADD CONSTRAINT what_if_unknown_has_searched_check CHECK (
    status <> 'unknown' OR jsonb_array_length(searched) > 0);

CREATE INDEX IF NOT EXISTS what_if_issuer_idx ON sonar.what_if (issuer_slug);
CREATE INDEX IF NOT EXISTS what_if_mode_idx   ON sonar.what_if (mode_id);
CREATE INDEX IF NOT EXISTS what_if_status_idx ON sonar.what_if (status);
CREATE INDEX IF NOT EXISTS what_if_source_idx ON sonar.what_if (source_id);

COMMENT ON TABLE sonar.what_if IS
    'One issuer''s answer to one failure mode: what happens to the holder, in whose words, from which document.';
COMMENT ON COLUMN sonar.what_if.id IS '<issuer_slug>:<mode_id> — deterministic, so a re-load is an upsert';
COMMENT ON COLUMN sonar.what_if.status IS
    'documented (the source''s words) | inferred (our reading) | litigated (a court decided) | unknown (we looked, it does not say) | not-applicable';
COMMENT ON COLUMN sonar.what_if.outcome IS 'what happens to the holder, one to three sentences in OUR words';
COMMENT ON COLUMN sonar.what_if.accessed_at IS 'when the researcher read the source — never the load clock';
COMMENT ON COLUMN sonar.what_if.cases IS 'array of {name, court, date, url, holding} for `litigated`, else []';
COMMENT ON COLUMN sonar.what_if.searched IS 'array of URLs or document titles searched, for `unknown` and `inferred`';
COMMENT ON COLUMN sonar.what_if.source_id IS 'sonar.source row matched on exact URL at load time; null when the registry has no such URL';

-- A table created by some other role in an earlier run would silently break the next
-- `CREATE INDEX IF NOT EXISTS` (DDL needs ownership even when the index already exists), so
-- make ownership explicit and idempotent rather than assuming the SET ROLE above did it.
DO $$
BEGIN
    IF pg_has_role(current_user, 'geo_user', 'MEMBER') OR current_user = 'geo_user' THEN
        EXECUTE 'ALTER TABLE sonar.failure_mode OWNER TO geo_user';
        EXECUTE 'ALTER TABLE sonar.what_if OWNER TO geo_user';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Examples. The queries these two tables exist for.
-- ---------------------------------------------------------------------------------------------
--
-- 1. Which questions nobody can answer: the modes with the fewest answers across issuers.
--
--    SELECT m.id, m.actor, count(w.id)::int AS answered,
--           count(*) FILTER (WHERE w.status = 'documented')::int AS documented
--      FROM sonar.failure_mode m
--      LEFT JOIN sonar.what_if w ON w.mode_id = m.id
--     GROUP BY m.id, m.actor, m.ord
--     ORDER BY answered ASC, m.ord ASC;
--
-- 2. One issuer's answer sheet, catalogue order, gaps included.
--
--    SELECT m.ord, m.actor, m.id, coalesce(w.status, 'missing') AS status, left(w.outcome, 70)
--      FROM sonar.failure_mode m
--      LEFT JOIN sonar.what_if w ON w.mode_id = m.id AND w.issuer_slug = 'xstocks-backed'
--     ORDER BY m.ord;
--
-- 3. Every answer a court decided, with the cases it rests on.
--
--    SELECT w.issuer_slug, w.mode_id, c->>'name' AS case_name, c->>'url' AS case_url
--      FROM sonar.what_if w, jsonb_array_elements(w.cases) AS c
--     WHERE w.status = 'litigated'
--     ORDER BY 1, 2;
--
-- 4. Answers whose source is not in the watch registry, so nothing will ever re-read them.
--
--    SELECT issuer_slug, mode_id, url
--      FROM sonar.what_if
--     WHERE source_id IS NULL AND url IS NOT NULL
--     ORDER BY 1, 2;
--
-- 5. Coverage per issuer: how much of the chain is actually answered.
--
--    SELECT w.issuer_slug, count(*)::int AS answered,
--           count(*) FILTER (WHERE w.status IN ('documented', 'litigated'))::int AS sourced,
--           (SELECT count(*) FROM sonar.failure_mode) - count(*) AS missing
--      FROM sonar.what_if w
--     GROUP BY 1
--     ORDER BY sourced DESC;
