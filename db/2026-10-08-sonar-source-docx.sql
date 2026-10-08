-- Add Word document sources without changing existing kinds or rows.
BEGIN;
SET LOCAL client_min_messages = warning;
DO $$
BEGIN
    IF current_user <> 'geo_user' AND pg_has_role(current_user, 'geo_user', 'MEMBER') THEN
        EXECUTE 'SET LOCAL ROLE geo_user';
    END IF;
END
$$;
ALTER TABLE sonar.source DROP CONSTRAINT IF EXISTS source_kind_check;
ALTER TABLE sonar.source ADD CONSTRAINT source_kind_check
    CHECK (kind IN ('pdf', 'docx', 'html', 'api', 'onchain'));
COMMIT;
