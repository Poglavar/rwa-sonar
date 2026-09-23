import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_ARTIFACTS } from './lib/release-manifest.mjs';
import { publishRelease } from './publish-release.mjs';
import { hashArtifactFamily } from './release-evidence.mjs';

const DIRECTORIES = new Set(['stocks/data/history', 'cards', 'templates', 'issuers', 'protocols', 'comparisons']);

async function writeRelease(root, version) {
    for (const item of RELEASE_ARTIFACTS) {
        const path = join(root, item);
        await mkdir(join(path, '..'), { recursive: true });
        if (DIRECTORIES.has(item)) {
            await mkdir(path, { recursive: true });
            await writeFile(join(path, 'version.txt'), version);
        } else if (item !== 'release-evidence.json') {
            await writeFile(path, `${version}:${item}`);
        }
    }
    const artifacts = [];
    for (const item of RELEASE_ARTIFACTS.slice(1)) artifacts.push(await hashArtifactFamily({ root, artifact: item }));
    await writeFile(join(root, 'release-evidence.json'), JSON.stringify({ artifacts }));
}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rwa-publish-test-'));
    const source = join(root, 'source');
    const destination = join(root, 'docroot');
    await mkdir(source); await mkdir(destination);
    await writeRelease(source, 'new'); await writeRelease(destination, 'old');
    return { root, source, destination };
}

async function text(root, item) { return readFile(join(root, item), 'utf8'); }

describe('publishRelease', () => {
    let root;
    afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });

    test('publishes the complete manifest while preserving modes, generated symlinks, and runtime tape outside it', async () => {
        const setup = await fixture(); ({ root } = setup);
        await chmod(join(setup.source, 'stocks-graph.json'), 0o640);
        await writeFile(join(setup.destination, 'stocks-trades.json'), 'runtime tape');

        await expect(publishRelease(setup)).resolves.toEqual({ artifacts: RELEASE_ARTIFACTS.length });
        await expect(text(setup.destination, 'stocks-issuers.json')).resolves.toBe('new:stocks-issuers.json');
        await expect(text(setup.destination, 'stocks-trades.json')).resolves.toBe('runtime tape');
        expect((await stat(join(setup.destination, 'stocks-graph.json'))).mode & 0o777).toBe(0o640);
        expect((await lstat(join(setup.destination, 'cards'))).isSymbolicLink()).toBe(true);
    });

    test('a staging/hash failure leaves the served old generation unchanged', async () => {
        const setup = await fixture(); ({ root } = setup);
        await writeFile(join(setup.source, RELEASE_ARTIFACTS[1]), 'tampered');
        await expect(publishRelease(setup)).rejects.toThrow(/hash mismatch/);
        await expect(text(setup.destination, RELEASE_ARTIFACTS[1])).resolves.toBe(`old:${RELEASE_ARTIFACTS[1]}`);
    });

    test('the first legacy migration installs every alias before exposing the new generation', async () => {
        const setup = await fixture(); ({ root } = setup);
        let pointerSwitches = 0;
        const observedBeforeActivation = [];
        const rename = async (from, to) => {
            if (to.endsWith('/.rwa-release-current')) {
                pointerSwitches += 1;
                if (pointerSwitches === 2) {
                    for (const item of RELEASE_ARTIFACTS) {
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
        await writeRelease(setup.source, 'newer');
        await publishRelease(setup);
        expect(await fs.readlink(join(setup.destination, '.rwa-release-current'))).not.toBe(pointer);
        for (const item of ['stocks-issuers.json', 'stocks-tokens.json', 'stocks-graph.json', 'cards/version.txt', 'templates/version.txt', 'issuers/version.txt', 'protocols/version.txt', 'comparisons/version.txt']) expect(await text(setup.destination, item)).toContain('newer');
        await expect(text(setup.destination, 'stocks-trades.json')).resolves.toBe('runtime');
    });

    test('tampered or incomplete evidence is rejected before activation', async () => {
        const setup = await fixture(); ({ root } = setup);
        await writeFile(join(setup.source, 'release-evidence.json'), JSON.stringify({ artifacts: [] }));
        await expect(publishRelease(setup)).rejects.toThrow(/complete manifest/);
        await expect(text(setup.destination, RELEASE_ARTIFACTS[1])).resolves.toBe(`old:${RELEASE_ARTIFACTS[1]}`);
    });

    test('rejects a nested source/destination pair before staging anything', async () => {
        const setup = await fixture(); ({ root } = setup);
        const nested = join(setup.source, 'docroot'); await mkdir(nested);
        await expect(publishRelease({ source: setup.source, destination: nested })).rejects.toThrow(/separate, non-nested/);
    });

    test('resolves a Linux-style docroot symlink before staging', async () => {
        const setup = await fixture(); ({ root } = setup);
        const link = join(setup.root, 'current');
        await symlink(setup.destination, link);
        await expect(publishRelease({ source: setup.source, destination: link })).resolves.toEqual({ artifacts: RELEASE_ARTIFACTS.length });
        await expect(text(setup.destination, 'stocks-issuers.json')).resolves.toBe('new:stocks-issuers.json');
    });
});
