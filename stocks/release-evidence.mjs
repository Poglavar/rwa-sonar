#!/usr/bin/env node
// Records a locally validated release candidate. This is evidence about local artifacts only; it
// never asserts that a docroot mirror, cache purge, or public endpoint was successfully served.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs, log, logError } from './lib/io.mjs';
import { RELEASE_ARTIFACTS } from './lib/release-manifest.mjs';
import { validateRelease } from './validate-release.mjs';

const run = promisify(execFile);
const RECORD = 'release-evidence.json';
const HASHED_ARTIFACTS = RELEASE_ARTIFACTS.filter((item) => item !== RECORD);

function safeRelative(path) {
    return !path.startsWith(`..${sep}`) && path !== '..' && !path.includes('\0');
}

async function regularFile(path, label) {
    const state = await lstat(path);
    if (state.isSymbolicLink()) throw new Error(`${label}: symbolic links are not accepted in release evidence`);
    if (!state.isFile()) throw new Error(`${label}: expected a regular file`);
    return state;
}

async function familyFiles(root, artifact) {
    const source = join(root, artifact);
    const state = await lstat(source);
    if (state.isSymbolicLink()) throw new Error(`${artifact}: symbolic links are not accepted in release evidence`);
    if (state.isFile()) return [artifact];
    if (!state.isDirectory()) throw new Error(`${artifact}: expected a regular file or directory`);
    const files = [];
    async function visit(directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const full = join(directory, entry.name);
            const rel = relative(root, full);
            if (!safeRelative(rel)) throw new Error(`${artifact}: unsafe nested path`);
            if (entry.isSymbolicLink()) throw new Error(`${rel}: symbolic links are not accepted in release evidence`);
            if (entry.isDirectory()) await visit(full);
            else if (entry.isFile()) files.push(rel);
            else throw new Error(`${rel}: unsupported non-file release input`);
        }
    }
    await visit(source);
    return files.sort((a, b) => a.localeCompare(b));
}

export async function hashArtifactFamily({ root, artifact }) {
    const files = await familyFiles(root, artifact);
    const digest = createHash('sha256');
    for (const file of files) {
        await regularFile(join(root, file), file);
        const bytes = await readFile(join(root, file));
        digest.update(file.replaceAll(sep, '/'));
        digest.update('\0');
        digest.update(bytes);
        digest.update('\0');
    }
    return { path: artifact, fileCount: files.length, sha256: digest.digest('hex') };
}

async function jsonAt(root, path) {
    return JSON.parse(await readFile(join(root, path), 'utf8'));
}

async function codeIdentity(root) {
    const [{ stdout: gitHead }, { stdout: porcelain }] = await Promise.all([
        run('git', ['-C', root, 'rev-parse', 'HEAD']),
        run('git', ['-C', root, 'status', '--porcelain'])
    ]);
    return { gitHead: gitHead.trim(), dirty: porcelain.trim() !== '' };
}

async function timestamps(root) {
    const [tokens, issuers, discovery, health, defi, templates, queue] = await Promise.all([
        jsonAt(root, 'stocks-tokens.json'), jsonAt(root, 'stocks-issuers.json'), jsonAt(root, 'stocks-discovery.json'),
        jsonAt(root, 'stocks-health.json'), jsonAt(root, 'stocks/data/defi-usage.json'),
        jsonAt(root, 'stocks-legal-templates.json'), jsonAt(root, 'stocks-review-queue.json')
    ]);
    return {
        builds: { tokensBuiltAt: tokens.builtAt ?? null, issuersBuiltAt: issuers.builtAt ?? null,
            discoveryBuiltAt: discovery.builtAt ?? null, healthGeneratedAt: health.generatedAt ?? null,
            reviewQueueGeneratedAt: queue.generatedAt ?? null },
        observations: { defiFetchedAt: defi.fetchedAt ?? null, templateReviewedAt: templates.reviewedAt ?? null }
    };
}

/** Validate first, hash the declared families, then atomically replace only this local record. */
export async function createReleaseEvidence({ root, baseUrl, now = () => new Date(), validate = validateRelease, identity = codeIdentity } = {}) {
    const releaseRoot = resolve(root ?? join(import.meta.dirname, '..'));
    const validation = await validate({ root: releaseRoot, baseUrl });
    const [artifacts, code, sourceTimes] = await Promise.all([
        Promise.all(HASHED_ARTIFACTS.map((artifact) => hashArtifactFamily({ root: releaseRoot, artifact }))),
        identity(releaseRoot), timestamps(releaseRoot)
    ]);
    const record = {
        schemaVersion: 1,
        purpose: 'local validated release candidate; not evidence of publication or public availability',
        validation: { status: 'passed', validatedAt: now().toISOString(), result: validation },
        code,
        timestamps: sourceTimes,
        artifacts
    };
    const output = join(releaseRoot, RECORD);
    const temporary = join(dirname(output), `.${RECORD}.${process.pid}.${Date.now()}.tmp`);
    try {
        await mkdir(dirname(output), { recursive: true });
        await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
        await rename(temporary, output);
    } finally { await rm(temporary, { force: true }); }
    return record;
}

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.run) { console.log('node stocks/release-evidence.mjs --run --base-url=https://rwasonar.com'); return; }
    const record = await createReleaseEvidence({ root: join(import.meta.dirname, '..'), baseUrl: flags['base-url'] });
    log(`recorded local validation evidence for ${record.artifacts.length} artifact families at ${record.validation.validatedAt}`);
}
if (import.meta.filename === process.argv[1]) main().catch((error) => { logError(error.stack ?? String(error)); process.exit(1); });
