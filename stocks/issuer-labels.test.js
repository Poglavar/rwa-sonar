// Unit tests for stocks/lib/issuer-labels.js: grid placement, chip size, grade/coverage/severity
// labels, ladder tooltips, display names, the issuer order and the "New on Solana" chips. Moved
// with the code out of stocks-page.test.js (next-steps.md F11), which still tests the page wiring
// that calls it.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const REPO = join(__dirname, '..');

const {
    DASH,
    humanizeSlug
} = require('./lib/fmt.js');
const {
    CHIP_MIN_PX,
    CHIP_MAX_PX,
    GRID_STAGES,
    GRID_FIRST_DATA_COLUMN,
    chipSize,
    gridCell,
    claimAxisLabels,
    claimLabel,
    verificationLabel,
    coverageLabel,
    coverageClass,
    isControlOn,
    fmtFeeBps,
    transferFeeCapabilityLabel,
    severityRank,
    worstSeverity,
    indexTypes,
    labelForSchema,
    displayName,
    sortIssuersForDisplay,
    MATURITY_LEVEL_TOOLTIPS,
    CLAIM_RUNG_TOOLTIPS,
    maturityLevelTooltip,
    claimRungTooltip
} = require('./lib/issuer-labels.js');

describe('chipSize', () => {
    it('floors a null, zero or negative liquidity instead of collapsing the dot', () => {
        expect(chipSize(null)).toBe(CHIP_MIN_PX);
        expect(chipSize(0)).toBe(CHIP_MIN_PX);
        expect(chipSize(-5)).toBe(CHIP_MIN_PX);
        expect(chipSize(undefined)).toBe(CHIP_MIN_PX);
    });

    it('clamps both ends of the log range', () => {
        expect(chipSize(1)).toBe(CHIP_MIN_PX);
        expect(chipSize(1e3)).toBe(CHIP_MIN_PX);
        expect(chipSize(1e8)).toBe(CHIP_MAX_PX);
        expect(chipSize(1e12)).toBe(CHIP_MAX_PX);
    });

    it('scales by log10, so every decade is the same step apart from rounding', () => {
        const decades = [1e4, 1e5, 1e6, 1e7].map(chipSize);
        const steps = decades.slice(1).map((v, i) => v - decades[i]);
        const expected = (CHIP_MAX_PX - CHIP_MIN_PX) / 5;
        for (const step of steps) {
            expect(step).toBeGreaterThan(0);
            expect(Math.abs(step - expected)).toBeLessThanOrEqual(1);
        }
    });

    it('is monotonic and bounded', () => {
        expect(chipSize(1e6)).toBeGreaterThan(chipSize(1e4));
        expect(chipSize(2.6e6)).toBeLessThanOrEqual(CHIP_MAX_PX);
    });
});

describe('gridCell', () => {
    it('puts claim rung 0 in the first data column and rung 4 in the last', () => {
        expect(gridCell(0, 2).column).toBe(GRID_FIRST_DATA_COLUMN);
        expect(gridCell(4, 2).column).toBe(GRID_FIRST_DATA_COLUMN + 4);
    });

    it('puts maturity Level 4 at the top row and Level 0 at the bottom', () => {
        expect(gridCell(0, 4).row).toBe(1);
        expect(gridCell(0, 0).row).toBe(GRID_STAGES);
    });

    it('places the documented issuers where the model says', () => {
        // xStocks: Level 2, secured claim (rung 2) -> middle of the grid.
        expect(gridCell(2, 2)).toEqual({ column: 4, row: 3 });
        // Opening Bell: Level 0, registered share (rung 4) -> bottom right.
        expect(gridCell(4, 0)).toEqual({ column: 6, row: 5 });
    });

    it('refuses an unknown or out-of-range coordinate so the issuer lands in the legend', () => {
        expect(gridCell(null, 2)).toBeNull();
        expect(gridCell(2, null)).toBeNull();
        expect(gridCell(undefined, undefined)).toBeNull();
        expect(gridCell(5, 2)).toBeNull();
        expect(gridCell(-1, 2)).toBeNull();
        expect(gridCell(2, 5)).toBeNull();
        expect(gridCell(2.5, 2)).toBeNull();
        expect(gridCell('2', '2')).toBeNull();
    });
});

describe('claimAxisLabels', () => {
    it('prefers the label the data carries for each rung', () => {
        const labels = claimAxisLabels([
            { grades: { claimRung: 4, claimLabel: 'registered share' } },
            { grades: { claimRung: 0, claimLabel: 'synthetic exposure (perp)' } }
        ]);
        expect(labels[0]).toBe('synthetic exposure (perp)');
        expect(labels[4]).toBe('registered share');
    });

    it('falls back to the canonical label for an unoccupied rung', () => {
        const labels = claimAxisLabels([]);
        expect(labels).toHaveLength(5);
        expect(labels[2]).toBe('secured claim on collateral');
    });

    it('ignores issuers with no usable rung or label', () => {
        const labels = claimAxisLabels([
            { grades: { claimRung: null, claimLabel: null } },
            { grades: { claimRung: 3, claimLabel: '  ' } },
            null
        ]);
        expect(labels[3]).toBe('beneficial interest in the security');
    });
});

describe('claimLabel and verificationLabel', () => {
    it('uses the label from the data when it has one', () => {
        expect(claimLabel(2, 'secured claim on collateral')).toBe('secured claim on collateral');
        expect(verificationLabel(4, 'on-chain PoR')).toBe('on-chain PoR');
    });

    it('derives the canonical label from the number otherwise', () => {
        expect(claimLabel(4, null)).toBe('registered share');
        expect(verificationLabel(5, null)).toBe('transfer-agent register');
        expect(verificationLabel(0, '')).toBe('none');
    });

    it('dashes an unknown rung or strength rather than guessing', () => {
        expect(claimLabel(null, null)).toBe(DASH);
        expect(claimLabel(9, null)).toBe(DASH);
        expect(verificationLabel(null, null)).toBe(DASH);
        expect(verificationLabel(6, null)).toBe(DASH);
    });
});

describe('coverage and fee rendering', () => {
    it('labels the three coverage buckets and dashes anything else', () => {
        expect(coverageLabel('all')).toBe('All');
        expect(coverageLabel('some')).toBe('Some');
        expect(coverageLabel('none')).toBe('None');
        expect(coverageLabel(null)).toBe(DASH);
        expect(coverageLabel('unknown')).toBe(DASH);
    });

    it('gives each bucket its own class', () => {
        expect(coverageClass('all')).toBe('cov-all');
        expect(coverageClass('none')).toBe('cov-none');
        expect(coverageClass(undefined)).toBe('cov-unknown');
    });

    it('reads an authority address as a control in force, not just a boolean true', () => {
        // stocks-tokens.json carries control.freezeAuthority as the authority's own address on all
        // 441 mints; a `=== true` test would report that nobody can freeze anything.
        expect(isControlOn('51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK')).toBe(true);
        expect(isControlOn(true)).toBe(true);
        expect(isControlOn(false)).toBe(false);
        expect(isControlOn(null)).toBe(false);
        expect(isControlOn(undefined)).toBe(false);
        expect(isControlOn('')).toBe(false);
        expect(isControlOn('   ')).toBe(false);
    });

    it('renders a 0 bps fee as a real value, and an empty list as a dash', () => {
        expect(fmtFeeBps([0])).toBe('0 bps');
        expect(fmtFeeBps([25, 0])).toBe('0 / 25 bps');
        expect(fmtFeeBps([])).toBe(DASH);
        expect(fmtFeeBps(null)).toBe(DASH);
        expect(fmtFeeBps([null, undefined])).toBe(DASH);
    });

    it('keeps a zero current rate separate from the installed fee-setting capability', () => {
        expect(transferFeeCapabilityLabel({ transferFee: true, transferFeeBps: 0 }))
            .toBe('0 bps currently · fee-setting capability installed');
        expect(transferFeeCapabilityLabel({ transferFeeConfigAuthority: 'FeeKey' }))
            .toBe('Fee-setting capability installed · current rate not established');
        expect(transferFeeCapabilityLabel({ transferFee: false, transferFeeBps: null })).toBeNull();
    });
});

describe('severity', () => {
    it('ranks info below caution below warning below critical', () => {
        expect(severityRank('info')).toBeLessThan(severityRank('caution'));
        expect(severityRank('caution')).toBeLessThan(severityRank('warning'));
        expect(severityRank('warning')).toBeLessThan(severityRank('critical'));
        expect(severityRank('nonsense')).toBe(-1);
        expect(severityRank(null)).toBe(-1);
    });

    it('reports the worst severity in a findings list', () => {
        expect(worstSeverity([{ severity: 'info' }, { severity: 'critical' }, { severity: 'caution' }]))
            .toBe('critical');
        expect(worstSeverity([{ severity: 'info' }])).toBe('info');
    });

    it('reports nothing for an empty or absent list', () => {
        expect(worstSeverity([])).toBeNull();
        expect(worstSeverity(null)).toBeNull();
    });
});

describe('labelForSchema', () => {
    it('prefers the type name when the types file defines the slug', () => {
        const index = indexTypes([
            { schema: 'issuer-has-wound-down', name: 'Issuer has wound down' },
            { name: 'no schema, ignored' },
            null
        ]);
        expect(labelForSchema('issuer-has-wound-down', index)).toBe('Issuer has wound down');
    });

    it('humanizes the slug when the types file is missing or does not know it', () => {
        expect(labelForSchema('no-token-terms-published', indexTypes(null)))
            .toBe('No token terms published');
        expect(labelForSchema('authority-key-is-hot-wallet', undefined))
            .toBe('Authority key is hot wallet');
    });
});

describe('displayName', () => {
    it('leaves a real name alone', () => {
        expect(displayName('Kraken xStocks')).toBe('Kraken xStocks');
        expect(displayName('Tessera (Tessera Works Foundation)')).toBe('Tessera (Tessera Works Foundation)');
    });

    it('cuts the clause after an em dash', () => {
        // The name stocks-issuers.json actually carries for Bullish.
        const real = 'Bullish (NYSE: BLSH) — the securities issuer is the listed company itself, ' +
            'a Cayman Islands company (SEC CIK 0001872195, Commission File No. 001-42797)';
        expect(displayName(real)).toBe('Bullish (NYSE: BLSH)');
    });

    it('drops an overlong trailing parenthetical rather than truncating mid-word', () => {
        const real = 'Ondo Global Markets ("Ondo Stocks"; legacy "GM" prefix in APIs and contracts)';
        expect(displayName(real)).toBe('Ondo Global Markets');
    });

    it('drops a nested trailing parenthetical whole', () => {
        // stocks-issuers.json's name for xStocks; the inner "(JE)" defeats a non-greedy strip.
        expect(displayName('xStocks (Backed Finance / Backed Assets (JE) Limited)', 28)).toBe('xStocks');
    });

    it('keeps only the first sentence of a name that is really a paragraph', () => {
        const real = 'Backpack Securities (marketing name). The token issuer of record is Trek Nexus ' +
            'Markets Ltd (BVI) as bare trustee; Backpack Exchange is Trek Labs Ltd.';
        expect(displayName(real)).toBe('Backpack Securities (marketing name).');
    });

    it('does not cut at an abbreviation dot while the name still fits', () => {
        expect(displayName('Securitize Corp. (NYSE: SECZ)')).toBe('Securitize Corp. (NYSE: SECZ)');
    });

    it('hard-truncates with an ellipsis when nothing else shortens it', () => {
        const long = 'A'.repeat(80);
        const out = displayName(long, 20);
        expect(out).toHaveLength(20);
        expect(out.endsWith('…')).toBe(true);
    });

    it('respects a tighter limit for a chip label', () => {
        expect(displayName('Kraken xStocks', 28)).toBe('Kraken xStocks');
        expect(displayName('Opening Bell by Superstate Services LLC', 28).length).toBeLessThanOrEqual(28);
    });

    it('dashes an absent name', () => {
        expect(displayName(null)).toBe(DASH);
        expect(displayName('')).toBe(DASH);
        expect(displayName('   ')).toBe(DASH);
    });
});

describe('sortIssuersForDisplay', () => {
    it('puts live issuers first, by liquidity, and defunct ones last', () => {
        const issuers = [
            { slug: 'remora', name: 'Remora', status: 'defunct', market: { dexLiquidityUsd: 0 } },
            { slug: 'superstate', name: 'Opening Bell', status: 'live', market: { dexLiquidityUsd: 9420 } },
            { slug: 'xstocks', name: 'Kraken xStocks', status: 'live', market: { dexLiquidityUsd: 2_612_100 } }
        ];
        expect(sortIssuersForDisplay(issuers).map((i) => i.slug))
            .toEqual(['xstocks', 'superstate', 'remora']);
    });

    it('does not let a null liquidity outrank a real one', () => {
        const issuers = [
            { slug: 'unknown', name: 'Unknown', status: 'live', market: { dexLiquidityUsd: null } },
            { slug: 'small', name: 'Small', status: 'live', market: { dexLiquidityUsd: 1 } }
        ];
        expect(sortIssuersForDisplay(issuers).map((i) => i.slug)).toEqual(['small', 'unknown']);
    });
});

// --- the ladder tooltips (MODEL §11.4, definitions from §2.2/§3.1/§3.2) --------------------------
describe('ladder tooltips', () => {
    it('has one definition per ledger-maturity level, naming the pillar that level adds', () => {
        expect(MATURITY_LEVEL_TOOLTIPS).toHaveLength(5);
        expect(maturityLevelTooltip(0)).toMatch(/none of the four pillars/i);
        expect(maturityLevelTooltip(1)).toMatch(/blockchainIsMainLedger/);
        expect(maturityLevelTooltip(2)).toMatch(/Tokenized/);
        expect(maturityLevelTooltip(2)).toMatch(/unconditionalTransfers/);
        expect(maturityLevelTooltip(3)).toMatch(/Issuer independent/);
        expect(maturityLevelTooltip(3)).toMatch(/bearerRedemption/);
        expect(maturityLevelTooltip(4)).toMatch(/Legally integrated/);
        expect(maturityLevelTooltip(4)).toMatch(/forcedTransfers/);
    });

    it('has one definition per claim-depth rung, naming what the holder owns', () => {
        expect(CLAIM_RUNG_TOOLTIPS).toHaveLength(5);
        expect(claimRungTooltip(0)).toMatch(/synthetic exposure/i);
        expect(claimRungTooltip(1)).toMatch(/unsecured creditor/i);
        expect(claimRungTooltip(2)).toMatch(/security interest/i);
        expect(claimRungTooltip(3)).toMatch(/beneficial interest/i);
        expect(claimRungTooltip(4)).toMatch(/registered/i);
    });

    it('returns nothing at all for a level or rung that is not one of the five', () => {
        for (const bad of [-1, 5, 9, null, undefined, 1.5, '2']) {
            expect(maturityLevelTooltip(bad)).toBe('');
            expect(claimRungTooltip(bad)).toBe('');
        }
    });
});

describe('the sample fixtures', () => {
    const issuerDb = require('./fixtures/stocks-issuers.sample.json');

    it('places every live issuer on the grid or knowingly off it', () => {
        for (const issuer of issuerDb.issuers) {
            const cell = gridCell(issuer.grades.claimRung, issuer.grades.maturityStageNum);
            if (cell === null) expect(issuer.grades.claimRung).toBeNull();
            else expect(cell.column).toBeGreaterThanOrEqual(GRID_FIRST_DATA_COLUMN);
        }
    });
});

/** The row and panel "Card ↗" link, built from the same slug rule as the card builder (fmt.cardSlug). */
describe('cardLinkHtml', () => {
    const page = require('./lib/issuer-labels.js');

    it('builds the row and panel "Card" link from the computed slug', () => {
        const html = page.cardLinkHtml({ symbol: 'NVDAx', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' });
        expect(html).toContain('href="cards/NVDAx.html"');
        expect(html).toContain('class="card-link"');
        expect(page.cardLinkHtml({ symbol: '"><img src=x>', mint: 'M' })).not.toContain('<img');
        expect(page.cardLinkHtml({})).toBe('');
    });
});

// ------------------------------------------------- the "New on Solana" strip
describe('newMintChips', () => {
    const page = require('./lib/issuer-labels.js');
    const NOW = Date.parse('2026-09-17T11:50:27Z');

    /** A stocks-changes.json `newMints[]` row as build-changes.mjs writes it. */
    function feedRow(overrides = {}) {
        return {
            mint: 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES',
            symbol: 'AMD',
            name: 'Advanced Micro Devices - Backpack Securities',
            issuer: 'backpack-securities',
            issuerName: 'Backpack Securities',
            firstSeenAt: '2026-09-17T09:50:27Z',
            cardSlug: 'AMD',
            ...overrides
        };
    }

    it('shapes one chip per row, in the order the feed selected them', () => {
        const chips = page.newMintChips({
            newMints: [feedRow(), feedRow({ symbol: 'LUV', mint: 'LUV9', cardSlug: 'LUV', firstSeenAt: '2026-09-16T23:00:00Z' })]
        }, NOW);
        expect(chips.map((chip) => chip.symbol)).toEqual(['AMD', 'LUV']);
        expect(chips[0].issuer).toBe('Backpack Securities');
        expect(chips[0].href).toBe('./cards/AMD.html');
        expect(chips[0].firstSeen).toBe('2 h ago');
        expect(chips[0].title).toContain('first seen 17 Sep 2026 09:50 UTC');
    });

    it('takes its age from the instant passed in, so the same feed shapes the same way', () => {
        const [chip] = page.newMintChips({ newMints: [feedRow()] }, Date.parse('2026-09-19T09:50:27Z'));
        expect(chip.firstSeen).toBe('2 d ago');
    });

    it('leaves a missing first-seen time null rather than dating the mint now', () => {
        const [chip] = page.newMintChips({ newMints: [feedRow({ firstSeenAt: null })] }, NOW);
        expect(chip.firstSeen).toBeNull();
        expect(chip.title).not.toMatch(/first seen/);
    });

    it('never links to a card the build did not write', () => {
        const [chip] = page.newMintChips({ newMints: [feedRow({ cardSlug: null })] }, NOW);
        expect(chip.href).toBeNull();
        const [escaped] = page.newMintChips({ newMints: [feedRow({ cardSlug: 'a"><img src=x>' })] }, NOW);
        expect(escaped.href).not.toContain('<img');
    });

    it('falls back to the readable issuer slug when the build named no issuer', () => {
        const [chip] = page.newMintChips({ newMints: [feedRow({ issuerName: null, issuer: 'ondo-global-markets' })] }, NOW);
        expect(chip.issuer).toBe('Ondo global markets');
    });

    it('renders nothing at all when the file, the feed or the rows are unusable', () => {
        expect(page.newMintChips(null, NOW)).toEqual([]);
        expect(page.newMintChips({}, NOW)).toEqual([]);
        expect(page.newMintChips({ newMints: {} }, NOW)).toEqual([]);
        expect(page.newMintChips({ newMints: [null, 7, {}, { symbol: ' ' }] }, NOW)).toEqual([]);
    });

    it('reads the window off the feed and falls back to a fortnight', () => {
        expect(page.newMintsWindowDays({ newMintWindowDays: 30 })).toBe(30);
        expect(page.newMintsWindowDays(null)).toBe(14);
        expect(page.newMintsWindowDays({ newMintWindowDays: -1 })).toBe(page.NEW_MINTS_WINDOW_DAYS);
    });
});

// --- the fourth authority in the issuer panel (MODEL.md §2.7) ---------------------------------
// The panel's Key governance section and the Keys badge both read keyGovernance. The rebase key is
// the one whose omission is invisible — every other value still renders — so it is pinned here.
describe('the rebase authority in the issuer panel', () => {
    const { readFileSync } = require('node:fs');
    const S = require('./lib/issuer-labels.js');

    it('reads all four authorities, in the §2.7 order', () => {
        expect(S.KEY_GOVERNANCE_ROLES).toEqual(['mint', 'freeze', 'delegate', 'rebase']);
    });

    it("labels 'none' rather than falling back to the raw slug", () => {
        // Only `rebase` can be genuinely absent, and 'none' must read as a fact about the mint.
        expect(S.KEY_GOVERNANCE_LABELS.none).toBe('none');
        expect(S.KEY_GOVERNANCE_LABELS['hot-key']).toBe('hot key');
    });

    it('carries the value on every built issuer record, so the row is never empty', () => {
        const issuers = JSON.parse(readFileSync(join(REPO, 'stocks-issuers.json'), 'utf8'));
        for (const issuer of issuers.issuers) {
            expect(typeof issuer.keyGovernance.rebase).toBe('string');
            expect(Object.keys(S.KEY_GOVERNANCE_LABELS)).toContain(issuer.keyGovernance.rebase);
            expect(issuer.control.keyGovernance.rebase).toBe(issuer.keyGovernance.rebase);
        }
    });
});

describe('newMintChipHtml', () => {
    const { newMintChipHtml } = require('./lib/issuer-labels.js');

    it('links a chip whose card exists and leaves one without a card as plain text', () => {
        const chip = { symbol: 'NVDAx', issuer: 'Backed', firstSeen: '2 days ago', href: './cards/NVDAx.html', title: 'NVDAx — Nvidia' };
        expect(newMintChipHtml(chip)).toBe('<li class="new-mint-chip"><a href="./cards/NVDAx.html" title="NVDAx — Nvidia">'
            + '<span class="new-mint-symbol">NVDAx</span><span aria-hidden="true">·</span>'
            + '<span class="new-mint-issuer">Backed</span><span aria-hidden="true">·</span>'
            + '<span class="new-mint-age">first seen 2 days ago</span></a></li>');
        expect(newMintChipHtml({ ...chip, href: null, issuer: null, firstSeen: null }))
            .toBe('<li class="new-mint-chip"><span title="NVDAx — Nvidia"><span class="new-mint-symbol">NVDAx</span></span></li>');
    });

    it('escapes what the feed supplies', () => {
        const html = newMintChipHtml({ symbol: '<x>', issuer: null, firstSeen: null, href: null, title: '"t"' });
        expect(html).not.toContain('<x>');
        expect(html).toContain('title="&quot;t&quot;"');
    });
});
