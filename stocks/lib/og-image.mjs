// Per-token 1200×630 social preview images for the card pages: the pure half. Turns a built card
// into a small, stable model, lays it out as SVG with exact advance widths from the bundled Inter
// fonts, and names the image by a hash of what it draws — so the incremental step can skip any
// token whose image would come out identical. Zero dependencies: the SVG rasteriser (resvg) lives
// apart in stocks/og/render.mjs, its own package, so nothing else in the pipeline pulls it in.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import discovery from './discovery.js';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
/** Where the images go inside the card directory; published with cards/ as one release family. */
export const OG_SUBDIR = 'og';
export const FONT_DIR = join(import.meta.dirname, '..', 'og', 'fonts');
/** Weight → bundled file. The renderer loads only these, never system fonts, so output is deterministic. */
export const FONT_FILES = { 500: 'Inter-Medium.ttf', 700: 'Inter-Bold.ttf', 800: 'Inter-ExtraBold.ttf' };

const PAD_X = 64;
const CONTENT_W = OG_WIDTH - 2 * PAD_X;
const INK = '#17151d';
const MUTED = '#5d5966';
const PANEL = '#fffdf8';
const LINE = '#d8d3c8';
const COBALT = '#3154d8';
const PINK = '#dd625b';
// The card page's own status palette (card.css --good/--caution/--warning and their -bg tints).
export const STATUS_STYLE = {
    good: { word: 'Good', ink: '#27735b', bg: '#e3f5ea' },
    caution: { word: 'Caution', ink: '#b45309', bg: '#fdf1d3' },
    warning: { word: 'Warning', ink: '#b91c1c', bg: '#fbe4e1' },
    unknown: { word: 'Not measured', ink: '#5d5966', bg: '#efece6' }
};

// ── Font metrics: cmap (format 4/12) + hmtx, enough for advance widths. Kerning is ignored, so
// layouts keep a small margin (FIT_SLACK) rather than trusting the last pixel.

const FIT_SLACK = 0.97;

function tableDirectory(buf) {
    const tables = {};
    const count = buf.readUInt16BE(4);
    for (let i = 0; i < count; i += 1) {
        const at = 12 + 16 * i;
        tables[buf.toString('latin1', at, at + 4)] = { offset: buf.readUInt32BE(at + 8), length: buf.readUInt32BE(at + 12) };
    }
    return tables;
}

function cmapLookup(buf, cmapOffset) {
    const count = buf.readUInt16BE(cmapOffset + 2);
    let format4 = null;
    let format12 = null;
    for (let i = 0; i < count; i += 1) {
        const at = cmapOffset + 4 + 8 * i;
        const platform = buf.readUInt16BE(at);
        const encoding = buf.readUInt16BE(at + 2);
        const sub = cmapOffset + buf.readUInt32BE(at + 4);
        const format = buf.readUInt16BE(sub);
        if (format === 12 && (platform === 3 && encoding === 10 || platform === 0)) format12 = sub;
        if (format === 4 && (platform === 3 && encoding === 1 || platform === 0)) format4 = sub;
    }
    if (format12 !== null) {
        const groups = buf.readUInt32BE(format12 + 12);
        return (code) => {
            let lo = 0;
            let hi = groups - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const at = format12 + 16 + 12 * mid;
                const start = buf.readUInt32BE(at);
                const end = buf.readUInt32BE(at + 4);
                if (code < start) hi = mid - 1;
                else if (code > end) lo = mid + 1;
                else return buf.readUInt32BE(at + 8) + (code - start);
            }
            return 0;
        };
    }
    if (format4 === null) throw new Error('font has no usable cmap subtable (format 4 or 12)');
    const segCount = buf.readUInt16BE(format4 + 6) / 2;
    const ends = format4 + 14;
    const starts = ends + 2 * segCount + 2;
    const deltas = starts + 2 * segCount;
    const ranges = deltas + 2 * segCount;
    return (code) => {
        if (code > 0xffff) return 0;
        for (let i = 0; i < segCount; i += 1) {
            if (buf.readUInt16BE(ends + 2 * i) < code) continue;
            const start = buf.readUInt16BE(starts + 2 * i);
            if (start > code) return 0;
            const delta = buf.readInt16BE(deltas + 2 * i);
            const rangeAt = ranges + 2 * i;
            const range = buf.readUInt16BE(rangeAt);
            if (range === 0) return (code + delta) & 0xffff;
            const glyph = buf.readUInt16BE(rangeAt + range + 2 * (code - start));
            return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
        }
        return 0;
    };
}

/**
 * `{ unitsPerEm, advance(codePoint) }` in font units from a TrueType buffer. A code point the font
 * does not map measures as the .notdef glyph, which is what the renderer would draw.
 */
export function parseFontMetrics(buf) {
    const tables = tableDirectory(buf);
    for (const tag of ['head', 'hhea', 'hmtx', 'cmap']) {
        if (!tables[tag]) throw new Error(`font is missing its ${tag} table`);
    }
    const unitsPerEm = buf.readUInt16BE(tables.head.offset + 18);
    const hMetrics = buf.readUInt16BE(tables.hhea.offset + 34);
    const glyphFor = cmapLookup(buf, tables.cmap.offset);
    const widthOf = (glyph) => buf.readUInt16BE(tables.hmtx.offset + 4 * Math.min(glyph, hMetrics - 1));
    const cache = new Map();
    return {
        unitsPerEm,
        advance(code) {
            if (!cache.has(code)) cache.set(code, widthOf(glyphFor(code)));
            return cache.get(code);
        }
    };
}

/** Reads the bundled fonts once: `{metrics: {500,700,800}, digest}`; the digest joins every image hash. */
export async function loadFonts(dir = FONT_DIR) {
    const metrics = {};
    const digest = createHash('sha256');
    for (const [weight, file] of Object.entries(FONT_FILES)) {
        const buf = await readFile(join(dir, file));
        metrics[weight] = parseFontMetrics(buf);
        digest.update(file).update('\0').update(buf);
    }
    return { dir, metrics, files: Object.values(FONT_FILES).map((file) => join(dir, file)), digest: digest.digest('hex') };
}

/** Rendered width in px of `text` at `size` px, with optional letter spacing in px. */
export function textWidth(metrics, text, size, letterSpacing = 0) {
    const chars = [...String(text)];
    let units = 0;
    for (const ch of chars) units += metrics.advance(ch.codePointAt(0));
    return units / metrics.unitsPerEm * size + letterSpacing * Math.max(chars.length - 1, 0);
}

/** `text` cut to fit `maxWidth`, at a word boundary when one is close, with an ellipsis. */
export function truncateToWidth(metrics, text, size, maxWidth) {
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (textWidth(metrics, clean, size) <= maxWidth * FIT_SLACK) return clean;
    const chars = [...clean];
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (textWidth(metrics, `${chars.slice(0, mid).join('')}…`, size) <= maxWidth * FIT_SLACK) lo = mid;
        else hi = mid - 1;
    }
    let cut = chars.slice(0, lo).join('');
    const space = cut.lastIndexOf(' ');
    if (space > cut.length * 0.7) cut = cut.slice(0, space);
    return `${cut.replace(/[\s.,;:·—–-]+$/, '')}…`;
}

/** Greedy word wrap into at most `maxLines`; the last line is truncated with an ellipsis if needed. */
export function wrapToWidth(metrics, text, size, maxWidth, maxLines) {
    const words = String(text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const lines = [];
    let current = '';
    for (let i = 0; i < words.length; i += 1) {
        if (lines.length === maxLines - 1) {
            // Last allowed line: take everything left and let truncation below cut it.
            current = words.slice(i - (current ? current.split(' ').length : 0)).join(' ');
            break;
        }
        const next = current ? `${current} ${words[i]}` : words[i];
        if (current === '' || textWidth(metrics, next, size) <= maxWidth * FIT_SLACK) {
            current = next;
        } else {
            lines.push(current);
            current = words[i];
        }
    }
    if (current) lines.push(current);
    // A single over-long word can overflow any line; the last line also carries the overflow.
    return lines.map((line) => truncateToWidth(metrics, line, size, maxWidth));
}

/** The largest size in [min, max] (step 2 px) at which `text` fits `maxWidth`; min when none does. */
export function fitSize(metrics, text, maxWidth, max, min, letterSpacingEm = 0) {
    for (let size = max; size > min; size -= 2) {
        if (textWidth(metrics, text, size, letterSpacingEm * size) <= maxWidth * FIT_SLACK) return size;
    }
    return min;
}

// ── The model: only what the image draws, and nothing that moves every refresh (prices, counts,
// dates), so an unchanged token keeps its hash and is never re-rendered.

function str(value) {
    return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : null;
}

function signerThreshold(value) {
    const match = /^\s*(\d+)\s*(?:of|-of-|\/)\s*(\d+)/i.exec(String(value ?? ''));
    return match ? `${match[1]}-of-${match[2]}` : null;
}

/** "Freeze key: 2-of-4 multisig" and the like, from the card's authority attribution. */
export function freezeFact(card) {
    const rows = Array.isArray(card?.authorityAttribution?.authorities) ? card.authorityAttribution.authorities : [];
    const freeze = rows.find((row) => row?.id === 'freeze') ?? null;
    const clawback = card?.control?.clawback === true ? ' · clawback enabled' : '';
    if (freeze === null || freeze.technicalCapability === 'unknown') {
        return card?.control?.freezeAuthority === false ? `No freeze key on this mint${clawback}` : `Freeze power not established${clawback}`;
    }
    if (freeze.technicalCapability === 'absent') return `No freeze key on this mint${clawback}`;
    const g = freeze.governance ?? {};
    const threshold = signerThreshold(g.signerThreshold);
    const holder = {
        multisig: threshold ? `${threshold} multisig` : 'multisig',
        'single-signer-multisig': 'one-signer multisig',
        program: 'held by a program',
        'hot-key': 'one hot wallet',
        none: 'none'
    }[g.type] ?? 'controller unknown';
    return `Freeze key: ${holder}${clawback}`;
}

/** What is known about redemption actually happening, without the dates that change daily. */
export function redemptionFact(card) {
    const feed = card?.ownership?.redemptionFeed ?? null;
    const available = card?.ownership?.redemption?.available ?? card?.ownership?.redemptionAvailable ?? null;
    if (feed?.state === 'observed') return 'Redemptions observed on-chain';
    if (feed?.state === 'on-chain-leg-observed') return 'Redemption burns observed on-chain; completion off-chain';
    if (available === false) return 'No holder redemption right recorded';
    if (available !== true) return 'Redemption rights not established';
    if (feed?.state === 'none-observed') return 'Redemption documented; none observed on-chain yet';
    if (feed?.state === 'not-observable') return 'Redemption documented; not observable on-chain';
    return 'Redemption documented, not independently observed';
}

/**
 * The image's whole input. Everything here is drawn; nothing here moves with prices or clocks
 * except the health status and its worst check, which the image is meant to show.
 */
export function ogImageModel(card) {
    const status = card?.health?.status in STATUS_STYLE ? card.health.status : 'unknown';
    const rules = Array.isArray(card?.health?.rules) ? card.health.rules : [];
    const worst = rules.find((rule) => rule?.id === card?.health?.worstRuleId) ?? null;
    const rung = Number.isInteger(card?.ownership?.claimRung) ? card.ownership.claimRung : null;
    const verdict = discovery.laypersonVerdict({ claimRung: rung });
    const facts = [];
    if (card?.control?.paused === true) facts.push('Paused right now: transfers are halted');
    facts.push(freezeFact(card));
    facts.push(redemptionFact(card));
    const discrepancies = Array.isArray(card?.discrepancies) ? card.discrepancies.length : 0;
    if (Array.isArray(card?.underReview) && card.underReview.length) {
        facts.push('Legal conclusions under review');
    } else if (discrepancies > 0) {
        facts.push(`${discrepancies} source-backed claim ≠ reality discrepanc${discrepancies === 1 ? 'y' : 'ies'}`);
    }
    return {
        symbol: str(card?.symbol) ?? str(card?.mint) ?? 'token',
        name: str(card?.name),
        underlyingTicker: str(card?.underlyingTicker),
        issuer: str(card?.issuer?.name) ?? str(card?.issuer?.slug),
        status,
        worstRule: str(worst?.label),
        claimRung: rung,
        // "You own X." → "X", capitalised: the headline reads as a statement on its own.
        claim: rung === null ? 'Legal claim not established yet'
            : verdict.headline.replace(/^You own /, '').replace(/\.$/, '').replace(/^./, (c) => c.toUpperCase()),
        facts: facts.slice(0, 3)
    };
}

/** Plain-text description of the image for og:image:alt / twitter:image:alt. */
export function ogImageAlt(model) {
    const what = [model.name, model.underlyingTicker ? `tracks ${model.underlyingTicker}` : null].filter(Boolean).join(', ');
    const health = `${STATUS_STYLE[model.status].word.toLowerCase()}${model.worstRule ? ` (worst check: ${model.worstRule.toLowerCase()})` : ''}`;
    return [
        `RWA Sonar card for ${model.symbol}${what ? ` (${what})` : ''}${model.issuer ? ` issued by ${model.issuer}` : ''}`,
        `health ${health}`,
        `holder claim${model.claimRung === null ? '' : ` rung ${model.claimRung} of 4`}: ${model.claim.toLowerCase()}`,
        ...model.facts
    ].map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('. ').replace(/\s+/g, ' ') + '.';
}

// ── SVG

function esc(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function text(x, y, size, weight, fill, content, extra = '') {
    return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}"${extra}>${esc(content)}</text>`;
}

const LOGO = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s / 100})">`
    + `<circle cx="50" cy="50" r="44" stroke="${COBALT}" stroke-width="5" fill="none"/>`
    + `<path d="M50 50 L85 50 A35 35 0 0 0 50 15 Z" fill="${COBALT}" opacity=".25"/>`
    + `<line x1="50" y1="5" x2="50" y2="95" stroke="${COBALT}" stroke-width="2" opacity=".35"/>`
    + `<line x1="5" y1="50" x2="95" y2="50" stroke="${COBALT}" stroke-width="2" opacity=".35"/>`
    + `<circle cx="70" cy="30" r="7" fill="${PINK}"/></g>`;

/**
 * The image as a self-contained SVG string (font-family Inter, weights 500/700/800 only).
 * Deterministic: the same model and fonts give the same bytes, which is what the hash relies on.
 */
export function renderOgSvg(model, fonts) {
    const m = fonts.metrics;
    const style = STATUS_STYLE[model.status];
    const parts = [];

    // Background: the site's paper tone with the og.html cobalt glow in the top-right corner.
    parts.push(`<defs><radialGradient id="glow" cx="1056" cy="38" r="420" gradientUnits="userSpaceOnUse">`
        + `<stop offset="0" stop-color="${COBALT}" stop-opacity=".14"/><stop offset="1" stop-color="${COBALT}" stop-opacity="0"/></radialGradient></defs>`
        + `<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="#f9f7f2"/>`
        + `<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#glow)"/>`);

    // Brand row, issuer on the right.
    parts.push(LOGO(PAD_X, 44, 46));
    parts.push(text(PAD_X + 60, 79, 28, 800, INK, 'RWA Sonar', ' letter-spacing="-0.5"'));
    if (model.issuer) {
        const brandRight = PAD_X + 60 + textWidth(m[800], 'RWA Sonar', 28) + 40;
        const room = OG_WIDTH - PAD_X - brandRight;
        const issuer = truncateToWidth(m[700], `Issued by ${model.issuer}`, 24, room);
        parts.push(text(OG_WIDTH - PAD_X, 78, 24, 700, MUTED, issuer, ' text-anchor="end"'));
    }

    // Symbol, shrunk to fit, then name · tracks TICKER on one line.
    const symbolSize = fitSize(m[800], model.symbol, CONTENT_W, 96, 48, -0.03);
    const symbol = truncateToWidth(m[800], model.symbol, symbolSize, CONTENT_W);
    parts.push(text(PAD_X - 3, 184, symbolSize, 800, INK, symbol, ` letter-spacing="${(-0.03 * symbolSize).toFixed(2)}"`));
    const subParts = [model.name, model.underlyingTicker ? `tracks ${model.underlyingTicker}` : null].filter(Boolean);
    if (subParts.length) {
        const ticker = model.underlyingTicker ? ` · tracks ${model.underlyingTicker}` : '';
        const nameRoom = CONTENT_W - textWidth(m[500], ticker, 30);
        const name = model.name ? truncateToWidth(m[500], model.name, 30, nameRoom) : '';
        parts.push(text(PAD_X, 230, 30, 500, MUTED, `${name}${model.name ? ticker : ticker.replace(/^ · /, '')}`));
    }

    // Two panels: health (status-tinted) and what you own.
    const top = 262;
    const height = 172;
    const leftW = 430;
    const gap = 24;
    const rightX = PAD_X + leftW + gap;
    const rightW = CONTENT_W - leftW - gap;
    parts.push(`<rect x="${PAD_X}" y="${top}" width="${leftW}" height="${height}" rx="18" fill="${style.bg}" stroke="${style.ink}" stroke-opacity=".45" stroke-width="2"/>`);
    parts.push(text(PAD_X + 26, top + 40, 18, 800, MUTED, 'HEALTH CHECKS', ' letter-spacing="1.6"'));
    parts.push(`<circle cx="${PAD_X + 38}" cy="${top + 81}" r="12" fill="${style.ink}"/>`);
    parts.push(text(PAD_X + 62, top + 94, 38, 800, style.ink, style.word, ' letter-spacing="-0.8"'));
    const worst = model.status === 'good' ? 'Every measured check is good'
        : model.status !== 'unknown' && model.worstRule ? `Worst: ${model.worstRule}` : 'No check could be measured';
    const worstSize = fitSize(m[700], worst, leftW - 52, 24, 18);
    parts.push(text(PAD_X + 26, top + 136, worstSize, 700, INK, truncateToWidth(m[700], worst, worstSize, leftW - 52)));

    parts.push(`<rect x="${rightX}" y="${top}" width="${rightW}" height="${height}" rx="18" fill="${PANEL}" stroke="${LINE}" stroke-width="2"/>`);
    const kicker = model.claimRung === null ? 'WHAT YOU OWN' : `WHAT YOU OWN · CLAIM RUNG ${model.claimRung} OF 4`;
    parts.push(text(rightX + 26, top + 40, 18, 800, MUTED, kicker, ' letter-spacing="1.6"'));
    const claimSize = model.claim.length > 70 ? 28 : 30;
    wrapToWidth(m[800], model.claim, claimSize, rightW - 52, 3).forEach((line, index) => {
        parts.push(text(rightX + 26, top + 82 + (claimSize + 8) * index, claimSize, 800, INK, line, ' letter-spacing="-0.4"'));
    });

    // Up to three key facts, each on its own line behind a cobalt marker.
    model.facts.slice(0, 3).forEach((fact, index) => {
        const y = 486 + 34 * index;
        parts.push(`<rect x="${PAD_X}" y="${y - 17}" width="10" height="10" rx="2" fill="${COBALT}"/>`);
        parts.push(text(PAD_X + 24, y - 4, 25, 700, INK, truncateToWidth(m[700], fact, 25, CONTENT_W - 24)));
    });

    // Footer.
    parts.push(`<line x1="${PAD_X}" y1="580" x2="${OG_WIDTH - PAD_X}" y2="580" stroke="${LINE}" stroke-width="2"/>`);
    parts.push(text(PAD_X, 610, 21, 700, MUTED, 'Tokenized stocks on Solana, compared by what you actually own'));
    parts.push(text(OG_WIDTH - PAD_X, 610, 22, 800, COBALT, 'rwasonar.com', ' text-anchor="end"'));

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}" font-family="Inter">${parts.join('')}</svg>`;
}

// ── Incremental store: cards/og/<slug>.<hash>.png, the hash over the SVG and the font bytes.

/** 12 hex characters of sha256(svg, fonts): the image's content address. */
export function ogImageHash(svg, fontDigest) {
    return createHash('sha256').update(fontDigest).update('\0').update(svg).digest('hex').slice(0, 12);
}

export function ogImageFileName(slug, hash) {
    return `${slug}.${hash}.png`;
}

async function exists(path) {
    try {
        return (await stat(path)).size > 0;
    } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
    }
}

/**
 * Makes sure `<dir>/<slug>.<hash>.png` exists, rendering it only when it does not. `render(svg)`
 * returns PNG bytes (stocks/og/render.mjs in the build, a stub in tests). The write is a rename
 * from a temporary name, so a killed run never leaves a truncated image under a final name.
 * Returns `{fileName, rendered, bytes}`.
 */
export async function ensureOgImage({ dir, slug, svg, fontDigest, render }) {
    const fileName = ogImageFileName(slug, ogImageHash(svg, fontDigest));
    const path = join(dir, fileName);
    if (await exists(path)) return { fileName, rendered: false, bytes: (await stat(path)).size };
    const png = await render(svg);
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, png);
    await rename(tmp, path);
    return { fileName, rendered: true, bytes: png.byteLength };
}

/** Deletes every file in `dir` not in `keep` (older hashes, gone tokens, leftover temporaries). */
export async function pruneOgImages(dir, keep) {
    let names = [];
    try {
        names = await readdir(dir);
    } catch (err) {
        if (err.code === 'ENOENT') return 0;
        throw err;
    }
    let removed = 0;
    for (const name of names) {
        if (keep.has(name)) continue;
        await rm(join(dir, name), { force: true });
        removed += 1;
    }
    return removed;
}

export async function ensureOgDir(dir) {
    await mkdir(dir, { recursive: true });
}
