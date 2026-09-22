import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

describe('public research-history boundary', () => {
    test('the published issuer database states the current understanding without editorial correction narration', () => {
        const text = readFileSync(join(ROOT, 'stocks-issuers.json'), 'utf8');
        expect(text).not.toMatch(/rwa-sonar (?:record|attestations DB)|\bCORRECTED\b|\bRE-SOURCED\b|dossier previously|statement previously|Records the correction|Two corrections|\bADDED 20\d\d-|\bNEW FACT\b|missed in the first pass|research pass|corrections pass|now confirmed on the register rather than asserted|this dossier(?:’s|'s) research notes|dossier(?:’s|'s) central open question|artefact of the tools used/i);
    });

    test('the public journal excludes versioned false alarms', () => {
        const journal = JSON.parse(readFileSync(join(ROOT, 'stocks-change-journal.json'), 'utf8'));
        const ids = journal.items.map((item) => item.id);
        expect(ids).not.toContain('prestocks-attestations-negative-check');
        expect(ids).not.toContain('xstocks-us-transient-availability');
    });

    test('token and underlying API histories apply the same public event condition', () => {
        const condition = readFileSync(join(ROOT, 'api/src/lib/evidence.js'), 'utf8');
        const tokens = readFileSync(join(ROOT, 'api/src/routes/tokens.js'), 'utf8');
        const history = readFileSync(join(ROOT, 'api/src/routes/history.js'), 'utf8');
        expect(condition).toContain('PUBLIC_CHANGE_CONDITION');
        expect(condition).toContain('^baseline recorded:');
        expect(tokens).toContain('AND ${PUBLIC_CHANGE_CONDITION}');
        expect(history).toContain('AND ${PUBLIC_CHANGE_CONDITION}');
    });

    test('every public claim-versus-reality record states its scope and resolution condition', () => {
        const files = [
            'backpack-securities-spcx.json', 'ondo-global-markets.json',
            'superstate-opening-bell.json', 'tessera.json', 'xstocks-backed.json'
        ];
        const rows = files.flatMap((file) => JSON.parse(readFileSync(join(ROOT, 'stocks/data/issuers', file), 'utf8')).discrepancies ?? []);
        expect(rows).toHaveLength(5);
        for (const row of rows) {
            expect(row.classification.length).toBeGreaterThan(12);
            expect(row.resolutionCondition.length).toBeGreaterThan(30);
            expect(row.impact.length).toBeGreaterThan(30);
        }
    });
});
