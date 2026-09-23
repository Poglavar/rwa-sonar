/*
 * The funnel graphic's geometry and wording (stocks-funnel.json -> an inline SVG): node positions,
 * radii, connector paths, labels, the section heading, and the SVG markup drawn from the layout.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). Pure: no DOM, no fetch, no clock. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaFunnelLayout; jest requires it. Tested in stocks/funnel-layout.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'), require('./issuer-labels.js'));
    else root.__rwaFunnelLayout = factory(root.__rwaFmt, root.__rwaIssuerLabels);
})(this, function (fmt, issuerLabels) {
    const { DASH, escapeHtml, fmtNumber, isNum } = fmt;
    const { displayName } = issuerLabels;

    /**
     * Funnel graphic geometry (stocks-funnel.json → funnelLayout). Circle AREA is proportional to the
     * mint count, so r follows sqrt, with a floor that keeps a one-mint programme visible; the column
     * weights are shares of the drawing width, widest where the labels are longest (the recipes).
     */
    const FUNNEL_WIDTH = 1100;
    const FUNNEL_MIN_R = 5;
    const FUNNEL_MAX_R = 30;
    const FUNNEL_ROW_PX = 50;
    const FUNNEL_TOP_PAD = 36;
    const FUNNEL_BOTTOM_PAD = 12;
    const FUNNEL_MIN_HEIGHT = 340;
    const FUNNEL_EDGE_MIN_PX = 1;
    const FUNNEL_EDGE_MAX_PX = 9;
    const FUNNEL_COLUMN_WEIGHTS = [0.2, 0.26, 0.32, 0.22];
    const FUNNEL_COLUMN_GAP = 16;
    const FUNNEL_LABEL_GAP = 8;
    /** Rough width of one character at the label font size, for deciding where to truncate. */
    const FUNNEL_LABEL_CHAR_PX = 6.2;

    /** Counts under ten read as words in the section heading: "to one token program". */
    const SMALL_NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

    // --- the funnel graphic ----------------------------------------------------

    /** One column of stocks-funnel.json, or null. */
    function funnelColumn(funnel, key) {
        const columns = funnel && Array.isArray(funnel.columns) ? funnel.columns : [];
        return columns.find((column) => column && column.key === key) || null;
    }

    function numberWord(count) {
        if (Number.isInteger(count) && count >= 0 && count < SMALL_NUMBER_WORDS.length) return SMALL_NUMBER_WORDS[count];
        return fmtNumber(count);
    }

    /**
     * The section heading, built from the funnel's own totals rather than written down: "From 471 token addresses
     * to one token program". Null when there is no funnel to count, in which case the section is hidden
     * rather than headed with a number nobody measured.
     */
    function funnelTitle(funnel) {
        const mints = funnelColumn(funnel, 'tokens');
        const programs = funnelColumn(funnel, 'programs');
        if (!mints || !programs || !isNum(mints.total) || !Array.isArray(programs.nodes)) return null;
        const count = programs.nodes.length;
        return `From ${fmtNumber(mints.total)} token addresses to ${numberWord(count)} token program${count === 1 ? '' : 's'}`;
    }

    /**
     * The text drawn beside a circle: the node's label with its mint count. A recipe label already
     * names its program ("token-2022 · pausable + clawback") and the program is the very next column,
     * so the prefix is dropped here — the full label stays in the node's <title>.
     */
    function funnelNodeText(node, columnKey, maxLength) {
        const raw = node && typeof node.label === 'string' ? node.label : '';
        const label = columnKey === 'recipes' ? raw.replace(/^[^·]*·\s*/, '') : raw;
        const short = displayName(label, isNum(maxLength) ? maxLength : 40);
        return `${short} · ${fmtNumber(node && node.count)}`;
    }

    /** The node's hover text: always the FULL label, the count, and an issuer's lifecycle status. */
    function funnelNodeTitle(node, columnKey) {
        const label = node && typeof node.label === 'string' ? node.label : DASH;
        const count = node && isNum(node.count) ? node.count : null;
        const mints = count === null ? DASH : `${fmtNumber(count)} token${count === 1 ? '' : 's'}`;
        const status = columnKey === 'issuers' && node && typeof node.status === 'string' ? `, ${node.status}` : '';
        return `${label} — ${mints}${status}`;
    }

    /** Drawing height: enough rows for the tallest column, never below the minimum. */
    function funnelHeight(funnel) {
        const columns = funnel && Array.isArray(funnel.columns) ? funnel.columns : [];
        const tallest = columns.reduce((most, column) => Math.max(most, (column.nodes || []).length), 0);
        return Math.max(FUNNEL_MIN_HEIGHT, tallest * FUNNEL_ROW_PX + FUNNEL_TOP_PAD + FUNNEL_BOTTOM_PAD);
    }

    function round1(value) {
        return Math.round(value * 10) / 10;
    }

    /**
     * Pure layout for the funnel SVG: node positions, radii and connector path strings, from
     * stocks-funnel.json. Circle area is proportional to the mint count (r ∝ √count) against the
     * biggest count anywhere in the funnel, so a circle is comparable across columns, with a floor so a
     * one-mint programme is still a dot rather than nothing. Every y is clamped inside the box, so a
     * caller that asks for a short box gets overlapping circles rather than circles off the canvas.
     * Connector width follows the edge's mint count, also with a floor, and an edge whose endpoints are
     * not both nodes is dropped rather than drawn to nowhere.
     */
    function funnelLayout(funnel, options) {
        const opts = options || {};
        const columns = (funnel && Array.isArray(funnel.columns) ? funnel.columns : [])
            .filter((column) => column && Array.isArray(column.nodes));
        const width = isNum(opts.width) && opts.width > 0 ? opts.width : FUNNEL_WIDTH;
        const height = isNum(opts.height) && opts.height > 0 ? opts.height : funnelHeight(funnel);
        if (columns.length === 0) return { width, height, columns: [], nodes: [], edges: [] };

        const counts = columns.flatMap((column) => column.nodes.map((node) => node.count)).filter(isNum);
        const maxCount = Math.max(1, ...counts);
        const radius = (count) => (isNum(count) && count > 0
            ? Math.max(FUNNEL_MIN_R, Math.min(FUNNEL_MAX_R, FUNNEL_MAX_R * Math.sqrt(count / maxCount)))
            : FUNNEL_MIN_R);

        const usable = Math.max(1, width - FUNNEL_COLUMN_GAP * (columns.length - 1));
        const laidOutColumns = [];
        const nodes = [];
        let bandStart = 0;

        for (let index = 0; index < columns.length; index++) {
            const column = columns[index];
            const weight = isNum(FUNNEL_COLUMN_WEIGHTS[index]) ? FUNNEL_COLUMN_WEIGHTS[index] : 1 / columns.length;
            const bandWidth = usable * weight;
            const x = bandStart + FUNNEL_MAX_R;
            const labelRoom = Math.max(6, Math.floor((bandWidth - FUNNEL_MAX_R - FUNNEL_LABEL_GAP) / FUNNEL_LABEL_CHAR_PX));

            laidOutColumns.push({
                key: column.key,
                title: typeof column.title === 'string' ? column.title : '',
                total: isNum(column.total) ? column.total : null,
                count: column.nodes.length,
                // The number the column heading prints, and the funnel's own story: the first column is
                // read as the mints it holds (its circles are instrument types), every later one as how
                // many distinct things those mints collapse into — 471 → 12 → 6 → 1.
                headline: column.key === 'tokens' && isNum(column.total) ? column.total : column.nodes.length,
                x: round1(x),
                labelX: round1(bandStart),
                titleY: round1(FUNNEL_TOP_PAD / 2)
            });

            const step = (height - FUNNEL_TOP_PAD - FUNNEL_BOTTOM_PAD) / Math.max(1, column.nodes.length);
            for (let row = 0; row < column.nodes.length; row++) {
                const node = column.nodes[row];
                const r = radius(node.count);
                const centre = FUNNEL_TOP_PAD + step * (row + 0.5);
                const y = Math.min(Math.max(centre, r), height - r);
                nodes.push({
                    id: node.id,
                    column: column.key,
                    kind: typeof node.kind === 'string' ? node.kind : column.key,
                    label: typeof node.label === 'string' ? node.label : DASH,
                    count: isNum(node.count) ? node.count : null,
                    status: typeof node.status === 'string' ? node.status : null,
                    // Only an issuer circle opens a dossier; the other three columns are not records.
                    slug: column.key === 'issuers' && typeof node.id === 'string' ? node.id : null,
                    // Hollow = nothing flowing through it: a defunct programme, or one with no mints.
                    hollow: column.key === 'issuers' && (node.count === 0 || node.status !== 'live'),
                    text: funnelNodeText(node, column.key, labelRoom),
                    title: funnelNodeTitle(node, column.key),
                    x: round1(x),
                    y: round1(y),
                    textX: round1(x + r + FUNNEL_LABEL_GAP),
                    r: round1(r)
                });
            }

            bandStart += bandWidth + FUNNEL_COLUMN_GAP;
        }

        const byId = new Map(nodes.map((node) => [node.id, node]));
        const rawEdges = (funnel && Array.isArray(funnel.edges) ? funnel.edges : [])
            .filter((edge) => edge && byId.has(edge.from) && byId.has(edge.to));
        const maxEdge = Math.max(1, ...rawEdges.map((edge) => (isNum(edge.count) ? edge.count : 0)));

        const edges = rawEdges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            const x1 = round1(from.x + from.r);
            const x2 = round1(to.x - to.r);
            const bend = round1((x2 - x1) / 2);
            const share = isNum(edge.count) ? edge.count / maxEdge : 0;
            return {
                from: edge.from,
                to: edge.to,
                count: isNum(edge.count) ? edge.count : null,
                d: `M${x1},${from.y}C${round1(x1 + bend)},${from.y} ${round1(x2 - bend)},${to.y} ${x2},${to.y}`,
                strokeWidth: round1(Math.max(FUNNEL_EDGE_MIN_PX, FUNNEL_EDGE_MAX_PX * share)),
                title: `${from.label} → ${to.label}: ${fmtNumber(edge.count)} token${edge.count === 1 ? '' : 's'}`
            };
        });

        return { width, height, columns: laidOutColumns, nodes, edges };
    }

    /**
     * The funnel SVG, from the layout funnelLayout() computed. Colours come from the CSS
     * custom properties (stocks.css), so the same markup reads in both themes; every circle and
     * every connector carries a <title> for hover, and an issuer circle carries data-slug, which
     * is what the page's one click handler already turns into a dossier.
     */
    function funnelSvg(layout) {
        const parts = [
            `<svg class="funnel-svg" viewBox="0 0 ${layout.width} ${layout.height}" ` +
            `width="${layout.width}" height="${layout.height}" role="group" ` +
            'aria-label="Funnel: token addresses by instrument type, the issuer programmes behind them, ' +
            'the control recipes those programmes run, and the token programs holding them">'
        ];

        parts.push('<g class="funnel-edges" aria-hidden="true">');
        for (const edge of layout.edges) {
            parts.push(
                `<path class="funnel-edge" d="${escapeHtml(edge.d)}" stroke-width="${edge.strokeWidth}">` +
                `<title>${escapeHtml(edge.title)}</title></path>`
            );
        }
        parts.push('</g>');

        parts.push('<g class="funnel-columns">');
        for (const column of layout.columns) {
            parts.push(
                `<text class="funnel-column-title" x="${column.labelX}" y="${column.titleY}">` +
                `${escapeHtml(column.title)} <tspan class="funnel-column-count">${escapeHtml(fmtNumber(column.headline))}</tspan></text>`
            );
        }
        parts.push('</g>');

        parts.push('<g class="funnel-nodes">');
        for (const node of layout.nodes) {
            const classes = `funnel-node funnel-node-${escapeHtml(node.column)}${node.hollow ? ' funnel-node-hollow' : ''}`;
            const interactive = node.slug === null
                ? ''
                : ` class="funnel-node-link" data-slug="${escapeHtml(node.slug)}" role="button" tabindex="0"` +
                  ` aria-label="${escapeHtml(`${node.title} — open the dossier`)}"`;
            parts.push(
                `<g class="${classes}"><g${interactive}>` +
                `<title>${escapeHtml(node.title)}</title>` +
                `<circle class="funnel-dot" cx="${node.x}" cy="${node.y}" r="${node.r}" />` +
                `<text class="funnel-node-text" x="${node.textX}" y="${node.y}">${escapeHtml(node.text)}</text>` +
                '</g></g>'
            );
        }
        parts.push('</g></svg>');

        return parts.join('');
    }

    return {
        FUNNEL_WIDTH,
        FUNNEL_MIN_R,
        FUNNEL_MAX_R,
        FUNNEL_ROW_PX,
        FUNNEL_TOP_PAD,
        FUNNEL_BOTTOM_PAD,
        FUNNEL_MIN_HEIGHT,
        FUNNEL_EDGE_MIN_PX,
        FUNNEL_EDGE_MAX_PX,
        FUNNEL_COLUMN_WEIGHTS,
        FUNNEL_COLUMN_GAP,
        FUNNEL_LABEL_GAP,
        FUNNEL_LABEL_CHAR_PX,
        SMALL_NUMBER_WORDS,
        funnelColumn,
        numberWord,
        funnelTitle,
        funnelNodeText,
        funnelNodeTitle,
        funnelHeight,
        round1,
        funnelLayout,
        funnelSvg
    };
});
