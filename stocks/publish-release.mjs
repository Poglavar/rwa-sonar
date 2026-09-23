#!/usr/bin/env node
// Publishes the declared generated-data families through one generation pointer. This is not a
// whole-docroot switch: ordinary site assets and runtime-owned files remain outside this boundary.
import * as nativeFs from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs, log, logError } from './lib/io.mjs';
import { RELEASE_ARTIFACTS } from './lib/release-manifest.mjs';
import { hashArtifactFamily } from './release-evidence.mjs';

// mkdtemp creates 0700 directories. A generation is served through symlinks, so the web server
// (a different user) must be able to traverse it; 0700 made every generated file 'permission
// denied' on rwasonar.com on 2026-09-23.
const GENERATION_MODE = 0o755;

function isInside(parent, child) {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel));
}

function safeArtifact(item) {
    if (typeof item !== 'string' || item === '' || isAbsolute(item)) return false;
    const rel = relative('.', item);
    return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

async function exists(fs, path) {
    try { await fs.lstat(path); return true; } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

async function assertDirectory(fs, path, name) {
    let state;
    try { state = await fs.stat(path); } catch (error) {
        throw new Error(`${name} does not exist or is inaccessible: ${path}`, { cause: error });
    }
    if (!state.isDirectory()) throw new Error(`${name} must be a directory: ${path}`);
}

async function readPointer(fs, pointer) {
    if (!await exists(fs, pointer)) return null;
    const state = await fs.lstat(pointer);
    if (!state.isSymbolicLink()) throw new Error(`release pointer must be a symlink: ${pointer}`);
    return fs.readlink(pointer);
}

async function switchPointer(fs, pointer, target) {
    const link = `${pointer}.next-${process.pid}`;
    await fs.rm(link, { recursive: true, force: true });
    await fs.symlink(target, link);
    await fs.rename(link, pointer);
}

async function installAlias(fs, target, pointerTarget) {
    const desired = pointerTarget;
    try {
        if ((await fs.lstat(target)).isSymbolicLink() && await fs.readlink(target) === desired) return;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(dirname(target), { recursive: true });
    const link = `${target}.next-${process.pid}`;
    await fs.rm(link, { recursive: true, force: true });
    await fs.symlink(desired, link);
    try {
        await fs.rename(link, target);
    } catch (error) {
        // POSIX can replace a file or symlink atomically, but not a non-empty directory. Moving a
        // legacy directory aside is safe here because the pointer still serves its byte-identical
        // frozen copy; no new-generation data is visible until the later pointer switch.
        const state = await fs.lstat(target).catch(() => null);
        if (!state?.isDirectory() || state.isSymbolicLink()) throw error;
        const backup = `${target}.legacy-${process.pid}`;
        await fs.rename(target, backup);
        try {
            await fs.rename(link, target);
            await fs.rm(backup, { recursive: true, force: true });
        } catch (installError) {
            if (!await exists(fs, target) && await exists(fs, backup)) await fs.rename(backup, target);
            throw installError;
        }
    }
}

async function prepareAliases(fs, dest, generations, pointer) {
    let current = await readPointer(fs, pointer);
    if (current === null) {
        const present = [];
        for (const item of RELEASE_ARTIFACTS) present.push(await exists(fs, join(dest, item)));
        const count = present.filter(Boolean).length;
        if (count !== 0 && count !== RELEASE_ARTIFACTS.length) {
            throw new Error('existing destination has an incomplete legacy release; refusing non-atomic migration');
        }
        if (count === RELEASE_ARTIFACTS.length) {
            const legacyStage = await fs.mkdtemp(join(generations, '.legacy-staging-'));
            await fs.chmod(legacyStage, GENERATION_MODE);
            for (const item of RELEASE_ARTIFACTS) {
                await fs.mkdir(dirname(join(legacyStage, item)), { recursive: true });
                await fs.cp(join(dest, item), join(legacyStage, item), {
                    recursive: true, force: true, verbatimSymlinks: true
                });
            }
            current = join(generations, `release-legacy-${Date.now()}-${process.pid}`);
            await fs.rename(legacyStage, current);
            await switchPointer(fs, pointer, current);
        }
    }
    if (current !== null) {
        for (const item of RELEASE_ARTIFACTS) await installAlias(fs, join(dest, item), join(pointer, item));
    }
    return current;
}

/**
 * Publishes the manifest through one generation pointer. Runtime-owned files outside the manifest
 * are never touched. `fsOps` is an internal test seam; production callers must leave it unset.
 */
export async function publishRelease({ source, destination, fsOps = null } = {}) {
    const fs = { ...nativeFs, ...(fsOps ?? {}) };
    const sourcePath = resolve(source ?? '');
    const destinationPath = resolve(destination ?? '');
    if (!source || !destination) throw new Error('source and destination are required');
    if (!RELEASE_ARTIFACTS.every(safeArtifact)) throw new Error('release manifest contains an unsafe artifact path');
    await assertDirectory(fs, sourcePath, 'source');
    await assertDirectory(fs, destinationPath, 'destination');
    // A Linux docroot is often a symlink (`current` → a release volume). Stage alongside the
    // resolved target, otherwise a rename can cross filesystems and lose its atomic guarantee.
    const src = await fs.realpath(sourcePath);
    const dest = await fs.realpath(destinationPath);
    if (src === dest || isInside(src, dest) || isInside(dest, src)) throw new Error('source and destination must be separate, non-nested directories');

    const parent = dirname(dest);
    const generations = join(parent, '.rwa-release-generations');
    const pointer = join(dest, '.rwa-release-current');
    await fs.mkdir(generations, { recursive: true });
    const generation = await fs.mkdtemp(join(generations, '.staging-'));
    await fs.chmod(generation, GENERATION_MODE);
    const evidence = JSON.parse(await fs.readFile(join(src, 'release-evidence.json'), 'utf8'));
    if (!Array.isArray(evidence.artifacts)) throw new Error('release-evidence.json has no artifact hashes');
    const expected = new Map(evidence.artifacts.map((item) => [item.path, item]));
    if (expected.size !== RELEASE_ARTIFACTS.length - 1 || RELEASE_ARTIFACTS.slice(1).some((item) => !expected.has(item))) {
        throw new Error('release evidence does not cover the complete manifest');
    }
    try {
        for (const item of RELEASE_ARTIFACTS) {
            const from = join(src, item);
            if (!await exists(fs, from)) throw new Error(`required release artifact is missing: ${item}`);
            if (item === 'release-evidence.json') continue;
            await fs.mkdir(dirname(join(generation, item)), { recursive: true });
            await fs.cp(from, join(generation, item), { recursive: true, force: true, verbatimSymlinks: true });
            const actual = await hashArtifactFamily({ root: generation, artifact: item });
            const want = expected.get(item);
            if (actual.fileCount !== want.fileCount || actual.sha256 !== want.sha256) throw new Error(`artifact hash mismatch: ${item}`);
        }
        await fs.cp(join(src, 'release-evidence.json'), join(generation, 'release-evidence.json'));
        const next = join(generations, `release-${Date.now()}-${process.pid}`);
        await fs.rename(generation, next);
        const previous = await prepareAliases(fs, dest, generations, pointer);
        if (previous === null) {
            // A pristine destination has no older release to preserve. Point it at the complete
            // verified generation before installing aliases, then every first read is complete.
            await switchPointer(fs, pointer, next);
            for (const item of RELEASE_ARTIFACTS) await installAlias(fs, join(dest, item), join(pointer, item));
        } else {
            // Every alias still resolves to the complete old generation until this one rename.
            await switchPointer(fs, pointer, next);
        }
        try {
            for (const item of RELEASE_ARTIFACTS.slice(1)) {
                // Hash the immutable generation itself; docroot aliases are only a routing layer.
                const actual = await hashArtifactFamily({ root: next, artifact: item });
                const want = expected.get(item);
                if (actual.fileCount !== want.fileCount || actual.sha256 !== want.sha256) throw new Error(`active artifact hash mismatch: ${item}`);
            }
        } catch (error) {
            if (previous !== null) await switchPointer(fs, pointer, previous);
            throw error;
        }
    } catch (error) {
        await fs.rm(generation, { recursive: true, force: true });
        throw error;
    } finally {
        // Generations are intentionally retained for rollback/recovery.
    }
    return { artifacts: RELEASE_ARTIFACTS.length };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run || !flags.source || !flags.destination) throw new Error('usage: --run --source=<repo> --destination=<docroot>');
    const result = await publishRelease({ source: flags.source, destination: flags.destination });
    log(`published staged release (${result.artifacts} artifact families; atomic generation pointer)`);
}
if (import.meta.filename === process.argv[1]) main().catch((error) => { logError(error.stack ?? String(error)); process.exit(1); });
