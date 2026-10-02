// Exercises deterministic artifact hashes and failure-safe evidence recording in temporary fixtures.
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RELEASE_ARTIFACTS } from './lib/release-manifest.mjs';
import { createReleaseEvidence, hashArtifactFamily } from './release-evidence.mjs';

const ORIGIN = 'https://rwasonar.test';
const json = (value) => `${JSON.stringify(value)}\n`;

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rwa-evidence-'));
    for (const artifact of RELEASE_ARTIFACTS.filter((item) => item !== 'release-evidence.json')) {
        const path = join(root, artifact);
        if (artifact.includes('.') && !artifact.endsWith('history')) {
            await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, json({ artifact }));
        } else {
            await mkdir(path, { recursive: true }); await writeFile(join(path, 'z.json'), json({ artifact })); await writeFile(join(path, 'a.json'), json({ artifact, first: true }));
        }
    }
    await writeFile(join(root, 'stocks-tokens.json'), json({ builtAt: 'tokens-at' }));
    await writeFile(join(root, 'stocks-issuers.json'), json({ builtAt: 'issuers-at' }));
    await writeFile(join(root, 'stocks-discovery.json'), json({ builtAt: 'discovery-at' }));
    await writeFile(join(root, 'stocks-health.json'), json({ generatedAt: 'health-at' }));
    await writeFile(join(root, 'stocks/data/defi-usage.json'), json({ fetchedAt: 'defi-observed-at' }));
    await writeFile(join(root, 'stocks-legal-templates.json'), json({ reviewedAt: 'template-reviewed-at' }));
    await writeFile(join(root, 'stocks-review-queue.json'), json({ generatedAt: 'queue-at' }));
    return root;
}

const validation = async () => ({ tokenCount: 2, cardCount: 2 });
const identity = async () => ({ gitHead: 'a'.repeat(40), dirty: true });

describe('release evidence', () => {
    let root;
    afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

    test('records validated local artifact hashes and preserves distinct build versus observation times', async () => {
        root = await fixture();
        const result = await createReleaseEvidence({ root, baseUrl: ORIGIN, validate: validation, identity, now: () => new Date('2026-09-22T12:00:00Z') });
        expect(result).toMatchObject({ schemaVersion: 1, code: { gitHead: 'a'.repeat(40), dirty: true }, validation: {
            status: 'passed', validatedAt: '2026-09-22T12:00:00.000Z', result: { tokenCount: 2 }
        }, timestamps: { builds: { tokensBuiltAt: 'tokens-at', issuersBuiltAt: 'issuers-at', discoveryBuiltAt: 'discovery-at' }, observations: { defiFetchedAt: 'defi-observed-at', templateReviewedAt: 'template-reviewed-at' } } });
        expect(result.purpose).toMatch(/not evidence of publication/i);
        expect(result.artifacts).toHaveLength(RELEASE_ARTIFACTS.length - 1);
        expect(result.artifacts.find((item) => item.path === 'cards')).toMatchObject({ fileCount: 2, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
        const persisted = JSON.parse(await readFile(join(root, 'release-evidence.json'), 'utf8'));
        expect(persisted.artifacts).toEqual(result.artifacts);
    });

    test('hashes sorted paths and bytes, rejects symlinks, and validation failure preserves prior evidence', async () => {
        root = await fixture();
        const before = await hashArtifactFamily({ root, artifact: 'cards' });
        await writeFile(join(root, 'cards/a.json'), 'changed');
        const after = await hashArtifactFamily({ root, artifact: 'cards' });
        expect(after.fileCount).toBe(before.fileCount);
        expect(after.sha256).not.toBe(before.sha256);
        await writeFile(join(root, 'release-evidence.json'), 'prior record');
        await expect(createReleaseEvidence({ root, baseUrl: ORIGIN, validate: async () => { throw new Error('invalid release'); }, identity }))
            .rejects.toThrow('invalid release');
        await expect(readFile(join(root, 'release-evidence.json'), 'utf8')).resolves.toBe('prior record');
        await symlink('../stocks-tokens.json', join(root, 'cards', 'linked.json'));
        await expect(hashArtifactFamily({ root, artifact: 'cards' })).rejects.toThrow(/symbolic links/);
    });
});
