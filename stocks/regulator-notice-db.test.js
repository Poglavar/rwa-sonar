// Integration test of the notice store's SQL (stocks/lib/regulators.mjs) on a throwaway schema of a
// laptop database (SONAR_TEST_DATABASE_URL; skipped without it): a repeat store of unchanged
// notices inserts nothing, a changed notice is a new version, a failed processing transaction
// leaves the stored notices in place and unmatched, and the next run's backlog read finds them.

import { readFileSync } from 'node:fs';

import { TEST_DB_URL, throwawaySchema } from '../test-fixtures/throwaway-schema.mjs';
import { wrapTransaction } from './lib/db-load.mjs';
import {
    buildMarkMatchedSql, buildNoticeStoreSql, buildReadUnmatchedQuery, noticeRows, parseFcaWarnings, parseStoreCounts
} from './lib/regulators.mjs';

const DDL = readFileSync(new URL('../db/2026-11-23-sonar-regulator-notice.sql', import.meta.url), 'utf8');
const NOTICES = parseFcaWarnings(readFileSync(new URL('./fixtures/regulators/fca-warnings.xml', import.meta.url), 'utf8'));
const maybe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) console.log('regulator-notice-db.test.js: SONAR_TEST_DATABASE_URL not set — integration tests skipped');

maybe('sonar.regulator_notice on a real Postgres', () => {
    const db = throwawaySchema('regnotice');
    beforeAll(() => db.create(DDL));
    afterAll(() => db.drop());

    const store = async (notices, seenAt) => parseStoreCounts(await db.value(buildNoticeStoreSql(noticeRows('fca-warnings', notices), { seenAt }).sql));

    test('a repeat store of unchanged notices inserts nothing and only moves last_seen_at', async () => {
        expect(await store(NOTICES, '2026-11-23T03:21:00Z')).toEqual({ inserted: NOTICES.length, touched: NOTICES.length });
        expect(await store(NOTICES, '2026-11-23T04:21:00Z')).toEqual({ inserted: 0, touched: NOTICES.length });
        expect(await store(NOTICES, '2026-11-23T04:21:00Z')).toEqual({ inserted: 0, touched: 0 });
        expect(Number(await db.value('SELECT count(*) FROM sonar.regulator_notice;'))).toBe(NOTICES.length);
        expect(await db.value("SELECT count(DISTINCT first_seen_at) || '|' || max(last_seen_at) FROM sonar.regulator_notice;"))
            .toBe('1|2026-11-23 04:21:00+00');
    });

    test('a changed notice is a new version beside the old one', async () => {
        expect((await store([{ ...NOTICES[0], title: `${NOTICES[0].title} (amended)` }], '2026-11-23T05:21:00Z')).inserted).toBe(1);
        expect(Number(await db.value(`SELECT count(*) FROM sonar.regulator_notice WHERE notice_id = '${NOTICES[0].id.replace(/'/g, "''")}';`))).toBe(2);
    });

    test('a failed processing transaction leaves every notice stored and unmatched; the next run reads them as backlog', async () => {
        const mark = buildMarkMatchedSql('fca-warnings', NOTICES, { matchedAt: '2026-11-23T05:21:00Z' }).sql;
        // The processing transaction fails after the mark (a broken match upsert): all of it rolls back.
        await expect(db.run(wrapTransaction([mark, 'INSERT INTO sonar.no_such_table VALUES (1);']))).rejects.toThrow(/psql exited/);
        const backlog = JSON.parse(await db.value(buildReadUnmatchedQuery('fca-warnings')));
        expect(backlog.map((b) => b.notice.id).sort()).toEqual(NOTICES.map((n) => n.id).sort());
        // The newest unmatched version of the amended notice is the one offered.
        expect(backlog.find((b) => b.notice.id === NOTICES[0].id).notice.title).toContain('(amended)');
        await db.run(wrapTransaction([mark]));
        expect(JSON.parse(await db.value(buildReadUnmatchedQuery('fca-warnings')))).toEqual([]);
    });
});
