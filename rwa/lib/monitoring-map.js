/* Pure filtering, source grouping and time-lapse geometry for the How it works mission map. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaMonitoringMap = factory();
})(this, function () {
    const CATEGORIES = [
        { id: 'documents', label: 'Documents', color: '#e9b979', description: 'Terms, prospectuses, disclosures and cited evidence.' },
        { id: 'chain', label: 'Blockchains', color: '#76d7cf', description: 'Token state, authority keys and the transactions that use them.' },
        { id: 'issuer', label: 'Issuer registries', color: '#eb9a83', description: 'Official token lists, reserves and fund data.' },
        { id: 'markets', label: 'Markets & prices', color: '#a7b5fa', description: 'Trading venues, reference prices, depth and corporate actions.' },
        { id: 'defi', label: 'DeFi protocols', color: '#b5d795', description: 'Lending markets, collateral, liquidations and oracle use.' },
        { id: 'public', label: 'Public records', color: '#d5a5dd', description: 'Courts, company registers and regulator notices.' },
        { id: 'processing', label: 'Analysis & delivery', color: '#97b9d6', description: 'Review changes, build reports and deliver saved watches.' }
    ];
    const unique = (values) => [...new Set(values)];
    const finite = (value) => typeof value === 'number' && Number.isFinite(value);
    function hash(value) {
        let n = 2166136261;
        for (const ch of String(value)) n = Math.imul(n ^ ch.charCodeAt(0), 16777619);
        return n >>> 0;
    }
    function safeUrl(value) {
        try {
            const url = new URL(value);
            return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
        } catch { return null; }
    }
    function selectInventory(data, { issuer = 'all', category = 'all', query = '', state = 'all' } = {}) {
        const sources = new Map(data.sources.map((source) => [source.id, source]));
        const jobs = new Map(data.jobs.map((job) => [job.id, job]));
        const issuers = new Map(data.issuers.map((row) => [row.id, row]));
        const needle = query.trim().toLowerCase();
        const routes = data.routes.filter((route) => {
            const job = jobs.get(route.jobId), source = sources.get(route.sourceId);
            if (!job || !source) return false;
            if (issuer !== 'all' && !route.issuerIds.includes(issuer)) return false;
            if (category !== 'all' && route.category !== category) return false;
            if (state !== 'all' && route.state !== state) return false;
            return !needle || [source.label, source.host, route.url, route.label, job.label,
                ...route.issuerIds.map((id) => issuers.get(id)?.label)].filter(Boolean).join(' ').toLowerCase().includes(needle);
        });
        const sourceIds = new Set(routes.map((r) => r.sourceId));
        const jobIds = new Set(routes.map((r) => r.jobId));
        const issuerIds = new Set(routes.flatMap((r) => r.issuerIds));
        return {
            routes,
            sources: data.sources.filter((r) => sourceIds.has(r.id)),
            jobs: data.jobs.filter((r) => jobIds.has(r.id)),
            issuers: data.issuers.filter((r) => issuer === 'all' ? issuerIds.has(r.id) : r.id === issuer),
            counts: {
                sources: sourceIds.size,
                endpoints: new Set(routes.filter((r) => r.url).map((r) => r.url)).size,
                routes: routes.length,
                jobs: jobIds.size,
                issuers: issuerIds.size,
                configured: routes.filter((r) => r.state === 'configured').length,
                prepared: routes.filter((r) => r.state === 'prepared').length,
                conditional: routes.filter((r) => r.state === 'conditional').length,
                shared: routes.filter((r) => r.issuerIds.length > 1).length
            }
        };
    }
    function groupRoutes(view) {
        return view.sources.map((source) => {
            const routes = view.routes.filter((r) => r.sourceId === source.id);
            const weights = routes.reduce((counts, route) => { counts[route.category] = (counts[route.category] || 0) + 1; return counts; }, {});
            const category = source.id.startsWith('chain:') ? 'chain'
                : Object.keys(weights).sort((a, b) => weights[b] - weights[a] || a.localeCompare(b))[0] || source.category;
            return { ...source, category, routes, issuerIds: unique(routes.flatMap((r) => r.issuerIds)),
                jobIds: unique(routes.map((r) => r.jobId)),
                endpoints: unique(routes.map((r) => r.url).filter(Boolean)),
                configured: routes.filter((r) => r.state === 'configured').length,
                categories: unique(routes.map((r) => r.category)) };
        }).sort((a, b) => b.routes.length - a.routes.length || a.label.localeCompare(b.label));
    }
    function cadenceLabel(hours) {
        if (!finite(hours) || hours <= 0) return 'On demand';
        if (hours === 1) return 'Hourly';
        if (hours === 24) return 'Daily';
        return `Every ${hours} hours`;
    }
    function scopeLabel(route) {
        const labels = { shared: 'One shared read', 'per-entity': 'Separate legal-entity query', 'issuer-specific': 'Issuer-specific read',
            'per-token': 'Token collection', 'per-account': 'Account read', 'per-pool': 'Pool read', 'per-underlying': 'Underlying listing query',
            batch: 'Shared batch', 'per-docket': 'Docket follow-up', 'per-market': 'Market lookup', 'per-deployment': 'Deployment read',
            internal: 'Internal service', 'per-feed': 'Oracle feed reads', 'per-reserve': 'Reserve history' };
        return `${labels[route.scope] || 'Collection step'}${route.issuerIds.length > 1 ? ` · serves ${route.issuerIds.length} issuer/product scopes` : ''}`;
    }
    function observationLabel(job, now = Date.now()) {
        const date = Date.parse(job.observedAt);
        if (!Number.isFinite(date)) return 'No run record in this snapshot';
        const ageHours = Math.max(0, (now - date) / 3600000);
        if (job.outcome === 'failed' || job.outcome === 'partial') return `Last run: ${job.outcome}`;
        if (finite(job.cadenceHours) && ageHours > job.cadenceHours * 3) return 'Run record is out of date';
        return 'Run record available';
    }
    // One mission departs once per configured interval. A 24 h route is exactly 24 times slower
    // than a 1 h route; travel duration is decorative, never a claimed network latency.
    function shipPhase(route, elapsedSeconds, secondsPerHour = 4) {
        if (route.state !== 'configured' || !finite(route.cadenceHours) || route.cadenceHours <= 0) return null;
        const period = route.cadenceHours * secondsPerHour;
        const phase = ((elapsedSeconds + hash(route.id) % 100000 / 100000 * period) % period + period) % period;
        const travel = Math.min(period * 0.82, 4.5);
        if (phase >= travel) return null;
        const progress = phase / travel;
        return { progress: progress <= 0.5 ? progress * 2 : (1 - progress) * 2, returning: progress > 0.5 };
    }
    function curvePoint(start, end, bend, t) {
        const dx = end.x - start.x, dy = end.y - start.y;
        const mid = { x: (start.x + end.x) / 2 - dy * bend, y: (start.y + end.y) / 2 + dx * bend };
        const u = 1 - t;
        return { x: u * u * start.x + 2 * u * t * mid.x + t * t * end.x,
            y: u * u * start.y + 2 * u * t * mid.y + t * t * end.y,
            angle: Math.atan2(2 * u * (mid.y - start.y) + 2 * t * (end.y - mid.y),
                2 * u * (mid.x - start.x) + 2 * t * (end.x - mid.x)) };
    }
    function layoutSources(groups, width, height) {
        const center = { x: width / 2, y: height / 2 };
        const compact = width < 600;
        const ordered = [...groups].sort((a, b) => {
            const ca = CATEGORIES.findIndex((c) => c.id === a.category), cb = CATEGORIES.findIndex((c) => c.id === b.category);
            return ca - cb || b.configured - a.configured || b.routes.length - a.routes.length || a.id.localeCompare(b.id);
        });
        const categoryGroups = CATEGORIES.map((cat) => ordered.filter((s) => s.category === cat.id)).filter((s) => s.length);
        const positions = [];
        let offset = -Math.PI * 0.9;
        const gap = 0.08, total = ordered.length;
        for (const group of categoryGroups) {
            const span = (Math.PI * 2 - categoryGroups.length * gap) * (0.5 / categoryGroups.length + 0.5 * group.length / Math.max(1, total));
            group.forEach((source, index) => {
                const majorCount = Math.min(3, group.length);
                const lane = index % 3;
                // Spread the most-used sources through their sector; smaller destinations form a
                // loose belt, rather than piling large planets and labels into the same radial row.
                const fraction = index < majorCount ? (index + .5) / majorCount : ((index * .61803398875) % 1) * .94 + .03;
                const angle = offset + span * fraction;
                const scale = index < majorCount ? .82 : .66 + lane * .14 + (hash(source.id) % 100) / 2500;
                positions.push({ ...source, x: center.x + Math.cos(angle) * Math.max(70, width / 2 - (compact ? 28 : 78)) * scale,
                    y: center.y + Math.sin(angle) * Math.max(100, height / 2 - 65) * scale,
                    radius: (total < 18 ? Math.min(27, 15 + Math.log2(source.routes.length + 1) * 2) : Math.min(15, 2.2 + Math.log2(source.routes.length + 1) * 1.15)) * (compact ? .7 : 1), angle,
                    prominent: index < (width < 600 ? 1 : 3) });
            });
            offset += span + gap;
        }
        return { center, nodes: positions };
    }
    function labelSources(nodes, width, height, selectedId) {
        const boxes = [{ x: width / 2 - 75, y: height / 2 - 75, width: 150, height: 210 }], labels = [];
        const wanted = nodes.filter((n) => n.id === selectedId || n.prominent || nodes.length < 18)
            .sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId) || b.routes.length - a.routes.length);
        const overlaps = (a, b) => a.x < b.x + b.width + 5 && a.x + a.width + 5 > b.x && a.y < b.y + b.height + 5 && a.y + a.height + 5 > b.y;
        for (const node of wanted) {
            const maxChars = width < 600 ? 17 : 25;
            const label = node.label.length > maxChars ? node.label.slice(0, maxChars - 1) + '…' : node.label;
            const w = Math.max(62, label.length * 5.3), r = node.radius + 7;
            const candidates = [
                { x: node.x + r, y: node.y - 10 }, { x: node.x - r - w, y: node.y - 10 },
                { x: node.x - w / 2, y: node.y - r - 28 }, { x: node.x - w / 2, y: node.y + r }
            ].map((p) => ({ ...p, width: w, height: 25 }));
            const place = candidates.find((p) => p.x >= 8 && p.y >= 36 && p.x + w <= width - 8 && p.y + p.height < height - 34 && !boxes.some((b) => overlaps(p, b)));
            if (place) { boxes.push(place); labels.push({ id: node.id, text: label, x: place.x, y: place.y + 9, box: place }); }
        }
        return labels;
    }
    return { CATEGORIES, hash, safeUrl, selectInventory, groupRoutes, cadenceLabel, scopeLabel, observationLabel, shipPhase, curvePoint, layoutSources, labelSources };
});
