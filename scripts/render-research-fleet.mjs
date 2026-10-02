#!/usr/bin/env node
// Export the decorative fleet loop from the same inventory geometry and ship poses used by the research map.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, mkdir, stat, writeFile, mkdtemp, rm, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'stocks/og/package.json'));
const M = require(join(ROOT, 'rwa/lib/monitoring-map.js'));
const F = require(join(ROOT, 'rwa/lib/research-fleet.js'));
const USAGE = `Usage: node scripts/render-research-fleet.mjs --run [options]

Options:
  --inventory PATH          Inventory JSON (default: monitoring-map.json)
  --out PREFIX              Output prefix (default: images/research-fleet/fleet-loop-v1)
  --width PX                Canvas width (default: 1280)
  --height PX               Canvas height (default: 720)
  --fps N                   Frame rate (default: 24)
  --seconds-per-hour N      Animation time scale (default: 2)
  --frames DIR              Scratch/checkpoint frame directory
  --help                    Show this help`;

function parseArgs(argv) {
    const opts = { inventory: 'monitoring-map.json', out: 'images/research-fleet/fleet-loop-v1', width: 1280, height: 720, fps: 24, secondsPerHour: 2, run: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help') { opts.help = true; continue; }
        if (arg === '--run') { opts.run = true; continue; }
        const key = ({ '--inventory': 'inventory', '--out': 'out', '--width': 'width', '--height': 'height', '--fps': 'fps', '--seconds-per-hour': 'secondsPerHour', '--frames': 'frames' })[arg];
        if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${arg}`);
        opts[key] = argv[++i];
    }
    for (const key of ['width', 'height', 'fps', 'secondsPerHour']) opts[key] = Number(opts[key]);
    if (![opts.width, opts.height, opts.fps, opts.secondsPerHour].every((n) => Number.isFinite(n) && n > 0)) throw new Error('Dimensions, fps, and seconds-per-hour must be positive numbers.');
    if (![opts.width, opts.height, opts.fps, opts.secondsPerHour].every(Number.isInteger)) throw new Error('Dimensions, fps, and seconds-per-hour must be integers.');
    return opts;
}
function run(command, args, { quiet = false } = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, { stdio: quiet ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} failed (${code}): ${stderr.trim()}`)));
    });
}
async function pngExists(path) {
    try { const [info, signature] = await Promise.all([stat(path), readFile(path, { encoding: null, flag: 'r' }).then((b) => b.subarray(0, 8))]);
        const tail = await readFile(path).then((b) => b.subarray(-12));
        return info.isFile() && info.size > 32 && signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            && tail.equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
    } catch { return false; }
}
function xmlData(bytes) { return `data:image/png;base64,${bytes.toString('base64')}`; }
async function atomicWrite(path, bytes) {
    const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try { await writeFile(temp, bytes); await rename(temp, path); }
    catch (error) { await rm(temp, { force: true }); throw error; }
}
function makeBackdrop(scene, width, height, issuerCount) {
    let seed = 9127;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const dots = Array.from({ length: Math.floor(width * height / 5200) }, () => `<circle cx="${(random() * width).toFixed(1)}" cy="${(random() * height).toFixed(1)}" r="${(0.35 + random() * 0.8).toFixed(2)}" fill="#d7e9ff" opacity="${(0.16 + random() * 0.28).toFixed(2)}"/>`).join('');
    const gradients = M.CATEGORIES.map((c) => `<radialGradient id="planet-${c.id}" cx="28%" cy="25%" r="78%"><stop offset="0" stop-color="#f2f0e3"/><stop offset=".2" stop-color="${c.color}"/><stop offset=".8" stop-color="${c.color}" stop-opacity=".25"/><stop offset="1" stop-color="#14202f"/></radialGradient>`).join('');
    const paths = scene.nodes.map((node) => {
        const { start, bend } = node;
        const mid = M.curvePoint(start, node, bend, 0.5);
        const control = { x: 2 * mid.x - (start.x + node.x) / 2, y: 2 * mid.y - (start.y + node.y) / 2 };
        return `<path d="M${start.x},${start.y} Q${control.x},${control.y} ${node.x},${node.y}" fill="none" stroke="${nodeColor(node)}" stroke-opacity=".13" stroke-width=".75"/>`;
    }).join('');
    const worlds = scene.nodes.map((node) => {
        const color = nodeColor(node);
        return `<g><circle cx="${node.x}" cy="${node.y}" r="${node.radius}" fill="url(#planet-${node.category})" stroke="${color}" stroke-opacity=".3" stroke-width=".7"/></g>`;
    }).join('');
    const orbitRadius = width < 600 ? 70 : 91;
    const issuerDots = Array.from({ length: issuerCount }, (_, index) => {
        const angle = index / Math.max(1, issuerCount) * Math.PI * 2 - Math.PI / 2;
        const x = scene.center.x + Math.cos(angle) * orbitRadius, y = scene.center.y + Math.sin(angle) * orbitRadius * .77;
        return `<circle cx="${x}" cy="${y}" r="2.7" fill="#0a111a" stroke="#8796ad" stroke-width="1"/>`;
    }).join('');
    const outerRx = Math.max(90, width / 2 - 75), outerRy = height / 2 - 63;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${gradients}<radialGradient id="station-glow"><stop stop-color="#76c5d6" stop-opacity=".2"/><stop offset="1" stop-color="#76c5d6" stop-opacity="0"/></radialGradient><linearGradient id="background" x2="0" y2="1"><stop stop-color="#071323"/><stop offset="1" stop-color="#0c1c32"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#background)"/>${dots}<ellipse cx="${scene.center.x}" cy="${scene.center.y}" rx="${outerRx}" ry="${outerRy}" fill="none" stroke="#8092a8" stroke-opacity=".13"/><ellipse cx="${scene.center.x}" cy="${scene.center.y}" rx="${orbitRadius}" ry="${orbitRadius * .77}" fill="none" stroke="#8092a8" stroke-opacity=".2"/>${paths}${worlds}${issuerDots}${F.stationSvg(scene, '#station-sprite', false)}</svg>`;
}
function nodeColor(node) { return M.CATEGORIES.find((category) => category.id === node.category)?.color || M.CATEGORIES[0].color; }
function makeShips(scene, elapsed, secondsPerHour, spriteData, width, height) {
    const shapes = scene.flights.map((flight) => {
        const pose = F.shipPose(flight, elapsed, secondsPerHour);
        if (!pose) return '';
        const angle = pose.angle * 180 / Math.PI;
        return `<g transform="translate(${pose.x.toFixed(3)} ${pose.y.toFixed(3)}) rotate(${angle.toFixed(3)})"><path d="M-12 0 H-19" stroke="${flight.color}" stroke-width="2" stroke-linecap="round" opacity=".33"/><use href="#ship-sprite"/></g>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><image id="ship-sprite" href="${spriteData}" x="-11" y="-6" width="22" height="12"/></defs>${shapes}</svg>`;
}
async function render() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help || !opts.run) { console.log(USAGE); if (!opts.help) process.exitCode = 2; return; }
    const inventoryPath = resolve(ROOT, opts.inventory), outPrefix = resolve(ROOT, opts.out);
    const [inventoryBytes, stationBytes, shipBytes] = await Promise.all([
        readFile(inventoryPath), readFile(resolve(ROOT, F.ASSETS.station)), readFile(resolve(ROOT, F.ASSETS.ship))
    ]);
    const inventory = JSON.parse(inventoryBytes);
    const view = M.selectInventory(inventory, { issuer: 'all', category: 'all' });
    const groups = M.groupRoutes(view);
    const scene = F.buildFleet(groups, opts.width, opts.height);
    const cadenceValues = [...new Set(scene.flights.map((f) => f.route.cadenceHours).filter(Number.isFinite))];
    const unsupported = cadenceValues.filter((hours) => !Number.isFinite(hours) || hours <= 0 || 24 % hours !== 0);
    if (unsupported.length) throw new Error(`Cannot make a seamless 24-hour cadence loop. Unsupported configured cadence(s): ${unsupported.join(', ')} hours.`);
    const resvg = require('@resvg/resvg-js');
    const { Resvg } = resvg;
    const duration = 24 * opts.secondsPerHour, framesCount = duration * opts.fps;
    const fingerprint = createHash('sha256').update(inventoryBytes).update(stationBytes).update(shipBytes)
        .update(await readFile(join(ROOT, 'rwa/lib/monitoring-map.js'))).update(await readFile(join(ROOT, 'rwa/lib/research-fleet.js'))).update(await readFile(fileURLToPath(import.meta.url)))
        .update(JSON.stringify({ width: opts.width, height: opts.height, fps: opts.fps, secondsPerHour: opts.secondsPerHour })).digest('hex').slice(0, 20);
    const framesBase = opts.frames ? resolve(ROOT, opts.frames) : join(tmpdir(), 'rwa-research-fleet-frames');
    const framesDir = join(framesBase, `fleet-${fingerprint}`);
    const tempDir = await mkdtemp(join(tmpdir(), 'rwa-fleet-'));
    const stationPng = join(tempDir, 'station.png'), shipPng = join(tempDir, 'ship.png');
    const stationWebp = join(tempDir, 'station.webp'), shipWebp = join(tempDir, 'ship.webp');
    await Promise.all([writeFile(stationWebp, stationBytes), writeFile(shipWebp, shipBytes)]);
    try {
        await Promise.all([
            run('ffmpeg', ['-v', 'error', '-y', '-i', stationWebp, stationPng], { quiet: true }),
            run('ffmpeg', ['-v', 'error', '-y', '-i', shipWebp, shipPng], { quiet: true })
        ]);
        const stationData = xmlData(await readFile(stationPng)), shipData = xmlData(await readFile(shipPng));
        const backdropSvg = makeBackdrop(scene, opts.width, opts.height, view.issuers.length).replace('#station-sprite', stationData);
        await mkdir(dirname(outPrefix), { recursive: true }); await mkdir(framesDir, { recursive: true });
        const bgPath = join(framesDir, 'background.png');
        if (!(await pngExists(bgPath))) await atomicWrite(bgPath, new Resvg(backdropSvg, { fitTo: { mode: 'original' } }).render().asPng());
        const start = Date.now(); let skipped = 0, rendered = 0;
        for (let i = 0; i < framesCount; i++) {
            const framePath = join(framesDir, `frame-${String(i).padStart(5, '0')}.png`);
            if (await pngExists(framePath)) { skipped++; continue; }
            const time = i / opts.fps;
            const svg = makeShips(scene, time, opts.secondsPerHour, shipData, opts.width, opts.height);
            await atomicWrite(framePath, new Resvg(svg, { fitTo: { mode: 'original' } }).render().asPng());
            rendered++;
            if ((rendered + skipped) % Math.max(1, Math.floor(opts.fps * 2)) === 0 || i === framesCount - 1) {
                const done = i + 1, elapsed = (Date.now() - start) / 1000, remaining = done ? elapsed / done * (framesCount - done) : 0;
                console.log(`${done}/${framesCount} frames: ${rendered} rendered, ${skipped} skipped; ETA ${Math.ceil(remaining)}s`);
            }
        }
        const pattern = join(framesDir, 'frame-%05d.png');
        const poster = join(tempDir, 'poster.png');
        console.log('Encoding poster WebP...');
        await run('ffmpeg', ['-v', 'error', '-y', '-i', bgPath, '-i', join(framesDir, 'frame-00000.png'), '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto', '-frames:v', '1', poster], { quiet: true });
        await run('cwebp', ['-quiet', '-q', '82', poster, '-o', `${outPrefix}.webp`], { quiet: true });
        console.log('Encoding VP9 WebM...');
        await run('ffmpeg', ['-v', 'error', '-y', '-framerate', String(opts.fps), '-i', pattern, '-loop', '1', '-framerate', String(opts.fps), '-i', bgPath, '-filter_complex', '[1:v][0:v]overlay=0:0:shortest=1:format=auto', '-c:v', 'libvpx-vp9', '-row-mt', '1', '-cpu-used', '3', '-threads', '4', '-crf', '40', '-b:v', '0', '-pix_fmt', 'yuv420p', '-an', `${outPrefix}.webm`], { quiet: true });
        console.log('Encoding H.264 MP4...');
        await run('ffmpeg', ['-v', 'error', '-y', '-framerate', String(opts.fps), '-i', pattern, '-loop', '1', '-framerate', String(opts.fps), '-i', bgPath, '-filter_complex', '[1:v][0:v]overlay=0:0:shortest=1:format=auto', '-c:v', 'libx264', '-preset', 'fast', '-threads', '4', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', `${outPrefix}.mp4`], { quiet: true });
        console.log('Encoding 12 fps GIF palette...');
        const palette = join(tempDir, 'palette.png');
        await run('ffmpeg', ['-v', 'error', '-y', '-framerate', String(opts.fps), '-i', pattern, '-loop', '1', '-framerate', String(opts.fps), '-i', bgPath, '-filter_complex', '[1:v][0:v]overlay=0:0:shortest=1:format=auto,fps=12,scale=960:-1:flags=lanczos,palettegen=max_colors=192', palette], { quiet: true });
        await run('ffmpeg', ['-v', 'error', '-y', '-framerate', String(opts.fps), '-i', pattern, '-loop', '1', '-framerate', String(opts.fps), '-i', bgPath, '-i', palette, '-filter_complex', '[1:v][0:v]overlay=0:0:shortest=1:format=auto,fps=12,scale=960:-1:flags=lanczos[x];[x][2:v]paletteuse=dither=bayer', '-loop', '0', `${outPrefix}.gif`], { quiet: true });
        console.log(`Exported ${framesCount} frames to ${outPrefix}.{webm,mp4,gif,webp}`);
    } finally { await rm(tempDir, { recursive: true, force: true }); }
}

render().catch((error) => { console.error(`Fleet export failed: ${error.message}`); process.exitCode = 1; });
