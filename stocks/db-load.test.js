// Unit tests for stocks/lib/db-load.mjs — the pure document-to-SQL builders behind
// stocks/load-db.mjs. No database is touched: every test asserts something a reader of the
// generated SQL (or a victim of it) would notice if it broke. The properties under test are the
// ones that cost real damage when wrong: a dollar tag that the document's own bytes could
// terminate (a SQL injection through our own data), a column list that has drifted from the DDL,
// an ON CONFLICT guard that would bump `updated_at` on an unchanged re-load, a settled trade
// being rewritten by a later file, and a snapshot date taken from the clock instead of the
// document. The last suite builds from the repo's real JSON, so a shape change fails here first.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildClaimOrphanSql, buildClaimSql, buildFailureModeSql, buildIssuerSql, buildSnapshotSql,
    buildTokenSql, buildTradeSql, buildWhatIfDeleteSql, buildWhatIfSql,
    claimId, claimRows, claimRowsForDossier,
    ident, jsonbLiteral, pickDollarTag, renderUpsert, whatIfId, whatIfRows, whatIfRowsForDossier,
    wrapTransaction
} from './lib/db-load.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DDL_PATH = join(REPO, 'db', '2026-09-17-sonar-stocks.sql');
const CLAIM_DDL_PATH = join(REPO, 'db', '2026-09-18-sonar-claims.sql');
const CLAIM_FIXTURE = JSON.parse(
    readFileSync(join(REPO, 'stocks', 'fixtures', 'dossier-claims.sample.json'), 'utf8')
);

/** The column list of `INSERT INTO <table> AS tgt (a, b, c)`, as written. */
function insertedColumns(sql) {
    const m = sql.match(/INSERT INTO \S+ AS tgt \(([^)]*)\)/);
    if (!m) throw new Error('no INSERT column list found');
    return m[1].split(',').map((c) => c.trim());
}

/** The columns named in the `DO UPDATE SET` list, `updated_at` excluded. */
function updatedColumns(sql) {
    // a CTE may contain its own WHERE, so anchor on the LAST one — the ON CONFLICT guard
    const body = sql.slice(sql.indexOf('DO UPDATE SET'), sql.lastIndexOf('\n  WHERE '));
    return [...body.matchAll(/^\s+("?[\w]+"?) = EXCLUDED\./gm)].map((m) => m[1]);
}

/** Pull the one dollar-quoted payload back out and parse it, proving the literal round-trips. */
function embeddedDocs(sql) {
    return [...sql.matchAll(/\$(sonar\d*)\$([\s\S]*?)\$\1\$::jsonb/g)].map((m) => JSON.parse(m[2]));
}

/** Column names declared by each CREATE TABLE in the DDL file. */
function ddlColumns(path = DDL_PATH) {
    const text = readFileSync(path, 'utf8');
    const out = {};
    for (const m of text.matchAll(/CREATE TABLE IF NOT EXISTS (sonar\.\w+) \(([\s\S]*?)\n\);/g)) {
        out[m[1]] = m[2].split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !/^(PRIMARY KEY|UNIQUE|CONSTRAINT|CHECK|FOREIGN)/i.test(line))
            .map((line) => line.split(/\s+/)[0]);
    }
    return out;
}

describe('pickDollarTag', () => {
    test('uses the plain base tag when the content cannot terminate it', () => {
        expect(pickDollarTag('{"a":1}')).toBe('sonar');
    });

    test('escalates when the content contains the base tag, and keeps escalating', () => {
        expect(pickDollarTag('a $sonar$ b')).toBe('sonar1');
        expect(pickDollarTag('$sonar$ $sonar1$ $sonar2$')).toBe('sonar3');
    });

    test('a bare $ or a different tag in the content does not force an escalation', () => {
        expect(pickDollarTag('price $5 and $$ and $other$')).toBe('sonar');
    });

    test('throws rather than returning a tag the content could terminate', () => {
        const everything = Array.from({ length: 1000 }, (_, i) => `$sonar${i || ''}$`).join(' ');
        expect(() => pickDollarTag(everything)).toThrow(/no safe dollar tag/);
    });

    test('rejects a tag base that is not a bare identifier', () => {
        expect(() => pickDollarTag('x', 'so nar')).toThrow(/bad dollar tag base/);
    });
});

describe('jsonbLiteral', () => {
    test('embeds the document verbatim — quotes are not escaped, because they need not be', () => {
        const doc = { note: "the issuer's own words: 'no entitlement'" };
        const literal = jsonbLiteral(doc);
        expect(literal).toBe(`$sonar$${JSON.stringify(doc)}$sonar$::jsonb`);
        expect(embeddedDocs(literal)).toEqual([doc]);
    });

    test('a document containing the default tag gets a tag it cannot terminate', () => {
        const doc = { evidence: 'the string $sonar$ appeared in a memo' };
        const literal = jsonbLiteral(doc);
        expect(literal.startsWith('$sonar1$')).toBe(true);
        // exactly two occurrences of the chosen delimiter: the opening and the closing one
        expect(literal.split('$sonar1$')).toHaveLength(3);
        expect(embeddedDocs(literal)).toEqual([doc]);
    });

    test('backslashes and newlines survive, since JSON.stringify already escaped them', () => {
        const doc = { s: 'a\\b\nc\t"d"' };
        expect(embeddedDocs(jsonbLiteral(doc))).toEqual([doc]);
    });
});

describe('ident', () => {
    test('quotes reserved words this schema actually uses', () => {
        expect(ident('row')).toBe('"row"');
        expect(ident('time')).toBe('"time"');
    });

    test('leaves ordinary column names bare', () => {
        expect(ident('mint')).toBe('mint');
        expect(ident('top20_share_pct')).toBe('top20_share_pct');
    });

    test('refuses an empty or non-string identifier', () => {
        expect(() => ident('')).toThrow(/bad identifier/);
        expect(() => ident(null)).toThrow(/bad identifier/);
    });
});

describe('renderUpsert', () => {
    test('guards every updated column with IS DISTINCT FROM, and bumps updated_at only then', () => {
        const sql = renderUpsert({
            table: 'sonar.t',
            from: 'src',
            columns: [['k', "r->>'k'"], ['a', "r->>'a'"], ['b', "r->>'b'"]],
            conflict: 'k',
            update: ['a', 'b']
        });
        expect(sql).toContain('ON CONFLICT (k) DO UPDATE SET');
        expect(sql).toContain('updated_at = now()');
        expect(sql).toContain('WHERE tgt.a IS DISTINCT FROM EXCLUDED.a');
        expect(sql).toContain('OR tgt.b IS DISTINCT FROM EXCLUDED.b');
        // the guard is what makes an unchanged re-load a no-op, so it must cover the same
        // columns the SET list writes — no more, no less
        expect(updatedColumns(sql)).toEqual(['a', 'b']);
        expect([...sql.matchAll(/IS DISTINCT FROM/g)]).toHaveLength(2);
    });

    test('refuses to update a column it does not load', () => {
        expect(() => renderUpsert({
            table: 'sonar.t', from: 'src', columns: [['k', 'x']], conflict: 'k', update: ['nope']
        })).toThrow(/update column not loaded: nope/);
    });

    test('refuses an empty column or update list', () => {
        expect(() => renderUpsert({ table: 't', from: 's', columns: [], conflict: 'k', update: ['a'] }))
            .toThrow(/needs columns/);
        expect(() => renderUpsert({ table: 't', from: 's', columns: [['k', 'x']], conflict: 'k', update: [] }))
            .toThrow(/needs update columns/);
    });
});

describe('buildIssuerSql', () => {
    const doc = {
        builtAt: '2026-09-17T13:49:40Z',
        issuers: [{
            slug: 'backpack-securities',
            name: 'Backpack Securities',
            status: 'live',
            legalForm: 'spv-claim-redeemable',
            grades: { claimRung: 3, claimLabel: 'beneficial interest', maturityStageNum: 0, maturityScore: 0, verificationStrength: 0, verificationLabel: 'none' },
            keyGovernance: { mint: 'unknown', freeze: 'program', delegate: 'program' },
            recipes: [{ label: 'token-2022 · pausable + clawback', mints: 51 }],
            tokenMints: ['A', 'B', 'C']
        }]
    };

    test('upserts on slug and never rewrites the key', () => {
        const { sql } = buildIssuerSql(doc);
        expect(sql).toContain('INSERT INTO sonar.stock_issuer AS tgt');
        expect(sql).toContain('ON CONFLICT (slug) DO UPDATE SET');
        expect(updatedColumns(sql)).not.toContain('slug');
        expect(insertedColumns(sql)).toContain('slug');
    });

    test('flattens the facets from grades and keyGovernance, not from the top level', () => {
        const { sql } = buildIssuerSql(doc);
        expect(sql).toContain("(r->'grades'->>'claimRung')::int AS claim_rung");
        expect(sql).toContain("(r->'grades'->>'maturityStageNum')::int AS maturity_stage");
        expect(sql).toContain("r->'grades'->>'verificationLabel' AS verification_type");
        expect(sql).toContain("r->'keyGovernance'->>'delegate' AS key_governance_delegate");
    });

    test('mint_count comes from the record and stays null when there is no array', () => {
        const { sql } = buildIssuerSql(doc);
        expect(sql).toContain("jsonb_array_length(r->'tokenMints')");
        expect(sql).toContain('ELSE NULL END AS mint_count');
        expect(sql).toContain('ELSE NULL END AS recipes');
    });

    test('keeps the whole record and reports the distinct-slug count', () => {
        const built = buildIssuerSql(doc);
        expect(built.sql).toContain('r AS record');
        expect(built.rows).toBe(1);
        const twice = buildIssuerSql({ ...doc, issuers: [doc.issuers[0], doc.issuers[0]] });
        expect(twice.rows).toBe(1); // DISTINCT ON collapses them, so the count must too
        expect(twice.sql).toContain("DISTINCT ON (x.r->>'slug')");
    });

    test('an empty or absent issuer list still produces valid SQL and zero rows', () => {
        expect(buildIssuerSql({ builtAt: 'x' }).rows).toBe(0);
        expect(buildIssuerSql({ builtAt: 'x' }).sql).toContain('INSERT INTO sonar.stock_issuer');
    });
});

describe('buildTokenSql', () => {
    const tokensDoc = {
        builtAt: '2026-09-17T13:49:40Z',
        tokens: [{
            mint: 'MINT_A', symbol: 'AAPLon', issuer: 'ondo-global-markets',
            recipe: { label: 'token-2022 · pausable', extensions: ['pausable'] },
            control: { clawback: false, pausable: true, paused: false, transferFeeBps: null },
            market: { liquidity: 892.06 }, activity: { lastTradedAt: '2026-09-16T20:12:30+00:00' },
            holders: { top1SharePct: 48.7 }, reference: { source: 'ondo-implied' }
        }]
    };
    const healthDoc = { items: [{ mint: 'MINT_A', status: 'warning', worstRuleId: 'liquidity' }] };

    test('joins the health verdict from the second document, optionally', () => {
        const { sql } = buildTokenSql({ tokensDoc, healthDoc });
        expect(sql).toContain("LEFT JOIN health ON health.mint = src.r->>'mint'");
        expect(sql).toContain('health.status AS health_status');
        expect(sql).toContain('health.worst_rule AS worst_rule');
        expect(embeddedDocs(sql)).toEqual([tokensDoc, healthDoc]);
    });

    test('the programme and this-token levels are loaded beside the overall verdict', () => {
        const { sql } = buildTokenSql({ tokensDoc, healthDoc });
        expect(sql).toContain("x.r->'levels'->'programme'->>'status' AS programme_health");
        expect(sql).toContain("x.r->'levels'->'token'->>'status' AS token_health");
        expect(sql).toContain("(x.r->'levels'->'token'->>'passed')::int AS token_checks_passed");
        expect(sql).toContain("(x.r->'levels'->'token'->>'judged')::int AS token_checks_judged");
        expect(sql).toContain("(x.r->'levels'->'token'->>'rank')::int AS token_health_rank");
        for (const column of ['programme_health', 'programme_worst_rule', 'token_health', 'token_worst_rule',
            'token_checks_passed', 'token_checks_judged', 'token_health_rank']) {
            expect(sql).toContain(`health.${column} AS ${column}`);
            expect(updatedColumns(sql)).toContain(column);
        }
    });

    test('works with no health document at all — the verdict columns just stay null', () => {
        const { sql } = buildTokenSql({ tokensDoc });
        expect(embeddedDocs(sql)).toEqual([tokensDoc, { items: [] }]);
        expect(sql).toContain('health.status AS health_status');
    });

    test('recipe extensions become a text[] and null when the record has none', () => {
        const { sql } = buildTokenSql({ tokensDoc, healthDoc });
        expect(sql).toContain("ARRAY(SELECT jsonb_array_elements_text(r->'recipe'->'extensions'))");
        expect(sql).toContain('ELSE NULL END AS recipe_extensions');
    });

    test('supply is read exactly and floats are read as floats', () => {
        const { sql } = buildTokenSql({ tokensDoc, healthDoc });
        expect(sql).toContain("(r->>'supplyRaw')::numeric AS supply_raw");
        expect(sql).toContain("(r->>'uiMultiplier')::numeric AS ui_multiplier");
        expect(sql).toContain("(r->>'supplyUi')::double precision AS supply_ui");
    });

    test('upserts on mint, guards every other column, and dedupes a repeated mint', () => {
        const built = buildTokenSql({ tokensDoc, healthDoc });
        expect(built.sql).toContain('ON CONFLICT (mint) DO UPDATE SET');
        expect(updatedColumns(built.sql)).not.toContain('mint');
        const guards = [...built.sql.matchAll(/IS DISTINCT FROM/g)].length;
        expect(guards).toBe(updatedColumns(built.sql).length);
        expect(built.rows).toBe(1);
        expect(buildTokenSql({ tokensDoc: { tokens: [tokensDoc.tokens[0], tokensDoc.tokens[0]] } }).rows).toBe(1);
    });
});

describe('buildSnapshotSql', () => {
    const doc = {
        date: '2026-09-16',
        builtAt: '2026-09-16T20:45:57Z',
        items: [{ mint: 'MINT_A', symbol: 'AAPLon', issuer: 'ondo-global-markets', supplyRaw: '367022839632', health: null }]
    };

    test('the snapshot date comes from the document, never from the clock', () => {
        const { sql } = buildSnapshotSql(doc);
        expect(sql).toContain("(d->>'date')::date AS snapshot_date");
        expect(sql).not.toMatch(/current_date|now\(\)::date/);
    });

    test('refuses a document with no date rather than inventing one', () => {
        expect(() => buildSnapshotSql({ builtAt: 'x', items: [] })).toThrow(/no `date`/);
    });

    test('the composite key is (snapshot_date, mint) and neither half is rewritten', () => {
        const { sql } = buildSnapshotSql(doc);
        expect(sql).toContain('ON CONFLICT (snapshot_date, mint) DO UPDATE SET');
        expect(updatedColumns(sql)).not.toContain('snapshot_date');
        expect(updatedColumns(sql)).not.toContain('mint');
    });

    test('the reserved column name `row` is quoted, so the statement parses', () => {
        const { sql } = buildSnapshotSql(doc);
        expect(insertedColumns(sql)).toContain('"row"');
        expect(sql).toContain('r AS "row"');
    });

    test('reports its own date and the distinct-mint count', () => {
        const built = buildSnapshotSql(doc);
        expect(built.date).toBe('2026-09-16');
        expect(built.rows).toBe(1);
    });
});

describe('buildTradeSql', () => {
    const doc = {
        generatedAt: '2026-09-17T10:05:00Z',
        trades: [{
            sig: 'SIG_A', time: '2026-09-17T10:04:03Z', mint: 'MINT_A', dex: 'raydium',
            side: 'sell', size: 0.081415, priceUsd: null, routed: true, programCount: 2, suspect: null
        }]
    };

    test('a re-seen trade only ever has `suspect` refreshed', () => {
        const { sql } = buildTradeSql(doc);
        expect(sql).toContain('ON CONFLICT (sig) DO UPDATE SET');
        expect(updatedColumns(sql)).toEqual(['suspect']);
        expect(sql).toContain('WHERE tgt.suspect IS DISTINCT FROM EXCLUDED.suspect');
        expect([...sql.matchAll(/IS DISTINCT FROM/g)]).toHaveLength(1);
        // a settled trade's price/size/side must not be rewritten by a later file
        for (const col of ['price_usd', 'size', 'side', 'mint', 'dex']) {
            expect(updatedColumns(sql)).not.toContain(col);
        }
    });

    test('the reserved column name `time` is quoted', () => {
        const { sql } = buildTradeSql(doc);
        expect(insertedColumns(sql)).toContain('"time"');
        expect(sql).toContain('(r->>\'time\')::timestamptz AS "time"');
    });

    test('a trade with no time is skipped, not given an invented one', () => {
        const built = buildTradeSql({ trades: [doc.trades[0], { sig: 'SIG_B' }, { time: '2026-09-17T10:00:00Z' }] });
        expect(built.rows).toBe(1);
        expect(built.skipped).toBe(2);
        expect(built.sql).toContain("WHERE x.r->>'sig' IS NOT NULL AND x.r->>'time' IS NOT NULL");
        expect(built.sql).not.toMatch(/now\(\)::timestamptz AS "time"/);
    });

    test('keeps the last occurrence of a repeated signature', () => {
        const built = buildTradeSql({ trades: [doc.trades[0], doc.trades[0]] });
        expect(built.rows).toBe(1);
        expect(built.sql).toContain("DISTINCT ON (x.r->>'sig')");
        expect(built.sql).toContain('ORDER BY x.r->>\'sig\', x.ord DESC');
    });

    test('stores no `record` column — the tape is flat by design', () => {
        expect(insertedColumns(buildTradeSql(doc).sql)).not.toContain('record');
    });
});

describe('wrapTransaction', () => {
    test('a table loads whole or not at all', () => {
        const out = wrapTransaction(['A;', 'B;']);
        expect(out.startsWith('BEGIN;\n')).toBe(true);
        expect(out.trimEnd().endsWith('COMMIT;')).toBe(true);
        expect(out).toContain('A;\nB;');
    });

    test('accepts a single statement', () => {
        expect(wrapTransaction('X;')).toBe('BEGIN;\nX;\nCOMMIT;\n');
    });
});

describe('the DDL and the builders agree', () => {
    const columns = ddlColumns();
    const cases = [
        ['sonar.stock_issuer', () => buildIssuerSql({ issuers: [] }).sql],
        ['sonar.stock_token', () => buildTokenSql({ tokensDoc: { tokens: [] } }).sql],
        ['sonar.stock_token_snapshot', () => buildSnapshotSql({ date: '2026-09-16', items: [] }).sql],
        ['sonar.stock_trade', () => buildTradeSql({ trades: [] }).sql]
    ];

    test('the DDL declares all four tables', () => {
        expect(Object.keys(columns).sort()).toEqual(cases.map(([t]) => t).sort());
    });

    test.each(cases)('%s: every inserted column exists in the DDL', (table, sqlOf) => {
        const declared = new Set(columns[table].map((c) => c.replace(/"/g, '')));
        for (const col of insertedColumns(sqlOf())) {
            expect(declared).toContain(col.replace(/"/g, ''));
        }
    });

    test.each(cases)('%s: the bookkeeping timestamps are left to the defaults', (table, sqlOf) => {
        const inserted = insertedColumns(sqlOf());
        expect(inserted).not.toContain('created_at');
        expect(inserted).not.toContain('updated_at');
        expect(columns[table]).toContain('created_at');
        expect(columns[table]).toContain('updated_at');
    });
});

describe('the repo’s real documents', () => {
    const read = (p) => JSON.parse(readFileSync(join(REPO, p), 'utf8'));

    test('stocks-issuers.json builds one row per issuer and round-trips through the literal', () => {
        const doc = read('stocks-issuers.json');
        const built = buildIssuerSql(doc);
        expect(built.rows).toBe(doc.issuers.length);
        expect(embeddedDocs(built.sql)).toEqual([doc]);
    });

    test('every token names an issuer the issuer document declares (the FK would reject it)', () => {
        const slugs = new Set(read('stocks-issuers.json').issuers.map((i) => i.slug));
        const orphans = read('stocks-tokens.json').tokens
            .map((t) => t.issuer)
            .filter((s) => !slugs.has(s));
        expect([...new Set(orphans)]).toEqual([]);
    });

    test('stocks-tokens.json and stocks-health.json build one row per mint', () => {
        const tokensDoc = read('stocks-tokens.json');
        const built = buildTokenSql({ tokensDoc, healthDoc: read('stocks-health.json') });
        expect(built.rows).toBe(tokensDoc.tokens.length);
        expect(built.sql).toContain('INSERT INTO sonar.stock_token AS tgt');
    });

    test('no real document can terminate its own dollar-quoted literal', () => {
        for (const p of ['stocks-issuers.json', 'stocks-tokens.json', 'stocks-health.json']) {
            const doc = read(p);
            const sql = jsonbLiteral(doc);
            const tag = sql.match(/^\$(sonar\d*)\$/)[1];
            expect(sql.split(`$${tag}$`)).toHaveLength(3);
        }
    });
});

// --- claims -----------------------------------------------------------------------------------

describe('claimId', () => {
    test('is deterministic: the same field, URL and quote always give the same id', () => {
        const a = claimId('prestocks', 'redemption.rails', 'https://x/tos', 'USDC or another');
        const b = claimId('prestocks', 'redemption.rails', 'https://x/tos', 'USDC or another');
        expect(a).toBe(b);
        // An id that moved between runs would make every re-load an insert, not an upsert.
        expect(a).toMatch(/^prestocks:redemption\.rails:[0-9a-f]{8}$/);
    });

    test('is normalised, so a spaced field path addresses the same row', () => {
        expect(claimId('p', '  redemption . rails ', 'u', 'q'))
            .toBe(claimId('p', 'redemption.rails', 'u', 'q'));
    });

    test('a different quote, URL, field or issuer is a different claim', () => {
        const base = claimId('p', 'f', 'u', 'q');
        expect(claimId('p', 'f', 'u', 'other')).not.toBe(base);
        expect(claimId('p', 'f', 'other', 'q')).not.toBe(base);
        expect(claimId('p', 'other', 'u', 'q')).not.toBe(base);
        expect(claimId('other', 'f', 'u', 'q')).not.toBe(base);
    });

    test('a null URL and a null quote are distinguishable from empty strings by the pair', () => {
        // The digest is over `url|quote`, so "a|" and "|a" cannot collide.
        expect(claimId('p', 'f', 'a', null)).not.toBe(claimId('p', 'f', null, 'a'));
    });
});

describe('claimRowsForDossier', () => {
    const rows = claimRowsForDossier('fixture', CLAIM_FIXTURE);
    const byField = (field) => rows.filter((r) => r.field === field);

    test('carries the dossier VALUE at the claim\'s field path, not the quote', () => {
        const rails = byField('redemption.rails')[0];
        expect(rails.value).toBe('USDC, or another mutually agreed form of value.');
        expect(rails.quote).toBe('USDC or another mutually agreed form of value');
    });

    test('an array index and a vocabulary value resolve', () => {
        expect(byField('products[0]')[0].value).toBe('tokenized US equities');
        expect(byField('vocabulary.blockchainIsMainLedger.value')[0].value).toBe('yes');
        expect(byField('parties.custodians')[0].value).toEqual(['Unnamed Liechtenstein bank']);
    });

    test('a researched `false` is carried as false, never as null and never as 0', () => {
        expect(byField('bankruptcyRemote')[0].value).toBe(false);
    });

    test('a findings/incidents/attestations claim carries the whole entry as its value', () => {
        expect(byField('findings[0]')[0].value.schema).toBe('freeze-authority-has-been-exercised');
        expect(byField('incidents[0]')[0].value.date).toBe('2026-05-02');
    });

    test('method is derived from the locator, not declared', () => {
        expect(byField('keyGovernance.mint')[0].method).toBe('onchain');
        expect(byField('legalForm')[0].method).toBe('manual');
    });

    test('a missing claims array gives the quoted entries and zero errors', () => {
        const { claims: _drop, ...noClaims } = CLAIM_FIXTURE;
        const out = claimRowsForDossier('fixture', noClaims);
        expect(out.map((r) => r.field)).toEqual(['findings[0]', 'incidents[0]', 'attestations[0]']);
    });

    test('a dossier with neither claims nor quotes gives ZERO rows, not an error', () => {
        expect(claimRowsForDossier('fixture', { redemption: { rails: 'x' } })).toEqual([]);
        expect(claimRowsForDossier('fixture', {})).toEqual([]);
        expect(claimRowsForDossier('fixture', null)).toEqual([]);
    });

    test('claimRows sorts by id, so the embedded payload is byte-stable across runs', () => {
        const a = claimRows([{ slug: 'fixture', dossier: CLAIM_FIXTURE }]);
        const b = claimRows([{ slug: 'fixture', dossier: CLAIM_FIXTURE }]);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        expect(a.map((r) => r.id)).toEqual([...a.map((r) => r.id)].sort());
    });

    test('a dossier entry with no slug is skipped rather than filed under "undefined"', () => {
        expect(claimRows([{ dossier: CLAIM_FIXTURE }, null, undefined])).toEqual([]);
        expect(claimRows(null)).toEqual([]);
    });
});

describe('buildClaimOrphanSql', () => {
    const rows = claimRows([{ slug: 'fixture', dossier: CLAIM_FIXTURE }]);

    test('asks which of an issuer\'s claims this run did not offer, and never deletes', () => {
        const built = buildClaimOrphanSql(rows);
        expect(built.text).toContain('FROM sonar.claim c');
        expect(built.text).toContain('AND c.id NOT IN (SELECT id FROM offered)');
        // A loader that deleted them would silently discard a quote a human is meant to review.
        expect(built.text).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE)\b/i);
        expect(built.ids).toBe(new Set(rows.map((r) => r.id)).size);
        expect(built.slugs).toBe(1);
    });

    test('scopes to the issuers actually loaded, so a partial run cannot flag the others', () => {
        // --only=claims on a dossier directory holding one issuer must not report every OTHER
        // issuer's claims as orphaned.
        const built = buildClaimOrphanSql(rows);
        expect(built.text).toContain('WHERE c.issuer_slug IN (SELECT slug FROM loaded)');
        const embedded = embeddedDocs(built.text.replace(/::jsonb/g, '::jsonb'));
        expect(embedded[1]).toEqual(['fixture']);
    });

    test('an empty run asks about nothing rather than flagging the whole table', () => {
        const built = buildClaimOrphanSql([]);
        expect(built.ids).toBe(0);
        expect(built.slugs).toBe(0);
        // No slugs means the IN list is empty, so the statement selects no rows at all.
        expect(embeddedDocs(built.text)[1]).toEqual([]);
    });
});

describe('buildClaimSql', () => {
    const rows = claimRows([{ slug: 'fixture', dossier: CLAIM_FIXTURE }]);
    const built = buildClaimSql(rows, { builtAt: '2026-09-18T12:00:00Z' });

    test('one row per distinct claim id', () => {
        expect(built.rows).toBe(new Set(rows.map((r) => r.id)).size);
        expect(built.table).toBe('sonar.claim');
    });

    test('an empty list still renders a valid statement (zero rows, not a crash)', () => {
        const empty = buildClaimSql([]);
        expect(empty.rows).toBe(0);
        expect(empty.sql).toContain('INSERT INTO sonar.claim AS tgt');
        expect(embeddedDocs(empty.sql)).toEqual([{ builtAt: null, claims: [] }]);
    });

    test('source_id is resolved by EXACT url against sonar.source, and never invented', () => {
        expect(built.sql).toContain("LEFT JOIN sonar.source s ON s.url = src.r->>'url'");
        expect(built.sql).toContain('s.id AS source_id');
    });

    test('recorded_at and the two watcher timestamps are INSERT-only', () => {
        // recorded_at is when we first wrote the claim; last_checked_at/last_confirmed_at belong to
        // the watcher, which measures them by re-reading the source. Refreshing them from the
        // dossier would make a stale claim look freshly checked.
        const updated = updatedColumns(built.sql);
        expect(updated).not.toContain('recorded_at');
        expect(updated).not.toContain('last_checked_at');
        expect(updated).not.toContain('last_confirmed_at');
        expect(updated).not.toContain('status');
        expect(updated).toContain('value');
        expect(updated).toContain('source_id');
        expect(updated).toContain('active');
    });

    test('marks the loaded issuers inactive before reactivating their exact current claims', () => {
        expect(built.sql).toContain('SET active = false');
        expect(built.sql).toContain("issuer_slug IN (SELECT DISTINCT r->>'issuerSlug'");
        expect(built.sql).toContain("id NOT IN (SELECT r->>'id'");
        expect(built.sql).toContain('TRUE AS active');
    });

    test('the ON CONFLICT guard makes an unchanged re-load a no-op', () => {
        for (const col of updatedColumns(built.sql)) {
            expect(built.sql).toContain(`tgt.${col} IS DISTINCT FROM EXCLUDED.${col}`);
        }
    });

    test('a JSON null value lands as SQL NULL, not as the jsonb literal `null`', () => {
        expect(built.sql).toContain("NULLIF(r->'value', 'null'::jsonb) AS value");
    });

    test('last_confirmed_at is only seeded for a CONFIRMED claim', () => {
        expect(built.sql).toContain("CASE WHEN r->>'status' = 'confirmed' THEN (r->>'accessedAt')::timestamptz ELSE NULL END AS last_confirmed_at");
    });

    test('every loaded column exists in db/2026-09-18-sonar-claims.sql', () => {
        const declared = ddlColumns(CLAIM_DDL_PATH)['sonar.claim'];
        expect(declared).toBeDefined();
        const missing = insertedColumns(built.sql).filter((c) => !declared.includes(c));
        expect(missing).toEqual([]);
    });

    test('no claim payload can terminate its own dollar-quoted literal', () => {
        const nasty = claimRows([{
            slug: 'fixture',
            dossier: { redemption: { rails: 'x' }, claims: [{
                field: 'redemption.rails',
                quote: 'a $sonar$ and a $sonar1$ walk into a bar',
                url: 'https://x/tos',
                accessedAt: '2026-09-18T10:00:00Z',
                status: 'confirmed'
            }] }
        }]);
        const sql = buildClaimSql(nasty).sql;
        const tag = sql.match(/\$(sonar\d*)\$/)[1];
        expect(embeddedDocs(sql)[0].claims[0].quote).toContain('$sonar$');
        expect(tag).not.toBe('sonar');
    });

    test('an inference row loads, and the DDL\'s evidence check permits its shape', () => {
        // url null + quote null + a note naming what it rests on is the PRESCRIBED inference shape.
        // A CHECK of "quote OR url" would reject every one of them at the database, which is why
        // the constraint carries the exception explicitly rather than by accident.
        const inference = rows.find((r) => r.field === 'securityInterest.exists'
            && r.status === 'inference');
        expect(inference).toBeDefined();
        expect(inference.quote).toBeNull();
        expect(inference.url).toBeNull();
        expect(inference.note).not.toBeNull();
        expect(inference.value).toBe(false);

        const ddl = readFileSync(CLAIM_DDL_PATH, 'utf8');
        // Each check is written TWICE on purpose — once inside CREATE TABLE for a fresh database,
        // once as an ALTER so it also reaches a table that already exists — so both occurrences
        // are counted. Asserting only `toContain` let a mutation of the CREATE copy pass, because
        // the ALTER copy still matched; the two must not be allowed to drift.
        const occurrences = (needle) => ddl.split(needle).length - 1;
        // A claim must SAY something, but not necessarily quote something.
        expect(occurrences('quote IS NOT NULL OR url IS NOT NULL OR note IS NOT NULL')).toBe(2);
        // And a `confirmed` claim must have the words or at least the link.
        expect(occurrences("status <> 'confirmed' OR quote IS NOT NULL OR url IS NOT NULL")).toBe(2);
        // Both must be re-stated, not just declared inside CREATE TABLE IF NOT EXISTS, or
        // applying the file to an existing table would be a silent no-op.
        for (const name of ['claim_has_evidence_check', 'claim_confirmed_has_source_check']) {
            expect(ddl).toContain(`ALTER TABLE sonar.claim DROP CONSTRAINT IF EXISTS ${name}`);
            expect(ddl).toContain(`ALTER TABLE sonar.claim ADD CONSTRAINT ${name}`);
        }
    });

    test('every row the loader offers satisfies both DDL checks', () => {
        // The loader and the constraint have to agree, or ONE bad claim aborts the whole
        // transaction and nothing loads at all.
        for (const row of rows) {
            const saysSomething = row.quote !== null || row.url !== null || row.note !== null;
            const confirmedHasSource = row.status !== 'confirmed'
                || row.quote !== null || row.url !== null;
            expect({ field: row.field, saysSomething, confirmedHasSource })
                .toEqual({ field: row.field, saysSomething: true, confirmedHasSource: true });
        }
    });

    test('the REAL dossiers satisfy both checks too, so a load cannot be aborted by one claim', () => {
        const dossiers = readdirSync(join(REPO, 'stocks', 'data', 'issuers'))
            .filter((f) => f.endsWith('.json')).sort()
            .map((f) => ({
                slug: f.replace(/\.json$/, ''),
                dossier: JSON.parse(readFileSync(join(REPO, 'stocks', 'data', 'issuers', f), 'utf8'))
            }));
        const offending = claimRows(dossiers).filter((row) => {
            const saysSomething = row.quote !== null || row.url !== null || row.note !== null;
            const confirmedHasSource = row.status !== 'confirmed'
                || row.quote !== null || row.url !== null;
            return !saysSomething || !confirmedHasSource;
        });
        expect(offending.map((r) => `${r.issuerSlug}:${r.field}:${r.status}`)).toEqual([]);
    });

    test('the statuses the fixture writes are all inside the DDL check constraint', () => {
        const ddl = readFileSync(CLAIM_DDL_PATH, 'utf8');
        const allowed = ddl.match(/claim_status_check CHECK \(status IN \(([^)]*)\)/)[1]
            .split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
        for (const row of rows) expect(allowed).toContain(row.status);
        for (const row of rows) expect(['manual', 'extracted', 'onchain']).toContain(row.method);
    });
});

// --- what-if ----------------------------------------------------------------------------------

const WHATIF_DDL_PATH = join(REPO, 'db', '2026-09-18-sonar-whatif.sql');
const CATALOGUE = JSON.parse(
    readFileSync(join(REPO, 'stocks', 'data', 'trust-chain.json'), 'utf8')
);

/** A dossier that answers three modes three different ways, plus one entry with no mode at all. */
const WHATIF_FIXTURE = {
    whatIf: [
        {
            mode: 'issuer-wind-down',
            status: 'documented',
            outcome: 'Thirty days notice, then redemption at the final mark.',
            quote: 'The Issuer may terminate the Products on 30 days notice.',
            url: 'https://fixture.example/terms.pdf',
            locator: 'clause 18',
            accessedAt: '2026-09-18T10:00:00Z'
        },
        {
            mode: 'court-order',
            status: 'litigated',
            outcome: 'The issuer complied with the order.',
            quote: 'ORDERED that the tokens be transferred.',
            url: 'https://www.sec.gov/litigation/lr-1.htm',
            accessedAt: '2026-09-18T10:00:00Z',
            cases: [{ name: 'A v. B', court: 'SDNY', date: '2024-01-01', url: 'https://x/a-v-b' }]
        },
        {
            mode: 'tax-withholding',
            status: 'unknown',
            outcome: 'We could not establish who withholds.',
            accessedAt: '2026-09-18T10:00:00Z',
            searched: ['https://fixture.example/terms.pdf', 'the prospectus tax section']
        },
        { status: 'inferred', outcome: 'an entry that names no mode at all' }
    ]
};

describe('buildFailureModeSql', () => {
    const built = buildFailureModeSql(CATALOGUE);

    test('loads the whole catalogue, one row per mode', () => {
        expect(built.table).toBe('sonar.failure_mode');
        expect(built.rows).toBe(CATALOGUE.failureModes.length);
    });

    test('`ord` is the mode\'s position in the FILE, not an id sort', () => {
        const [doc] = embeddedDocs(built.sql);
        expect(doc.modes.map((m) => m.ord)).toEqual(doc.modes.map((_, i) => i));
        expect(doc.modes.map((m) => m.id)).toEqual(CATALOGUE.failureModes.map((m) => m.id));
        // An id sort would have put `account-frozen` first; the file starts at the holder.
        expect(doc.modes[0].id).toBe('keys-stolen');
        expect(doc.modes[0].id).not.toBe([...doc.modes].sort((a, b) => (a.id < b.id ? -1 : 1))[0].id);
    });

    test('every loaded column exists in db/2026-09-18-sonar-whatif.sql', () => {
        const declared = ddlColumns(WHATIF_DDL_PATH)['sonar.failure_mode'];
        expect(declared).toBeDefined();
        expect(insertedColumns(built.sql).filter((c) => !declared.includes(c))).toEqual([]);
    });

    test('the ON CONFLICT guard makes an unchanged re-load a no-op', () => {
        for (const col of updatedColumns(built.sql)) {
            expect(built.sql).toContain(`tgt.${col} IS DISTINCT FROM EXCLUDED.${col}`);
        }
        expect(updatedColumns(built.sql)).not.toContain('id');
    });

    test('an empty or absent catalogue renders zero rows rather than throwing', () => {
        expect(buildFailureModeSql({}).rows).toBe(0);
        expect(buildFailureModeSql(null).rows).toBe(0);
    });
});

describe('whatIfRowsForDossier', () => {
    const { rows, dropped } = whatIfRowsForDossier('fixture', WHATIF_FIXTURE);

    test('the id is <issuer>:<mode>, so one issuer answers one mode exactly once', () => {
        expect(rows.map((r) => r.id)).toEqual([
            'fixture:issuer-wind-down', 'fixture:court-order', 'fixture:tax-withholding'
        ]);
        expect(whatIfId('fixture', 'court-order')).toBe('fixture:court-order');
    });

    test('an entry with no mode is skipped and COUNTED, never silently lost', () => {
        expect(dropped).toBe(1);
        expect(rows).toHaveLength(3);
    });

    test('cases and searched default to [], because the columns are NOT NULL arrays', () => {
        const documented = rows.find((r) => r.mode === 'issuer-wind-down');
        expect(documented.cases).toEqual([]);
        expect(documented.searched).toEqual([]);
        expect(rows.find((r) => r.mode === 'court-order').cases).toHaveLength(1);
        expect(rows.find((r) => r.mode === 'tax-withholding').searched).toHaveLength(2);
    });

    test('a dossier with no whatIf gives zero rows and no error', () => {
        expect(whatIfRowsForDossier('fixture', {})).toEqual({ rows: [], dropped: 0 });
        expect(whatIfRowsForDossier('fixture', null)).toEqual({ rows: [], dropped: 0 });
    });

    test('whatIfRows sorts by id, so the embedded payload is byte-stable across runs', () => {
        const a = whatIfRows([{ slug: 'fixture', dossier: WHATIF_FIXTURE }]);
        const b = whatIfRows([{ slug: 'fixture', dossier: WHATIF_FIXTURE }]);
        expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows));
        expect(a.rows.map((r) => r.id)).toEqual([...a.rows.map((r) => r.id)].sort());
    });

    test('a dossier entry with no slug is skipped rather than filed under ""', () => {
        expect(whatIfRows([{ dossier: WHATIF_FIXTURE }, null]).rows).toEqual([]);
        expect(whatIfRows(null).rows).toEqual([]);
    });
});

describe('buildWhatIfSql', () => {
    const { rows } = whatIfRows([{ slug: 'fixture', dossier: WHATIF_FIXTURE }]);
    const built = buildWhatIfSql(rows, { builtAt: '2026-09-18T12:00:00Z' });

    test('one row per distinct answer id', () => {
        expect(built.table).toBe('sonar.what_if');
        expect(built.rows).toBe(3);
    });

    test('source_id is resolved by EXACT url against sonar.source, and never invented', () => {
        expect(built.sql).toContain("LEFT JOIN sonar.source s ON s.url = src.r->>'url'");
        expect(built.sql).toContain('s.id AS source_id');
    });

    test('a non-array cases/searched becomes [], which is what the NOT NULL column needs', () => {
        expect(built.sql).toContain(
            "CASE WHEN jsonb_typeof(r->'cases') = 'array' THEN r->'cases' ELSE '[]'::jsonb END AS cases");
        expect(built.sql).toContain(
            "CASE WHEN jsonb_typeof(r->'searched') = 'array' THEN r->'searched' ELSE '[]'::jsonb END AS searched");
    });

    test('accessed_at is the researcher\'s own reading, never the load clock', () => {
        expect(built.sql).toContain("(r->>'accessedAt')::timestamptz AS accessed_at");
        expect(built.sql).not.toMatch(/now\(\) AS accessed_at/);
    });

    test('every loaded column exists in db/2026-09-18-sonar-whatif.sql', () => {
        const declared = ddlColumns(WHATIF_DDL_PATH)['sonar.what_if'];
        expect(declared).toBeDefined();
        expect(insertedColumns(built.sql).filter((c) => !declared.includes(c))).toEqual([]);
    });

    test('the ON CONFLICT guard makes an unchanged re-load a no-op', () => {
        for (const col of updatedColumns(built.sql)) {
            expect(built.sql).toContain(`tgt.${col} IS DISTINCT FROM EXCLUDED.${col}`);
        }
        expect(updatedColumns(built.sql)).not.toContain('id');
    });

    test('an empty list still renders a valid statement (zero rows, not a crash)', () => {
        const empty = buildWhatIfSql([]);
        expect(empty.rows).toBe(0);
        expect(empty.sql).toContain('INSERT INTO sonar.what_if AS tgt');
        expect(embeddedDocs(empty.sql)).toEqual([{ builtAt: null, whatIf: [] }]);
    });

    test('no answer payload can terminate its own dollar-quoted literal', () => {
        const nasty = whatIfRows([{
            slug: 'fixture',
            dossier: { whatIf: [{
                mode: 'keys-stolen',
                status: 'documented',
                outcome: 'gone',
                quote: 'a $sonar$ and a $sonar1$ walk into a bar',
                accessedAt: '2026-09-18T10:00:00Z'
            }] }
        }]).rows;
        const sql = buildWhatIfSql(nasty).sql;
        expect(sql).toContain('$sonar2$');
        expect(embeddedDocs(sql)[0].whatIf[0].quote).toBe('a $sonar$ and a $sonar1$ walk into a bar');
    });
});

describe('buildWhatIfDeleteSql', () => {
    const { rows } = whatIfRows([{ slug: 'fixture', dossier: WHATIF_FIXTURE }]);

    test('deletes the answers this run no longer offers — a withdrawn answer must not be served', () => {
        const built = buildWhatIfDeleteSql(rows);
        expect(built.text).toContain('DELETE FROM sonar.what_if w');
        expect(built.text).toContain('AND w.id NOT IN (SELECT id FROM offered)');
        expect(built.text).toContain('RETURNING w.issuer_slug, w.mode_id');
        expect(built.ids).toBe(3);
        expect(built.slugs).toBe(1);
    });

    test('scopes to the issuers actually loaded, so --only over one dossier cannot wipe the rest', () => {
        const built = buildWhatIfDeleteSql(rows);
        expect(built.text).toContain('WHERE w.issuer_slug IN (SELECT slug FROM loaded)');
        expect(embeddedDocs(built.text)[1]).toEqual(['fixture']);
    });

    test('an empty run deletes NOTHING rather than emptying the table', () => {
        const built = buildWhatIfDeleteSql([]);
        expect(built.ids).toBe(0);
        expect(built.slugs).toBe(0);
        // No slugs means the issuer IN list is empty, so the DELETE matches no row at all.
        expect(embeddedDocs(built.text)[1]).toEqual([]);
    });
});
