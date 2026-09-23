// Loopscale (Solana order-book lending) detection, pure: which stock mints are posted as collateral
// in Loopscale Loan accounts, decoded from the account bytes. Loopscale publishes no collateral
// registry for these mints, so the evidence is the chain itself: a token account whose owner is a
// Loan account of the Loopscale program (found through the top-20 holder scan), then that Loan's
// own bytes. Program id and layout come from Loopscale's publications, recorded in
// LOOPSCALE_ATTRIBUTION below; no offset here is guessed.

export const LOOPSCALE_PROGRAM_ID = '1oopBoJG58DgkUVKkEzKgyG9dvRmpgeEm1AVjoHkF78';

/** Where the program id and the Loan layout come from, checked 2026-09-23. */
export const LOOPSCALE_ATTRIBUTION = {
    checkedAt: '2026-09-23',
    strength: 'protocol-published',
    sources: [
        { kind: 'protocol-docs', url: 'https://docs.loopscale.com/resources/addresses',
            note: 'Loopscale’s “Addresses” page lists 1oopBoJG58DgkUVKkEzKgyG9dvRmpgeEm1AVjoHkF78 as the “Loopscale Core Program” (Solana mainnet).' },
        { kind: 'protocol-idl', url: 'https://github.com/LoopscaleLabs/loopscale-pricing-adapters/blob/cd0d4692ee/src/contracts/loopscale.json',
            note: 'The Anchor IDL in Loopscale’s own GitHub organisation carries the same address and defines the Loan account decoded here.' },
        { kind: 'onchain-security-txt', url: 'https://solscan.io/account/1oopBoJG58DgkUVKkEzKgyG9dvRmpgeEm1AVjoHkF78',
            note: 'The deployed program binary embeds a security.txt naming “Loopscale”, security@loopscale.com and github.com/LoopscaleLabs/loopscale-program-library (self-asserted by the deployer).' }
    ]
};

export const LOOPSCALE_IDL_URL = LOOPSCALE_ATTRIBUTION.sources[1].url;

// Anchor account discriminator of `Loan` in the IDL above.
export const LOAN_DISCRIMINATOR = Object.freeze([20, 195, 70, 117, 165, 227, 182, 1]);

// The IDL declares Loan and its members bytemuck `repr(C, packed)`, so offsets are the plain running
// sum of field sizes: Ledger = 182 bytes, CollateralData = 73, each matrix 5×5 u32 “cbps”. The IDL's
// Loan is 1634 bytes; live version-2 loans are 1658 — 24 zero bytes appended after the matrices
// (observed 2026-09-23), so everything decoded below lies inside the IDL-described prefix.
export const LOAN_LAYOUT = Object.freeze({
    size: 1634,
    version: 8, bump: 9, loanStatus: 10, borrower: 11, nonce: 43, startTime: 51,
    ledgers: 59, ledgerSize: 182, slots: 5,
    ledger: { status: 0, strategy: 1, principalMint: 33, marketInformation: 65, principalDue: 97, principalRepaid: 105,
        interestDue: 113, interestRepaid: 121, startTime: 158, endTime: 166 },
    collateral: 969, collateralSize: 73,
    collateralItem: { assetMint: 0, amount: 32, assetType: 40, assetIdentifier: 41 },
    weightMatrix: 1334, ltvMatrix: 1434, lqtMatrix: 1534
});

// IDL: "helper type to store u32 cbps values" — centi-basis points, so 1,000,000 = 100 %
// (the live SECZ loan's weight cell reads exactly 1,000,000).
const CBPS_PER_UNIT = 1_000_000;
const DEFAULT_KEY = '11111111111111111111111111111111';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes) {
    let n = 0n;
    for (const byte of bytes) n = (n << 8n) + BigInt(byte);
    let out = '';
    while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
    for (const byte of bytes) { if (byte !== 0) break; out = '1' + out; }
    return out;
}

/** The discriminator as the base58 string a getProgramAccounts memcmp filter takes. */
export const LOAN_DISCRIMINATOR_BASE58 = base58(LOAN_DISCRIMINATOR);

function key(buf, offset) { return base58(buf.subarray(offset, offset + 32)); }
function u64(buf, offset) { return buf.readBigUInt64LE(offset).toString(); }
function time(buf, offset) {
    const seconds = Number(buf.readBigUInt64LE(offset));
    return seconds > 0 ? new Date(seconds * 1000).toISOString().replace('.000Z', 'Z') : null;
}
function matrix(buf, offset) {
    return Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => buf.readUInt32LE(offset + (i * 5 + j) * 4)));
}

/**
 * Decode one Loan account from its raw bytes (Buffer/Uint8Array or base64 string). Returns null
 * when the bytes are not a Loan (wrong discriminator or shorter than the IDL layout) — a caller must
 * not read a foreign account as a loan. Empty ledger/collateral slots are dropped. `loanStatus` and
 * ledger `status` stay raw codes: the IDL does not name their values.
 */
export function decodeLoan(data) {
    const buf = typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data ?? []);
    const L = LOAN_LAYOUT;
    if (buf.length < L.size || LOAN_DISCRIMINATOR.some((byte, i) => buf[i] !== byte)) return null;
    const ledgers = [];
    for (let i = 0; i < L.slots; i += 1) {
        const o = L.ledgers + i * L.ledgerSize;
        const principalMint = key(buf, o + L.ledger.principalMint);
        if (principalMint === DEFAULT_KEY) continue;
        ledgers.push({
            index: i,
            status: buf[o + L.ledger.status],
            strategy: key(buf, o + L.ledger.strategy),
            principalMint,
            marketInformation: key(buf, o + L.ledger.marketInformation),
            principalDueRaw: u64(buf, o + L.ledger.principalDue),
            principalRepaidRaw: u64(buf, o + L.ledger.principalRepaid),
            interestDueRaw: u64(buf, o + L.ledger.interestDue),
            interestRepaidRaw: u64(buf, o + L.ledger.interestRepaid),
            startTime: time(buf, o + L.ledger.startTime),
            endTime: time(buf, o + L.ledger.endTime)
        });
    }
    const collateral = [];
    for (let i = 0; i < L.slots; i += 1) {
        const o = L.collateral + i * L.collateralSize;
        const assetMint = key(buf, o + L.collateralItem.assetMint);
        const amountRaw = u64(buf, o + L.collateralItem.amount);
        if (assetMint === DEFAULT_KEY || amountRaw === '0') continue;
        collateral.push({
            index: i,
            assetMint,
            amountRaw,
            assetType: buf[o + L.collateralItem.assetType],
            assetIdentifier: key(buf, o + L.collateralItem.assetIdentifier)
        });
    }
    return {
        version: buf[L.version],
        loanStatus: buf[L.loanStatus],
        borrower: key(buf, L.borrower),
        startTime: time(buf, L.startTime),
        ledgers,
        collateral,
        ltvMatrixCbps: matrix(buf, L.ltvMatrix),
        lqtMatrixCbps: matrix(buf, L.lqtMatrix)
    };
}

/**
 * A matrix cell is only attributable to a (ledger, collateral) pair when the loan has exactly one
 * of each and exactly one non-zero cell: the IDL does not say which axis is which, so any other
 * shape yields null rather than a guessed orientation.
 */
export function unambiguousCell(loan, matrixCbps) {
    if (!loan || loan.ledgers.length !== 1 || loan.collateral.length !== 1) return null;
    const cells = (matrixCbps ?? []).flat().filter((value) => value > 0);
    return cells.length === 1 ? cells[0] / CBPS_PER_UNIT : null;
}

function uiAmount(raw, decimals) {
    return Number.isFinite(decimals) && typeof raw === 'string' ? Number(raw) / (10 ** decimals) : null;
}

/**
 * Candidate owner addresses from the saved top-20 holder scan: every wallet/account that holds one
 * of the covered mints. Only these are checked for a Loopscale owner, so coverage is exactly the
 * mints (and depths) holders.json reached.
 */
export function holderOwners(holders) {
    const owners = new Set();
    for (const item of Array.isArray(holders?.items) ? holders.items : []) {
        for (const row of Array.isArray(item?.top20) ? item.top20 : []) {
            if (typeof row?.owner === 'string' && row.owner) owners.add(row.owner);
        }
    }
    return [...owners].sort();
}

/**
 * Join the holder scan with decoded Loans. `loans` maps loan address → decodeLoan() result.
 * Returns one position per (stock token account, loan) where the token account's owner is a Loan
 * and that Loan's own collateral record names the same mint; a mismatch is reported, not dropped.
 */
export function loopscalePositions(holders, loans) {
    const positions = [];
    for (const item of Array.isArray(holders?.items) ? holders.items : []) {
        for (const row of Array.isArray(item?.top20) ? item.top20 : []) {
            const loan = loans.get(row?.owner);
            if (!loan) continue;
            const posted = loan.collateral.find((entry) => entry.assetMint === item.mint) ?? null;
            positions.push({
                mint: item.mint,
                symbol: item.symbol ?? null,
                tokenAccount: row.tokenAccount,
                tokenAccountAmountUi: typeof row.amountUi === 'number' ? row.amountUi : null,
                loanAddress: row.owner,
                loan,
                collateral: posted,
                matchesLoanRecord: posted !== null
            });
        }
    }
    return positions;
}

/** One lending integration per stock mint with decoded Loopscale collateral. */
export function loopscaleUsage(token, scan) {
    const rows = (Array.isArray(scan?.positions) ? scan.positions : [])
        .filter((row) => row.mint === token?.mint && row.matchesLoanRecord);
    if (rows.length === 0) return [];
    const decimals = Number.isFinite(token?.decimals) ? token.decimals : null;
    const collateralTokens = rows.reduce((total, row) => total + (uiAmount(row.collateral.amountRaw, decimals) ?? 0), 0);
    const price = Number.isFinite(token?.market?.usdPrice) ? token.market.usdPrice : null;
    const ltvs = rows.map((row) => unambiguousCell(row.loan, row.loan.ltvMatrixCbps)).filter((value) => value !== null);
    const lqts = rows.map((row) => unambiguousCell(row.loan, row.loan.lqtMatrixCbps)).filter((value) => value !== null);
    const borrowing = rows.some((row) => row.loan.ledgers.some((ledger) => ledger.principalDueRaw !== '0'));
    return [{
        id: 'loopscale:collateral',
        protocolId: 'loopscale',
        protocolName: 'Loopscale',
        category: 'lending',
        status: 'live',
        actions: borrowing ? ['collateral', 'borrow'] : ['collateral'],
        summary: `This exact mint is posted as collateral in ${rows.length} Loopscale loan account${rows.length === 1 ? '' : 's'}, read and decoded directly on-chain. Loopscale lists no standing market for it: terms are set per lender strategy on its order book.`,
        accessNote: 'Observed loans, not a published collateral listing. Loopscale and issuer eligibility, allowlisting and transfer restrictions apply to any new loan or liquidation transfer.',
        links: { use: 'https://app.loopscale.com/', protocol: 'https://docs.loopscale.com/resources/addresses' },
        metrics: {
            positions: rows.length,
            collateralTokens: decimals === null ? null : collateralTokens,
            sizeUsd: price === null || decimals === null ? null : collateralTokens * price,
            maxLtvMin: ltvs.length ? Math.min(...ltvs) : null,
            maxLtvMax: ltvs.length ? Math.max(...ltvs) : null,
            liquidationLtvMin: lqts.length ? Math.min(...lqts) : null,
            liquidationLtvMax: lqts.length ? Math.max(...lqts) : null
        },
        markets: rows.map((row) => {
            const ledger = row.loan.ledgers[0] ?? null;
            return {
                name: `Loopscale loan ${row.loanAddress.slice(0, 4)}…${row.loanAddress.slice(-4)}`,
                loanAddress: row.loanAddress,
                tokenAccount: row.tokenAccount,
                borrower: row.loan.borrower,
                collateralAmountRaw: row.collateral.amountRaw,
                collateralTokens: uiAmount(row.collateral.amountRaw, decimals),
                debtMint: ledger?.principalMint ?? null,
                principalDueRaw: ledger?.principalDueRaw ?? null,
                ledgerCount: row.loan.ledgers.length,
                loanStartTime: row.loan.startTime,
                ledgerEndTime: ledger?.endTime ?? null
            };
        }),
        decoding: {
            decoder: 'stocks/lib/loopscale.mjs decodeLoan()',
            idl: LOOPSCALE_IDL_URL,
            slot: Number.isFinite(scan?.slot) ? scan.slot : null,
            observedAt: scan?.fetchedAt ?? null,
            scope: 'Loan account collateral and ledger records (position state), not a market-wide configuration.'
        },
        evidence: [{
            type: 'onchain-account',
            url: `https://solscan.io/account/${rows[0].loanAddress}`,
            note: `${rows.length} token account${rows.length === 1 ? '' : 's'} holding this mint ${rows.length === 1 ? 'is' : 'are'} owned by a Loan account of program ${LOOPSCALE_PROGRAM_ID}, and each Loan's own collateral record names this mint and amount.`
        }, {
            type: 'program-attribution',
            url: LOOPSCALE_ATTRIBUTION.sources[0].url,
            note: 'The program id is named as Loopscale’s core program by Loopscale’s docs, the IDL in its GitHub organisation, and the program’s on-chain security.txt.'
        }]
    }];
}
