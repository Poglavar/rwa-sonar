/*
 * The one copy of the display formatters — what a missing value looks like, how a price, a premium,
 * a timestamp or an age is spelled — shared by the browser pages (stocks.js loads this as a classic
 * script and reads window.__rwaFmt) and by the ESM builders (stocks/build-cards.mjs imports it, so a
 * server-rendered card and the live table cannot drift apart). UMD-wrapped rather than exporting
 * bare top-level names, so it cannot shadow a global in the classic scripts that load beside it.
 * No DOM, no fetch, no clock except the one fmtRelativeTime is given. Tested in ../../stocks-page.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__rwaFmt = factory();
})(this, function () {
    /** What a missing value renders as. Never 0, never "null". */
    const DASH = '—';

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    const SECOND_MS = 1000;
    const MINUTE_MS = 60 * SECOND_MS;
    const HOUR_MS = 60 * MINUTE_MS;
    const DAY_MS = 24 * HOUR_MS;
    const MONTH_MS = 30 * DAY_MS;
    const YEAR_MS = 365 * DAY_MS;

    /** A card file name may hold only these characters, so it is safe in a path and in a URL. */
    const SLUG_SAFE = /^[A-Za-z0-9._-]+$/;

    /** True only for a real, finite number — so a null never becomes 0 downstream. */
    function isNum(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    /** Escapes text for interpolation into HTML, attribute values included. */
    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
    }

    /** Only http(s), same-origin and mailto links are ever emitted as hrefs. */
    function isSafeUrl(url) {
        if (!url || typeof url !== 'string') return false;
        const trimmed = url.trim().toLowerCase();
        return trimmed.startsWith('http://') ||
            trimmed.startsWith('https://') ||
            trimmed.startsWith('/') ||
            trimmed.startsWith('./') ||
            trimmed.startsWith('../') ||
            trimmed.startsWith('mailto:');
    }

    /** 1234567 -> "1,234,567"; null/NaN -> "—". */
    function fmtNumber(value, digits) {
        if (!isNum(value)) return DASH;
        const d = isNum(digits) ? digits : 0;
        return value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    }

    /** Compact USD for aggregates: $1.92T / $1.23B / $4.56M / $78.9k / $12.34 / $0 (a real zero) / "—". */
    function fmtMoney(value) {
        if (!isNum(value)) return DASH;
        const abs = Math.abs(value);
        // The trillion band exists because issuer valuations and underlying market caps live there:
        // PreStocks marks SPACEX at 1.92e12 and Ondo reports Apple at 4.86e12, and "$1921.37B" is
        // not a number anyone reads at a glance.
        if (abs >= 1e12) return '$' + (value / 1e12).toFixed(2) + 'T';
        if (abs >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
        if (abs >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
        if (abs >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'k';
        if (abs >= 1) return '$' + value.toFixed(2);
        if (value === 0) return '$0';
        if (abs < 0.0001) return '<$0.001';
        return '$' + value.toPrecision(2);
    }

    /** Full-precision USD for a single price: $4,491.20 / "—". */
    function fmtPrice(value) {
        if (!isNum(value)) return DASH;
        const abs = Math.abs(value);
        const digits = abs > 0 && abs < 1 ? 4 : 2;
        return '$' + value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }

    /** 56.61 -> "56.6%"; null -> "—". */
    function fmtPct(value, digits) {
        if (!isNum(value)) return DASH;
        return value.toFixed(isNum(digits) ? digits : 1) + '%';
    }

    /** A premium: "+0.45%" / "-1.80%" / "0.00%" / "—". */
    function fmtSignedPct(value, digits) {
        if (!isNum(value)) return DASH;
        const d = isNum(digits) ? digits : 2;
        return (value > 0 ? '+' : '') + value.toFixed(d) + '%';
    }

    /** "2026-09-16T13:02:44Z" -> "16 Sep 2026 13:02 UTC". Always UTC, so it never drifts by host. */
    function fmtDateTime(iso) {
        if (typeof iso !== 'string' || !iso.trim()) return DASH;
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return DASH;
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${hh}:${mm} UTC`;
    }

    /** "2026-05-08" -> "8 May 2026". */
    function fmtDate(iso) {
        if (typeof iso !== 'string' || !iso.trim()) return DASH;
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return DASH;
        return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }

    /** A sources entry is either an ISO string or a record carrying fetchedAt. */
    function fetchedAtOf(source) {
        if (typeof source === 'string') return source.trim() ? source : null;
        if (source && typeof source === 'object' && typeof source.fetchedAt === 'string') {
            return source.fetchedAt.trim() ? source.fetchedAt : null;
        }
        return null;
    }

    /** An ISO timestamp as epoch milliseconds, or null when it is absent or unparseable. */
    function isoToMillis(iso) {
        if (typeof iso !== 'string' || !iso.trim()) return null;
        const ms = new Date(iso).getTime();
        return Number.isFinite(ms) ? ms : null;
    }

    /** A span of time as a magnitude only, no direction: "38 s" / "12 min" / "3 h" / "2 d" / "4 mo" / "2 y". */
    function humanizeDuration(ms) {
        if (!isNum(ms)) return DASH;
        const abs = Math.abs(ms);
        if (abs < 45 * SECOND_MS) return `${Math.max(1, Math.round(abs / SECOND_MS))} s`;
        if (abs < 90 * MINUTE_MS) return `${Math.round(abs / MINUTE_MS)} min`;
        if (abs < 36 * HOUR_MS) return `${Math.round(abs / HOUR_MS)} h`;
        if (abs < 30 * DAY_MS) return `${Math.round(abs / DAY_MS)} d`;
        if (abs < YEAR_MS) return `${Math.round(abs / MONTH_MS)} mo`;
        return `${Math.round(abs / YEAR_MS)} y`;
    }

    /**
     * "3 h ago" for a past timestamp, "in 3 h" for a future one (a venue's clock can run ahead of ours,
     * and silently printing that as "3 h ago" would invent a trade that has not happened), "just now"
     * inside three quarters of a minute either way, and a dash when there is no timestamp at all.
     * `nowMs` is injectable so the tests do not depend on the wall clock.
     */
    function fmtRelativeTime(iso, nowMs) {
        const then = isoToMillis(iso);
        if (then === null) return DASH;
        const now = isNum(nowMs) ? nowMs : Date.now();
        const diff = now - then;
        if (Math.abs(diff) < 45 * SECOND_MS) return 'just now';
        const magnitude = humanizeDuration(diff);
        return diff < 0 ? `in ${magnitude}` : `${magnitude} ago`;
    }

    /** An age in seconds as "4 min old"; a missing age is a dash, never "0 s old". */
    function fmtAgeSeconds(seconds) {
        if (!isNum(seconds)) return DASH;
        return `${humanizeDuration(seconds * SECOND_MS)} old`;
    }

    /** A ratio kept readable: "3.4" while small, grouped whole numbers once it is large. */
    function fmtTradesPerTrader(value) {
        if (!isNum(value)) return DASH;
        return Math.abs(value) < 100 ? value.toFixed(1) : fmtNumber(value);
    }

    /** "3 / 61" for a count against a total; either side may be missing, and then it is a dash. */
    function fmtCountOfTotal(count, total) {
        if (!isNum(count) && !isNum(total)) return DASH;
        return `${isNum(count) ? fmtNumber(count) : DASH} / ${isNum(total) ? fmtNumber(total) : DASH}`;
    }

    /** A cross-venue price spread for a table cell: "0.57 %" / "—". Two decimals, because a spread. */
    function fmtVenueSpreadPct(value) {
        if (!isNum(value)) return DASH;
        return `${value.toFixed(2)} %`;
    }

    /**
     * The same spread spelled out for the detail panel: "0.57 % (Raydium → Kraken, 5 venues priced)".
     * The cheapest and dearest venue and the count of priced venues are each optional — a spread with
     * no venue names still says how wide it was.
     */
    function fmtVenueSpread(activity) {
        const a = activity && typeof activity === 'object' ? activity : {};
        if (!isNum(a.venueSpreadPct)) return DASH;
        const name = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
        const low = name(a.venueSpreadLow);
        const high = name(a.venueSpreadHigh);
        const parts = [];
        if (low && high) parts.push(`${low} → ${high}`);
        else if (low) parts.push(`from ${low}`);
        else if (high) parts.push(`to ${high}`);
        if (isNum(a.venuesPriced)) parts.push(`${fmtNumber(a.venuesPriced)} venue${a.venuesPriced === 1 ? '' : 's'} priced`);
        return `${fmtVenueSpreadPct(a.venueSpreadPct)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }

    /** "freeze-authority-has-been-exercised" -> "Freeze authority has been exercised". */
    function humanizeSlug(slug) {
        if (typeof slug !== 'string' || !slug.trim()) return DASH;
        const words = slug.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
        return words.charAt(0).toUpperCase() + words.slice(1);
    }

    /**
     * The per-token card file name, without any knowledge of the other tokens: the symbol when it is
     * already path-safe, else the symbol with every unsafe run turned into a hyphen, else a name made
     * from the mint. Uniqueness is the builder's job (stocks/lib/cards.mjs assignSlugs), because only
     * it sees the whole set — this is what the stocks page computes for a row link, and all 441
     * symbols are currently distinct case-insensitively, so the two agree.
     */
    function cardSlug(symbol, mint) {
        const clean = typeof symbol === 'string' ? symbol.trim() : '';
        if (SLUG_SAFE.test(clean)) return clean;
        const sanitized = clean.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
        if (sanitized) return sanitized;
        const address = typeof mint === 'string' ? mint.trim() : '';
        return address ? `mint-${address.slice(0, 8)}` : '';
    }

    /**
     * A number cut to `digits` significant figures, for a file that must be byte-identical when it
     * is rebuilt from the same inputs: 213.83327706797914 -> 213.833. Null stays null — a rounded
     * missing value would be 0, which is the whole trap. Integers are returned unchanged.
     */
    function roundSignificant(value, digits) {
        if (!isNum(value)) return null;
        if (value === 0) return 0;
        const d = Number.isInteger(digits) && digits > 0 ? digits : 6;
        return Number(value.toPrecision(d));
    }

    /** The disambiguating tail appended to a slug when two tokens want the same one. */
    function mintSuffix(mint) {
        const address = typeof mint === 'string' ? mint.trim() : '';
        return address ? address.slice(0, 6) : '';
    }

    return {
        DASH,
        MONTHS,
        SECOND_MS,
        MINUTE_MS,
        HOUR_MS,
        DAY_MS,
        MONTH_MS,
        YEAR_MS,
        SLUG_SAFE,
        isNum,
        escapeHtml,
        isSafeUrl,
        fmtNumber,
        fmtMoney,
        fmtPrice,
        fmtPct,
        fmtSignedPct,
        fmtDateTime,
        fmtDate,
        fetchedAtOf,
        isoToMillis,
        humanizeDuration,
        fmtRelativeTime,
        fmtAgeSeconds,
        fmtTradesPerTrader,
        fmtCountOfTotal,
        fmtVenueSpreadPct,
        fmtVenueSpread,
        humanizeSlug,
        roundSignificant,
        cardSlug,
        mintSuffix
    };
});
