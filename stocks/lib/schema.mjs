// The sonar schema files, in the order they must be applied: the claim and what-if tables' foreign
// keys need sonar.source (evidence), the change judgment and case-law files extend the chain
// watcher's change_event, and the source-status file extends sonar.source. stocks/apply-schema.mjs
// applies them; schema.test.js fails when a db/*.sql file is in neither list below.

export const SCHEMA_FILES = [
    '2026-09-17-sonar-stocks.sql',
    '2026-09-18-sonar-evidence.sql',
    '2026-09-18-sonar-claims.sql',
    '2026-09-18-sonar-whatif.sql',
    '2026-09-18-sonar-health-dimensions.sql',
    '2026-09-18-sonar-chain.sql',
    '2026-09-19-sonar-snapshot-history.sql',
    '2026-09-19-sonar-watchlists.sql',
    '2026-09-20-sonar-review-resolutions.sql',
    '2026-09-22-sonar-watch-cardinality.sql',
    '2026-09-22-sonar-focused-watches.sql',
    '2026-09-22-sonar-current-claims.sql',
    '2026-09-23-sonar-source-provenance.sql',
    '2026-09-23-sonar-watch-delivery.sql',
    '2026-09-23-sonar-caselaw.sql',
    '2026-09-23-sonar-change-judgment.sql',
    '2026-09-24-sonar-lending.sql',
    '2026-09-24-sonar-source-unreadable.sql',
    '2026-10-01-sonar-reserves.sql',
    '2026-10-01-sonar-entities.sql',
    '2026-10-01-sonar-corporate-actions.sql',
    '2026-10-01-sonar-regulators.sql',
    '2026-10-01-sonar-powers.sql',
    // Always last: the one statement of the allowed change_event kinds.
    '2026-10-01-sonar-change-event-kinds.sql'
];

/** Files kept for the record but never applied again, with the reason. */
export const SUPERSEDED_SCHEMA_FILES = {
    '2026-09-24-sonar-source-reachable.sql': 'its narrower source status list would fail against `unreadable` rows; '
        + '2026-09-24-sonar-source-unreadable.sql states the same list plus `unreadable`'
};
