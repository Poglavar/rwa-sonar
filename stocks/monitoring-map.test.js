// Behavioral checks for issuer scoping, shared sources and proportional mission time-lapse.
const model = require('../rwa/lib/monitoring-map.js');
const fixture = {
    issuers: [{ id: 'a', label: 'Issuer A' }, { id: 'b', label: 'Issuer B' }],
    jobs: [{ id: 'court', label: 'Court scout' }, { id: 'feed', label: 'Shared feed' }],
    sources: [{ id: 'court', label: 'Court', host: 'court.example', category: 'public' }],
    routes: [
        { id: 'a', jobId: 'court', sourceId: 'court', issuerIds: ['a'], category: 'public', url: 'https://court.example/a', state: 'configured', cadenceHours: 24 },
        { id: 'b', jobId: 'court', sourceId: 'court', issuerIds: ['b'], category: 'public', url: 'https://court.example/b', state: 'configured', cadenceHours: 24 },
        { id: 'shared', jobId: 'feed', sourceId: 'court', issuerIds: ['a', 'b'], category: 'public', url: 'https://court.example/feed', state: 'prepared', cadenceHours: 6 }
    ]
};
test('all view keeps separate issuer checks at the same source and counts the shared read once', () => {
    const view = model.selectInventory(fixture);
    expect(view.counts).toMatchObject({ sources: 1, routes: 3, shared: 1, issuers: 2, configured: 2, prepared: 1 });
    expect(model.groupRoutes(view)[0]).toMatchObject({ issuerIds: ['a', 'b'], jobIds: ['court', 'feed'] });
});
test('issuer selection includes shared monitoring without carrying another issuer’s private query', () => {
    const view = model.selectInventory(fixture, { issuer: 'a' });
    expect(view.routes.map((r) => r.id)).toEqual(['a', 'shared']);
    expect(view.issuers.map((i) => i.id)).toEqual(['a']);
    expect(model.selectInventory(fixture, { issuer: 'missing' }).routes).toEqual([]);
});
test('source search, category and status compose without losing attribution', () => {
    expect(model.selectInventory(fixture, { query: 'Issuer B', state: 'configured' }).routes.map((r) => r.id)).toEqual(['b']);
    expect(model.selectInventory(fixture, { category: 'chain' }).counts.routes).toBe(0);
});
test('a shared provider uses the category of the routes in the selected view', () => {
    const data = { ...fixture, routes: [...fixture.routes, { ...fixture.routes[0], id: 'new', category: 'chain' }] };
    expect(model.groupRoutes(model.selectInventory(data))[0].category).toBe('public');
    expect(model.groupRoutes(model.selectInventory(data, { category: 'chain' }))[0].category).toBe('chain');
});
test('a blockchain destination retains its identity when lending account reads dominate', () => {
    const view = { sources: [{ id: 'chain:solana', label: 'Solana', category: 'chain' }], routes: [{ ...fixture.routes[0], sourceId: 'chain:solana', category: 'defi' }] };
    expect(model.groupRoutes(view)[0].category).toBe('chain');
});
test('route labels distinguish a shared read from a separate entity query', () => {
    expect(model.scopeLabel({ scope: 'shared', issuerIds: ['a', 'b'] })).toBe('One shared read · serves 2 issuer/product scopes');
    expect(model.scopeLabel({ scope: 'per-entity', issuerIds: ['a'] })).toBe('Separate legal-entity query');
});
test('hourly and daily missions retain their exact period on any time scale', () => {
    for (const cadenceHours of [1, 6, 24]) for (const secondsPerHour of [1, 4, 12]) {
        const route = { id: 'test', state: 'configured', cadenceHours };
        for (const t of [0, 0.13, 2.1, 50.6]) {
            const a = model.shipPhase(route, t, secondsPerHour), b = model.shipPhase(route, t + cadenceHours * secondsPerHour, secondsPerHour);
            if (!a) expect(b).toBeNull(); else expect(b.progress).toBeCloseTo(a.progress, 8);
        }
    }
});
test('a full simulated day launches 24 hourly, four six-hourly and one daily mission', () => {
    for (const cadenceHours of [1, 6, 24]) {
        const route = { id: 'repeated-flight', state: 'configured', cadenceHours };
        let previous = model.shipPhase(route, 0), departures = 0, returns = 0;
        for (let sample = 1; sample <= 4800; sample++) {
            const phase = model.shipPhase(route, sample / 50);
            if (phase && !phase.returning && (!previous || previous.returning)) departures++;
            if (phase?.returning && !previous?.returning) returns++;
            previous = phase;
        }
        expect(departures).toBe(24 / cadenceHours);
        expect(returns).toBe(departures);
    }
});
test('prepared, conditional and unscheduled routes never simulate live flights', () => {
    for (const state of ['prepared', 'conditional']) expect(model.shipPhase({ id: 'x', state, cadenceHours: 1 }, 0)).toBeNull();
    expect(model.shipPhase({ id: 'x', state: 'configured', cadenceHours: null }, 0)).toBeNull();
});
test('a missing run is unknown, never a success or an epoch-age calculation', () => {
    expect(model.observationLabel({ observedAt: null })).toBe('No run record in this snapshot');
    expect(model.observationLabel({ observedAt: '2026-01-01', cadenceHours: 1 }, Date.parse('2026-01-02'))).toBe('Run record is out of date');
});
test('source layout stays inside both narrow and wide maps and is deterministic', () => {
    const groups = Array.from({ length: 180 }, (_, n) => ({ id: String(n), label: String(n), category: model.CATEGORIES[n % 7].id, routes: Array(1 + n % 40).fill({}) }));
    for (const [width, height] of [[360, 480], [1200, 680]]) {
        const layout = model.layoutSources(groups, width, height);
        expect(layout.nodes).toHaveLength(180);
        expect(layout).toEqual(model.layoutSources(groups, width, height));
        for (const node of layout.nodes) { expect(node.x).toBeGreaterThan(0); expect(node.x).toBeLessThan(width); expect(node.y).toBeGreaterThan(0); expect(node.y).toBeLessThan(height); }
    }
});
test('quadratic route positions start at the station and finish at the source', () => {
    expect(model.curvePoint({ x: 1, y: 2 }, { x: 4, y: 8 }, 0.2, 0)).toMatchObject({ x: 1, y: 2 });
    expect(model.curvePoint({ x: 1, y: 2 }, { x: 4, y: 8 }, 0.2, 1)).toMatchObject({ x: 4, y: 8 });
});
test('visible labels stay inside the map, avoid each other and leave room for the station', () => {
    const groups = Array.from({ length: 180 }, (_, n) => ({ id: String(n), label: `Source ${n}`, category: model.CATEGORIES[n % 7].id, configured: 1, routes: Array(1 + n % 40).fill({}) }));
    for (const [width, height] of [[296, 470], [1026, 575]]) {
        const { nodes } = model.layoutSources(groups, width, height);
        const labels = model.labelSources(nodes, width, height, nodes[0].id);
        expect(labels.length).toBeGreaterThan(2);
        const boxes = [{ x: width / 2 - 75, y: height / 2 - 75, width: 150, height: 210 }];
        for (const { box } of labels) {
            expect(box.x).toBeGreaterThanOrEqual(8);
            expect(box.x + box.width).toBeLessThanOrEqual(width - 8);
            expect(box.y).toBeGreaterThanOrEqual(36);
            expect(box.y + box.height).toBeLessThan(height - 34);
            for (const prior of boxes) expect(box.x < prior.x + prior.width && box.x + box.width > prior.x && box.y < prior.y + prior.height && box.y + box.height > prior.y).toBe(false);
            boxes.push(box);
        }
    }
});
test('only public HTTP links are allowed', () => {
    expect(model.safeUrl('javascript:alert(1)')).toBeNull();
    expect(model.safeUrl('https://user:secret@example.com')).toBeNull();
    expect(model.safeUrl('https://example.com/x')).toBe('https://example.com/x');
});
