// Unit tests for the pure section of monitor.js — the shaping behind monitor.html, now an explorer
// over the read-only JSON API. Every test asserts an outcome a reader would notice if it broke:
// that a filtered view survives being shared as a link, that a second value inside one facet is OR
// and removing the last one drops the facet rather than sending an empty parameter, that a slow
// earlier response cannot repaint a table the reader has moved off, that a page past the end lands
// on the last page rather than on an empty table, that a facet value the API cannot be asked for is
// still counted but not offered as a filter, that a missing measurement stays a dash and never a 0,
// and that the change log, the events and the Meteora pools — which are still files — are unchanged.
//
// Three tests exist purely to stop this page and the API drifting apart: the 22 facet names and the
// sort whitelist are read out of api/src/lib/query.js, and the rule LABELS (the one thing the API
// does not serve) are compared against stocks-health.json. The health rules themselves are NOT
// tested here: they live in stocks/lib/health.mjs and are covered by stocks/health.test.js.

const M = require('./monitor.js');

/** A stocks-tokens.json with one token deliberately absent (MINT_E), to prove nulls survive. */
function tokens() {
    return {
        builtAt: '2026-09-16T22:57:26Z',
        issuerIndex: {
            'xstocks-backed': { name: 'Backed (xStocks)', status: 'live' },
            'ondo-global-markets': { name: 'Ondo Global Markets', status: 'live' }
        },
        tokens: [
            {
                mint: 'MINT_A', symbol: 'AAPLx', name: 'Apple xStock', issuer: 'xstocks-backed',
                market: { liquidity: 4000, vol24: 12000 }, activity: { venueSpreadPct: 0.52, lastTradedAt: '2026-09-16T20:12:30Z' },
                reference: { premiumPct: -0.28, price: 241, source: 'pyth' }, holders: { top1SharePct: 48.7 }
            },
            {
                mint: 'MINT_B', symbol: 'TSLAx', name: 'Tesla xStock', issuer: 'xstocks-backed',
                market: { liquidity: 900000 }, activity: { venueSpreadPct: 6.1, lastTradedAt: '2026-09-16T22:00:00Z' },
                reference: { premiumPct: 0.9, price: 430 }, holders: { top1SharePct: 12.1 }
            },
            {
                mint: 'MINT_C', symbol: 'AAPLon', name: 'Apple (Ondo Tokenized)', issuer: 'ondo-global-markets',
                market: { liquidity: 892.057 }, activity: { venueSpreadPct: null, lastTradedAt: null },
                reference: { premiumPct: null, price: null }, holders: { top1SharePct: 99.1 }
            },
            {
                mint: 'MINT_D', symbol: 'SPCXx', name: 'SpaceX xStock', issuer: 'xstocks-backed',
                market: { liquidity: 50000 }, activity: { venueSpreadPct: 5.33, lastTradedAt: '2026-09-16T18:00:00Z' },
                reference: { premiumPct: 2.5, price: 210 }, holders: { top1SharePct: null }
            }
        ]
    };
}

// ---------------------------------------------------- the API contract this page depends on

describe('the API names this page holds a copy of', () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const querySrc = readFileSync(join(__dirname, 'api/src/lib/query.js'), 'utf8');

    /** The keys of an `export const NAME = { … };` block in the API's query builder. */
    function keysOf(name) {
        const block = querySrc.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\};`));
        if (block === null) throw new Error(`${name} is no longer declared in api/src/lib/query.js`);
        return [...block[1].matchAll(/^ {4}([a-z_0-9]+):/gm)].map((match) => match[1]);
    }

    test('FACET_NAMES is exactly the API\'s filter whitelist — an invented name is a 400', () => {
        // The API rejects an unknown filter rather than ignoring it, so a name this page makes up
        // breaks every request; a name it FORGETS is a facet no reader can ever see.
        expect(M.FACET_NAMES).toEqual(keysOf('FILTERS'));
        expect(M.FACET_NAMES).toHaveLength(26);
    });

    test('TOKEN_SORTS is exactly the API\'s sort whitelist', () => {
        expect(M.TOKEN_SORTS.slice().sort()).toEqual(keysOf('TOKEN_SORTS').slice().sort());
        expect(M.TOKEN_SORTS).toContain(M.DEFAULT_SORT);
    });

    test('every column monitor.html offers as sortable is a key the API will sort by', () => {
        const html = readFileSync(join(__dirname, 'monitor.html'), 'utf8');
        const offered = [...html.matchAll(/data-sort="([^"]+)"/g)].map((match) => match[1]);
        expect(offered.length).toBeGreaterThan(0);
        for (const key of offered) expect(M.TOKEN_SORTS).toContain(key);
    });

    test('RULE_LABELS is the health file\'s own rule names, so a renamed rule cannot drift', () => {
        // The API serves the rule ID and no label, which is why this map exists at all. It is
        // display text only — stocks/lib/health.mjs stays the one copy of the rules themselves.
        const health = JSON.parse(readFileSync(join(__dirname, 'stocks-health.json'), 'utf8'));
        const fromFile = Object.fromEntries(health.rules.map((rule) => [rule.id, rule.label]));
        expect(M.RULE_LABELS).toEqual(fromFile);
    });

    test('every facet sits in exactly one group in the panel, and every group is non-empty', () => {
        const placed = M.FACET_GROUPS.flatMap((group) => group.facets);
        expect(placed.slice().sort()).toEqual(M.FACET_NAMES.slice().sort());
        expect(new Set(placed).size).toBe(placed.length);
        for (const group of M.FACET_GROUPS) expect(group.facets.length).toBeGreaterThan(0);
    });

    test('monitor.js reads the API, and no longer reads the files it replaced', () => {
        const source = readFileSync(join(__dirname, 'monitor.js'), 'utf8');
        expect(source).toContain('/api/tokens');
        expect(source).toContain('/api/facets');
        // The paths as they would be FETCHED — both files are still named in comments, which is
        // where the explanation of why they are gone belongs.
        expect(source).not.toMatch(/['"]\.\/stocks-health\.json['"]/);
        expect(source).not.toMatch(/['"]\.\/cards\/index\.json['"]/);
    });
});

// ------------------------------------------------------------- filter state in the URL

describe('parseFilterState and filterStateToSearch', () => {
    test('a filtered view round trips through the query string', () => {
        const search = 'recipe=token-2022%20%C2%B7%20pausable&health=warning,caution&q=nvda&sort=symbol&order=asc&page=3';
        const state = M.parseFilterState(`?${search}`);
        expect(state).toEqual({
            filters: { recipe: ['token-2022 · pausable'], health: ['warning', 'caution'] },
            q: 'nvda',
            sort: 'symbol',
            order: 'asc',
            page: 3
        });
        expect(M.parseFilterState(`?${M.filterStateToSearch(state)}`)).toEqual(state);
    });

    test('the page\'s own parameters are NOT read as filters, which the API would reject', () => {
        const state = M.parseFilterState('?api=http://localhost:3300&reduceMotion=1&health=good');
        expect(state.filters).toEqual({ health: ['good'] });
        // …and they are carried back out, so a shared link keeps pointing at the same API.
        expect(M.filterStateToSearch(state, { api: 'http://localhost:3300', reduceMotion: '1' }))
            .toBe('api=http%3A%2F%2Flocalhost%3A3300&reduceMotion=1&health=good');
    });

    test('a default is left out of the URL, so an unfiltered page has a clean one', () => {
        expect(M.filterStateToSearch(M.parseFilterState(''))).toBe('');
        expect(M.filterStateToSearch({ filters: {}, q: '', sort: M.DEFAULT_SORT, order: 'desc', page: 1 })).toBe('');
    });

    test('a repeated parameter means OR, and duplicates collapse', () => {
        expect(M.parseFilterState('?issuer=shift&issuer=prestocks,shift').filters)
            .toEqual({ issuer: ['shift', 'prestocks'] });
    });

    test('an unknown sort, a bad order and a bad page fall back rather than reaching the API', () => {
        const state = M.parseFilterState('?sort=supply_raw&order=sideways&page=zero');
        expect(state.sort).toBe(M.DEFAULT_SORT);
        expect(state.order).toBe('desc');
        expect(state.page).toBe(1);
        expect(M.parseFilterState('?page=-4').page).toBe(1);
    });

    test('the null bucket survives the round trip, because it is a filter like any other', () => {
        const state = M.parseFilterState('?reference=null');
        expect(state.filters).toEqual({ reference: [M.NULL_PARAM] });
        expect(M.filterStateToSearch(state)).toBe('reference=null');
    });
});

describe('toggleFilterValue', () => {
    test('a second value in the same facet is added — multi-select inside a facet is OR', () => {
        const once = M.toggleFilterValue({}, 'health', 'warning');
        expect(once).toEqual({ health: ['warning'] });
        expect(M.toggleFilterValue(once, 'health', 'caution')).toEqual({ health: ['warning', 'caution'] });
    });

    test('toggling the last value off drops the facet, never sends an empty parameter', () => {
        expect(M.toggleFilterValue({ health: ['warning'] }, 'health', 'warning')).toEqual({});
        expect(M.toggleFilterValue({ health: ['warning', 'good'] }, 'health', 'warning'))
            .toEqual({ health: ['good'] });
    });

    test('the input is not mutated, so a stale render cannot see a half-applied filter', () => {
        const before = { health: ['warning'] };
        M.toggleFilterValue(before, 'health', 'good');
        expect(before).toEqual({ health: ['warning'] });
    });

    test('a facet the API does not have is refused rather than sent', () => {
        expect(M.toggleFilterValue({}, 'supply_raw', '1')).toEqual({});
        expect(M.toggleFilterValue({}, 'health', '')).toEqual({});
    });
});

describe('tokenRequestParams and facetRequestParams', () => {
    test('the page becomes an offset, and an empty search is dropped', () => {
        const state = M.parseFilterState('?health=warning&page=3');
        expect(M.tokenRequestParams(state)).toEqual({
            health: ['warning'], q: null, sort: M.DEFAULT_SORT, order: 'desc', limit: 50, offset: 100
        });
        expect(M.facetRequestParams(state)).toEqual({ health: ['warning'], q: null });
    });

    test('facets are asked for with no `by`, so all 22 come back in one request', () => {
        expect(Object.keys(M.facetRequestParams(M.parseFilterState('')))).toEqual(['q']);
    });
});

// -------------------------------------------------------------------- facets

describe('facetGroups', () => {
    /** A /api/facets response, shaped exactly as the route returns it. */
    function facets() {
        return {
            issuer: [
                { value: 'ondo-global-markets', count: 230, name: 'Ondo Global Markets' },
                { value: 'xstocks-backed', count: 165, name: 'Kraken xStocks' }
            ],
            instrument: [{ value: 'stock', count: 324 }],
            health: [{ value: 'warning', count: 309 }, { value: 'caution', count: 125 }],
            worst_rule: [{ value: 'keyControl', count: 40 }],
            reference: [{ value: 'pyth', count: 5 }, { value: null, count: 118 }],
            clawback: [{ value: true, count: 238, label: 'true' }, { value: false, count: 233, label: 'false' }],
            first_seen_day: [{ value: '2026-09-16', count: 441 }],
            jurisdiction: [
                { value: 'Jersey (Channel Islands)', count: 165 },
                { value: 'Delaware LLC, principal offices New York, NY, USA. Issuers are US-incorporated', count: 8, label: 'Delaware LLC, principal offices New York…' }
            ],
            program: []
        };
    }

    test('groups in the panel\'s order, under the panel\'s headings, empty facets left out', () => {
        const groups = M.facetGroups(facets(), {});
        expect(groups.map((group) => group.id))
            .toEqual(['issuer', 'instrument', 'health', 'issuer-shape', 'control', 'reference', 'seen']);
        expect(groups.find((group) => group.id === 'health').facets.map((facet) => facet.name))
            .toEqual(['health', 'worst_rule']);
        // `program` came back empty and `recipe` did not come back at all: neither gets a heading.
        expect(groups.some((group) => group.id === 'recipe')).toBe(false);
    });

    test('a facet the API reports and this page has not placed is shown, not dropped', () => {
        const groups = M.facetGroups({ ...facets(), supply_band: [{ value: 'small', count: 3 }] }, {});
        const other = groups[groups.length - 1];
        expect(other.id).toBe('other');
        expect(other.facets.map((facet) => facet.name)).toEqual(['supply_band']);
    });

    test('a value is labelled the way a reader reads it, never as a bare null or true', () => {
        const groups = M.facetGroups(facets(), {});
        const byName = new Map(groups.flatMap((group) => group.facets).map((facet) => [facet.name, facet]));
        expect(byName.get('issuer').values[0].label).toBe('Ondo Global Markets');
        expect(byName.get('worst_rule').values[0].label).toBe('Authority keys');
        expect(byName.get('clawback').values.map((value) => value.label)).toEqual(['yes', 'no']);
        expect(byName.get('reference').values[1].label).toBe(M.MISSING_LABEL);
        expect(byName.get('reference').values[1].param).toBe(M.NULL_PARAM);
        expect(byName.get('first_seen_day').values[0].label).toBe('16 Sep 2026');
        expect(byName.get('jurisdiction').values[1].label).toBe('Delaware LLC, principal offices New York…');
    });

    test('a value containing a comma is listed with its count but NOT offered as a filter', () => {
        // The API reads a comma as the OR separator, so asking for such a value returns zero
        // tokens. Six of the nine real jurisdiction blurbs contain one.
        const facet = M.facetGroups(facets(), {}).flatMap((group) => group.facets)
            .find((entry) => entry.name === 'jurisdiction');
        expect(facet.values[0].filterable).toBe(true);
        expect(facet.values[1].filterable).toBe(false);
        expect(facet.values[1].count).toBe(8);
    });

    test('the active values are marked, so the panel shows what is on', () => {
        const facet = M.facetGroups(facets(), { health: ['warning'] }).flatMap((group) => group.facets)
            .find((entry) => entry.name === 'health');
        expect(facet.values.map((value) => value.active)).toEqual([true, false]);
    });

    test('no facets at all is no groups, not a crash', () => {
        expect(M.facetGroups(null, null)).toEqual([]);
        expect(M.facetGroups({}, {})).toEqual([]);
    });
});

describe('filterChips', () => {
    const facets = {
        health: [{ value: 'warning', count: 309 }],
        clawback: [{ value: true, count: 238 }],
        reference: [{ value: null, count: 118 }]
    };

    test('one chip per active value, search first, in the panel\'s facet order', () => {
        const state = { filters: { clawback: ['true'], health: ['warning'] }, q: 'nvda' };
        expect(M.filterChips(state, facets)).toEqual([
            { facet: 'q', value: 'nvda', title: 'Search', label: 'nvda' },
            { facet: 'health', value: 'warning', title: 'Status', label: 'warning' },
            { facet: 'clawback', value: 'true', title: 'Clawback', label: 'yes' }
        ]);
    });

    test('the null bucket reads as a missing value, never as the word null', () => {
        expect(M.filterChips({ filters: { reference: ['null'] } }, facets)[0].label).toBe(M.MISSING_LABEL);
    });

    test('a value the facets do not carry still gets a chip, so it can be removed', () => {
        const chips = M.filterChips({ filters: { health: ['gone'] } }, facets);
        expect(chips).toEqual([{ facet: 'health', value: 'gone', title: 'Status', label: 'gone' }]);
    });

    test('no filters is no chips', () => {
        expect(M.filterChips({ filters: {}, q: '' }, facets)).toEqual([]);
        expect(M.filterChips(null, null)).toEqual([]);
    });
});

describe('statusTilesFromFacet', () => {
    test('all four statuses always appear, in order, with the facet\'s own counts', () => {
        const tiles = M.statusTilesFromFacet(
            [{ value: 'warning', count: 309 }, { value: 'caution', count: 125 }, { value: 'good', count: 37 }],
            ['warning']
        );
        expect(tiles.map((tile) => tile.status)).toEqual(['good', 'caution', 'warning', 'unknown']);
        expect(tiles.map((tile) => tile.count)).toEqual([37, 125, 309, 0]);
        // A status the facet does not mention is 0 — the tile does not vanish, and 0 is a fact here.
        expect(tiles.map((tile) => tile.active)).toEqual([false, false, true, false]);
    });

    test('every tile carries a sentence, and the unknown one refuses to read as a pass', () => {
        for (const tile of M.statusTilesFromFacet([], [])) {
            expect(typeof tile.blurb).toBe('string');
            expect(tile.blurb.length).toBeGreaterThan(10);
        }
        expect(M.STATUS_BLURBS.unknown).toMatch(/this is not a pass/);
    });
});

describe('dimensionSummariesFromFacets', () => {
    test('keeps all four health distributions independent', () => {
        const dimensions = M.dimensionSummariesFromFacets({
            market_health: [{ value: 'warning', count: 8 }],
            control_health: [{ value: 'good', count: 7 }],
            legal_health: [{ value: 'unknown', count: 6 }],
            composability_health: [{ value: 'caution', count: 398 }]
        }, { control_health: ['good'] });
        expect(dimensions.map((item) => item.label)).toEqual(['Market', 'Control', 'Legal / evidence', 'DeFi composability']);
        expect(dimensions[0].statuses.find((item) => item.status === 'warning').count).toBe(8);
        expect(dimensions[1].statuses.find((item) => item.status === 'good').active).toBe(true);
        expect(dimensions[2].statuses.find((item) => item.status === 'unknown').count).toBe(6);
        expect(dimensions[3].statuses.find((item) => item.status === 'caution').count).toBe(398);
    });
});

describe('ruleStripFromFacet', () => {
    test('biggest first, labelled, shares adding to 100 across the tokens that have a worst rule', () => {
        const strip = M.ruleStripFromFacet([
            { value: 'tracking', count: 102 },
            { value: 'concentration', count: 138 },
            { value: 'spread', count: 0 },
            { value: null, count: 12 }
        ], ['tracking']);
        expect(strip.map((rule) => rule.id)).toEqual(['concentration', 'tracking']);
        expect(strip[0].label).toBe('Holder concentration');
        // The null bucket is NOT a rule: counting it would read as a clean bill of health.
        expect(strip.some((rule) => rule.id === 'null')).toBe(false);
        expect(strip.reduce((sum, rule) => sum + rule.share, 0)).toBeCloseTo(100, 6);
        expect(strip.find((rule) => rule.id === 'tracking').active).toBe(true);
    });

    test('an empty or absent facet is an empty strip, not a crash', () => {
        expect(M.ruleStripFromFacet([], [])).toEqual([]);
        expect(M.ruleStripFromFacet(null, null)).toEqual([]);
    });
});

// ------------------------------------------------------------------- paging

describe('pageMath', () => {
    test('the offset, the window and the label of a page in the middle', () => {
        const math = M.pageMath({ total: 471, page: 2, perPage: 50 });
        expect(math).toMatchObject({ page: 2, pages: 10, offset: 50, from: 51, to: 100, hasPrev: true, hasNext: true });
        expect(math.label).toBe('51–100 of 471 · page 2 of 10');
    });

    test('the last page is short, and offers no next', () => {
        const math = M.pageMath({ total: 471, page: 10, perPage: 50 });
        expect(math).toMatchObject({ offset: 450, from: 451, to: 471, hasNext: false, hasPrev: true });
    });

    test('a page past the end is CLAMPED to the last one, not shown as empty', () => {
        expect(M.pageMath({ total: 471, page: 99, perPage: 50 }).page).toBe(10);
        expect(M.pageMath({ total: 471, page: 0, perPage: 50 }).page).toBe(1);
    });

    test('no matches is one page with no rows, and says so instead of showing 0–0 of 0', () => {
        const math = M.pageMath({ total: 0, page: 1 });
        expect(math).toMatchObject({ pages: 1, from: null, to: null, hasPrev: false, hasNext: false });
        expect(math.label).toBe('no tokens match');
    });

    test('the default window is the page size the table asks the API for', () => {
        expect(M.pageMath({ total: 100 }).perPage).toBe(M.PER_PAGE);
    });
});

describe('createSequence', () => {
    test('only the newest request may render — a slow earlier answer is discarded', () => {
        const sequence = M.createSequence();
        const first = sequence.next();
        const second = sequence.next();
        // The first request finishes LAST, which is exactly the case that repaints a stale table.
        expect(sequence.isCurrent(second)).toBe(true);
        expect(sequence.isCurrent(first)).toBe(false);
    });

    test('each request takes its own number, and a fresh sequence has issued none', () => {
        const sequence = M.createSequence();
        expect(sequence.isCurrent(0)).toBe(true);
        expect(sequence.next()).toBe(1);
        expect(sequence.next()).toBe(2);
        expect(sequence.value).toBe(2);
    });
});

describe('describeApiFailure', () => {
    test('the status AND the path are in the sentence, because they are different problems', () => {
        expect(M.describeApiFailure({ path: '/api/tokens?health=warning', status: 500 }))
            .toBe('API unreachable: GET /api/tokens?health=warning answered HTTP 500.');
    });

    test('no status at all says the API did not answer, and names the reason it was given', () => {
        expect(M.describeApiFailure({ path: '/api/facets', message: 'Failed to fetch' }))
            .toBe('API unreachable: GET /api/facets did not answer (Failed to fetch). Check that the API is running.');
        expect(M.describeApiFailure({})).toMatch(/^API unreachable: GET the API did not answer\./);
    });
});

// -------------------------------------------------------------- table rows

describe('tokenRowsFromApi and gapIndex', () => {
    /** Two slim rows exactly as /api/tokens serves them, snake_case and all. */
    function items() {
        return [
            {
                mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', symbol: 'SPYx', name: 'SP500 xStock',
                issuer_slug: 'xstocks-backed', issuer_name: 'Kraken xStocks', instrument_type: 'etf',
                recipe_label: 'token-2022 · pausable + clawback', health_status: 'caution',
                market_health: 'warning', control_health: 'good', legal_health: 'caution',
                composability_health: 'caution',
                worst_rule: 'keyControl', liquidity_usd: 5871523.44, volume24_usd: 22884814.38,
                premium_pct: -0.1795, venue_spread_pct: 1.3734, top1_share_pct: 29.257,
                holder_count: 68863, trades24: 117526, last_traded_at: '2026-09-16T20:24:51.000Z',
                first_seen_at: '2026-09-16T20:27:15.000Z', paused: false
            },
            {
                mint: 'MINT_B', symbol: 'GHOST', name: null, issuer_slug: 'remora-markets',
                issuer_name: null, health_status: null, worst_rule: null, liquidity_usd: null,
                premium_pct: null, venue_spread_pct: null, top1_share_pct: null,
                last_traded_at: null, paused: null
            }
        ];
    }

    const gaps = M.gapIndex({ items: [{ mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', gapPct: -1.4 }] });

    test('the API\'s snake_case row becomes a table row, in the order the API returned it', () => {
        const rows = M.tokenRowsFromApi(items(), gaps);
        expect(rows.map((row) => row.symbol)).toEqual(['SPYx', 'GHOST']);
        expect(rows[0]).toMatchObject({
            issuerName: 'Kraken xStocks',
            status: 'caution',
            marketStatus: 'warning',
            controlStatus: 'good',
            legalStatus: 'caution',
            composabilityStatus: 'caution',
            worstRuleLabel: 'Authority keys',
            liquidity: 5871523.44,
            premiumPct: -0.1795,
            venueSpreadPct: 1.3734,
            top1SharePct: 29.257,
            lastTradedAt: '2026-09-16T20:24:51.000Z'
        });
    });

    test('the after-hours gap is joined in by mint, and a mint that file lacks keeps a NULL gap', () => {
        const rows = M.tokenRowsFromApi(items(), gaps);
        expect(rows[0].gapPct).toBe(-1.4);
        expect(rows[1].gapPct).toBeNull();
        // Not 0: the gap only exists for mints with trades on both sides of the session boundary.
        expect(M.tokenRowsFromApi(items(), new Map())[0].gapPct).toBeNull();
    });

    test('every missing measurement stays null rather than becoming a zero in a cell', () => {
        const row = M.tokenRowsFromApi(items(), gaps)[1];
        expect(row.liquidity).toBeNull();
        expect(row.premiumPct).toBeNull();
        expect(row.top1SharePct).toBeNull();
        expect(row.worstRuleLabel).toBeNull();
        expect(row.lastTradedAt).toBeNull();
    });

    test('a status the API does not report is `unknown`, never silently treated as good', () => {
        expect(M.tokenRowsFromApi(items(), gaps)[1].status).toBe('unknown');
        expect(M.tokenRowsFromApi(items(), gaps)[1].marketStatus).toBe('unknown');
        expect(M.tokenRowsFromApi([{ mint: 'M', health_status: 'splendid' }], gaps)[0].status).toBe('unknown');
    });

    test('an issuer the API has no name for is humanized rather than left blank', () => {
        expect(M.tokenRowsFromApi(items(), gaps)[1].issuerName).toBe('Remora markets');
    });

    test('a rule id the labels do not know is shown as the id, not as a dash', () => {
        expect(M.tokenRowsFromApi([{ mint: 'M', worst_rule: 'newRule' }], gaps)[0].worstRuleLabel).toBe('newRule');
    });

    test('no items, and no after-hours file, yields no rows and throws nothing', () => {
        expect(M.tokenRowsFromApi(null, null)).toEqual([]);
        expect(M.gapIndex(null)).toEqual(new Map());
    });
});

// -------------------------------------------------------------- card links

describe('cardHref', () => {
    test('the card is named from the symbol, which is what the card builder starts from', () => {
        expect(M.cardHref('AAPLx', 'MINT_A')).toBe('./cards/AAPLx.html');
    });

    test('a symbol that is not path-safe is sanitised rather than written into a URL raw', () => {
        expect(M.cardHref('A B/C', 'MINT_A')).toBe('./cards/A-B-C.html');
        expect(M.cardHref('../etc/passwd', 'MINT_A')).toBe('./cards/etc-passwd.html');
    });

    test('neither a symbol nor a mint means no link at all, rather than ./cards/.html', () => {
        expect(M.cardHref(null, null)).toBeNull();
        expect(M.cardHref('', '')).toBeNull();
    });

    test('the helper uses each build-assigned slug, including symbol collisions', () => {
        // The API and built feeds carry this slug, so the page does not need to fetch the whole
        // card index just to resolve the colliding symbols.
        const { readFileSync, existsSync } = require('node:fs');
        const { join } = require('node:path');
        const index = JSON.parse(readFileSync(join(__dirname, 'cards/index.json'), 'utf8'));
        expect(index.length).toBeGreaterThan(400);
        const wrong = index.filter((card) => M.cardHref(card.symbol, card.mint, card.slug) !== `./cards/${card.slug}.html`);
        expect(wrong).toEqual([]);
        expect(index.filter((card) => /-[A-Za-z0-9]{6}$/.test(card.slug)).length).toBeGreaterThan(0);
        const missing = index.filter((card) => !existsSync(join(__dirname, 'cards', `${card.slug}.html`)));
        expect(missing).toEqual([]);
    });
});

// ------------------------------------------------------------- change log

describe('groupChanges and dayCounts', () => {
    const kinds = [
        { id: 'paused', label: 'Trading paused' },
        { id: 'liquidity-drop', label: 'Pool liquidity halved or worse' },
        { id: 'spread-wide', label: 'Venue spread crossed 5 %' }
    ];
    const changes = [
        { kind: 'spread-wide', mint: 'MINT_D', symbol: 'SPCXx', field: 'venueSpreadPct', before: 4.8, after: 5.3, note: 'crossed' },
        { kind: 'paused', mint: 'MINT_A', symbol: 'AAPLx', field: 'paused', before: false, after: true, note: 'paused' },
        { kind: 'spread-wide', mint: 'MINT_B', symbol: 'TSLAx', field: 'venueSpreadPct', before: 4.9, after: 6.1, note: 'crossed' }
    ];

    test('groups in the order the DIFF declares, not in the order the changes arrived', () => {
        const groups = M.groupChanges(changes, kinds);
        expect(groups.map((group) => group.id)).toEqual(['paused', 'spread-wide']);
        expect(groups.map((group) => group.label)).toEqual(['Trading paused', 'Venue spread crossed 5 %']);
        expect(groups[1].items.map((change) => change.symbol)).toEqual(['SPCXx', 'TSLAx']);
    });

    test('a kind with no changes gets no section', () => {
        expect(M.groupChanges(changes, kinds).some((group) => group.id === 'liquidity-drop')).toBe(false);
    });

    test('a kind the file does not declare is still shown, at the end, rather than dropped silently', () => {
        const groups = M.groupChanges([...changes, { kind: 'brand-new-kind', mint: 'M', symbol: 'X' }], kinds);
        const last = groups[groups.length - 1];
        expect(last.id).toBe('brand-new-kind');
        expect(last.label).toBe('Brand new kind');
    });

    test('no kinds published at all still groups every change rather than showing none', () => {
        const groups = M.groupChanges(changes, null);
        expect(groups.map((group) => group.id).sort()).toEqual(['paused', 'spread-wide']);
        expect(groups.reduce((sum, group) => sum + group.items.length, 0)).toBe(3);
    });

    test('dayCounts totals each pair and names the kinds, oldest first', () => {
        const days = M.dayCounts([
            { from: '2026-09-15', to: '2026-09-16', counts: { paused: 1, 'liquidity-drop': 2 } },
            { from: '2026-09-16', to: '2026-09-17', counts: {} }
        ]);
        expect(days).toHaveLength(2);
        expect(days[0]).toMatchObject({ from: '2026-09-15', to: '2026-09-16', total: 3 });
        expect(days[0].counts).toEqual([{ kind: 'paused', count: 1 }, { kind: 'liquidity-drop', count: 2 }]);
        expect(days[1].total).toBe(0);
        expect(days[1].counts).toEqual([]);
    });

    test('an absent history is an empty strip', () => {
        expect(M.dayCounts(null)).toEqual([]);
        expect(M.dayCounts([])).toEqual([]);
    });

    test('large groups begin as a bounded digest and retain every hidden row', () => {
        const rows = Array.from({ length: 20 }, (_, i) => ({ mint: `MINT_${i}` }));
        const split = M.splitDisplayRows(rows);
        expect(split.visible).toHaveLength(M.CHANGE_GROUP_DISPLAY_LIMIT);
        expect(split.hidden).toHaveLength(20 - M.CHANGE_GROUP_DISPLAY_LIMIT);
        expect([...split.visible, ...split.hidden]).toEqual(rows);
    });
});

describe('DeFi protocol change feed', () => {
    const document = {
        kinds: [
            { id: 'token-added', label: 'Token added to protocol', severity: 'info' },
            { id: 'token-removed', label: 'Token removed from protocol', severity: 'warning' },
            { id: 'ltv-changed', label: 'Maximum LTV changed', severity: 'caution' },
            { id: 'market-inactive', label: 'Market became inactive', severity: 'warning' },
            { id: 'collateral-value-drop', label: 'Collateral value fell sharply', severity: 'caution' }
        ],
        latest: {
            from: '2026-09-18', to: '2026-09-19',
            events: [
                { kind: 'token-removed', mint: 'MINT_A', symbol: 'AAPLx', protocolName: 'Kamino', before: 'live', after: null },
                { kind: 'ltv-changed', mint: 'MINT_B', symbol: 'TSLAx', protocolName: 'Jupiter Lend', before: { min: 0.5, max: 0.5 }, after: { min: 0.6, max: 0.65 } }
            ]
        }
    };

    test('builds visible counts for every watched kind and keeps declared group order', () => {
        const view = M.defiChangeView(document);
        expect(view).toMatchObject({ baseline: false, from: '2026-09-18', to: '2026-09-19', total: 2, selectedKind: null });
        expect(view.filters.map((filter) => [filter.id, filter.count])).toEqual([
            [null, 2], ['token-added', 0], ['token-removed', 1], ['ltv-changed', 1],
            ['market-inactive', 0], ['collateral-value-drop', 0]
        ]);
        expect(view.groups.map((group) => group.id)).toEqual(['token-removed', 'ltv-changed']);
    });

    test('filters locally without dropping the exact token evidence', () => {
        const view = M.defiChangeView(document, 'ltv-changed');
        expect(view.groups).toHaveLength(1);
        expect(view.groups[0].items[0].mint).toBe('MINT_B');
        expect(M.defiChangeDetail(view.groups[0].items[0])).toBe('Maximum LTV 50.0% → 60.0%–65.0%');
    });

    test('an unknown filter falls back to all, and a first snapshot is explicitly a baseline', () => {
        expect(M.defiChangeView(document, 'invented').selectedKind).toBeNull();
        expect(M.defiChangeView({ latest: null, kinds: document.kinds })).toMatchObject({ baseline: true, total: 0, groups: [] });
    });

    test('collateral and status evidence get readable units rather than raw JSON', () => {
        expect(M.defiChangeDetail({ kind: 'collateral-value-drop', before: 1_000_000, after: 700_000, dropPct: 30 }))
            .toBe('Reported collateral $1.00M → $700.0k (30.0% down)');
        expect(M.defiChangeDetail({ kind: 'market-inactive', before: 'live', after: 'available' }))
            .toBe('Observed status live → available');
    });
});

// ------------------------------------------------------------------ events

describe('sortEvents', () => {
    test('newest first, whatever order the file is in', () => {
        const out = M.sortEvents([
            { date: '2026-01-28', kind: 'governance' },
            { date: '2026-09-16', kind: 'pause' },
            { date: '2026-06-12', kind: 'shortfall' }
        ]);
        expect(out.map((event) => event.date)).toEqual(['2026-09-16', '2026-06-12', '2026-01-28']);
    });

    test('does not mutate the array it was handed, and drops nothing but non-objects', () => {
        const input = [{ date: '2026-01-01' }, null, { date: '2026-02-01' }];
        const out = M.sortEvents(input);
        expect(input[0].date).toBe('2026-01-01');
        expect(out).toHaveLength(2);
        expect(M.sortEvents(null)).toEqual([]);
    });
});

// ----------------------------------------------------------- Meteora pools

describe('meteoraRows', () => {
    function meteora() {
        return {
            items: [
                {
                    mint: 'MINT_A', symbol: 'AAPLx', issuer: 'xstocks-backed', pairAddress: 'PAIR_A',
                    dexId: 'meteora', poolType: 'dlmm', binStep: 80, baseFeePct: 0.1, maxFeePct: 0, dynamicFeePct: 0.0048,
                    liquidityUsd: 2426800, volume24Usd: 2629890, fees24Usd: 2437.9, priceUsd: 253.05,
                    quoteSymbol: 'USDC', dexscreener: { liquidityUsd: 2417756, volume24Usd: 1769347, txns24: 1858 },
                    curve: null, error: null
                },
                {
                    mint: 'MINT_B', symbol: 'TSLAx', issuer: 'xstocks-backed', pairAddress: 'PAIR_B',
                    dexId: 'meteora', poolType: 'dlmm', binStep: 20, baseFeePct: 0.2,
                    liquidityUsd: 4459042, volume24Usd: 2969379, fees24Usd: 5370, priceUsd: 430,
                    quoteSymbol: 'USDC', dexscreener: {}, curve: null, error: null
                },
                {
                    mint: 'MINT_C', symbol: 'AAPLon', issuer: 'ondo-global-markets', pairAddress: 'PAIR_C',
                    dexId: 'meteoradbc', poolType: 'dbc', binStep: null, baseFeePct: null,
                    liquidityUsd: null, volume24Usd: null, fees24Usd: null, priceUsd: null,
                    quoteSymbol: 'AU', dexscreener: { liquidityUsd: null, volume24Usd: 0, txns24: 2 },
                    curve: {
                        address: 'PAIR_C',
                        tokenX: { symbol: 'AU' }, tokenY: { symbol: 'AAPLon' },
                        account: { exists: true, owner: 'dbcij', dataLength: 424, isDbcProgram: true },
                        curveState: null, migrated: null,
                        note: 'the pool account layout was NOT decoded'
                    },
                    error: null
                }
            ]
        };
    }

    function trades() {
        return {
            pools: [
                { pair: 'PAIR_A', mint: 'MINT_A', signaturesSeen: 50, failedTx: 19, decoded: 0 },
                { pair: 'PAIR_C', mint: 'MINT_C', signaturesSeen: 0, failedTx: 0, decoded: 0 }
            ],
            trades: [
                { pair: 'PAIR_A', time: '2026-09-16T22:00:00Z', mint: 'MINT_A' },
                { pair: 'PAIR_A', time: '2026-09-16T22:47:35Z', mint: 'MINT_A' },
                { pair: 'PAIR_A', time: '2026-09-16T21:00:00Z', mint: 'MINT_A' }
            ]
        };
    }

    function pools() {
        return M.meteoraRows({ meteora: meteora(), tokens: tokens(), trades: trades() });
    }

    test('one row per pool, largest liquidity first, the unmeasured pool last', () => {
        expect(pools().map((pool) => pool.symbol)).toEqual(['TSLAx', 'AAPLx', 'AAPLon']);
    });

    test('carries the Meteora-only facts DexScreener does not report', () => {
        const pool = pools().find((p) => p.symbol === 'AAPLx');
        expect(pool).toMatchObject({
            poolType: 'dlmm', binStep: 80, baseFeePct: 0.1, dynamicFeePct: 0.0048,
            liquidityUsd: 2426800, volume24Usd: 2629890, fees24Usd: 2437.9,
            dexscreenerLiquidityUsd: 2417756
        });
    });

    test('premium is the pool price against the token reference price, in per cent', () => {
        // 253.05 against a 241 reference is +5.0 %.
        expect(pools().find((p) => p.symbol === 'AAPLx').premiumPct).toBeCloseTo(5.0, 1);
        // 430 against a 430 reference is exactly flat — a real 0, not a missing value.
        expect(pools().find((p) => p.symbol === 'TSLAx').premiumPct).toBe(0);
    });

    test('a pool with no price, or a token with no reference price, has a NULL premium not a 0 %', () => {
        expect(pools().find((p) => p.symbol === 'AAPLon').premiumPct).toBeNull();
        const noRef = M.meteoraRows({
            meteora: meteora(),
            tokens: { tokens: [{ mint: 'MINT_A', reference: { price: null } }] },
            trades: trades()
        });
        expect(noRef.find((p) => p.mint === 'MINT_A').premiumPct).toBeNull();
    });

    test('the failed share is the reverted portion of the sampled signatures', () => {
        const pool = pools().find((p) => p.symbol === 'AAPLx');
        expect(pool.signaturesSeen).toBe(50);
        expect(pool.failedTx).toBe(19);
        expect(pool.failedShare).toBe(38);
    });

    test('a pool the collector never reached shows a NULL failed share, never 0 %', () => {
        // TSLAx has no pools[] entry at all; AAPLon has one that sampled zero signatures.
        expect(pools().find((p) => p.symbol === 'TSLAx').failedShare).toBeNull();
        expect(pools().find((p) => p.symbol === 'AAPLon').failedShare).toBeNull();
    });

    test('the last trade is the newest trade on that pool, and null when there is none', () => {
        expect(pools().find((p) => p.symbol === 'AAPLx').lastTradeAt).toBe('2026-09-16T22:47:35Z');
        expect(pools().find((p) => p.symbol === 'TSLAx').lastTradeAt).toBeNull();
    });

    test('no Meteora file is no rows, not a crash', () => {
        expect(M.meteoraRows()).toEqual([]);
        expect(M.meteoraRows({ meteora: { items: [] }, tokens: tokens(), trades: trades() })).toEqual([]);
    });
});

describe('curveSummary', () => {
    test('reports existence, the owning program and the data length — and says the state is undecoded', () => {
        const summary = M.curveSummary({
            address: 'PAIR_C',
            tokenX: { symbol: 'AU' }, tokenY: { symbol: 'TSMon' },
            account: { exists: true, dataLength: 424, isDbcProgram: true },
            curveState: null, migrated: null,
            note: 'layout was NOT decoded'
        });
        expect(summary.text).toBe('curve account exists · 424 bytes of state · owned by the DBC program · state not decoded');
        expect(summary.pairName).toBe('AU / TSMon');
        expect(summary.note).toBe('layout was NOT decoded');
    });

    test('never implies a progress figure nobody read', () => {
        const summary = M.curveSummary({ account: { exists: true }, curveState: null });
        expect(summary.text).not.toMatch(/%|progress|threshold/i);
        expect(summary.text).toMatch(/state not decoded/);
    });

    test('a decoded state and a migration flag are reported when they are actually there', () => {
        const summary = M.curveSummary({ account: { exists: true }, curveState: { reserve: 1 }, migrated: true });
        expect(summary.text).toMatch(/state decoded/);
        expect(summary.text).toMatch(/migrated/);
    });

    test('a pool with no curve record has no curve line', () => {
        expect(M.curveSummary(null)).toBeNull();
        expect(M.curveSummary('nonsense')).toBeNull();
    });
});

// ------------------------------------------------- the "New on Solana" strip

describe('newMintChips', () => {
    const NOW = Date.parse('2026-09-17T11:50:27Z');

    /** A stocks-changes.json `newMints[]` row as build-changes.mjs writes it. */
    function feedRow(overrides = {}) {
        return {
            mint: 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES',
            symbol: 'AMD',
            name: 'Advanced Micro Devices - Backpack Securities',
            issuer: 'backpack-securities',
            issuerName: 'Backpack Securities',
            firstSeenAt: '2026-09-17T09:50:27Z',
            cardSlug: 'AMD',
            ...overrides
        };
    }

    test('shapes one chip per row, in the order the feed selected them', () => {
        const chips = M.newMintChips({
            newMints: [
                feedRow({ symbol: 'AMD', firstSeenAt: '2026-09-17T09:50:27Z' }),
                feedRow({ symbol: 'LUV', mint: 'LUV9', cardSlug: 'LUV', firstSeenAt: '2026-09-16T23:00:00Z' })
            ]
        }, NOW);
        expect(chips.map((chip) => chip.symbol)).toEqual(['AMD', 'LUV']);
        expect(chips[0].issuer).toBe('Backpack Securities');
        expect(chips[0].href).toBe('./cards/AMD.html');
        expect(chips[0].title).toContain('first seen 17 Sep 2026 09:50 UTC');
    });

    test('the age is relative to the instant passed in, not to the wall clock', () => {
        const [chip] = M.newMintChips({ newMints: [feedRow()] }, NOW);
        expect(chip.firstSeen).toBe('2 h ago');
        const [later] = M.newMintChips({ newMints: [feedRow()] }, Date.parse('2026-09-19T09:50:27Z'));
        expect(later.firstSeen).toBe('2 d ago');
    });

    test('no firstSeenAt leaves the age null rather than reading as "just now"', () => {
        const [chip] = M.newMintChips({ newMints: [feedRow({ firstSeenAt: null })] }, NOW);
        expect(chip.firstSeen).toBeNull();
        expect(chip.firstSeenAt).toBeNull();
        expect(chip.title).not.toMatch(/first seen/);
    });

    test('no cardSlug means no link, so a chip never points at a card the build did not write', () => {
        const [chip] = M.newMintChips({ newMints: [feedRow({ cardSlug: null })] }, NOW);
        expect(chip.href).toBeNull();
        expect(chip.symbol).toBe('AMD');
    });

    test('an issuer with no display name falls back to the readable slug, never to a bare null', () => {
        const [chip] = M.newMintChips({ newMints: [feedRow({ issuerName: null, issuer: 'ondo-global-markets' })] }, NOW);
        expect(chip.issuer).toBe('Ondo global markets');
        const [none] = M.newMintChips({ newMints: [feedRow({ issuerName: null, issuer: null })] }, NOW);
        expect(none.issuer).toBeNull();
    });

    test('a missing file, a missing feed or an unusable row yields nothing, so the strip stays hidden', () => {
        expect(M.newMintChips(null, NOW)).toEqual([]);
        expect(M.newMintChips({}, NOW)).toEqual([]);
        expect(M.newMintChips({ newMints: 'nonsense' }, NOW)).toEqual([]);
        expect(M.newMintChips({ newMints: [null, 'x', {}, { symbol: '  ' }] }, NOW)).toEqual([]);
    });

    test('a row with only a mint still shows, labelled by the mint', () => {
        const chips = M.newMintChips({ newMints: [{ mint: 'MINT_ONLY' }] }, NOW);
        expect(chips).toHaveLength(1);
        expect(chips[0].symbol).toBe('MINT_ONLY');
    });

    test('the window comes from the feed, and falls back to a fortnight', () => {
        expect(M.newMintsWindowDays({ newMintWindowDays: 7 })).toBe(7);
        expect(M.newMintsWindowDays({ newMintWindowDays: 0 })).toBe(M.NEW_MINTS_WINDOW_DAYS);
        expect(M.newMintsWindowDays({ newMintWindowDays: 'lots' })).toBe(M.NEW_MINTS_WINDOW_DAYS);
        expect(M.newMintsWindowDays(null)).toBe(14);
        expect(M.NEW_MINTS_DISPLAY_LIMIT).toBe(24);
    });
});

describe('the strip markup and styles the page needs', () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const html = readFileSync(join(__dirname, 'monitor.html'), 'utf8');
    const css = readFileSync(join(__dirname, 'stocks.css'), 'utf8');

    test('monitor.html carries the strip, hidden until the feed fills it, plus the header count', () => {
        expect(html).toMatch(/<section id="newMints"[^>]*hidden/);
        expect(html).toContain('id="newMintsTrack"');
        expect(html).toContain('id="newMintsClone"');
        expect(html).toMatch(/<span id="newMintsSummary"[\s\S]{0,120}hidden/);
        expect(html).toContain('href="#newMints"');
    });

    test('the complete list is explicitly disclosed rather than duplicated for a moving strip', () => {
        expect(html).toContain('Show every recent addition');
        expect(html).not.toContain('new-mints-marquee');
    });

    test('stocks.css lays out a bounded static preview and an on-demand complete list', () => {
        expect(css).toMatch(/\.new-mints-preview\s*\{[^}]*display:\s*grid/);
        expect(css).toContain('.new-mints-all');
    });

    test('monitor.js sets the reduced-motion class from the media query and the URL flag', () => {
        const source = readFileSync(join(__dirname, 'monitor.js'), 'utf8');
        expect(source).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
        expect(source).toContain("has('reduceMotion')");
        expect(source).toContain("classList.add('reduce-motion')");
    });
});

// ------------------------------------------------- the explorer markup and styles

describe('the explorer markup and styles the page needs', () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const html = readFileSync(join(__dirname, 'monitor.html'), 'utf8');
    const css = readFileSync(join(__dirname, 'monitor.css'), 'utf8');

    test('every element monitor.js looks up by id is in the page', () => {
        // boot() fetches these by id and would silently render nothing if one were renamed.
        for (const id of [
            'facetPanel', 'activeFilters', 'filterChips', 'clearFilters', 'searchFilter',
            'tokenTableWrap', 'tableMessage', 'tokenTable', 'tokenBody', 'tokenCount',
            'tokenPager', 'pageLabel', 'prevPage', 'nextPage', 'statusTiles', 'ruleStrip',
            'dataAsOf', 'snapshotDate', 'tokenTotal', 'defiChangeRange', 'defiChangeFilters',
            'defiChangeGroups'
        ]) {
            expect(html).toContain(`id="${id}"`);
        }
    });

    test('the daily protocol feed is loaded and has a machine-readable evidence link', () => {
        const source = readFileSync(join(__dirname, 'monitor.js'), 'utf8');
        expect(source).toContain("defiChanges: './stocks-defi-changes.json'");
        expect(html).toContain('href="./stocks-defi-changes.json"');
        expect(html).toContain('id="defiChangesSection"');
    });

    test('the API base helper is loaded before monitor.js, which needs it at boot', () => {
        const base = html.indexOf('stocks/lib/api-base.js');
        const monitor = html.indexOf('monitor.js?v=');
        expect(base).toBeGreaterThan(-1);
        expect(base).toBeLessThan(monitor);
    });

    test('the chip row and the pager start hidden, so neither flashes empty on load', () => {
        expect(html).toMatch(/<div id="activeFilters"[^>]*hidden/);
        expect(html).toMatch(/<div id="tokenPager"[^>]*hidden/);
        expect(html).toMatch(/<p id="tableMessage"[^>]*hidden/);
    });

    test('a flex row that is hidden actually disappears', () => {
        // Found in the browser: `display: flex` is an AUTHOR rule and the browser's own
        // `[hidden] { display: none }` is not, so the empty chip row kept showing its "Clear all"
        // button on an unfiltered page. Both flex rows need the explicit rule.
        expect(css).toMatch(/\.mon-active-filters\[hidden\],\s*\n\s*\.mon-pager\[hidden\]\s*\{\s*\n\s*display: none;/);
    });

    test('the facet panel is a sidebar on a wide screen and stacks above the table on a phone', () => {
        // The panel is FIRST in the markup, so the single-column layout needs no re-ordering.
        expect(html.indexOf('id="facetPanel"')).toBeLessThan(html.indexOf('id="tokenTable"'));
        expect(css).toMatch(/\.mon-explorer\s*\{[\s\S]*?grid-template-columns:[^;]*minmax\(0, 1fr\)/);
        expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.mon-explorer\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
    });

    test('no colour is forced with !important, and every one comes from a custom property', () => {
        expect(css).not.toContain('!important');
        const added = css.slice(css.indexOf('.mon-explorer'), css.indexOf('/* --- token table extras'));
        expect(added).toMatch(/var\(--panel-border\)/);
        expect(added).not.toMatch(/:\s*#[0-9a-fA-F]{3,6}/);
    });
});
