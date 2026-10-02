// Tests for stocks/lib/power-map.mjs — the "who can touch your tokens" shaping behind powers.html.
// Each asserts a way the map could mislead: a PDA read as a private key (or the reverse), an
// unknown controller softened into a known one, an absent power drawn as held, a program path
// hiding a single upgrade key, or silence about use read as "never used".
const {
    POWERS, HOLDER_KINDS, isOnCurve, base58Decode, mintAuthorities, capabilityOver, holderKind,
    tallyAddresses, usageFor, timelockFrom, inheritSharedAddresses, shapeIssuerRow, buildPowerMap, kindCounts
} = require('./lib/power-map.mjs');

/** A jsonParsed Token-2022 mint account, as stocks/data/raw/mints-parsed-*.json keeps it. */
function rawMint({ mint = 'MintKeyAAA', freeze = 'FreezeKey', delegate = null, pause = null, scaled = null, multiplier = '1', newMultiplier = null, effectiveAt = 0, fee = null, paused = false, supply = '100', fetchedAt = '2026-09-20T01:00:00Z' } = {}) {
    const extensions = [];
    if (delegate) extensions.push({ extension: 'permanentDelegate', state: { delegate } });
    if (pause) extensions.push({ extension: 'pausableConfig', state: { authority: pause, paused } });
    if (scaled) extensions.push({ extension: 'scaledUiAmountConfig', state: { authority: scaled, multiplier, newMultiplier: newMultiplier ?? multiplier, newMultiplierEffectiveTimestamp: effectiveAt } });
    if (fee) {
        extensions.push({ extension: 'transferFeeConfig', state: {
            transferFeeConfigAuthority: fee.config, withdrawWithheldAuthority: fee.withdraw,
            newerTransferFee: { transferFeeBasisPoints: fee.bps }, withheldAmount: fee.withheld ?? 0
        } });
    }
    return { account: { data: { parsed: { info: { mintAuthority: mint, freezeAuthority: freeze, supply, extensions } } } }, _fetchedAt: fetchedAt };
}

describe('ed25519 on-curve reading of an address', () => {
    test('a programme PDA and a Squads vault are off-curve; plain signers are on-curve', () => {
        // Ondo's MINT_AUTHORITY_SEED PDA and xStocks' Squads vault: no private key can exist.
        expect(isOnCurve('9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD')).toBe(false);
        expect(isOnCurve('JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs')).toBe(false);
        // xStocks' rebase signer and the Securitize key the dossier records as on-curve.
        expect(isOnCurve('S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS')).toBe(true);
        expect(isOnCurve('8d36iv2YUD8yDChuVZchx1NqE4qkDWCAEgsUEEUqzbB6')).toBe(true);
    });

    test('anything that is not a 32-byte base58 address is null, never a guess', () => {
        expect(isOnCurve('not-base58-0OIl')).toBeNull();
        expect(isOnCurve('abc')).toBeNull();
        expect(isOnCurve(null)).toBeNull();
        expect(base58Decode('11')).toEqual(Uint8Array.from([0, 0]));
    });
});

describe('chain facts per mint', () => {
    test('reads every authority address a parsed mint names, per power, with each fee role kept apart', () => {
        const shaped = mintAuthorities(rawMint({ delegate: 'Del', pause: 'Pau', scaled: 'Reb', fee: { config: 'FeeCfg', withdraw: 'FeeWd', bps: 20 } }));
        expect(shaped.addresses.mint[0].address).toBe('MintKeyAAA');
        expect(shaped.addresses.moveBurn[0].address).toBe('Del');
        expect(shaped.addresses.pause[0].address).toBe('Pau');
        expect(shaped.addresses.rebase[0].address).toBe('Reb');
        expect(shaped.addresses.transferFee.map((row) => row.role)).toEqual(['fee-config authority', 'withheld-fee withdraw authority']);
        expect(shaped.feeBps).toBe(20);
    });

    test('an extension the mint does not carry yields no address and null state', () => {
        const shaped = mintAuthorities(rawMint({ freeze: null }));
        expect(shaped.addresses.freeze).toEqual([]);
        expect(shaped.addresses.pause).toEqual([]);
        expect(shaped.paused).toBeNull();
        expect(shaped.multiplier).toBeNull();
        expect(mintAuthorities({})).toBeNull();
    });

    test('tallies distinct addresses by how many mints name them, most first', () => {
        const tally = tallyAddresses([[{ address: 'A', role: 'r' }], [{ address: 'B', role: 'r' }], [{ address: 'B', role: 'r' }]]);
        expect(tally.distinct).toBe(2);
        expect(tally.shown.map((row) => [row.address, row.mints])).toEqual([['B', 2], ['A', 1]]);
    });
});

describe('capability and holder kind', () => {
    test('capability is all / some / none over the mints, and unobserved with no mints read', () => {
        expect(capabilityOver(['present', 'present']).state).toBe('all');
        expect(capabilityOver(['present', 'absent'])).toMatchObject({ state: 'some', present: 1, total: 2 });
        expect(capabilityOver(['absent', 'absent']).state).toBe('none');
        expect(capabilityOver(['absent', 'unknown']).state).toBe('unknown');
        expect(capabilityOver([]).state).toBe('unobserved');
    });

    test('a power absent from every mint is none, whatever the governance label says', () => {
        expect(holderKind('none', 'hot-key')).toBe('none');
        expect(holderKind('all', 'none')).toBe('none');
    });

    test('a 1-of-n multisig is a single key; unknown governance stays unknown', () => {
        expect(holderKind('all', 'single-signer-multisig')).toBe('single-key');
        expect(holderKind('all', 'hot-key')).toBe('single-key');
        expect(holderKind('all', 'multisig')).toBe('multisig');
        expect(holderKind('all', 'program')).toBe('program');
        expect(holderKind('all', 'unknown')).toBe('unknown');
        expect(holderKind('unobserved', undefined)).toBe('unknown');
        expect(HOLDER_KINDS).toEqual(['single-key', 'multisig', 'program', 'none', 'unknown']);
    });
});

describe('timelock from a reviewed note', () => {
    test('reads the first stated delay, zero when the note says there is none, null when unstated', () => {
        expect(timelockFrom('Authority is vault index 0 WV9P…; zero execution timelock; all roles share it.')).toEqual({ seconds: 0, phrase: 'zero execution timelock' });
        expect(timelockFrom('Directly submits changes; no multisig or timelock.')).toMatchObject({ seconds: 0 });
        expect(timelockFrom('Minting vault (4 of 6; 900-second timelock). Upgrade vault (4 of 7; 7,200-second timelock).')).toMatchObject({ seconds: 900 });
        expect(timelockFrom('Program upgrade/root-role vault has a 7,200-second timelock.')).toMatchObject({ seconds: 7200 });
        expect(timelockFrom('Signs multiplier changes directly.')).toBeNull();
        expect(timelockFrom(null)).toBeNull();
    });
});

describe('use of a power', () => {
    const chain = [mintAuthorities(rawMint({ scaled: 'R', multiplier: '5' })), mintAuthorities(rawMint({ scaled: 'R', multiplier: '1' }))];

    test('a dossier finding that the freeze was exercised is recorded use, with its evidence', () => {
        const issuer = { findings: [{ schema: 'freeze-authority-has-been-exercised', statement: 'Froze twice.', evidence: 'rpc:x', observedAt: '2026-09-16' }] };
        expect(usageFor('freeze', issuer, chain)).toMatchObject({ state: 'recorded', finding: { statement: 'Froze twice.', observedAt: '2026-09-16' } });
    });

    test('a multiplier other than 1 is an observed effect, counted over the mints', () => {
        expect(usageFor('rebase', {}, chain)).toEqual({ state: 'effect-observed', finding: null, effects: ['the balance multiplier in force is not 1 on 1 of 2 mints'], check: null });
    });

    test('a newMultiplier whose effective time has passed is the multiplier in force; a future one is scheduled', () => {
        // PreStocks SPACEX as read 2026-09-20: multiplier "1", newMultiplier "5" effective 2026-06-10.
        const past = mintAuthorities(rawMint({ scaled: 'R', multiplier: '1', newMultiplier: '5', effectiveAt: 1781065800 }));
        expect(past).toMatchObject({ multiplier: '5', multiplierPending: null });
        const future = mintAuthorities(rawMint({ scaled: 'R', multiplier: '1', newMultiplier: '2', effectiveAt: 1893456000 }));
        expect(future).toMatchObject({ multiplier: '1', multiplierPending: '2' });
        expect(usageFor('rebase', {}, [future]).effects).toEqual(['a multiplier change is scheduled on 1 of 1 mints']);
    });

    test('no record is not-recorded, never a claim that the power was never used', () => {
        const usage = usageFor('moveBurn', {}, chain);
        expect(usage.state).toBe('not-recorded');
        expect(usage.check).toBeNull();
        expect(JSON.stringify(usage)).not.toMatch(/never/);
    });

    test('a reviewed search of the authority’s history is carried as a bounded check, not as use', () => {
        const useCheck = { statement: 'No transfer or burn in 10 transactions names it as authority.', through: '2026-09-23', source: 'rpc:getSignaturesForAddress X' };
        const usage = usageFor('moveBurn', {}, chain, useCheck);
        expect(usage).toMatchObject({ state: 'not-recorded', finding: null, check: useCheck });
        // A check without its statement or its end date is no check at all.
        expect(usageFor('moveBurn', {}, chain, { statement: 'x' }).check).toBeNull();
    });
});

describe('the xStocks move / burn cell, from the dossier itself', () => {
    const dossier = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'data/issuers/xstocks-backed.json'), 'utf8'));
    const issuer = { slug: 'xstocks-backed', name: 'xStocks', ...dossier };
    const token = { mint: 'X1', issuer: 'xstocks-backed', control: { permanentDelegate: true } };
    const chainByMint = new Map([['X1', mintAuthorities(rawMint({ delegate: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq' }))]]);
    const cell = shapeIssuerRow(issuer, [token], chainByMint).cells.find((row) => row.power === 'moveBurn');

    test('names the 2-of-3 Squads vault and its zero timelock, as keyGovernance evidence records', () => {
        expect(cell).toMatchObject({ kind: 'multisig', signerThreshold: '2 of 3', timelock: { seconds: 0 } });
        expect(cell.controller).toContain('Dsm8Dmh6ip3pc19G3oB3FBc2Kx7A9sQBSA2akD2Jraot');
        expect(cell.technicalNotes).toContain('5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq');
        // Every fact is one the dossier's own evidence already states.
        for (const text of ['Dsm8Dmh6ip3pc19G3oB3FBc2Kx7A9sQBSA2akD2Jraot', 'threshold 2 of 3, timeLock 0', '1,845 transactions', '2026-09-23']) {
            expect(dossier.keyGovernance.evidence).toContain(text);
        }
    });

    test('carries the dossier’s search of the vault’s history as the use check', () => {
        expect(cell.usage.state).toBe('not-recorded');
        expect(cell.usage.check.statement).toContain('1,845 transactions');
        expect(cell.usage.check.through).toBe('2026-09-23');
        expect(dossier.keyGovernance.evidence).toContain(cell.usage.check.statement.replace(/\.$/, ''));
    });
});

describe('issuer rows', () => {
    const tokens = [
        { mint: 'M1', issuer: 'demo', control: { mintAuthority: 'Prog', freezeAuthority: 'F', permanentDelegate: true, pausable: true, transferFee: false, rebase: true } },
        { mint: 'M2', issuer: 'demo', control: { mintAuthority: 'Prog', freezeAuthority: 'F', permanentDelegate: true, pausable: true, transferFee: false, rebase: true } }
    ];
    const chainByMint = new Map([
        ['M1', mintAuthorities(rawMint({ mint: 'Prog', freeze: 'F', delegate: 'D', pause: 'D', scaled: 'Prog' }))],
        ['M2', mintAuthorities(rawMint({ mint: 'Prog', freeze: 'F', delegate: 'D', pause: 'D', scaled: 'Prog' }))]
    ]);

    test('a program path whose upgrade key is a single signer resolves to a single key', () => {
        const issuer = {
            slug: 'demo', name: 'Demo', keyGovernance: { mint: 'program', freeze: 'multisig', delegate: 'hot-key', rebase: 'program' },
            authorityFacts: { mint: { upgradeGovernance: 'hot-key', upgradeAuthority: 'OneKey' } }
        };
        const row = shapeIssuerRow(issuer, tokens, chainByMint);
        const mint = row.cells.find((cell) => cell.power === 'mint');
        expect(mint).toMatchObject({ kind: 'single-key', viaProgramUpgrade: true, upgradeAuthority: 'OneKey' });
        // Without upgrade evidence the program path stays a program, not a guess.
        expect(row.cells.find((cell) => cell.power === 'rebase').kind).toBe('program');
        expect(row.cells.find((cell) => cell.power === 'transferFee').kind).toBe('none');
        expect(row.cells.map((cell) => cell.power)).toEqual(POWERS.map((power) => power.id));
    });

    test('an unknown power held by the same address as a known one inherits it, and says from where', () => {
        const issuer = { slug: 'demo', name: 'Demo', keyGovernance: { mint: 'program', freeze: 'multisig', delegate: 'hot-key', rebase: 'program' } };
        const pause = shapeIssuerRow(issuer, tokens, chainByMint).cells.find((cell) => cell.power === 'pause');
        expect(pause).toMatchObject({ kind: 'single-key', inheritedFrom: 'moveBurn' });
    });

    test('an address shared with powers of different kinds does not inherit either', () => {
        const cells = [
            { power: 'mint', kind: 'program', inheritedFrom: null },
            { power: 'rebase', kind: 'single-key', inheritedFrom: null },
            { power: 'pause', kind: 'unknown', inheritedFrom: null }
        ];
        const chain = [{ addresses: { mint: [{ address: 'X' }], rebase: [{ address: 'X' }], pause: [{ address: 'X' }] } }];
        const pause = inheritSharedAddresses(cells, chain).find((cell) => cell.power === 'pause');
        expect(pause.kind).toBe('unknown');
        expect(pause.sameAddressAs).toEqual(['mint', 'rebase']);
    });

    test('a programme with no readable mint keeps its dossier governance but an unobserved capability', () => {
        const issuer = { slug: 'gone', name: 'Gone', keyGovernance: { mint: 'multisig', freeze: 'unknown' } };
        const row = shapeIssuerRow(issuer, [], new Map());
        expect(row.mints).toBe(0);
        expect(row.chainReadAt).toBeNull();
        expect(row.cells.find((cell) => cell.power === 'mint')).toMatchObject({ kind: 'multisig', capability: { state: 'unobserved' } });
        expect(row.cells.find((cell) => cell.power === 'freeze').kind).toBe('unknown');
    });

    test('the whole map carries its sources with their own observation times, and counts every cell', () => {
        const map = buildPowerMap({
            issuersDb: { builtAt: '2026-09-23T11:58:24Z', issuers: [{ slug: 'demo', name: 'Demo', keyGovernance: {} }] },
            tokensDb: { builtAt: '2026-09-23T11:58:24Z', tokens },
            onchain: { fetchedAt: '2026-09-20T10:28:25Z', source: { rawFile: 'mints-parsed-2026-09-20.json', rpc: 'rpc', method: 'getMultipleAccounts' } },
            raw: { accounts: { M1: rawMint(), M2: rawMint() } },
            builtAt: '2026-09-24T00:00:00Z'
        });
        expect(map.sources.chain).toMatchObject({ fetchedAt: '2026-09-20T10:28:25Z', file: 'stocks/data/raw/mints-parsed-2026-09-20.json', mintsRead: 2 });
        expect(map.issuers[0].chainReadAt).toEqual({ from: '2026-09-20T01:00:00Z', to: '2026-09-20T01:00:00Z' });
        const total = Object.values(kindCounts(map.issuers)).reduce((a, b) => a + b, 0);
        expect(total).toBe(POWERS.length);
    });
});
