// Where tests read the catalogue from. The runtime data files (stocks-tokens.json, stocks-issuers.json,
// stocks/data/venues.json…) are written by the prod jobs and no longer tracked in git, so a local sync
// or refresh never changes what a test sees. test-fixtures/catalogue/ is a frozen copy, under the same
// relative paths, of the files as they were when they stopped being tracked (commit dd3dfdc).
// CommonJS so both the .test.js (require) and the .test.mjs (import) files can use it.
const fs = require('fs');
const path = require('path');

const FIXTURE_ROOT = path.join(__dirname, 'catalogue');

/** The frozen copy of a runtime data file, by its path from the repo root ('stocks-tokens.json'). */
function fixture(relativePath) {
    return path.join(FIXTURE_ROOT, relativePath);
}

/**
 * For a test's generic "read a repo file" helper: the frozen copy when the file is job-owned runtime
 * data (a copy exists here), else the file in the repo (a tracked input such as a dossier or
 * stocks/data/composability-templates.json).
 */
function repoFile(repoRoot, ...parts) {
    const relative = path.join(...parts);
    return fs.existsSync(fixture(relative)) ? fixture(relative) : path.join(repoRoot, relative);
}

module.exports = { FIXTURE_ROOT, fixture, repoFile };
