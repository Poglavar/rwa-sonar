// The ESM face of the trust-chain helpers for the builders (build-stocks-db.mjs) and the API.
// All the logic lives in ./trustchain.js, which is UMD so the browser page can load the very same
// file; this module adds the one thing a page gets by fetching it instead — TRUST_CHAIN, the
// catalogue from stocks/data/trust-chain.json — and re-exports everything else unchanged, so
// there is exactly one implementation and one catalogue.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import trustchain from './trustchain.js';

/** The shared catalogue, read once at import. A missing or empty file is fatal on purpose: a
 *  chain built against no actors would render as "this issuer has no parties". */
export const TRUST_CHAIN_PATH = join(import.meta.dirname, '..', 'data', 'trust-chain.json');

export const TRUST_CHAIN = JSON.parse(readFileSync(TRUST_CHAIN_PATH, 'utf8'));

for (const key of ['actors', 'flows', 'failureModes']) {
    if (!Array.isArray(TRUST_CHAIN[key]) || TRUST_CHAIN[key].length === 0) {
        throw new Error(`${TRUST_CHAIN_PATH}: expected a non-empty "${key}" array`);
    }
}

export const {
    ANSWER_STATUSES,
    EVIDENCE_GRADES,
    VERIFICATION_GRADES,
    EVIDENCE_BY_CLAIM_STATUS,
    REGULATOR_HOSTS,
    THIRD_PARTY_VERIFICATION_EXCLUDED,
    buildChain,
    buildNodes,
    partiesByRole,
    flowActors,
    evidenceGrade,
    verificationGrade,
    isRegulatorUrl,
    isThirdPartyVerification,
    stableJson,
    summaryValue,
    whatIfIndex,
    validateWhatIf,
    validateCatalogue
} = trustchain;

/** The chain for one record against the shared catalogue (the common call in the builders). */
export function chainFor(issuer, { catalogue = TRUST_CHAIN, claims = null } = {}) {
    return trustchain.buildChain(issuer, catalogue, { claims });
}

/** The what-if index for one record against the shared catalogue. */
export function whatIfFor(issuer, catalogue = TRUST_CHAIN) {
    return trustchain.whatIfIndex(issuer, catalogue);
}

export default trustchain;
