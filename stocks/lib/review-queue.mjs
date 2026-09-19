import { createHash } from 'node:crypto';

const DAY_MS = 86_400_000;
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

const AREA_PATTERNS = [
    ['defi', /\b(defi|protocol|liquidat|lending|lender|borrower|oracle|escrow|smart[- ]contract|seiz(?:e|ure))\b/i],
    ['redemption', /\bredemption|redeem|cash exit|investor put|settlement rail/i],
    ['insolvency', /bankrupt|insolv|securityInterest|security interest|priority|perfection|segregat|rehypothecat|commingl|custodian lien/i],
    ['ownership', /holderClaim|legalForm|issuingEntity|mint identity|asset identity|title|beneficial owner|holder of record|what .* own/i],
    ['control', /keyGovernance|transferRestrictions|tokenProgram|freeze|clawback|delegate|pause|authority|allowlist|rebase/i]
];

export const REVIEW_AREAS = ['ownership', 'insolvency', 'redemption', 'control', 'defi', 'other'];
export const REVIEW_ISSUES = ['changed', 'source-gone', 'conflict', 'missing', 'unsupported', 'stale', 'open-question', 'discovery-candidate'];

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function stableId(...parts) {
    return createHash('sha1').update(parts.map((part) => text(part)).join('|')).digest('hex').slice(0, 16);
}

export function areaFor(field, detail = '') {
    const haystack = `${text(field)} ${text(detail)}`;
    return AREA_PATTERNS.find(([, pattern]) => pattern.test(haystack))?.[0] ?? 'other';
}

function dateMillis(value) {
    const parsed = Date.parse(value ?? '');
    return Number.isFinite(parsed) ? parsed : null;
}

function newestTimestamp(claims) {
    let newest = null;
    for (const claim of claims) {
        for (const value of [claim.last_checked_at, claim.lastCheckedAt, claim.last_confirmed_at,
            claim.lastConfirmedAt, claim.accessed_at, claim.accessedAt]) {
            const parsed = dateMillis(value);
            if (parsed !== null && (newest === null || parsed > newest)) newest = parsed;
        }
    }
    return newest === null ? null : new Date(newest).toISOString();
}

function priorityFor(issue, area, severity = null) {
    const consequential = area !== 'other';
    if (severity === 'critical' || severity === 'warning'
        || (severity === null && consequential && ['changed', 'source-gone'].includes(issue))) return 'P0';
    if (severity === 'caution' || (consequential && ['conflict', 'missing', 'unsupported', 'open-question'].includes(issue))) return 'P1';
    if (issue === 'stale' || issue === 'conflict' || issue === 'missing' || issue === 'unsupported') return 'P2';
    return 'P3';
}

function actionFor(issue, area) {
    if (issue === 'changed') return 'Re-open the source, compare the changed language, then confirm or amend the published conclusion.';
    if (issue === 'source-gone') return 'Find an authoritative replacement or archived copy before relying on this conclusion.';
    if (issue === 'conflict') return 'Resolve which document controls and record why the preferred source has higher authority.';
    if (issue === 'stale') return 'Re-read the cited source and renew the checked/confirmed timestamps.';
    if (issue === 'open-question' && area === 'defi') return 'Obtain protocol or issuer evidence for enforceable custody, liquidation and exit after default.';
    if (issue === 'discovery-candidate') return 'Confirm the exact mint in an issuer-controlled registry or reviewed primary source before adding it to the public asset universe.';
    if (issue === 'unsupported') return 'Replace inference or an unverified note with primary-source words, or explicitly retain it as unknown.';
    return 'Locate primary evidence or record where we looked and why the answer remains unknown.';
}

function titleFor(issue, field) {
    const label = text(field) || 'unclassified conclusion';
    const prefix = {
        changed: 'Source language changed',
        'source-gone': 'Source disappeared',
        conflict: 'Conflicting evidence needs a decision',
        missing: 'Required evidence is missing',
        unsupported: 'Conclusion is not confirmed',
        stale: 'Evidence needs re-checking',
        'open-question': 'Open enforcement question',
        'discovery-candidate': 'New address needs identity review'
    }[issue] ?? 'Evidence review needed';
    return `${prefix}: ${label}`;
}

function item({ issuerSlug, issuerName, field = null, issue, detail, observedAt = null, severity = null,
    sourceUrl = null, eventId = null, templateId = null, href = null }) {
    const area = areaFor(field, detail);
    return {
        id: stableId(issuerSlug, field, issue, eventId, detail),
        priority: priorityFor(issue, area, severity),
        area,
        issue,
        issuerSlug,
        issuerName,
        field,
        title: titleFor(issue, field),
        detail: text(detail),
        action: actionFor(issue, area),
        observedAt,
        severity,
        sourceUrl: text(sourceUrl) || null,
        eventId,
        templateId,
        href: href ?? (issuerSlug ? `./stocks.html#issuer-${issuerSlug}` : './watch.html')
    };
}

function claimsForField(issuer, field, databaseClaims) {
    const watched = databaseClaims.filter((claim) => claim.issuer_slug === issuer.slug && claim.field === field);
    if (watched.length) return watched;
    return (issuer.claims ?? []).filter((claim) => claim.field === field);
}

export function buildReviewQueue({ issuerDb, legalTemplates, databaseClaims = [], changeEvents = [], discoveryCandidates = [], nowMs = Date.now() }) {
    const issuers = Array.isArray(issuerDb?.issuers) ? issuerDb.issuers : [];
    const names = new Map(issuers.map((issuer) => [issuer.slug, issuer.name ?? issuer.slug]));
    const canonicalSlug = (raw) => {
        if (!raw || names.has(raw)) return raw ?? null;
        return [...names.keys()].filter((slug) => raw.startsWith(`${slug}-`))
            .sort((a, b) => b.length - a.length)[0] ?? raw;
    };
    const items = [];

    for (const issuer of issuers) {
        for (const field of issuer.evidenceFields ?? []) {
            const claims = claimsForField(issuer, field, databaseClaims);
            const statuses = new Set(claims.map((claim) => claim.status));
            const latest = newestTimestamp(claims);
            const sourceUrl = claims.find((claim) => text(claim.url))?.url ?? null;
            let issue = null;
            let detail = '';
            if (statuses.has('source-gone')) {
                issue = 'source-gone'; detail = 'The document previously supporting this field is no longer available.';
            } else if (statuses.has('changed')) {
                issue = 'changed'; detail = 'The watcher no longer finds the recorded quote in the current source.';
            } else if (statuses.has('contradicted-corrected')) {
                issue = 'conflict'; detail = 'At least one reviewed source contradicted an earlier reading; document precedence needs to remain explicit.';
            } else if (!statuses.has('confirmed')) {
                issue = claims.length === 0 ? 'missing' : 'unsupported';
                detail = claims.length === 0
                    ? 'This field is required by the evidence methodology but has no claim attached.'
                    : `Only ${[...statuses].sort().join(' / ')} evidence is recorded; none is confirmed.`;
            }
            if (issue) items.push(item({ issuerSlug: issuer.slug, issuerName: names.get(issuer.slug), field, issue, detail, observedAt: latest, sourceUrl }));

            if (!issue && latest !== null) {
                const area = areaFor(field);
                const maxAgeDays = area === 'other' ? 90 : 30;
                if (nowMs - Date.parse(latest) > maxAgeDays * DAY_MS) {
                    items.push(item({
                        issuerSlug: issuer.slug, issuerName: names.get(issuer.slug), field, issue: 'stale',
                        detail: `The newest check is older than the ${maxAgeDays}-day review window for ${area} evidence.`,
                        observedAt: latest, sourceUrl
                    }));
                }
            }
        }
    }

    for (const template of legalTemplates?.templates ?? []) {
        for (const question of template.openQuestions ?? []) {
            if (areaFor('', question) !== 'defi') continue;
            items.push(item({
                issuerSlug: template.issuer?.slug ?? null,
                issuerName: template.issuer?.name ?? template.issuer?.slug ?? 'Unknown issuer',
                field: 'DeFi enforcement', issue: 'open-question', detail: question,
                observedAt: template.reviewedAt ?? null, templateId: template.id
            }));
        }
    }

    for (const event of changeEvents) {
        if (event.acknowledged_at) continue;
        const issuerSlug = canonicalSlug(event.issuer_slug ?? (event.subject_type === 'issuer' ? event.subject_id : null));
        const issue = event.kind === 'document-gone' ? 'source-gone' : 'changed';
        items.push(item({
            issuerSlug,
            issuerName: names.get(issuerSlug) ?? issuerSlug ?? 'Unattributed source',
            field: event.field ?? event.kind,
            issue,
            detail: event.summary ?? `${event.kind} event awaiting editorial acknowledgement.`,
            observedAt: event.detected_at ?? null,
            severity: event.severity ?? null,
            eventId: event.id ?? null
        }));
    }

    for (const candidate of discoveryCandidates) {
        if (candidate?.status !== 'candidate' || !candidate?.mint) continue;
        const issuerSlug = canonicalSlug(candidate.proposedIssuer);
        const evidence = candidate.signals ?? {};
        const signalSummary = [
            evidence.stockTag ? 'stock tag' : null,
            evidence.aggregatorVerified ? 'aggregator verified' : null,
            evidence.sponsorIssuer ? `issuer registry says ${evidence.sponsorIssuer}` : null,
            evidence.mintAuthorityIssuer ? `mint authority says ${evidence.mintAuthorityIssuer}` : null,
            evidence.freezeAuthorityIssuer ? `freeze authority says ${evidence.freezeAuthorityIssuer}` : null,
            evidence.protocolListed ? 'listed by a reviewed protocol' : null
        ].filter(Boolean).join('; ');
        items.push(item({
            issuerSlug,
            issuerName: names.get(issuerSlug) ?? issuerSlug ?? 'Unidentified programme',
            field: `mint identity · ${candidate.symbol ?? candidate.mint.slice(0, 8)}`,
            issue: 'discovery-candidate',
            detail: `${candidate.mint}. ${(candidate.reasons ?? []).join('; ') || 'Independent identity evidence is incomplete.'}`
                + `${signalSummary ? ` Signals: ${signalSummary}.` : ''}`,
            observedAt: candidate.lastSeenAt ?? candidate.firstSeenAt ?? null,
            severity: candidate.severity ?? 'caution',
            href: './review.html'
        }));
    }

    const unique = [...new Map(items.map((entry) => [entry.id, entry])).values()];
    unique.sort((a, b) => (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
        || String(b.observedAt ?? '').localeCompare(String(a.observedAt ?? ''))
        || a.issuerName.localeCompare(b.issuerName)
        || String(a.field).localeCompare(String(b.field)));
    return unique;
}

export function queueSummary(items) {
    const list = Array.isArray(items) ? items : [];
    const countBy = (key, values) => Object.fromEntries(values.map((value) => [value,
        list.filter((entry) => entry[key] === value).length]));
    return {
        total: list.length,
        byPriority: countBy('priority', ['P0', 'P1', 'P2', 'P3']),
        byArea: countBy('area', REVIEW_AREAS),
        byIssue: countBy('issue', REVIEW_ISSUES)
    };
}

export function acknowledgeEventSql(value) {
    const id = String(value ?? '');
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error('event id must be a positive integer');
    return `UPDATE sonar.change_event SET acknowledged_at = now(), updated_at = now() WHERE id = ${id} AND acknowledged_at IS NULL RETURNING id, summary;`;
}
