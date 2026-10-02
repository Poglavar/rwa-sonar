/*
 * Draws the catalogue funnel (token addresses → issuers → control recipes → token program) into
 * any page element carrying `data-funnel-figure`, from stocks-funnel.json and the same
 * stocks/lib/funnel-layout.js the stocks page uses — so the landing and powers pages show the
 * built numbers, never typed ones. Clicking an issuer circle opens that issuer's dossier page.
 * Needs fmt.js and stocks/lib/funnel-layout.js loaded first; declares no globals.
 */
(function (root) {
    'use strict';

    const lib = root.__rwaFunnelLayout;
    const script = typeof document !== 'undefined' ? document.currentScript : null;
    // Data and dossiers sit beside this script at the site root, wherever the page itself lives.
    const base = script && script.src ? script.src : `${location.origin}/`;
    const DATA_URL = new URL('stocks-funnel.json', base).href;

    function log(message, detail) {
        console.error(`[${new Date().toISOString()}] funnel figure: ${message}`, detail ?? '');
    }

    function draw(el, funnel) {
        const title = lib.funnelTitle(funnel);
        const layout = lib.funnelLayout(funnel, {});
        if (title === null || layout.nodes.length === 0) {
            el.hidden = true;
            return;
        }
        const heading = el.querySelector('[data-funnel-title]');
        if (heading) heading.textContent = title;
        const canvas = el.querySelector('[data-funnel-canvas]') ?? el;
        canvas.innerHTML = `<div class="funnel-scroll"><div class="funnel-graphic">${lib.funnelSvg(layout)}</div></div>`;
        el.hidden = false;
        const open = (target) => {
            const node = target.closest('[data-slug]');
            if (node) location.href = new URL(`issuers/${encodeURIComponent(node.getAttribute('data-slug'))}.html`, base).href;
        };
        canvas.addEventListener('click', (event) => open(event.target));
        canvas.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open(event.target);
            }
        });
    }

    async function boot() {
        const els = [...document.querySelectorAll('[data-funnel-figure]')];
        if (els.length === 0) return;
        if (!lib) {
            log('stocks/lib/funnel-layout.js did not load; the funnel is not drawn');
            return;
        }
        try {
            const res = await fetch(DATA_URL, { headers: { accept: 'application/json' } });
            if (!res.ok) throw new Error(`${DATA_URL} answered HTTP ${res.status}`);
            const funnel = await res.json();
            for (const el of els) draw(el, funnel);
        } catch (err) {
            log('could not load the funnel', err.message);
            for (const el of els) el.hidden = true;
        }
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
        else boot();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
