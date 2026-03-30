const { getOrderedAttestors } = require('./asset-modal.js');

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
