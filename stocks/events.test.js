// Tests the latest-events rules (lib/events.mjs) and the creation-time folding behind their wording
// (lib/mint-created.mjs): what each source contributes, what is left out and why, how one fact
// reported by two sources becomes one event, and the window. Every rule has a case that fails when
// the rule is removed.
import {
    MAX_EVENTS, TITLE_MAX, buildEventsFeed, catalogueEvents, changeRowEvents, changeRowsPsql, changeRowsSelect,
    defiEvents, eventContext, eventTime, finaliseEvents, issuerStatusChanges,
    journalEvents, mergeEvents, mergeLiveFeed, resolvedObservations, snapshotEvents, stampFirstSeen
} from './lib/events.mjs';
import { foldSignaturePage, mintsToCheck } from './lib/mint-created.mjs';

const NAMES = {
    'ondo-global-markets': 'Ondo Global Markets', 'xstocks-backed': 'Kraken xStocks', prestocks: 'PreStocks',
    'backpack-securities': 'Backpack Securities', tessera: 'Tessera', securitize: 'Securitize SECZ'
};

function context(extra = {}) {
    return eventContext({
        issuerNames: NAMES,
        cardSlugs: { MINTA: 'AAPLon', MINTX: 'APHx', MINTP1: 'OPENAI', MINTP2: 'ANDURIL', MINTS: 'SECZ', MINTL: 'MCDx' },
        protocolPages: { 'MINTS|loopscale': 'secz-loopscale-collateral' },
        recordsBeginOn: '2026-09-16',
        ...extra
    });
}

function token(mint, symbol, issuer, firstSeenAt) {
    return { mint, symbol, issuer, firstSeenAt, cardSlug: symbol };
}

function row(id, kind, fields = {}) {
    return { id: String(id), detected_at: '2026-09-21T10:00:00Z', kind, subject_type: 'token', subject_id: 'MINTX', severity: 'warning', evidence: {}, ...fields };
}

function docRow(id, fields = {}, judgment = { judgment_status: 'valid', judgment_material: true, judgment_severity: 'critical' }) {
    return {
        id: String(id), detected_at: '2026-09-19T05:53:24Z', kind: 'quote-lost', subject_type: 'claim', subject_id: `x:${id}`,
        issuer_slug: 'xstocks-backed', severity: 'warning', evidence: { url: 'https://assets.backed.fi/terms-of-service' },
        source_url: 'https://assets.backed.fi/terms-of-service', source_title: 'Backed Assets Terms of Service (PDF, last updated 2025-11-18) — the only document', source_kind: 'html',
        ...judgment, ...fields
    };
}

describe('times', () => {
    test('keeps the source precision: an instant to the second, a bare date as a date, garbage as null', () => {
        expect(eventTime('2026-09-24T14:07:04.000Z')).toBe('2026-09-24T14:07:04Z');
        expect(eventTime('2026-09-24 14:07:04+00')).toBe('2026-09-24T14:07:04Z');
        expect(eventTime('2026-09-19')).toBe('2026-09-19');
        expect(eventTime('yesterday')).toBeNull();
        expect(eventTime(null)).toBeNull();
    });
});

describe('catalogue: new tokens', () => {
    test('one event per issuer per day, first seen, newest symbols first; the founding cohort is not news', () => {
        const tally = {};
        const events = catalogueEvents([
            token('M1', 'RTXon', 'ondo-global-markets', '2026-09-24T00:08:26Z'),
            token('M2', 'BLSHon', 'ondo-global-markets', '2026-09-24T09:00:00Z'),
            token('M3', 'NVDA', 'backpack-securities', '2026-09-24T01:39:39Z'),
            token('M0', 'AAPLx', 'xstocks-backed', '2026-09-16T20:45:57Z')
        ], context(), tally);
        expect(events.map((e) => e.title).sort()).toEqual([
            'Backpack Securities: new token NVDA first seen',
            'Ondo Global Markets: 2 new tokens first seen (BLSHon, RTXon)'
        ]);
        const ondo = events.find((e) => e.subject.id === 'ondo-global-markets');
        expect(ondo).toMatchObject({ at: '2026-09-24T09:00:00Z', category: 'catalogue', source: 'catalogue', href: './issuers/ondo-global-markets.html' });
        expect(events.find((e) => e.subject.type === 'token').href).toBe('./cards/NVDA.html');
        expect(tally['catalogue: founding cohort (first seen the day records began)']).toBe(1);
    });

    test('says "created" at the creation time only when every mint was made just before first sight', () => {
        const mintCreated = { M1: { state: 'created', createdAt: '2026-09-23T22:00:00Z' }, M2: { state: 'created', createdAt: '2026-09-24T08:00:00Z' } };
        const [event] = catalogueEvents([
            token('M1', 'RTXon', 'ondo-global-markets', '2026-09-24T00:08:26Z'),
            token('M2', 'BLSHon', 'ondo-global-markets', '2026-09-24T09:00:00Z')
        ], context({ mintCreated }));
        expect(event.title).toBe('Ondo Global Markets created 2 new tokens (BLSHon, RTXon)');
        expect(event).toMatchObject({ kind: 'tokens-created', at: '2026-09-24T08:00:00Z' });
    });

    test('a batch in which a checked mint existed long before first sight is the catalogue catching up, not news', () => {
        const tally = {};
        const events = catalogueEvents([
            token('X1', 'BLDRx', 'xstocks-backed', '2026-09-23T14:52:36Z'),
            token('X2', 'MHKx', 'xstocks-backed', '2026-09-23T14:50:00Z'),
            token('X3', 'PATHx', 'xstocks-backed', '2026-09-23T14:49:00Z')
        ], context({ mintCreated: { X1: { state: 'created', createdAt: '2026-06-25T11:31:05Z' } } }), tally);
        expect(events).toEqual([]);
        expect(tally['catalogue: existing tokens newly catalogued (created long before first sight)']).toBe(1);
        expect(tally['catalogue: unchecked tokens catalogued in the same batch as an older one']).toBe(2);
    });

    test('a bound from an unfinished history also proves a mint older (predates), and a recent bound proves nothing', () => {
        const old = catalogueEvents([token('X1', 'BLDRx', 'xstocks-backed', '2026-09-23T14:52:36Z')],
            context({ mintCreated: { X1: { state: 'predates', createdBefore: '2026-04-10T14:17:30Z' } } }));
        expect(old).toEqual([]);
        const open = catalogueEvents([token('X1', 'BLDRx', 'xstocks-backed', '2026-09-23T14:52:36Z')],
            context({ mintCreated: { X1: { state: 'undecided', createdBefore: '2026-09-23T18:56:17Z' } } }));
        expect(open[0].title).toBe('Kraken xStocks: new token BLDRx first seen');
    });
});

describe('the public change journal', () => {
    const items = [
        { id: 'fee', date: '2026-09-19', firstObservedAt: '2026-09-19', category: 'actor-change', kind: 'fee-change', severity: 'warning',
            issuer: 'prestocks', title: 'PreStocks doubled its on-chain transfer fee', href: './issuers/prestocks.html' },
        { id: 'cat', date: '2026-09-20', category: 'catalogue', kind: 'asset-added', title: '656 Kraken xStocks token addresses entered the tracked catalogue' },
        { id: 'dex', date: '2026-09-24', category: 'protocol-change', kind: 'token-added', title: '5 token addresses entered Meteora' },
        { id: 'curated-2026-09-16-ondo-pause', date: '2026-09-16', eventAt: '2026-09-16', category: 'actor-change', kind: 'pause', title: 'Ondo Global Markets: pause' },
        { id: 'moved', date: '2026-09-19', category: 'actor-change', kind: 'document-moved', severity: 'info', title: 'Ondo moved its ITN integration documentation' },
        { id: 'moved-hard', date: '2026-09-19', category: 'actor-change', kind: 'document-moved', severity: 'caution', issuer: 'ondo-global-markets',
            title: 'Ondo removed its disclosures index; the cited Sales Terms remain available' },
        { id: 'curated-2026-09-20-shift-wind-down', date: '2026-09-20', eventAt: '2026-09-20', category: 'actor-change', kind: 'wind-down', severity: 'warning',
            issuer: 'shift', title: 'Shift leveraged tokens: wind down', summary: 'Shift sunset its markets; holders were paid at a frozen price. More detail follows.' },
        { id: 'protocol-discrepancy-a', date: '2026-09-23', category: 'protocol-change', kind: 'docs-vs-chain', severity: 'caution', actor: 'Loopscale', href: './protocols/secz-loopscale.html', title: 'Loopscale: a very long discrepancy title' },
        { id: 'protocol-discrepancy-b', date: '2026-09-23', category: 'protocol-change', kind: 'docs-vs-chain', severity: 'info', actor: 'Loopscale', href: './protocols/secz-loopscale.html', title: 'Loopscale: another' }
    ];

    test('keeps external changes, maps their category, and says why the rest is left out', () => {
        const tally = {};
        const events = journalEvents(items, context(), tally);
        const byId = Object.fromEntries(events.map((e) => [e.id, e]));
        expect(Object.keys(byId).sort()).toEqual([
            'journal-curated-2026-09-20-shift-wind-down', 'journal-docs-vs-chain-loopscale-2026-09-23', 'journal-fee', 'journal-moved-hard'
        ]);
        expect(byId['journal-fee']).toMatchObject({ category: 'keys', at: '2026-09-19', source: 'change journal', title: 'PreStocks doubled its on-chain transfer fee' });
        expect(byId['journal-moved-hard'].category).toBe('terms');
        expect(byId['journal-curated-2026-09-20-shift-wind-down'].category).toBe('legal');
        expect(tally).toMatchObject({
            'journal: catalogue additions (shown from token first-seen times)': 1,
            'journal: protocol listing changes (shown from the DeFi scanner)': 1,
            'journal: baseline research from the day records began': 1,
            'journal: document moved with its content intact': 1
        });
    });

    test('replaces a generic "Issuer: kind" title with the first clause of its summary', () => {
        const events = journalEvents(items, context());
        expect(events.find((e) => e.kind === 'wind-down').title).toBe('Shift sunset its markets');
    });

    test('groups docs-versus-chain findings per protocol per day, linked to the protocol dossier', () => {
        const [finding] = journalEvents(items, context()).filter((e) => e.kind === 'docs-vs-chain');
        expect(finding).toMatchObject({
            title: 'Loopscale: its docs and its on-chain setup disagree on 2 points', category: 'defi', severity: 'caution', href: './protocols/secz-loopscale.html'
        });
    });

    test('a day-dated entry takes the watcher\'s own time of the events its resolution covers, never a later one', () => {
        const events = journalEvents(items, context(), null, new Map([['fee', '2026-09-19T08:07:00Z'], ['moved-hard', '2026-09-20T01:00:00Z']]));
        expect(events.find((e) => e.id === 'journal-fee').at).toBe('2026-09-19T08:07:00Z');
        expect(events.find((e) => e.id === 'journal-moved-hard').at).toBe('2026-09-19');
    });
});

describe('watcher rows: chain', () => {
    test('supply, treasury and metadata moves are routine', () => {
        const tally = {};
        expect(changeRowEvents([row(1, 'supply'), row(2, 'treasury'), row(3, 'metadata')], context(), tally)).toEqual([]);
        expect(tally['chain watcher: supply (routine)']).toBe(1);
        expect(tally['chain watcher: treasury (routine)']).toBe(1);
    });

    test('a multiplier update the chain watcher graded caution is routine; a split is news, worded as one', () => {
        const tally = {};
        const events = changeRowEvents([
            row(1, 'rebase', { severity: 'caution', field: 'ui_multiplier', before: '1.0145', after: '1.0175', subject_id: 'MINTA' }),
            row(2, 'rebase', { field: 'ui_multiplier', before: '1', after: '2', evidence: { symbol: 'APHx' } }),
            row(3, 'rebase', { field: 'ui_multiplier', before: '10', after: '1', subject_id: 'MINTB', evidence: { symbol: 'BIGx' } }),
            row(4, 'rebase', { field: 'ui_multiplier', before: '1', after: '1.4861347', subject_id: 'MINTP1', evidence: { symbol: 'OPENAI' } })
        ], context(), tally);
        expect(events.map((e) => e.title)).toEqual([
            'APHx: 2-for-1 split applied to every balance',
            'BIGx: 1-for-10 reverse split applied to every balance',
            'OPENAI: every balance restated ×1.49 without a transfer'
        ]);
        expect(events[0]).toMatchObject({ category: 'market', source: 'chain watcher', href: './cards/APHx.html', keys: ['split|MINTX'] });
        expect(tally['chain watcher: routine balance-multiplier updates']).toBe(1);
    });

    test('key and extension changes are grouped per issuer, day, field and value, in plain words', () => {
        const fee = (id, mint, symbol) => row(id, 'extension-toggle', { subject_id: mint, issuer_slug: 'prestocks', field: 'transfer_fee_bps', before: '50', after: '100', evidence: { symbol } });
        const events = changeRowEvents([
            fee(1, 'MINTP1', 'OPENAI'), fee(2, 'MINTP2', 'ANDURIL'),
            row(3, 'authority-key', { issuer_slug: 'ondo-global-markets', subject_id: 'MINTA', field: 'freeze_authority', before: 'KeyA', after: 'KeyB', evidence: { symbol: 'AAPLon' } }),
            row(4, 'extension-toggle', { issuer_slug: 'ondo-global-markets', subject_id: 'MINTA', field: 'paused', before: 'false', after: 'true', evidence: { symbol: 'AAPLon' } })
        ], context());
        expect(events.map((e) => e.title)).toEqual([
            // No slot in these rows, so whether the new fee is in force yet is unknown: "set", not "raised".
            'PreStocks set a 1 % transfer fee on 2 tokens, up from 0.5 % (ANDURIL, OPENAI)',
            'Ondo Global Markets changed the freeze authority of AAPLon',
            'Ondo Global Markets paused AAPLon'
        ]);
        expect(events.every((e) => e.category === 'keys')).toBe(true);
        expect(events[0]).toMatchObject({ href: './issuers/prestocks.html', subject: { type: 'issuer', id: 'prestocks' } });
        expect(events[1].href).toBe('./cards/AAPLon.html');
    });

    // Token-2022 puts a new transfer fee in force two epochs after it is set, and the chain watcher
    // reads the NEWER fee, so a fee change it sees is scheduled, not yet charged. These rows are the
    // watcher's real 2026-09-24 PreStocks rows (slots and times as stored).
    const prestocksFee = (id, mint, symbol, evidence) => row(id, 'extension-toggle', {
        subject_id: mint, issuer_slug: 'prestocks', field: 'transfer_fee_bps', before: '100', after: '300', detected_at: evidence.observedAt, evidence: { symbol, ...evidence }
    });
    const at1807 = { slot: 450105097, previousSlot: 450091617, observedAt: '2026-09-24T18:07:01Z' };
    const at1859 = { slot: 450116882, previousSlot: 450105098, observedAt: '2026-09-24T18:59:28Z' };
    const seven = (extra = {}, fields = {}) => [
        ['P1', 'POLYMARKET', at1807], ['P2', 'KALSHI', at1807], ['P3', 'FIGUREAI', at1807], ['P4', 'NEURALINK', at1807],
        ['P5', 'ANDURIL', at1807], ['P6', 'ANTHROPIC', at1859], ['P7', 'OPENAI', at1859]
    ].map(([mint, symbol, ev], i) => ({ ...prestocksFee(i + 1, mint, symbol, { ...ev, ...extra }), ...fields }));

    test('a fee change whose epoch is still ahead is worded as scheduled, with the epoch and its approximate day', () => {
        const [event] = changeRowEvents(seven(), context());
        // Both readings sit in epoch 1041 (slot / 432 000), so the new fee starts at epoch 1043.
        expect(event.title).toBe('PreStocks scheduled a 1 % → 3 % transfer fee on 7 tokens from epoch 1043, about 26 Sep');
        expect(event.title).not.toMatch(/raised/);
        expect(event).toMatchObject({ category: 'keys', severity: 'warning', href: './issuers/prestocks.html' });
    });

    test('an uncapped fee says so (from the evidence, or the mint state beside the row), keeping the title in bounds', () => {
        const recorded = changeRowEvents(seven({ transferFee: { newerEpoch: 1043, maximumFee: '18446744073709551616' } }), context())[0];
        expect(recorded.title).toBe('PreStocks scheduled a 1 % → 3 % transfer fee (no cap) on 7 tokens from about 26 Sep');
        const joined = changeRowEvents(seven({}, { transfer_fee_max: '18446744073709551616' }), context())[0];
        expect(joined.title).toBe(recorded.title);
        expect(recorded.title.length).toBeLessThanOrEqual(TITLE_MAX);
        const single = changeRowEvents(seven({ transferFee: { newerEpoch: 1043, maximumFee: '18446744073709551616' } }).slice(0, 1), context())[0];
        expect(single.title).toBe('PreStocks scheduled a 1 % → 3 % transfer fee (no cap) on POLYMARKET from about 26 Sep');
    });

    test('once the new fee is in force at the reading, it is "raised"', () => {
        // Recorded epoch 1041 = the reading's own epoch: the fee already applies.
        const [event] = changeRowEvents(seven({ transferFee: { newerEpoch: 1041, maximumFee: '5000' } }), context());
        expect(event.title).toMatch(/^PreStocks raised the transfer fee on 7 tokens from 1 % to 3 %/);
    });

    test('readings in different epochs without a recorded epoch: still scheduled when it cannot be in force yet, epoch left out', () => {
        const straddle = { slot: 450144000, previousSlot: 450000000, observedAt: '2026-09-25T02:00:00Z' };
        const [event] = changeRowEvents(seven(straddle), context());
        expect(event.title).toMatch(/^PreStocks scheduled its transfer fee to rise from 1 % to 3 % on 7 tokens/);
        expect(event.title).not.toMatch(/epoch/);
    });

    test('a court docket names the party and the issuer', () => {
        const [event] = changeRowEvents([{
            id: '2398', detected_at: '2026-09-24T04:23:00Z', kind: 'litigation', subject_type: 'issuer', subject_id: 'xstocks-backed',
            field: 'case:courtlistener-r:73536833', after: 'Arena v. Coinbase Global, Inc.', severity: 'caution',
            evidence: { query: 'Payward, Inc.', matchLevel: 'party' }
        }], context());
        expect(event).toMatchObject({
            title: 'Arena v. Coinbase Global, Inc. names Payward, Inc. (Kraken xStocks)', category: 'legal', source: 'court watcher', href: './issuers/xstocks-backed.html'
        });
    });
});

describe('watcher rows: documents', () => {
    test('an unreviewed document change never becomes a public event, whatever the model rated it', () => {
        // A geoblock page, a binary body or a script-only shell also "loses" every quote; the model
        // rates those critical too. Only the reviewed change-journal entry speaks for a document.
        const tally = {};
        const events = changeRowEvents([
            docRow(1, {}, { judgment_status: 'valid', judgment_material: false }),
            docRow(2, {}, { judgment_status: 'invalid', judgment_material: null }),
            docRow(5),
            docRow(838, { kind: 'document-gone', subject_type: 'source', source_url: 'https://assets.backed.fi/x', evidence: { url: 'https://assets.backed.fi/x' } })
        ], context(), tally);
        expect(events).toEqual([]);
        expect(tally).toEqual({ 'document watcher: not reviewed yet (on the changes page, not in the feed)': 4 });
    });

    test('rows the editorial review decided are never shown on their own; a public one lends its time to the journal', () => {
        const resolutions = [
            { id: 'prestocks-fee', public: true, match: { issuerSlug: 'prestocks', kind: 'extension-toggle', field: 'transfer_fee_bps' } },
            { id: 'quote-refresh', public: false, match: { kind: 'quote-lost', subjectId: 'x:9' } }
        ];
        const ctx = context({ resolutions });
        const rows = [
            row(1, 'extension-toggle', { issuer_slug: 'prestocks', field: 'transfer_fee_bps', before: '50', after: '100', detected_at: '2026-09-19T08:07:00Z' }),
            docRow(9)
        ];
        const tally = {};
        expect(changeRowEvents(rows, ctx, tally)).toEqual([]);
        expect(tally['review: reported by its change journal entry']).toBe(1);
        expect(tally['review: resolved as a false alarm or our own re-read, not an external change']).toBe(1);
        expect(resolvedObservations(rows, ctx)).toEqual(new Map([['prestocks-fee', '2026-09-19T08:07:00Z']]));
    });
});

describe('DeFi scanner', () => {
    const feed = {
        items: [
            { date: '2026-09-24', change: 'added', category: 'lending', severity: 'info', mint: 'MINTS', symbol: 'SECZ', protocolId: 'loopscale', protocolName: 'Loopscale' },
            { date: '2026-09-24', change: 'added', category: 'dex', severity: 'info', mint: 'MINTA', symbol: 'AAPLon', protocolId: 'meteora', protocolName: 'Meteora' },
            { date: '2026-09-22', change: 'removed', category: 'lending', severity: 'warning', mint: 'MINTA', symbol: 'AAPLon', protocolId: 'kamino', protocolName: 'Kamino' },
            { date: '2026-09-22', change: 'removed', category: 'lending', severity: 'warning', mint: 'MINTX', symbol: 'APHx', protocolId: 'kamino', protocolName: 'Kamino' }
        ],
        candidates: [{}, {}]
    };

    test('lending and vault support added or removed; DEX churn and unconfirmed holdings are not events', () => {
        const tally = {};
        const events = defiEvents(feed, context(), tally);
        expect(events.map((e) => e.title)).toEqual(['Loopscale now lists SECZ for lending', 'Kamino dropped 2 tokens from lending (AAPLon, APHx)']);
        expect(events[0]).toMatchObject({ at: '2026-09-24', href: './protocols/secz-loopscale-collateral.html', category: 'defi', source: 'DeFi scanner' });
        expect(events[1].severity).toBe('warning');
        expect(tally['DeFi scanner: DEX pool listing churn']).toBe(1);
        expect(tally['DeFi scanner: unconfirmed holdings under review']).toBe(2);
    });
});

describe('DeFi scanner: observed loans', () => {
    test('a loan read on-chain is worded as an observed loan, never as a listing', () => {
        const events = defiEvents({ items: [
            { date: '2026-09-26', change: 'added', category: 'lending', severity: 'info', mint: 'MINTQ', symbol: 'QQQx', protocolId: 'loopscale', protocolName: 'Loopscale', basis: 'onchain-position' },
            { date: '2026-09-26', change: 'added', category: 'lending', severity: 'info', mint: 'MINTS', symbol: 'SECZ', protocolId: 'loopscale', protocolName: 'Loopscale', basis: 'exact-token-registry' }
        ] }, context());
        expect(events.map((e) => e.title).sort()).toEqual(['First Loopscale loan against QQQx observed', 'Loopscale now lists SECZ for lending']);
    });
});

describe('daily snapshot diffs', () => {
    const diff = {
        from: '2026-09-21', to: '2026-09-22', toObservedAt: '2026-09-22T18:28:54Z',
        changes: [
            { kind: 'liquidity-drop', mint: 'MINTL', symbol: 'MCDx', issuer: 'xstocks-backed', before: 899000, after: 409000 },
            { kind: 'liquidity-drop', mint: 'MINTA', symbol: 'AAPLon', issuer: 'ondo-global-markets', before: 40000, after: 1000 },
            { kind: 'health-worse', mint: 'MINTA', symbol: 'AAPLon', issuer: 'ondo-global-markets' },
            { kind: 'paused', mint: 'MINTA', symbol: 'AAPLon', issuer: 'ondo-global-markets', field: 'paused', before: false, after: true },
            { kind: 'rebase', mint: 'MINTX', symbol: 'APHx', issuer: 'xstocks-backed', before: '1', after: '2' },
            { kind: 'control-change', mint: 'MINTX', symbol: 'APHx', issuer: 'xstocks-backed', field: 'clawback', before: false, after: true }
        ],
        issuerChanges: issuerStatusChanges({ items: [{ slug: 'shift', status: 'live' }] }, { items: [{ slug: 'shift', status: 'defunct' }] })
    };

    test('keeps collapses on liquid tokens, pauses, splits, control flags and a programme status move, at the snapshot\'s time', () => {
        const tally = {};
        const events = snapshotEvents([diff], context({ issuerNames: { ...NAMES, shift: 'Shift leveraged tokens' } }), tally);
        expect(events.map((e) => e.title).sort()).toEqual([
            'APHx: 2-for-1 split applied to every balance',
            'Kraken xStocks added a clawback power to APHx',
            'MCDx: pool liquidity fell 55 % in a day ($899k → $409k)',
            'Ondo Global Markets paused AAPLon',
            'Shift leveraged tokens: programme now listed as defunct'
        ]);
        expect(events.every((e) => e.at === '2026-09-22T18:28:54Z' && e.source === 'catalogue')).toBe(true);
        expect(tally['catalogue: liquidity drops on pools under $100k']).toBe(1);
        expect(tally['catalogue: health got worse']).toBe(1);
    });
});

describe('market events keep their first-seen time', () => {
    const drop = { kind: 'liquidity-drop', mint: 'MINTL', symbol: 'MCDx', issuer: 'xstocks-backed', before: 899000, after: 409000 };
    const pause = { kind: 'paused', mint: 'MINTA', symbol: 'AAPLon', issuer: 'ondo-global-markets', field: 'paused', before: false, after: true };
    const rewrite = (observedAt, changes, issuerChanges = []) => ({ from: '2026-09-21', to: '2026-09-22', toObservedAt: observedAt, changes, issuerChanges });
    const byKind = (events) => Object.fromEntries(events.map((e) => [e.kind, e.at]));

    test('a later rewrite of the same day keeps the first build\'s time, and a new crossing takes its own', () => {
        const first = stampFirstSeen([rewrite('2026-09-22T06:17:00Z', [drop])], {}, '2026-09-20');
        // Six hours later the day's snapshot is rewritten: the drop is still there (a new value), a pause appeared.
        const later = stampFirstSeen([rewrite('2026-09-22T12:17:00Z', [{ ...drop, after: 380000 }, pause],
            issuerStatusChanges({ items: [{ slug: 'shift', status: 'live' }] }, { items: [{ slug: 'shift', status: 'defunct' }] }))],
        first.ledger, '2026-09-20');
        const events = snapshotEvents(later.diffs, context());
        expect(byKind(events)).toEqual({
            'liquidity-collapse': '2026-09-22T06:17:00Z', pause: '2026-09-22T12:17:00Z', 'issuer-status': '2026-09-22T12:17:00Z'
        });
        // Without the ledger every event takes the latest rewrite's time, which is the bug this fixes.
        expect(snapshotEvents([rewrite('2026-09-22T12:17:00Z', [drop])], context())[0].at).toBe('2026-09-22T12:17:00Z');
    });

    test('a grouped pause takes its earliest member, and the ledger drops days before the window', () => {
        const other = { ...pause, mint: 'MINTB', symbol: 'MSFTon' };
        const { ledger } = stampFirstSeen([rewrite('2026-09-22T06:17:00Z', [pause])], { '2026-09-01|paused|OLD||': '2026-09-01T06:00:00Z' }, '2026-09-20');
        expect(Object.keys(ledger)).toEqual(['2026-09-22|paused|MINTA|paused|']);
        const { diffs } = stampFirstSeen([rewrite('2026-09-22T18:17:00Z', [pause, other])], ledger, '2026-09-20');
        const [event] = snapshotEvents(diffs, context());
        expect(event.kind).toBe('pause');
        expect(event.at).toBe('2026-09-22T06:17:00Z');
    });
});

describe('one event per fact', () => {
    const journalFee = journalEvents([{ id: 'fee', date: '2026-09-19', category: 'actor-change', kind: 'fee-change', issuer: 'prestocks', severity: 'warning', title: 'PreStocks doubled its on-chain transfer fee' }], context())[0];
    const chainFee = changeRowEvents([row(1, 'extension-toggle', { issuer_slug: 'prestocks', subject_id: 'MINTP1', field: 'transfer_fee_bps', before: '50', after: '100', detected_at: '2026-09-19T08:07:00Z' })], context())[0];

    test('the journal\'s words win over a watcher\'s, and a day-only date takes the watcher\'s precise time', () => {
        const tally = {};
        const merged = mergeEvents([chainFee, journalFee], tally);
        expect(merged).toHaveLength(1);
        expect(merged[0]).toMatchObject({ id: 'journal-fee', title: 'PreStocks doubled its on-chain transfer fee', at: '2026-09-19T08:07:00Z' });
        expect(tally['merged: same fact from the chain watcher and the change journal']).toBe(1);
    });

    test('the same key far apart in time is two facts', () => {
        const later = { ...chainFee, id: 'later', at: '2026-09-24T08:07:00Z' };
        expect(mergeEvents([journalFee, later])).toHaveLength(2);
    });

    test('a chain split and the daily snapshot\'s view of it are one event, the chain watcher\'s', () => {
        const chain = changeRowEvents([row(2, 'rebase', { field: 'ui_multiplier', before: '1', after: '2', detected_at: '2026-09-21T21:07:03Z' })], context());
        const snap = snapshotEvents([{ to: '2026-09-22', toObservedAt: '2026-09-22T18:57:42Z', changes: [{ kind: 'rebase', mint: 'MINTX', symbol: 'APHx', before: '1', after: '2' }] }], context());
        const merged = mergeEvents([...snap, ...chain]);
        expect(merged).toHaveLength(1);
        expect(merged[0]).toMatchObject({ source: 'chain watcher', at: '2026-09-21T21:07:03Z' });
    });

    test('one entry absorbs another about documents only when it covers every document the other names', () => {
        const entry = (id, date, urls) => journalEvents([{ id, date, category: 'actor-change', kind: 'documentation-corrected', issuer: 'xstocks-backed',
            title: `Backed corrected its docs (${id})`, sources: urls.map((url) => ({ url })) }], context())[0];
        const two = entry('two-pages', '2026-09-20', ['https://assets.backed.fi/legal-documentation', 'https://assets.backed.fi/terms-of-service/']);
        // A later entry about one of the two pages does not swallow the one about both, or vice versa.
        expect(mergeEvents([entry('one-page', '2026-09-22', ['https://assets.backed.fi/legal-documentation']), two])).toHaveLength(2);
        // Covering both pages within 7 days: one fact.
        const both = mergeEvents([entry('both-pages', '2026-09-22', ['https://assets.backed.fi/legal-documentation', 'https://assets.backed.fi/terms-of-service/']), two]);
        expect(both).toHaveLength(1);
        // Ten days apart: two facts.
        expect(mergeEvents([entry('later', '2026-09-30', ['https://assets.backed.fi/legal-documentation', 'https://assets.backed.fi/terms-of-service/']), two])).toHaveLength(2);
    });

    test('the same id twice is one event, the later copy', () => {
        expect(mergeEvents([{ ...chainFee, title: 'old' }, { ...chainFee, title: 'new' }]).map((e) => e.title)).toEqual(['new']);
    });
});

describe('window and envelope', () => {
    const events = [
        { id: 'a', at: '2026-09-24T10:00:00Z', severity: 'info', category: 'market', source: 'catalogue' },
        { id: 'b', at: '2026-09-24', severity: 'warning', category: 'terms', source: 'change journal' },
        { id: 'c', at: '2026-08-20T10:00:00Z', severity: 'info', category: 'keys', source: 'chain watcher' }
    ];

    test('newest first within the window counted back from the data\'s own newest time; nothing without one', () => {
        const tally = {};
        expect(finaliseEvents(events, { asOf: '2026-09-24T14:07:04Z', tally }).map((e) => e.id)).toEqual(['a', 'b']);
        expect(tally['older than 30 days']).toBe(1);
        expect(finaliseEvents(events, { asOf: null })).toEqual([]);
        expect(finaliseEvents(events, { asOf: '2026-09-24T14:07:04Z', limit: 1 }).map((e) => e.id)).toEqual(['a']);
    });

    test('every title fits one ticker line and names things by their display names', () => {
        const long = 'X'.repeat(40);
        const feed = buildEventsFeed({
            tokens: Array.from({ length: 30 }, (_, i) => token(`N${i}`, `${long}${i}`, 'ondo-global-markets', '2026-09-24T01:00:00Z')),
            journal: [{ id: 'long', date: '2026-09-23', category: 'actor-change', kind: 'disclosure', issuer: 'tessera', title: `Tessera ${'said something '.repeat(12)}` }],
            ctx: context(), asOf: '2026-09-24T14:00:00Z'
        });
        expect(feed.events.length).toBe(2);
        for (const event of feed.events) {
            expect(event.title.length).toBeLessThanOrEqual(TITLE_MAX);
            for (const slug of Object.keys(NAMES)) expect(event.title).not.toContain(slug);
        }
        expect(feed.counts).toEqual({ total: 2, byCategory: { catalogue: 1, terms: 1 }, bySource: { catalogue: 1, 'change journal': 1 } });
        expect(MAX_EVENTS).toBe(200);
    });

    test('the live feed replaces the file\'s watcher events with fresh rows and keeps the file\'s own', () => {
        const file = {
            asOf: '2026-09-24T12:00:00Z',
            events: [
                { id: 'defi-x', at: '2026-09-24', kind: 'defi-added', category: 'defi', title: 'Loopscale now lists SECZ for lending', severity: 'info', source: 'DeFi scanner', keys: [], origin: 'file' },
                { id: 'court-1', at: '2026-09-23T04:00:00Z', kind: 'court-case', category: 'legal', title: 'stale copy', severity: 'caution', source: 'court watcher', keys: [], origin: 'db' },
                // A watcher event the fresh rows no longer produce (since resolved as a false alarm) must go.
                { id: 'doc-gone-since', at: '2026-09-23T05:00:00Z', kind: 'document-changed', category: 'terms', title: 'withdrawn', severity: 'warning', source: 'document watcher', keys: [], origin: 'db' }
            ]
        };
        const live = mergeLiveFeed(file, [{
            id: '1', detected_at: '2026-09-24T13:00:00Z', kind: 'litigation', subject_type: 'issuer', subject_id: 'tessera', field: 'case:k', after: 'A v. B', severity: 'caution', evidence: { query: 'Tessera' }
        }], context());
        expect(live.asOf).toBe('2026-09-24T13:00:00Z');
        expect(live.events.map((e) => [e.id, e.title])).toEqual([['court-1', 'A v. B names Tessera'], ['defi-x', 'Loopscale now lists SECZ for lending']]);
    });
});

describe('the watcher rows query', () => {
    test('reads only the kinds the rules use, public rows only, and inlines nothing but a checked instant', () => {
        const sql = changeRowsPsql({ since: '2026-08-25T00:00:00Z', judgments: true });
        expect(sql).toContain("e.detected_at >= '2026-08-25T00:00:00Z'::timestamptz");
        expect(sql).toContain("e.kind IN ('authority-key', 'extension-toggle', 'rebase', 'litigation', 'quote-lost', 'document-gone', 'legal-term')");
        expect(sql).toContain('sonar.change_judgment');
        expect(sql).toContain("NOT (e.kind = 'status'");
        expect(() => changeRowsPsql({ since: "2026-08-25'; DROP TABLE x; --", judgments: true })).toThrow('ISO UTC instant');
        expect(changeRowsSelect({ sinceExpr: '$1::timestamptz', judgments: false })).not.toContain('change_judgment');
    });
});

describe('mint creation times', () => {
    const page = (n, oldestTime) => Array.from({ length: n }, (_, i) => ({ signature: `sig${i}`, blockTime: i === n - 1 ? oldestTime : oldestTime + 1000 }));
    const seen = '2026-09-23T14:52:36Z';

    test('a short page reaches the first transaction: that is the creation time', () => {
        const record = foldSignaturePage({}, page(12, Date.parse('2026-06-25T11:31:05Z') / 1000), { firstSeenAt: seen });
        expect(record).toMatchObject({ state: 'created', createdAt: '2026-06-25T11:31:05Z', pages: 1 });
    });

    test('a full page whose oldest transaction is long before first sight settles "predates"; a recent one stays open, then undecided', () => {
        expect(foldSignaturePage({}, page(1000, Date.parse('2026-04-10T14:17:30Z') / 1000), { firstSeenAt: seen }).state).toBe('predates');
        const recent = page(1000, Date.parse('2026-09-23T18:56:17Z') / 1000);
        expect(foldSignaturePage({}, recent, { firstSeenAt: seen }).state).toBe('open');
        expect(foldSignaturePage({}, recent, { firstSeenAt: seen, lastPage: true }).state).toBe('undecided');
    });

    test('checks the newest unchecked mint of each batch, then the newest overall; skips settled mints, decided batches and the founding cohort', () => {
        const tokens = [
            token('A1', 'A1', 'ondo-global-markets', '2026-09-24T00:08:26Z'),
            token('A2', 'A2', 'ondo-global-markets', '2026-09-24T00:09:00Z'),
            token('B1', 'B1', 'xstocks-backed', '2026-09-23T14:52:36Z'),
            token('B2', 'B2', 'xstocks-backed', '2026-09-23T14:50:00Z'),
            token('C1', 'C1', 'backpack-securities', '2026-09-22T10:00:00Z'),
            token('Z1', 'Z1', 'xstocks-backed', '2026-09-16T20:00:00Z')
        ];
        const cache = { B1: { state: 'created', createdAt: '2026-06-25T11:31:05Z' }, C1: { state: 'undecided' } };
        expect(mintsToCheck(tokens, cache, { asOf: '2026-09-24T12:00:00Z', recordsBeginOn: '2026-09-16', newest: 2 }).map((row) => row.mint))
            .toEqual(['A2', 'A1']);
    });
});
