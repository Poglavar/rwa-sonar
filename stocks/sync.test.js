// Unit tests for the pure diff/merge logic in sync-assets-db.mjs: how a record is created or
// updated, which booleans reach rwa-assets-db.json, how a record's attestation rows are replaced
// in place, and that re-serialising either DB file preserves its own indentation byte for byte.
// The CLI itself is guarded, so importing the module here runs no I/O and writes nothing.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
    MAX_DESCRIPTION,
    NEUTRAL_ASSET_IMAGE,
    REPAIRS,
    attestationRow,
    detectIndent,
    firstSampleMint,
    mergeRecord,
    mergeRecords,
    replaceAttestations,
    selectAttestations,
    siteBooleans,
    stringifyLike,
    truncateDescription
} = require('./sync-assets-db.mjs');

const REPO_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------- file formatting

describe('indentation is preserved', () => {
    test.each([
        ['rwa-assets-db.json', 4],
        ['attestations-db.json', 2]
    ])('%s round-trips byte for byte at indent %i', (file, indent) => {
        const original = readFileSync(join(REPO_ROOT, file), 'utf8');
        expect(detectIndent(original)).toBe(indent);
        expect(stringifyLike(JSON.parse(original), original)).toBe(original);
    });

    test('detectIndent reads the first indented line, and tabs stay tabs', () => {
        expect(detectIndent('[\n  {\n    "a": 1\n  }\n]')).toBe(2);
        expect(detectIndent('[\n    {\n        "a": 1\n    }\n]')).toBe(4);
        expect(detectIndent('[\n\t{\n\t\t"a": 1\n\t}\n]')).toBe('\t');
        expect(detectIndent('[]')).toBe(2);
        expect(detectIndent('[]', 4)).toBe(4);
    });

    test('a file with no trailing newline does not gain one', () => {
        const compact = '[\n    {\n        "a": 1\n    }\n]';
        expect(stringifyLike(JSON.parse(compact), compact)).toBe(compact);
        expect(stringifyLike(JSON.parse(`${compact}\n`), `${compact}\n`)).toBe(`${compact}\n`);
    });
});

// ---------------------------------------------------------------- record merge

describe('mergeRecord', () => {
    const existing = {
        name: 'Kraken xStocks',
        ticker: '',
        asset_image: 'https://xstocks.com/favicon.svg',
        type: 'Tokenized Equity',
        description: 'old text',
        website: 'https://xstocks.com',
        tokenStandard: 'SPL',
        blockchainIsMainLedger: 'no',
        meetingOfMinds: 'yes',
        issuer: 'Kraken'
    };

    test('an update keeps every untouched key in its original position', () => {
        const { record, changes, created } = mergeRecord(existing, {
            fields: [
                ['type', 'Tokenized Equity (Tracker Certificates)', 'set'],
                ['tokenStandard', 'Token-2022', 'set'],
                ['status', 'live', 'set'],
                ['blockchainIsMainLedger', 'yes', 'set']
            ],
            remove: ['meetingOfMinds']
        });

        expect(created).toBe(false);
        expect(Object.keys(record)).toEqual([
            'name', 'ticker', 'asset_image', 'type', 'description', 'website', 'tokenStandard',
            'blockchainIsMainLedger', 'issuer', 'status'
        ]);
        expect(record.type).toBe('Tokenized Equity (Tracker Certificates)');
        expect(record.blockchainIsMainLedger).toBe('yes');
        expect(record).not.toHaveProperty('meetingOfMinds');
        expect(changes).toEqual([
            { field: 'type', from: 'Tokenized Equity', to: 'Tokenized Equity (Tracker Certificates)' },
            { field: 'tokenStandard', from: 'SPL', to: 'Token-2022' },
            { field: 'blockchainIsMainLedger', from: 'no', to: 'yes' },
            { field: 'meetingOfMinds', from: 'yes', to: undefined, removed: true },
            { field: 'status', from: undefined, to: 'live', added: true }
        ]);
    });

    test('"fill" only writes where the record has no value, and blank counts as no value', () => {
        const { record, changes } = mergeRecord(existing, {
            fields: [
                ['name', 'Something Else', 'fill'],
                ['asset_image', NEUTRAL_ASSET_IMAGE, 'fill'],
                ['website', 'https://example.com', 'fill'],
                ['ticker', 'KRKX', 'fill'],
                ['blockchain_logo', './images/solana-logo.svg', 'fill']
            ]
        });
        expect(record.name).toBe('Kraken xStocks');
        expect(record.asset_image).toBe('https://xstocks.com/favicon.svg');
        expect(record.website).toBe('https://xstocks.com');
        // `ticker` is present but empty, so it is treated as missing and filled.
        expect(record.ticker).toBe('KRKX');
        expect(record.blockchain_logo).toBe('./images/solana-logo.svg');
        expect(changes.map((c) => c.field).sort()).toEqual(['blockchain_logo', 'ticker']);
    });

    test('an unchanged value is not reported as a change', () => {
        const { changes } = mergeRecord(existing, { fields: [['issuer', 'Kraken', 'set']] });
        expect(changes).toEqual([]);
    });

    test('a create writes the fields in the given order and reports them all', () => {
        const { record, changes, created } = mergeRecord(null, {
            fields: [
                ['name', 'Tessera', 'fill'],
                ['ticker', '', 'fill'],
                ['type', 'Pre-IPO Loan Participation', 'set'],
                ['status', 'live', 'set'],
                ['issuer', 'Tessera', 'set']
            ],
            remove: ['meetingOfMinds', 'aiReady']
        });
        expect(created).toBe(true);
        expect(Object.keys(record)).toEqual(['name', 'ticker', 'type', 'status', 'issuer']);
        expect(changes).toHaveLength(5);
        expect(changes.every((c) => c.added === true)).toBe(true);
        // Removing a key that was never there is not a change.
        expect(changes.map((c) => c.field)).not.toContain('meetingOfMinds');
    });

    test('an undefined value is skipped rather than written as null', () => {
        const { record, changes } = mergeRecord(existing, {
            fields: [['contractAddress', undefined, 'set'], ['status', 'live', 'set']]
        });
        expect(record).not.toHaveProperty('contractAddress');
        expect(changes).toEqual([{ field: 'status', from: undefined, to: 'live', added: true }]);
    });
});

describe('mergeRecords', () => {
    const rows = [
        { name: 'Circle USDC', type: 'Stablecoin (USD)' },
        { name: 'Kraken xStocks', type: 'Tokenized Equity' },
        { name: 'Oro GOLD', type: 'Tokenized Commodity (Gold)' }
    ];

    test('matched records are updated in place and new ones are appended', () => {
        const { rows: out, diffs } = mergeRecords(rows, [
            { slug: 'xstocks-backed', name: 'Kraken xStocks', fields: [['type', 'Tokenized Equity (Tracker Certificates)', 'set']] },
            { slug: 'tessera', name: 'Tessera', fields: [['name', 'Tessera', 'fill'], ['type', 'Pre-IPO Loan Participation', 'set']] }
        ]);

        expect(out.map((r) => r.name)).toEqual(['Circle USDC', 'Kraken xStocks', 'Oro GOLD', 'Tessera']);
        expect(out[1].type).toBe('Tokenized Equity (Tracker Certificates)');
        expect(out[0]).toBe(rows[0]);
        expect(diffs.map((d) => d.created)).toEqual([false, true]);
    });

    test('the input array is not mutated', () => {
        const before = JSON.stringify(rows);
        mergeRecords(rows, [{ slug: 'x', name: 'Kraken xStocks', fields: [['type', 'changed', 'set']] }]);
        expect(JSON.stringify(rows)).toBe(before);
    });
});

// ---------------------------------------------------------------- booleans

describe('siteBooleans', () => {
    test('only definite yes/no values are written; everything else is removed', () => {
        const { write, remove } = siteBooleans({
            blockchainIsMainLedger: { value: 'yes', reason: 'cited' },
            unconditionalTransfers: { value: 'no', reason: 'cited' },
            bearerRedemption: { value: 'unknown', reason: 'no evidence either way' },
            forcedTransfers: 'yes',
            titleDeed: '',
            tokenSelfCustody: 'yes',
            issuerIndependent: 'no',
            presetJurisdiction: 'yes',
            thirdPartyAttestations: 'no',
            aiReady: 'yes',
            // The three booleans that must never be written are not even considered here.
            reflectLegalDecisions: 'yes',
            meetingOfMinds: 'yes',
            assetSelfCustody: 'yes'
        });

        expect(Object.fromEntries(write)).toEqual({
            blockchainIsMainLedger: 'yes',
            unconditionalTransfers: 'no',
            forcedTransfers: 'yes',
            tokenSelfCustody: 'yes',
            issuerIndependent: 'no',
            presetJurisdiction: 'yes',
            thirdPartyAttestations: 'no',
            aiReady: 'yes'
        });
        expect(remove).toEqual(['bearerRedemption', 'titleDeed']);
        for (const [key] of write) {
            expect(['reflectLegalDecisions', 'meetingOfMinds', 'assetSelfCustody']).not.toContain(key);
        }
    });

    test('an absent vocabulary removes all ten rather than writing anything', () => {
        expect(siteBooleans(undefined).write).toEqual([]);
        expect(siteBooleans(undefined).remove).toHaveLength(10);
        expect(siteBooleans({}).remove).toHaveLength(10);
    });
});

// ---------------------------------------------------------------- attestations

describe('replaceAttestations', () => {
    const rows = [
        { assetName: 'Circle USDC', schema: 'a' },
        { assetName: 'Kraken xStocks', schema: 'old-1' },
        { assetName: 'Oro GOLD', schema: 'b' },
        { assetName: 'Kraken xStocks', schema: 'old-2' },
        { assetName: 'Oro GOLD', schema: 'c' }
    ];

    test('existing rows are deleted and the new ones land where the first one sat', () => {
        const { rows: out, summary } = replaceAttestations(rows, [
            { assetName: 'Kraken xStocks', rows: [{ assetName: 'Kraken xStocks', schema: 'new-1' }, { assetName: 'Kraken xStocks', schema: 'new-2' }] }
        ]);

        expect(out.map((r) => `${r.assetName}:${r.schema}`)).toEqual([
            'Circle USDC:a',
            'Kraken xStocks:new-1',
            'Kraken xStocks:new-2',
            'Oro GOLD:b',
            'Oro GOLD:c'
        ]);
        expect(summary[0].deleted.map((r) => r.schema)).toEqual(['old-1', 'old-2']);
        expect(summary[0].inserted).toHaveLength(2);
    });

    test('a record with no existing rows is appended', () => {
        const { rows: out, summary } = replaceAttestations(rows, [
            { assetName: 'Tessera', rows: [{ assetName: 'Tessera', schema: 'new' }] }
        ]);
        expect(out).toHaveLength(6);
        expect(out[5]).toEqual({ assetName: 'Tessera', schema: 'new' });
        expect(summary[0].deleted).toEqual([]);
    });

    test('replacing with an empty group deletes without inserting', () => {
        const { rows: out } = replaceAttestations(rows, [{ assetName: 'Oro GOLD', rows: [] }]);
        expect(out.map((r) => r.assetName)).toEqual(['Circle USDC', 'Kraken xStocks', 'Kraken xStocks']);
    });

    test('other records keep their objects and the input is not mutated', () => {
        const before = JSON.stringify(rows);
        const { rows: out } = replaceAttestations(rows, [{ assetName: 'Kraken xStocks', rows: [] }]);
        expect(out[0]).toBe(rows[0]);
        expect(JSON.stringify(rows)).toBe(before);
    });
});

describe('selectAttestations', () => {
    const known = new Set(['token-represents-equity', 'transfers-unrestricted']);

    test('writable rows get the record name and the file key order', () => {
        const { rows } = selectAttestations('Tessera', [{
            assetName: 'Tessera (T-OpenAI, T-SpaceX)',
            schema: 'token-represents-equity',
            attestor: 'Tessera',
            attestationDate: '2026-01-01',
            expiryDate: '',
            status: 'valid',
            onchain: true,
            link: 'https://example.com',
            statement: 'x'
        }], known);

        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0])).toEqual([
            'assetName', 'schema', 'attestor', 'attestationDate', 'expiryDate', 'status', 'onchain', 'link', 'statement'
        ]);
        expect(rows[0].assetName).toBe('Tessera');
    });

    test('a NEW: proposal or an unknown schema is skipped and reported, never written', () => {
        const { rows, skipped } = selectAttestations('Tessera', [
            { schema: 'NEW:loan-to-issuer-is-unsecured' },
            { schema: 'not-a-real-type' },
            { schema: '' },
            { schema: 'transfers-unrestricted' }
        ], known);

        expect(rows.map((r) => r.schema)).toEqual(['transfers-unrestricted']);
        expect(skipped.map((s) => s.schema)).toEqual(['NEW:loan-to-issuer-is-unsecured', 'not-a-real-type', '(none)']);
        expect(skipped[0].reason).toMatch(/NEW:/);
    });

    test('absent optional fields fall back to the conventions the file already uses', () => {
        const { rows } = selectAttestations('Tessera', [{ schema: 'transfers-unrestricted' }], known);
        expect(rows[0]).toEqual({
            assetName: 'Tessera',
            schema: 'transfers-unrestricted',
            attestor: '',
            attestationDate: '',
            expiryDate: '',
            status: 'valid',
            onchain: false,
            link: '#',
            statement: ''
        });
    });

    test('an absent attestations array yields nothing at all', () => {
        expect(selectAttestations('Tessera', undefined, known)).toEqual({ rows: [], skipped: [] });
    });

    test('attestationRow forces onchain to a real boolean', () => {
        expect(attestationRow('X', { schema: 's', onchain: 'true' }).onchain).toBe(false);
        expect(attestationRow('X', { schema: 's', onchain: true }).onchain).toBe(true);
    });
});

// ---------------------------------------------------------------- description and mints

describe('truncateDescription', () => {
    test('a short claim is passed through with whitespace collapsed', () => {
        expect(truncateDescription('  The holder owns\nthe share.  ')).toBe('The holder owns the share.');
    });

    test('a long claim is cut at a sentence end and stays within the budget', () => {
        const first = `${'A'.repeat(200)}. `;
        const result = truncateDescription(`${first}${'B'.repeat(400)}.`);
        expect(result).toBe(`${'A'.repeat(200)}.`);
        expect(result.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    });

    test('with no sentence end in range it cuts on a word boundary and marks the cut', () => {
        const words = 'word '.repeat(200).trim();
        const result = truncateDescription(words);
        expect(result.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
        expect(result.endsWith('…')).toBe(true);
        expect(result).not.toMatch(/ …$/);
    });

    test('a sentence ending too early is ignored in favour of a fuller cut', () => {
        const result = truncateDescription(`Yes. ${'x'.repeat(500)}`);
        expect(result).not.toBe('Yes.');
        expect(result.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    });

    test('a missing claim is null, never an empty string', () => {
        expect(truncateDescription(null)).toBeNull();
        expect(truncateDescription(undefined)).toBeNull();
        expect(truncateDescription('   ')).toBeNull();
        expect(truncateDescription(42)).toBeNull();
    });
});

describe('firstSampleMint', () => {
    test('skips the dossier entries that are authority keys or prose, not addresses', () => {
        expect(firstSampleMint({
            sampleMints: [
                { symbol: 'rSPAX / rSpaceX (genuine Mirror Note)', mint: 'unknown — never published' },
                { symbol: 'BLSH', mint: '6d5zakCaxjjRALNRyudC6ArivxeBGT3XUAci7ybWQY8U' }
            ]
        })).toBe('6d5zakCaxjjRALNRyudC6ArivxeBGT3XUAci7ybWQY8U');
    });

    test('an Ethereum address is not a Solana mint', () => {
        expect(firstSampleMint({ sampleMints: [{ mint: '0x139c8f5f0e1ff9a9e6bcaea1a06a0ba4c5c83a4b' }] })).toBeNull();
    });

    test('no usable sample yields null', () => {
        expect(firstSampleMint({ sampleMints: [] })).toBeNull();
        expect(firstSampleMint({})).toBeNull();
        expect(firstSampleMint(null)).toBeNull();
    });
});

describe('the MODEL.md §4 repair table', () => {
    test('covers the eleven issuer programmes exactly once each', () => {
        expect(REPAIRS).toHaveLength(11);
        expect(new Set(REPAIRS.map((r) => r.slug)).size).toBe(11);
        expect(new Set(REPAIRS.map((r) => r.name)).size).toBe(11);
        for (const repair of REPAIRS) {
            expect(repair.dossier).toMatch(/\.json$/);
            expect(['live', 'defunct', 'not-launched']).toContain(repair.status);
            expect(repair.website).toMatch(/^https:\/\//);
        }
    });

    test('only Ventuals is off Solana, and its token standard says so', () => {
        const offSolana = REPAIRS.filter((r) => r.blockchain !== undefined);
        expect(offSolana.map((r) => r.slug)).toEqual(['ventuals']);
        expect(offSolana[0].blockchain).toBe('Hyperliquid');
        expect(offSolana[0].tokenStandard).toBe('n/a (perpetual positions)');
    });
});
