/*
 * Page hook for the schematics: fills every element carrying `data-schematic` with figures drawn
 * by stocks/lib/flow-diagram.js from stocks-schematics.json (stocks/build-schematics.mjs). Used by
 * hand-written pages (learn articles, flows.html, exits.html) and by the stocks issuer panel, so a
 * page needs only a placeholder element, never its own drawing code:
 *
 *   <figure data-schematic="defi:xstocks-vaults-loop"></figure>          one spec by id
 *   <div data-schematic="issuer:ondo-global-markets"></div>              that issuer's redemption,
 *                                                                        creation and relationship figures
 *   <div data-schematic="whatif:custodian-insolvency:xstocks-backed ondo-global-markets:redemption"></div>
 *
 * Space-separated ids draw in order. An id the file does not hold is said in words, never skipped.
 * Needs fmt.js, stocks/lib/flow-diagram.js and stocks/lib/schematics.js loaded first. Declares no globals except
 * window.__rwaSchematicHook ({ load, fill }).
 */
(function (root) {
    'use strict';

    const kit = root.__rwaFlowDiagram;
    const lib = root.__rwaSchematics;
    const script = typeof document !== 'undefined' ? document.currentScript : null;
    // The data file sits beside this script at the site root, wherever the page itself lives.
    const DATA_URL = script && script.src ? new URL('stocks-schematics.json', script.src).href : './stocks-schematics.json';
    let pending = null;

    function log(message, detail) {
        console.error(`[${new Date().toISOString()}] schematics: ${message}`, detail ?? '');
    }

    /** The built file, fetched once per page. */
    function load() {
        if (pending === null) {
            pending = fetch(DATA_URL, { headers: { accept: 'application/json' } })
                .then((res) => {
                    if (!res.ok) throw new Error(`${DATA_URL} answered HTTP ${res.status}`);
                    return res.json();
                });
        }
        return pending;
    }

    let counter = 0;

    /** Draws into one placeholder. `data-schematic-open` shows the step lists expanded. */
    function fillOne(el, data) {
        const tokens = String(el.getAttribute('data-schematic') || '').split(/\s+/).filter(Boolean);
        const open = el.hasAttribute('data-schematic-open');
        const parts = tokens.map((token) => {
            const specs = lib.specsForToken(data, token);
            if (specs === null || specs.length === 0) {
                log(`no schematic "${token}" in ${DATA_URL}`);
                return `<p class="fd-empty">No schematic is recorded for “${token.replace(/[<>&"]/g, '')}”.</p>`;
            }
            return specs.map((spec) => {
                counter += 1;
                return kit.figureHtml(spec, { id: `fdh-${counter}`, open });
            }).join('');
        });
        const html = parts.join('');
        el.innerHTML = tokens.length > 1 || el.hasAttribute('data-schematic-grid') ? `<div class="fd-grid">${html}</div>` : html;
        el.setAttribute('data-schematic-ready', '');
    }

    /** Fills every unfilled placeholder under `scope` (the document by default). */
    async function fill(scope) {
        if (!kit || !lib) {
            log('stocks/lib/flow-diagram.js or stocks/lib/schematics.js did not load; schematics are not drawn');
            return;
        }
        const els = [...(scope || document).querySelectorAll('[data-schematic]:not([data-schematic-ready])')];
        if (els.length === 0) return;
        try {
            const data = await load();
            for (const el of els) fillOne(el, data);
        } catch (err) {
            log('could not load the schematics file', err.message);
            for (const el of els) {
                el.innerHTML = '<p class="fd-empty">The schematic could not be loaded.</p>';
            }
        }
    }

    root.__rwaSchematicHook = { load, fill };
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => fill());
        else fill();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
