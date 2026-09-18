/*
 * The one copy of the trust-chain logic behind stocks/data/trust-chain.json: how a dossier's
 * parties become the chain's NODES (one per catalogue actor), how the catalogue's rights flows
 * become its LINKS with their two grades, how a dossier's `whatIf[]` answers are indexed against
 * the 38 shared failure modes (so a gap is visible AS a gap), and what makes an entry or the
 * catalogue itself malformed. No DOM, no fs, no network, no clock: every function is a pure
 * transform of what it is handed.
 *
 * UMD-wrapped exactly like evidence.js and fmt.js, so the same file serves three callers without
 * a second copy: the browser page (classic script -> window.__rwaTrustChain, which needs
 * evidence.js loaded first), the ESM builders (via trustchain.mjs) and jest (require).
 * Tested in ../trustchain.test.js.
 *
 * ---------------------------------------------------------------------------------------------
 * The two link grades (catalogue `linkGrades`). Neither is ever typed by hand in a dossier: both
 * are computed here from the dossier's claims and the values the link rests on, so a link cannot
 * look firmer than the evidence under it.
 *
 * `evidence` — WHO SAID SO. The best claim status across the flow's `dossierFields`, in the trust
 * order lib/evidence.js defines:
 *     confirmed                                   -> documented  (the source's own words, read)
 *     inference                                   -> inferred    (our reading of the structure)
 *     unverified | contradicted-corrected         -> asserted    (written down, nobody has looked)
 *     changed | source-gone                       -> asserted    (it WAS read; the source moved)
 *     no claim at all                             -> unknown
 *
 * `verification` — HOW IT WAS CHECKED, in this precedence:
 *   1. `onchain`       a claim on one of the flow's fields was read off the ledger
 *                      (`method === 'onchain'`, i.e. an `rpc:`/`tx ` locator), OR the flow rests
 *                      on a field that IS chain state (`keyGovernance.*`, `knownExtensions`,
 *                      `tokenProgram`, `transferRestrictions.mechanism`) and either that field's
 *                      own text or `keyGovernance.evidence` says "on-chain" / "verified on-chain".
 *                      The second half has to exist because the chain reads that back the
 *                      key-governance research are recorded as prose in `keyGovernance.evidence`
 *                      rather than one claim per authority.
 *   2. `attested`      a third party vouches for it: the flow runs through the `attestor` or the
 *                      `custodian` AND `custodyVerification.type` is a third-party type (see
 *                      THIRD_PARTY_VERIFICATION_EXCLUDED), or a claim on the flow's fields cites
 *                      a regulator's own host (REGULATOR_HOSTS).
 *   3. `self-reported` there are claims, but none of them qualifies above.
 *   4. `none`          no claim touches any field this flow rests on.
 *
 * Note that 1 can hold with no claims at all (the on-chain reading is in the evidence prose), so
 * `verification: 'onchain'` beside `evidence: 'unknown'` is a real and meaningful combination:
 * the ledger says what the state is, nobody has quoted a document about it.
 * ---------------------------------------------------------------------------------------------
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./evidence.js'));
    else root.__rwaTrustChain = factory(root.__rwaEvidence);
})(this, function (evidence) {
    const { bestClaim, claimsByField, dossierClaims, hasValue, normaliseField, statusRank, valueAtPath } = evidence;

    /** The five answer statuses a `whatIf[]` entry may carry (catalogue `answerStatuses`). */
    const ANSWER_STATUSES = ['documented', 'inferred', 'litigated', 'unknown', 'not-applicable'];

    /** The four evidence grades and the four verification grades (catalogue `linkGrades`). */
    const EVIDENCE_GRADES = ['documented', 'inferred', 'asserted', 'unknown'];
    const VERIFICATION_GRADES = ['onchain', 'attested', 'self-reported', 'none'];

    /** Claim status -> evidence grade. See the file header for why `changed` grades as `asserted`. */
    const EVIDENCE_BY_CLAIM_STATUS = {
        confirmed: 'documented',
        inference: 'inferred',
        unverified: 'asserted',
        'contradicted-corrected': 'asserted',
        changed: 'asserted',
        'source-gone': 'asserted'
    };

    /**
     * Fields whose value IS on-chain state rather than a document's words. A claim on one of these
     * counts as an on-chain reading when the surrounding evidence prose says it was read there.
     */
    const CHAIN_STATE_FIELDS = new Set(['knownExtensions', 'tokenProgram', 'transferRestrictions.mechanism']);
    const CHAIN_STATE_PREFIX = 'keyGovernance.';

    /** "verified on-chain", "read on-chain", "on-chain multisig" — one pattern covers all of them. */
    const ONCHAIN_TEXT = /on-chain/i;

    /**
     * `custodyVerification.type` values that are NOT a third party vouching for the backing.
     * `issuer-statement` is on this list although the brief's wording did not name it: it is
     * strength 1 in lib/grade.mjs precisely because it is the issuer's own word, and calling that
     * `attested` would make the grade mean nothing. `self-reported` is not a value any dossier
     * uses, but it is the obvious spelling for the same thing and is excluded too.
     */
    const THIRD_PARTY_VERIFICATION_EXCLUDED = new Set(['', 'none', 'unknown', 'self-reported', 'issuer-statement']);

    /**
     * Regulators' own hosts. A claim citing one of these is attested by the regulator's file, not
     * by the issuer. Matched on the host or any subdomain of it (`data.sec.gov` counts), because a
     * bare `.gov` test would also catch a city planning department. One constant, so the list can
     * be extended in one place as dossiers reach new jurisdictions.
     */
    const REGULATOR_HOSTS = [
        'sec.gov',            // US Securities and Exchange Commission (incl. data./efts./www.)
        'finra.org',          // FINRA
        'finma.ch',           // Swiss Financial Market Supervisory Authority
        'fma-li.li',          // FMA Liechtenstein
        'fca.org.uk',         // UK Financial Conduct Authority
        'gov.je',             // Jersey (JFSC filings and the registry)
        'jerseyfsc.org',      // Jersey Financial Services Commission
        'gfsc.gg',            // Guernsey Financial Services Commission
        'gfsc.gi',            // Gibraltar Financial Services Commission
        'bvifsc.vg',          // BVI Financial Services Commission
        'sec.gov.pa',         // Panama Superintendencia del Mercado de Valores
        'supervalores.gob.pa',
        'vara.ae',            // Dubai Virtual Assets Regulatory Authority
        'fincen.gov',
        'esma.europa.eu',
        'mas.gov.sg',
        'cima.ky'
    ];

    /** The longest a value may be inside a one-line link summary before it is cut with an ellipsis. */
    const SUMMARY_VALUE_MAX = 120;

    function str(value) {
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    }

    function list(value) {
        return Array.isArray(value) ? value : [];
    }

    /** The catalogue's three lists, each defaulting to empty so a partial catalogue still loads. */
    function actorsOf(catalogue) { return list(catalogue?.actors); }
    function flowsOf(catalogue) { return list(catalogue?.flows); }
    function modesOf(catalogue) { return list(catalogue?.failureModes); }

    /** `{id: entry}` over a catalogue list; the FIRST entry wins, and duplicates are a validation problem. */
    function byId(items) {
        const index = Object.create(null);
        for (const item of items) {
            const id = str(item?.id);
            if (id !== null && !Object.prototype.hasOwnProperty.call(index, id)) index[id] = item;
        }
        return index;
    }

    // --- nodes ----------------------------------------------------------------------------------

    /**
     * Every party a dossier names, grouped by the party's OWN `role` field (which every entry in
     * every dossier carries, and which is what the catalogue's `partyRoles` names). Grouping by
     * the role rather than by the `parties.<key>` it sits under means a party filed under the
     * wrong key still reaches the right actor.
     */
    function partiesByRole(issuer) {
        const index = Object.create(null);
        const parties = issuer?.parties;
        if (!parties || typeof parties !== 'object') return index;
        for (const value of Object.values(parties)) {
            for (const entry of list(value)) {
                const role = str(entry?.role);
                if (role === null) continue;
                if (!index[role]) index[role] = [];
                index[role].push(entry);
            }
        }
        return index;
    }

    /** The four identifying fields of a party; the prose (`note`, `source`) stays in the dossier. */
    function shapeParty(entry) {
        return {
            name: str(entry?.name),
            role: str(entry?.role),
            jurisdiction: str(entry?.jurisdiction),
            identifier: str(entry?.identifier)
        };
    }

    /**
     * One node per catalogue actor, populated from `issuer.parties.*` by the actor's `partyRoles`.
     * An actor nobody fills still appears, with `parties: []` — an empty seat in the chain is the
     * finding (no transfer agent means the token is not the share, no security agent means holders
     * are unsecured), and dropping the node would hide it.
     *
     * THE REGISTERED-SHARE RULE: for a registered-share token the `token-issuer` IS the company
     * whose stock it is — there is no SPV in between — so those dossiers file the company under
     * `parties.securitiesIssuers` and leave `parties.tokenIssuers` empty. When that is the case
     * (and only then) the security issuers are copied into the `token-issuer` node, keeping their
     * own recorded role, so the node says WHICH company stands behind the token instead of
     * reporting an empty seat that is not empty.
     */
    function buildNodes(issuer, catalogue) {
        const byRole = partiesByRole(issuer);
        const legalForm = str(issuer?.legalForm);
        return actorsOf(catalogue).map((actor) => {
            const roles = list(actor?.partyRoles);
            let entries = [];
            for (const role of roles) entries.push(...list(byRole[role]));
            if (entries.length === 0 && str(actor?.id) === 'token-issuer' && legalForm === 'registered-share') {
                entries = [...list(byRole['security-issuer'])];
            }
            return {
                actor: str(actor?.id),
                label: str(actor?.label),
                parties: entries.map(shapeParty)
            };
        });
    }

    // --- links ----------------------------------------------------------------------------------

    /** Every actor a flow touches: its ends and everything it runs through. */
    function flowActors(flow) {
        const out = [];
        for (const id of [flow?.from, flow?.to, ...list(flow?.via)]) {
            const actor = str(id);
            if (actor !== null && !out.includes(actor)) out.push(actor);
        }
        return out;
    }

    /** The strongest claim on any of these fields, by lib/evidence.js's trust order. */
    function bestAcross(fields, byField) {
        const candidates = [];
        for (const field of fields) {
            const best = bestClaim(byField[normaliseField(field)] || []);
            if (best !== null) candidates.push(best);
        }
        if (candidates.length === 0) return null;
        return candidates.sort((a, b) => statusRank(a?.status) - statusRank(b?.status))[0];
    }

    /** Every claim on any of the flow's fields, flat. */
    function claimsAcross(fields, byField) {
        const out = [];
        for (const field of fields) out.push(...(byField[normaliseField(field)] || []));
        return out;
    }

    function isChainStateField(field) {
        const path = normaliseField(field);
        return path.startsWith(CHAIN_STATE_PREFIX) || CHAIN_STATE_FIELDS.has(path);
    }

    /** A value flattened to the text an "on-chain" test can be run over. Never invents anything. */
    function fieldText(value) {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return value.map(fieldText).join(' ');
        if (value !== null && typeof value === 'object') return Object.values(value).map(fieldText).join(' ');
        return value === null || value === undefined ? '' : String(value);
    }

    /** The host of a URL, lowercased; null when it is not a URL. */
    function hostOf(url) {
        const text = str(url);
        if (text === null) return null;
        try {
            return new URL(text).hostname.toLowerCase();
        } catch {
            return null;
        }
    }

    function isRegulatorUrl(url) {
        const host = hostOf(url);
        if (host === null) return false;
        return REGULATOR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    }

    /** custodyVerification.type names a third party, rather than the issuer or nothing at all. */
    function isThirdPartyVerification(issuer) {
        const type = str(issuer?.custodyVerification?.type);
        if (type === null) return false;
        return !THIRD_PARTY_VERIFICATION_EXCLUDED.has(type.toLowerCase());
    }

    /** The evidence grade of one link. See the file header. */
    function evidenceGrade(fields, byField) {
        const best = bestAcross(fields, byField);
        if (best === null) return 'unknown';
        const grade = EVIDENCE_BY_CLAIM_STATUS[best.status];
        // An unrecognised status is graded `asserted`, not `documented`: a researcher's typo must
        // never make a link look like the source's own words were read.
        return grade === undefined ? 'asserted' : grade;
    }

    /** The verification grade of one link. See the file header for the four rules and their order. */
    function verificationGrade(issuer, flow, fields, byField) {
        const claims = claimsAcross(fields, byField);

        if (claims.some((claim) => claim?.method === 'onchain')) return 'onchain';
        const evidenceText = fieldText(valueAtPath(issuer, 'keyGovernance.evidence'));
        for (const field of fields) {
            if (!isChainStateField(field)) continue;
            const text = `${evidenceText} ${fieldText(valueAtPath(issuer, field))}`;
            if (ONCHAIN_TEXT.test(text)) return 'onchain';
        }

        const actors = flowActors(flow);
        const throughVerifier = actors.includes('attestor') || actors.includes('custodian');
        if (throughVerifier && isThirdPartyVerification(issuer)) return 'attested';
        if (claims.some((claim) => isRegulatorUrl(claim?.url))) return 'attested';

        return claims.length > 0 ? 'self-reported' : 'none';
    }

    /**
     * JSON with object keys in SORTED order, at every depth. Plain JSON.stringify would render the
     * same value two different ways depending on where it came from: a record read back out of a
     * Postgres `jsonb` column has lost its key order (jsonb stores keys sorted by length then
     * bytes), so the API rebuilding a chain from the stored record produced a `documents=[{...}]`
     * summary that differed from the built file's, byte for byte, for no reason anyone could see.
     * Key order is not information here, so the rendering must not depend on it.
     */
    function stableJson(value) {
        if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
        if (value !== null && typeof value === 'object') {
            const keys = Object.keys(value).sort();
            return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
        }
        return JSON.stringify(value) ?? 'null';
    }

    /** One value rendered for a summary line: the value itself, collapsed to one line and cut. */
    function summaryValue(value) {
        let text;
        if (typeof value === 'boolean') text = value ? 'yes' : 'no';
        else if (typeof value === 'number') text = String(value);
        else if (typeof value === 'string') text = value;
        else if (Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')) {
            text = value.map((v) => (v === null ? 'null' : String(v))).join(', ');
        } else text = stableJson(value);
        text = String(text).replace(/\s+/g, ' ').trim();
        return text.length > SUMMARY_VALUE_MAX ? `${text.slice(0, SUMMARY_VALUE_MAX - 1)}…` : text;
    }

    /**
     * One plain-text line per link, assembled from the flow's label, the actors it runs through
     * and the dossier's own values — nothing is inferred or worded for it. A field with no value
     * is left out rather than printed as "unknown", because an absent field and a researched
     * "unknown" are different answers.
     */
    function linkSummary(issuer, flow, nodeLabels, fields) {
        const path = flowActors(flow)
            // from, then via, then to — the order the value actually travels in.
            .sort((a, b) => flowOrder(flow, a) - flowOrder(flow, b))
            .map((actor) => nodeLabels[actor] ?? actor);
        const pairs = [];
        for (const field of fields) {
            const value = valueAtPath(issuer, field);
            if (!hasValue(value)) continue;
            pairs.push(`${normaliseField(field)}=${summaryValue(value)}`);
        }
        const head = `${str(flow?.label) ?? str(flow?.id) ?? 'flow'}: ${path.join(' → ')}`;
        return pairs.length === 0 ? `${head}.` : `${head}. ${pairs.join('; ')}`;
    }

    /** from = 0, via = its position + 1, to = last. */
    function flowOrder(flow, actor) {
        if (str(flow?.from) === actor) return 0;
        const via = list(flow?.via).indexOf(actor);
        if (via >= 0) return via + 1;
        return list(flow?.via).length + 1;
    }

    /**
     * The chain one dossier (or one built issuer record) describes: a node per catalogue actor and
     * a link per catalogue flow, each link graded twice and carrying the fields it rests on.
     *
     * `claims` may be passed when the caller already has the shaped claim list — which the built
     * record does, as `record.claims`. Prefer passing it: running dossierClaims() over a built
     * record counts its quote-bearing findings twice (once from the copied `claims[]`, once from
     * `findings[]` itself). The duplicates carry the same statuses, so no grade moves either way —
     * which is the reason to be explicit rather than to depend on that happening to be true.
     */
    function buildChain(issuer, catalogue, { claims = null } = {}) {
        const shaped = Array.isArray(claims)
            ? claims
            : dossierClaims(str(issuer?.slug), issuer);
        const byField = claimsByField(shaped);
        const nodes = buildNodes(issuer, catalogue);
        const nodeLabels = Object.create(null);
        for (const node of nodes) nodeLabels[node.actor] = node.label;

        const links = flowsOf(catalogue).map((flow) => {
            const fields = list(flow?.dossierFields).map(normaliseField);
            return {
                flow: str(flow?.id),
                label: str(flow?.label),
                from: str(flow?.from),
                to: str(flow?.to),
                via: list(flow?.via).map((v) => str(v)).filter((v) => v !== null),
                evidence: evidenceGrade(fields, byField),
                verification: verificationGrade(issuer, flow, fields, byField),
                fields: fields.map((field) => {
                    const best = bestClaim(byField[field] || []);
                    return {
                        field,
                        value: valueAtPath(issuer, field),
                        // null, never a status string, when nothing is claimed about the field: a
                        // missing claim is not a weak claim.
                        claimStatus: best === null ? null : best.status
                    };
                }),
                summary: linkSummary(issuer, flow, nodeLabels, fields)
            };
        });

        return { nodes, links };
    }

    // --- what-if ---------------------------------------------------------------------------------

    /** An empty count set, every key present so a consumer never has to test for one. */
    function emptyCounts() {
        const counts = {};
        for (const status of ANSWER_STATUSES) counts[status] = 0;
        counts.missing = 0;
        return counts;
    }

    /**
     * One dossier's `whatIf[]` indexed against the catalogue's 38 failure modes: every entry with
     * the mode's actor, flow and question attached, the per-status counts including the modes with
     * NO entry (`missing` — the gap is the point), and the same counts per actor.
     *
     * A dossier with no `whatIf` array is not an error: every one of its modes counts as `missing`,
     * which is exactly what the page and the API should show while the research pass is running.
     *
     * Two deliberate holes, both of them things validateWhatIf() reports as problems rather than
     * hiding here: an entry naming a mode the catalogue does not have keeps `actor`, `flow` and
     * `question` null and is counted in `counts` but under no actor; and an entry whose `status`
     * is not one of the five is counted under no key at all, so the counts stop adding up to the
     * catalogue's mode count — which is the signal.
     */
    function whatIfIndex(issuer, catalogue) {
        const modes = modesOf(catalogue);
        const modeById = byId(modes);
        const raw = list(issuer?.whatIf);

        const entries = raw.map((entry) => {
            const mode = modeById[str(entry?.mode)] ?? null;
            return {
                ...entry,
                actor: mode === null ? null : str(mode.actor),
                flow: mode === null ? null : str(mode.flow),
                question: mode === null ? null : str(mode.question)
            };
        });

        const counts = emptyCounts();
        const byActor = Object.create(null);
        for (const mode of modes) {
            const actor = str(mode?.actor);
            if (actor !== null && !byActor[actor]) byActor[actor] = emptyCounts();
        }

        const answered = new Set();
        for (const entry of entries) {
            const status = str(entry?.status);
            const actor = str(entry?.actor);
            if (status !== null && Object.prototype.hasOwnProperty.call(counts, status)) {
                counts[status] += 1;
                if (actor !== null && byActor[actor]) byActor[actor][status] += 1;
            }
            const mode = str(entry?.mode);
            if (mode !== null) answered.add(mode);
        }

        for (const mode of modes) {
            const id = str(mode?.id);
            if (id === null || answered.has(id)) continue;
            counts.missing += 1;
            const actor = str(mode?.actor);
            if (actor !== null && byActor[actor]) byActor[actor].missing += 1;
        }

        return { entries, counts, byActor };
    }

    // --- validation ------------------------------------------------------------------------------

    /** Is this a non-empty array of objects? `cases` and `searched` both have to be. */
    function nonEmptyArray(value) {
        return Array.isArray(value) && value.length > 0;
    }

    /**
     * Every way a `whatIf[]` entry can be malformed, as a list of problem strings; an empty array
     * means the whole list is valid. Each string names the index and the mode, so a problem can be
     * found in the file without counting braces.
     *
     * `accessedAt` is required on every status EXCEPT `not-applicable`: the other four all rest on
     * something having been read (a clause, a judgment, or the documents that turned out not to
     * say), and a reading with no date cannot be re-checked. `not-applicable` is the one answer
     * where nothing was read, so it must carry a `note` saying why the case cannot arise — which
     * the catalogue's own `answerStatuses` already demands.
     */
    function validateWhatIf(entries, catalogue) {
        const problems = [];
        const list_ = Array.isArray(entries) ? entries : [];
        if (!Array.isArray(entries) && entries !== null && entries !== undefined) {
            return [`whatIf is ${typeof entries}, expected an array`];
        }
        const modeById = byId(modesOf(catalogue));
        const seen = new Map();

        list_.forEach((entry, index) => {
            const mode = str(entry?.mode);
            const where = `whatIf[${index}]${mode === null ? '' : ` (${mode})`}`;
            if (mode === null) {
                problems.push(`${where}: no \`mode\``);
            } else if (!Object.prototype.hasOwnProperty.call(modeById, mode)) {
                problems.push(`${where}: unknown failure mode id`);
            }
            if (mode !== null) {
                if (seen.has(mode)) problems.push(`${where}: duplicate of whatIf[${seen.get(mode)}]`);
                else seen.set(mode, index);
            }

            const status = str(entry?.status);
            if (status === null || !ANSWER_STATUSES.includes(status)) {
                problems.push(`${where}: status ${JSON.stringify(entry?.status ?? null)} is not one of `
                    + ANSWER_STATUSES.join(' | '));
            }

            if (str(entry?.outcome) === null) problems.push(`${where}: no \`outcome\``);

            if (status === 'documented' || status === 'litigated') {
                if (str(entry?.quote) === null && str(entry?.url) === null) {
                    problems.push(`${where}: \`${status}\` needs a quote or a url`);
                }
            }

            if (status === 'litigated') {
                if (!nonEmptyArray(entry?.cases)) {
                    problems.push(`${where}: \`litigated\` needs a non-empty \`cases\``);
                } else {
                    entry.cases.forEach((kase, i) => {
                        if (str(kase?.name) === null) problems.push(`${where}: cases[${i}] has no \`name\``);
                        if (str(kase?.url) === null) problems.push(`${where}: cases[${i}] has no \`url\``);
                    });
                }
            }

            if (status === 'unknown' && !nonEmptyArray(entry?.searched)) {
                problems.push(`${where}: \`unknown\` needs a non-empty \`searched\` — the gap is only `
                    + 'evidence if it says where we looked');
            }

            if (status === 'not-applicable') {
                if (str(entry?.note) === null) {
                    problems.push(`${where}: \`not-applicable\` needs a \`note\` saying why the case cannot arise`);
                }
            } else if (str(entry?.accessedAt) === null) {
                problems.push(`${where}: no \`accessedAt\``);
            } else if (Number.isNaN(Date.parse(entry.accessedAt))) {
                problems.push(`${where}: accessedAt ${JSON.stringify(entry.accessedAt)} is not a parseable timestamp`);
            }

            for (const key of ['cases', 'searched']) {
                if (entry?.[key] !== undefined && entry[key] !== null && !Array.isArray(entry[key])) {
                    problems.push(`${where}: \`${key}\` is ${typeof entry[key]}, expected an array`);
                }
            }
        });

        return problems;
    }

    /**
     * Every way the catalogue itself can be inconsistent: a duplicate id, a flow pointing at an
     * actor that does not exist, a mode naming a flow that does not list it, a mode no flow
     * carries (which would make it unreachable from the chain), an actor role list or field list
     * that is not an array. An empty array means the catalogue is sound.
     */
    function validateCatalogue(catalogue) {
        const problems = [];
        const actors = actorsOf(catalogue);
        const flows = flowsOf(catalogue);
        const modes = modesOf(catalogue);
        if (actors.length === 0) problems.push('catalogue has no `actors`');
        if (flows.length === 0) problems.push('catalogue has no `flows`');
        if (modes.length === 0) problems.push('catalogue has no `failureModes`');

        for (const [name, items] of [['actors', actors], ['flows', flows], ['failureModes', modes]]) {
            const seen = new Set();
            items.forEach((item, index) => {
                const id = str(item?.id);
                if (id === null) {
                    problems.push(`${name}[${index}]: no \`id\``);
                    return;
                }
                if (seen.has(id)) problems.push(`${name}[${index}] (${id}): duplicate id`);
                seen.add(id);
            });
        }

        const actorIds = new Set(actors.map((a) => str(a?.id)).filter((id) => id !== null));
        const flowIds = new Set(flows.map((f) => str(f?.id)).filter((id) => id !== null));
        const modeIds = new Set(modes.map((m) => str(m?.id)).filter((id) => id !== null));

        for (const actor of actors) {
            const id = str(actor?.id) ?? '?';
            if (!Array.isArray(actor?.partyRoles)) problems.push(`actor ${id}: \`partyRoles\` is not an array`);
            if (!Array.isArray(actor?.dossierFields)) problems.push(`actor ${id}: \`dossierFields\` is not an array`);
        }

        const carried = new Set();
        for (const flow of flows) {
            const id = str(flow?.id) ?? '?';
            for (const [role, value] of [['from', flow?.from], ['to', flow?.to]]) {
                const actor = str(value);
                if (actor === null) problems.push(`flow ${id}: no \`${role}\``);
                else if (!actorIds.has(actor)) problems.push(`flow ${id}: \`${role}\` names unknown actor "${actor}"`);
            }
            if (!Array.isArray(flow?.via)) problems.push(`flow ${id}: \`via\` is not an array`);
            for (const actor of list(flow?.via)) {
                if (!actorIds.has(str(actor))) problems.push(`flow ${id}: \`via\` names unknown actor "${actor}"`);
            }
            if (!Array.isArray(flow?.dossierFields)) problems.push(`flow ${id}: \`dossierFields\` is not an array`);
            if (!Array.isArray(flow?.failureModes)) problems.push(`flow ${id}: \`failureModes\` is not an array`);
            for (const mode of list(flow?.failureModes)) {
                const modeId = str(mode);
                if (modeId === null || !modeIds.has(modeId)) {
                    problems.push(`flow ${id}: \`failureModes\` names unknown mode "${mode}"`);
                    continue;
                }
                carried.add(modeId);
            }
        }

        for (const mode of modes) {
            const id = str(mode?.id) ?? '?';
            const actor = str(mode?.actor);
            if (actor === null) problems.push(`mode ${id}: no \`actor\``);
            else if (!actorIds.has(actor)) problems.push(`mode ${id}: \`actor\` names unknown actor "${actor}"`);
            const flow = str(mode?.flow);
            if (flow === null) problems.push(`mode ${id}: no \`flow\``);
            else if (!flowIds.has(flow)) problems.push(`mode ${id}: \`flow\` names unknown flow "${flow}"`);
            else {
                const owner = flows.find((f) => str(f?.id) === flow);
                if (!list(owner?.failureModes).includes(id)) {
                    problems.push(`mode ${id}: its own flow "${flow}" does not list it in \`failureModes\``);
                }
            }
            if (str(mode?.question) === null) problems.push(`mode ${id}: no \`question\``);
        }

        for (const id of modeIds) {
            if (!carried.has(id)) problems.push(`mode ${id}: no flow carries it, so the chain cannot reach it`);
        }

        return problems;
    }

    return {
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
    };
});
