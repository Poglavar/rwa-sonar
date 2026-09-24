import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_ARTIFACTS } from './lib/release-manifest.mjs';
import { KEEP_GENERATIONS, generationsToPrune, publishRelease } from './publish-release.mjs';
import { hashArtifactFamily } from './release-evidence.mjs';

// Tests the staged, pointer-switched release publisher against generated fixture releases.

const DIRECTORIES = new Set(['stocks/data/history', 'cards', 'templates', 'issuers', 'protocols', 'comparisons', 'weekly', 'og', 'sitemaps']);

/**
 * A publish costs ~15 filesystem metadata calls per artifact family (copy, hash, symlink, rename),
 * and on a loaded laptop each of those can wait milliseconds behind other jest workers' filesystem
 * work: with the real 29-family manifest, single tests took 3-4 s of jest's 5 s budget while the
 * full suite ran beside them (2026-09-23). The mechanics under test — staging, hash verification,
 * alias installation and the one pointer switch — do not depend on how many families there are,
 * so every test except the complete-manifest one publishes this representative subset: the
 * evidence record, top-level files, a nested directory family and top-level directory families.
 */
const SMALL = ['release-evidence.json', 'stocks-issuers.json', 'stocks-tokens.json', 'stocks-graph.json',
    'stocks/data/history', 'cards', 'templates'];

async function writeRelease(root, version, artifacts = SMALL) {
    for (const item of artifacts) {
        const path = join(root, item);
        await mkdir(join(path, '..'), { recursive: true });
        if (DIRECTORIES.has(item)) {
            await mkdir(path, { recursive: true });
            await writeFile(join(path, 'version.txt'), version);
        } else if (item !== 'release-evidence.json') {
            await writeFile(path, `${version}:${item}`);
        }
    }
    const hashes = [];
    for (const item of artifacts.slice(1)) hashes.push(await hashArtifactFamily({ root, artifact: item }));
    await writeFile(join(root, 'release-evidence.json'), JSON.stringify({ artifacts: hashes }));
}

async function fixture(artifacts = SMALL) {
    const root = await mkdtemp(join(tmpdir(), 'rwa-publish-test-'));
    const source = join(root, 'source');
    const destination = join(root, 'docroot');
    await mkdir(source); await mkdir(destination);
    await writeRelease(source, 'new', artifacts); await writeRelease(destination, 'old', artifacts);
    return { root, source, destination, artifacts };
}

async function text(root, item) { return readFile(join(root, item), 'utf8'); }

describe('publishRelease', () => {
    let root;
    afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });

    // The one test that publishes the real 29-family manifest (two fixture releases plus one
    // publish, ~700 filesystem calls). It measured 3.3 s beside the full suite on a loaded laptop,
    // so it gets 20 s; the other tests use the small manifest and jest's default budget.
    test('publishes the complete manifest while preserving modes, generated symlinks, and runtime tape outside it', async () => {
        const setup = await fixture(RELEASE_ARTIFACTS); ({ root } = setup);
        await chmod(join(setup.source, 'stocks-graph.json'), 0o640);
        await writeFile(join(setup.destination, 'stocks-trades.json'), 'runtime tape');

        await expect(publishRelease(setup)).resolves.toMatchObject({ artifacts: RELEASE_ARTIFACTS.length });
        await expect(text(setup.destination, 'stocks-issuers.json')).resolves.toBe('new:stocks-issuers.json');
        await expect(text(setup.destination, 'stocks-trades.json')).resolves.toBe('runtime tape');
        expect((await stat(join(setup.destination, 'stocks-graph.json'))).mode & 0o777).toBe(0o640);
        expect((await lstat(join(setup.destination, 'cards'))).isSymbolicLink()).toBe(true);
    }, 20_000);

    test('every generation directory is world-readable, so the web server can traverse it', async () => {
        // mkdtemp creates 0700 directories; published through symlinks, that returned "permission
        // denied" to nginx for every generated file on rwasonar.com on 2026-09-23.
        const setup = await fixture(); ({ root } = setup);
        await publishRelease(setup);
        await publishRelease(setup);
        const generations = join(root, '.rwa-release-generations');
        const { readdir } = await import('node:fs/promises');
        const names = (await readdir(generations)).filter((name) => name.startsWith('release-'));
        expect(names.length).toBeGreaterThanOrEqual(2);
        for (const name of names) {
            expect((await stat(join(generations, name))).mode & 0o755).toBe(0o755);
        }
    });

    test('old generations are pruned: only the newest few remain, and the live one is among them', async () => {
        // Keeping every generation filled the prod disk on 2026-09-23 (52 copies, 9.5 GB, ENOSPC).
        const setup = await fixture(); ({ root } = setup);
        for (let i = 0; i < KEEP_GENERATIONS + 2; i += 1) await publishRelease(setup);
        const generations = join(root, '.rwa-release-generations');
        const { readdir, realpath } = await import('node:fs/promises');
        const names = (await readdir(generations)).filter((name) => /^release-\d+-\d+$/.test(name));
        expect(names).toHaveLength(KEEP_GENERATIONS);
        const live = (await realpath(join(setup.destination, '.rwa-release-current'))).split('/').pop();
        expect(names).toContain(live);
    }, 20_000);

    test('a staging/hash failure leaves the served old generation unchanged', async () => {
        const setup = await fixture(); ({ root } = setup);
        await writeFile(join(setup.source, SMALL[1]), 'tampered');
        await expect(publishRelease(setup)).rejects.toThrow(/hash mismatch/);
        await expect(text(setup.destination, SMALL[1])).resolves.toBe(`old:${SMALL[1]}`);
    });

    test('the first legacy migration installs every alias before exposing the new generation', async () => {
        const setup = await fixture(); ({ root } = setup);
        let pointerSwitches = 0;
        const observedBeforeActivation = [];
        const rename = async (from, to) => {
            if (to.endsWith('/.rwa-release-current')) {
                pointerSwitches += 1;
                if (pointerSwitches === 2) {
                    for (const item of SMALL) {
                        expect((await lstat(join(setup.destination, item))).isSymbolicLink()).toBe(true);
                    }
                    observedBeforeActivation.push(await text(setup.destination, 'stocks-issuers.json'));
                    observedBeforeActivation.push(await text(setup.destination, 'cards/version.txt'));
                }
            }
            return fs.rename(from, to);
        };

        await publishRelease({ ...setup, fsOps: { rename } });
        expect(pointerSwitches).toBe(2);
        expect(observedBeforeActivation).toEqual(['old:stocks-issuers.json', 'old']);
        await expect(text(setup.destination, 'stocks-issuers.json')).resolves.toBe('new:stocks-issuers.json');
    });

    test('a second publish switches every alias through one pointer and preserves runtime files', async () => {
        const setup = await fixture(); ({ root } = setup);
        await writeFile(join(setup.destination, 'stocks-trades.json'), 'runtime');
        await publishRelease(setup);
        const pointer = await fs.readlink(join(setup.destination, '.rwa-release-current'));
        await writeRelease(setup.source, 'newer', SMALL);
        await publishRelease(setup);
        expect(await fs.readlink(join(setup.destination, '.rwa-release-current'))).not.toBe(pointer);
        for (const item of ['stocks-issuers.json', 'stocks-tokens.json', 'stocks-graph.json', 'stocks/data/history/version.txt', 'cards/version.txt', 'templates/version.txt']) expect(await text(setup.destination, item)).toContain('newer');
        await expect(text(setup.destination, 'stocks-trades.json')).resolves.toBe('runtime');
    });

    test('tampered or incomplete evidence is rejected before activation', async () => {
        const setup = await fixture(); ({ root } = setup);
        await writeFile(join(setup.source, 'release-evidence.json'), JSON.stringify({ artifacts: [] }));
        await expect(publishRelease(setup)).rejects.toThrow(/complete manifest/);
        await expect(text(setup.destination, SMALL[1])).resolves.toBe(`old:${SMALL[1]}`);
    });

    test('rejects a nested source/destination pair before staging anything', async () => {
        const setup = await fixture(); ({ root } = setup);
        const nested = join(setup.source, 'docroot'); await mkdir(nested);
        await expect(publishRelease({ source: setup.source, destination: nested, artifacts: SMALL })).rejects.toThrow(/separate, non-nested/);
    });

    test('the manifest seam refuses a manifest that does not start with the evidence record', async () => {
        const setup = await fixture(); ({ root } = setup);
        await expect(publishRelease({ ...setup, artifacts: SMALL.slice(1) })).rejects.toThrow(/must start with release-evidence\.json/);
    });

    test('resolves a Linux-style docroot symlink before staging', async () => {
        const setup = await fixture(); ({ root } = setup);
        const link = join(setup.root, 'current');
        await symlink(setup.destination, link);
        await expect(publishRelease({ source: setup.source, destination: link, artifacts: SMALL })).resolves.toEqual({ artifacts: SMALL.length, pruned: 0 });
        await expect(text(setup.destination, 'stocks-issuers.json')).resolves.toBe('new:stocks-issuers.json');
    });
});

describe('generationsToPrune', () => {
    const names = ['release-100-1', 'release-400-1', 'release-legacy-50-9', '.staging-abc', 'release-300-2', 'release-200-1'];

    test('keeps the newest N, never the legacy set or a staging directory', () => {
        expect(generationsToPrune(names, { keep: 2 }).sort()).toEqual(['release-100-1', 'release-200-1']);
    });

    test('never prunes the current or previous generation, however old', () => {
        expect(generationsToPrune(names, { keep: 1, current: 'release-100-1', previous: 'release-200-1' })).toEqual(['release-300-2']);
    });
});
