// SVG → PNG for the per-token social images, the only step in the stocks pipeline with an npm
// dependency (@resvg/resvg-js, a prebuilt native binary; no browser). It lives in its own package
// (stocks/og/package.json, installed with `npm ci --prefix stocks/og`) so the import resolves from
// here and nothing else in the pipeline can grow a dependency by accident. Only the bundled fonts
// are loaded — never system fonts — so the laptop and the server draw identical pixels. resvg's
// own PNG is truecolour+alpha (~100 kB here); the pixels are re-encoded as an indexed PNG instead.

import { encodeIndexedPng } from '../lib/png-indexed.mjs';

/**
 * `{ render(svg) → PNG Buffer }`, or throws with the install command when the dependency is
 * missing. `fontFiles` are absolute paths (stocks/lib/og-image.mjs loadFonts().files).
 */
export async function createOgRenderer(fontFiles) {
    let Resvg;
    try {
        ({ Resvg } = await import('@resvg/resvg-js'));
    } catch (err) {
        throw new Error(`@resvg/resvg-js is not installed (${err.code ?? err.message}); run: npm ci --prefix stocks/og`);
    }
    const options = {
        font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' },
        fitTo: { mode: 'original' },
        shapeRendering: 2,
        textRendering: 1
    };
    return {
        render(svg) {
            const image = new Resvg(svg, options).render();
            return encodeIndexedPng(image.pixels, image.width, image.height).png;
        }
    };
}
