import { createHash } from 'node:crypto';

import { inferenceReviewState, publicClaims } from './evidence.mjs';

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
export const REVIEW_ISSUES = ['changed', 'source-gone', 'conflict', 'missing', 'unsupported', 'reviewed-inference', 'stale', 'open-question', 'discovery-candidate', 'defi-integration-candidate'];

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

/** An inference can be rigorously reviewed without becoming a source-confirmed fact.  The
 * explicit fields avoid treating an eloquent free-text note or an old access time as review. */
export { inferenceReviewState };

/**
 * A `changed` claim is historical once a researcher has re-read the source and recorded its current
 * wording as a new confirmed claim on the same field: the old claim is kept (with `changed`) as the
 * record of what the source used to say, and must not keep the field at P0 forever. The reference
 * moment is when the old words were LAST SEEN (their last confirmation), not when the watcher last
 * looked for them — it re-checks a lost quote on every run, so its last-checked time moves forever.
 * Superseded means a confirmed claim on the field was confirmed after every lost quote was last seen.
 */
function changeSuperseded(claims) {
    let lastSeen = null;
    for (const claim of claims) {
        if (claim.status !== 'changed') continue;
        const at = dateMillis(claim.last_confirmed_at ?? claim.lastConfirmedAt ?? claim.accessed_at ?? claim.accessedAt);
        if (at === null) return false;
        if (lastSeen === null || at > lastSeen) lastSeen = at;
    }
    if (lastSeen === null) return false;
    return claims.some((claim) => {
        if (claim.status !== 'confirmed') return false;
        const at = dateMillis(claim.last_confirmed_at ?? claim.lastConfirmedAt ?? claim.accessed_at ?? claim.accessedAt);
        return at !== null && at > lastSeen;
    });
}

/**
 * An open question becomes a DeFi enforcement item only while it is still open and is actually about
 * using the token in a lending or trading protocol. Dossiers mark answered questions by prefixing
 * "ANSWERED (date):" rather than deleting them ("PARTLY ANSWERED" stays open), and the broad area
 * pattern matched words like "seize", "protocol" or "smart-contract" in questions about the issuer's
 * own powers, which put non-DeFi questions in the DeFi queue (measured 2026-09-23: most of 8).
 */
const DEFI_QUESTION = /\b(defi\b|lending (?:market|protocol|pool)|lenders?\b|borrow(?:er|ers|ing)?|as (?:loan )?collateral|loan (?:account|collateral)|liquidat(?:e|ed|ion|or)s?\b|kamino|jupiter lend|loopscale|marginfi|solend|on-chain credit|money market)/i;
export function isOpenDefiQuestion(question) {
    const text = typeof question === 'string' ? question.trim() : '';
    // "ANSWERED (date)" may follow the question text; "PARTLY ANSWERED" keeps it open.
    if (!text || /(?<!partly\s)\banswered\s*\(\d{4}-\d{2}-\d{2}\)/i.test(text) || /^answered\b/i.test(text)) return false;
    return DEFI_QUESTION.test(text);
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
    if (issue === 'defi-integration-candidate') return 'Identify the program and product holding the token, then add it to the program registry and, if it is a real integration, to a collected registry or the reviewed products file.';
    if (issue === 'unsupported') return 'Replace inference or an unverified note with primary-source words, or explicitly retain it as unknown.';
    if (issue === 'reviewed-inference') return 'Keep this as a reviewed inference, not a source-confirmed fact; re-open it if its scope, reasoning or cited sources change.';
    return 'Locate primary evidence or record where we looked and why the answer remains unknown.';
}

function impactFor(area) {
    return {
        ownership: 'May change what legal or economic claim the token represents.',
        insolvency: 'May change the holder’s recovery, priority or exposure if an intermediary fails.',
        redemption: 'May change whether, when or how the holder can exit for cash or the underlying asset.',
        control: 'May change who can freeze, move, pause or otherwise override the token.',
        defi: 'May change whether a protocol can custody, liquidate or return the token as intended.',
        other: 'May change a published fact or conclusion and requires editorial review.'
    }[area];
}

function affectedConclusionsFor(area) {
    return {
        ownership: ['legal claim', 'holder scope', 'asset identity'],
        insolvency: ['asset segregation', 'priority on failure', 'custody chain'],
        redemption: ['cash exit', 'holder eligibility', 'fees and timing'],
        control: ['issuer intervention', 'transfer finality', 'on-chain authority'],
        defi: ['collateral eligibility', 'liquidation path', 'lender exit'],
        other: ['published research fact']
    }[area] ?? ['published research fact'];
}

function monitoringStateFor(issue, area) {
    const consequential = area !== 'other';
    const defaults = {
        retrievalState: 'not checked in this workflow',
        contentComparisonState: 'not compared',
        analystReviewState: 'pending analyst review',
        conclusionValidityState: consequential ? 'provisional until reviewed' : 'context item awaiting review'
    };
    if (issue === 'changed') {
        return {
            retrievalState: 'retrieved successfully',
            contentComparisonState: 'source bytes or cited text changed; relevance is not yet reviewed',
            analystReviewState: 'pending analyst review',
            conclusionValidityState: consequential ? 'published conclusion must be treated as provisional' : 'published note needs review'
        };
    }
    if (issue === 'source-gone') {
        return {
            retrievalState: 'retrieval failed',
            contentComparisonState: 'cannot compare current governing text',
            analystReviewState: 'pending source recovery',
            conclusionValidityState: consequential ? 'explicit evidence limitation required' : 'source gap remains open'
        };
    }
    if (issue === 'stale') {
        return {
            retrievalState: 'last successful retrieval is outside the review window',
            contentComparisonState: 'old comparison cannot prove the whole source stayed unchanged',
            analystReviewState: 'renewal pending',
            conclusionValidityState: consequential ? 'usable with stale-evidence caveat' : 'scheduled re-check'
        };
    }
    if (issue === 'unsupported') {
        return {
            ...defaults,
            retrievalState: 'partial or unconfirmed retrieval',
            contentComparisonState: 'no confirmed primary-source match',
            conclusionValidityState: consequential ? 'unknown until primary support is recorded' : 'unsupported note'
        };
    }
    if (issue === 'reviewed-inference') {
        return {
            ...defaults,
            retrievalState: 'reviewed inference; source support is recorded separately',
            contentComparisonState: 'reasoning, sources and scope were recorded; this is not a verbatim source claim',
            analystReviewState: 'inference review recorded',
            conclusionValidityState: 'reviewed inference; not source-confirmed'
        };
    }
    if (issue === 'missing') {
        return {
            ...defaults,
            retrievalState: 'no source attached',
            conclusionValidityState: consequential ? 'unknown, not a pass' : 'missing evidence'
        };
    }
    if (issue === 'conflict') {
        return {
            ...defaults,
            retrievalState: 'multiple sources recorded',
            contentComparisonState: 'sources imply different readings',
            conclusionValidityState: consequential ? 'unresolved until authority is decided' : 'conflict pending'
        };
    }
    if (issue === 'open-question') {
        return {
            ...defaults,
            retrievalState: 'research question recorded',
            contentComparisonState: 'no decisive source found',
            conclusionValidityState: 'not established'
        };
    }
    if (issue === 'defi-integration-candidate') {
        return {
            ...defaults,
            retrievalState: 'on-chain holding observed',
            contentComparisonState: 'program not attributed to a collected integration',
            conclusionValidityState: 'not published as an integration until reviewed'
        };
    }
    if (issue === 'discovery-candidate') {
        return {
            ...defaults,
            retrievalState: 'identity signals collected',
            contentComparisonState: 'issuer-controlled exact-mint proof incomplete',
            conclusionValidityState: 'quarantined; not a published asset'
        };
    }
    return defaults;
}

function resolutionCriteriaFor(issue, area) {
    if (issue === 'changed') return 'Compare the new source text against the affected conclusion, then record whether the conclusion still holds, changes, or becomes unknown.';
    if (issue === 'source-gone') return 'Recover a primary source, authoritative replacement or archived copy; otherwise mark the affected conclusion with an explicit evidence limitation.';
    if (issue === 'missing') return 'Attach primary evidence for the required field or keep the conclusion unknown.';
    if (issue === 'unsupported') return 'Upgrade the claim to confirmed primary support, or downgrade the conclusion to inference/unknown.';
    if (issue === 'reviewed-inference') return 'Keep the reasoning, cited sources, scope and review date together; do not relabel this inference as confirmed evidence.';
    if (issue === 'conflict') return 'Name the controlling source and authority rule, or leave the conflict unresolved beside the conclusion.';
    if (issue === 'stale') return 'Re-fetch and compare the relevant source, then refresh the checked and reviewed timestamps separately.';
    if (issue === 'open-question' && area === 'defi') return 'Record exact protocol, issuer or legal evidence for custody, liquidation and exit after default.';
    if (issue === 'discovery-candidate') return 'Confirm the exact mint in an issuer-controlled registry or reviewed primary source before publication.';
    if (issue === 'defi-integration-candidate') return 'Attribute the holding program with a primary source (protocol docs, verified build or official announcement) and record whether it is an integration, custody or plumbing.';
    return 'Record an analyst decision with the evidence used and the conclusion affected.';
}

function titleFor(issue, field) {
    const label = text(field) || 'unclassified conclusion';
    const prefix = {
        changed: 'Source language changed',
        'source-gone': 'Source disappeared',
        conflict: 'Conflicting evidence needs a decision',
        missing: 'Required evidence is missing',
        unsupported: 'Conclusion is not confirmed',
        'reviewed-inference': 'Reviewed inference remains distinct from source confirmation',
        stale: 'Evidence needs re-checking',
        'open-question': 'Open enforcement question',
        'discovery-candidate': 'New address needs identity review',
        'defi-integration-candidate': 'Possible new DeFi integration'
    }[issue] ?? 'Evidence review needed';
    return `${prefix}: ${label}`;
}

function item({ issuerSlug, issuerName, field = null, issue, detail, observedAt = null, severity = null,
    sourceUrl = null, eventId = null, eventIds = null, eventSubjectId = null, templateId = null,
    href = null, previousText = null, currentText = null }) {
    const area = areaFor(field, detail);
    const monitoringState = monitoringStateFor(issue, area);
    const affectedConclusions = affectedConclusionsFor(area);
    return {
        id: stableId(issuerSlug, field, issue, eventId, detail),
        priority: priorityFor(issue, area, severity),
        area,
        issue,
        impactScore: { ownership: 5, insolvency: 5, redemption: 5, control: 4, defi: 4, other: 1 }[area] ?? 1,
        issuerSlug,
        issuerName,
        field,
        title: titleFor(issue, field),
        detail: text(detail),
        action: actionFor(issue, area),
        claimImpact: impactFor(area),
        affectedConclusions,
        resolutionCriteria: resolutionCriteriaFor(issue, area),
        // A review of analytical reasoning is valuable, but never converts it into a primary
        // source assertion. Consumers can render this state distinctly from unsupported work.
        evidence: issue === 'reviewed-inference' ? { reviewedInference: true } : null,
        ...monitoringState,
        previousText: text(previousText) || null,
        currentText: text(currentText) || null,
        observedAt,
        severity,
        sourceUrl: text(sourceUrl) || null,
        eventId,
        eventIds: Array.isArray(eventIds) ? eventIds : (eventId === null ? [] : [eventId]),
        eventSubjectId: text(eventSubjectId) || null,
        templateId,
        href: href ?? (issuerSlug ? `./issuers/${issuerSlug}.html` : './watch.html')
    };
}

/**
 * A watcher can observe the same unresolved source changing several times before an analyst reviews
 * it. Present that as one source history rather than several competing tasks. Distinct source IDs
 * stay distinct even when they belong to the same issuer and field.
 */
export function collapseEventSequences(items) {
    const rows = Array.isArray(items) ? items : [];
    const groups = new Map();
    const passthrough = [];
    for (const entry of rows) {
        if (!entry.eventSubjectId || entry.eventId === null) {
            passthrough.push(entry);
            continue;
        }
        const key = [entry.issuerSlug, entry.field, entry.issue, entry.eventSubjectId].map(text).join('|');
        const group = groups.get(key) ?? [];
        group.push(entry);
        groups.set(key, group);
    }
    for (const group of groups.values()) {
        group.sort((a, b) => String(a.observedAt ?? '').localeCompare(String(b.observedAt ?? ''))
            || Number(a.eventId) - Number(b.eventId));
        const oldest = group[0];
        const latest = group[group.length - 1];
        const eventIds = [...new Set(group.flatMap((entry) => entry.eventIds ?? [entry.eventId])
            .map(Number).filter(Number.isSafeInteger))].sort((a, b) => a - b);
        passthrough.push({
            ...latest,
            id: stableId(latest.issuerSlug, latest.field, latest.issue, latest.eventSubjectId, 'event-sequence'),
            detail: group.length === 1 ? latest.detail
                : `${latest.detail} ${group.length} unresolved observations for this source are reviewed as one sequence.`,
            previousText: oldest.previousText,
            eventId: latest.eventId,
            eventIds,
            observationCount: group.length
        });
    }
    return passthrough;
}

function claimsForField(issuer, field, databaseClaims) {
    const watched = databaseClaims.filter((claim) => claim.issuer_slug === issuer.slug && claim.field === field);
    const current = (issuer.claims ?? []).filter((claim) => claim.field === field);
    if (watched.length && current.length) {
        // sonar.claim intentionally retains claims no longer offered by the current dossier as an
        // internal audit trail. They must not resurrect an old editorial reading in the public
        // queue. A watched row is current only when its source and quoted words still identify a
        // claim the published issuer record carries now.
        const currentWatched = current.map((offered) => {
            const observed = watched.find((claim) => text(claim.url) === text(offered.url)
                && text(claim.quote) === text(offered.quote));
            if (!observed) return null;
            // Watcher state and observation times override the dossier, while analytical review
            // metadata stays with the current editorial claim because sonar.claim intentionally
            // stores source observations rather than the full reasoning record.
            return {
                ...offered,
                status: observed.status ?? offered.status,
                last_checked_at: observed.last_checked_at ?? offered.last_checked_at,
                last_confirmed_at: observed.last_confirmed_at ?? offered.last_confirmed_at,
                accessed_at: observed.accessed_at ?? offered.accessed_at
            };
        }).filter(Boolean);
        return publicClaims(currentWatched.length ? currentWatched : current);
    }
    if (watched.length) return publicClaims(watched);
    return publicClaims(current);
}

export function buildReviewQueue({ issuerDb, legalTemplates, databaseClaims = [], changeEvents = [], discoveryCandidates = [], defiCandidates = [], nowMs = Date.now() }) {
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
            } else if (statuses.has('changed') && !changeSuperseded(claims)) {
                issue = 'changed'; detail = 'The watcher no longer finds the recorded quote in the current source.';
            } else if (!statuses.has('confirmed')) {
                issue = claims.length === 0 ? 'missing' : 'unsupported';
                detail = claims.length === 0
                    ? 'This field is required by the evidence methodology but has no claim attached.'
                    : `Only ${[...statuses].sort().join(' / ')} evidence is recorded; none is confirmed.`;
                const inferences = claims.filter((claim) => claim.status === 'inference');
                if (inferences.length === claims.length && inferences.length > 0) {
                    const reviews = inferences.map(inferenceReviewState);
                    if (reviews.every((review) => review.reviewed)) {
                        issue = 'reviewed-inference';
                        detail = `${inferences.length} reviewed inference${inferences.length === 1 ? '' : 's'} with explicit reasoning, sources, scope and review date. This is not source-confirmed evidence.`;
                    } else {
                        const missing = [...new Set(reviews.flatMap((review) => review.missing))];
                        detail = `Inference is not yet rigorously reviewed: missing ${missing.join(', ')}. It is not source-confirmed evidence.`;
                    }
                }
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
            if (!isOpenDefiQuestion(question)) continue;
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
        // A first successful chain read establishes the comparison baseline; it is evidence that
        // monitoring started, not an external actor changing a token. Keep the event internally
        // for auditability, but never turn collector bootstrap into public review work.
        if (event.kind === 'status' && event.field === 'chain-watch'
            && /^baseline recorded:/i.test(text(event.summary))) continue;
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
            eventId: event.id ?? null,
            eventIds: event.id === null || event.id === undefined ? [] : [event.id],
            eventSubjectId: event.subject_id ?? null,
            previousText: event.before,
            currentText: event.after
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

    // On-chain footprint candidates (stocks/data/defi-footprint.json): a program holding a tracked
    // stock that no collected registry explains. Severity: an unknown program is caution; a known
    // protocol whose exact use is simply not yet collected is informational.
    for (const candidate of defiCandidates) {
        if (!candidate?.mint || !candidate?.reason) continue;
        const issuerSlug = canonicalSlug(candidate.issuer);
        const who = candidate.protocolName ?? candidate.programId ?? 'unresolved program';
        items.push(item({
            issuerSlug,
            issuerName: names.get(issuerSlug) ?? issuerSlug ?? 'Unattributed issuer',
            field: `DeFi protocol use · ${candidate.symbol ?? candidate.mint.slice(0, 8)} · ${who}`,
            issue: 'defi-integration-candidate',
            detail: `${candidate.summary} Mint ${candidate.mint}; holding account owner(s) ${(candidate.owners ?? []).join(', ') || 'unknown'}.`,
            observedAt: candidate.observedAt ?? null,
            severity: candidate.reason === 'unlisted-integration' ? null : 'caution',
            href: './stocks.html?view=defi#defiNewStrip'
        }));
    }

    const collapsed = collapseEventSequences(items);
    const unique = [...new Map(collapsed.map((entry) => [entry.id, entry])).values()];
    unique.sort((a, b) => (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
        || ((b.impactScore ?? 0) - (a.impactScore ?? 0))
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
