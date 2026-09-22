// Locks fee-scope behavior and real curated data so unknowns cannot become zeros or cross-product facts.
import { readFileSync } from 'node:fs';
import economics from './lib/economics.js';

const { selectProfile, selectFees } = economics;

function fee(id, scope, amountText = null) {
    return { id, stage: 'exit', label: id, amountText, kind: amountText ? 'charge' : 'unknown', status: amountText ? 'documented' : 'unknown', payer: null, payee: null, scope, sourceIds: [], note: null };
}

describe('economics model', () => {
    test('selects any profile by id and leaves missing values null, never zero', () => {
        const data = { profiles: [{ id: 'one' }, { id: 'two' }, { id: 'three' }] };
        expect(selectProfile(data, 'two')).toEqual({ id: 'two' });
        expect(selectProfile(data, 'missing')).toBeNull();
        expect(selectFees({ fees: [fee('unknown', { level: 'programme', products: [], route: null, chain: null, holder: null })] })[0].amountText).toBeNull();
    });

    test('distinguishes programme, product, and route scopes', () => {
        const profile = { fees: [
            fee('programme-cap', { level: 'programme', products: [], route: null, chain: null, holder: null }, 'up to 5%'),
            fee('tslax', { level: 'product', products: ['TSLAx'], route: null, chain: null, holder: null }, 'up to 0.50%'),
            fee('ethereum-gas', { level: 'route', products: [], route: 'direct redemption', chain: 'Ethereum', holder: null })
        ] };
        const out = selectFees(profile, { productSymbol: 'TSLAx', route: 'direct redemption' });
        expect(out.map((row) => row.applicability)).toEqual(['applicable', 'applicable', 'route-context']);
        expect(selectFees(profile, { productSymbol: 'FGDLx', route: 'secondary' })[1]).toMatchObject({ applicability: 'not-applicable', scopeState: 'other-product-example' });
        expect(selectFees(profile, { productSymbol: 'FGDLx', route: 'secondary' })[2]).toMatchObject({ applicability: 'not-applicable', scopeState: 'other-route' });
    });

    test('shows programme constraints as context until their route or chain is supplied', () => {
        const constrained = fee('programme-context', { level: 'programme', products: [], route: 'redemption', chain: 'Solana', holder: null });
        expect(selectFees({ fees: [constrained] })[0].applicability).toBe('programme-context');
        expect(selectFees({ fees: [constrained] }, { chain: 'Solana' })[0].applicability).toBe('programme-context');
        expect(selectFees({ fees: [constrained] }, { route: 'redemption', chain: 'Solana' })[0].applicability).toBe('applicable');
        expect(selectFees({ fees: [constrained] }, { route: 'issuance', chain: 'Solana' })[0].applicability).toBe('not-applicable');
    });

    test('never gives FGDLx the TSLAx-only fee and keeps a programme cap visible', () => {
        const profile = { fees: [
            fee('programme-cap', { level: 'programme', products: [], route: null, chain: null, holder: null }, 'up to 5%'),
            fee('tslax-issuance', { level: 'product', products: ['TSLAx'], route: null, chain: null, holder: null }, 'up to 0.50%')
        ] };
        const out = selectFees(profile, { productSymbol: 'FGDLx', collapseProductExamples: true });
        expect(out.find((row) => row.id === 'programme-cap').amountText).toBe('up to 5%');
        expect(out.find((row) => row.id === 'tslax-issuance')).toBeUndefined();
        expect(out.find((row) => row.id === 'no-exact-fee-confirmed')).toMatchObject({ amountText: null, stage: 'unknown', applicability: 'no-exact-fee-confirmed' });
    });

    test('real data has the exact issuer set and does not turn the PreStocks authority into a beneficiary', () => {
        const data = JSON.parse(readFileSync(new URL('./data/economics.json', import.meta.url)));
        const issuers = JSON.parse(readFileSync(new URL('../stocks-issuers.json', import.meta.url)));
        expect(data.profiles.map((profile) => profile.id).sort()).toEqual(issuers.issuers.map(issuer => issuer.slug).sort());
        const authority = selectProfile(data, 'prestocks').actors.find((actor) => actor.role === 'protocol role');
        expect(authority.payment).toBeNull();
        expect(authority.tradeoff).toMatch(/beneficiary/i);
        const sources = Object.fromEntries(data.profiles.flatMap((profile) => profile.sources.map((source) => [`${profile.id}:${source.id}`, source])));
        for (const profile of data.profiles) for (const fee of profile.fees) {
            if (fee.status !== 'documented') continue;
            for (const sourceId of fee.sourceIds) expect(sources[`${profile.id}:${sourceId}`].url).toMatch(/^https?:\/\//);
        }
        for (const source of Object.values(sources)) for (const field of ['observedAt', 'checkedAt', 'publishedAt']) {
            if (source[field] !== null && source[field] !== undefined) expect(source[field]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        expect(selectProfile(data, 'ondo-global-markets').actors.find((actor) => actor.role === 'security agent')).toMatchObject({
            name: 'Ankura Trust Company, LLC', sourceIds: ['ondo-sales-terms']
        });
    });

    test.each(['programme', 'product', 'route'])('every constraint is checked at %s scope', (level) => {
        const item = fee('restricted', { level, products: ['TSLAx'], route: 'redemption', chain: 'Ethereum', holder: 'approved investor' });
        const options = { productSymbol: 'tslax', route: 'redemption', chain: 'Ethereum', holder: 'approved investor' };
        expect(selectFees({ fees: [item] }, options)[0].applicability).toBe('applicable');
        expect(selectFees({ fees: [item] }, { ...options, chain: 'Solana' })[0].applicability).toBe('not-applicable');
        expect(selectFees({ fees: [item] }, { ...options, holder: null })[0].applicability).toBe(`${level}-context`);
    });

    test('does not leak other product fees even where one exact fee exists', () => {
        const result = selectFees({ fees: [fee('own', { level: 'product', products: ['TSLAx'] }, '0.5%'), fee('other', { level: 'product', products: ['FGDLx'] }, '9%')] }, { productSymbol: 'TSLAx', collapseProductExamples: true });
        expect(result.map(row => row.id)).toEqual(['own']);
    });
});
