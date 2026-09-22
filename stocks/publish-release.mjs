#!/usr/bin/env node
// This is a staged, rollback-capable replacement of the generated release families. It is not a
// whole-docroot atomic switch: each final rename is atomic, but clients can observe a mixed set
// between artifact-family renames. Runtime-owned files outside RELEASE_ARTIFACTS are untouched.
import * as nativeFs from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs, log, logError } from './lib/io.mjs';
import { RELEASE_ARTIFACTS } from './lib/release-manifest.mjs';

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

function rollbackError(original, backup, failures) {
    const detail = failures.map(({ item, error }) => `${item}: ${error.message ?? error}`).join('; ');
    return new Error(`publication failed and rollback is incomplete; backup retained at ${backup} (${detail})`, { cause: original });
}

/**
 * Publishes the manifest using per-artifact atomic renames. `fsOps` is an internal test seam;
 * production callers must leave it unset. A rollback failure intentionally retains `backup` for
 * manual recovery rather than deleting the last complete copy.
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
    const stage = await fs.mkdtemp(join(parent, '.rwa-release-stage-'));
    const backup = await fs.mkdtemp(join(parent, '.rwa-release-backup-'));
    const transactions = [];
    let rollbackComplete = true;
    try {
        // cp keeps modes and symbolic links by default. `verbatimSymlinks` avoids resolving a
        // generated relative link against this temporary staging directory.
        for (const item of RELEASE_ARTIFACTS) {
            const from = join(src, item);
            if (!await exists(fs, from)) throw new Error(`required release artifact is missing: ${item}`);
            await fs.mkdir(dirname(join(stage, item)), { recursive: true });
            await fs.cp(from, join(stage, item), { recursive: true, force: true, verbatimSymlinks: true });
        }
        for (const item of RELEASE_ARTIFACTS) {
            const target = join(dest, item);
            const staged = join(stage, item);
            const saved = join(backup, item);
            const tx = { item, target, saved, backedUp: false, installed: false };
            transactions.push(tx);
            await fs.mkdir(dirname(target), { recursive: true });
            if (await exists(fs, target)) {
                await fs.mkdir(dirname(saved), { recursive: true });
                await fs.rename(target, saved);
                tx.backedUp = true;
            }
            await fs.rename(staged, target);
            tx.installed = true;
        }
    } catch (error) {
        const failures = [];
        for (const tx of transactions.reverse()) {
            try {
                // Remove the newly installed item before restoring the old one. This also removes
                // newly-created artifacts that had no predecessor.
                if (tx.installed && await exists(fs, tx.target)) await fs.rm(tx.target, { recursive: true, force: true });
                if (tx.backedUp && await exists(fs, tx.saved)) await fs.rename(tx.saved, tx.target);
            } catch (restoreError) {
                rollbackComplete = false;
                failures.push({ item: tx.item, error: restoreError });
            }
        }
        if (!rollbackComplete) throw rollbackError(error, backup, failures);
        throw error;
    } finally {
        await fs.rm(stage, { recursive: true, force: true });
        // Never delete a backup which could be the only remaining complete prior artifact.
        if (rollbackComplete) await fs.rm(backup, { recursive: true, force: true });
    }
    return { artifacts: RELEASE_ARTIFACTS.length };
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run || !flags.source || !flags.destination) throw new Error('usage: --run --source=<repo> --destination=<docroot>');
    const result = await publishRelease({ source: flags.source, destination: flags.destination });
    log(`published staged release (${result.artifacts} artifact families; per-artifact atomic, not a whole-release atomic switch)`);
}
if (import.meta.filename === process.argv[1]) main().catch((error) => { logError(error.stack ?? String(error)); process.exit(1); });
