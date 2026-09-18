// Unit tests for stocks/lib/trustchain-svg.js — the pure drawing of the trust chain. No DOM, no
// network, no clock: a chain object goes in and an SVG string comes out, which is the whole reason
// the panel and the card builder can be trusted to draw the same diagram.
//
// What is under test is what a reader would be misled by if it broke: a link drawn in the colour of
// a firmer evidence grade than it has, a verification grade whose line style silently collapses into
// another one's, an actor nobody fills quietly vanishing from the chain (the empty seat is the
// finding), a party name escaping into the markup unescaped, and the output drifting between two
// runs so that a rebuilt card is never byte-identical.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import svg from './lib/trustchain-svg.js';
import { TRUST_CHAIN, buildChain } from './lib/trustchain.mjs';

const {
    EVIDENCE_GRADES, VERIFICATION_GRADES, LAYOUT, MAX_PARTIES,
    cut, evidenceClass, verificationClass, wrapText, partyNames, nodeLines, flowStops,
    layoutChain, chainSvg, legendHtml, flowListHtml, diagramHtml
} = svg;

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const STOCKS_CSS = readFileSync(join(REPO, 'stocks.css'), 'utf8');
const CARD_CSS = readFileSync(join(REPO, 'card.css'), 'utf8');

/** A minimal chain: three actors, one link between two of them. */
function tinyChain() {
    return {
        nodes: [
            { actor: 'holder', label: 'Holder', parties: [{ name: 'non-US persons' }] },
            { actor: 'custodian', label: 'Custodian or prime broker', parties: [{ name: 'Alpaca Crypto LLC' }] },
            { actor: 'company', label: 'Underlying company', parties: [] }
        ],
        links: [{
            flow: 'ownership',
            label: 'Ownership of the underlying',
            from: 'company',
            to: 'holder',
            via: ['custodian'],
            evidence: 'documented',
            verification: 'onchain',
            fields: [{ field: 'legalForm', value: 'tracker-certificate', claimStatus: 'confirmed' }],
            summary: 'Ownership of the underlying: Underlying company → Holder.'
        }]
    };
}

/** The 13 catalogue actors with no parties at all — a chain for an issuer nobody has researched. */
function emptyChain() {
    return {
        nodes: TRUST_CHAIN.actors.map((actor) => ({ actor: actor.id, label: actor.label, parties: [] })),
        links: TRUST_CHAIN.flows.map((flow) => ({
            flow: flow.id,
            label: flow.label,
            from: flow.from,
            to: flow.to,
            via: flow.via ?? [],
            evidence: 'unknown',
            verification: 'none',
            fields: [],
            summary: null
        }))
    };
}

/** Every `<g class="…" data-flow="id">` class list in a drawing, by flow id. */
function laneClasses(markup) {
    const out = {};
    const re = /<g class="(tc-lane[^"]*)" data-flow="([^"]*)"/g;
    let match;
    while ((match = re.exec(markup)) !== null) out[match[2]] = match[1].split(' ');
    return out;
}

describe('grade classes', () => {
    test('every evidence grade gets its own class and an unknown value falls back to unknown', () => {
        expect(EVIDENCE_GRADES.map(evidenceClass)).toEqual([
            'tc-ev-documented', 'tc-ev-inferred', 'tc-ev-asserted', 'tc-ev-unknown'
        ]);
        expect(new Set(EVIDENCE_GRADES.map(evidenceClass)).size).toBe(EVIDENCE_GRADES.length);
        expect(evidenceClass('excellent')).toBe('tc-ev-unknown');
        expect(evidenceClass(null)).toBe('tc-ev-unknown');
    });

    test('every verification grade gets its own class and an unknown value falls back to none', () => {
        expect(VERIFICATION_GRADES.map(verificationClass)).toEqual([
            'tc-vf-onchain', 'tc-vf-attested', 'tc-vf-self-reported', 'tc-vf-none'
        ]);
        expect(new Set(VERIFICATION_GRADES.map(verificationClass)).size).toBe(VERIFICATION_GRADES.length);
        expect(verificationClass('audited')).toBe('tc-vf-none');
    });

    test('both stylesheets define all eight grade classes, so no lane is drawn unstyled', () => {
        for (const css of [STOCKS_CSS, CARD_CSS]) {
            for (const grade of EVIDENCE_GRADES) expect(css).toContain(`--tc-${grade}`);
            for (const grade of VERIFICATION_GRADES) expect(css).toContain(`.tc-vf-${grade}`);
        }
    });

    test('on a narrow screen the drawing scrolls in its own box, never the page', () => {
        // The type is unreadable if the 360-unit viewBox is scaled into 254 px, so below 420 px the
        // canvas becomes its own horizontal scroller at 1 unit to 1 px. The page must not.
        for (const css of [STOCKS_CSS, CARD_CSS]) {
            const at = css.indexOf('@media (max-width: 420px)');
            expect(at).toBeGreaterThan(-1);
            const block = css.slice(at, css.indexOf('\n}', css.indexOf('.tc-svg {', at)));
            expect(block).toContain('overflow-x: auto');
            expect(block).toContain('width: 360px');
        }
    });

    test('a collapsible row shows a disclosure chevron of its own in both stylesheets', () => {
        // Chrome removes the native triangle from any <summary> with a `display` other than
        // list-item, and both .wi-item's and .tc-flow's are grid/flex — so 47 openable rows would
        // read as static text with nothing to say they open (found in the browser, 2026-09-18).
        for (const css of [STOCKS_CSS, CARD_CSS]) {
            expect(css).toMatch(/\.wi-item > summary::before[\s\S]{0,200}content:/);
            expect(css).toMatch(/\.tc-flow\[open\] > summary::before/);
            expect(css).toContain('summary::-webkit-details-marker');
        }
    });

    test('each verification grade maps to a distinct dash pattern in both stylesheets', () => {
        for (const css of [STOCKS_CSS, CARD_CSS]) {
            const dashes = VERIFICATION_GRADES.map((grade) => {
                const at = css.indexOf(`.tc-vf-${grade} .tc-lane-line`);
                expect(at).toBeGreaterThan(-1);
                const block = css.slice(at, css.indexOf('}', at));
                const dash = /stroke-dasharray:\s*([^;]+)/.exec(block);
                return dash === null ? 'solid' : dash[1].trim();
            });
            // `onchain` is the solid one; the other three must differ from it and from each other.
            expect(dashes[0]).toBe('solid');
            expect(new Set(dashes).size).toBe(VERIFICATION_GRADES.length);
        }
    });
});

describe('wrapText', () => {
    test('breaks on word boundaries and never exceeds the limit', () => {
        const lines = wrapText('InCore Bank AG, Maerki Baumann & Co. AG, Alpaca Securities', 20);
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
        expect(lines.join(' ')).toBe('InCore Bank AG, Maerki Baumann & Co. AG, Alpaca Securities');
    });

    test('hard splits a single word longer than the limit rather than overflowing', () => {
        expect(wrapText('AAAAAAAAAA', 4)).toEqual(['AAAA', 'AAAA', 'AA']);
    });

    test('blank and missing text produce no lines at all', () => {
        expect(wrapText('   ', 10)).toEqual([]);
        expect(wrapText(null, 10)).toEqual([]);
    });
});

describe('nodeLines', () => {
    test('a node with parties prints their distinct names', () => {
        const lines = nodeLines({ label: 'Tokenization provider', parties: [{ name: 'Kraken' }, { name: 'Backed Finance AG' }, { name: 'Kraken' }] });
        expect(lines.empty).toBe(false);
        expect(lines.parties.join(' ')).toBe('Kraken, Backed Finance AG');
    });

    test('a node nobody fills says so instead of printing nothing', () => {
        const lines = nodeLines({ label: 'Transfer agent', parties: [] });
        expect(lines.empty).toBe(true);
        expect(lines.parties.join(' ')).toBe('no party named');
    });

    test('more parties than fit are counted, never silently dropped', () => {
        const many = Array.from({ length: MAX_PARTIES + 3 }, (_, i) => ({ name: `Party${i}` }));
        const lines = nodeLines({ label: 'Custodian', parties: many });
        expect(lines.parties.join(' ')).toContain('+3 more');
    });

    test('parties are capped to the configured number of lines', () => {
        const lines = nodeLines({
            label: 'Custodian or prime broker',
            parties: [{ name: 'A very long custodian name indeed limited partnership' },
                { name: 'Another extremely long custodian name limited company' },
                { name: 'A third long custodian name incorporated somewhere' },
                { name: 'A fourth long custodian name incorporated somewhere else' }]
        });
        expect(lines.parties.length).toBeLessThanOrEqual(LAYOUT.maxPartyLines);
        expect(lines.parties[lines.parties.length - 1]).toMatch(/…$/);
    });

    test('partyNames drops a party with no name and keeps the dossier order', () => {
        expect(partyNames({ parties: [{ name: 'B' }, { role: 'custodian' }, { name: 'A' }] })).toEqual(['B', 'A']);
    });
});

describe('layoutChain', () => {
    test('one row per node, one lane per link, rows in chain order and never overlapping', () => {
        const box = layoutChain(emptyChain());
        expect(box.rows).toHaveLength(13);
        expect(box.lanes).toHaveLength(9);
        expect(box.rows.map((row) => row.actor)).toEqual(TRUST_CHAIN.actors.map((a) => a.id));
        for (let i = 1; i < box.rows.length; i += 1) {
            expect(box.rows[i].y).toBeGreaterThanOrEqual(box.rows[i - 1].y + box.rows[i - 1].height);
        }
        expect(box.height).toBeGreaterThan(box.rows[12].y + box.rows[12].height);
    });

    test('lanes are side by side and inside the gutter, never over the node boxes', () => {
        const box = layoutChain(emptyChain());
        const xs = box.lanes.map((lane) => lane.x);
        expect(new Set(xs).size).toBe(xs.length);
        for (const x of xs) expect(x).toBeLessThan(LAYOUT.nodeX - LAYOUT.nodeGap);
    });

    test('a lane stops on exactly the actors its flow touches, in travel order', () => {
        const box = layoutChain(emptyChain());
        const lane = box.lanes.find((l) => l.flow === 'ownership');
        expect(lane.stops.map((stop) => stop.actor))
            .toEqual(['company', 'custodian', 'token-issuer', 'token-program', 'holder']);
        expect(lane.from.actor).toBe('company');
        expect(lane.to.actor).toBe('holder');
        expect(lane.loop).toBe(false);
    });

    test('a flow whose ends are the same actor is marked as a loop, not arrowed', () => {
        const box = layoutChain(emptyChain());
        const lane = box.lanes.find((l) => l.flow === 'transfer');
        expect(lane.from.actor).toBe('holder');
        expect(lane.to.actor).toBe('holder');
        expect(lane.loop).toBe(true);
    });

    test('flowStops drops an actor the flow does not name', () => {
        expect(flowStops({ from: 'a', to: 'c', via: ['b', null] })).toEqual(['a', 'b', 'c']);
    });
});

describe('chainSvg', () => {
    test('draws one node group per actor and one lane group per flow', () => {
        const markup = chainSvg(emptyChain());
        expect(markup.match(/class="tc-node[ "]/g)).toHaveLength(13);
        expect(markup.match(/data-flow="/g)).toHaveLength(9);
    });

    test('an issuer with empty parties still renders all 13 nodes and says each seat is empty', () => {
        const markup = chainSvg(emptyChain());
        expect(markup.match(/tc-node tc-node-empty/g)).toHaveLength(13);
        expect(markup.match(/no party named/g)).toHaveLength(13);
        for (const actor of TRUST_CHAIN.actors) {
            expect(markup).toContain(`data-actor="${actor.id}"`);
        }
    });

    test('a documented link gets the documented class, and nothing firmer than it has', () => {
        const chain = tinyChain();
        const classes = laneClasses(chainSvg(chain)).ownership;
        expect(classes).toContain('tc-ev-documented');
        expect(classes).not.toContain('tc-ev-inferred');
        expect(classes).not.toContain('tc-ev-asserted');
        expect(classes).not.toContain('tc-ev-unknown');
    });

    test('each evidence grade reaches the lane it was given, and no other', () => {
        for (const grade of EVIDENCE_GRADES) {
            const chain = tinyChain();
            chain.links[0].evidence = grade;
            const classes = laneClasses(chainSvg(chain)).ownership;
            expect(classes).toContain(`tc-ev-${grade}`);
            for (const other of EVIDENCE_GRADES) {
                if (other !== grade) expect(classes).not.toContain(`tc-ev-${other}`);
            }
        }
    });

    test('verification maps to the lane class whose dash pattern the stylesheet defines', () => {
        for (const grade of VERIFICATION_GRADES) {
            const chain = tinyChain();
            chain.links[0].verification = grade;
            expect(laneClasses(chainSvg(chain)).ownership).toContain(`tc-vf-${grade}`);
        }
    });

    test('a lane carries a hover title naming both of its grades', () => {
        const markup = chainSvg(tinyChain());
        expect(markup).toContain(
            '<title>Ownership of the underlying — documented evidence, onchain verification</title>');
    });

    test('the drawing is deterministic: the same chain twice is the same string', () => {
        expect(chainSvg(tinyChain())).toBe(chainSvg(tinyChain()));
        expect(chainSvg(emptyChain())).toBe(chainSvg(emptyChain()));
    });

    test('no coordinate prints as a float-noise number', () => {
        expect(chainSvg(emptyChain())).not.toMatch(/\d\.\d{7}/);
    });

    test('a party name is escaped, so a dossier cannot inject markup', () => {
        const chain = tinyChain();
        chain.nodes[0].parties = [{ name: '<script>x</script>' }];
        const markup = chainSvg(chain);
        expect(markup).not.toContain('<script>');
        expect(markup).toContain('&lt;script&gt;');
    });

    test('the id prefix reaches the title and description, so two diagrams can share a page', () => {
        const markup = chainSvg(tinyChain(), { id: 'card-chain' });
        expect(markup).toContain('id="card-chain-t"');
        expect(markup).toContain('aria-labelledby="card-chain-t card-chain-d"');
    });

    test('a chain with no nodes draws nothing rather than throwing', () => {
        expect(chainSvg({ nodes: [], links: [] })).toContain('<svg');
        expect(chainSvg(null)).toContain('<svg');
    });
});

describe('legendHtml', () => {
    test('names all four colours and all four line styles', () => {
        const html = legendHtml();
        for (const grade of EVIDENCE_GRADES) expect(html).toContain(`tc-key-swatch tc-ev-${grade}`);
        for (const grade of VERIFICATION_GRADES) expect(html).toContain(`tc-key-line tc-vf-${grade}`);
    });
});

describe('flowListHtml', () => {
    test('one collapsible per flow, with both grades and the fields it rests on', () => {
        const html = flowListHtml(tinyChain());
        expect(html.match(/<details class="tc-flow"/g)).toHaveLength(1);
        expect(html).toContain('documented · onchain');
        expect(html).toContain('legalForm');
        expect(html).toContain('tc-claim-confirmed');
    });

    test('prints the flow’s whole summary by default, not an ellipsis standing in for it', () => {
        // The default is NO limit, and it has to be asserted on the TEXT: an element that is
        // present but says only "…" passes every structural check, which is exactly how the
        // issuer panel shipped nine empty summaries past this suite once (2026-09-18).
        const html = flowListHtml(tinyChain());
        expect(html).toContain(
            '<p class="tc-flow-summary">Ownership of the underlying: Underlying company → Holder.</p>');
        expect(html).not.toContain('<p class="tc-flow-summary">…</p>');
    });

    test('cuts the summary only when asked, and then keeps words in front of the ellipsis', () => {
        const chain = tinyChain();
        chain.links[0].summary = 'one two three four five six seven eight nine ten eleven twelve';
        const html = flowListHtml(chain, { maxSummary: 24 });
        const summary = /<p class="tc-flow-summary">([^<]*)<\/p>/.exec(html)[1];
        expect(summary.length).toBeLessThanOrEqual(25);
        expect(summary).toMatch(/^one two/);
        expect(summary).toMatch(/…$/);
    });

    test('a field with no claim says "no claim", never a status it does not have', () => {
        const chain = tinyChain();
        chain.links[0].fields = [{ field: 'voting', value: null, claimStatus: null }];
        const html = flowListHtml(chain);
        expect(html).toContain('>no claim<');
        expect(html).toContain('tc-claim-none');
    });

    test('a long field value is cut visibly, never silently', () => {
        const chain = tinyChain();
        chain.links[0].fields = [{ field: 'holderClaim', value: 'x'.repeat(400), claimStatus: 'confirmed' }];
        expect(flowListHtml(chain)).toContain('…');
    });

    test('fields can be left off for a byte-capped card', () => {
        expect(flowListHtml(tinyChain(), { fields: false })).not.toContain('legalForm');
    });

    test('a chain with no links says so', () => {
        expect(flowListHtml({ nodes: [], links: [] })).toContain('No rights flows graded');
    });
});

describe('diagramHtml', () => {
    test('one block with the drawing, the legend and the flow list', () => {
        const html = diagramHtml(tinyChain(), { id: 'panel-chain' });
        expect(html).toContain('class="tc-diagram"');
        expect(html).toContain('<svg');
        expect(html).toContain('tc-key');
        expect(html).toContain('tc-flows');
    });

    test('a chain that was never built says so rather than drawing an empty frame', () => {
        expect(diagramHtml({ nodes: [], links: [] })).toContain('No trust chain has been built');
    });

    test('an unsafe out-link is dropped, a safe one is kept', () => {
        expect(diagramHtml(tinyChain(), { href: 'javascript:alert(1)' })).not.toContain('javascript:');
        expect(diagramHtml(tinyChain(), { href: '../stocks.html#issuers' })).toContain('../stocks.html#issuers');
    });
});

describe('cut', () => {
    test('keeps short text whole and marks a cut with an ellipsis', () => {
        expect(cut('short', 50)).toBe('short');
        expect(cut('  ', 50)).toBeNull();
        const long = cut('one two three four five six seven eight nine ten', 20);
        expect(long.length).toBeLessThanOrEqual(21);
        expect(long).toMatch(/…$/);
    });

    test('a max of 0 means no limit, not "cut everything"', () => {
        // Without this guard, 0 cut every string to the empty string and returned a bare "…",
        // silently erasing the text it was handed.
        expect(cut('the whole sentence survives', 0)).toBe('the whole sentence survives');
        expect(cut('the whole sentence survives')).toBe('the whole sentence survives');
        expect(cut('x', -5)).toBe('x');
    });
});

describe('against the repo’s real chain', () => {
    test('the xStocks chain draws 13 nodes and 9 graded lanes', () => {
        const dossier = JSON.parse(readFileSync(
            join(REPO, 'stocks', 'data', 'issuers', 'xstocks-backed.json'), 'utf8'));
        const chain = buildChain(dossier, TRUST_CHAIN);
        const markup = chainSvg(chain);
        expect(chain.nodes).toHaveLength(TRUST_CHAIN.actors.length);
        expect(chain.links).toHaveLength(TRUST_CHAIN.flows.length);
        expect(markup.match(/data-flow="/g)).toHaveLength(TRUST_CHAIN.flows.length);
        // Every lane must carry one of the four colours: a lane with no evidence class would be
        // drawn in the stylesheet's fallback and read as firmer or weaker than it is.
        for (const classes of Object.values(laneClasses(markup))) {
            expect(classes.filter((c) => c.startsWith('tc-ev-'))).toHaveLength(1);
            expect(classes.filter((c) => c.startsWith('tc-vf-'))).toHaveLength(1);
        }
    });
});
