/*
 * Draws the trust chain (stocks/EVIDENCE.md §6) as one deterministic SVG string, plus the legend
 * and the per-flow detail list that carry what the drawing cannot say in a line. Pure: no DOM, no
 * fetch, no clock, no ids that are not derived from the input — so the issuer panel on stocks.html
 * and the static card builder render byte-identical drawings from the same `chain` object.
 *
 * The layout is a Marey/subway chart turned vertical: the 13 catalogue actors are rows from Holder
 * at the top to Solana at the bottom, and each of the 9 rights flows gets its own LANE — a vertical
 * line in the gutter to their left, with a station dot on every actor row the flow touches. Which
 * lanes touch a node is read off the dots on its row, so no horizontal connector has to cross the
 * other eight lanes. A hollow ring marks the flow's origin and a filled triangle its destination;
 * a flow whose two ends are the same actor (Transfer and control, holder → holder) gets a ringed
 * dot there instead, because an arrow onto its own origin would say nothing.
 *
 * Lane colour is the link's `evidence` grade and lane dash is its `verification` grade — the two
 * axes trustchain.js computes; this file only names them as classes (.tc-ev-* and .tc-vf-*) and
 * never invents a grade or decides a colour. The colours themselves live in stocks.css and
 * card.css, one token per grade in both themes.
 *
 * UMD-wrapped like fmt.js and trustchain.js, so one copy serves the classic script on the page
 * (window.__rwaTrustChainSvg, needs fmt.js first), the ESM card builder (import) and jest
 * (require). Tested in ../trustchain-svg.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'));
    else root.__rwaTrustChainSvg = factory(root.__rwaFmt);
})(this, function (fmt) {
    'use strict';

    const { escapeHtml, isSafeUrl } = fmt;

    /** The four evidence grades (lane colour) and the four verification grades (lane dash). */
    const EVIDENCE_GRADES = ['documented', 'inferred', 'asserted', 'unknown'];
    const VERIFICATION_GRADES = ['onchain', 'attested', 'self-reported', 'none'];

    /** What each grade means, one clause each — the legend's own words. */
    const EVIDENCE_LEGEND = {
        documented: 'the source’s own words, read and quoted',
        inferred: 'our reading of the structure; no source states it',
        asserted: 'recorded once and not re-checked since',
        unknown: 'nothing found for the fields this link rests on'
    };

    const VERIFICATION_LEGEND = {
        onchain: 'read off the ledger',
        attested: 'a third party vouches for it',
        'self-reported': 'only the issuer says so',
        none: 'we cannot verify it'
    };

    /**
     * Every number the drawing uses, in viewBox units. The SVG is emitted at this width and scaled
     * by CSS, so a narrow phone and a wide desktop get the same drawing at different sizes rather
     * than two layouts. CHAR_* are average glyph widths as a fraction of the font size, measured
     * against system-ui well enough to wrap without a text-measuring DOM; they only ever make a
     * line break one word early, never overflow the box.
     */
    const LAYOUT = {
        width: 360,
        laneX0: 13,
        laneGap: 12,
        nodeX: 124,
        nodeGap: 6,
        rowPad: 5,
        rowGap: 4,
        labelSize: 11,
        labelLine: 12.5,
        partySize: 9.5,
        partyLine: 11,
        textPad: 7,
        dotR: 2.7,
        ringR: 3.4,
        arrow: 4,
        topPad: 8,
        bottomPad: 8,
        charLabel: 0.56,
        charParty: 0.54,
        maxPartyLines: 3
    };

    /** Party names a node prints before it says "+N more". */
    const MAX_PARTIES = 4;

    /** How much of a field value the flow list prints before cutting it. */
    const VALUE_MAX = 150;

    function str(value) {
        if (typeof value !== 'string') return null;
        const text = value.trim();
        return text === '' ? null : text;
    }

    function list(value) {
        return Array.isArray(value) ? value : [];
    }

    /**
     * Prose cut at a word boundary with an ellipsis; a blank stays null, never an empty quote.
     *
     * `max` of 0 means NO LIMIT, and the guard for it is load-bearing: without it a 0 cut every
     * string to the empty string and returned a bare "…", which is exactly what the issuer panel
     * printed for all nine flow summaries (found in the browser, 2026-09-18 — the element was
     * there, so every structural assertion passed while the sentence was gone).
     */
    function cut(value, max) {
        const text = str(value);
        if (text === null || !(max > 0) || text.length <= max) return text;
        const head = text.slice(0, max);
        const space = head.lastIndexOf(' ');
        return `${(space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:.]+$/, '')}…`;
    }

    /** The CSS class for a link's evidence grade; an unknown value falls back to `unknown`. */
    function evidenceClass(grade) {
        return `tc-ev-${EVIDENCE_GRADES.includes(grade) ? grade : 'unknown'}`;
    }

    /** The CSS class for a link's verification grade; an unknown value falls back to `none`. */
    function verificationClass(grade) {
        return `tc-vf-${VERIFICATION_GRADES.includes(grade) ? grade : 'none'}`;
    }

    /**
     * Greedy word wrap to at most `maxChars` per line. A single word longer than the limit is hard
     * split rather than allowed to overflow the node box, because an overflowing name is worse than
     * a broken one. Returns [] for nothing to draw.
     */
    function wrapText(text, maxChars) {
        const source = str(text);
        const limit = Math.max(4, Math.floor(maxChars));
        if (source === null) return [];
        const lines = [];
        let current = '';
        for (const word of source.split(/\s+/)) {
            let piece = word;
            while (piece.length > limit) {
                if (current !== '') {
                    lines.push(current);
                    current = '';
                }
                lines.push(piece.slice(0, limit));
                piece = piece.slice(limit);
            }
            if (piece === '') continue;
            const candidate = current === '' ? piece : `${current} ${piece}`;
            if (candidate.length <= limit) current = candidate;
            else {
                if (current !== '') lines.push(current);
                current = piece;
            }
        }
        if (current !== '') lines.push(current);
        return lines;
    }

    /** Distinct party names in the order the node lists them; a party with no name is dropped. */
    function partyNames(node) {
        const names = [];
        for (const party of list(node?.parties)) {
            const name = str(party?.name);
            if (name !== null && !names.includes(name)) names.push(name);
        }
        return names;
    }

    /**
     * What one node prints: its actor label, and its parties as one comma list wrapped over at most
     * LAYOUT.maxPartyLines lines. A node nobody fills prints "no party named" — an empty seat in
     * the chain is the finding (no transfer agent means the token is not the share), so it is said
     * rather than left blank.
     */
    function nodeLines(node, layout = LAYOUT) {
        const inner = layout.width - layout.nodeX - layout.nodeGap - layout.textPad * 2;
        const label = wrapText(str(node?.label) ?? str(node?.actor) ?? '—',
            inner / (layout.labelSize * layout.charLabel));
        const names = partyNames(node);
        const shown = names.slice(0, MAX_PARTIES);
        const extra = names.length - shown.length;
        const text = names.length === 0
            ? 'no party named'
            : `${shown.join(', ')}${extra > 0 ? ` +${extra} more` : ''}`;
        const parties = wrapText(text, inner / (layout.partySize * layout.charParty));
        const clipped = parties.length > layout.maxPartyLines;
        return {
            label: label.length === 0 ? ['—'] : label,
            parties: clipped
                ? [...parties.slice(0, layout.maxPartyLines - 1), `${parties[layout.maxPartyLines - 1]}…`]
                : parties,
            empty: names.length === 0
        };
    }

    /** Every actor a flow touches, in travel order: from, its via stops, then to. */
    function flowStops(link) {
        const stops = [str(link?.from), ...list(link?.via).map((v) => str(v)), str(link?.to)];
        return stops.filter((actor) => actor !== null);
    }

    /**
     * The whole drawing as numbers: one row per node (its y, height and wrapped text) and one lane
     * per link (its x, the y of every station it stops at, and which of them are its two ends).
     * Pure arithmetic over the chain, so the geometry can be asserted without parsing SVG.
     */
    function layoutChain(chain, layout = LAYOUT) {
        const nodes = list(chain?.nodes);
        const rows = [];
        let y = layout.topPad;
        for (const node of nodes) {
            const lines = nodeLines(node, layout);
            const height = layout.rowPad * 2
                + lines.label.length * layout.labelLine
                + lines.parties.length * layout.partyLine;
            rows.push({
                actor: str(node?.actor),
                label: str(node?.label),
                y,
                height,
                center: y + height / 2,
                lines
            });
            y += height + layout.rowGap;
        }
        const centerOf = Object.create(null);
        for (const row of rows) if (row.actor !== null) centerOf[row.actor] = row.center;

        const links = list(chain?.links);
        const lanes = links.map((link, index) => {
            const stops = flowStops(link);
            const points = [];
            for (const actor of stops) {
                const at = centerOf[actor];
                if (typeof at === 'number') points.push({ actor, y: at });
            }
            const ys = points.map((point) => point.y);
            const from = points.length > 0 ? points[0] : null;
            const to = points.length > 0 ? points[points.length - 1] : null;
            return {
                flow: str(link?.flow),
                label: str(link?.label),
                evidence: str(link?.evidence),
                verification: str(link?.verification),
                x: layout.laneX0 + index * layout.laneGap,
                stops: points,
                top: ys.length > 0 ? Math.min(...ys) : null,
                bottom: ys.length > 0 ? Math.max(...ys) : null,
                from,
                to,
                // A flow that begins and ends at the same actor (holder → holder) has no direction
                // to point in: it is marked at that one station instead of arrowed.
                loop: from !== null && to !== null && from.actor === to.actor
            };
        });

        return {
            width: layout.width,
            height: Math.max(layout.topPad + layout.bottomPad,
                y - layout.rowGap + layout.bottomPad),
            rows,
            lanes
        };
    }

    function attr(value) {
        // Six decimals is far more than the drawing needs and keeps every rebuild byte-identical
        // (0.1 + 0.2 must not print as 0.30000000000000004), with trailing zeros removed.
        return String(Number.parseFloat(Number(value).toFixed(6)));
    }

    function textLines(lines, x, y, lineHeight, className) {
        return lines.map((line, index) =>
            `<text class="${className}" x="${attr(x)}" y="${attr(y + index * lineHeight)}">`
            + `${escapeHtml(line)}</text>`).join('');
    }

    /** One arrowhead pointing down (`dir` 1) or up (`dir` -1) at the lane's destination station. */
    function arrowPath(x, y, dir, size) {
        const tip = y + dir * size;
        return `M ${attr(x - size * 0.8)} ${attr(y)} L ${attr(x + size * 0.8)} ${attr(y)} `
            + `L ${attr(x)} ${attr(tip)} Z`;
    }

    /**
     * The diagram. `chain` is the {nodes, links} object trustchain.js builds — from a dossier, from
     * a built issuer record, or from /api/issuers/:slug/chain; all three are the same shape.
     *
     * `id` prefixes the title and description element ids so two diagrams can sit on one page.
     * Nothing else in the output carries an id, and no marker or gradient def is emitted, so the
     * string depends on the chain alone.
     */
    function chainSvg(chain, { id = 'tc', layout = LAYOUT, title = null } = {}) {
        const box = layoutChain(chain, layout);
        const inner = layout.width - layout.nodeX - layout.nodeGap;
        const laneWidth = layout.nodeX - layout.nodeGap;
        const heading = str(title) ?? 'Trust chain';

        const guides = box.rows.map((row) =>
            `<line class="tc-guide" x1="${attr(layout.laneX0 - layout.laneGap * 0.5)}" `
            + `y1="${attr(row.center)}" x2="${attr(laneWidth)}" y2="${attr(row.center)}" />`).join('');

        const boxes = box.rows.map((row) => {
            const lines = row.lines;
            const labelY = row.y + layout.rowPad + layout.labelSize * 0.82;
            const partyY = labelY + (lines.label.length - 1) * layout.labelLine + layout.partyLine;
            return `<g class="tc-node${lines.empty ? ' tc-node-empty' : ''}" `
                + `data-actor="${escapeHtml(row.actor ?? '')}">`
                + `<rect class="tc-node-box" x="${attr(layout.nodeX)}" y="${attr(row.y)}" `
                + `width="${attr(inner)}" height="${attr(row.height)}" rx="4" />`
                + textLines(lines.label, layout.nodeX + layout.textPad, labelY, layout.labelLine, 'tc-node-label')
                + textLines(lines.parties, layout.nodeX + layout.textPad, partyY, layout.partyLine,
                    lines.empty ? 'tc-node-none' : 'tc-node-party')
                + '</g>';
        }).join('');

        const lanes = box.lanes.map((lane) => {
            const cls = `tc-lane ${evidenceClass(lane.evidence)} ${verificationClass(lane.verification)}`;
            const parts = [];
            if (lane.top !== null && lane.bottom !== null && lane.bottom > lane.top) {
                parts.push(`<line class="tc-lane-line" x1="${attr(lane.x)}" y1="${attr(lane.top)}" `
                    + `x2="${attr(lane.x)}" y2="${attr(lane.bottom)}" />`);
            }
            for (const stop of lane.stops) {
                parts.push(`<circle class="tc-stop" cx="${attr(lane.x)}" cy="${attr(stop.y)}" `
                    + `r="${attr(layout.dotR)}" />`);
            }
            if (lane.from !== null) {
                parts.push(`<circle class="tc-origin" cx="${attr(lane.x)}" cy="${attr(lane.from.y)}" `
                    + `r="${attr(layout.ringR)}" />`);
            }
            if (lane.to !== null && !lane.loop) {
                const dir = lane.to.y >= (lane.from?.y ?? lane.to.y) ? 1 : -1;
                parts.push(`<path class="tc-arrow" d="${arrowPath(lane.x, lane.to.y - dir * layout.arrow, dir, layout.arrow)}" />`);
            }
            if (lane.loop) {
                parts.push(`<circle class="tc-loop" cx="${attr(lane.x)}" cy="${attr(lane.from.y)}" `
                    + `r="${attr(layout.ringR + 2)}" />`);
            }
            const grades = `${lane.evidence ?? 'unknown'} evidence, `
                + `${lane.verification ?? 'none'} verification`;
            return `<g class="${cls}" data-flow="${escapeHtml(lane.flow ?? '')}" role="listitem">`
                + `<title>${escapeHtml(`${lane.label ?? lane.flow ?? 'flow'} — ${grades}`)}</title>`
                + parts.join('') + '</g>';
        }).join('');

        const desc = `${box.rows.length} actors between a holder and the company, `
            + `${box.lanes.length} rights flows drawn as lanes; colour is how well the link is `
            + 'evidenced, line style is how it was verified.';

        return `<svg class="tc-svg" viewBox="0 0 ${attr(box.width)} ${attr(box.height)}" `
            + `role="img" aria-labelledby="${escapeHtml(id)}-t ${escapeHtml(id)}-d" `
            + `xmlns="http://www.w3.org/2000/svg">`
            + `<title id="${escapeHtml(id)}-t">${escapeHtml(heading)}</title>`
            + `<desc id="${escapeHtml(id)}-d">${escapeHtml(desc)}</desc>`
            + `<g class="tc-guides">${guides}</g>`
            + `<g class="tc-nodes">${boxes}</g>`
            + `<g class="tc-lanes" role="list">${lanes}</g>`
            + '</svg>';
    }

    /** One legend: four colours for the evidence grades, four line styles for the verification. */
    function legendHtml() {
        const swatch = (grade) =>
            `<li class="tc-key-item"><span class="tc-key-swatch ${evidenceClass(grade)}"></span>`
            + `<strong>${escapeHtml(grade)}</strong> — ${escapeHtml(EVIDENCE_LEGEND[grade])}</li>`;
        const dash = (grade) =>
            `<li class="tc-key-item"><span class="tc-key-line ${verificationClass(grade)}"></span>`
            + `<strong>${escapeHtml(grade)}</strong> — ${escapeHtml(VERIFICATION_LEGEND[grade])}</li>`;
        return '<div class="tc-key">'
            + '<div class="tc-key-group"><h5 class="tc-key-head">Colour: who said so</h5>'
            + `<ul class="tc-key-list">${EVIDENCE_GRADES.map(swatch).join('')}</ul></div>`
            + '<div class="tc-key-group"><h5 class="tc-key-head">Line: how it was checked</h5>'
            + `<ul class="tc-key-list">${VERIFICATION_GRADES.map(dash).join('')}</ul></div>`
            + '</div>';
    }

    /**
     * `field = value` with the claim status that backs it, or the fact that nothing does. `max` of
     * 0 drops the value and keeps the path and the status: a byte-capped card can still say which
     * fields a link rests on and whether anything is claimed about them, which is the grade's whole
     * derivation, without carrying 400 characters of holderClaim prose nine times over.
     */
    function fieldRow(field, max = VALUE_MAX) {
        const path = str(field?.field);
        if (path === null) return '';
        const value = field?.value;
        const printed = value === null || value === undefined || value === ''
            ? '—'
            : cut(typeof value === 'string' ? value : JSON.stringify(value), max) ?? '—';
        const status = str(field?.claimStatus);
        return '<li class="tc-field">'
            + `<code class="tc-field-path">${escapeHtml(path)}</code>`
            + (max > 0 ? `<span class="tc-field-value">${escapeHtml(printed)}</span>` : '')
            + `<span class="tc-claim tc-claim-${escapeHtml(status ?? 'none')}">`
            + `${escapeHtml(status ?? 'no claim')}</span></li>`;
    }

    /**
     * The nine flows as a tappable list under the drawing: what the link says, both its grades and
     * the dossier fields it rests on with their claim status. This is what a hover cannot carry on
     * a phone, and it is also the drawing's accessible text: with JavaScript off, or with no
     * pointer at all, everything the lanes encode is still readable here.
     */
    function flowListHtml(chain, { open = false, fields = true, maxValue = VALUE_MAX, maxSummary = 0 } = {}) {
        const links = list(chain?.links);
        if (links.length === 0) {
            return '<p class="tc-empty">No rights flows graded for this issuer.</p>';
        }
        const items = links.map((link) => {
            const evidence = str(link?.evidence) ?? 'unknown';
            const verification = str(link?.verification) ?? 'none';
            const rows = fields ? list(link?.fields).map((field) => fieldRow(field, maxValue)).join('') : '';
            const summary = cut(link?.summary, maxSummary);
            return `<li><details class="tc-flow" data-flow="${escapeHtml(str(link?.flow) ?? '')}"`
                + `${open ? ' open' : ''}>`
                + '<summary>'
                + `<span class="tc-flow-swatch ${evidenceClass(evidence)} ${verificationClass(verification)}"></span>`
                + `<span class="tc-flow-label">${escapeHtml(str(link?.label) ?? str(link?.flow) ?? 'flow')}</span>`
                + `<span class="tc-flow-grade">${escapeHtml(evidence)} · ${escapeHtml(verification)}</span>`
                + '</summary>'
                + (summary === null ? '' : `<p class="tc-flow-summary">${escapeHtml(summary)}</p>`)
                + (rows === '' ? '' : `<ul class="tc-fields">${rows}</ul>`)
                + '</details></li>';
        }).join('');
        return `<ul class="tc-flows">${items}</ul>`;
    }

    /**
     * Diagram, legend and flow list as one block. `href` adds a link out to wherever the full
     * chain lives (the issuer panel, for a card that carries a cut-down copy).
     */
    function diagramHtml(chain, options = {}) {
        const {
            id = 'tc', title = null, fields = true, maxValue = VALUE_MAX, maxSummary = 0,
            href = null, hrefLabel = 'Full chain'
        } = options;
        const nodes = list(chain?.nodes);
        if (nodes.length === 0) {
            return '<p class="tc-empty">No trust chain has been built for this issuer yet.</p>';
        }
        const out = str(href);
        const link = out !== null && isSafeUrl(out)
            ? `<p class="tc-out"><a href="${escapeHtml(out)}">${escapeHtml(hrefLabel)}</a></p>`
            : '';
        return '<div class="tc-diagram">'
            + `<div class="tc-canvas">${chainSvg(chain, { id, title })}</div>`
            + legendHtml()
            + flowListHtml(chain, { fields, maxValue, maxSummary })
            + link
            + '</div>';
    }

    return {
        EVIDENCE_GRADES,
        VERIFICATION_GRADES,
        EVIDENCE_LEGEND,
        VERIFICATION_LEGEND,
        LAYOUT,
        MAX_PARTIES,
        VALUE_MAX,
        cut,
        evidenceClass,
        verificationClass,
        wrapText,
        partyNames,
        nodeLines,
        flowStops,
        layoutChain,
        chainSvg,
        legendHtml,
        flowListHtml,
        diagramHtml
    };
});
