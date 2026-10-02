// Unit tests for stocks/lib/evidence.js — the pure claim/evidence logic shared by the builders,
// the loader and the page. Nothing here touches a database, a file the researchers are editing, or
// a browser: the fixture dossier (fixtures/dossier-claims.sample.json) is the input, precisely
// because the real dossiers gain their `claims[]` arrays one issuer at a time and a test that read
// them today would pass on an empty array and prove nothing.
//
// What is under test is what costs real damage when wrong: a field path that resolves to the wrong
// value (so a claim would be filed against a fact it does not support), a coverage number that
// counts an unverified claim as a source, a `0` where a missing value belongs, and the claim id
// changing between two runs (which would turn every re-load into a duplicate row).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
    CLAIM_FIELDS, bestClaim, claimMethod, claimsByField, compareClaims, dossierClaims, inferenceReviewState,
    evidenceSummary, expandPattern, hasValue, neededFields, normaliseField, parseFieldPath,
    publicClaim, publicClaims, statusRank, valueAtPath
} from './lib/evidence.mjs';

const HERE = import.meta.dirname;
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'dossier-claims.sample.json'), 'utf8'));

describe('parseFieldPath / normaliseField', () => {
    test('a dotted path is its segments', () => {
        expect(parseFieldPath('redemption.rails')).toEqual(['redemption', 'rails']);
        expect(parseFieldPath('vocabulary.blockchainIsMainLedger.value'))
            .toEqual(['vocabulary', 'blockchainIsMainLedger', 'value']);
    });

    test('an array index is a NUMBER, not the string "0"', () => {
        expect(parseFieldPath('products[0]')).toEqual(['products', 0]);
        expect(parseFieldPath('findings[12].quote')).toEqual(['findings', 12, 'quote']);
    });

    test('a quoted bracket segment is accepted, so quoting cannot break a path', () => {
        expect(parseFieldPath('parties["custodians"]')).toEqual(['parties', 'custodians']);
        expect(normaliseField("parties['custodians']")).toBe('parties.custodians');
    });

    test('whitespace and a leading $ are normalised away, so one field is one chip', () => {
        expect(normaliseField('  redemption . rails ')).toBe('redemption.rails');
        expect(normaliseField('$.redemption.rails')).toBe('redemption.rails');
        expect(normaliseField('products[0]')).toBe('products[0]');
    });

    test('an unparseable path is kept as its own text rather than dropped', () => {
        // Losing a claim silently is worse than showing it under an odd key.
        expect(normaliseField('..')).toBe('..');
        expect(parseFieldPath('..')).toEqual([]);
    });

    test('a non-string is not a path', () => {
        expect(parseFieldPath(null)).toEqual([]);
        expect(parseFieldPath(42)).toEqual([]);
        expect(normaliseField(undefined)).toBe('');
    });
});

describe('valueAtPath', () => {
    test('reads nested keys, array indices and vocabulary values off the fixture', () => {
        expect(valueAtPath(FIXTURE, 'redemption.rails'))
            .toBe('USDC, or another mutually agreed form of value.');
        expect(valueAtPath(FIXTURE, 'products[0]')).toBe('tokenized US equities');
        expect(valueAtPath(FIXTURE, 'vocabulary.blockchainIsMainLedger.value')).toBe('yes');
        expect(valueAtPath(FIXTURE, 'parties.custodians')).toEqual(['Unnamed Liechtenstein bank']);
    });

    test('false is a value, not a miss — a researched "no" must not read as absent', () => {
        expect(valueAtPath(FIXTURE, 'bankruptcyRemote')).toBe(false);
        expect(valueAtPath(FIXTURE, 'collateral.onLoanDisclosed')).toBe(false);
    });

    test('a path that does not resolve is null, never 0 and never undefined', () => {
        expect(valueAtPath(FIXTURE, 'redemption.nonesuch')).toBeNull();
        expect(valueAtPath(FIXTURE, 'products[99]')).toBeNull();
        expect(valueAtPath(FIXTURE, 'redemption.rails.deeper')).toBeNull();
        expect(valueAtPath(FIXTURE, 'redemption.kyc')).toBeNull();
        expect(valueAtPath(null, 'a.b')).toBeNull();
    });
});

describe('hasValue', () => {
    test('false and 0 are values; null, "", [] and {} are not', () => {
        expect(hasValue(false)).toBe(true);
        expect(hasValue(0)).toBe(true);
        expect(hasValue(null)).toBe(false);
        expect(hasValue(undefined)).toBe(false);
        expect(hasValue('   ')).toBe(false);
        expect(hasValue([])).toBe(false);
        expect(hasValue({})).toBe(false);
    });
});

describe('claimMethod', () => {
    test('an rpc: or tx locator is an on-chain reading', () => {
        expect(claimMethod('rpc:getAccountInfo 9xQeWv…  mintAuthority')).toBe('onchain');
        expect(claimMethod('tx 5ZHt4gK9…')).toBe('onchain');
        expect(claimMethod('  RPC:getMultipleAccounts')).toBe('onchain');
    });

    test('anything else is a human reading a document', () => {
        expect(claimMethod('p. 41, s. 4.1.1')).toBe('manual');
        expect(claimMethod(null)).toBe('manual');
        expect(claimMethod('')).toBe('manual');
        // "transaction" is not "tx " — the prefix must be the locator's own word.
        expect(claimMethod('transaction log, p. 2')).toBe('manual');
    });
});

describe('dossierClaims', () => {
    const claims = dossierClaims('fixture', FIXTURE);

    test('reads the dossier claims[] and the quoted findings/incidents/attestations', () => {
        const fields = claims.map((c) => c.field);
        expect(fields).toContain('redemption.rails');
        expect(fields).toContain('findings[0]');
        expect(fields).toContain('incidents[0]');
        expect(fields).toContain('attestations[0]');
    });

    test('an entry with no quote is not a claim, so findings[1] is absent', () => {
        expect(claims.map((c) => c.field)).not.toContain('findings[1]');
    });

    test('an INFERENCE with neither a quote nor a URL is KEPT — that is its prescribed shape', () => {
        // Dropping these took 8 real claims (Ondo, Tessera and six on Ventuals) out of the derived
        // list, the coverage counts and sonar.claim with no warning at all. An inference is our
        // reading rather than the source's words, so it HAS no quote and no URL; the note names
        // what it rests on.
        const inference = claims.find((c) => c.field === 'securityInterest.exists');
        expect(inference).toBeDefined();
        expect(inference.status).toBe('inference');
        expect(inference.quote).toBeNull();
        expect(inference.url).toBeNull();
        expect(inference.note).toContain('INFERENCE');
    });

    test('a claim with no quote and no URL is kept whatever its status, as long as it has one', () => {
        const kept = claims.find((c) => c.field === 'dividends');
        expect(kept).toBeDefined();
        expect(kept.status).toBe('unverified');
        expect(kept.quote).toBeNull();
        expect(kept.url).toBeNull();
    });

    test('preserves explicit inference-review fields without treating legacy prose as reviewed', () => {
        const [claim] = dossierClaims('reviewed', { claims: [{ field: 'holderClaim', status: 'inference',
            reasoning: 'The cited register rule controls the answer.', sources: ['https://issuer.example/terms'],
            scope: 'This issuer’s Solana token only', reviewedAt: '2026-09-20T00:00:00Z' }] });
        expect(claim).toMatchObject({ reasoning: 'The cited register rule controls the answer.',
            sources: ['https://issuer.example/terms'], scope: 'This issuer’s Solana token only', reviewedAt: '2026-09-20T00:00:00Z' });
        expect(inferenceReviewState(claim).reviewed).toBe(true);
        expect(inferenceReviewState({ status: 'inference', note: 'INFERENCE: old prose' }).reviewed).toBe(false);
    });

    test('a claim with no STATUS is dropped — nothing downstream could rank it', () => {
        expect(claims.find((c) => c.field === 'voting')).toBeUndefined();
    });

    test('a claim with no field names nothing and is dropped', () => {
        expect(claims.every((c) => c.field !== '')).toBe(true);
    });

    test('a status outside the allowed set falls back to unverified rather than being stored', () => {
        const odd = claims.find((c) => c.field === 'custodyVerification.type');
        expect(odd.status).toBe('unverified');
    });

    test('an attestation\'s own status word ("valid") is not a claim status', () => {
        expect(claims.find((c) => c.field === 'attestations[0]').status).toBe('unverified');
    });

    test('the field path is normalised, so a spaced path indexes with the plain one', () => {
        expect(claims.filter((c) => c.field === 'redemption.eligibility')).toHaveLength(1);
    });

    test('an entry\'s URL is read from whichever key its list uses', () => {
        expect(claims.find((c) => c.field === 'findings[0]').url).toBe('https://fixture.example/tx');
        expect(claims.find((c) => c.field === 'incidents[0]').url).toBe('https://fixture.example/status');
        expect(claims.find((c) => c.field === 'attestations[0]').url)
            .toBe('https://fixture.example/attestation.pdf');
    });

    test('method comes from the locator', () => {
        expect(claims.find((c) => c.field === 'keyGovernance.mint').method).toBe('onchain');
        expect(claims.find((c) => c.field === 'keyGovernance.freeze').method).toBe('onchain');
        expect(claims.find((c) => c.field === 'legalForm').method).toBe('manual');
    });

    test('an inference still counts in the summary, and never as a source', () => {
        const only = claims.filter((c) => c.status === 'inference');
        expect(only.length).toBeGreaterThan(0);
        const summary = evidenceSummary(FIXTURE, only, CLAIM_FIELDS);
        expect(summary.inference).toBe(only.length);
        expect(summary.claims).toBe(only.length);
        // securityInterest.exists is on the need list and has a value in the fixture, so it is
        // NEEDED — but an inference is not a source, so it stays unsourced.
        expect(neededFields(FIXTURE, CLAIM_FIELDS)).toContain('securityInterest.exists');
        expect(summary.coverage.sourced).toBe(0);
    });

    test('a missing claims array yields the quoted entries and no error', () => {
        const { claims: _dropped, ...noClaims } = FIXTURE;
        const out = dossierClaims('fixture', noClaims);
        expect(out.length).toBe(3);
        expect(out.map((c) => c.field)).toEqual(['findings[0]', 'incidents[0]', 'attestations[0]']);
    });

    test('an empty dossier is zero claims, not a throw', () => {
        expect(dossierClaims('fixture', {})).toEqual([]);
        expect(dossierClaims('fixture', null)).toEqual([]);
    });
});

describe('ordering', () => {
    test('trust order puts confirmed first and source-gone last', () => {
        expect(statusRank('confirmed')).toBeLessThan(statusRank('unverified'));
        expect(statusRank('contradicted-corrected')).toBeLessThan(statusRank('unverified'));
        expect(statusRank('unverified')).toBeLessThan(statusRank('inference'));
        expect(statusRank('inference')).toBeLessThan(statusRank('source-gone'));
    });

    test('an unknown status sorts last rather than being treated as good', () => {
        expect(statusRank('made-up')).toBeGreaterThan(statusRank('source-gone'));
    });

    test('same status: the newest access first, so the freshest reading leads', () => {
        const older = { status: 'confirmed', accessedAt: '2026-09-01T00:00:00Z', quote: 'a' };
        const newer = { status: 'confirmed', accessedAt: '2026-09-18T00:00:00Z', quote: 'a' };
        expect(compareClaims(newer, older)).toBeLessThan(0);
    });

    test('claimsByField groups and orders, so the strongest claim leads each field', () => {
        const byField = claimsByField(dossierClaims('fixture', FIXTURE));
        expect(byField['redemption.rails']).toHaveLength(2);
        expect(byField['redemption.rails'][0].status).toBe('confirmed');
        expect(bestClaim(byField['redemption.rails']).status).toBe('confirmed');
    });
});

describe('public claim view', () => {
    test('publishes the corrected current evidence without our superseded interpretation', () => {
        const internal = {
            field: 'holderClaim', status: 'contradicted-corrected', quote: 'Current source words',
            note: 'CORRECTION: we previously misunderstood this field.', url: 'https://example.com'
        };
        const published = publicClaim(internal);
        expect(published).toEqual({ ...internal, status: 'confirmed', note: null });
        expect(internal.status).toBe('contradicted-corrected');
        expect(internal.note).toMatch(/^CORRECTION/);
    });

    test('keeps external source changes visible', () => {
        const changed = { field: 'redemption.rails', status: 'changed', note: 'Issuer changed the terms.' };
        expect(publicClaims([changed])).toEqual([changed]);
        expect(publicClaims(null)).toEqual([]);
    });

    test('drops an explicitly superseded old assertion from publication', () => {
        const old = { field: 'governingLaw', status: 'unverified', note: 'SUPERSEDED: later terms name Panama.' };
        expect(publicClaim(old)).toBeNull();
        expect(publicClaims([old])).toEqual([]);
    });
});

describe('neededFields', () => {
    test('expands a wildcard against the record\'s OWN keys', () => {
        expect(expandPattern(FIXTURE, 'vocabulary.*.value')).toEqual([
            'vocabulary.blockchainIsMainLedger.value',
            'vocabulary.unconditionalTransfers.value'
        ]);
    });

    test('a field with nothing in it does not need a source', () => {
        const fields = neededFields(FIXTURE, CLAIM_FIELDS);
        expect(fields).toContain('redemption.rails');
        // null in the fixture, so there is nothing to quote
        expect(fields).not.toContain('redemption.kyc');
        expect(fields).not.toContain('securityInterest.holder');
        // false IS a researched answer and does need one
        expect(fields).toContain('bankruptcyRemote');
        expect(fields).toContain('collateral.onLoanDisclosed');
    });

    test('the shared list is what is expanded, and it is not empty', () => {
        expect(CLAIM_FIELDS.length).toBeGreaterThan(30);
        expect(CLAIM_FIELDS).toContain('vocabulary.*.value');
        expect(neededFields(FIXTURE, [])).toEqual([]);
    });

    test('a path is needed once however many patterns reach it', () => {
        const fields = neededFields(FIXTURE, ['legalForm', 'legalForm', 'legalForm']);
        expect(fields).toEqual(['legalForm']);
    });
});

describe('evidenceSummary', () => {
    const claims = dossierClaims('fixture', FIXTURE);
    const summary = evidenceSummary(FIXTURE, claims, CLAIM_FIELDS);

    test('counts the claims by status', () => {
        expect(summary.claims).toBe(claims.length);
        expect(summary.confirmed).toBe(claims.filter((c) => c.status === 'confirmed').length);
        expect(summary.corrected).toBe(1);
        expect(summary.inference).toBe(2);
    });

    test('separates strictly reviewed inferences without counting either as sourced evidence', () => {
        const reviewed = { field: 'securityInterest.exists', status: 'inference', reasoning: 'The documented register controls the stated result.',
            sources: [{ url: 'https://issuer.example/terms' }], scope: 'This issuer and token programme', reviewedAt: '2026-09-20T00:00:00Z' };
        const legacy = { field: 'securityInterest.priority', status: 'inference', note: 'INFERENCE: old prose alone.' };
        expect(inferenceReviewState(reviewed)).toMatchObject({ reviewed: true, missing: [] });
        expect(inferenceReviewState({ ...reviewed, reviewedAt: 'not a date' })).toMatchObject({ reviewed: false, missing: ['review date'] });
        const summary = evidenceSummary(FIXTURE, [reviewed, legacy], CLAIM_FIELDS);
        expect(summary).toMatchObject({ inference: 2, inferenceReviewed: 1, inferenceUnreviewed: 1 });
        expect(summary.coverage.sourced).toBe(0);
    });

    test('coverage counts fields with a CONFIRMED claim, not fields with any claim', () => {
        // redemption.eligibility has an unverified claim only, so it is needed and not sourced.
        expect(summary.coverage.needed).toBeGreaterThan(summary.coverage.sourced);
        const sourcedBy = (field) => evidenceSummary(FIXTURE,
            claims.filter((c) => c.field === field), CLAIM_FIELDS).coverage.sourced;
        expect(sourcedBy('redemption.rails')).toBe(1);
        expect(sourcedBy('redemption.eligibility')).toBe(0);
    });

    test('a claim on a field that needs nothing cannot inflate coverage', () => {
        const summaryWithExtra = evidenceSummary(FIXTURE, [
            ...claims,
            { field: 'findings[0]', status: 'confirmed', quote: 'x', accessedAt: null }
        ], CLAIM_FIELDS);
        expect(summaryWithExtra.coverage.sourced).toBe(summary.coverage.sourced);
        expect(summaryWithExtra.coverage.needed).toBe(summary.coverage.needed);
    });

    test('lastCheckedAt is the freshest accessedAt, and null when nothing was accessed', () => {
        expect(summary.lastCheckedAt).toBe('2026-09-18T11:20:00Z');
        expect(evidenceSummary(FIXTURE, [], CLAIM_FIELDS).lastCheckedAt).toBeNull();
    });

    test('does not refresh legal-review time when the source is unavailable', () => {
        const result = evidenceSummary(FIXTURE, [
            { field: 'holderClaim', status: 'confirmed', accessedAt: '2026-09-18T11:20:00Z' },
            { field: 'redemption.rails', status: 'source-gone', accessedAt: '2026-09-22T09:00:00Z' }
        ], CLAIM_FIELDS);
        expect(result.lastCheckedAt).toBe('2026-09-18T11:20:00Z');
    });

    test('no claims at all is a zero summary with a real denominator, not a throw', () => {
        const empty = evidenceSummary(FIXTURE, [], CLAIM_FIELDS);
        expect(empty.claims).toBe(0);
        expect(empty.confirmed).toBe(0);
        expect(empty.coverage.sourced).toBe(0);
        expect(empty.coverage.needed).toBeGreaterThan(20);
    });
});

describe('the real dossiers still parse under these rules', () => {
    // Slice 2 lands while the research pass is still writing claims[] arrays, so this suite must
    // pass on an empty array AND on a full one. What it proves is that nothing in the dossiers
    // makes the shaping throw, and that anything already written is well formed.
    const ISSUERS = join(HERE, 'data', 'issuers');
    const files = readdirSync(ISSUERS).filter((f) => f.endsWith('.json')).sort();

    test.each(files)('%s shapes without throwing', (file) => {
        const dossier = JSON.parse(readFileSync(join(ISSUERS, file), 'utf8'));
        const slug = file.replace(/\.json$/, '');
        const claims = dossierClaims(slug, dossier);
        expect(Array.isArray(claims)).toBe(true);
        for (const claim of claims) {
            expect(claim.field).not.toBe('');
            expect(['manual', 'onchain']).toContain(claim.method);
            // Quote-or-URL is required of everything EXCEPT an inference, which by construction
            // has neither and must instead say what it rests on.
            if (claim.quote === null && claim.url === null) {
                expect(claim.status).not.toBe('confirmed');
            }
        }
        const summary = evidenceSummary(dossier, claims, CLAIM_FIELDS);
        expect(summary.coverage.needed).toBeGreaterThan(0);
        expect(summary.coverage.sourced).toBeLessThanOrEqual(summary.coverage.needed);
    });
});
