// The public research report embeds the latest monitor state, so a clean release build needs no
// runtime observation file and must not manufacture one as a side effect.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');

describe('shared RWA research release builder', () => {
    let root;
    afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

    test('builds with empty watcher input and does not create a raw observations file', async () => {
        root = await mkdtemp(join(tmpdir(), 'rwa-research-release-'));
        await mkdir(join(root, 'rwa/data'), { recursive: true });
        await mkdir(join(root, 'stocks/data/issuers'), { recursive: true });
        const curated = JSON.parse(await readFile(join(ROOT, 'rwa/data/research.json'), 'utf8'));
        await writeFile(join(root, 'rwa/data/research.json'), JSON.stringify(curated));
        await writeFile(join(root, 'stocks-issuers.json'), JSON.stringify({ issuers: [] }));
        await writeFile(join(root, 'stocks-tokens.json'), JSON.stringify({ tokens: [] }));

        await execFileAsync(process.execPath, [join(ROOT, 'rwa/build-research.mjs'), '--run', `--root=${root}`]);

        const report = JSON.parse(await readFile(join(root, 'rwa-research.json'), 'utf8'));
        expect(report.monitoringRecords).toEqual({});
        expect(report.counts.configuredMonitors).toBe(0);
        expect(report.counts.publicProductReviews).toBe(curated.products.length);
        await expect(readFile(join(root, 'rwa/data/deployment-observations.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
