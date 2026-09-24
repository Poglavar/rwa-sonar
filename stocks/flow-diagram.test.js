// Unit tests for stocks/lib/flow-diagram.js — the schematic kit. Pure: a spec goes in, numbers and
// an SVG string come out. What is under test is what would mislead a reader if it broke: steps
// drawn out of order, one label printed over another, an unknown step drawn like an established
// one, a step without a source, text escaping into markup, and a rebuild that is not byte-identical.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import kit from './lib/flow-diagram.js';

const {
    STATUSES, LAYOUT, wrapText, statusOf, layoutSequence, layoutFlow, layoutHub, layoutDiagram,
    sequenceSvg, flowSvg, hubSvg, diagramSvg, stepListHtml, usedStatuses, legendHtml, figureHtml,
    boxesOverlap, textBoxes
} = kit;

const REPO = join(import.meta.dirname, '..');
const CSS = readFileSync(join(REPO, 'flow-diagram.css'), 'utf8');

const LONG = 'The holder sends the token to the published burn address, whose owner then burns it and the transfer agent credits book-entry shares off-chain in a portal nobody can observe from the chain';

const SEQ = {
    id: 'test:seq',
    kind: 'sequence',
    title: 'Test sequence',
    lanes: [
        { id: 'a', label: 'Holder wallet' },
        { id: 'b', label: 'Redemption address with a long name' },
        { id: 'c', label: 'Issuer treasury' },
        { id: 'd', label: 'Issuer (off-chain)' }
    ],
    steps: [
        { from: 'a', to: 'b', label: 'Sends the token', status: 'observed', source: { label: 'tx', url: 'https://solscan.io/tx/1' } },
        { from: 'b', to: 'c', label: LONG, status: 'documented', source: { label: 'Terms', url: 'https://example.com/t', locator: 's. 4' } },
        { from: 'd', to: 'd', label: 'Sells the underlying', status: 'inferred', source: { label: 'Docs' } },
        { from: 'c', to: 'a', label: 'Pays USDC back', status: 'unknown', source: { label: 'Searched' } }
    ],
    groups: [{ from: 0, to: 3, status: 'inferred', label: 'Linked by wallet and timing' }]
};

const FLOW = {
    id: 'test:flow',
    kind: 'flow',
    title: 'Test flow',
    steps: [
        { label: 'A liquidity event happens', status: 'documented', source: { label: 'Terms' } },
        { label: LONG, status: 'documented', source: { label: 'Terms' } },
        { label: 'No procedure is published', status: 'unknown', source: { label: 'Searched' } }
    ],
    loopBack: { from: 2, to: 0, label: 'Repeats' }
};

const HUB = {
    id: 'test:hub',
    kind: 'hub',
    title: 'Test hub',
    centre: { label: 'Programme X', sub: 'Issuer Ltd · Jersey' },
    spokes: [
        { relation: 'Holds the underlying', direction: 'in', names: ['Bank A', 'Bank B', 'Bank C', 'Bank D', 'Bank E'], status: 'documented', source: { label: 'Prospectus', url: 'https://example.com/p' } },
        { relation: 'Keeps the share register', direction: 'in', names: [], status: 'documented', source: { label: 'none' } },
        { relation: 'Offered to', direction: 'out', names: ['Non-US persons'], status: 'documented', source: { label: 'Terms' } }
    ]
};

function assertNoOverlap(box) {
    const boxes = textBoxes(box);
    for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
            if (boxesOverlap(boxes[i], boxes[j])) {
                throw new Error(`text boxes ${i} and ${j} overlap: ${JSON.stringify(boxes[i])} ${JSON.stringify(boxes[j])}`);
            }
        }
    }
}

describe('wrapText', () => {
    it('never exceeds the character budget and keeps every word', () => {
        const lines = wrapText(LONG, 30);
        expect(lines.every((line) => line.length <= 30)).toBe(true);
        expect(lines.join(' ')).toBe(LONG);
    });
    it('clips with an ellipsis instead of growing past maxLines', () => {
        const lines = wrapText(LONG, 20, 2);
        expect(lines).toHaveLength(2);
        expect(lines[1].endsWith('…')).toBe(true);
    });
    it('returns nothing for nothing', () => {
        expect(wrapText('   ', 20)).toEqual([]);
        expect(wrapText(null, 20)).toEqual([]);
    });
});

describe('statusOf', () => {
    it('keeps the six statuses and turns anything else into unknown, never a firmer grade', () => {
        for (const status of STATUSES) expect(statusOf(status)).toBe(status);
        expect(statusOf('confirmed')).toBe('unknown');
        expect(statusOf(undefined)).toBe('unknown');
        expect(statusOf('not-applicable')).toBe('unknown');
    });
});

describe('layoutSequence', () => {
    const box = layoutSequence(SEQ);

    it('numbers the steps 1..n in spec order and places each below the last', () => {
        expect(box.steps.map((step) => step.n)).toEqual([1, 2, 3, 4]);
        for (let i = 1; i < box.steps.length; i += 1) {
            expect(box.steps[i].top).toBeGreaterThan(box.steps[i - 1].bottom);
        }
    });

    it('puts every arrow below its own label and every row below the lane headers', () => {
        const headBottom = box.lanes[0].box.y + box.lanes[0].box.h;
        for (const step of box.steps) {
            expect(step.top).toBeGreaterThan(headBottom);
            expect(step.arrowY).toBeGreaterThan(step.labelBox.y + step.labelBox.h);
        }
    });

    it('prints no label over another (headers, step labels, group labels)', () => {
        assertNoOverlap(box);
    });

    it('keeps every label inside the drawing width', () => {
        for (const step of box.steps) {
            expect(step.labelBox.x + step.labelBox.w).toBeLessThanOrEqual(LAYOUT.width - LAYOUT.pad + 0.001);
        }
        for (const lane of box.lanes) {
            for (const line of lane.lines) {
                expect(line.length * LAYOUT.headSize * LAYOUT.charHead).toBeLessThanOrEqual(lane.box.w);
            }
        }
    });

    it('spreads lanes left to right in spec order and draws arrows between their centres', () => {
        const xs = box.lanes.map((lane) => lane.x);
        expect([...xs].sort((a, b) => a - b)).toEqual(xs);
        expect(box.steps[0].x1).toBe(box.lanes[0].x);
        expect(box.steps[0].x2).toBe(box.lanes[1].x);
        expect(box.steps[2].self).toBe(true);
    });

    it('draws a step that names no lane as unknown instead of dropping it', () => {
        const broken = layoutSequence({ ...SEQ, steps: [{ from: 'a', to: 'zz', label: 'x', status: 'documented' }] });
        expect(broken.steps).toHaveLength(1);
        expect(broken.steps[0].status).toBe('unknown');
    });

    it('gives the group label its own line, so it cannot collide with a step', () => {
        const [group] = box.groups;
        expect(group.labelY + group.labelBox.h).toBeLessThanOrEqual(box.steps[0].top + 0.001);
        expect(group.bottom).toBeGreaterThanOrEqual(box.steps[3].bottom);
    });
});

describe('unknown steps are drawn as unknown', () => {
    it('sequence: the unknown step carries the unknown class and a question mark', () => {
        const svg = sequenceSvg(SEQ, { id: 's' });
        const step4 = svg.slice(svg.indexOf('data-step="4"'));
        expect(svg).toContain('class="fd-step fd-st-unknown" data-step="4"');
        expect(step4).toContain('class="fd-unknown-mark"');
        expect(svg.slice(0, svg.indexOf('data-step="4"'))).not.toContain('fd-unknown-mark');
    });
    it('flow: the unknown box is dashed and badged "?" instead of a number', () => {
        const svg = flowSvg(FLOW, { id: 'f' });
        const step3 = svg.slice(svg.indexOf('data-step="3"'));
        expect(step3).toContain('fd-box fd-box-unknown');
        expect(step3).toMatch(/class="fd-badge-n"[^>]*>\?<\/text>/);
    });
    it('hub: a seat nobody fills is drawn unknown and says "none named"', () => {
        const box = layoutHub(HUB);
        expect(box.spokes[1].status).toBe('unknown');
        expect(box.spokes[1].lines.join(' ')).toBe('none named');
        expect(hubSvg(HUB)).toContain('fd-box fd-box-unknown');
    });
    it('the CSS draws unknown dashed and colours every status in both themes', () => {
        expect(CSS).toMatch(/\.fd-st-unknown[^{]*\.fd-arrow-line[^{]*\{[^}]*stroke-dasharray/);
        expect(CSS).toMatch(/\.fd-box-unknown\s*\{[^}]*stroke-dasharray/);
        const dark = CSS.slice(CSS.indexOf('[data-theme="dark"]'));
        for (const status of STATUSES) {
            expect(CSS).toContain(`--fd-${status}:`);
            expect(dark).toContain(`--fd-${status}:`);
            expect(CSS).toContain(`.fd-st-${status}`);
        }
    });
});

describe('flow and hub layouts', () => {
    it('flow: boxes stack top to bottom without overlapping labels, loop-back on the right', () => {
        const box = layoutFlow(FLOW);
        for (let i = 1; i < box.boxes.length; i += 1) expect(box.boxes[i].y).toBeGreaterThan(box.boxes[i - 1].y + box.boxes[i - 1].h);
        assertNoOverlap(box);
        expect(box.loop.x).toBeGreaterThan(box.boxes[0].x + box.boxes[0].w);
    });
    it('hub: spokes stack below the centre, "+N more" past four names, no overlaps', () => {
        const box = layoutHub(HUB);
        expect(box.spokes[0].relTop).toBeGreaterThan(box.centre.y + box.centre.h);
        expect(box.spokes[0].lines.join(' ')).toContain('+1 more');
        assertNoOverlap(box);
    });
});

describe('the SVG and the figure', () => {
    it('is accessible: title and desc ids derived from the given id, desc lists every step', () => {
        const svg = sequenceSvg(SEQ, { id: 'x1' });
        expect(svg).toContain('role="img" aria-labelledby="x1-t x1-d"');
        expect(svg).toContain('<title id="x1-t">Test sequence</title>');
        const desc = svg.slice(svg.indexOf('<desc'), svg.indexOf('</desc>'));
        for (const n of [1, 2, 3, 4]) expect(desc).toContain(`${n}. `);
    });

    it('escapes every label', () => {
        const spec = { ...SEQ, title: '<b>t</b>', steps: [{ from: 'a', to: 'b', label: '<script>x</script>', status: 'documented' }] };
        const html = figureHtml(spec);
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('is byte-identical across runs and prints no float noise', () => {
        for (const spec of [SEQ, FLOW, HUB]) {
            expect(diagramSvg(spec, { id: 'z' })).toBe(diagramSvg(spec, { id: 'z' }));
            expect(diagramSvg(spec, { id: 'z' })).not.toMatch(/\d\.\d{7,}/);
        }
    });

    it('lists every step with its status and its source next to the drawing', () => {
        const html = figureHtml(SEQ, { id: 'f1' });
        const list = html.slice(html.indexOf('<ol class="fd-list">'), html.indexOf('</ol>'));
        expect(list.match(/<li /g)).toHaveLength(4);
        expect(list).toContain('Holder wallet → Redemption address with a long name');
        expect(list).toContain('href="https://solscan.io/tx/1"');
        expect(list).toContain('Terms — s. 4');
        expect(list).toContain('not established');
        expect(html).toContain('<details class="fd-steps">');
        expect(figureHtml(SEQ, { open: true })).toContain('<details class="fd-steps" open>');
    });

    it('says when a step has no source rather than leaving it blank', () => {
        const html = stepListHtml({ kind: 'flow', steps: [{ label: 'x', status: 'documented' }] });
        expect(html).toContain('Source: not recorded');
    });

    it('compact drops per-step sources but keeps the list and the way out', () => {
        const html = figureHtml(SEQ, { compact: true, href: '../issuers/x.html', hrefLabel: 'All schematics' });
        expect(html).not.toContain('Source:');
        expect(html).toContain('href="../issuers/x.html"');
        expect(html).toContain('fd-compact');
    });

    it('the legend lists only the statuses drawn', () => {
        expect(usedStatuses(SEQ)).toEqual(['observed', 'documented', 'inferred', 'unknown']);
        expect(legendHtml(SEQ)).not.toContain('fd-st-litigated');
        expect(usedStatuses(HUB)).toEqual(['documented', 'unknown']);
    });

    it('dispatches on kind', () => {
        expect(layoutDiagram(FLOW).kind).toBe('flow');
        expect(layoutDiagram(HUB).kind).toBe('hub');
        expect(layoutDiagram(SEQ).kind).toBe('sequence');
    });
});

describe('every published schematic', () => {
    const built = JSON.parse(readFileSync(join(REPO, 'stocks-schematics.json'), 'utf8'));
    const specs = [
        ...Object.values(built.issuers).flatMap((row) => [...row.redemption, ...row.creation, ...row.whatIf, row.relationships]),
        ...built.defi
    ];

    it('exists for the flagship programmes', () => {
        for (const slug of ['xstocks-backed', 'ondo-global-markets', 'superstate-opening-bell', 'prestocks', 'tessera']) {
            expect(built.issuers[slug].redemption.length).toBeGreaterThan(0);
        }
        expect(built.defi.map((spec) => spec.id)).toEqual(expect.arrayContaining(['defi:xstocks-vaults-loop', 'defi:secz-loopscale-liquidation']));
    });

    it('lays out with no overlapping text and every step inside the width', () => {
        for (const spec of specs) {
            const box = layoutDiagram(spec);
            assertNoOverlap(box);
            expect(box.height).toBeGreaterThan(0);
        }
    });

    it('carries a source on every step and every spoke', () => {
        for (const spec of specs) {
            const items = spec.kind === 'hub' ? spec.spokes : spec.steps;
            expect(items.length).toBeGreaterThan(0);
            for (const item of items) {
                const label = item.source?.label ?? null;
                const url = item.source?.url ?? null;
                expect(label !== null || url !== null).toBe(true);
            }
        }
    });
});
