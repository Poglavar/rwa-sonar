// 1200×630 social preview images for every page that is not a token card: the top-level pages,
// issuer dossiers, legal templates, protocol dossiers and weekly digests. One generic layout (kicker,
// title, subtitle, then up to three stat tiles or a short checklist) drawn with the card image's own
// primitives and fonts (og-image.mjs), a model builder per page family, and the two stores: hashed
// file names inside a generated family (published atomically with its HTML, like cards/og/) and
// stable names plus a `?v=<hash>` for hand-written pages (see stocks/build-site-seo.mjs for why).

import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import discovery from './discovery.js';
import fmt from './fmt.js';
import {
    OG_HEIGHT, OG_PALETTE, OG_WIDTH, STATUS_STYLE, fitSize, ogImageHash, svgLogo, svgText,
    textWidth, truncateToWidth, wrapToWidth
} from './og-image.mjs';

const { INK, MUTED, PANEL, LINE, COBALT, PAD_X, CONTENT_W } = OG_PALETTE;
const STAT_TONES = { good: STATUS_STYLE.good, caution: STATUS_STYLE.caution, warning: STATUS_STYLE.warning };
const FACT_MARKS = { yes: '#27735b', no: '#b9b3a7', neutral: COBALT };

function clean(value) {
    return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : null;
}

/**
 * The image's whole input, normalised. `stats` are `{value, label, tone?}` (value already formatted
 * text; a stat without a value is dropped, never drawn as zero), `facts` `{text, state}` with state
 * yes | no | neutral. Nothing here may come from a clock: the hash is over what is drawn.
 */
export function pageOgModel({ kicker = null, title, subtitle = null, stats = [], facts = [], path = null }) {
    const t = clean(title);
    if (t === null) throw new Error('page og image: a title is required');
    return {
        kicker: clean(kicker),
        title: t,
        subtitle: clean(subtitle),
        stats: (Array.isArray(stats) ? stats : [])
            .filter((row) => clean(row?.value) !== null && clean(row?.label) !== null)
            .slice(0, 3)
            .map((row) => ({ value: clean(row.value), label: clean(row.label), tone: row.tone in STAT_TONES ? row.tone : null })),
        facts: (Array.isArray(facts) ? facts : [])
            .filter((row) => clean(row?.text) !== null)
            .slice(0, 4)
            .map((row) => ({ text: clean(row.text), state: row.state in FACT_MARKS ? row.state : 'neutral' })),
        path: clean(path)
    };
}

/** og:image:alt text: everything the image says, as sentences. */
export function pageOgAlt(model) {
    const parts = [`RWA Sonar${model.kicker ? ` ${model.kicker.toLowerCase()}` : ''}: ${model.title}`];
    if (model.subtitle) parts.push(model.subtitle);
    // "833 exact Solana tokens", but "Who holds the keys: Mint: one key" for a sentence-valued tile.
    for (const stat of model.stats) parts.push(/^[\d$%.,/-]/.test(stat.value) ? `${stat.value} ${stat.label}` : `${stat.label.charAt(0).toUpperCase()}${stat.label.slice(1)}: ${stat.value}`);
    for (const fact of model.facts) parts.push(fact.text);
    return parts.map((part) => part.replace(/[.\s]+$/, '')).join('. ') + '.';
}

/** The largest title size at which the whole title fits in two lines; else the smallest, truncated. */
function titleLayout(metrics, title) {
    for (const size of [68, 62, 56, 50, 46]) {
        const lines = wrapToWidth(metrics, title, size, CONTENT_W, 2);
        if (lines.join(' ') === title) return { size, lines };
    }
    return { size: 44, lines: wrapToWidth(metrics, title, 44, CONTENT_W, 2) };
}

/** The whole image as a self-contained SVG (Inter 500/700/800 only). Deterministic. */
export function renderPageOgSvg(model, fonts) {
    const m = fonts.metrics;
    const parts = [];
    parts.push(`<defs><radialGradient id="glow" cx="1056" cy="38" r="420" gradientUnits="userSpaceOnUse">`
        + `<stop offset="0" stop-color="${COBALT}" stop-opacity=".14"/><stop offset="1" stop-color="${COBALT}" stop-opacity="0"/></radialGradient></defs>`
        + `<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="#f9f7f2"/>`
        + `<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#glow)"/>`);

    parts.push(svgLogo(PAD_X, 44, 46));
    parts.push(svgText(PAD_X + 60, 79, 28, 800, INK, 'RWA Sonar', ' letter-spacing="-0.5"'));
    if (model.kicker) {
        const brandRight = PAD_X + 60 + textWidth(m[800], 'RWA Sonar', 28) + 40;
        const kicker = truncateToWidth(m[800], model.kicker.toUpperCase(), 20, OG_WIDTH - PAD_X - brandRight - 30);
        parts.push(svgText(OG_WIDTH - PAD_X, 76, 20, 800, COBALT, kicker, ' text-anchor="end" letter-spacing="1.6"'));
    }

    const title = titleLayout(m[800], model.title);
    let y = 120 + Math.round(title.size * 0.9);
    title.lines.forEach((line, index) => {
        if (index > 0) y += Math.round(title.size * 1.08);
        parts.push(svgText(PAD_X - 2, y, title.size, 800, INK, line, ` letter-spacing="${(-0.025 * title.size).toFixed(2)}"`));
    });

    const hasStats = model.stats.length > 0;
    const bottom = hasStats ? 382 : 380;
    if (model.subtitle) {
        const room = Math.max(1, Math.min(2, Math.floor((bottom - 20 - (y + 14)) / 36)));
        const lines = wrapToWidth(m[500], model.subtitle, 28, CONTENT_W, room);
        y += 46;
        lines.forEach((line, index) => {
            parts.push(svgText(PAD_X, y + 36 * index, 28, 500, MUTED, line));
        });
    }

    if (hasStats) {
        const gap = 24;
        // Always three columns, so one or two tiles keep the same size and sit on the left.
        const width = (CONTENT_W - gap * 2) / 3;
        model.stats.forEach((stat, index) => {
            const x = PAD_X + index * (width + gap);
            const tone = stat.tone ? STAT_TONES[stat.tone] : null;
            parts.push(`<rect x="${x.toFixed(1)}" y="${bottom}" width="${width.toFixed(1)}" height="170" rx="18" fill="${tone ? tone.bg : PANEL}" stroke="${tone ? tone.ink : LINE}" stroke-opacity="${tone ? '.45' : '1'}" stroke-width="2"/>`);
            const ink = tone ? tone.ink : INK;
            if (textWidth(m[800], stat.value, 38) <= (width - 48) * 0.97) {
                // A number or a short phrase: as large as fits, with a two-line label below.
                const size = fitSize(m[800], stat.value, width - 48, 60, 38, -0.02);
                parts.push(svgText((x + 24).toFixed(1), bottom + 24 + Math.round(size * 0.9), size, 800, ink,
                    stat.value, ` letter-spacing="${(-0.02 * size).toFixed(2)}"`));
                wrapToWidth(m[700], stat.label, 21, width - 48, 2).forEach((line, lineIndex) => {
                    parts.push(svgText((x + 24).toFixed(1), bottom + 118 + 27 * lineIndex, 21, 700, MUTED, line));
                });
            } else {
                // A sentence (a holder claim, a key-control summary): wrapped, label on one line.
                wrapToWidth(m[800], stat.value, 26, width - 48, 3).forEach((line, lineIndex) => {
                    parts.push(svgText((x + 24).toFixed(1), bottom + 48 + 32 * lineIndex, 26, 800, ink, line, ' letter-spacing="-0.3"'));
                });
                parts.push(svgText((x + 24).toFixed(1), bottom + 146, 21, 700, MUTED, truncateToWidth(m[700], stat.label, 21, width - 48)));
            }
        });
    } else {
        model.facts.forEach((fact, index) => {
            const fy = bottom + 30 + 44 * index;
            const colour = FACT_MARKS[fact.state];
            parts.push(fact.state === 'no'
                ? `<rect x="${PAD_X + 1}" y="${fy - 19}" width="16" height="16" rx="3" fill="none" stroke="${colour}" stroke-width="2.5"/>`
                : `<rect x="${PAD_X}" y="${fy - 20}" width="18" height="18" rx="3" fill="${colour}"/>`);
            parts.push(svgText(PAD_X + 34, fy - 3, 27, 700, fact.state === 'no' ? MUTED : INK,
                truncateToWidth(m[700], fact.text, 27, CONTENT_W - 34)));
        });
    }

    parts.push(`<line x1="${PAD_X}" y1="580" x2="${OG_WIDTH - PAD_X}" y2="580" stroke="${LINE}" stroke-width="2"/>`);
    // The page's own address on the right, so a cropped preview still says where it links; a
    // long slug falls back to its family directory rather than an ellipsis mid-word.
    const tagline = 'Tokenized stocks on Solana, explained';
    const room = CONTENT_W - textWidth(m[700], tagline, 21) - 40;
    const full = model.path ? `rwasonar.com/${model.path}` : 'rwasonar.com';
    const address = textWidth(m[800], full, 22) <= room ? full
        : truncateToWidth(m[800], `rwasonar.com/${model.path.split('/')[0]}/`, 22, room);
    parts.push(svgText(PAD_X, 610, 21, 700, MUTED, tagline));
    parts.push(svgText(OG_WIDTH - PAD_X, 610, 22, 800, COBALT, address, ' text-anchor="end"'));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}" font-family="Inter">${parts.join('')}</svg>`;
}

// ── Number words shared by the model builders.

export function fmtCount(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : null;
}

export function fmtUsdShort(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const abs = Math.abs(value);
    if (abs >= 1e9) return `$${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
    if (abs >= 1e6) return `$${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
    if (abs >= 1e3) return `$${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
    return `$${Math.round(value)}`;
}

// ── Family models.

/** "one key", "2-of-4 multisig", "program", "not installed" or "not established" for a power-map cell. */
export function powerPhrase(cell) {
    if (!cell || typeof cell !== 'object') return 'not established';
    if (cell.kind === 'none') return 'not installed';
    if (cell.kind === 'single-key') return 'one key';
    if (cell.kind === 'multisig') {
        const m = /(\d+)\s*(?:of|-of-|\/)\s*(\d+)/i.exec(String(cell.signerThreshold ?? ''));
        return m ? `${m[1]}-of-${m[2]} multisig` : 'multisig';
    }
    if (cell.kind === 'program') return 'a program';
    return 'not established';
}

/** Who holds the mint and freeze keys, from the power map's issuer row: "Mint: one key · Freeze: 2-of-4 multisig". */
export function keyControlSummary(powerRow) {
    const cells = Array.isArray(powerRow?.cells) ? powerRow.cells : [];
    if (cells.length === 0) return null;
    const byPower = new Map(cells.map((cell) => [cell.power, cell]));
    return ['mint', 'freeze']
        .filter((power) => byPower.has(power))
        .map((power) => `${{ mint: 'Mint', freeze: 'Freeze', moveBurn: 'Forced transfer' }[power]}: ${powerPhrase(byPower.get(power))}`)
        .join(' · ');
}

/** "You own …" → the plain holder claim for a claim rung, or null when the rung is unknown. */
export function claimPhrase(rung) {
    if (!Number.isInteger(rung)) return null;
    return discovery.laypersonVerdict({ claimRung: rung }).headline
        .replace(/^You own /, '').replace(/\.$/, '').replace(/^./, (c) => c.toUpperCase());
}

/**
 * An issuer dossier: name, the holder claim, documented what-if answers out of the catalogue's
 * questions, exact token count, and who holds the mint/freeze/forced-transfer keys.
 */
export function issuerOgModel({ issuer, tokenCount = null, powerRow = null, questionCount = null }) {
    const counts = issuer?.whatIfCounts ?? null;
    const documented = typeof counts?.documented === 'number' ? counts.documented : null;
    const total = Number.isInteger(questionCount) ? questionCount : null;
    const status = issuer?.status && issuer.status !== 'live' ? ` · ${issuer.status}` : '';
    const rung = issuer?.grades?.claimRung;
    return pageOgModel({
        kicker: `Issuer dossier${status}`,
        title: issuer?.name ?? issuer?.slug ?? 'Issuer',
        subtitle: `Holder claim${Number.isInteger(rung) ? ` (rung ${rung} of 4)` : ''}: ${claimPhrase(rung) ?? 'not established'}`,
        stats: [
            { value: documented === null ? null : total === null ? String(documented) : `${documented}/${total}`, label: 'failure scenarios answered from documents' },
            { value: fmtCount(tokenCount), label: `exact Solana token${tokenCount === 1 ? '' : 's'}` },
            { value: keyControlSummary(powerRow) ?? 'Not established', label: 'who holds the keys' }
        ],
        path: `issuers/${issuer?.slug ?? ''}`
    });
}

/** A legal template: issuer, the control recipe, the legal structure, and how many tokens inherit it. */
export function templateOgModel(template) {
    return pageOgModel({
        kicker: 'Legal + control template',
        title: `${template?.issuer?.name ?? 'Issuer'}: ${template?.technologyRecipe ?? 'control recipe'}`,
        subtitle: template?.legalTemplate ?? null,
        stats: [
            { value: fmtCount(template?.inheritance?.count), label: 'exact tokens inherit this analysis' },
            { value: fmtCount(template?.inheritance?.underlyingCount), label: 'distinct underlyings' },
            { value: template?.reviewedAt ? fmt.fmtDate(template.reviewedAt) : null, label: 'last legal review' }
        ],
        path: `templates/${template?.id ?? ''}`
    });
}

/** A protocol dossier: token × protocol and the proof ladder, each rung yes / no. */
export function protocolOgModel(dossier) {
    const i = dossier?.integration ?? {};
    const p = dossier?.proof ?? {};
    const listed = ['exact-token-registry', 'named-product-page'].includes(p.sourceStatus);
    const observed = p.sourceStatus === 'observed-market' || p.sourceStatus === 'onchain-position';
    const accounts = Number.isInteger(p.accountCount) && p.accountCount > 0
        ? `${p.existingAccountCount ?? 0} of ${p.accountCount} referenced accounts exist on-chain` : 'No referenced account checked on-chain';
    return pageOgModel({
        kicker: 'Protocol dossier',
        title: `${dossier?.symbol ?? 'Token'} × ${i.protocolName ?? 'protocol'}`,
        subtitle: Array.isArray(i.actions) && i.actions.length ? `Source-described use: ${i.actions.join(', ')}` : null,
        facts: [
            { text: listed ? 'Exact token named by the protocol source' : observed ? 'Exact-token market observed' : 'No exact-token source listing', state: listed || observed ? 'yes' : 'no' },
            { text: accounts, state: Number.isInteger(p.accountCount) && p.accountCount > 0 && p.existingAccountCount === p.accountCount ? 'yes' : 'no' },
            { text: p.configurationDecoded ? 'Market configuration decoded' : 'Configuration not decoded', state: p.configurationDecoded ? 'yes' : 'no' },
            { text: p.readOnlyExecutionSimulated ? 'Read-only execution simulated' : 'No execution simulated', state: p.readOnlyExecutionSimulated ? 'yes' : 'no' }
        ],
        path: `protocols/${dossier?.slug ?? ''}`
    });
}

/** A weekly digest: the week, its range and status, and its headline numbers. */
export function weeklyOgModel({ id, label, range, inProgress, stats }) {
    return pageOgModel({
        kicker: 'This week in tokenized stocks',
        title: label,
        subtitle: `${range}${inProgress ? ' · in progress' : ' · complete week'}`,
        stats,
        path: `weekly/${id}`
    });
}

// ── Stores.

async function fileSize(path) {
    try {
        return (await stat(path)).size;
    } catch (err) {
        if (err.code === 'ENOENT') return 0;
        throw err;
    }
}

/**
 * Stable-name store for hand-written pages: `<dir>/<key>.png` plus `<dir>/index.json` recording the
 * hash each file was rendered from. A page whose drawn content is unchanged is not re-rendered.
 * Returns `{fileName, hash, rendered}`; the page links `<fileName>?v=<hash>`.
 */
export async function ensureStableOgImage({ dir, key, svg, fontDigest, render, manifest }) {
    const hash = ogImageHash(svg, fontDigest);
    const fileName = `${key}.png`;
    const path = join(dir, fileName);
    if (manifest[key]?.hash === hash && await fileSize(path) > 0) return { fileName, hash, rendered: false };
    const png = await render(svg);
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, png);
    await rename(tmp, path);
    manifest[key] = { hash };
    return { fileName, hash, rendered: true };
}

export async function readOgManifest(dir) {
    try {
        return JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
    }
}
