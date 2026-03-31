function isYes(value) {
    return ['yes', 'y', '1', 'true'].includes(String(value ?? '').trim().toLowerCase());
}

function isNo(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return ['no', 'n', '0', 'false'].includes(v);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isYes, isNo };
}
