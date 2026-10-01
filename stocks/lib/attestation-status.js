// Interprets legacy asset attestation records without promoting their recorded status to a current
// verification. Expiry is a status of the evidence record, never a conclusion about the asset.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaAttestationStatus = factory();
})(this, function () {
    function dateOnly(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
        const parsed = new Date(value + 'T00:00:00.000Z');
        return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
    }

    function dayOf(value) {
        if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
        return dateOnly(value) ?? (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(value)
            ? dayFromDate(new Date(value)) : null);
    }

    function dayFromDate(date) {
        return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
    }

    function hasSource(record) {
        const link = typeof record?.link === 'string' ? record.link.trim() : '';
        return /^https?:\/\/[^\s]+$/i.test(link) && link !== '#';
    }

    /** now may be a Date or date string, allowing the boundary to be tested without a clock. */
    function classifyAttestation(record, now = new Date()) {
        const recordedStatus = typeof record?.status === 'string' && record.status.trim()
            ? record.status.trim() : null;
        const normalizedStatus = recordedStatus?.toLowerCase() ?? null;
        const expiryDate = dateOnly(record?.expiryDate);
        const today = dayOf(now);
        const sourceAvailable = hasSource(record);
        const expiredByDate = expiryDate !== null && today !== null && today >= expiryDate;

        let state;
        let label;
        if (normalizedStatus === 'revoked') {
            state = 'revoked';
            label = 'Recorded as revoked' + (sourceAvailable ? '' : '; evidence unavailable');
        } else if (normalizedStatus === 'expired' || expiredByDate) {
            state = 'expired';
            label = expiryDate
                ? 'Expired at stated expiry date ' + expiryDate
                : 'Recorded as expired';
            if (!sourceAvailable) label += '; evidence unavailable';
        } else if (!sourceAvailable) {
            state = 'evidence-unavailable';
            label = 'Evidence unavailable' + (recordedStatus ? '; recorded status: ' + recordedStatus : '');
        } else if (normalizedStatus === 'valid') {
            state = 'recorded-unverified';
            label = 'Recorded as valid; current validity not verified';
        } else {
            state = 'recorded-unverified';
            label = 'Recorded status' + (recordedStatus ? ': ' + recordedStatus : ' unavailable')
                + '; current validity not verified';
        }

        return {
            state,
            label,
            recordedStatus,
            expiryDate,
            sourceAvailable,
            expiredByDate,
            // Existing CSS colors expired evidence in red and all unverified/unavailable evidence
            // in amber. No state is assigned the green "valid" treatment.
            cssClass: state === 'expired' || state === 'revoked' ? 'expired' : 'warning'
        };
    }

    return { classifyAttestation };
});
