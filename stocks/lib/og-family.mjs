// The per-page social image step shared by the generated page families (issuers/, templates/,
// protocols/, weekly/): renders each page's model into <family>/og/<slug>.<hash>.png, re-rendering
// only when the drawing changed, prunes what no page names any more, and logs one summary line.
// The same incremental store as the cards (og-image.mjs ensureOgImage); a missing renderer or a
// failed render leaves that page on the site image instead of stopping the build.

import { join } from 'node:path';
import { log, logError, logWarn } from './io.mjs';
import { OG_SUBDIR, ensureOgDir, ensureOgImage, loadFonts, pruneOgImages } from './og-image.mjs';
import { pageOgAlt, renderPageOgSvg } from './page-og.mjs';

/**
 * State for one family, or null (logged) when images are off or the renderer is not installed.
 * `outDir` is the family directory on disk, `urlPrefix` its path under the site root ('issuers').
 */
export async function prepareFamilyOg({ outDir, urlPrefix, label, enabled = true }) {
    if (!enabled) {
        log(`${label} og images: skipped; every page uses the site image`);
        return null;
    }
    const fonts = await loadFonts();
    let renderer;
    try {
        const { createOgRenderer } = await import('../og/render.mjs');
        renderer = await createOgRenderer(fonts.files);
    } catch (err) {
        logWarn(`${label} og images: renderer unavailable — ${err.message}. Every page keeps the site image.`);
        return null;
    }
    const dir = join(outDir, OG_SUBDIR);
    await ensureOgDir(dir);
    return { dir, urlPrefix, label, fonts, renderer, keep: new Set(), rendered: 0, reused: 0, failed: 0 };
}

/**
 * `{path, alt}` for the page (path relative to the site root, e.g. issuers/og/tessera.<hash>.png),
 * or null when images are off or this render failed — the caller then uses the site image.
 */
export async function familyOgImage(state, slug, model) {
    if (state === null) return null;
    try {
        const result = await ensureOgImage({
            dir: state.dir, slug, svg: renderPageOgSvg(model, state.fonts), fontDigest: state.fonts.digest,
            render: (svg) => state.renderer.render(svg)
        });
        state.keep.add(result.fileName);
        if (result.rendered) state.rendered += 1; else state.reused += 1;
        return { path: `${state.urlPrefix}/${OG_SUBDIR}/${result.fileName}`, alt: pageOgAlt(model) };
    } catch (err) {
        state.failed += 1;
        logError(`${state.label} og image for ${slug} failed: ${err.message} — that page keeps the site image`);
        return null;
    }
}

/** Prunes images no page named in this run and logs the family's totals. */
export async function finishFamilyOg(state) {
    if (state === null) return;
    const pruned = await pruneOgImages(state.dir, state.keep);
    log(`${state.label} og images: ${state.rendered} rendered, ${state.reused} unchanged, ${state.failed} failed, ${pruned} old file(s) pruned`);
}

/** The absolute `{url, alt, width, height}` seoHeadTags wants, from a family image and an origin. */
export function absoluteImage(origin, image) {
    if (origin === null || image === null || image === undefined) return null;
    return { url: `${origin}/${image.path.split('/').map(encodeURIComponent).join('/')}`, alt: image.alt, width: 1200, height: 630 };
}
