// The schema is applied in one place: stocks/apply-schema.mjs at deploy. Scheduled jobs never apply
// it, because re-applying DDL takes exclusive table locks even when nothing changes, and two jobs
// overlapping at the same minute cancelled each other on lock timeout (30 Sep 2026, 06:35 UTC).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SCHEMA_FILES, SUPERSEDED_SCHEMA_FILES } from './lib/schema.mjs';

const ROOT = join(import.meta.dirname, '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

describe('the schema is applied once, at deploy, and never by a scheduled job', () => {
    it('lists every db/*.sql exactly once, either applied in order or superseded with a reason', () => {
        const files = readdirSync(join(ROOT, 'db')).filter((name) => name.endsWith('.sql')).sort();
        const listed = [...SCHEMA_FILES, ...Object.keys(SUPERSEDED_SCHEMA_FILES)].sort();
        expect(listed).toEqual(files);
        expect(new Set(SCHEMA_FILES).size).toBe(SCHEMA_FILES.length);
        for (const reason of Object.values(SUPERSEDED_SCHEMA_FILES)) expect(reason.length).toBeGreaterThan(20);
    });

    it('applies the files a later one depends on first', () => {
        const at = (name) => SCHEMA_FILES.indexOf(name);
        // sonar.source (evidence) before the claim and what-if foreign keys and the source status lists;
        // the chain watcher's change_event before the files that extend it.
        for (const later of ['2026-09-18-sonar-claims.sql', '2026-09-18-sonar-whatif.sql', '2026-09-23-sonar-source-provenance.sql', '2026-09-24-sonar-source-unreadable.sql']) {
            expect(at('2026-09-18-sonar-evidence.sql')).toBeLessThan(at(later));
        }
        for (const later of ['2026-09-23-sonar-caselaw.sql', '2026-09-23-sonar-change-judgment.sql']) {
            expect(at('2026-09-18-sonar-chain.sql')).toBeLessThan(at(later));
        }
        expect(at('2026-09-17-sonar-stocks.sql')).toBe(0);
    });

    it('no scheduled job applies schema: no --ddl in the PM2 jobs or the refresh, and no script accepts it', () => {
        expect(read('ecosystem.config.cjs')).not.toMatch(/--ddl/);
        expect(read('stocks', 'refresh-on-server.sh')).not.toMatch(/--ddl/);
        for (const script of ['load-db', 'watch-sources', 'watch-chain', 'watch-lending', 'watch-caselaw', 'judge-changes']) {
            const source = read('stocks', `${script}.mjs`);
            expect(source).not.toMatch(/flags\.ddl|DDL_FILES?\b|readFile\([^)]*\.sql/);
        }
    });

    it('the deploy applies the schema before its database load, and restarts every scheduled job when their settings change', () => {
        const deploy = read('deploy-to-server.sh');
        expect(deploy.indexOf('node stocks/apply-schema.mjs --run')).toBeGreaterThan(-1);
        expect(deploy.indexOf('node stocks/apply-schema.mjs --run')).toBeLessThan(deploy.indexOf('node stocks/load-db.mjs --run'));
        const ecosystem = read('ecosystem.config.cjs');
        // One block per app: from its `name:` to the next one.
        const cronJobs = ecosystem.split(/(?=name: ')/).filter((block) => /cron_restart:/.test(block))
            .map((block) => /name: '([\w-]+)'/.exec(block)[1]);
        expect(cronJobs.length).toBeGreaterThanOrEqual(7);
        const restarted = /APPS="\$APPS ([^"]+)"/.exec(deploy)[1].split(' ');
        for (const job of cronJobs.filter((name) => name !== 'rwa-watch-digest')) expect(restarted).toContain(job);
    });
});

describe('the scheduled jobs start under PM2', () => {
    it('the watch digest runs through its own entry file, and the module no longer starts itself behind an argv guard', () => {
        // Under PM2 process.argv[1] is PM2's container, so `import.meta.url === argv[1]` was false
        // and the hourly digest never ran (28 Sep).
        expect(read('ecosystem.config.cjs')).toContain("script: 'api/src/jobs/run-watch-digests.js'");
        expect(read('api', 'src', 'jobs', 'run-watch-digests.js')).toMatch(/^runCli\(process\.argv\.slice\(2\)\);$/m);
        expect(read('api', 'src', 'jobs', 'send-watch-digests.js')).not.toMatch(/process\.argv\[1\]/);
    });
});
