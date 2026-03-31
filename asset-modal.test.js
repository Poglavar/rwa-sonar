const {
    getOrderedAttestors,
    getCirclePosition,
    CARD_W,
    CARD_H,
    CIRCLE_OFFSET,
    LEFT_COUNT,
    BOTTOM_COUNT,
    RIGHT_COUNT,
    TOP_COUNT,
    MAX_CIRCLES
} = require('./asset-modal.js');

describe('getOrderedAttestors', () => {
    const attestations = [
        { assetName: 'Asset A', attestor: 'Attestor 1' },
        { assetName: 'Asset A', attestor: 'Attestor 1' },
        { assetName: 'Asset A', attestor: 'Attestor 2' },
        { assetName: 'Asset B', attestor: 'Attestor 3' },
    ];

    it('should sort issuer first regardless of count', () => {
        const asset = { name: 'Asset A', issuer: 'Issuer X' };
        const result = getOrderedAttestors(asset, attestations);
        expect(result[0].name).toBe('Issuer X');
        expect(result[0].isIssuer).toBe(true);
        expect(result[0].count).toBe(0);
    });

    it('should sort by count descending for same asset when not issuer', () => {
        const asset = { name: 'Asset A', issuer: 'Issuer X' };
        const result = getOrderedAttestors(asset, attestations);
        expect(result[1].name).toBe('Attestor 1');
        expect(result[1].count).toBe(2);
        expect(result[2].name).toBe('Attestor 2');
        expect(result[2].count).toBe(1);
    });

    it('should sort alphabetically when counts are the same', () => {
        const moreAttestations = [
            ...attestations,
            { assetName: 'Asset A', attestor: 'B Attestor' },
            { assetName: 'Asset A', attestor: 'A Attestor' },
        ];
        const asset = { name: 'Asset A' };
        const result = getOrderedAttestors(asset, moreAttestations);

        const ones = result.filter(r => r.count === 1);
        expect(ones[0].name).toBe('A Attestor');
        expect(ones[1].name).toBe('Attestor 2');
        expect(ones[2].name).toBe('B Attestor');
    });

    it('should include attestors with zero count for current asset but present in DB', () => {
        const asset = { name: 'Asset A' };
        const result = getOrderedAttestors(asset, attestations);
        const attestor3 = result.find(r => r.name === 'Attestor 3');
        expect(attestor3).toBeDefined();
        expect(attestor3.count).toBe(0);
    });
});

describe('getCirclePosition', () => {
    test('should correctly position circles on the left edge', () => {
        const step = CARD_H / (LEFT_COUNT + 1);
        for (let i = 0; i < LEFT_COUNT; i++) {
            const pos = getCirclePosition(i, MAX_CIRCLES);
            expect(pos.left).toBe(-CIRCLE_OFFSET);
            expect(pos.top).toBe(step * (i + 1) - CIRCLE_OFFSET);
        }
    });

    test('should correctly position circles on the bottom edge', () => {
        const step = CARD_W / (BOTTOM_COUNT + 1);
        for (let i = 0; i < BOTTOM_COUNT; i++) {
            const index = LEFT_COUNT + i;
            const pos = getCirclePosition(index, MAX_CIRCLES);
            expect(pos.left).toBe(step * (i + 1) - CIRCLE_OFFSET);
            expect(pos.top).toBe(CARD_H - CIRCLE_OFFSET);
        }
    });

    test('should correctly position circles on the right edge', () => {
        const step = CARD_H / (RIGHT_COUNT + 1);
        for (let i = 0; i < RIGHT_COUNT; i++) {
            const index = LEFT_COUNT + BOTTOM_COUNT + i;
            const pos = getCirclePosition(index, MAX_CIRCLES);
            expect(pos.left).toBe(CARD_W - CIRCLE_OFFSET);
            expect(pos.top).toBe(CARD_H - step * (i + 1) - CIRCLE_OFFSET);
        }
    });

    test('should correctly position circles on the top edge', () => {
        const step = CARD_W / (TOP_COUNT + 1);
        for (let i = 0; i < TOP_COUNT; i++) {
            const index = LEFT_COUNT + BOTTOM_COUNT + RIGHT_COUNT + i;
            const pos = getCirclePosition(index, MAX_CIRCLES);
            expect(pos.left).toBe(CARD_W - step * (i + 1) - CIRCLE_OFFSET);
            expect(pos.top).toBe(-CIRCLE_OFFSET);
        }
    });

    test('should return top edge position for index beyond max count (handled by else)', () => {
        const index = MAX_CIRCLES + 1;
        const i = index - LEFT_COUNT - BOTTOM_COUNT - RIGHT_COUNT;
        const step = CARD_W / (TOP_COUNT + 1);
        const pos = getCirclePosition(index, MAX_CIRCLES);
        expect(pos.left).toBe(CARD_W - step * (i + 1) - CIRCLE_OFFSET);
        expect(pos.top).toBe(-CIRCLE_OFFSET);
    });

    test('first index (0) should be on the left edge', () => {
        const pos = getCirclePosition(0, MAX_CIRCLES);
        const step = CARD_H / (LEFT_COUNT + 1);
        expect(pos.left).toBe(-CIRCLE_OFFSET);
        expect(pos.top).toBe(step - CIRCLE_OFFSET);
    });

    test('last index (29) should be on the top edge', () => {
        const index = MAX_CIRCLES - 1;
        const pos = getCirclePosition(index, MAX_CIRCLES);
        const step = CARD_W / (TOP_COUNT + 1);
        const i = index - LEFT_COUNT - BOTTOM_COUNT - RIGHT_COUNT;
        expect(pos.left).toBe(CARD_W - step * (i + 1) - CIRCLE_OFFSET);
        expect(pos.top).toBe(-CIRCLE_OFFSET);
    });
});
