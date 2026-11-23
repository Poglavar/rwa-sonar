// A throwaway Postgres schema for integration tests of the sonar SQL: the DDL and the statements
// under test are rewritten from `sonar.` to a schema named after the test process, which is created
// before and dropped after. Runs only when SONAR_TEST_DATABASE_URL is set (a laptop database, never
// prod); without it the integration tests are skipped and say so.

import { psql } from '../stocks/lib/psql.mjs';

export const TEST_DB_URL = process.env.SONAR_TEST_DATABASE_URL || null;

export function throwawaySchema(label) {
    const name = `sonar_test_${label.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${process.pid}`;
    /**
     * `sonar.` (and the CREATE SCHEMA of the DDL) rewritten to the throwaway schema; the DDL's
     * geo_user ownership steps become the test login's own, so the drop needs no other role.
     */
    const rewrite = (sql) => sql.replace(/\bsonar\./g, `${name}.`)
        .replace(/CREATE SCHEMA IF NOT EXISTS sonar;/g, `CREATE SCHEMA IF NOT EXISTS ${name};`)
        .replace(/SET ROLE geo_user/g, 'SET ROLE NONE').replace(/OWNER TO geo_user/g, 'OWNER TO CURRENT_USER');
    const run = (sql, extra = []) => psql(TEST_DB_URL, rewrite(sql), `test ${name}`, extra);
    return {
        name,
        rewrite,
        run,
        /** psql -t -A: one value per line, no headers. */
        value: async (sql) => (await run(sql, ['-t', '-A'])).trim(),
        create: async (...ddl) => {
            await psql(TEST_DB_URL, `DROP SCHEMA IF EXISTS ${name} CASCADE; CREATE SCHEMA ${name};\n`, `create ${name}`);
            for (const text of ddl) await run(text);
        },
        drop: () => psql(TEST_DB_URL, `RESET ROLE; DROP SCHEMA IF EXISTS ${name} CASCADE;\n`, `drop ${name}`)
    };
}
