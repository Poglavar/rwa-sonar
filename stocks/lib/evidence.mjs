// The ESM face of the claim/evidence helpers for the builders (build-stocks-db.mjs,
// build-cards.mjs, lib/db-load.mjs). All the logic lives in ./evidence.js, which is UMD so the
// browser page can load the very same file; this module adds the one thing a page gets by fetching
// it instead — CLAIM_FIELDS, the field-need list from stocks/data/claim-fields.json — and re-exports
// everything else unchanged, so there is exactly one implementation and one list.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import evidence from './evidence.js';

/** The shared list, read once at import. A missing or malformed file is fatal on purpose: a
 *  coverage number counted against an empty list would read as "0 of 0 fields sourced". */
export const CLAIM_FIELDS_PATH = join(import.meta.dirname, '..', 'data', 'claim-fields.json');

export const CLAIM_FIELDS_FILE = JSON.parse(readFileSync(CLAIM_FIELDS_PATH, 'utf8'));

if (!Array.isArray(CLAIM_FIELDS_FILE.fields) || CLAIM_FIELDS_FILE.fields.length === 0) {
    throw new Error(`${CLAIM_FIELDS_PATH}: expected a non-empty "fields" array`);
}

export const CLAIM_FIELDS = CLAIM_FIELDS_FILE.fields;

export const {
    CLAIM_STATUSES,
    STATUS_RANK,
    UNKNOWN_STATUS_RANK,
    DEFAULT_QUOTE_STATUS,
    statusRank,
    hasValue,
    parseFieldPath,
    normaliseField,
    valueAtPath,
    claimMethod,
    dossierClaims,
    claimsByField,
    compareClaims,
    bestClaim,
    neededFields,
    expandPattern,
    evidenceSummary,
    chipFor
} = evidence;

/** The needed paths for one record against the shared list (the common call in the builders). */
export function needed(record, fields = CLAIM_FIELDS) {
    return evidence.neededFields(record, fields);
}

/** The summary for one record against the shared list. */
export function summarise(record, claims, fields = CLAIM_FIELDS) {
    return evidence.evidenceSummary(record, claims, fields);
}

export default evidence;
