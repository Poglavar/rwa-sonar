// A minimal 8-bit indexed-colour PNG encoder (node:zlib only). The social images are flat colours
// plus anti-aliased text — a few hundred distinct colours — so a 256-entry palette holds ≥ 99.8 %
// of their pixels exactly and a truecolour PNG spends ~3× the bytes on nothing. Deterministic:
// the palette is ordered by pixel count, ties by colour value, and rare colours map to the nearest
// palette entry.

import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
}

/**
 * PNG bytes for an RGBA buffer (`width × height × 4`). Alpha is composited over white; the images
 * this serves are opaque, so that only matters for a stray transparent edge.
 * Returns `{ png, colors, exact }`: distinct colours seen, and the share of pixels kept exactly.
 */
export function encodeIndexedPng(rgba, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new Error(`bad image size ${width}×${height}`);
    }
    if (rgba.length !== width * height * 4) throw new Error(`expected ${width * height * 4} RGBA bytes, got ${rgba.length}`);
    const pixels = width * height;
    const rgb = new Uint32Array(pixels);
    const counts = new Map();
    // Runs of one colour are long (flat panels), so counting a run at a time skips most Map work.
    let runColor = -1;
    let runLength = 0;
    for (let i = 0; i < pixels; i += 1) {
        const a = rgba[4 * i + 3];
        let color;
        if (a === 255) {
            color = (rgba[4 * i] << 16) | (rgba[4 * i + 1] << 8) | rgba[4 * i + 2];
        } else {
            const blend = (c) => Math.round((c * a + 255 * (255 - a)) / 255);
            color = (blend(rgba[4 * i]) << 16) | (blend(rgba[4 * i + 1]) << 8) | blend(rgba[4 * i + 2]);
        }
        rgb[i] = color;
        if (color === runColor) {
            runLength += 1;
            continue;
        }
        if (runLength) counts.set(runColor, (counts.get(runColor) ?? 0) + runLength);
        runColor = color;
        runLength = 1;
    }
    if (runLength) counts.set(runColor, (counts.get(runColor) ?? 0) + runLength);
    const palette = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 256).map(([color]) => color);
    const index = new Map(palette.map((color, i) => [color, i]));
    let exactPixels = 0;
    for (const color of palette) exactPixels += counts.get(color);
    const nearest = (color) => {
        const r = color >> 16;
        const g = (color >> 8) & 255;
        const b = color & 255;
        let best = 0;
        let bestDistance = Infinity;
        palette.forEach((candidate, i) => {
            const dr = (candidate >> 16) - r;
            const dg = ((candidate >> 8) & 255) - g;
            const db = (candidate & 255) - b;
            const distance = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
            if (distance < bestDistance) {
                bestDistance = distance;
                best = i;
            }
        });
        return best;
    };
    // Filter type 0 on every row: the PNG spec's advice for palette images, and the smallest here.
    // Deflate level 6, not 9: 9 saved ~2 kB (6 %) per image for ~8× the compression time.
    const raw = Buffer.alloc((width + 1) * height);
    let lastColor = -1;
    let lastIndex = 0;
    for (let y = 0; y < height; y += 1) {
        const row = y * (width + 1);
        for (let x = 0; x < width; x += 1) {
            const color = rgb[y * width + x];
            if (color !== lastColor) {
                if (!index.has(color)) index.set(color, nearest(color));
                lastColor = color;
                lastIndex = index.get(color);
            }
            raw[row + 1 + x] = lastIndex;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 3;
    const plte = Buffer.alloc(palette.length * 3);
    palette.forEach((color, i) => {
        plte[3 * i] = color >> 16;
        plte[3 * i + 1] = (color >> 8) & 255;
        plte[3 * i + 2] = color & 255;
    });
    const png = Buffer.concat([
        SIGNATURE,
        chunk('IHDR', ihdr),
        chunk('PLTE', plte),
        chunk('IDAT', deflateSync(raw, { level: 6 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
    return { png, colors: counts.size, exact: exactPixels / pixels };
}
