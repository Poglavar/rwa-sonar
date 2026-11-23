// Integration test of the entity watcher's store/compare split (stocks/lib/entities.mjs) on a
// throwaway schema of a laptop database (SONAR_TEST_DATABASE_URL; skipped without it): the same
// state observed again writes no row, a failed comparison leaves the stored observation waiting,
// the next run offers it again with the state before it, and re-applying the DDL never marks a
// waiting row as compared.

import { readFileSync } from 'node:fs';

import { TEST_DB_URL, throwawaySchema } from '../test-fixtures/throwaway-schema.mjs';
import { wrapTransaction } from './lib/db-load.mjs';
import {
    buildObservationSql, buildProcessedSql, buildReadUnprocessedQuery, gleifState, observationRow, parseGleifRecord, parseObservationResult,
    processObservation
} from './lib/entities.mjs';

const DDL = readFileSync(new URL('../db/2026-10-01-sonar-entities.sql', import.meta.url), 'utf8');
const maybe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) console.log('entity-observation-db.test.js: SONAR_TEST_DATABASE_URL not set — integration tests skipped');

const BITGO = parseGleifRecord(JSON.parse(readFileSync(new URL('./fixtures/entities/gleif-record-bitgo-trust-lapsed.json', import.meta.url), 'utf8')).data);
const TASK = { id: 'gleif:254900QXDWGM1T0HGF47', source: 'gleif', identifier: '254900QXDWGM1T0HGF47', entityKey: 'bitgo trust co inc', entityName: 'BitGo Trust Company, Inc.', issuers: ['i1'] };
const ACTIVE = gleifState({ ...BITGO, registrationStatus: 'ISSUED' }).state;
const MOVED = gleifState(BITGO).state;

maybe('sonar.entity_observation on a real Postgres', () => {
    const db = throwawaySchema('entobs');
    beforeAll(() => db.create(DDL));
    afterAll(() => db.drop());

    const observe = async (state, at) => parseObservationResult(await db.value(
        buildObservationSql(observationRow(TASK, { state, sourceUpdatedAt: null, url: 'u' }, { detectedAt: at })).sql));
    const unprocessed = async () => JSON.parse(await db.value(buildReadUnprocessedQuery()));

    test('a first observation is a baseline row; the same state again only confirms it', async () => {
        expect(await observe(ACTIVE, '2026-11-20T03:29:00Z')).toEqual({ inserted: 1, confirmed: 0, changeKind: 'baseline' });
        expect(await observe(ACTIVE, '2026-11-21T03:29:00Z')).toEqual({ inserted: 0, confirmed: 1, changeKind: null });
        expect(Number(await db.value('SELECT count(*) FROM sonar.entity_observation;'))).toBe(1);
    });

    test('a failed comparison leaves the new observation stored and waiting; the next run compares it with the state before', async () => {
        expect(await observe(MOVED, '2026-11-22T03:29:00Z')).toEqual({ inserted: 1, confirmed: 0, changeKind: 'changed' });
        const waiting = await unprocessed();
        expect(waiting).toHaveLength(2);
        const moved = waiting[1];
        expect(moved.prevState).toEqual(ACTIVE);
        const result = processObservation(moved);
        expect(result.changedFields).toEqual(['registrationStatus']);
        expect(result.events).toHaveLength(1);
        // The processing transaction breaks after the update (an events insert that fails): all of it rolls back.
        await expect(db.run(wrapTransaction([buildProcessedSql(moved.id, result), 'INSERT INTO sonar.no_such_table VALUES (1);'])))
            .rejects.toThrow(/psql exited/);
        expect(await unprocessed()).toHaveLength(2);
        // The next run observes the same state (nothing new stored) and still finds the row to compare.
        expect((await observe(MOVED, '2026-11-23T03:29:00Z')).inserted).toBe(0);
        const again = (await unprocessed()).find((r) => r.id === moved.id);
        expect(processObservation(again).findings).toEqual(result.findings);
        for (const row of await unprocessed()) await db.run(buildProcessedSql(row.id, processObservation(row)));
        expect(await unprocessed()).toEqual([]);
        expect(await db.value(`SELECT changed_fields FROM sonar.entity_observation WHERE id = ${Number(moved.id)};`)).toBe('{registrationStatus}');
    });

    test('re-applying the DDL never marks a waiting row as compared', async () => {
        await observe(ACTIVE, '2026-11-24T03:29:00Z');
        expect(await unprocessed()).toHaveLength(1);
        await db.run(DDL);
        expect(await unprocessed()).toHaveLength(1);
    });

    test('on a table from before the column, applying the DDL marks every existing row compared, once', async () => {
        await db.run('DROP VIEW sonar.entity_status_current; ALTER TABLE sonar.entity_observation DROP COLUMN processed_at;');
        await db.run(DDL);
        expect(await unprocessed()).toEqual([]);
        expect(await db.value('SELECT count(*) FILTER (WHERE processed_at = observed_at) || \'|\' || count(*) FROM sonar.entity_observation;')).toBe('3|3');
    });
});
