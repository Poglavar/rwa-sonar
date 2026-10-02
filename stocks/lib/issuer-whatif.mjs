// Reads each issuer's what-if answers from its dossier file (stocks/data/issuers/*.json). Shared by
// build-cards.mjs (the answers on every card) and build-legal-templates.mjs (the counts and links
// on every issuer dossier page), so both resolve an issuer slug to the same file.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { byString, logWarn, readJson } from './io.mjs';

/**
 * The dossier file that belongs to an issuer slug. Three of the twelve dossiers are filed under a
 * token-suffixed name (`bullish-blsh.json` for `bullish`), so the rule is: the exact name first,
 * then the one file whose name is the slug plus a suffix. Derived rather than typed, so a new
 * issuer needs no map entry — and an AMBIGUOUS prefix returns null and is warned about rather than
 * resolved by guessing, because the wrong dossier would put another issuer's answers on this card.
 */
export function dossierFileFor(slug, files) {
    if (files.includes(`${slug}.json`)) return `${slug}.json`;
    const prefixed = files.filter((name) => name.startsWith(`${slug}-`));
    return prefixed.length === 1 ? prefixed[0] : null;
}

/**
 * One issuer slug -> its dossier's `whatIf[]`. The answers are the one part of a dossier that
 * stocks-issuers.json deliberately does not carry (EVIDENCE.md §6.4: they are prose with quotes and
 * case citations, and the API serves them), so the builders read the dossiers directly.
 */
export async function readWhatIf(dir, slugs) {
    const index = new Map();
    let files = [];
    try {
        files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort(byString);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        logWarn(`${dir} is not there, so no what-if answer can be shown`);
        return index;
    }
    for (const slug of slugs) {
        const file = dossierFileFor(slug, files);
        if (file === null) {
            logWarn(`no dossier file for issuer "${slug}" — its 38 questions show as unanswered`);
            continue;
        }
        const dossier = await readJson(join(dir, file), null);
        index.set(slug, Array.isArray(dossier?.whatIf) ? dossier.whatIf : []);
    }
    return index;
}
