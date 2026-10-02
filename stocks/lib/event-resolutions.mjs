// Versioned editorial decisions for watcher events. Event ids are database-local, so matching is
// deliberately based on stable facts: actor, kind, field, before/after values and source URL.

function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function valueMatches(actual, expected) {
    if (Array.isArray(expected)) return expected.some((value) => valueMatches(actual, value));
    if (expected === undefined || expected === null) return true;
    return String(actual ?? '') === String(expected);
}

export function eventFacts(event) {
    return {
        issuerSlug: text(event?.issuer_slug ?? event?.issuerSlug),
        kind: text(event?.kind),
        subjectType: text(event?.subject_type ?? event?.subjectType),
        subjectId: text(event?.subject_id ?? event?.subjectId),
        field: text(event?.field),
        before: event?.before ?? null,
        after: event?.after ?? null,
        sourceUrl: text(event?.evidence?.url ?? event?.sourceUrl),
        detectedOn: text(event?.detected_at ?? event?.detectedAt)?.slice(0, 10) ?? null
    };
}

export function matchesEventResolution(event, resolution) {
    const match = resolution?.match;
    if (!match || typeof match !== 'object') return false;
    const facts = eventFacts(event);
    return Object.entries(match).every(([key, expected]) => valueMatches(facts[key], expected));
}

export function resolutionForEvent(event, resolutions) {
    return (Array.isArray(resolutions) ? resolutions : [])
        .find((resolution) => matchesEventResolution(event, resolution)) ?? null;
}

export function partitionEventResolutions(events, resolutions) {
    const open = [];
    const resolved = [];
    for (const event of Array.isArray(events) ? events : []) {
        const resolution = resolutionForEvent(event, resolutions);
        if (resolution) resolved.push({ event, resolution });
        else open.push(event);
    }
    return { open, resolved };
}
