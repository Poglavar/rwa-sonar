// The "control recipe" dimension of a tokenized-stock mint: which token program holds it and which
// of the five control extensions are switched on, as a sorted list plus one display label. Split out
// of lib/grade.mjs (which is already the long file of scoring rules) because three callers group by
// it — the per-token record, the per-issuer `recipes` tally and lib/funnel.mjs — and a label that is
// spelled two ways is two recipes. Pure, no I/O, unit-tested in ../recipe.test.js.

import { tokenProgramName } from './classify.mjs';

/**
 * Canonical extension order, which is also how every label reads. Deliberately NOT alphabetical:
 * the label is a fixed sentence about the mint (the flag nearly every issuer holds first, the rarest
 * last), so two mints with the same switches always produce the same string and therefore the same
 * recipe. Adding a flag means appending to this list, never re-sorting it.
 */
export const RECIPE_EXTENSIONS = ['pausable', 'clawback', 'allowlist', 'transfer-fee', 'transfer-hook'];

/** Programs a recipe can name. Anything else is 'unknown' rather than a guess. */
export const RECIPE_PROGRAMS = ['token-2022', 'spl-token'];

/** The control fields a recipe reads. One of them being known makes the recipe knowable. */
const CONTROL_KEYS = ['pausable', 'clawback', 'allowlist', 'transferFeeBps', 'hookActive'];

/** Label for a mint whose control block has not been read from the chain yet. */
export const UNKNOWN_RECIPE_LABEL = 'unknown';

/** Label suffix for a mint on a known program with none of the five extensions on. */
export const NO_EXTENSIONS = 'none';

/** 'token-2022' | 'spl-token' | 'unknown', from a raw program id or an already-mapped name. */
export function recipeProgram(tokenProgram) {
    const name = tokenProgramName(tokenProgram);
    return RECIPE_PROGRAMS.includes(name) ? name : 'unknown';
}

/**
 * True when at least one control flag was actually read. A record whose flags are all null is a
 * mint we have not profiled yet, which is not the same fact as a mint with no extensions — the
 * first gets the 'unknown' label, the second gets '… · none'.
 */
export function controlKnown(control) {
    if (!control || typeof control !== 'object') return false;
    return CONTROL_KEYS.some((key) => control[key] !== null && control[key] !== undefined);
}

/**
 * The recipe of one token record (stocks-tokens.json shape: `{tokenProgram, control}`).
 *
 * `allowlist` is the default-frozen account state (a new wallet must be onboarded before it can
 * hold the token) and `clawback` is the permanent delegate (the issuer can move the token out of
 * any wallet). `transfer-fee` is ON whenever the fee extension is installed, including at 0 bps:
 * a recipe is what the issuer can technically do, and a configured 0 bps still reserves the right
 * to charge — the same reading the issuer card's Fee badge gives. `transfer-hook` is a hook
 * actually installed, not merely configured with an empty program.
 */
export function controlRecipe(token) {
    const program = recipeProgram(token?.tokenProgram ?? null);
    const control = token?.control ?? null;

    if (!controlKnown(control)) {
        return { program, extensions: [], label: UNKNOWN_RECIPE_LABEL };
    }

    const on = {
        pausable: control.pausable === true,
        clawback: control.clawback === true,
        allowlist: control.allowlist === true,
        'transfer-fee': Number.isFinite(control.transferFeeBps),
        'transfer-hook': control.hookActive === true
    };
    const extensions = RECIPE_EXTENSIONS.filter((name) => on[name]);

    return {
        program,
        extensions,
        label: `${program} · ${extensions.length ? extensions.join(' + ') : NO_EXTENSIONS}`
    };
}

/**
 * Distinct recipes across a list of token records, with a mint count each: the per-issuer
 * `recipes: [{label, mints}]` of stocks-issuers.json. Sorted by mints desc then label, so a rebuild
 * of unchanged inputs produces an unchanged file. The counts always sum to the list's length —
 * every mint has exactly one recipe, even when that recipe is 'unknown'.
 */
export function recipeTally(tokens) {
    const counts = new Map();
    for (const token of Array.isArray(tokens) ? tokens : []) {
        if (!token || typeof token !== 'object') continue;
        const { label } = token.recipe && typeof token.recipe.label === 'string'
            ? token.recipe
            : controlRecipe(token);
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([label, mints]) => ({ label, mints }))
        .sort((a, b) => b.mints - a.mints || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
