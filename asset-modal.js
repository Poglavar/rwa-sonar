/**
 * Shared geometry values for the token card attestation circles.
 */
const CARD_W = 280;
const CARD_H = 420;
const CIRCLE_SIZE = 24;
const CIRCLE_OFFSET = CIRCLE_SIZE / 2;

// Circle distribution: left 9, bottom 6, right 9, top 6 = 30 max circles.
const LEFT_COUNT = 9;
const BOTTOM_COUNT = 6;
const RIGHT_COUNT = 9;
const TOP_COUNT = 6;
const MAX_CIRCLES = LEFT_COUNT + BOTTOM_COUNT + RIGHT_COUNT + TOP_COUNT;

/**
 * Return circle coordinates for an attestation index.
 *
 * The index walks around the token card clockwise:
 * left edge -> bottom edge -> right edge -> top edge.
 *
 * @param {number} index
 * @param {number} maxCount
 * @returns {{top:number,left:number}}
 */
function getCirclePosition(index, maxCount = MAX_CIRCLES) {
    const normalizedIndex = Number.isFinite(index) ? index : 0;

    let top;
    let left;

    if (normalizedIndex < LEFT_COUNT) {
        const step = CARD_H / (LEFT_COUNT + 1);
        top = step * (normalizedIndex + 1) - CIRCLE_OFFSET;
        left = -CIRCLE_OFFSET;
    } else if (normalizedIndex < LEFT_COUNT + BOTTOM_COUNT) {
        const i = normalizedIndex - LEFT_COUNT;
        const step = CARD_W / (BOTTOM_COUNT + 1);
        left = step * (i + 1) - CIRCLE_OFFSET;
        top = CARD_H - CIRCLE_OFFSET;
    } else if (normalizedIndex < LEFT_COUNT + BOTTOM_COUNT + RIGHT_COUNT) {
        const i = normalizedIndex - LEFT_COUNT - BOTTOM_COUNT;
        const step = CARD_H / (RIGHT_COUNT + 1);
        left = CARD_W - CIRCLE_OFFSET;
        top = CARD_H - step * (i + 1) - CIRCLE_OFFSET;
    } else {
        // Also handles index values larger than maxCount, intentionally.
        const i = normalizedIndex - LEFT_COUNT - BOTTOM_COUNT - RIGHT_COUNT;
        const step = CARD_W / (TOP_COUNT + 1);
        left = CARD_W - step * (i + 1) - CIRCLE_OFFSET;
        top = -CIRCLE_OFFSET;
    }

    return { top, left };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getCirclePosition,
        CARD_W,
        CARD_H,
        CIRCLE_SIZE,
        CIRCLE_OFFSET,
        LEFT_COUNT,
        TOP_COUNT,
        RIGHT_COUNT,
        BOTTOM_COUNT,
        MAX_CIRCLES
    };
}
