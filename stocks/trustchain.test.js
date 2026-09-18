// Unit tests for stocks/lib/trustchain.js — the chain the catalogue describes, the two link
// grades, and the what-if index and validators. Nothing here touches a database, a network or the
// clock. What is under test is what would cost real damage if it broke: a link grading itself
// `documented` on evidence that is only our own reading, a registered-share token showing an empty
// token-issuer seat when the company IS the issuer, a what-if answer claiming a court decided
// something with no case cited, and a catalogue whose cross-references have drifted so that a
// failure mode nobody can reach still counts as answered. The last two suites run over the repo's
// REAL catalogue and REAL dossiers, so a shape change or a malformed research answer fails here.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ANSWER_STATUSES, buildChain, buildNodes, evidenceGrade, isRegulatorUrl,
    isThirdPartyVerification, partiesByRole, stableJson, validateCatalogue, validateWhatIf,
    verificationGrade, whatIfIndex
} from './lib/trustchain.mjs';
import { claimsByField, dossierClaims } from './lib/evidence.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGUE = JSON.parse(readFileSync(join(REPO, 'stocks', 'data', 'trust-chain.json'), 'utf8'));
const ISSUER_DIR = join(REPO, 'stocks', 'data', 'issuers');

/** One link out of a built chain, by flow id. */
function link(chain, flow) {
    const found = chain.links.find((l) => l.flow === flow);
    if (!found) throw new Error(`no link for flow ${flow}`);
    return found;
}

function node(chain, actor) {
    const found = chain.nodes.find((n) => n.actor === actor);
    if (!found) throw new Error(`no node for actor ${actor}`);
    return found;
}

/**
 * A fixture dossier engineered so that three links land on three different pairs of grades:
 *   transfer  -> documented + onchain      (a confirmed claim; keyGovernance.evidence read on-chain)
 *   security  -> asserted   + self-reported (an unverified claim on the issuer's own site)
 *   voting    -> unknown    + none          (no claim touches `voting` at all)
 * `custodyVerification.type` is deliberately 'none', so nothing is attested and the `none` case is
 * reachable — the attested rules get their own tests below.
 */
const FIXTURE = {
    slug: 'fixture-co',
    legalForm: 'tracker-certificate',
    issuingEntity: 'Fixture Issuer Ltd',
    governingLaw: 'Jersey',
    holderClaim: 'A bearer tracker certificate.',
    underlyingCustodian: 'Fixture Custody AG',
    collateral: { ratio: '1:1', composition: 'underlying-only' },
    custodyVerification: { type: 'none', agent: null, frequency: null },
    securityInterest: { exists: false, holder: null, priority: null },
    bankruptcyRemote: null,
    redemption: { available: true, eligibility: 'Any holder', rails: 'USDC', fees: '0.5%', kyc: true },
    transferRestrictions: {
        allowlist: false, kycToHold: false, usPersonsExcluded: true, mechanism: 'permanent-delegate'
    },
    tokenProgram: 'token-2022',
    knownExtensions: ['permanentDelegate', 'scaledUiAmount'],
    dividends: 'reinvested',
    voting: 'none',
    corporateActions: 'Mirrored by a multiplier.',
    pricing: { referenceMarket: 'exchange-nbbo', arbitrageable: true },
    venues: ['Kraken'],
    chains: ['Solana'],
    keyGovernance: {
        mint: 'multisig',
        freeze: 'multisig',
        delegate: 'hot-key',
        rebase: 'hot-key',
        evidence: 'Authorities read on-chain from the mint account on 2026-09-10: 2-of-3 multisig.'
    },
    parties: {
        securitiesIssuers: [
            { name: 'Fixture Corp', role: 'security-issuer', jurisdiction: 'Delaware', identifier: 'CIK 1', note: 'x' }
        ],
        tokenIssuers: [
            { name: 'Fixture Issuer Ltd', role: 'token-issuer', jurisdiction: 'Jersey', identifier: '', note: 'x' }
        ],
        custodians: [
            { name: 'Fixture Custody AG', role: 'custodian', jurisdiction: 'Switzerland', identifier: '', note: 'x' }
        ],
        transferAgents: [],
        distributors: [{ name: 'Kraken', role: 'distributor', jurisdiction: '', identifier: '' }]
    },
    claims: [
        {
            field: 'transferRestrictions.mechanism',
            status: 'confirmed',
            quote: 'The Issuer may transfer any Token by exercise of the Permanent Delegate.',
            url: 'https://fixture.example/terms',
            locator: 'clause 9.2',
            accessedAt: '2026-09-10T00:00:00Z'
        },
        {
            field: 'securityInterest.exists',
            status: 'unverified',
            quote: 'No security interest is granted over the Underlyings.',
            url: 'https://fixture.example/terms',
            locator: 'clause 4',
            accessedAt: '2026-09-10T00:00:00Z'
        }
    ]
};

const CHAIN = buildChain(FIXTURE, CATALOGUE);

describe('the real catalogue', () => {
    test('validates — no duplicate id, no dangling cross-reference, every mode carried by a flow', () => {
        expect(validateCatalogue(CATALOGUE)).toEqual([]);
    });

    test('is the 13 actors / 9 flows / 38 modes the dossiers are researched against', () => {
        expect(CATALOGUE.actors).toHaveLength(13);
        expect(CATALOGUE.flows).toHaveLength(9);
        expect(CATALOGUE.failureModes).toHaveLength(38);
    });

    test('validateCatalogue catches a dangling actor reference, a mode no flow carries and a duplicate id', () => {
        const broken = structuredClone(CATALOGUE);
        broken.flows[0].via.push('nonexistent-actor');
        expect(validateCatalogue(broken).join(' ')).toContain('unknown actor "nonexistent-actor"');

        // A mode may legitimately be listed by more than one flow (`attestation-wrong` is carried
        // by both `ownership` and `pricing`), so it only becomes unreachable when EVERY flow drops
        // it — which is what makes "no flow carries it" a real check rather than a spelling test.
        const orphaned = structuredClone(CATALOGUE);
        const dropped = orphaned.failureModes[0].id;
        for (const flow of orphaned.flows) {
            flow.failureModes = flow.failureModes.filter((m) => m !== dropped);
        }
        expect(validateCatalogue(orphaned).join(' '))
            .toContain(`mode ${dropped}: no flow carries it`);

        const duped = structuredClone(CATALOGUE);
        duped.actors.push({ ...duped.actors[0] });
        expect(validateCatalogue(duped).join(' ')).toContain('duplicate id');
    });
});

describe('buildChain nodes', () => {
    test('one node per catalogue actor, in catalogue order', () => {
        expect(CHAIN.nodes.map((n) => n.actor)).toEqual(CATALOGUE.actors.map((a) => a.id));
    });

    test('a party reaches its actor by its own `role`, carrying only the identifying fields', () => {
        expect(node(CHAIN, 'custodian').parties).toEqual([
            { name: 'Fixture Custody AG', role: 'custodian', jurisdiction: 'Switzerland', identifier: null }
        ]);
        // The prose stays in the dossier: a node is the seat, not the research note.
        expect(Object.keys(node(CHAIN, 'custodian').parties[0])).toEqual(
            ['name', 'role', 'jurisdiction', 'identifier']
        );
    });

    test('an actor nobody fills still appears with an empty seat — the gap IS the finding', () => {
        expect(node(CHAIN, 'transfer-agent')).toEqual({
            actor: 'transfer-agent', label: 'Transfer agent', parties: []
        });
        // `security-agent` has no partyRoles at all in the catalogue, so it is always empty.
        expect(node(CHAIN, 'security-agent').parties).toEqual([]);
    });

    test('partiesByRole groups by the entry\'s role, not by the key it sits under', () => {
        const byRole = partiesByRole({
            parties: { anythingAtAll: [{ name: 'X', role: 'custodian' }] }
        });
        expect(byRole.custodian).toHaveLength(1);
        expect(partiesByRole({}).custodian).toBeUndefined();
    });
});

describe('the registered-share rule', () => {
    const registered = {
        ...FIXTURE,
        legalForm: 'registered-share',
        parties: { ...FIXTURE.parties, tokenIssuers: [] }
    };

    test('with no tokenIssuers, a registered-share dossier puts the company in the token-issuer seat', () => {
        const chain = buildChain(registered, CATALOGUE);
        expect(node(chain, 'token-issuer').parties.map((p) => p.name)).toEqual(['Fixture Corp']);
        // The company is still the company: the copy does not move it out of its own seat.
        expect(node(chain, 'company').parties.map((p) => p.name)).toEqual(['Fixture Corp']);
    });

    test('the rule does NOT fire for any other legal form — the seat stays empty', () => {
        const tracker = { ...registered, legalForm: 'tracker-certificate' };
        expect(node(buildChain(tracker, CATALOGUE), 'token-issuer').parties).toEqual([]);
    });

    test('the rule does NOT fire when tokenIssuers is already filled', () => {
        const filled = { ...FIXTURE, legalForm: 'registered-share' };
        expect(node(buildChain(filled, CATALOGUE), 'token-issuer').parties.map((p) => p.name))
            .toEqual(['Fixture Issuer Ltd']);
    });
});

describe('the two link grades', () => {
    test('one link per catalogue flow, with the flow\'s own ends and vias', () => {
        expect(CHAIN.links.map((l) => l.flow)).toEqual(CATALOGUE.flows.map((f) => f.id));
        const ownership = link(CHAIN, 'ownership');
        expect(ownership.from).toBe('company');
        expect(ownership.to).toBe('holder');
        expect(ownership.via).toEqual(['custodian', 'token-issuer', 'token-program']);
    });

    test('a confirmed claim on a chain-state field grades documented + onchain', () => {
        const transfer = link(CHAIN, 'transfer');
        expect(transfer.evidence).toBe('documented');
        expect(transfer.verification).toBe('onchain');
    });

    test('an unverified claim on the issuer\'s own site grades asserted + self-reported', () => {
        const security = link(CHAIN, 'security');
        expect(security.evidence).toBe('asserted');
        expect(security.verification).toBe('self-reported');
    });

    test('a field nobody has claimed anything about grades unknown + none', () => {
        const voting = link(CHAIN, 'voting');
        expect(voting.evidence).toBe('unknown');
        expect(voting.verification).toBe('none');
        expect(voting.fields).toEqual([{ field: 'voting', value: 'none', claimStatus: null }]);
    });

    test('an `inference` claim grades inferred, never documented', () => {
        const byField = claimsByField(dossierClaims('f', {
            claims: [{ field: 'voting', status: 'inference', note: 'no register, so no vote' }]
        }));
        expect(evidenceGrade(['voting'], byField)).toBe('inferred');
    });

    test('an unrecognised status grades asserted — a typo must not read as the source\'s own words', () => {
        const byField = claimsByField(dossierClaims('f', {
            claims: [{ field: 'voting', status: 'confirrmed', quote: 'x' }]
        }));
        // dossierClaims falls back to `unverified` for an unknown status, which is already asserted;
        // grade the raw shape too, so the mapping itself is the thing under test.
        expect(evidenceGrade(['voting'], byField)).toBe('asserted');
        expect(evidenceGrade(['voting'], { voting: [{ field: 'voting', status: 'nonsense' }] })).toBe('asserted');
    });

    test('fields carry the dossier\'s VALUE at the path and the best claim status', () => {
        const transfer = link(CHAIN, 'transfer');
        expect(transfer.fields).toEqual([
            { field: 'transferRestrictions.allowlist', value: false, claimStatus: null },
            { field: 'transferRestrictions.kycToHold', value: false, claimStatus: null },
            { field: 'transferRestrictions.mechanism', value: 'permanent-delegate', claimStatus: 'confirmed' },
            { field: 'keyGovernance.freeze', value: 'multisig', claimStatus: null },
            { field: 'keyGovernance.delegate', value: 'hot-key', claimStatus: null },
            { field: 'knownExtensions', value: ['permanentDelegate', 'scaledUiAmount'], claimStatus: null }
        ]);
    });

    test('a false value is a value, and a missing field is null — never 0 and never "unknown"', () => {
        const security = link(CHAIN, 'security');
        const exists = security.fields.find((f) => f.field === 'securityInterest.exists');
        expect(exists.value).toBe(false);
        const remote = security.fields.find((f) => f.field === 'bankruptcyRemote');
        expect(remote.value).toBeNull();
    });

    test('a summary does not depend on object KEY ORDER — a jsonb round-trip loses it', () => {
        // Postgres jsonb stores keys sorted by length then bytes, so the record the API reads back
        // out of sonar.stock_issuer has different key order from the one the builder had. A plain
        // JSON.stringify in the summary made the API serve a different chain from the built file
        // for exactly that reason; sorting the keys is what makes the two agree.
        const a = { ...FIXTURE, documents: [{ title: 'T', url: 'https://x/a' }] };
        const b = { ...FIXTURE, documents: [{ url: 'https://x/a', title: 'T' }] };
        const summaryOf = (d) => link(buildChain(d, CATALOGUE), 'permission').summary;
        expect(summaryOf(a)).toBe(summaryOf(b));
        expect(summaryOf(a)).toContain('documents=[{"title":"T","url":"https://x/a"}]');
        expect(stableJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
            .toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
    });

    test('summary is the flow, the actors it runs through, and the dossier\'s own values — one line', () => {
        const summary = link(CHAIN, 'security').summary;
        expect(summary).toBe('Security interest: Token issuer → Security agent or trustee → Holder. '
            + 'securityInterest.exists=no');
        expect(summary).not.toContain('\n');
        // A field with no value is left out, not printed as "unknown".
        expect(summary).not.toContain('bankruptcyRemote');
    });
});

describe('verification: attested and onchain', () => {
    const byField = (dossier) => claimsByField(dossierClaims('f', dossier));
    const flow = (id) => CATALOGUE.flows.find((f) => f.id === id);

    test('a third-party custody verification attests a flow that runs through the custodian', () => {
        const attested = { ...FIXTURE, custodyVerification: { type: 'chainlink-por' } };
        expect(verificationGrade(attested, flow('ownership'), ['legalForm'], byField(attested)))
            .toBe('attested');
        // ... and not one that does not run through the custodian or the attestor.
        expect(verificationGrade(attested, flow('permission'), ['legalForm'], byField(attested)))
            .toBe('none');
    });

    test('the issuer\'s own statement is not a third party, so it does not attest anything', () => {
        expect(isThirdPartyVerification({ custodyVerification: { type: 'issuer-statement' } })).toBe(false);
        expect(isThirdPartyVerification({ custodyVerification: { type: 'none' } })).toBe(false);
        expect(isThirdPartyVerification({ custodyVerification: { type: null } })).toBe(false);
        expect(isThirdPartyVerification({})).toBe(false);
        expect(isThirdPartyVerification({ custodyVerification: { type: 'transfer-agent-register' } })).toBe(true);
    });

    test('a claim citing a regulator\'s own host attests the link wherever the flow runs', () => {
        const filed = {
            ...FIXTURE,
            claims: [{
                field: 'regulatoryStatus', status: 'confirmed', quote: 'Registered.',
                url: 'https://www.sec.gov/Archives/edgar/data/1/0001.htm',
                accessedAt: '2026-09-10T00:00:00Z'
            }]
        };
        expect(verificationGrade(filed, flow('permission'), ['regulatoryStatus'], byField(filed)))
            .toBe('attested');
    });

    test('regulator hosts match subdomains, and nothing else does', () => {
        expect(isRegulatorUrl('https://data.sec.gov/submissions/CIK1.json')).toBe(true);
        expect(isRegulatorUrl('https://www.finma.ch/en/')).toBe(true);
        expect(isRegulatorUrl('https://notsec.gov.example.com/x')).toBe(false);
        expect(isRegulatorUrl('https://backed.fi/terms')).toBe(false);
        expect(isRegulatorUrl(null)).toBe(false);
        expect(isRegulatorUrl('not a url')).toBe(false);
    });

    test('an `rpc:` locator is an on-chain reading whatever the field is', () => {
        const read = {
            ...FIXTURE,
            keyGovernance: { ...FIXTURE.keyGovernance, evidence: 'From the issuer FAQ.' },
            claims: [{
                field: 'voting', status: 'confirmed', quote: '—',
                locator: 'rpc:getAccountInfo mint', accessedAt: '2026-09-10T00:00:00Z'
            }]
        };
        expect(verificationGrade(read, flow('voting'), ['voting'], byField(read))).toBe('onchain');
    });

    test('a chain-state field alone is not enough: the evidence has to say it was read on-chain', () => {
        const offchain = {
            ...FIXTURE,
            keyGovernance: { ...FIXTURE.keyGovernance, evidence: 'The issuer FAQ says it is a multisig.' }
        };
        const chain = buildChain(offchain, CATALOGUE);
        expect(link(chain, 'transfer').verification).toBe('self-reported');
        expect(link(chain, 'transfer').evidence).toBe('documented');
    });
});

describe('whatIfIndex', () => {
    test('a dossier with no whatIf counts every catalogue mode as missing', () => {
        const index = whatIfIndex(FIXTURE, CATALOGUE);
        expect(index.entries).toEqual([]);
        expect(index.counts.missing).toBe(38);
        for (const status of ANSWER_STATUSES) expect(index.counts[status]).toBe(0);
        expect(index.byActor.holder.missing).toBe(6);
        expect(index.byActor.company.missing).toBe(8);
    });

    test('an entry gains its mode\'s actor, flow and question, and the counts add up to 38', () => {
        const answered = {
            ...FIXTURE,
            whatIf: [
                { mode: 'keys-stolen', status: 'inferred', outcome: 'Gone.', accessedAt: '2026-09-18T00:00:00Z' },
                { mode: 'voting-rights', status: 'documented', outcome: 'No vote.', quote: 'No voting rights.', url: 'https://f/x', accessedAt: '2026-09-18T00:00:00Z' },
                { mode: 'dividend-missing', status: 'not-applicable', outcome: 'None paid.', note: 'The underlying pays no dividend.' }
            ]
        };
        const index = whatIfIndex(answered, CATALOGUE);
        expect(index.entries[0]).toMatchObject({ mode: 'keys-stolen', actor: 'holder', flow: 'transfer' });
        expect(index.entries[0].question).toContain('private keys are stolen');
        expect(index.counts).toEqual({
            documented: 1, inferred: 1, litigated: 0, unknown: 0, 'not-applicable': 1, missing: 35
        });
        const total = Object.values(index.counts).reduce((a, b) => a + b, 0);
        expect(total).toBe(CATALOGUE.failureModes.length);
        expect(index.byActor.holder).toEqual({
            documented: 0, inferred: 1, litigated: 0, unknown: 0, 'not-applicable': 0, missing: 5
        });
        expect(index.byActor.company).toEqual({
            documented: 1, inferred: 0, litigated: 0, unknown: 0, 'not-applicable': 1, missing: 6
        });
    });

    test('an entry naming a mode the catalogue does not have keeps null actor/flow/question', () => {
        const index = whatIfIndex({ whatIf: [{ mode: 'invented', status: 'inferred' }] }, CATALOGUE);
        expect(index.entries[0]).toMatchObject({ actor: null, flow: null, question: null });
        expect(index.counts.inferred).toBe(1);
        expect(index.counts.missing).toBe(38);
    });
});

describe('validateWhatIf', () => {
    const good = {
        mode: 'keys-stolen',
        status: 'documented',
        outcome: 'The tokens are gone; there is no reissuance.',
        quote: 'The Issuer shall have no obligation to replace lost or stolen Tokens.',
        url: 'https://fixture.example/terms',
        locator: 'clause 12',
        accessedAt: '2026-09-18T10:00:00Z',
        cases: [],
        searched: []
    };

    test('a well-formed entry has no problems, and an empty list is valid', () => {
        expect(validateWhatIf([good], CATALOGUE)).toEqual([]);
        expect(validateWhatIf([], CATALOGUE)).toEqual([]);
        expect(validateWhatIf(null, CATALOGUE)).toEqual([]);
    });

    test('an unknown mode id is rejected', () => {
        const out = validateWhatIf([{ ...good, mode: 'meteor-strike' }], CATALOGUE);
        expect(out.join(' ')).toContain('unknown failure mode id');
    });

    test('a duplicate mode is rejected, naming the entry it duplicates', () => {
        const out = validateWhatIf([good, { ...good, quote: 'other' }], CATALOGUE);
        expect(out.join(' ')).toContain('duplicate of whatIf[0]');
    });

    test('a status outside the five is rejected', () => {
        const out = validateWhatIf([{ ...good, status: 'probably-fine' }], CATALOGUE);
        expect(out.join(' ')).toContain('is not one of documented | inferred | litigated | unknown | not-applicable');
        expect(validateWhatIf([{ ...good, status: null }], CATALOGUE).join(' ')).toContain('is not one of');
    });

    test('`documented` with neither quote nor url is rejected', () => {
        const out = validateWhatIf([{ ...good, quote: null, url: null }], CATALOGUE);
        expect(out.join(' ')).toContain('`documented` needs a quote or a url');
    });

    test('`litigated` needs a quote or url AND a non-empty cases[], each case with name and url', () => {
        const noCases = validateWhatIf([{ ...good, status: 'litigated' }], CATALOGUE);
        expect(noCases.join(' ')).toContain('`litigated` needs a non-empty `cases`');

        const badCase = validateWhatIf([{
            ...good, status: 'litigated', cases: [{ court: 'SDNY', date: '2024-01-01' }]
        }], CATALOGUE);
        expect(badCase.join(' ')).toContain('cases[0] has no `name`');
        expect(badCase.join(' ')).toContain('cases[0] has no `url`');

        const ok = validateWhatIf([{
            ...good,
            status: 'litigated',
            cases: [{ name: 'SEC v. Fixture', court: 'SDNY', date: '2024-01-01', url: 'https://www.sec.gov/x', holding: 'x' }]
        }], CATALOGUE);
        expect(ok).toEqual([]);
    });

    test('`unknown` needs a non-empty searched[] — the gap is only evidence if it says where we looked', () => {
        const out = validateWhatIf([{ ...good, status: 'unknown', quote: null, url: null }], CATALOGUE);
        expect(out.join(' ')).toContain('needs a non-empty `searched`');
        expect(validateWhatIf([{
            ...good, status: 'unknown', quote: null, url: null, searched: ['https://fixture.example/terms']
        }], CATALOGUE)).toEqual([]);
    });

    test('a missing or unparseable accessedAt is rejected on every status that rests on a reading', () => {
        expect(validateWhatIf([{ ...good, accessedAt: null }], CATALOGUE).join(' '))
            .toContain('no `accessedAt`');
        expect(validateWhatIf([{ ...good, accessedAt: 'last Tuesday' }], CATALOGUE).join(' '))
            .toContain('is not a parseable timestamp');
        // `not-applicable` is the one answer where nothing was read: it needs a note instead.
        expect(validateWhatIf([{
            mode: 'dividend-missing', status: 'not-applicable', outcome: 'No dividend exists.',
            note: 'A perpetual with no distribution.'
        }], CATALOGUE)).toEqual([]);
        expect(validateWhatIf([{
            mode: 'dividend-missing', status: 'not-applicable', outcome: 'No dividend exists.'
        }], CATALOGUE).join(' ')).toContain('needs a `note`');
    });

    test('a missing outcome is rejected on every status', () => {
        for (const status of ANSWER_STATUSES) {
            const out = validateWhatIf([{ ...good, status, outcome: null }], CATALOGUE);
            expect(out.join(' ')).toContain('no `outcome`');
        }
    });

    test('cases or searched given as something other than an array is rejected', () => {
        expect(validateWhatIf([{ ...good, searched: 'the terms' }], CATALOGUE).join(' '))
            .toContain('`searched` is string, expected an array');
    });
});

// --- the real dossiers ------------------------------------------------------------------------
// The research agents write `whatIf[]` into the dossiers by hand. These two suites are what makes
// that output checked rather than trusted: every answer must satisfy the same schema, and every
// dossier must produce a chain.

const DOSSIERS = readdirSync(ISSUER_DIR).filter((f) => f.endsWith('.json')).sort()
    .map((file) => ({
        slug: file.replace(/\.json$/, ''),
        dossier: JSON.parse(readFileSync(join(ISSUER_DIR, file), 'utf8'))
    }));

describe('every real dossier', () => {
    test('there are dossiers to check at all', () => {
        expect(DOSSIERS.length).toBeGreaterThanOrEqual(12);
    });

    test.each(DOSSIERS.map(({ slug, dossier }) => [slug, dossier]))(
        '%s: its whatIf[] answers are well formed (empty array of problems)',
        (slug, dossier) => {
            expect(validateWhatIf(dossier.whatIf ?? null, CATALOGUE)).toEqual([]);
        }
    );

    test.each(DOSSIERS.map(({ slug, dossier }) => [slug, dossier]))(
        '%s: builds a chain with every actor and every flow, and grades every link',
        (slug, dossier) => {
            const chain = buildChain({ slug, ...dossier }, CATALOGUE);
            expect(chain.nodes).toHaveLength(CATALOGUE.actors.length);
            expect(chain.links).toHaveLength(CATALOGUE.flows.length);
            for (const l of chain.links) {
                expect(['documented', 'inferred', 'asserted', 'unknown']).toContain(l.evidence);
                expect(['onchain', 'attested', 'self-reported', 'none']).toContain(l.verification);
                expect(l.summary).not.toContain('\n');
                expect(l.summary.length).toBeGreaterThan(0);
            }
            // Every dossier names at least one party, so at least one seat is filled.
            expect(chain.nodes.some((n) => n.parties.length > 0)).toBe(true);
        }
    );
});

describe('the built stocks-issuers.json', () => {
    const BUILT = JSON.parse(readFileSync(join(REPO, 'stocks-issuers.json'), 'utf8'));

    test('every issuer record carries `chain` and `whatIfCounts`', () => {
        expect(BUILT.issuers.length).toBeGreaterThan(0);
        for (const issuer of BUILT.issuers) {
            expect(issuer.chain).toBeTruthy();
            expect(issuer.whatIfCounts).toBeTruthy();
        }
    });

    test('the chain is REBUILDABLE from the stored record — which is what the API route does', () => {
        for (const issuer of BUILT.issuers) {
            const rebuilt = buildChain(issuer, CATALOGUE, { claims: issuer.claims });
            expect(rebuilt).toEqual(issuer.chain);
        }
    });

    test('whatIfCounts sums to the catalogue mode count for every issuer', () => {
        for (const issuer of BUILT.issuers) {
            const total = Object.values(issuer.whatIfCounts).reduce((a, b) => a + b, 0);
            expect(total).toBe(CATALOGUE.failureModes.length);
        }
    });

    test('the full whatIf entries are NOT inlined — the API serves those', () => {
        for (const issuer of BUILT.issuers) expect(issuer.whatIf).toBeUndefined();
    });
});
