// Tests methodology.html's pure freshness rules and its promise to expose collector-specific state.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const methodology = require('./methodology.js');

describe('collector freshness presentation', () => {
    const now = Date.parse('2026-09-20T12:00:00Z');

    test('uses each collector cadence and exposes completed runs with failures', () => {
        expect(methodology.freshness({ observedAt: '2026-09-20T11:00:00Z', cadenceHours: 1 }, now).status).toBe('current');
        expect(methodology.freshness({ observedAt: '2026-09-20T11:00:00Z', cadenceHours: 1, failures: 2 }, now).status).toBe('degraded');
        expect(methodology.freshness({ observedAt: '2026-09-19T18:00:00Z', cadenceHours: 6 }, now).status).toBe('delayed');
        expect(methodology.freshness({ observedAt: '2026-09-16T00:00:00Z', cadenceHours: 24 }, now).status).toBe('stale');
        expect(methodology.freshness({ observedAt: null, cadenceHours: 24 }, now).status).toBe('unknown');
    });

    test('renders source, cadence, coverage and failures without treating missing coverage as zero', () => {
        const html = methodology.collectorCardHtml({
            label: 'Authority watch', observedAt: '2026-09-20T11:00:00Z', cadenceHours: 1,
            source: 'Solana RPC', coverage: 471, unit: 'mints checked', failures: 2
        }, now);
        expect(html).toContain('Current, with failures');
        expect(html).toContain('expected hourly');
        expect(html).toContain('Observed 20 Sept 2026, 11:00 UTC');
        expect(html).toContain('471 mints checked · 2 failures');
        expect(methodology.collectorCardHtml({ label: 'Missing', cadenceHours: 24 }, now))
            .toContain('coverage unavailable');
    });
});
describe('public methodology page', () => {
    const html = readFileSync(join(__dirname, 'methodology.html'), 'utf8');

    test('states what every domain can and cannot prove', () => {
        for (const phrase of [
            'Market', 'Control', 'Legal &amp; evidence', 'DeFi composability',
            'Does not prove:', 'Known blind spots', 'Unknown is not safe', 'When sources disagree'
        ]) expect(html).toContain(phrase);
    });

    test('publishes external change history without exposing internal editorial corrections', () => {
        expect(html).toContain('Reality is allowed to change.');
        expect(html).toContain('best current analysis');
        expect(html).toContain('continuing conflict between actors or sources remains visible');
        expect(html).not.toContain('Contradictions are retained as corrections');
    });

    test('loads one safe aggregate artifact and keeps scripts external', () => {
        expect(readFileSync(join(__dirname, 'methodology.js'), 'utf8')).toContain("fetchJson('./stocks-collector-status.json')");
        expect(html).toContain('id="collectorGrid"');
        expect(html).toContain('id="apiHealth"');
        expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    });
    test('uses the full responsive survey scene with a descriptive alternative', () => {
        expect(html).toContain('survey-team-v2-768.webp 768w');
        expect(html).toContain('survey-team-v2.webp 1536w');
        expect(html).toContain('Four headlamp-wearing dolphins survey the submerged part of an iceberg, with two farther away.');
        expect(html).not.toContain('<source media=');
    });
});
