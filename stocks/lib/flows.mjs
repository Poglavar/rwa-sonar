// Shapes the creation/redemption flows and the xStocks public float for flows.html
// (stocks/build-flows.mjs → stocks-flows.json). Pure: inputs are the parsed observation, float,
// catalogue and snapshot files; tests in stocks/flows.test.js.
//
// The rule everything follows: a number means something only over COVERAGE. A day the observer did
// not read is `missing`, never 0; a day it read partly says how many hours; an amount the
// transaction did not show, or a dollar value nothing priced, stays null and is counted as such.

import { coveredHoursOn, mergeIntervals } from './redemption-feed.mjs';
import { toUnits } from './xstocks-float.mjs';

export const FLOW_DAYS = 14;
const DAY_MS = 86400000;
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const round = (x, digits = 2) => (finite(x) ? Math.round(x * 10 ** digits) / 10 ** digits : null);

/** What each programme's flows count, where the coverage comes from, and what is not collected. */
export const PROGRAMMES = [
    {
        slug: 'xstocks-backed', name: 'xStocks (Backed)',
        redeemed: { counted: true, countField: ['deposits'], coverageAddress: 'CgyuW2dWDJzWW2H1XTjPRkbg9Y41dW2Fjj69KWsiir8C',
            what: 'Holder transfers to the issuer redemption address CgyuW2…, which the issuer sweeps into its treasury (the prospectus calls this "de-activation"). Every deposit counts, whether or not the stablecoin payout leg could be paired.' },
        created: { counted: false,
            why: 'Issuance "activates" pre-created tokens by transferring them out of the issuer treasury S7vYFF…, which signs well over a thousand transactions a day; reading all of them would roughly double the observer\'s RPC budget, so it is not collected yet. The public-float table shows the net change between daily reads instead.' }
    },
    {
        slug: 'ondo-global-markets', name: 'Ondo Global Markets',
        redeemed: { counted: true, countField: ['redemptions', 'intermediated'], coverageAddress: 'XzTT4XB8m7sLD2xi6snefSasaswsKCxx5Tifjondogm',
            what: 'RedeemForUsdc / RedeemForUsdon burns by the Ondo GM program, direct and through intermediary (solver) programs. Direct redemptions are valued at the stablecoin paid out in the same transaction.' },
        created: { counted: true, countField: ['mints'], coverageAddress: 'XzTT4XB8m7sLD2xi6snefSasaswsKCxx5Tifjondogm',
            what: 'MintWithUsdc / MintWithUsdon subscriptions: GM units minted by the program\'s mint-authority PDA, valued at the stablecoin paid in the same transaction.' }
    },
    {
        slug: 'superstate-opening-bell', name: 'Superstate Opening Bell',
        redeemed: { counted: true, countField: ['redemptions'], coverageAddress: null,
            what: 'Issuer burns at the published equity burn address: the token converts back to book-entry shares at the transfer agent and no cash is paid.' },
        created: { counted: false,
            why: 'Conversions from book-entry shares into tokens are issuer mints the observer does not read (it watches the burn address only).' }
    }
];

/** The last `days` UTC dates ending on `now`'s date, oldest first. */
export function dayWindow(now, days = FLOW_DAYS) {
    const end = Date.parse(`${String(now).slice(0, 10)}T00:00:00Z`);
    return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

/** Clip coverage to start at `from` (null = unclipped). */
export function clipCoverage(list, from) {
    if (from === null || from === undefined) return mergeIntervals(list);
    const f = Date.parse(from);
    return mergeIntervals(list).filter((i) => Date.parse(i.to) > f)
        .map((i) => (Date.parse(i.from) < f ? { from: from, to: i.to } : i));
}

function coverageFor(entry, address) {
    if (address) return mergeIntervals(entry.addresses?.[address]?.coverage ?? []);
    return mergeIntervals(entry.coverage ?? []);
}

/**
 * Value one direction's per-mint cells for one day. Each cell carries units and the USD the
 * observer could attach (a stablecoin leg or the DEX tape); the remainder is priced with
 * `priceFor(mint, day)` → {usdPerUnit, source} or null. Units no price covers stay unpriced: the
 * day's `usd` is then a LOWER BOUND and `complete` is false.
 */
export function valueCells(cells, day, { priceFor, symbolOf }) {
    let usd = 0;
    let complete = true;
    let events = 0;
    let unmeasured = 0;
    const sources = {};
    const unpricedMints = [];
    const byMint = [];
    for (const [mint, cell] of Object.entries(cells ?? {})) {
        events += cell.n ?? 0;
        unmeasured += cell.unmeasured ?? 0;
        if ((cell.unmeasured ?? 0) > 0) complete = false;
        const units = finite(cell.units) ? cell.units : 0;
        let value = finite(cell.usd) ? cell.usd : 0;
        for (const [src, n] of Object.entries(cell.priced ?? {})) sources[src] = (sources[src] ?? 0) + n;
        const rest = units - (finite(cell.usdUnits) ? cell.usdUnits : 0);
        let priced = true;
        if (rest > 1e-12) {
            const p = priceFor(mint, day);
            if (p && finite(p.usdPerUnit)) {
                value += rest * p.usdPerUnit;
                sources[p.source] = (sources[p.source] ?? 0) + 1;
            } else {
                priced = false;
                complete = false;
                unpricedMints.push(symbolOf(mint) ?? mint);
            }
        }
        usd += value;
        byMint.push({ mint, symbol: symbolOf(mint), events: cell.n ?? 0, units: round(units, 6), usd: priced ? round(value) : null, pricedUsd: round(value) });
    }
    byMint.sort((a, b) => (b.pricedUsd ?? 0) - (a.pricedUsd ?? 0));
    return { events, unmeasured, usd: round(usd), complete, sources, unpricedMints: unpricedMints.slice(0, 10), unpricedMintCount: unpricedMints.length, top: byMint.slice(0, 5), mints: byMint.length };
}

function sumCounts(dayCounts, fields) {
    if (!dayCounts) return 0;
    return fields.reduce((n, f) => n + (finite(dayCounts[f]) ? dayCounts[f] : 0), 0);
}

/**
 * One issuer's daily series. For each direction: `coveredHours` (count coverage) and
 * `amountHours` (coverage with amounts recorded — amounts began at the entry's `flowsFrom`), the
 * transaction `count` (null when the day is not covered) and `value` (null when no amounts were
 * recorded that day). `net` = created − redeemed USD, only when both sides are counted, covered for
 * the whole day with amounts and fully priced.
 */
export function issuerSeries(entry, programme, days, { priceFor, symbolOf }) {
    const amountsRecorded = entry && Object.prototype.hasOwnProperty.call(entry, 'flowsFrom');
    const direction = (key) => {
        const spec = programme[key];
        if (!spec.counted) return null;
        const countCoverage = coverageFor(entry, spec.coverageAddress);
        const amountCoverage = amountsRecorded ? clipCoverage(countCoverage, entry.flowsFrom) : [];
        return { spec, countCoverage, amountCoverage };
    };
    const sides = { created: direction('created'), redeemed: direction('redeemed') };
    const rows = days.map((day) => {
        const row = { date: day };
        for (const [key, side] of Object.entries(sides)) {
            if (!side) { row[key] = null; continue; }
            const coveredHours = coveredHoursOn(side.countCoverage, day);
            const amountHours = coveredHoursOn(side.amountCoverage, day);
            const counts = entry.daily?.[day] ?? null;
            row[key] = {
                coveredHours,
                amountHours,
                count: coveredHours > 0 ? sumCounts(counts, side.spec.countField) : null,
                value: amountHours > 0 ? valueCells(counts?.flows?.[key] ?? {}, day, { priceFor, symbolOf }) : null
            };
        }
        const c = row.created;
        const r = row.redeemed;
        const whole = (s) => s && s.amountHours >= 24 && s.value && s.value.complete;
        row.netUsd = whole(c) && whole(r) ? round(c.value.usd - r.value.usd) : null;
        return row;
    });
    return rows;
}

/** Everything the page's flows section needs, per programme, plus the not-observable ones. */
export function buildFlows(observations, { now, days = FLOW_DAYS, priceFor, symbolOf, source = 'stocks/data/redemption-observations.json' }) {
    const window = dayWindow(now, days);
    const issuers = [];
    for (const programme of PROGRAMMES) {
        const entry = observations?.issuers?.[programme.slug] ?? null;
        if (!entry) {
            issuers.push({ slug: programme.slug, name: programme.name, state: 'no-observation-file', days: [] });
            continue;
        }
        const scan = entry.lastScan ?? null;
        issuers.push({
            slug: programme.slug,
            name: programme.name,
            state: scan?.status === 'failed' ? 'scan-failed' : 'observed',
            lastScanAt: scan?.at ?? null,
            lastScanStatus: scan?.status ?? null,
            lastScanError: scan?.error ?? null,
            amountsFrom: Object.prototype.hasOwnProperty.call(entry, 'flowsFrom') ? (entry.flowsFrom ?? 'first-coverage') : null,
            coveredFrom: mergeIntervals(entry.coverage ?? [])[0]?.from ?? null,
            coveredThrough: mergeIntervals(entry.coverage ?? []).at(-1)?.to ?? null,
            created: { counted: programme.created.counted, what: programme.created.what ?? null, why: programme.created.why ?? null },
            redeemed: { counted: programme.redeemed.counted, what: programme.redeemed.what ?? null, why: programme.redeemed.why ?? null },
            days: issuerSeries(entry, programme, window, { priceFor, symbolOf })
        });
    }
    const notObservable = Object.values(observations?.issuers ?? {}).filter((e) => e.observable === false)
        .map((e) => ({ slug: e.slug, mechanism: e.mechanism ?? null, why: e.whyNotObservable ?? null, checkedAt: e.lastScan?.at ?? null }));
    return {
        window,
        source,
        observedAt: observations?.generatedAt ?? null,
        lastRun: observations?.lastRun ? { status: observations.lastRun.status, startedAt: observations.lastRun.startedAt, endedAt: observations.lastRun.endedAt } : null,
        issuers,
        notObservable
    };
}

/**
 * A price per on-chain unit (base units / 10^decimals, BEFORE the scaled-UI multiplier) for `mint`
 * on `day`, from that day's snapshot (stocks/data/history/<day>/tokens.json: marketValueUsd over
 * supply), else from the catalogue when its market price was observed that same day. Null when
 * neither exists: a different day's price is not the day's price.
 */
export function makePriceFor({ snapshots, tokensByMint, catalogueDay }) {
    return (mint, day) => {
        const token = tokensByMint.get(mint) ?? null;
        const decimals = Number.isInteger(token?.decimals) ? token.decimals : null;
        const snap = snapshots.get(day)?.get(mint) ?? null;
        if (snap && decimals !== null && finite(snap.marketValueUsd) && snap.marketValueUsd > 0 && typeof snap.supplyRaw === 'string' && snap.supplyRaw !== '0') {
            return { usdPerUnit: snap.marketValueUsd / (Number(snap.supplyRaw) / 10 ** decimals), source: 'daily-snapshot' };
        }
        const price = token?.market?.usdPrice;
        const multiplier = Number(token?.uiMultiplier ?? 1);
        if (day === catalogueDay && finite(price) && price > 0 && Number.isFinite(multiplier)) {
            return { usdPerUnit: price * multiplier, source: 'same-day-catalogue' };
        }
        return null;
    };
}

/**
 * The public-float section: aggregate, top tokens by float value (priced with the catalogue's
 * market price, observation time carried), the change since the previous day's read and the
 * issuer's own all-chain circulating figure from its proof-of-reserves feed as a cross-check.
 */
export function buildFloat(floatFile, { tokensByMint, por = new Map(), porFetchedAt = null, priceObservedAt = null, top = 25 }) {
    if (!floatFile || !Array.isArray(floatFile.items)) return null;
    const prev = floatFile.previous?.floats ?? {};
    const rows = floatFile.items.map((item) => {
        const token = tokensByMint.get(item.mint) ?? null;
        const price = token?.market?.usdPrice;
        const units = (raw) => toUnits(raw, item.decimals, item.uiMultiplier);
        const floatUi = item.status === 'ok' ? units(item.floatRaw) : null;
        const prevUi = typeof prev[item.mint] === 'string' ? units(prev[item.mint]) : null;
        const p = por.get(item.symbol) ?? null;
        const porCirculating = p && Number.isFinite(Number(p.circulatingSupply)) ? Number(p.circulatingSupply) : null;
        return {
            mint: item.mint,
            symbol: item.symbol,
            status: item.status,
            supplyUi: round(units(item.supplyRaw), 4),
            inventoryUi: round(units(item.inventoryRaw), 4),
            floatUi: round(floatUi, 4),
            inventorySharePct: item.inventorySharePct,
            priceUsd: finite(price) && price > 0 ? round(price, 4) : null,
            floatUsd: finite(price) && price > 0 && floatUi !== null ? Math.round(floatUi * price) : null,
            inventoryUsd: finite(price) && price > 0 && item.status === 'ok' ? Math.round(units(item.inventoryRaw) * price) : null,
            floatChangeUi: floatUi !== null && prevUi !== null ? round(floatUi - prevUi, 4) : null,
            porCirculatingAllChains: porCirculating,
            porAt: p?.timestamp ?? null,
            // Our Solana-only float above the issuer's all-chain circulating figure cannot both be right.
            floatExceedsPor: porCirculating !== null && floatUi !== null && floatUi > porCirculating * 1.001
        };
    });
    const priced = rows.filter((r) => r.floatUsd !== null).sort((a, b) => b.floatUsd - a.floatUsd);
    const unpricedWithFloat = rows.filter((r) => r.floatUsd === null && finite(r.floatUi) && r.floatUi > 0).length;
    const shares = rows.filter((r) => finite(r.inventorySharePct)).map((r) => r.inventorySharePct).sort((a, b) => a - b);
    const median = shares.length ? (shares.length % 2 ? shares[(shares.length - 1) / 2] : (shares[shares.length / 2 - 1] + shares[shares.length / 2]) / 2) : null;
    return {
        readAt: floatFile.readAt,
        slots: floatFile.slots ?? null,
        method: floatFile.method ?? null,
        attributionCaveat: floatFile.attributionCaveat ?? null,
        wallets: (floatFile.wallets ?? []).map((w) => ({ address: w.address, role: w.role, basis: w.basis, dossierCitations: w.dossierCitations ?? null,
            dossierPaths: w.dossierPaths ?? [], xstockAccountsWithBalance: w.xstockAccountsWithBalance ?? null })),
        totals: floatFile.totals ?? null,
        counts: floatFile.counts ?? null,
        mints: rows.length,
        pricedMints: priced.length,
        unpricedWithFloat,
        medianInventorySharePct: round(median, 2),
        priceSource: 'stocks-tokens.json market.usdPrice (Jupiter)',
        priceObservedAt,
        previousReadAt: floatFile.previous?.readAt ?? null,
        por: { source: 'https://api.xstocks.fi/api/v2/public/proof-of-reserves', fetchedAt: porFetchedAt, scope: 'all chains' },
        porConflicts: rows.filter((r) => r.floatExceedsPor).map((r) => r.symbol),
        porCompared: rows.filter((r) => r.porCirculatingAllChains !== null && r.floatUi !== null).length,
        history: (floatFile.history ?? []).slice(-30),
        top: priced.slice(0, top)
    };
}
