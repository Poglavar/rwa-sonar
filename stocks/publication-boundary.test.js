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
});
