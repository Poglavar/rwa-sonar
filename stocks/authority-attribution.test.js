// Checks capability, controller and contractual-scope separation without network access.
const {
    shapeAuthorityAttribution, summarizeAuthorityAttribution, AUTHORITY_CAPABILITIES
} = require('./lib/authority-attribution.mjs');

function byId(result, id) {
    return result.authorities.find((authority) => authority.id === id);
}

describe('authority attribution model', () => {
    test('uses token evidence for capability and issuer evidence for governance without conflating them', () => {
        const result = shapeAuthorityAttribution({
            token: { control: { mintAuthority: 'MintKey', freezeAuthority: 'FreezeKey', pausable: true, clawback: false, transferFee: false } },
            issuer: { keyGovernance: { freeze: 'multisig', mint: 'hot-key' } }
        });
        expect(byId(result, 'freeze')).toMatchObject({ technicalCapability: 'present', governance: { type: 'multisig', controller: null, signerThreshold: null } });
        expect(byId(result, 'pause').technicalCapability).toBe('present');
        expect(byId(result, 'clawback').technicalCapability).toBe('absent');
        expect(byId(result, 'transferFee').technicalCapability).toBe('absent');
        expect(byId(result, 'mint')).toMatchObject({ technicalCapability: 'present', governance: { type: 'hot-key' } });
    });

    test('treats a positive configured transfer fee as a present capability', () => {
        const result = shapeAuthorityAttribution({ token: { control: { transferFeeBps: 100 } } });
        expect(byId(result, 'transferFee').technicalCapability).toBe('present');
    });

    test('does not erase an installed zero-bps fee extension when its authorities remain live', () => {
        const result = shapeAuthorityAttribution({ token: { control: {
            transferFeeBps: 0, transferFeeConfigAuthority: 'FeeConfigKey', transferFeeWithdrawAuthority: 'FeeWithdrawKey'
        } } });
        expect(byId(result, 'transferFee').technicalCapability).toBe('present');
    });

    test('recognises a zero-bps fee extension even where no retained authority has been attributed', () => {
        const result = shapeAuthorityAttribution({ token: { control: { transferFeeBps: 0 } } });
        expect(byId(result, 'transferFee').technicalCapability).toBe('present');
    });

    test('does not turn an unobserved fee extension into an absent capability', () => {
        const result = shapeAuthorityAttribution({ token: { control: {} } });
        expect(byId(result, 'transferFee').technicalCapability).toBe('unknown');
    });

    test('does not invent permanent-delegate, upgrade, threshold, identity, rotation, or legal limits', () => {
        const result = shapeAuthorityAttribution({ token: { control: {} }, issuer: { keyGovernance: {} } });
        for (const id of ['permanentDelegate', 'upgrade']) {
            expect(byId(result, id)).toMatchObject({ technicalCapability: 'unknown', governance: {
                type: 'unknown', controller: null, signerThreshold: null, upgradeAuthority: null,
                observedAt: null, source: null, lastRotatedAt: null, technicalNotes: null, contractualCircumstances: null
            } });
        }
    });

    test('accepts reviewed structured attribution facts without parsing descriptive evidence', () => {
        const result = shapeAuthorityAttribution({ authorityFacts: {
            upgrade: { capability: true, controller: 'Programme multisig', signerThreshold: '4 of 7', upgradeAuthority: 'Vault A', observedAt: '2026-09-20', source: 'https://api.mainnet-beta.solana.com', technicalNotes: 'A technical observation', lastRotatedAt: '2026-09-20', contractualCircumstances: 'Emergency upgrade only' }
        } });
        expect(byId(result, 'upgrade')).toMatchObject({ technicalCapability: 'present', governance: {
            controller: 'Programme multisig', signerThreshold: '4 of 7', upgradeAuthority: 'Vault A',
            observedAt: '2026-09-20', source: 'https://api.mainnet-beta.solana.com', technicalNotes: 'A technical observation',
            lastRotatedAt: '2026-09-20', contractualCircumstances: 'Emergency upgrade only'
        } });
    });

    test('uses issuer research facts by default, including an effective path that differs from the PDA label', () => {
        const result = shapeAuthorityAttribution({ issuer: {
            keyGovernance: { rebase: 'program' },
            authorityFactsSource: 'https://api.mainnet-beta.solana.com',
            authorityFacts: { rebase: { effectiveGovernance: 'hot-key', controller: 'Direct UpdateMultiplierRole signer', observedAt: '2026-09-20', technicalNotes: 'Direct operational signer.' } }
        }, token: { control: { rebase: true } } });
        expect(byId(result, 'rebase')).toMatchObject({ technicalCapability: 'present', governance: {
            type: 'hot-key', controller: 'Direct UpdateMultiplierRole signer', observedAt: '2026-09-20',
            source: 'https://api.mainnet-beta.solana.com', technicalNotes: 'Direct operational signer.',
            contractualCircumstances: null
        } });
    });

    test('has the full fixed authority surface', () => {
        expect(AUTHORITY_CAPABILITIES.map(([id]) => id)).toEqual([
            'mint', 'freeze', 'pause', 'permanentDelegate', 'clawback', 'allowlist',
            'transferHook', 'transferFee', 'rebase', 'upgrade'
        ]);
    });

    test('leads with a direct multiplier signer and one-signer pause instead of the outer program label', () => {
        const model = shapeAuthorityAttribution({
            token: { control: { mintAuthority: 'MintPda', freezeAuthority: 'FreezeVault', pausable: true, rebase: true } },
            issuer: { keyGovernance: { mint: 'program', freeze: 'multisig', rebase: 'program' }, authorityFacts: {
                mint: { effectiveGovernance: 'program', upgradeGovernance: 'multisig', signerThreshold: '4 of 6' },
                freeze: { effectiveGovernance: 'multisig', signerThreshold: '3 of 8' },
                pause: { effectiveGovernance: 'single-signer-multisig', signerThreshold: '1 of 9' },
                rebase: { effectiveGovernance: 'hot-key', controller: 'Direct UpdateMultiplierRole signer' }
            } }
        });
        const summary = summarizeAuthorityAttribution(model);
        expect(summary).toMatchObject({ status: 'caution', direct: ['pause', 'rebase'], unknown: [] });
        expect(summary.headline).toContain('Direct UpdateMultiplierRole signer');
        expect(summary.headline).toContain('1 of 9');
        expect(summary.headline).not.toContain('every installed path');
    });

    test('retains eligible-voter scope instead of counting initiate-only members as voters', () => {
        const model = shapeAuthorityAttribution({
            token: { control: { mintAuthority: 'Vault' } },
            issuer: { authorityFacts: { mint: {
                effectiveGovernance: 'multisig', controller: 'Squads multisig',
                signerThreshold: '2 of 5 eligible voters (7 members; 2 initiate-only)'
            } } }
        });
        const summary = summarizeAuthorityAttribution(model);
        expect(summary.headline).toContain('2 of 5 eligible voters (7 members; 2 initiate-only)');
        expect(summary.headline).not.toContain('2 of 7');
        expect(summary.headline.match(/2 of 5 eligible voters/g)).toHaveLength(1);
    });
});
