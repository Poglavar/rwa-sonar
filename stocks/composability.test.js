// Locks the reviewed DeFi-composability templates to the live issuer + control recipes. A new mint
// recipe must therefore arrive as an explicit unknown and fail this coverage test until reviewed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    COMPOSABILITY_SCENARIOS,
    composabilityHealthRule,
    composabilityTemplateFor,
    composabilityTemplateKey,
    indexComposabilityTemplates
} from './lib/composability.mjs';

const ROOT = join(import.meta.dirname, '..');
const tokens = JSON.parse(readFileSync(join(ROOT, 'stocks-tokens.json'), 'utf8')).tokens;
const db = JSON.parse(readFileSync(join(import.meta.dirname, 'data', 'composability-templates.json'), 'utf8'));

describe('DeFi composability templates', () => {
    test('every current issuer + recipe combination has exactly one reviewed template', () => {
        const index = indexComposabilityTemplates(db.templates);
        const liveKeys = new Set(tokens.map((token) => composabilityTemplateKey(token.issuer, token.recipe.label)));
        expect(liveKeys.size).toBe(9);
        expect(index.size).toBe(9);
        expect(new Set(index.keys())).toEqual(liveKeys);
        for (const token of tokens) expect(composabilityTemplateFor(token, index)).not.toBeNull();
    });

    test('every template answers all four scenarios without presenting an admin capability as a duty', () => {
        for (const template of db.templates) {
            expect(['good', 'caution', 'warning']).toContain(template.healthStatus);
            expect(template.summary.length).toBeGreaterThan(80);
            expect(template.basisFields.length).toBeGreaterThan(2);
            for (const scenario of COMPOSABILITY_SCENARIOS) {
                const answer = template.scenarios[scenario.id];
                expect(answer.outcome.length).toBeGreaterThan(3);
                expect(answer.headline.length).toBeGreaterThan(10);
                expect(answer.explanation.length).toBeGreaterThan(80);
            }
        }
        expect(db.assumptions.join(' ')).toMatch(/capabilities, not promises or legal duties/i);
    });

    test('the current mint population is 398 caution and 73 warning, counted from templates', () => {
        const index = indexComposabilityTemplates(db.templates);
        const counts = { good: 0, caution: 0, warning: 0, unknown: 0 };
        for (const token of tokens) counts[composabilityTemplateFor(token, index)?.healthStatus ?? 'unknown'] += 1;
        expect(counts).toEqual({ good: 0, caution: 398, warning: 73, unknown: 0 });
    });

    test('an unreviewed combination remains unknown rather than inheriting a nearby issuer conclusion', () => {
        const index = indexComposabilityTemplates(db.templates);
        expect(composabilityTemplateFor({ issuer: 'tessera', recipe: { label: 'token-2022 · clawback' } }, index)).toBeNull();
        expect(composabilityHealthRule(null)).toMatchObject({
            status: 'unknown',
            inputs: { templateId: null, escrow: null, borrowerDefault: null, protocolHack: null, accessLoss: null }
        });
    });
});
