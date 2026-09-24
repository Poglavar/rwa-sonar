/*
 * The schematic kit: sequence (swimlane) diagrams, simple step flows and relationship hubs, drawn
 * as deterministic inline SVG strings with the accessible step list that carries what a drawing
 * cannot. Pure: no DOM, no fetch, no clock, no ids that are not derived from the input — so a
 * generated issuer page, a card and the browser pages render byte-identical figures from the same
 * spec (stocks/lib/schematics.js builds the specs from dossiers, observations and the what-if
 * catalogue; this file never decides what a step says, only where it goes).
 *
 * Three kinds, all laid out for a 300-unit-wide viewBox — the content column of a 360 px phone —
 * so a phone draws them at about 1:1 (a 360-unit box drew 9.5 px lane names at 7.8 px) and a
 * desktop scales them up — one layout, never a second narrow one:
 *   - sequence: actors are LANES (columns with a lifeline), numbered steps are rows; each row puts
 *     its label on its own full-width line(s) and the arrow under it, so no label can overlap
 *     another however long it is. A self-step (an actor acting alone) is a small loop.
 *   - flow: numbered boxes top to bottom with arrows between, for a chain of conditions or states
 *     (a redemption that needs a liquidity event first). An optional loop-back arrow closes a cycle.
 *   - hub: one centre (the programme) and its counterparties as spokes off a spine, each labelled
 *     with the relation — who contracts with whom.
 *
 * Every step carries a `status` that picks its colour: observed (read off the chain), documented,
 * inferred, litigated, unknown (always drawn dashed with a "?"), and catalogue (the scenario or the
 * generic chain shape, not an issuer claim). Colours are classes (.fd-st-*) coloured in
 * flow-diagram.css; nothing here picks a colour.
 *
 * UMD-wrapped like trustchain-svg.js: window.__rwaFlowDiagram in the browser (needs fmt.js first),
 * import from the ESM builders, require from jest. Tested in ../flow-diagram.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./fmt.js'));
    else root.__rwaFlowDiagram = factory(root.__rwaFmt);
})(this, function (fmt) {
    'use strict';

    const { escapeHtml, isSafeUrl } = fmt;

    /** Step statuses, in legend order. Anything else is drawn as `unknown`, never as a firmer one. */
    const STATUSES = ['observed', 'documented', 'inferred', 'litigated', 'unknown', 'catalogue'];

    const STATUS_LEGEND = {
        observed: 'seen by our own checks — on-chain unless the source says otherwise',
        documented: 'the issuer’s or a regulator’s own words',
        inferred: 'our reading of the structure',
        litigated: 'decided by a court or regulator',
        unknown: 'drawn dashed: nothing found settles it',
        catalogue: 'the scenario or generic chain, not an issuer claim'
    };

    /**
     * Every number the drawings use, in viewBox units. CHAR_* are average glyph widths as a fraction
     * of the font size (system-ui), used to wrap without a text-measuring DOM; they err on the wide
     * side so a line breaks a word early rather than overflowing.
     */
    const LAYOUT = {
        width: 300,
        pad: 8,
        headSize: 9.5,
        headLine: 11,
        headPad: 5,
        labelSize: 10.5,
        labelLine: 13,
        badgeR: 7,
        textGap: 6,
        arrowGap: 8,
        arrowHead: 4.5,
        rowGap: 7,
        selfLoopW: 16,
        selfLoopH: 9,
        groupSize: 9,
        groupLine: 12,
        boxPad: 6,
        boxGap: 16,
        spineX: 14,
        charHead: 0.58,
        charLabel: 0.56,
        maxLabelLines: 8,
        maxHeadLines: 4,
        topPad: 6,
        bottomPad: 8
    };

    /** Party names a hub spoke prints before it says "+N more". */
    const MAX_NAMES = 4;

    function str(value) {
        if (typeof value !== 'string') return null;
        const text = value.replace(/\s+/g, ' ').trim();
        return text === '' ? null : text;
    }

    function list(value) {
        return Array.isArray(value) ? value : [];
    }

    function statusOf(value) {
        return STATUSES.includes(value) ? value : 'unknown';
    }

    function attr(value) {
        // Six decimals keeps every rebuild byte-identical (no 0.30000000000000004).
        return String(Number.parseFloat(Number(value).toFixed(6)));
    }

    /**
     * Greedy word wrap to at most `maxChars` per line; an over-long word is hard split. `maxLines`
     * clips with an ellipsis on the last line, so a drawing never grows without bound — the full
     * text is always in the step list beside it.
     */
    function wrapText(text, maxChars, maxLines = Infinity) {
        const source = str(text);
        const limit = Math.max(4, Math.floor(maxChars));
        if (source === null) return [];
        const lines = [];
        let current = '';
        for (const word of source.split(' ')) {
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
        if (lines.length <= maxLines) return lines;
        const kept = lines.slice(0, maxLines);
        const last = kept[maxLines - 1];
        kept[maxLines - 1] = `${last.length >= limit ? last.slice(0, limit - 1) : last}…`;
        return kept;
    }

    /** The approximate drawn width of a line, for overlap checks and box sizing. */
    function textWidth(line, size, charRatio) {
        return String(line).length * size * charRatio;
    }

    // ------------------------------------------------------------------------------------------
    // sequence
    // ------------------------------------------------------------------------------------------

    /**
     * The sequence drawing as numbers: lanes (x, wrapped header), one row per step (label lines and
     * their box, arrow y and ends) and group brackets. Steps keep the spec's order and are numbered
     * 1..n; a step naming a lane that does not exist is drawn as an unknown self-step on the first
     * lane rather than dropped, so a broken spec is visible instead of silently shorter.
     */
    function layoutSequence(spec, layout = LAYOUT) {
        const lanesIn = list(spec?.lanes).filter((lane) => str(lane?.id) !== null);
        const n = Math.max(1, lanesIn.length);
        const colW = (layout.width - layout.pad * 2) / n;
        const headChars = (colW - layout.headPad * 2) / (layout.headSize * layout.charHead);
        const heads = lanesIn.map((lane) => wrapText(str(lane.label) ?? lane.id, headChars, layout.maxHeadLines));
        const headLines = Math.max(1, ...heads.map((lines) => lines.length));
        const headTop = layout.topPad;
        const headHeight = layout.headPad * 2 + headLines * layout.headLine;
        const lanes = lanesIn.map((lane, index) => ({
            id: lane.id,
            label: str(lane.label) ?? lane.id,
            x: layout.pad + colW * (index + 0.5),
            box: { x: layout.pad + colW * index + 2, y: headTop, w: colW - 4, h: headHeight },
            lines: heads[index]
        }));
        const laneX = Object.create(null);
        for (const lane of lanes) laneX[lane.id] = lane.x;

        const textX = layout.pad + layout.badgeR * 2 + layout.textGap;
        const labelChars = (layout.width - textX - layout.pad) / (layout.labelSize * layout.charLabel);
        const groupsIn = list(spec?.groups);
        const groupStartsAt = new Map();
        for (const group of groupsIn) {
            if (Number.isInteger(group?.from) && Number.isInteger(group?.to) && group.to >= group.from) {
                if (!groupStartsAt.has(group.from)) groupStartsAt.set(group.from, group);
            }
        }

        let y = headTop + headHeight + 10;
        const steps = [];
        const groupRows = [];
        list(spec?.steps).forEach((step, index) => {
            const group = groupStartsAt.get(index);
            if (group) {
                groupRows.push({ group, labelY: y, top: y - 3 });
                y += layout.groupLine + 2;
            }
            const known = laneX[step?.from] !== undefined && laneX[step?.to] !== undefined;
            const from = known ? step.from : lanes[0]?.id ?? null;
            const to = known ? step.to : from;
            const status = known ? statusOf(step?.status) : 'unknown';
            const lines = wrapText(str(step?.label) ?? 'Step not described', labelChars, layout.maxLabelLines);
            const labelTop = y;
            const labelHeight = lines.length * layout.labelLine;
            const arrowY = labelTop + labelHeight + layout.arrowGap;
            const self = from === to;
            const bottom = arrowY + (self ? layout.selfLoopH : 0) + 4;
            const x1 = from === null ? layout.pad : laneX[from];
            const x2 = to === null ? layout.pad : laneX[to];
            steps.push({
                n: index + 1,
                from,
                to,
                self,
                status,
                lines,
                labelTop,
                badge: { cx: layout.pad + layout.badgeR, cy: labelTop + layout.labelLine / 2 - 1 },
                textX,
                labelBox: {
                    x: textX,
                    y: labelTop,
                    w: Math.max(...lines.map((line) => textWidth(line, layout.labelSize, layout.charLabel)), 0),
                    h: labelHeight
                },
                arrowY,
                x1,
                x2,
                top: labelTop,
                bottom
            });
            y = bottom + layout.rowGap;
        });

        const groups = groupRows.map(({ group, labelY, top }) => {
            const last = steps[Math.min(group.to, steps.length - 1)];
            return {
                label: str(group.label) ?? '',
                status: statusOf(group.status),
                labelY,
                top,
                bottom: last ? last.bottom + 3 : top + layout.groupLine,
                labelBox: {
                    x: layout.width - layout.pad - 4 - textWidth(str(group.label) ?? '', layout.groupSize, layout.charLabel),
                    y: labelY,
                    w: textWidth(str(group.label) ?? '', layout.groupSize, layout.charLabel),
                    h: layout.groupLine
                }
            };
        });

        const lifelineTop = headTop + headHeight;
        const lifelineBottom = steps.length ? steps[steps.length - 1].bottom + 2 : lifelineTop + 10;
        return {
            kind: 'sequence',
            width: layout.width,
            height: lifelineBottom + layout.bottomPad,
            lanes,
            steps,
            groups,
            lifelineTop,
            lifelineBottom
        };
    }

    function textLines(lines, x, y, lineHeight, className, anchor = null) {
        return lines.map((line, index) =>
            `<text class="${className}" x="${attr(x)}" y="${attr(y + index * lineHeight)}"`
            + `${anchor ? ` text-anchor="${anchor}"` : ''}>${escapeHtml(line)}</text>`).join('');
    }

    function arrowHead(x, y, dir, size) {
        // A triangle whose tip is at (x, y), pointing right (dir 1) or left (dir -1).
        return `M ${attr(x)} ${attr(y)} L ${attr(x - dir * size * 1.4)} ${attr(y - size * 0.8)} `
            + `L ${attr(x - dir * size * 1.4)} ${attr(y + size * 0.8)} Z`;
    }

    function arrowDown(x, y, size) {
        return `M ${attr(x)} ${attr(y)} L ${attr(x - size * 0.8)} ${attr(y - size * 1.4)} `
            + `L ${attr(x + size * 0.8)} ${attr(y - size * 1.4)} Z`;
    }

    function badgeSvg(cx, cy, r, text, status) {
        return `<circle class="fd-badge fd-st-${status}" cx="${attr(cx)}" cy="${attr(cy)}" r="${attr(r)}" />`
            + `<text class="fd-badge-n" x="${attr(cx)}" y="${attr(cy + 3.5)}" text-anchor="middle">${escapeHtml(text)}</text>`;
    }

    function svgOpen(box, id, title, desc) {
        const safe = escapeHtml(id);
        return `<svg class="fd-svg" viewBox="0 0 ${attr(box.width)} ${attr(box.height)}" `
            + `role="img" aria-labelledby="${safe}-t ${safe}-d" xmlns="http://www.w3.org/2000/svg">`
            + `<title id="${safe}-t">${escapeHtml(title)}</title>`
            + `<desc id="${safe}-d">${escapeHtml(desc)}</desc>`;
    }

    function stepDesc(steps) {
        return steps.map((step) => `${step.n}. ${step.lines.join(' ')} (${step.status})`).join(' ');
    }

    function sequenceSvg(spec, { id = 'fd', layout = LAYOUT } = {}) {
        const box = layoutSequence(spec, layout);
        const title = str(spec?.title) ?? 'Sequence';
        const heads = box.lanes.map((lane) =>
            `<g class="fd-lane" data-lane="${escapeHtml(lane.id)}">`
            + `<rect class="fd-lane-box" x="${attr(lane.box.x)}" y="${attr(lane.box.y)}" width="${attr(lane.box.w)}" `
            + `height="${attr(lane.box.h)}" rx="4" />`
            + textLines(lane.lines, lane.x, lane.box.y + layout.headPad + layout.headSize * 0.9, layout.headLine,
                'fd-lane-label', 'middle')
            + `<line class="fd-lifeline" x1="${attr(lane.x)}" y1="${attr(box.lifelineTop)}" x2="${attr(lane.x)}" `
            + `y2="${attr(box.lifelineBottom)}" /></g>`).join('');
        const groups = box.groups.map((group) =>
            `<g class="fd-group fd-st-${group.status}"><rect class="fd-group-box" x="${attr(layout.pad - 3)}" `
            + `y="${attr(group.top)}" width="${attr(layout.width - layout.pad * 2 + 6)}" `
            + `height="${attr(group.bottom - group.top)}" rx="6" />`
            + `<text class="fd-group-label" x="${attr(layout.width - layout.pad - 4)}" `
            + `y="${attr(group.labelY + layout.groupSize)}" text-anchor="end">${escapeHtml(group.label)}</text></g>`).join('');
        const rows = box.steps.map((step) => {
            const parts = [];
            const unknown = step.status === 'unknown';
            parts.push(badgeSvg(step.badge.cx, step.badge.cy, layout.badgeR, String(step.n), step.status));
            parts.push(textLines(step.lines, step.textX, step.labelTop + layout.labelSize * 0.85, layout.labelLine,
                'fd-step-label'));
            if (step.self) {
                const x = step.x1;
                const w = layout.selfLoopW;
                const h = layout.selfLoopH;
                parts.push(`<path class="fd-arrow-line" d="M ${attr(x)} ${attr(step.arrowY)} H ${attr(x + w)} `
                    + `V ${attr(step.arrowY + h)} H ${attr(x + layout.arrowHead * 1.4)}" />`);
                parts.push(`<path class="fd-arrow-head" d="${arrowHead(x, step.arrowY + h, -1, layout.arrowHead)}" />`);
                parts.push(`<circle class="fd-stop" cx="${attr(x)}" cy="${attr(step.arrowY)}" r="2.2" />`);
                if (unknown) {
                    parts.push(`<text class="fd-unknown-mark" x="${attr(x + w + 4)}" `
                        + `y="${attr(step.arrowY + h / 2 + 3.5)}">?</text>`);
                }
            } else {
                const dir = step.x2 >= step.x1 ? 1 : -1;
                const tip = step.x2 - dir * 2;
                parts.push(`<circle class="fd-stop" cx="${attr(step.x1)}" cy="${attr(step.arrowY)}" r="2.2" />`);
                parts.push(`<line class="fd-arrow-line" x1="${attr(step.x1)}" y1="${attr(step.arrowY)}" `
                    + `x2="${attr(tip - dir * layout.arrowHead * 1.2)}" y2="${attr(step.arrowY)}" />`);
                parts.push(`<path class="fd-arrow-head" d="${arrowHead(tip, step.arrowY, dir, layout.arrowHead)}" />`);
                if (unknown) {
                    parts.push(`<text class="fd-unknown-mark" x="${attr((step.x1 + step.x2) / 2)}" `
                        + `y="${attr(step.arrowY - 2.5)}" text-anchor="middle">?</text>`);
                }
            }
            return `<g class="fd-step fd-st-${step.status}" data-step="${step.n}">${parts.join('')}</g>`;
        }).join('');
        const desc = `${box.lanes.length} actors (${box.lanes.map((lane) => lane.label).join(', ')}); `
            + `${box.steps.length} numbered steps. ${stepDesc(box.steps)}`;
        return svgOpen(box, id, title, desc)
            + `<g class="fd-groups">${groups}</g><g class="fd-lanes">${heads}</g><g class="fd-steps-g">${rows}</g></svg>`;
    }

    // ------------------------------------------------------------------------------------------
    // flow (numbered boxes, top to bottom)
    // ------------------------------------------------------------------------------------------

    function layoutFlow(spec, layout = LAYOUT) {
        const loop = spec?.loopBack && Number.isInteger(spec.loopBack.from) && Number.isInteger(spec.loopBack.to)
            ? spec.loopBack : null;
        const right = loop ? 22 : 0;
        const boxX = layout.pad;
        const boxW = layout.width - layout.pad * 2 - right;
        const textX = boxX + layout.boxPad + layout.badgeR * 2 + layout.textGap;
        const chars = (boxX + boxW - layout.boxPad - textX) / (layout.labelSize * layout.charLabel);
        let y = layout.topPad;
        const boxes = list(spec?.steps).map((step, index) => {
            const lines = wrapText(str(step?.label) ?? 'Step not described', chars, layout.maxLabelLines);
            const h = layout.boxPad * 2 + lines.length * layout.labelLine;
            const out = {
                n: index + 1,
                status: statusOf(step?.status),
                lines,
                x: boxX,
                y,
                w: boxW,
                h,
                textX,
                labelBox: {
                    x: textX,
                    y: y + layout.boxPad,
                    w: Math.max(...lines.map((line) => textWidth(line, layout.labelSize, layout.charLabel)), 0),
                    h: lines.length * layout.labelLine
                }
            };
            y += h + layout.boxGap;
            return out;
        });
        const height = (boxes.length ? y - layout.boxGap : y) + layout.bottomPad;
        const loopPath = loop && boxes[loop.from] && boxes[loop.to]
            ? {
                from: boxes[loop.from],
                to: boxes[loop.to],
                x: boxX + boxW + right / 2 + 2,
                label: str(loop.label)
            }
            : null;
        return { kind: 'flow', width: layout.width, height, boxes, loop: loopPath };
    }

    function flowSvg(spec, { id = 'fd', layout = LAYOUT } = {}) {
        const box = layoutFlow(spec, layout);
        const title = str(spec?.title) ?? 'Flow';
        const parts = box.boxes.map((item, index) => {
            const unknown = item.status === 'unknown';
            const next = box.boxes[index + 1];
            const arrow = next
                ? `<line class="fd-arrow-line" x1="${attr(item.x + 24)}" y1="${attr(item.y + item.h)}" x2="${attr(item.x + 24)}" `
                + `y2="${attr(next.y - layout.arrowHead * 1.3)}" />`
                + `<path class="fd-arrow-head" d="${arrowDown(item.x + 24, next.y, layout.arrowHead)}" />`
                : '';
            return `<g class="fd-step fd-st-${item.status}" data-step="${item.n}">`
                + `<rect class="fd-box${unknown ? ' fd-box-unknown' : ''}" x="${attr(item.x)}" y="${attr(item.y)}" `
                + `width="${attr(item.w)}" height="${attr(item.h)}" rx="5" />`
                + badgeSvg(item.x + layout.boxPad + layout.badgeR, item.y + layout.boxPad + layout.labelLine / 2 - 1,
                    layout.badgeR, unknown ? '?' : String(item.n), item.status)
                + textLines(item.lines, item.textX, item.y + layout.boxPad + layout.labelSize * 0.85, layout.labelLine,
                    'fd-step-label')
                + arrow + '</g>';
        }).join('');
        let loop = '';
        if (box.loop !== null) {
            const { from, to, x } = box.loop;
            const y1 = from.y + from.h / 2;
            const y2 = to.y + to.h / 2;
            loop = `<g class="fd-loop"><path class="fd-arrow-line" d="M ${attr(from.x + from.w)} ${attr(y1)} H ${attr(x)} `
                + `V ${attr(y2)} H ${attr(to.x + to.w + layout.arrowHead * 1.4)}" />`
                + `<path class="fd-arrow-head" d="${arrowHead(to.x + to.w, y2, -1, layout.arrowHead)}" />`
                + (box.loop.label ? `<title>${escapeHtml(box.loop.label)}</title>` : '') + '</g>';
        }
        const desc = `${box.boxes.length} numbered steps, top to bottom. `
            + box.boxes.map((item) => `${item.n}. ${item.lines.join(' ')} (${item.status})`).join(' ')
            + (box.loop?.label ? ` Then: ${box.loop.label}.` : '');
        return svgOpen(box, id, title, desc) + parts + loop + '</svg>';
    }

    // ------------------------------------------------------------------------------------------
    // hub (a centre and its relations)
    // ------------------------------------------------------------------------------------------

    function spokeNames(spoke) {
        const names = [];
        for (const name of list(spoke?.names)) {
            const text = str(name);
            if (text !== null && !names.includes(text)) names.push(text);
        }
        return names;
    }

    function layoutHub(spec, layout = LAYOUT) {
        const centreChars = (layout.width - layout.pad * 2 - layout.boxPad * 2) / (layout.labelSize * layout.charLabel);
        const centreLines = wrapText(str(spec?.centre?.label) ?? 'Programme', centreChars, 3);
        const subLines = wrapText(str(spec?.centre?.sub), centreChars * 1.1, 2);
        const centre = {
            x: layout.pad,
            y: layout.topPad,
            w: layout.width - layout.pad * 2,
            h: layout.boxPad * 2 + centreLines.length * layout.labelLine + subLines.length * layout.groupLine,
            lines: centreLines,
            sub: subLines
        };
        const spineX = layout.pad + layout.spineX;
        const boxX = spineX + 34;
        const boxW = layout.width - layout.pad - boxX;
        const chars = (boxW - layout.boxPad * 2) / (layout.headSize * layout.charHead);
        const relChars = (boxW - layout.boxPad) / (layout.groupSize * layout.charLabel);
        let y = centre.y + centre.h + 12;
        const spokes = list(spec?.spokes).map((spoke, index) => {
            const names = spokeNames(spoke);
            const shown = names.slice(0, MAX_NAMES);
            const extra = names.length - shown.length;
            const status = statusOf(spoke?.status);
            const text = names.length === 0 ? 'none named' : `${shown.join(', ')}${extra > 0 ? ` +${extra} more` : ''}`;
            const relation = wrapText(str(spoke?.relation) ?? 'related', relChars, 2);
            const lines = wrapText(text, chars, 3);
            const relTop = y;
            const top = relTop + relation.length * layout.groupLine + 2;
            const h = layout.boxPad * 2 + lines.length * layout.headLine;
            const out = {
                n: index + 1,
                status: names.length === 0 ? 'unknown' : status,
                direction: spoke?.direction === 'out' ? 'out' : 'in',
                relation,
                lines,
                empty: names.length === 0,
                relTop,
                x: boxX,
                y: top,
                w: boxW,
                h,
                cy: top + h / 2,
                relBox: {
                    x: boxX,
                    y: relTop,
                    w: Math.max(...relation.map((line) => textWidth(line, layout.groupSize, layout.charLabel)), 0),
                    h: relation.length * layout.groupLine
                },
                labelBox: {
                    x: boxX + layout.boxPad,
                    y: top + layout.boxPad,
                    w: Math.max(...lines.map((line) => textWidth(line, layout.headSize, layout.charHead)), 0),
                    h: lines.length * layout.headLine
                }
            };
            y = top + h + 9;
            return out;
        });
        return {
            kind: 'hub',
            width: layout.width,
            height: (spokes.length ? y - 9 : y) + layout.bottomPad,
            centre,
            spineX,
            spokes
        };
    }

    function hubSvg(spec, { id = 'fd', layout = LAYOUT } = {}) {
        const box = layoutHub(spec, layout);
        const title = str(spec?.title) ?? 'Relationships';
        const c = box.centre;
        const centre = `<g class="fd-hub-centre"><rect class="fd-lane-box" x="${attr(c.x)}" y="${attr(c.y)}" width="${attr(c.w)}" `
            + `height="${attr(c.h)}" rx="6" />`
            + textLines(c.lines, c.x + layout.boxPad, c.y + layout.boxPad + layout.labelSize * 0.85, layout.labelLine, 'fd-hub-label')
            + textLines(c.sub, c.x + layout.boxPad, c.y + layout.boxPad + c.lines.length * layout.labelLine + layout.groupSize * 0.9,
                layout.groupLine, 'fd-hub-sub') + '</g>';
        const last = box.spokes[box.spokes.length - 1];
        const spine = last
            ? `<line class="fd-spine" x1="${attr(box.spineX)}" y1="${attr(c.y + c.h)}" x2="${attr(box.spineX)}" y2="${attr(last.cy)}" />`
            : '';
        const spokes = box.spokes.map((spoke) => {
            const left = box.spineX;
            const right = spoke.x;
            const tip = spoke.direction === 'out' ? right : left;
            const dir = spoke.direction === 'out' ? 1 : -1;
            return `<g class="fd-step fd-st-${spoke.status}" data-step="${spoke.n}">`
                + textLines(spoke.relation, spoke.x, spoke.relTop + layout.groupSize * 0.9, layout.groupLine, 'fd-hub-rel')
                + `<rect class="fd-box${spoke.empty ? ' fd-box-unknown' : ''}" x="${attr(spoke.x)}" y="${attr(spoke.y)}" `
                + `width="${attr(spoke.w)}" height="${attr(spoke.h)}" rx="5" />`
                + textLines(spoke.lines, spoke.x + layout.boxPad, spoke.y + layout.boxPad + layout.headSize * 0.9,
                    layout.headLine, spoke.empty ? 'fd-hub-none' : 'fd-hub-name')
                + `<line class="fd-arrow-line" x1="${attr(dir === 1 ? left : left + layout.arrowHead * 1.4)}" y1="${attr(spoke.cy)}" `
                + `x2="${attr(dir === 1 ? right - layout.arrowHead * 1.4 : right)}" y2="${attr(spoke.cy)}" />`
                + `<path class="fd-arrow-head" d="${arrowHead(tip, spoke.cy, dir, layout.arrowHead)}" />`
                + '</g>';
        }).join('');
        const desc = `${str(spec?.centre?.label) ?? 'Programme'} and ${box.spokes.length} relations. `
            + box.spokes.map((spoke) => `${spoke.relation.join(' ')}: ${spoke.lines.join(' ')}`).join('; ');
        return svgOpen(box, id, title, desc) + centre + spine + spokes + '</svg>';
    }

    // ------------------------------------------------------------------------------------------
    // one entry point, the step list and the figure
    // ------------------------------------------------------------------------------------------

    function layoutDiagram(spec, layout = LAYOUT) {
        if (spec?.kind === 'flow') return layoutFlow(spec, layout);
        if (spec?.kind === 'hub') return layoutHub(spec, layout);
        return layoutSequence(spec, layout);
    }

    function diagramSvg(spec, options = {}) {
        if (spec?.kind === 'flow') return flowSvg(spec, options);
        if (spec?.kind === 'hub') return hubSvg(spec, options);
        return sequenceSvg(spec, options);
    }

    /** "Source: label, locator ↗" for one step — every step says where it came from, or that nothing does. */
    function sourceHtml(source) {
        const label = str(source?.label);
        const locator = str(source?.locator);
        const url = str(source?.url);
        if (label === null && url === null) return '<span class="fd-src fd-src-none">Source: not recorded</span>';
        const text = `${label ?? 'source'}${locator ? ` — ${locator}` : ''}`;
        const body = url !== null && isSafeUrl(url)
            ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`
            : escapeHtml(text);
        return `<span class="fd-src">Source: ${body}</span>`;
    }

    /** The accessible text twin of the drawing: every step in order, its status and its source. */
    function stepListHtml(spec, { sources = true } = {}) {
        if (spec?.kind === 'hub') {
            const items = list(spec?.spokes).map((spoke) => {
                const names = spokeNames(spoke);
                const status = names.length === 0 ? 'unknown' : statusOf(spoke?.status);
                return `<li class="fd-st-${status}"><strong>${escapeHtml(str(spoke?.relation) ?? 'related')}:</strong> `
                    + `${escapeHtml(names.length ? names.join(', ') : 'none named')} `
                    + `<span class="fd-chip fd-st-${status}">${escapeHtml(status)}</span>`
                    + (sources ? ` ${sourceHtml(spoke?.source)}` : '') + '</li>';
            }).join('');
            return `<ul class="fd-list">${items}</ul>`;
        }
        const items = list(spec?.steps).map((step) => {
            const status = statusOf(step?.status);
            const lane = (id) => str(list(spec?.lanes).find((l) => l?.id === id)?.label) ?? id;
            const who = spec?.kind === 'sequence' || spec?.kind === undefined
                ? (step?.from === step?.to ? `${lane(step?.from)}` : `${lane(step?.from)} → ${lane(step?.to)}`)
                : null;
            return `<li class="fd-st-${status}">`
                + (who ? `<span class="fd-who">${escapeHtml(who ?? '')}</span> ` : '')
                + `${escapeHtml(str(step?.label) ?? 'Step not described')} `
                + `<span class="fd-chip fd-st-${status}">${escapeHtml(status === 'unknown' ? 'not established' : status)}</span>`
                + (sources ? ` ${sourceHtml(step?.source)}` : '') + '</li>';
        }).join('');
        const loop = spec?.kind === 'flow' && str(spec?.loopBack?.label)
            ? `<p class="fd-loop-note">↺ ${escapeHtml(spec.loopBack.label)}</p>` : '';
        return `<ol class="fd-list">${items}</ol>${loop}`;
    }

    /** The statuses a spec actually uses, in legend order — the legend never lists a colour it does not draw. */
    function usedStatuses(spec) {
        const used = new Set();
        const items = spec?.kind === 'hub' ? list(spec?.spokes) : list(spec?.steps);
        for (const item of items) {
            const empty = spec?.kind === 'hub' && spokeNames(item).length === 0;
            used.add(empty ? 'unknown' : statusOf(item?.status));
        }
        for (const group of list(spec?.groups)) used.add(statusOf(group?.status));
        return STATUSES.filter((status) => used.has(status));
    }

    function legendHtml(spec) {
        const items = usedStatuses(spec).map((status) =>
            `<li><span class="fd-key fd-st-${status}"></span><b>${escapeHtml(status === 'unknown' ? 'not established' : status)}</b>`
            + ` <small>${escapeHtml(STATUS_LEGEND[status])}</small></li>`).join('');
        return items ? `<ul class="fd-legend" aria-label="Step colours">${items}</ul>` : '';
    }

    /**
     * The whole figure: drawing, caption, legend and the numbered step list. `compact` drops the
     * per-step sources and the note (for byte-capped cards) and keeps a link to where the full
     * figure lives. `open` shows the step list expanded; closed by default so a page of figures is
     * not a wall of text — the SVG's <desc> already carries every step for assistive technology.
     */
    function figureHtml(spec, options = {}) {
        const { id = 'fd', compact = false, href = null, hrefLabel = 'Full schematic', open = false, headingLevel = 0 } = options;
        const title = str(spec?.title) ?? 'Schematic';
        const note = compact ? null : str(spec?.note);
        const link = str(href) !== null && isSafeUrl(href)
            ? `<p class="fd-out"><a href="${escapeHtml(href)}">${escapeHtml(hrefLabel)}</a></p>` : '';
        const heading = headingLevel >= 2 && headingLevel <= 6
            ? `<h${headingLevel} class="fd-title">${escapeHtml(title)}</h${headingLevel}>`
            : `<strong class="fd-title">${escapeHtml(title)}</strong>`;
        const kindClass = spec?.kind === 'flow' ? 'fd-kind-flow' : spec?.kind === 'hub' ? 'fd-kind-hub' : 'fd-kind-sequence';
        return `<figure class="fd ${kindClass}${compact ? ' fd-compact' : ''}" data-schematic-id="${escapeHtml(str(spec?.id) ?? id)}">`
            + `<figcaption>${heading}${str(spec?.summary) ? `<span class="fd-summary">${escapeHtml(spec.summary)}</span>` : ''}</figcaption>`
            + `<div class="fd-canvas">${diagramSvg(spec, { id })}</div>`
            + legendHtml(spec)
            + `<details class="fd-steps"${open ? ' open' : ''}><summary>${spec?.kind === 'hub' ? 'Relations' : 'Steps'} as text</summary>`
            + stepListHtml(spec, { sources: !compact })
            + (note ? `<p class="fd-note">${escapeHtml(note)}</p>` : '')
            + '</details>'
            + link
            + '</figure>';
    }

    /** Two axis-aligned boxes overlap (touching edges do not count). */
    function boxesOverlap(a, b) {
        return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    }

    /** Every text box a layout draws, for the overlap tests. */
    function textBoxes(box, layout = LAYOUT) {
        if (box.kind === 'flow') return box.boxes.map((item) => item.labelBox);
        if (box.kind === 'hub') return box.spokes.flatMap((spoke) => [spoke.relBox, spoke.labelBox]);
        return [
            ...box.lanes.map((lane) => ({ x: lane.box.x, y: lane.box.y, w: lane.box.w, h: lane.box.h })),
            ...box.steps.map((step) => step.labelBox),
            ...box.groups.map((group) => group.labelBox)
        ].filter((b) => b.w > 0 && b.h > 0 && layout);
    }

    return {
        STATUSES,
        STATUS_LEGEND,
        LAYOUT,
        MAX_NAMES,
        wrapText,
        statusOf,
        layoutSequence,
        layoutFlow,
        layoutHub,
        layoutDiagram,
        sequenceSvg,
        flowSvg,
        hubSvg,
        diagramSvg,
        sourceHtml,
        stepListHtml,
        usedStatuses,
        legendHtml,
        figureHtml,
        boxesOverlap,
        textBoxes
    };
});
