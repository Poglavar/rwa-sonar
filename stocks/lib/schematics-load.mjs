// Node-side loader for the schematics: reads the curated step lists, the what-if catalogue and each
// built issuer's dossier, and returns stocks/lib/schematics.js's buildSchematics() output. Shared by
// build-schematics.mjs (the browser file), build-legal-templates.mjs (issuer pages) and
// build-cards.mjs (compact card figures), so all three draw from one computation of the same data.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { byString, logWarn, readJson } from './io.mjs';
import { dossierFileFor } from './issuer-whatif.mjs';
import schematics from './schematics.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data');

/** Every built issuer slug -> its dossier object, resolved the same way the card builder does. */
export async function readDossiers(dir, slugs) {
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort(byString);
    const dossiers = new Map();
    for (const slug of slugs) {
        const file = dossierFileFor(slug, files);
        if (file === null) {
            logWarn(`no dossier file for issuer "${slug}" — no relationship map or what-if sequence for it`);
            continue;
        }
        dossiers.set(slug, await readJson(join(dir, file)));
    }
    return dossiers;
}

/**
 * `issuers` are the built issuer records (slug + name). Returns {version, keyModes, issuers, defi};
 * `curatedFile` overrides stocks/data/schematics.json for tests.
 */
export async function loadSchematics({ issuers, curatedFile = join(DATA_DIR, 'schematics.json'), dataDir = DATA_DIR } = {}) {
    const list = Array.isArray(issuers) ? issuers : [];
    const names = Object.fromEntries(list.map((issuer) => [issuer.slug, issuer.name]));
    const curated = await readJson(curatedFile);
    const catalogue = await readJson(join(dataDir, 'trust-chain.json'));
    const dossiers = await readDossiers(join(dataDir, 'issuers'), list.map((issuer) => issuer.slug));
    return schematics.buildSchematics({ curated, dossiers, catalogue, names });
}
