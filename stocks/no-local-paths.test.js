// Published files must not carry absolute local paths (a home directory names its owner).
// Markdown, tests and agent notes are not published, so they are skipped.
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const LOCAL_PATH = /\/(Users|home)\/[a-z][\w.-]*\//;

function publishedFiles() {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .filter((file) => !/\.(md|test\.js|test\.mjs)$/.test(file))
        .filter((file) => /\.(html|js|mjs|json|svg|txt|xml|css)$/.test(file))
        .filter((file) => !file.startsWith('video/'));
}

describe('published files', () => {
    it('contain no absolute local paths', () => {
        const hits = [];
        for (const file of publishedFiles()) {
            let text;
            try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
            const match = text.match(LOCAL_PATH);
            if (match) hits.push(`${file}: ${match[0]}`);
        }
        expect(hits).toEqual([]);
    });
});
