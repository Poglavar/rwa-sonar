// The job-owned runtime data is not in git: every release artifact except the curated inputs is
// ignored, the curated ones are not, and the frozen test copies (test-fixtures/catalogue/) are copies
// of artifacts only. Read from .gitignore itself, so it needs no git binary and fails when a new
// artifact is added to the release manifest without being ignored.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RELEASE_ARTIFACTS, RELEASE_CURATED } from './lib/release-manifest.mjs';

const ROOT = join(import.meta.dirname, '..');
const ignored = new Set(readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n')
    .map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => line.replace(/^\//, '').replace(/\/$/, '')));

function files(dir) {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
    });
}

describe('job-owned runtime data stays out of git', () => {
    it('ignores every release artifact a job writes', () => {
        const missing = RELEASE_ARTIFACTS.filter((path) => !RELEASE_CURATED.includes(path) && !ignored.has(path));
        expect(missing).toEqual([]);
    });

    it('keeps the curated inputs tracked, and they exist in the checkout', () => {
        for (const path of RELEASE_CURATED) {
            expect(RELEASE_ARTIFACTS).toContain(path);
            expect(ignored.has(path)).toBe(false);
            expect(existsSync(join(ROOT, path))).toBe(true);
        }
    });

    it('holds frozen test copies of release artifacts only', () => {
        const fixtureRoot = join(ROOT, 'test-fixtures', 'catalogue');
        const copies = files(fixtureRoot).map((path) => relative(fixtureRoot, path));
        expect(copies.length).toBeGreaterThan(0);
        for (const copy of copies) {
            expect(RELEASE_ARTIFACTS.some((artifact) => copy === artifact || copy.startsWith(`${artifact}/`))).toBe(true);
            expect(RELEASE_CURATED).not.toContain(copy);
        }
    });
});
