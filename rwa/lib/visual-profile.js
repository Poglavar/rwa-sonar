// Evidence-scoped visual profiles: identity colors never encode a product grade.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./research.js'));
    else root.__rwaVisualProfile = factory(root.__rwaResearch);
})(this, function (research) {
    'use strict';
    const FEATURES = [
        { id: 'ownership', label: 'Ownership', dimensions: ['rights', 'ledger'], icon: 'document' },
        { id: 'backing', label: 'Backing', dimensions: ['backing'], icon: 'vault' },
        { id: 'controls', label: 'Controls', dimensions: ['controls'], icon: 'key' },
        { id: 'exit', label: 'Exit', dimensions: ['exit', 'access'], icon: 'door' },
        { id: 'failure', label: 'Failure', dimensions: ['failure'], icon: 'lifebuoy' }
    ];
    const TONES = { strength: { label: 'Strength', mark: '✓' }, condition: { label: 'Caution', mark: '!' }, problem: { label: 'Problem', mark: '×' }, unknown: { label: 'Missing evidence', mark: '?' }, 'not-applicable': { label: 'Not applicable', mark: '—' } };
    const EVIDENCE_GAP_NOTE = 'Missing evidence: we could not verify this answer from the sources reviewed. This does not mean the protection is absent.';
    const UNKNOWN = { rights: 'Legal claim not verified', ledger: 'Which record prevails is unclear', backing: 'Current backing not verified', controls: 'Administrator powers not verified', exit: 'Redemption route not verified', access: 'Eligibility rules not verified', failure: 'Recovery rights not verified' };
    const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    // Include the operative finding and its source snapshot, not the index build date.
    function signature(claim, product) {
        return JSON.stringify([claim.dimension, claim.state, claim.basis, claim.summary, claim.scope, claim.sourceIds,
            claim.sourceIds.map((id) => product.sources.find((s) => s.id === id) || null)]);
    }
    function finding(product, contextId, dimension, options) {
        const claim = research.resolveClaim(product, contextId, dimension, options);
        const display = claim.display;
        const valid = display && display.basis === signature(claim, product) && TONES[display.tone]
            && (display.tone === 'unknown' || display.tone === 'not-applicable' || (claim.state === 'supported' && claim.sourceIds.length));
        const tone = claim.state === 'not-applicable' ? 'not-applicable' : valid && claim.state === 'supported' ? display.tone : 'unknown';
        const label = claim.state === 'conflicting' ? 'Sources conflict' : claim.state === 'stale' ? 'Historical evidence only'
            : claim.state === 'not-applicable' ? 'Not applicable' : valid ? display.label : UNKNOWN[dimension];
        return { id: claim.id || `${product.id}:${contextId}:${dimension}`, dimension, tone, label, note: claim.state === 'stale' ? 'The evidence covers an earlier period; it does not verify the current answer.' : claim.state === 'conflicting' ? 'The reviewed sources disagree and need reconciliation.' : valid ? display.note || '' : claim.state === 'unknown' ? claim.summary : '', state: claim.state,
            basis: claim.basis, summary: claim.summary, sourceIds: claim.sourceIds, scope: claim.scope || null,
            needsReview: Boolean(display && !valid), reason: valid ? display.reason : 'No current applicable presentation finding.',
            checkedAt: claim.observedAt || product.reviewedAt || product.evidenceCheckedAt || null };
    }
    function profile(product, contextId, options = {}) {
        const features = FEATURES.map((feature) => ({ ...feature, findings: feature.dimensions.map((d) => finding(product, contextId, d, options)) }));
        const clauses = ['ownership', 'exit', 'failure'].map((id) => ({ feature: id, text: features.find((f) => f.id === id).findings[0].label }));
        const context = product.contexts.find((c) => c.id === contextId);
        return { productId: product.id, programmeId: product.programmeId, name: product.name, contextId, context: product.id === 'acred' && contextId === 'feeder' ? 'ACRED feeder investor' : context?.label || 'Holder context not established',
            scope: options.deploymentId ? 'Selected token' : product.kind === 'programme' ? 'Issuer-wide review' : 'Product review',
            scopeNote: product.kind === 'programme' ? 'Individual token terms have not been verified.' : product.id === 'acred' ? 'The offering documents have not been reviewed.' : '',
            reviewedAt: product.reviewedAt || product.evidenceCheckedAt || null, features, clauses };
    }
    function icon(name) {
        const paths = {
            document: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>',
            vault: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="12" cy="12" r="4"/><path d="M12 8v8M8 12h8M18 8v8"/>',
            key: '<circle cx="8" cy="9" r="4"/><path d="m11 12 9 9M16 17l3-3M13 14l3-3"/>',
            door: '<path d="M5 21V3h11v18M8 21h13M12 12h9m-3-3 3 3-3 3"/>',
            lifebuoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m5.6 5.6 3.6 3.6m5.6 5.6 3.6 3.6m0-12.8-3.6 3.6m-5.6 5.6-3.6 3.6"/>'
        };
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.document}</svg>`;
    }
    function render(view, { compact = false, prefix = 'finding-', report = '', featureHeading = '', summaryOnly = false } = {}) {
        const href = (feature) => report ? `${report}#${prefix}${feature.dimensions[0]}` : `#${prefix}${feature.dimensions[0]}`;
        return `<section class="visual-profile${compact ? ' visual-profile-compact' : ''}" aria-label="${escape(view.name)} visual profile">${summaryOnly ? '' : `<p class="profile-scope">${escape(view.scope)}${view.scope === 'Issuer-wide review' ? '' : ' · ' + escape(view.context)}${view.scopeNote ? '<br>' + escape(view.scopeNote) : ''}</p><p class="profile-conclusion">${view.clauses.map(c => escape(c.text)).join('. ')}.</p>`}${featureHeading ? `<h4 class="profile-features-heading">${escape(featureHeading)}</h4>` : ''}<div class="profile-features">${view.features.map((f) => `<a class="profile-feature" href="${escape(href(f))}">${icon(f.icon)}<strong>${escape(f.label)}</strong>${f.findings.map((finding) => `<span class="profile-finding" data-tone="${escape(finding.tone)}"><b aria-label="${escape(TONES[finding.tone].label)}">${TONES[finding.tone].mark}</b><span>${escape(finding.label)}${finding.note ? `<small class="profile-note">${escape(finding.note)}</small>` : ''}${finding.needsReview ? '<small>Summary needs review</small>' : ''}</span></span>`).join('')}</a>`).join('')}</div><p class="profile-reviewed">Evidence reviewed: ${escape(view.reviewedAt ? view.reviewedAt.slice(0,10) : 'Date not recorded')}. Legal and chain checks stay separate.</p><p class="profile-legend"><span data-tone="strength">✓ Strength</span><span data-tone="condition">! Caution</span><span data-tone="problem">× Problem</span><span data-tone="unknown">? Missing evidence</span></p></section>`;
    }
    return { FEATURES, TONES, UNKNOWN, EVIDENCE_GAP_NOTE, signature, finding, profile, render, icon, escape };
});
