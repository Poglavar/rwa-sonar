/*
 * The one copy of the wording for "When the market is closed" (stocks-closed-market.json): how a
 * lender's closed-market label, its freezes, its Monday gap, the Solana depth and the weekend move
 * are spelled. Shared by the server-rendered token cards (stocks/lib/cards.mjs imports it) and the
 * monitor page's lender column (monitor.js reads window.__rwaClosedMarket), so the two cannot
 * drift. UMD-wrapped, no DOM, no fetch, no clock. Tested in ../closed-market-view.test.js.
 */

(function (root, factory) {
    const fmt = (typeof root !== 'undefined' && root && root.__rwaFmt) ? root.__rwaFmt : require('./fmt.js');
    if (typeof module === 'object' && module.exports) module.exports = factory(fmt);
    else root.__rwaClosedMarket = factory(fmt);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fmt) {
    const { DASH, fmtMoney, fmtSignedPct, fmtDate } = fmt;

    /** CSS modifier per label kind; the word always carries the meaning, the colour only repeats it. */
    const LABEL_CLASS = {
        'frozen-at-close': 'cm-frozen',
        'overnight-24x5': 'cm-overnight',
        'token-24x7': 'cm-token',
        'signed-quote': 'cm-signed',
        stale: 'cm-stale',
        'not-researched': 'cm-unknown'
    };

    function isNum(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function labelClass(kind) {
        return LABEL_CLASS[kind] || 'cm-unknown';
    }

    /** "12 Sep" — a card repeats dates often, so the year is left to the method line. */
    function shortDay(iso) {
        const full = fmtDate(iso);
        return full === DASH ? DASH : full.replace(/ \d{4}$/, '');
    }

    function hoursText(value) {
        if (!isNum(value)) return DASH;
        return value >= 10 ? `${Math.round(value)} h` : `${value.toFixed(1)} h`;
    }

    /** One threshold from the depth collector: ≈ $1.02M, < $1.0k, > $2.50M, no route at $2.50M. */
    function saleText(sale) {
        if (!sale || !isNum(sale.usd)) return DASH;
        const money = fmtMoney(sale.usd);
        if (sale.bound === 'below') return `< ${money}`;
        if (sale.bound === 'above') return `> ${money}`;
        if (sale.bound === 'no-route') return `no route at ${money}`;
        return `≈ ${money}`;
    }

    /** "5 % ≈ $1.02M · 10 % ≈ $1.10M" for one sample, or null. */
    function depthSampleText(sample) {
        if (!sample) return null;
        if (sample.noPrice) return 'no Solana price found by Jupiter';
        return `5 % ${saleText(sample.at5Pct)} · 10 % ${saleText(sample.at10Pct)}`;
    }

    /**
     * The depth row: the newest weekday and weekend samples, each dated. A depth that was never
     * collected says so; a session with no sample yet says that instead of borrowing the other's.
     */
    function depthText(depth) {
        if (!depth || depth.read === false) return 'not collected';
        const parts = [];
        if (depth.weekday) parts.push(`${depthSampleText(depth.weekday)} (weekday, ${shortDay(depth.weekday.at)})`);
        if (depth.weekend) parts.push(`${depthSampleText(depth.weekend)} (weekend, ${shortDay(depth.weekend.at)})`);
        if (parts.length === 0) return 'not measured yet';
        if (!depth.weekend) parts.push('no weekend sample yet');
        if (!depth.weekday) parts.push('no weekday sample yet');
        return parts.join('; ');
    }

    /** "44 h from 19 Sep (suspension)" / "since 26 Aug, ongoing". */
    function episodeText(ep) {
        const cause = ep.cause === 'scope-suspension' || ep.cause === 'operator-suspension' ? ' (operator suspension)'
            : ep.cause === 'stale-oracle-account' ? ' (price account not updated)' : '';
        if (ep.ongoing) return `since ${shortDay(ep.startedAt)}, ongoing${cause}`;
        const len = isNum(ep.lowHours) && isNum(ep.highHours) && Math.abs(ep.highHours - ep.lowHours) > Math.max(1, ep.highHours * 0.1)
            ? `${hoursText(ep.lowHours)}–${hoursText(ep.highHours)}` : hoursText(ep.highHours);
        return `${len} from ${shortDay(ep.startedAt)}${cause}`;
    }

    /**
     * The freeze row for one lender: what the watcher saw in the last 30 days and how far it has
     * read, or why there is nothing to show (not watched, not collected). Null for a lender whose
     * pricing was not researched.
     */
    function freezeText(freezes, protocolId) {
        if (!freezes) return null;
        if (!freezes.watched) return protocolId === 'nest' ? 'not watched (Nest prices in the same transaction)' : null;
        if (!freezes.read) return 'not collected';
        const cov = freezes.coverage || null;
        const read = cov && cov.readTo ? `; read to ${shortDay(cov.readTo)}` : cov && cov.checkedAt ? `; checked ${shortDay(cov.checkedAt)}` : '';
        const shown = (freezes.episodes || []).slice(0, 3).map(episodeText);
        const more = (freezes.episodes || []).length > 3 ? ` and ${(freezes.episodes.length - 3)} more` : '';
        const body = shown.length ? `${shown.join(', ')}${more}` : 'none of 20 min or more';
        return `${body}${read}`;
    }

    /** "+1.00 % (21 Sep), −1.26 % (14 Sep)" — the lender's Friday-close-to-reopening moves, newest `max`. */
    function gapsText(mondayGaps, max = Infinity) {
        if (!mondayGaps) return null;
        if (mondayGaps.unmeasured) return mondayGaps.unmeasured;
        if (mondayGaps.read === false) return 'not collected';
        const weeks = (mondayGaps.weeks || []).slice(0, max);
        if (weeks.length === 0) return 'not measured yet';
        return weeks.map((w) => `${fmtSignedPct(w.gapPct)} (${shortDay(w.reopenAt)})`).join(', ');
    }

    /** The weekend move in a 24/7 lender's price, or why it is missing. */
    function weekendMoveText(weekendMove) {
        if (!weekendMove) return null;
        if (weekendMove.read === false) return 'not collected';
        const m = weekendMove.move;
        if (!m) return 'no observation of the token in the last weekend';
        return `median ${fmtSignedPct(m.medianPct)}, widest ${fmtSignedPct(m.widestPct)} against Friday's close `
            + `(${m.observations} observation${m.observations === 1 ? '' : 's'}, ${shortDay(m.weekendFrom)}–${shortDay(m.weekendTo)})`;
    }

    /**
     * The monitor's compact form: one entry per protocol and label (the two Kamino xStocks markets
     * share a label), in the item's lender order, with the thresholds that label covers.
     */
    function compactLenders(item) {
        const out = [];
        for (const lender of (item && Array.isArray(item.lenders)) ? item.lenders : []) {
            const key = `${lender.protocolName}|${lender.label}`;
            let entry = out.find((e) => e.key === key);
            if (!entry) {
                entry = { key, protocolName: lender.protocolName, label: lender.label, labelKind: lender.labelKind, thresholds: [], markets: [] };
                out.push(entry);
            }
            if (isNum(lender.liquidationLtvPct)) entry.thresholds.push(lender.liquidationLtvPct);
            entry.markets.push(lender.displayName || lender.protocolName);
        }
        return out.map((e) => ({
            protocolName: e.protocolName,
            label: e.label,
            labelKind: e.labelKind,
            className: labelClass(e.labelKind),
            title: `${e.markets.join(', ')}: ${e.label}${e.thresholds.length ? `; liquidation at ${[...new Set(e.thresholds)].sort((a, b) => a - b).join(' / ')} % LTV` : ''}`
        }));
    }

    return { LABEL_CLASS, labelClass, shortDay, saleText, depthText, episodeText, freezeText, gapsText, weekendMoveText, compactLenders };
});
