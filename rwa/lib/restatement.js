/* Pure rules for restating RWA Sonar's records in Tokenizario's attestation vocabulary ("X says Y about Z"):
 * validation of hand-written restatements, what each party publishes today, recipe checks, the mapping of every
 * attestation and finding instance through rwa/data/attestation-schema-map.json, and database coverage. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaRestatement = factory();
})(this, function () {
    // What the right signer does today with a statement the structure needs, strongest first.
    const STATES = ['onchain', 'published', 'reported', 'not-published', 'unnamed', 'not-checked'];
    // The signer itself already says it, so signing it in Tokenizario would only change the form.
    const SAID_BY_SIGNER = new Set(['onchain', 'published']);
    const FITS = ['good', 'partial', 'poor', 'not-a-token'];
    const PATHS = ['fungible', 'nft', 'none'];
    const ROLES = ['issuer', 'custodian', 'sub-custodian', 'trustee', 'transfer-agent', 'registrar', 'administrator', 'auditor',
        'inspector', 'oracle', 'regulator', 'counsel', 'platform', 'venue', 'distributor', 'insurer', 'appraiser', 'lender',
        'governance', 'holder', 'researcher', 'other'];
    const STANDARDS = ['classic-spl', 'token-2022', 'erc-20', 'hts-nft', 'metaplex-nft', 'other', 'unknown'];
    const PROPOSED_CLAIM_KINDS = ['registered-holding', 'beneficial-interest', 'co-ownership', 'debt-secured', 'debt-unsecured',
        'contingent', 'membership-interest', 'synthetic', 'none'];
    // Values a restatement may use before v3 has them, each tied to the gap that proposes it.
    const PROPOSALS = {
        predicate: { lent: 'reserves-lent', insured: 'insurance', 'authoritative-record': 'authoritative-record', eligibility: 'eligibility' },
        event: { 'legal-opinion': 'legal-opinion', 'court-order': 'court-order', redemption: 'distribution-redemption',
            distribution: 'distribution-redemption', decision: 'governance-decision' }
    };
    const SUBJECT_KEYS = ['researchProducts', 'issuerDossiers', 'catalogueNames', 'mechanisms', 'universeIssuers'];
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const text = (value) => typeof value === 'string' && value.trim().length > 0;

    function validateRestatement(r, { vocabulary, gaps }) {
        const problems = [];
        const fail = (message) => problems.push(`${r && r.id ? r.id : '?'}: ${message}`);
        if (!r || !text(r.id) || !text(r.name)) return ['?: missing id or name'];
        const types = new Map(vocabulary.types.map((t) => [t.id, t]));
        const gapIds = new Set(gaps.gaps.map((g) => g.id));
        if (!r.subjects || SUBJECT_KEYS.some((k) => !Array.isArray(r.subjects[k]))) fail('subjects must list every subject key');
        else if (!SUBJECT_KEYS.some((k) => r.subjects[k].length)) fail('restates no RWA Sonar or Tokenizario record');
        for (const key of ['restatedAt', 'evidenceAsOf']) if (!DATE.test(r[key] || '')) fail(`${key} must be a date`);
        if (!Array.isArray(r.provenance) || !r.provenance.length || r.provenance.some((p) => !text(p.source) || !DATE.test(p.asOf || ''))) fail('provenance needs a source and date per entry');
        if (!PATHS.includes(r.path)) fail(`unknown path ${r.path}`);
        const hp = r.holderPosition || {};
        if (!vocabulary.originKinds.includes(hp.originKind)) fail(`unknown origin kind ${hp.originKind}`);
        if (hp.claimKind !== null && !vocabulary.fungibleDeclaration.claimKinds.includes(hp.claimKind)) fail(`unknown claim kind ${hp.claimKind}`);
        if (hp.proposedClaimKind !== null && !PROPOSED_CLAIM_KINDS.includes(hp.proposedClaimKind)) fail(`unknown proposed claim kind ${hp.proposedClaimKind}`);
        if (!text(hp.legalForm) || !text(hp.says)) fail('holder position needs a legal form and what it says');
        if (!Array.isArray(r.tokens) || r.tokens.some((t) => !text(t.chain) || !STANDARDS.includes(t.standard) || typeof t.readable !== 'boolean')) fail('every token needs a chain, a known standard and readable');
        if (r.path !== 'none' && !(r.tokens || []).length) fail('a token path needs tokens');
        const parties = new Map();
        for (const p of r.parties || []) {
            if (!text(p.id) || !text(p.name) || !ROLES.includes(p.role)) fail(`party ${p.id} needs a name and a known role, not ${p.role}`);
            if (parties.has(p.id)) fail(`duplicate party ${p.id}`);
            parties.set(p.id, p);
        }
        const ids = new Set();
        const statements = r.statements || [];
        if (!statements.length) fail('no statements');
        for (const s of statements) {
            const where = `statement ${s.id}`;
            if (!text(s.id) || ids.has(s.id)) fail(`${where}: missing or duplicate id`);
            ids.add(s.id);
            if (!parties.has(s.signer)) fail(`${where}: unknown signer ${s.signer}`);
            if (!types.has(s.type)) fail(`${where}: ${s.type} is not a v3 type`);
            if (!text(s.about) || !text(s.says)) fail(`${where}: needs about and says`);
            if (!s.today || !STATES.includes(s.today.state) || !text(s.today.where)) fail(`${where}: needs today.state and today.where`);
            for (const g of s.gaps || []) if (!gapIds.has(g)) fail(`${where}: unknown gap ${g}`);
            if (s.predicate !== undefined && s.type !== 'status') fail(`${where}: a predicate belongs to a status`);
            if (s.event !== undefined && s.type !== 'certification') fail(`${where}: an event belongs to a certification`);
            if (s.form !== undefined && (s.type !== 'declaration' || !vocabulary.fungibleDeclaration.purposes.includes(s.form))) fail(`${where}: form is a declaration purpose`);
            for (const [field, known] of [['predicate', vocabulary.statusPredicates], ['event', vocabulary.certificationEvents]]) {
                if (s[field] === undefined || known.includes(s[field])) continue;
                const gap = PROPOSALS[field][s[field]];
                if (!gap) fail(`${where}: ${s[field]} is neither a v3 ${field} nor an allowed proposal`);
                else if (s.proposed !== true || !(s.gaps || []).includes(gap)) fail(`${where}: proposed ${field} ${s[field]} needs proposed: true and gap ${gap}`);
            }
            if (s.proposed === true && s.predicate === undefined && s.event === undefined) fail(`${where}: proposed without a proposed value`);
        }
        for (const s of statements) for (const ref of s.refs || []) if (!ids.has(ref) || ref === s.id) fail(`statement ${s.id}: unknown reference ${ref}`);
        for (const f of r.chainFacts || []) if (!text(f.says) || !DATE.test(f.observedAt || '') || !text(f.source)) fail(`chain fact ${f.id} needs says, observedAt and source`);
        for (const o of r.outside || []) if (!text(o.topic) || !text(o.says)) fail('outside entries need a topic and says');
        if (r.recipe) {
            const ingredients = r.recipe.ingredients || [];
            if (!text(r.recipe.name) || !ingredients.length) fail('recipe needs a name and ingredients');
            for (const i of ingredients) {
                if (!types.has(i.type) || !text(i.label) || !(i.minSigners >= 1) || !['any', 'my-lens', 'credentialed'].includes(i.signers)) fail(`recipe ingredient ${i.label} is malformed`);
                if (i.signers === 'credentialed' && !(i.params && i.params.role)) fail(`recipe ingredient ${i.label} needs a credential role`);
                if (i.matches !== undefined && (!Array.isArray(i.matches) || i.matches.some((id) => !ids.has(id) || !matches(statements.find((s) => s.id === id), { ...i, matches: undefined })))) fail(`recipe ingredient ${i.label} matches a statement that is missing or of another kind`);
            }
        }
        if (!r.verdict || !FITS.includes(r.verdict.fit) || !text(r.verdict.summary)) fail('verdict needs a known fit and a summary');
        if (r.verdict && r.verdict.fit === 'not-a-token' && r.path !== 'none' && r.tokens.length) fail('not-a-token with live tokens');
        return problems;
    }

    // How much of the structure its own parties already say, and in what form.
    function readiness(r) {
        const byState = Object.fromEntries(STATES.map((s) => [s, 0]));
        for (const s of r.statements) byState[s.today.state] += 1;
        const total = r.statements.length;
        const saidBySigner = byState.onchain + byState.published;
        const gaps = [...new Set(r.statements.flatMap((s) => s.gaps || []))].sort();
        const silent = [...new Set(r.statements.filter((s) => !SAID_BY_SIGNER.has(s.today.state)).map((s) => s.signer))];
        return { total, byState, saidBySigner, share: total ? saidBySigner / total : null, gaps, silentParties: silent };
    }

    // An ingredient may name the exact statements that satisfy it (matches), when type and parameters alone would
    // also accept a statement about something else (an aggregate register entry for "an entry for my wallet").
    function matches(statement, ingredient) {
        if (Array.isArray(ingredient.matches) && !ingredient.matches.includes(statement.id)) return false;
        if (statement.type !== ingredient.type) return false;
        const p = ingredient.params || {};
        if (p.predicate && statement.predicate !== p.predicate) return false;
        if (p.event && statement.event !== p.event) return false;
        if (p.form && statement.form !== p.form) return false;
        return true;
    }

    // Would a reader's recipe be met if every party signed what it already says? "said" = the signer says it today;
    // "silent" = the statement is needed but only others report it or nobody publishes it; "absent" = not in the structure.
    function checkRecipe(r) {
        if (!r.recipe) return null;
        const rank = (s) => STATES.indexOf(s.today.state);
        const rows = r.recipe.ingredients.map((ingredient) => {
            const best = r.statements.filter((s) => matches(s, ingredient)).sort((a, b) => rank(a) - rank(b))[0];
            const state = !best ? 'absent' : SAID_BY_SIGNER.has(best.today.state) ? 'said' : 'silent';
            return { label: ingredient.label, state, statement: best ? best.id : null, today: best ? best.today.state : null };
        });
        return { name: r.recipe.name, metIfSigned: rows.every((row) => row.state === 'said'), rows };
    }

    // One attestation or finding instance from the database, restated through the schema map.
    function restateInstance(instance, schemaMap, { catalogue, signer } = {}) {
        const entry = schemaMap.get(instance.schema);
        return {
            schema: instance.schema,
            catalogue: catalogue || (entry ? entry.catalogue : null),
            signer: signer || instance.attestor || instance.observer || null,
            says: instance.statement || instance.summary || instance.quote || null,
            date: instance.attestationDate || instance.observedAt || instance.accessedAt || null,
            link: instance.link && instance.link !== '#' ? instance.link : (instance.url || instance.evidence || null),
            fit: entry ? entry.fit : 'unmapped',
            as: entry ? entry.as || [] : [],
            gaps: entry ? entry.gaps || [] : []
        };
    }

    // Which restatement covers each RWA Sonar record; a record claimed twice is a problem.
    function subjectIndex(restatements) {
        const index = Object.fromEntries(SUBJECT_KEYS.map((k) => [k, new Map()]));
        const problems = [];
        for (const r of restatements) for (const key of SUBJECT_KEYS) for (const subject of r.subjects[key]) {
            if (index[key].has(subject)) problems.push(`${key} ${subject} is restated by both ${index[key].get(subject)} and ${r.id}`);
            else index[key].set(subject, r.id);
        }
        return { index, problems };
    }

    // Every record in the database must resolve to a restatement, and every token through its programme.
    function coverage(index, { researchIds = [], dossierSlugs = [], catalogueNames = [], universe = [] }) {
        const missing = {
            researchProducts: researchIds.filter((id) => !index.researchProducts.has(id)),
            issuerDossiers: dossierSlugs.filter((id) => !index.issuerDossiers.has(id)),
            catalogueNames: catalogueNames.filter((name) => !index.catalogueNames.has(name))
        };
        const tokens = { total: universe.length, restated: 0, byProgramme: {}, unrestated: [] };
        for (const item of universe) {
            const id = item.issuer ? index.universeIssuers.get(item.issuer) : undefined;
            if (!id) { tokens.unrestated.push(item.mint); continue; }
            tokens.restated += 1;
            tokens.byProgramme[id] = (tokens.byProgramme[id] || 0) + 1;
        }
        return { missing, tokens, complete: Object.values(missing).every((list) => !list.length) && !tokens.unrestated.length };
    }

    // Which programmes and schemas run into each gap: the evidence behind each vocabulary improvement.
    function gapUse(gaps, restatements, schemaEntries) {
        return gaps.gaps.map((g) => ({
            id: g.id, title: g.title, priority: g.priority,
            programmes: restatements.filter((r) => r.statements.some((s) => (s.gaps || []).includes(g.id))).map((r) => r.id),
            statements: restatements.reduce((n, r) => n + r.statements.filter((s) => (s.gaps || []).includes(g.id)).length, 0),
            schemas: schemaEntries.filter((e) => (e.gaps || []).includes(g.id)).map((e) => e.schema)
        }));
    }

    return { STATES, SAID_BY_SIGNER, FITS, PATHS, ROLES, STANDARDS, PROPOSALS, PROPOSED_CLAIM_KINDS, SUBJECT_KEYS,
        validateRestatement, readiness, checkRecipe, restateInstance, subjectIndex, coverage, gapUse };
});
