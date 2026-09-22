import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_ARTIFACTS } from './lib/release-manifest.mjs';
import { publishRelease } from './publish-release.mjs';

const DIRECTORIES = new Set(['stocks/data/history', 'cards', 'templates', 'issuers', 'protocols', 'comparisons']);

async function writeRelease(root, version) {
    for (const item of RELEASE_ARTIFACTS) {
        const path = join(root, item);
        await mkdir(join(path, '..'), { recursive: true });
        if (DIRECTORIES.has(item)) {
            await mkdir(path, { recursive: true });
            await writeFile(join(path, 'version.txt'), version);
        } else {
            await writeFile(path, `${version}:${item}`);
        }
    }
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
        await rm(join(setup.source, 'cards'), { recursive: true });
        await symlink('generated-cards', join(setup.source, 'cards'));
        await writeFile(join(setup.destination, 'stocks-trades.json'), 'runtime tape');

        await expect(publishRelease(setup)).resolves.toEqual({ artifacts: RELEASE_ARTIFACTS.length });
        await expect(text(setup.destination, 'stocks-issuers.json')).resolves.toBe('new:stocks-issuers.json');
        await expect(text(setup.destination, 'stocks-trades.json')).resolves.toBe('runtime tape');
        expect((await lstat(join(setup.destination, 'stocks-graph.json'))).mode & 0o777).toBe(0o640);
        expect((await lstat(join(setup.destination, 'cards'))).isSymbolicLink()).toBe(true);
    });

    test('a staged-to-docroot rename failure restores every old artifact and removes a newly-created one', async () => {
        const setup = await fixture(); ({ root } = setup);
        const newOnly = RELEASE_ARTIFACTS[0];
        await rm(join(setup.destination, newOnly));
        const failSecondInstall = async (from, to) => {
            if (from.includes('.rwa-release-stage-') && to.endsWith(`/${RELEASE_ARTIFACTS[1]}`)) throw new Error('injected install failure');
            return fs.rename(from, to);
        };
        await expect(publishRelease({ ...setup, fsOps: { rename: failSecondInstall } })).rejects.toThrow('injected install failure');
        await expect(lstat(join(setup.destination, newOnly))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(text(setup.destination, RELEASE_ARTIFACTS[1])).resolves.toBe(`old:${RELEASE_ARTIFACTS[1]}`);
        await expect(readFile(join(setup.destination, RELEASE_ARTIFACTS.at(-1), 'version.txt'), 'utf8')).resolves.toBe('old');
    });

    test('a staging copy failure never touches the complete served set', async () => {
        const setup = await fixture(); ({ root } = setup);
        const failCopy = async (from, to, options) => {
            if (from.endsWith(`/${RELEASE_ARTIFACTS[1]}`)) throw new Error('injected copy failure');
            return fs.cp(from, to, options);
        };
        await expect(publishRelease({ ...setup, fsOps: { cp: failCopy } })).rejects.toThrow('injected copy failure');
        await expect(text(setup.destination, RELEASE_ARTIFACTS[0])).resolves.toBe(`old:${RELEASE_ARTIFACTS[0]}`);
        await expect(text(setup.destination, RELEASE_ARTIFACTS[1])).resolves.toBe(`old:${RELEASE_ARTIFACTS[1]}`);
    });

    test('a failed restore retains the old backup and does not leave the new replacement installed', async () => {
        const setup = await fixture(); ({ root } = setup);
        const first = RELEASE_ARTIFACTS[0]; const second = RELEASE_ARTIFACTS[1];
        const injected = async (from, to) => {
            if (from.includes('.rwa-release-stage-') && to.endsWith(`/${second}`)) throw new Error('injected install failure');
            if (from.includes('.rwa-release-backup-') && from.endsWith(`/${first}`) && to.endsWith(`/${first}`)) throw new Error('injected restore failure');
            return fs.rename(from, to);
        };
        let error;
        try { await publishRelease({ ...setup, fsOps: { rename: injected } }); } catch (caught) { error = caught; }
        expect(error?.message).toMatch(/rollback is incomplete; backup retained at/);
        const backup = error.message.match(/backup retained at (.+) \(/)?.[1];
        expect(backup).toBeTruthy();
        await expect(text(backup, first)).resolves.toBe(`old:${first}`);
        await expect(lstat(join(setup.destination, first))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('rejects a nested source/destination pair before staging anything', async () => {
        const setup = await fixture(); ({ root } = setup);
        const nested = join(setup.source, 'docroot'); await mkdir(nested);
        await expect(publishRelease({ source: setup.source, destination: nested })).rejects.toThrow(/separate, non-nested/);
    });

    test('resolves a Linux-style docroot symlink before staging so target renames share its filesystem', async () => {
        const setup = await fixture(); ({ root } = setup);
        const link = join(setup.root, 'current');
        await symlink(setup.destination, link);
        await expect(publishRelease({ source: setup.source, destination: link })).resolves.toEqual({ artifacts: RELEASE_ARTIFACTS.length });
        await expect(text(setup.destination, 'stocks-issuers.json')).resolves.toBe('new:stocks-issuers.json');
    });
});
