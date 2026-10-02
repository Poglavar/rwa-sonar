-- Keep the conservative overall health verdict, but also expose the independent questions it folds
-- together. Idempotent because the loader applies every DDL file on every refresh.

ALTER TABLE sonar.stock_token ADD COLUMN IF NOT EXISTS market_health text;
ALTER TABLE sonar.stock_token ADD COLUMN IF NOT EXISTS control_health text;
ALTER TABLE sonar.stock_token ADD COLUMN IF NOT EXISTS legal_health text;
ALTER TABLE sonar.stock_token ADD COLUMN IF NOT EXISTS composability_health text;

CREATE INDEX IF NOT EXISTS stock_token_market_health_idx ON sonar.stock_token (market_health);
CREATE INDEX IF NOT EXISTS stock_token_control_health_idx ON sonar.stock_token (control_health);
CREATE INDEX IF NOT EXISTS stock_token_legal_health_idx ON sonar.stock_token (legal_health);
CREATE INDEX IF NOT EXISTS stock_token_composability_health_idx ON sonar.stock_token (composability_health);
