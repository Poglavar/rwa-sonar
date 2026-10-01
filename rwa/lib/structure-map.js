// Pure all-RWA membership map and selection rules; connections describe associations, never rights inheritance.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./visual-profile.js'));
    else root.__rwaStructureMap = factory(root.__rwaVisualProfile);
})(this, function (visual) {
    'use strict';
    const FAMILIES = { cash: 'Dollar claims', fund: 'Fund interests', feeder: 'Feeder interests', gold: 'Gold interests', certificate: 'Tracker certificates', note: 'Debt / structured notes', share: 'Registered shares', synthetic: 'Synthetic exposure', derivative: 'Derivatives', unknown: 'Structure unresolved' };
    // Fixed palette slots survive reordering or new programme arrivals; they carry identity only.
    const IDENTITIES = {
        'circle-usdc': 0, 'paxos-gold': 1, 'blackrock-buidl': 2, 'franklin-benji': 3,
        'ondo-usdy': 4, 'securitize-acred': 5, 'securitize-hlscope': 6, ustb: 7,
        usyc: 29, jtrsy: 8, tbill: 9, ustbl: 10,
        wtgxx: 11, ousg: 30, vbill: 12, 'ter-gold': 13,
        'tether-gold': 14, 'felix-usdhl': 15, 'theo-thbill': 16, 'uranium-digital': 17,
        'oro-gold': 18, 'xstocks-backed': 19, 'ondo-global-markets': 31, 'superstate-opening-bell': 32,
        'backpack-securities': 20, bullish: 21, securitize: 22, prestocks: 23, tessera: 24,
        'remora-markets': 25, ventuals: 26, shift: 27, 'republic-mirror': 28
    };
    const hash = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
    const colorSlot = (id) => IDENTITIES[id] ?? hash(id) % 29;
    const addressKey = (d) => `${d.network}:${/^(Ethereum|HyperEVM|Polygon|Arbitrum|Base|Avalanche|Optimism|Ink)$/i.test(d.network) ? d.address.toLowerCase() : d.address}`;
    function buildMap(research, catalogue) {
        const entryByResearch = new Map(catalogue.entries.map((e) => [e.researchId || `stock:${e.programmeId}`, e]));
        const seen = new Set(), owners = new Map(), programmes = [], groups = new Map(), recipes = new Map(), terms = [], edges = [];
        for (const p of research.products) {
            const entry = entryByResearch.get(p.id);
            if (!entry) throw new Error(`Map product has no catalogue entry: ${p.id}`);
            const id = p.programmeId;
            let node = programmes.find((n) => n.id === id);
            if (!node) { node = { id, label: p.name, color: colorSlot(id), products: [], deployments: [], structureIds: [], recipeIds: [], entity: (p.instrument || p.programme).issuer }; programmes.push(node); }
            const profile = visual.profile(p, p.contexts[0].id);
            for (const f of profile.features) f.findings = f.findings.map(({tone,label,note,state,needsReview}) => ({tone,label,note,state,needsReview}));
            node.products.push({ profile, id: p.id, entryId: entry.id, name: p.name, contextId: p.contexts[0].id, terms: p.contexts.map(c => ({id:c.termsId,contextId:c.id,label:c.label})), report: `report.html?product=${encodeURIComponent(p.id)}` });
            for (const context of p.contexts) {
                const termId = `terms:${p.id}:${context.id}:${context.termsId}`;
                const scoped = p.claims.filter(c => c.scope.contextId === context.id && c.scope.termsId === context.termsId);
                const sourceIds = [...new Set(scoped.flatMap(c => c.sourceIds))];
                terms.push({id:termId,termsId:context.termsId,contextId:context.id,label:context.label,kind:'terms-snapshot',productId:p.id,programmeId:id,status:p.kind==='programme'?'programme-dossier':'reviewed-context',binding:'No shared exact template or per-address binding inferred',sourceIds});
                edges.push({from:id,to:termId,kind:'terms-snapshot',productId:p.id,contextId:context.id,sourceIds,scope:p.kind==='programme'?'Programme dossier; individual terms unresolved':'Reviewed instrument and holder context',status:p.kind==='programme'?'programme-only':'reviewed-context'});
            }
            const grouping = p.structure || { id: 'unknown', label: FAMILIES.unknown, basis: 'Unclassified research subject', sourceIds: [] };
            if (!groups.has(grouping.id)) groups.set(grouping.id, { id: grouping.id, label: grouping.label || FAMILIES[grouping.id], programmes: [], kind: 'structure-type' });
            groups.get(grouping.id).programmes.push(id);
            node.structureIds.push(grouping.id);
            edges.push({ from: id, to: grouping.id, kind: 'structure-type', productId: p.id, sourceIds: grouping.sourceIds || [], scope: p.kind === 'programme' ? 'Programme description; token terms unresolved' : 'Product research', status: grouping.sourceIds?.length ? 'source-described' : 'unknown', basis: grouping.basis });
            const counts = new Map(), recipeAddresses = new Set();
            for (const d of p.deployments) {
                const key = addressKey(d);
                if (owners.has(key) && owners.get(key) !== id) throw new Error(`Conflicting programme membership: ${key}`);
                owners.set(key, id);
                if (!seen.has(key)) { seen.add(key); node.deployments.push(key); }
                // Keep the existing observed recipe vocabulary; no recipe is invented from an issuer's branding.
                const recipe = d.legacy?.protocol?.label || 'Controls not classified';
                const recipeId = `recipe:${recipe}`;
                const membership = `${recipeId}:${key}`;
                if (!recipeAddresses.has(membership)) { counts.set(recipeId, (counts.get(recipeId) || 0) + 1); recipeAddresses.add(membership); }
                if (!recipes.has(recipeId)) recipes.set(recipeId, { id: recipeId, label: recipe === 'Controls not classified' ? 'Control pattern unknown' : recipe, programmes: [], kind: 'control-recipe' });
                recipes.get(recipeId).programmes.push(id);
            }
            if (!p.deployments.length) {
                const recipeId = 'recipe:Controls not classified';
                counts.set(recipeId, 0);
                if (!recipes.has(recipeId)) recipes.set(recipeId, { id: recipeId, label: 'Control pattern unknown', programmes: [], kind: 'control-recipe' });
                recipes.get(recipeId).programmes.push(id);
            }
            for (const [recipeId, count] of counts) { node.recipeIds.push(recipeId); edges.push({ from: id, to: recipeId, kind: 'control-recipe', productId: p.id, count, basis: 'Retained exact-deployment recipe; unknown where no recipe is classified', scope: 'Exact deployment classification; no legal terms binding implied', status: recipeId === 'recipe:Controls not classified' ? 'unknown' : 'retained-classification', sourceIds: [...new Set(p.deployments.filter(d => `recipe:${d.legacy?.protocol?.label || 'Controls not classified'}` === recipeId).flatMap(d => d.sourceIds))] }); }
        }
        const unique = (values) => [...new Set(values)];
        for (const n of programmes) { n.structureIds = unique(n.structureIds); n.recipeIds = unique(n.recipeIds); }
        for (const n of [...groups.values(), ...recipes.values()]) n.programmes = unique(n.programmes);
        programmes.sort((a, b) => b.deployments.length - a.deployments.length || a.id.localeCompare(b.id));
        return { schemaVersion: 1, counts: { deployments: seen.size, programmes: programmes.length, subjects: research.products.length }, programmes, terms: terms.sort((a,b)=>a.id.localeCompare(b.id)), structures: [...groups.values()].sort((a,b) => a.label.localeCompare(b.label)), recipes: [...recipes.values()].sort((a,b) => a.label.localeCompare(b.label)), edges };
    }
    // Keep filters explicit; promote selected branches and expand the compact view to fit their members.
    function overview(map, {search = '', entryIds = null, expanded = false, mode = 'legal', selection = null} = {}) {
        const query = search.toLowerCase();
        const pool = map.programmes.filter(p => (!entryIds || p.products.some(r => entryIds.includes(r.entryId))) && `${p.label} ${p.entity}`.toLowerCase().includes(query));
        const ordered = [...pool].sort((a,b) => b.deployments.length - a.deployments.length || a.id.localeCompare(b.id));
        const state = selection?.kind ? select(map, {...selection, mode}) : null;
        const connected = state ? ordered.filter(p => state.programmeIds.includes(p.id)) : [];
        const shown = state ? connected : expanded ? ordered : ordered.slice(0,7);
        const groupIds = new Set(shown.flatMap(p => mode === 'controls' ? p.recipeIds : p.structureIds));
        const groups = (mode === 'controls' ? map.recipes : map.structures).filter(g => groupIds.has(g.id));
        if (state) {
            const rank = g => selection.kind === 'group' && (selection.groupMode || selection.mode || mode) === mode && g.id === selection.id ? 0 : state.groupIds.includes(g.id) ? 1 : 2;
            groups.sort((a,b) => rank(a) - rank(b));
        }
        return {pool,shown,groups};
    }
    // Small clusters use one dot per address; larger clusters increase in density on a log scale.
    function clusterGlyph(count) {
        const dots = count <= 16 ? Math.max(0, count) : Math.min(100, Math.round(16 + Math.log2(count / 16) * 12));
        return {dots, columns: Math.max(1, Math.ceil(Math.sqrt(dots)))};
    }
    // Fixed-width digit reels finish on the real count; separators never move.
    function numberReels(value) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Expected a non-negative integer count');
        return value.toLocaleString('en-US').split('').map(char => ({ char,
            digits: /[0-9]/.test(char) ? Array.from({length:21 + Number(char)}, (_, i) => String(i % 10)) : null }));
    }
    function chainCount(map) {
        return new Set(map.programmes.flatMap(p => p.deployments.map(address => address.slice(0, address.indexOf(':'))))).size;
    }
    function connectionPath(a, b) {
        const middle = (a.x + b.x) / 2;
        return `M${a.x},${a.y}C${middle},${a.y} ${middle},${b.y} ${b.x},${b.y}`;
    }
    function movement(before, after) {
        if (!before || !after || ![before.x,before.y,after.x,after.y].every(Number.isFinite)) return null;
        const x = before.x - after.x, y = before.y - after.y;
        return x || y ? {x,y} : null;
    }
    function select(map, selection = {}) {
        const mode = selection.mode === 'controls' ? 'controls' : 'legal';
        const groupMode = selection.groupMode === 'controls' || selection.groupMode === 'legal' ? selection.groupMode : mode;
        const groups = groupMode === 'legal' ? map.structures : map.recipes;
        let programmes;
        if (selection.kind === 'programme') programmes = map.programmes.filter((p) => p.id === selection.id);
        else if (selection.kind === 'group') programmes = map.programmes.filter((p) => groups.find((g) => g.id === selection.id)?.programmes.includes(p.id));
        else programmes = map.programmes;
        const valid = !selection.kind || programmes.length > 0;
        return { mode, groupMode, valid, programmeIds: programmes.map((p) => p.id), productIds: programmes.flatMap((p) => p.products.map((p) => p.id)), entryIds: programmes.flatMap((p) => p.products.map((p) => p.entryId)), deploymentCount: new Set(programmes.flatMap((p) => p.deployments)).size,
            groupIds: [...new Set(programmes.flatMap((p) => mode === 'legal' ? p.structureIds : p.recipeIds))] };
    }
    return { FAMILIES, IDENTITIES, colorSlot, addressKey, buildMap, select, overview, clusterGlyph, numberReels, chainCount, connectionPath, movement };
});
