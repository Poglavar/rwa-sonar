/*
 * The one copy of the claim/evidence logic (stocks/EVIDENCE.md §1 and §4): how a dotted field path
 * is parsed and normalised, how a dossier's `claims[]` (plus the quote-bearing findings, incidents
 * and attestations) become one flat list, how those are indexed per field for the "§" chip, and how
 * the coverage summary — sourced fields over fields that need a source — is counted. No DOM, no fs,
 * no network, no clock: every function is a pure transform of what it is handed.
 *
 * UMD-wrapped exactly like fmt.js, so the same file serves three callers without a second copy:
 * the browser page (classic script -> window.__rwaEvidence), the ESM builders (via evidence.mjs,
 * which adds the field-need list read from stocks/data/claim-fields.json) and jest (require).
 * Tested in ../evidence.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaEvidence = factory();
})(this, function () {
    /** The statuses a claim may carry. The first four are human-written in a dossier; the last two
     *  are only ever set by the watcher (stocks/watch-sources.mjs), never by a researcher. */
    const CLAIM_STATUSES = [
        'confirmed', 'contradicted-corrected', 'changed', 'unverified', 'inference', 'source-gone'
    ];

    /**
     * Trust order, lowest rank first: `confirmed` is the source's own words found verbatim;
     * `contradicted-corrected` and `changed` have both been read against the source too, so they
     * outrank `unverified` (nobody has looked since it was written); `inference` has no source
     * words at all, and `source-gone` no longer has a source to read. An unknown status sorts last
     * rather than being silently treated as good.
     */
    const STATUS_RANK = {
        confirmed: 0,
        'contradicted-corrected': 1,
        changed: 2,
        unverified: 3,
        inference: 4,
        'source-gone': 5
    };

    const UNKNOWN_STATUS_RANK = 9;

    /** The status a findings/incidents/attestations quote gets: nobody has re-checked it yet. */
    const DEFAULT_QUOTE_STATUS = 'unverified';

    /** Locator prefixes that make a claim an on-chain reading rather than a document one. */
    const ONCHAIN_LOCATOR = /^(rpc:|tx\s)/i;

    function statusRank(status) {
        return Object.prototype.hasOwnProperty.call(STATUS_RANK, status)
            ? STATUS_RANK[status]
            : UNKNOWN_STATUS_RANK;
    }

    function str(value) {
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    }

    /**
     * Is there anything at this path to source? `false` and `0` are values; `null`, an absent key,
     * an empty string, an empty array and an empty object are not. Never truthiness — `false` is
     * exactly the kind of researched answer ("no, redemption is not available") that needs a quote.
     */
    function hasValue(value) {
        if (value === null || value === undefined) return false;
        if (typeof value === 'string') return value.trim() !== '';
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'object') return Object.keys(value).length > 0;
        return true;
    }

    /**
     * Split a field path into segments: `redemption.rails` -> ['redemption', 'rails'],
     * `products[0]` -> ['products', 0], `vocabulary.titleDeed.value` -> three strings. A bracketed
     * quoted key (`parties["custodians"]`) is accepted too, so a writer cannot break a path by
     * quoting a segment. Returns [] for anything that is not a usable path.
     */
    function parseFieldPath(field) {
        if (typeof field !== 'string') return [];
        let rest = field.trim();
        if (rest.startsWith('$.')) rest = rest.slice(2);
        else if (rest === '$') rest = '';
        const segments = [];
        const token = /^\s*(?:\[\s*(?:"([^"]*)"|'([^']*)'|(\d+))\s*\]|\.?([^.[\]]+))/;
        while (rest !== '') {
            const m = token.exec(rest);
            if (m === null) return [];
            if (m[3] !== undefined) segments.push(Number(m[3]));
            else {
                const key = (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[4]).trim();
                if (key === '') return [];
                segments.push(key);
            }
            rest = rest.slice(m[0].length);
        }
        return segments;
    }

    /**
     * The canonical spelling of a field path, so `  redemption . rails ` and `$.redemption.rails`
     * index to the same chip as `redemption.rails`. An unparseable path comes back as its own
     * trimmed text rather than being dropped — a claim with a strange field is still evidence, and
     * losing it silently would be worse than showing it under an odd key.
     */
    function normaliseField(field) {
        const segments = parseFieldPath(field);
        if (segments.length === 0) return typeof field === 'string' ? field.trim() : '';
        return segments.reduce((acc, segment) => (
            typeof segment === 'number' ? `${acc}[${segment}]` : acc === '' ? segment : `${acc}.${segment}`
        ), '');
    }

    /** The value a field path points at, or null when the path does not resolve. Never 0 for a
     *  missing value: an absent field and a zero are different answers. */
    function valueAtPath(record, field) {
        const segments = parseFieldPath(field);
        if (segments.length === 0) return null;
        let cursor = record;
        for (const segment of segments) {
            if (cursor === null || typeof cursor !== 'object') return null;
            if (typeof segment === 'number') {
                if (!Array.isArray(cursor) || segment >= cursor.length) return null;
                cursor = cursor[segment];
            } else {
                if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return null;
                cursor = cursor[segment];
            }
        }
        return cursor === undefined ? null : cursor;
    }

    /** manual | onchain, from the locator: `rpc:getAccountInfo …` and `tx <sig>` are chain reads,
     *  anything else is a human reading a document. (`extracted` is the watcher's to set.) */
    function claimMethod(locator) {
        const text = str(locator);
        if (text !== null && ONCHAIN_LOCATOR.test(text)) return 'onchain';
        return 'manual';
    }

    /**
     * One claim, shaped and normalised. A status OUTSIDE the allowed set falls back rather than
     * being stored: a researcher's typo must not become a status nothing downstream understands,
     * and dropping the claim over it would lose the evidence silently. A status that is ABSENT is
     * a different thing — see dossierClaims, which refuses such a claim.
     */
    function shapeClaim(slug, raw, field, origin, fallbackStatus) {
        const status = typeof raw?.status === 'string' && CLAIM_STATUSES.includes(raw.status)
            ? raw.status
            : fallbackStatus;
        return {
            issuerSlug: slug,
            subjectType: 'issuer',
            subjectId: slug,
            field: normaliseField(field),
            quote: str(raw?.quote),
            url: str(raw?.url),
            locator: str(raw?.locator),
            accessedAt: str(raw?.accessedAt),
            status,
            method: claimMethod(raw?.locator),
            // `quoteNote` is what the research pass writes on a findings/incidents/attestations
            // entry (a note about the quote, beside the entry's own prose); on a claims[] entry it
            // is plain `note`. Both mean the same thing here, so both are read rather than one of
            // them being silently dropped.
            note: str(raw?.note) ?? str(raw?.quoteNote),
            origin
        };
    }

    /**
     * Where a findings / incidents / attestations entry keeps its URL. Each list named it before
     * the claim shape existed, so all three spellings are read rather than the dossiers rewritten.
     */
    function entryUrl(entry) {
        return str(entry?.url) ?? str(entry?.evidence) ?? str(entry?.source) ?? str(entry?.link);
    }

    /**
     * Every claim one dossier asserts, flat: its own `claims[]` first, then the entries of
     * findings/incidents/attestations that carry a `quote` (field `findings[3]`, `incidents[0]` …),
     * which are claims in everything but name. A dossier with no `claims` array yields the quoted
     * entries and no error — the researchers fill that array issuer by issuer, and a partial pass
     * must load, not fail.
     *
     * A claims[] entry is dropped only when it names no FIELD or carries no STATUS. In particular a
     * claim with neither a quote nor a URL is KEPT: that is the prescribed shape of an
     * `inference` — our reading rather than the source's words, with the note naming what it rests
     * on — and dropping those took 8 real claims (Ondo, Tessera and six on Ventuals) out of the
     * derived list, the coverage counts and sonar.claim without a word of warning. An inference is
     * evidence of how we reasoned; it is shown muted and never counted as a source.
     *
     * A findings/incidents/attestations entry still needs its `quote`, because the quote is the
     * whole of what makes one a claim: the entry itself is already rendered as prose.
     */
    function dossierClaims(slug, dossier) {
        const out = [];
        const own = Array.isArray(dossier?.claims) ? dossier.claims : [];
        own.forEach((raw, index) => {
            const field = str(raw?.field);
            if (field === null) return;
            if (str(raw?.status) === null) return;
            const claim = shapeClaim(slug, raw, field, 'claims', 'unverified');
            claim.index = index;
            out.push(claim);
        });
        for (const list of ['findings', 'incidents', 'attestations']) {
            const items = Array.isArray(dossier?.[list]) ? dossier[list] : [];
            items.forEach((entry, index) => {
                if (str(entry?.quote) === null) return;
                const claim = shapeClaim(
                    slug,
                    { ...entry, url: entryUrl(entry) },
                    `${list}[${index}]`,
                    list,
                    DEFAULT_QUOTE_STATUS
                );
                claim.index = index;
                out.push(claim);
            });
        }
        return out;
    }

    /**
     * Publication view of one research claim. `contradicted-corrected` records how OUR analysis
     * changed; the quote and citation now support the dossier's current value, so the public sees
     * confirmed current evidence and not the superseded interpretation in `note`. Actor/source
     * changes (`changed`, `source-gone`) remain unchanged because they describe external reality.
     */
    function publicClaim(claim) {
        if (!claim || typeof claim !== 'object') return claim;
        // Some old absence claims pre-date the dedicated correction status. Their notes explicitly
        // mark them SUPERSEDED and point to the replacement claim; publishing both would make the
        // obsolete assertion look current.
        if (claim.status !== 'contradicted-corrected' && /\bSUPERSEDED\b/i.test(claim.note ?? '')) return null;
        if (claim.status !== 'contradicted-corrected') {
            return /contradicted-corrected/i.test(claim.note ?? '') ? { ...claim, note: null } : { ...claim };
        }
        return { ...claim, status: 'confirmed', note: null };
    }

    /** Publication view without mutating the internal research history. */
    function publicClaims(claims) {
        return (Array.isArray(claims) ? claims : []).map(publicClaim).filter(Boolean);
    }

    /** Claims grouped by their normalised field, each group in trust order. A plain object rather
     *  than a Map, so the same index can be embedded in a built JSON file. */
    function claimsByField(claims) {
        const index = Object.create(null);
        for (const claim of Array.isArray(claims) ? claims : []) {
            const field = normaliseField(claim?.field);
            if (field === '') continue;
            if (!index[field]) index[field] = [];
            index[field].push(claim);
        }
        for (const field of Object.keys(index)) index[field].sort(compareClaims);
        return index;
    }

    /** Trust order, then the newest access, then the quote — a total order, so a rebuild from the
     *  same inputs produces the same file. */
    function compareClaims(a, b) {
        const rank = statusRank(a?.status) - statusRank(b?.status);
        if (rank !== 0) return rank;
        const at = str(a?.accessedAt) ?? '';
        const bt = str(b?.accessedAt) ?? '';
        if (at !== bt) return at < bt ? 1 : -1;
        const aq = str(a?.quote) ?? '';
        const bq = str(b?.quote) ?? '';
        return aq === bq ? 0 : aq < bq ? -1 : 1;
    }

    /** The strongest claim on a field, or null. */
    function bestClaim(claims) {
        const list = Array.isArray(claims) ? [...claims].sort(compareClaims) : [];
        return list.length ? list[0] : null;
    }

    /**
     * The concrete field paths this record needs a source for: every entry of the shared list,
     * with each `*` segment expanded against the record's own keys, kept only when the record
     * actually carries a value there. So an issuer that documents six of the twelve vocabulary
     * questions is measured against six, not twelve, and coverage never punishes a dossier for
     * data nobody has claimed to have.
     */
    function neededFields(record, fields) {
        const list = Array.isArray(fields) ? fields : [];
        const out = [];
        const seen = new Set();
        for (const pattern of list) {
            for (const path of expandPattern(record, pattern)) {
                if (seen.has(path)) continue;
                if (!hasValue(valueAtPath(record, path))) continue;
                seen.add(path);
                out.push(path);
            }
        }
        return out;
    }

    /** One pattern's concrete paths. `a.*.b` walks the keys present under `a`. */
    function expandPattern(record, pattern) {
        const segments = parseFieldPath(pattern);
        if (segments.length === 0) return [];
        let paths = [[]];
        for (const segment of segments) {
            if (segment !== '*') {
                paths = paths.map((prefix) => [...prefix, segment]);
                continue;
            }
            const next = [];
            for (const prefix of paths) {
                const parent = prefix.length === 0 ? record : valueAtPath(record, renderPath(prefix));
                if (parent === null || typeof parent !== 'object') continue;
                const keys = Array.isArray(parent) ? parent.map((_, i) => i) : Object.keys(parent);
                for (const key of keys) next.push([...prefix, key]);
            }
            paths = next;
        }
        return paths.map(renderPath).filter((path) => path !== '');
    }

    function renderPath(segments) {
        return segments.reduce((acc, segment) => (
            typeof segment === 'number' ? `${acc}[${segment}]` : acc === '' ? String(segment) : `${acc}.${segment}`
        ), '');
    }

    /**
     * The evidence summary carried on an issuer record, on the issuerIndex entry and on a card
     * footer: how many claims, how they split by status, the freshest `accessedAt` across them
     * (what "last checked" means before a watcher has ever run), and coverage as
     * "fields with at least one CONFIRMED claim" over "fields that need one". A field sourced only
     * by an unverified or inferred claim is deliberately not counted as sourced.
     */
    function evidenceSummary(record, claims, fields) {
        const list = Array.isArray(claims) ? claims : [];
        const needed = neededFields(record, fields);
        const byField = claimsByField(list);
        const counts = { confirmed: 0, unverified: 0, inference: 0, corrected: 0 };
        let lastCheckedAt = null;
        for (const claim of list) {
            if (claim?.status === 'confirmed') counts.confirmed += 1;
            else if (claim?.status === 'unverified') counts.unverified += 1;
            else if (claim?.status === 'inference') counts.inference += 1;
            else if (claim?.status === 'contradicted-corrected') counts.corrected += 1;
            const at = str(claim?.accessedAt);
            if (at !== null && (lastCheckedAt === null || at > lastCheckedAt)) lastCheckedAt = at;
        }
        const sourced = needed.filter((field) => (byField[field] || [])
            .some((claim) => claim?.status === 'confirmed')).length;
        return {
            claims: list.length,
            confirmed: counts.confirmed,
            unverified: counts.unverified,
            inference: counts.inference,
            corrected: counts.corrected,
            lastCheckedAt,
            coverage: { sourced, needed: needed.length }
        };
    }

    /**
     * What a chip on one field needs to draw itself, or null when the field neither has a claim nor
     * needs one (no chip at all). `needed: true` with an empty `claims` is the hollow "§?" chip.
     */
    function chipFor(field, byField, neededSet) {
        const key = normaliseField(field);
        if (key === '') return null;
        const claims = byField && byField[key] ? byField[key] : [];
        const needed = !!(neededSet && (typeof neededSet.has === 'function'
            ? neededSet.has(key)
            : neededSet[key] === true));
        if (claims.length === 0 && !needed) return null;
        return { field: key, claims, needed, best: bestClaim(claims) };
    }

    return {
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
        publicClaim,
        publicClaims,
        claimsByField,
        compareClaims,
        bestClaim,
        neededFields,
        expandPattern,
        evidenceSummary,
        chipFor
    };
});
