/*
 * Turns research data into schematic specs for stocks/lib/flow-diagram.js. Pure: no DOM, no fetch,
 * no clock. Three sources, and no step comes from anywhere else:
 *   - curated step lists (stocks/data/schematics.json): every step names the data file and field
 *     it rests on and the verbatim words in that field (checked in ../schematics.test.js);
 *   - what-if answers (a dossier's whatIf[] or the API row) placed on the trust-chain catalogue's
 *     actors and flows: the trigger and the path are the catalogue's, the outcome is the answer's;
 *   - a dossier's `parties` block, drawn as a relationship hub around the programme.
 *
 * UMD-wrapped: window.__rwaSchematics in the browser (needs fmt.js), import/require elsewhere.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaSchematics = factory();
})(this, function () {
    'use strict';

    /** The failure modes that get a drawn sequence on issuer pages and learn articles. */
    const KEY_MODES = [
        'keys-stolen', 'authority-key-compromised', 'custodian-insolvency',
        'issuer-insolvency', 'company-acquired', 'company-delisted'
    ];

    /** What-if statuses that map onto a drawable step colour; not-applicable is said in words instead. */
    const DRAWABLE_ANSWER = ['documented', 'inferred', 'litigated', 'unknown'];

    /**
     * The relationship seats, in drawing order. `seat: true` is drawn even when empty — an empty
     * custodian or transfer-agent seat is itself the finding — everything else only when named.
     * `direction` follows stocks/build-graph.mjs: party-to-programme is 'in', the reverse 'out'.
     */
    const RELATION_ROLES = [
        { key: 'tokenIssuers', relation: 'Issues the token (the legal wrapper)', direction: 'in', seat: true },
        { key: 'securitiesIssuers', relation: null, direction: 'in', seat: false },
        { key: 'tokenizationProviders', relation: 'Runs the tokenization for it', direction: 'in', seat: false },
        { key: 'transferAgents', relation: 'Keeps the share register', direction: 'in', seat: true },
        { key: 'custodians', relation: 'Holds the underlying', direction: 'in', seat: true },
        { key: 'verificationAgents', relation: 'Verifies or audits', direction: 'in', seat: false },
        { key: 'distributors', relation: 'Distributes or lists it', direction: 'in', seat: false },
        { key: 'parents', relation: 'Programme is owned by', direction: 'out', seat: false },
        { key: 'regulators', relation: 'Programme answers to', direction: 'out', seat: false },
        { key: 'audience', relation: 'Offered to', direction: 'out', seat: false }
    ];

    function str(value) {
        if (typeof value !== 'string') return null;
        const text = value.replace(/\s+/g, ' ').trim();
        return text === '' ? null : text;
    }

    function list(value) {
        return Array.isArray(value) ? value : [];
    }

    /**
     * Reads `a.b[2].c[id=x].d` out of an object: dots for keys, [n] for an index, [key=value] for
     * the first array element whose key equals value. Returns undefined for any missing hop.
     */
    function resolvePath(object, path) {
        let at = object;
        const re = /([^.[\]]+)|\[(\d+)\]|\[([^=\]]+)=([^\]]+)\]/g;
        let match;
        while ((match = re.exec(String(path))) !== null) {
            if (at === null || at === undefined) return undefined;
            if (match[1] !== undefined) at = at[match[1]];
            else if (match[2] !== undefined) at = Array.isArray(at) ? at[Number(match[2])] : undefined;
            else at = Array.isArray(at) ? at.find((item) => String(item?.[match[3]]) === match[4]) : undefined;
        }
        return at;
    }

    /** `issuers/x.json#redemption.rails` -> {file: 'issuers/x.json', path: 'redemption.rails'}. */
    function splitRef(ref) {
        const text = str(ref);
        if (text === null || !text.includes('#')) return null;
        const at = text.indexOf('#');
        return { file: text.slice(0, at), path: text.slice(at + 1) };
    }

    /** Lowercased words longer than three letters, for matching a basis against claim quotes. */
    function words(text) {
        return (str(text) ?? '').toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
    }

    /**
     * The claim that backs a dossier field, for a step whose curated source names no document: the
     * claim on the same field whose quote shares the most words with the step's basis (first on a
     * tie). Null when no claim with a URL on that field plainly carries those words.
     */
    function claimFor(dossier, field, basis) {
        const claims = list(dossier?.claims).filter((claim) => claim?.field === field && str(claim?.url) !== null);
        if (claims.length === 0) return null;
        const wanted = [...new Set(words(basis))];
        let best = null;
        let bestScore = 0;
        for (const claim of claims) {
            const quote = new Set(words(claim.quote));
            const score = wanted.filter((word) => quote.has(word)).length;
            if (score > bestScore) {
                best = claim;
                bestScore = score;
            }
        }
        // A claim is attached only when its quote plainly carries the step's words: at least three
        // shared words and a third of the basis. Below that the field is cited as the source
        // instead, because a wrong document link is worse than none.
        return best !== null && bestScore >= 3 && bestScore >= wanted.length / 3 ? best : null;
    }

    /** The first clause of a prose field, cut at a word boundary — a label, never a paragraph. */
    function shortText(value, max) {
        const text = str(value);
        if (text === null) return null;
        const clause = text.split(/[;(]|\. /)[0].trim();
        if (clause.length <= max) return clause;
        const head = clause.slice(0, max);
        return `${head.slice(0, Math.max(head.lastIndexOf(' '), max * 0.6)).replace(/[\s,;:.]+$/, '')}…`;
    }

    function hostOf(url) {
        const match = /^https?:\/\/([^/?#]+)/i.exec(str(url) ?? '');
        return match ? match[1].replace(/^www\./, '') : null;
    }

    /**
     * The published source of one curated step: its own label/url/locator when the curator gave
     * them, else the dossier claim behind the field, else the field itself named as the source.
     * `basis` stays out of the published file (the test reads it from the curated one).
     */
    function publishedSource(source, { dossier = null, issuerName = null } = {}) {
        const ref = splitRef(source?.ref);
        const own = { label: str(source?.label), url: str(source?.url), locator: str(source?.locator) };
        if (own.url === null && ref !== null && ref.file.startsWith('issuers/') && dossier) {
            const claim = claimFor(dossier, ref.path, source?.basis);
            if (claim) {
                return {
                    ref: str(source?.ref),
                    label: own.label ?? hostOf(claim.url) ?? 'Source document',
                    url: claim.url,
                    locator: own.locator ?? str(claim.locator)
                };
            }
        }
        const fallbackLabel = ref === null ? null
            : ref.file.startsWith('issuers/') ? `${issuerName ?? 'Issuer'} dossier (${ref.path})`
                : `RWA Sonar research (${ref.file.replace(/\.json$/, '')})`;
        return { ref: str(source?.ref), label: own.label ?? fallbackLabel, url: own.url, locator: own.locator };
    }

    /** One curated entry as a drawable spec with published sources. */
    function curatedSpec(entry, context = {}) {
        const steps = list(entry?.steps).map((step) => ({
            ...(step?.from !== undefined ? { from: step.from, to: step.to } : {}),
            label: str(step?.label),
            status: str(step?.status) ?? 'unknown',
            source: publishedSource(step?.source, context)
        }));
        return {
            id: str(entry?.id),
            issuer: str(entry?.issuer),
            role: str(entry?.role),
            kind: str(entry?.kind) ?? 'sequence',
            title: str(entry?.title),
            summary: str(entry?.summary),
            ...(Array.isArray(entry?.lanes) ? { lanes: entry.lanes.map((lane) => ({ id: lane.id, label: lane.label })) } : {}),
            steps,
            ...(Array.isArray(entry?.groups) ? { groups: entry.groups } : {}),
            ...(entry?.loopBack ? { loopBack: entry.loopBack } : {}),
            ...(entry?.appliesTo ? { appliesTo: entry.appliesTo } : {}),
            note: str(entry?.note)
        };
    }

    /**
     * Sentences of an answer's outcome, so each becomes a step. Splits after . ! ? before a
     * capital or an opening quote, then re-joins a piece that ended on a short abbreviation
     * ("U.S.", "Inc.", "s.") — a wrong split there would put half a sentence in each step.
     */
    const ABBREVIATION = /(?:\b(?:[A-Z]\.){2,}|\b(?:s|ss|p|pp|cl|art|para|no|nos|Inc|Ltd|Co|Corp|Mr|Ms|Dr|St|vs|approx|e\.g|i\.e|cf|al)\.)$/i;

    function sentences(text, max = 3) {
        const source = str(text);
        if (source === null) return [];
        const pieces = source.split(/(?<=[.!?])\s+(?=[A-Z“"‘'(])/);
        const out = [];
        for (const piece of pieces) {
            const prev = out[out.length - 1];
            if (prev !== undefined && ABBREVIATION.test(prev)) {
                out[out.length - 1] = `${prev} ${piece}`;
            } else out.push(piece);
        }
        if (out.length <= max) return out;
        return [...out.slice(0, max - 1), out.slice(max - 1).join(' ')];
    }

    /** "The token issuer goes bankrupt." from the catalogue question: the event, without the ask. */
    function triggerText(question) {
        const text = str(question);
        if (text === null) return null;
        return text.split(/(?<=[.?])\s+/)[0];
    }

    function actorLabel(catalogue, id) {
        return str(list(catalogue?.actors).find((actor) => actor?.id === id)?.label) ?? id;
    }

    /**
     * The actors a failure travels through to reach the holder, in order: the catalogue flow's
     * stations from the failing actor to the holder. A failure AT the holder (stolen keys) lists
     * the flow's stations instead, since those are the parties who could act on it.
     */
    function whatIfLanes(modeDef, flowDef) {
        const failing = str(modeDef?.actor);
        const path = [str(flowDef?.from), ...list(flowDef?.via).map(str), str(flowDef?.to)].filter((id) => id !== null);
        const unique = (ids) => ids.filter((id, index) => ids.indexOf(id) === index);
        if (failing === null) return ['holder'];
        if (failing === 'holder') return unique(['holder', ...path.filter((id) => id !== 'holder')]);
        const i = path.indexOf(failing);
        const j = path.indexOf('holder');
        if (i < 0 || j < 0) return unique([failing, 'holder']);
        return unique(i <= j ? path.slice(i, j + 1) : path.slice(j, i + 1).reverse());
    }

    /**
     * One what-if answer as a sequence: (1) the catalogue's trigger at the failing actor, (2) its
     * path to the holder along the catalogue flow, (3..) the answer's outcome, one sentence per
     * step, coloured by the answer's status and sourced to its document. The first two steps are
     * `catalogue` — the scenario, not a claim about the issuer. Returns null for a missing mode or
     * a not-applicable/missing answer, which callers say in words rather than draw.
     *
     * `answer` may be a dossier whatIf[] entry or a normalised API row (whatif-render.js); both
     * carry mode, status, outcome, url and locator.
     */
    function whatIfSpec({ mode, answer, catalogue, issuerName = null, issuerSlug = null }) {
        const modeDef = list(catalogue?.failureModes).find((item) => item?.id === mode);
        const status = str(answer?.status);
        if (!modeDef || !DRAWABLE_ANSWER.includes(status)) return null;
        const outcome = sentences(answer?.outcome);
        if (outcome.length === 0) return null;
        const flowDef = list(catalogue?.flows).find((flow) => flow?.id === modeDef.flow) ?? null;
        const laneIds = whatIfLanes(modeDef, flowDef);
        const lanes = laneIds.map((id) => ({ id, label: actorLabel(catalogue, id) }));
        const failing = laneIds[0];
        const holderLane = laneIds.includes('holder') ? 'holder' : laneIds[laneIds.length - 1];
        const docSource = {
            label: str(answer?.sourceTitle) ?? hostOf(answer?.url) ?? (status === 'unknown' ? 'Searched; nothing found' : null),
            url: str(answer?.url),
            locator: str(answer?.locator)
        };
        const steps = [{
            from: failing,
            to: failing,
            label: triggerText(modeDef.question),
            status: 'catalogue',
            source: { label: 'Failure-scenario catalogue', url: null, locator: mode }
        }];
        const far = failing === 'holder' ? laneIds[laneIds.length - 1] : holderLane;
        if (far !== failing && flowDef) {
            steps.push({
                from: failing,
                to: far,
                label: failing === 'holder'
                    ? `Who could act on it: the “${str(flowDef.label)}” chain`
                    : `Reaches the holder along “${str(flowDef.label)}”`,
                status: 'catalogue',
                source: { label: 'Trust-chain catalogue', url: null, locator: `flow: ${flowDef.id}` }
            });
        }
        for (const sentence of outcome) {
            steps.push({ from: holderLane, to: holderLane, label: sentence, status, source: docSource });
        }
        const question = str(modeDef.question);
        return {
            id: `${issuerSlug ?? 'issuer'}:whatif:${mode}`,
            issuer: issuerSlug,
            role: 'whatif',
            mode,
            kind: 'sequence',
            title: `What if… ${triggerText(question) ?? mode}`,
            summary: issuerName ? `${issuerName} — answer ${status === 'unknown' ? 'not established' : status}.` : null,
            lanes,
            steps,
            note: null
        };
    }

    /** Distinct party names of one parties list, in order. */
    function partyNames(parties) {
        const names = [];
        for (const party of list(parties)) {
            const name = str(party?.name);
            if (name !== null && !names.includes(name)) names.push(name);
        }
        return names;
    }

    /**
     * Who contracts with whom, as a hub around the programme: each named role in the dossier's
     * `parties` block is a spoke with its relation. The securities issuer is the company issuing
     * the very share only for a registered-share programme; for every other form the company is
     * merely referenced (same rule as stocks/build-graph.mjs). A spoke's source is the dossier claim
     * on `parties.<role>` when there is one, else the first party's own cited source.
     */
    function relationshipSpec(issuer) {
        const parties = issuer?.parties && typeof issuer.parties === 'object' ? issuer.parties : {};
        const registered = issuer?.legalForm === 'registered-share';
        const spokes = [];
        for (const role of RELATION_ROLES) {
            const entries = list(parties[role.key]);
            const names = partyNames(entries);
            // A registered-share programme has no separate token issuer: the company issues the share.
            const seat = role.seat && !(registered && role.key === 'tokenIssuers');
            if (names.length === 0 && !seat) continue;
            const relation = role.key === 'securitiesIssuers'
                ? (registered ? 'Company that issues the share itself' : 'Company whose price is tracked (not a party)')
                : role.relation;
            const direction = role.key === 'securitiesIssuers' && !registered ? 'out' : role.direction;
            const claim = list(issuer?.claims).find((item) => item?.field === `parties.${role.key}` && str(item?.url) !== null);
            const firstSource = entries.map((party) => str(party?.source)).find((url) => url !== null && /^https?:/i.test(url)) ?? null;
            const url = str(claim?.url) ?? firstSource;
            spokes.push({
                role: role.key,
                relation,
                direction,
                names,
                status: names.length === 0 ? 'unknown' : url !== null ? 'documented' : 'inferred',
                source: names.length === 0
                    ? { label: 'No party named in the dossier', url: null, locator: `parties.${role.key}` }
                    : { label: hostOf(url) ?? 'Dossier', url, locator: str(claim?.locator) ?? `parties.${role.key}` }
            });
        }
        return {
            id: `${str(issuer?.slug) ?? 'issuer'}:relationships`,
            issuer: str(issuer?.slug),
            role: 'relationships',
            kind: 'hub',
            title: `${str(issuer?.name) ?? 'Programme'}: who is involved`,
            summary: 'Every party the dossier names, and how it relates to the programme.',
            centre: {
                label: str(issuer?.name) ?? 'Programme',
                // The token issuer's own name, not the dossier's issuingEntity paragraph.
                sub: [partyNames(parties.tokenIssuers)[0] ?? null,
                    str(list(parties.tokenIssuers)[0]?.jurisdiction)].filter(Boolean).join(' · ')
                    || shortText(issuer?.entityJurisdiction, 70)
            },
            spokes
        };
    }

    /**
     * The published schematics file: per issuer its curated redemption and creation flows, its
     * relationship hub and its key what-if sequences; plus the DeFi schematics. Deterministic —
     * issuers sorted by slug, no clock — so a rebuild from the same data is byte-identical.
     *
     * `dossiers` maps issuer slug -> dossier object (parties, claims, whatIf, legalForm) and
     * `names` issuer slug -> display name (the built catalogue's, since a dossier's `issuer` field
     * is a paragraph, not a name).
     */
    function buildSchematics({ curated, dossiers, catalogue, names = {} }) {
        const bySlug = dossiers instanceof Map ? dossiers : new Map(Object.entries(dossiers ?? {}));
        const slugs = [...bySlug.keys()].sort();
        const entries = list(curated?.diagrams);
        const issuers = {};
        for (const slug of slugs) {
            const dossier = bySlug.get(slug);
            const name = str(names?.[slug]) ?? slug;
            const context = { dossier, issuerName: name };
            const mine = entries.filter((entry) => entry?.issuer === slug);
            const whatIf = [];
            for (const mode of KEY_MODES) {
                const answer = list(dossier?.whatIf).find((row) => row?.mode === mode) ?? null;
                const spec = answer ? whatIfSpec({ mode, answer, catalogue, issuerName: name, issuerSlug: slug }) : null;
                if (spec) whatIf.push(spec);
            }
            issuers[slug] = {
                name,
                redemption: mine.filter((entry) => entry.role === 'redemption').map((entry) => curatedSpec(entry, context)),
                creation: mine.filter((entry) => entry.role === 'creation').map((entry) => curatedSpec(entry, context)),
                relationships: relationshipSpec({ ...dossier, slug, name }),
                whatIf
            };
        }
        const defi = entries.filter((entry) => entry?.role === 'defi').map((entry) => {
            const dossier = bySlug.get(entry.issuer) ?? null;
            return curatedSpec(entry, { dossier, issuerName: str(names?.[entry.issuer]) ?? entry.issuer });
        });
        return { version: 1, keyModes: KEY_MODES, issuers, defi };
    }

    /** Every drawable spec in a built schematics file, keyed by id — for the page hooks. */
    function indexSpecs(built) {
        const index = new Map();
        for (const [, entry] of Object.entries(built?.issuers ?? {})) {
            for (const spec of [...list(entry?.redemption), ...list(entry?.creation), ...list(entry?.whatIf)]) {
                if (spec?.id) index.set(spec.id, spec);
            }
            if (entry?.relationships?.id) index.set(entry.relationships.id, entry.relationships);
        }
        for (const spec of list(built?.defi)) if (spec?.id) index.set(spec.id, spec);
        return index;
    }

    /**
     * The specs one page placeholder token names: a spec id, `issuer:<slug>` (that issuer's
     * redemption, creation and relationship figures) or `whatif:<mode>:<slug>`. Null when the built
     * file holds nothing for it, so the page can say so rather than draw nothing silently.
     */
    function specsForToken(built, token) {
        const text = str(token);
        if (text === null) return null;
        if (text.startsWith('issuer:')) {
            const entry = built?.issuers?.[text.slice(7)];
            if (!entry) return null;
            return [...list(entry.redemption), ...list(entry.creation), ...(entry.relationships ? [entry.relationships] : [])];
        }
        if (text.startsWith('whatif:')) {
            const [, mode, slug] = text.split(':');
            const spec = list(built?.issuers?.[slug]?.whatIf).find((item) => item?.mode === mode);
            return spec ? [spec] : null;
        }
        const spec = indexSpecs(built).get(text);
        return spec ? [spec] : null;
    }

    return {
        KEY_MODES,
        RELATION_ROLES,
        resolvePath,
        splitRef,
        claimFor,
        publishedSource,
        curatedSpec,
        sentences,
        triggerText,
        whatIfLanes,
        whatIfSpec,
        relationshipSpec,
        buildSchematics,
        indexSpecs,
        specsForToken
    };
});
