const charts = require('./stocks/lib/history-charts.js');

describe('historical charts', () => {
    test('groups measured rows and keeps missing observations missing', () => {
        const sets = charts.series([{ snapshot_date: '2026-09-19', issuer: 'A', premium_pct: '1.2' }, { snapshot_date: '2026-09-20', issuer: 'A', premium_pct: null }], 'premium_pct');
        expect(sets).toEqual([{ label: 'A', points: [{ date: '2026-09-19', value: 1.2 }] }]);
    });
    test('renders an accessible SVG and a dated event marker', () => {
        const html = charts.render([{ snapshot_date: '2026-09-19', premium_pct: 1 }, { snapshot_date: '2026-09-20', premium_pct: 2 }], [{ detected_at: '2026-09-20T01:00:00Z', severity: 'warning', summary: 'Terms changed' }], 'premium_pct');
        expect(html).toContain('<svg'); expect(html).toContain('Terms changed'); expect(html).toContain('history-event-warning');
    });
});
