-- Keep superseded research claims for the internal audit trail without serving them as current
-- product evidence. The dossier loader marks the exact currently offered claim set active in one
-- transaction. Existing rows start active; the first post-migration claim load reconciles them.

ALTER TABLE sonar.claim
    ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS claim_active_issuer_field_idx
    ON sonar.claim (active, issuer_slug, field);

COMMENT ON COLUMN sonar.claim.active IS
    'true only while this exact quote/url claim is offered by the current dossier; inactive rows are an internal audit trail';
