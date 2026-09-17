// Unit tests for stocks/lib/recipe.mjs — the control-recipe dimension. The control blocks below are
// copies of real stocks-tokens.json records, one per recipe actually found on chain on 2026-09-17,
// so a change in the rules shows up here as a change in a label a reader of the funnel would see.
// The two cases that must never be confused are also pinned: a mint we have not read yet ('unknown')
// against a mint on a known program with nothing switched on ('… · none').

import {
    NO_EXTENSIONS,
    RECIPE_EXTENSIONS,
    UNKNOWN_RECIPE_LABEL,
    controlKnown,
    controlRecipe,
    recipeProgram,
    recipeTally
} from './lib/recipe.mjs';

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** A profiled Token-2022 mint with every flag off; each test turns on only what it is about. */
function token(control = {}, tokenProgram = 'token-2022') {
    return {
        tokenProgram,
        control: {
            clawback: false,
            freezeAuthority: null,
            pausable: false,
            paused: false,
            allowlist: false,
            transferFeeBps: null,
            hookActive: false,
            ...control
        }
    };
}

describe('recipeProgram', () => {
    it('maps the two raw program ids to their names', () => {
        expect(recipeProgram(TOKEN_2022)).toBe('token-2022');
        expect(recipeProgram(SPL_TOKEN)).toBe('spl-token');
    });

    it('passes an already-mapped name through, because both shapes reach it', () => {
        expect(recipeProgram('token-2022')).toBe('token-2022');
        expect(recipeProgram('spl-token')).toBe('spl-token');
    });

    it('folds anything else into unknown rather than guessing', () => {
        expect(recipeProgram('SomeOtherProgram1111111111111111111111111111')).toBe('unknown');
        expect(recipeProgram(null)).toBe('unknown');
        expect(recipeProgram(undefined)).toBe('unknown');
    });
});

describe('the six recipes found on chain', () => {
    it('Ondo: pausable only', () => {
        // 123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo (AAPLon), 230 mints.
        const recipe = controlRecipe(token({
            pausable: true,
            freezeAuthority: '51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK'
        }));
        expect(recipe).toEqual({
            program: 'token-2022',
            extensions: ['pausable'],
            label: 'token-2022 · pausable'
        });
    });

    it('xStocks and Backpack: pausable plus a permanent delegate', () => {
        const recipe = controlRecipe(token({ pausable: true, clawback: true }));
        expect(recipe.extensions).toEqual(['pausable', 'clawback']);
        expect(recipe.label).toBe('token-2022 · pausable + clawback');
    });

    it('PreStocks: pausable, delegate and a 50 bps transfer fee', () => {
        const recipe = controlRecipe(token({ pausable: true, clawback: true, transferFeeBps: 50 }));
        expect(recipe.extensions).toEqual(['pausable', 'clawback', 'transfer-fee']);
        expect(recipe.label).toBe('token-2022 · pausable + clawback + transfer-fee');
    });

    it('Superstate: allowlist (default-frozen) and a delegate, but not pausable', () => {
        const recipe = controlRecipe(token({ clawback: true, allowlist: true }));
        expect(recipe.extensions).toEqual(['clawback', 'allowlist']);
        expect(recipe.label).toBe('token-2022 · clawback + allowlist');
    });

    it('Securitize and Bullish: the allowlist line that IS pausable', () => {
        const recipe = controlRecipe(token({ pausable: true, clawback: true, allowlist: true }));
        expect(recipe.extensions).toEqual(['pausable', 'clawback', 'allowlist']);
        expect(recipe.label).toBe('token-2022 · pausable + clawback + allowlist');
    });

    it('Tessera: a 20 bps transfer fee and nothing else', () => {
        const recipe = controlRecipe(token({ transferFeeBps: 20 }));
        expect(recipe.extensions).toEqual(['transfer-fee']);
        expect(recipe.label).toBe('token-2022 · transfer-fee');
    });
});

describe('what a recipe does and does not read', () => {
    it('labels a profiled mint with nothing on as "none", not as unknown', () => {
        const recipe = controlRecipe(token());
        expect(recipe.extensions).toEqual([]);
        expect(recipe.label).toBe(`token-2022 · ${NO_EXTENSIONS}`);
        expect(recipe.label).not.toBe(UNKNOWN_RECIPE_LABEL);
    });

    it('counts a 0 bps transfer fee as the extension being installed', () => {
        // A configured 0 bps still reserves the right to charge, which is what a recipe reports.
        expect(controlRecipe(token({ transferFeeBps: 0 })).extensions).toEqual(['transfer-fee']);
        expect(controlRecipe(token({ transferFeeBps: null })).extensions).toEqual([]);
    });

    it('ignores a freeze authority and a paused flag, which are not extensions', () => {
        const recipe = controlRecipe(token({ freezeAuthority: 'FrEeZe1111111111111111111111111111111111111', paused: true }));
        expect(recipe.extensions).toEqual([]);
    });

    it('reports a hook only when one is actually installed', () => {
        expect(controlRecipe(token({ hookActive: true })).extensions).toEqual(['transfer-hook']);
        expect(controlRecipe(token({ hookActive: false })).extensions).toEqual([]);
    });

    it('always orders the extensions canonically, whatever order the flags arrive in', () => {
        const all = controlRecipe(token({
            hookActive: true, transferFeeBps: 25, allowlist: true, clawback: true, pausable: true
        }));
        expect(all.extensions).toEqual(RECIPE_EXTENSIONS);
        expect(all.label).toBe('token-2022 · pausable + clawback + allowlist + transfer-fee + transfer-hook');
    });
});

describe('a mint that has not been read from the chain', () => {
    const NULL_CONTROL = {
        clawback: null, freezeAuthority: null, pausable: null, paused: null,
        allowlist: null, transferFeeBps: null, hookActive: null
    };

    it('is unknown, not "none" — the two are different facts', () => {
        const recipe = controlRecipe({ tokenProgram: TOKEN_2022, control: NULL_CONTROL });
        expect(recipe).toEqual({ program: 'token-2022', extensions: [], label: UNKNOWN_RECIPE_LABEL });
    });

    it('is unknown when the control block is missing altogether', () => {
        expect(controlRecipe({ tokenProgram: TOKEN_2022 }).label).toBe(UNKNOWN_RECIPE_LABEL);
        expect(controlRecipe({ tokenProgram: TOKEN_2022, control: null }).label).toBe(UNKNOWN_RECIPE_LABEL);
        expect(controlRecipe(null).label).toBe(UNKNOWN_RECIPE_LABEL);
        expect(controlRecipe(undefined).label).toBe(UNKNOWN_RECIPE_LABEL);
    });

    it('still names the program it is on, because that much is known', () => {
        expect(controlRecipe({ tokenProgram: SPL_TOKEN, control: NULL_CONTROL }).program).toBe('spl-token');
        expect(controlRecipe({ tokenProgram: null, control: NULL_CONTROL }).program).toBe('unknown');
    });

    it('is known as soon as one single flag has been read', () => {
        expect(controlKnown(NULL_CONTROL)).toBe(false);
        expect(controlKnown({ ...NULL_CONTROL, pausable: false })).toBe(true);
        expect(controlKnown({ ...NULL_CONTROL, transferFeeBps: 0 })).toBe(true);
        expect(controlKnown(null)).toBe(false);
    });
});

describe('an unknown program', () => {
    it('labels the recipe with "unknown" in the program slot, not with a raw id', () => {
        const recipe = controlRecipe(token({ pausable: true }, 'Prog1111111111111111111111111111111111111111'));
        expect(recipe.program).toBe('unknown');
        expect(recipe.label).toBe('unknown · pausable');
    });

    it('does the same on spl-token, which has no extensions to find', () => {
        const recipe = controlRecipe(token({}, SPL_TOKEN));
        expect(recipe.label).toBe('spl-token · none');
    });
});

describe('recipeTally', () => {
    it('counts distinct recipes and sorts by mints desc, then label', () => {
        const tally = recipeTally([
            token({ pausable: true }),
            token({ pausable: true }),
            token({ pausable: true, clawback: true }),
            token({ transferFeeBps: 20 })
        ]);
        expect(tally).toEqual([
            { label: 'token-2022 · pausable', mints: 2 },
            { label: 'token-2022 · pausable + clawback', mints: 1 },
            { label: 'token-2022 · transfer-fee', mints: 1 }
        ]);
    });

    it('sums to the mint count, unprofiled mints included', () => {
        const tokens = [
            token({ pausable: true }),
            { tokenProgram: 'token-2022', control: null },
            { tokenProgram: 'token-2022', control: null }
        ];
        const tally = recipeTally(tokens);
        expect(tally.reduce((sum, r) => sum + r.mints, 0)).toBe(tokens.length);
        expect(tally[0]).toEqual({ label: UNKNOWN_RECIPE_LABEL, mints: 2 });
    });

    it('prefers a record’s own recipe over recomputing it, so the file is the source of truth', () => {
        const tally = recipeTally([{ recipe: { program: 'token-2022', extensions: [], label: 'token-2022 · taken as written' } }]);
        expect(tally).toEqual([{ label: 'token-2022 · taken as written', mints: 1 }]);
    });

    it('is empty for an issuer with no mints, rather than inventing a recipe', () => {
        expect(recipeTally([])).toEqual([]);
        expect(recipeTally(null)).toEqual([]);
    });
});
