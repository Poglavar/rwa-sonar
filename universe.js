// The universe view: a walk through what tokenized stocks share. Every stop is a system built round a
// centre: Solana (all tokens), a token (a planet, with the things it shares as moons on one ring per
// dimension), or a filter (a moon such as a custodian or a key, with every token that shares it as a
// planet). Any set of tokens can be grouped on any attribute, and the groups orbit as moons. Clicking
// a body flies into it and it becomes the next centre. The data are tables (universe-view/index.json);
// every grouping and lookup is a query in stocks/lib/universe-view-model.js (window.__rwaUniverseView).
// This file is the three.js scene and the DOM wiring only. ?reduceMotion=1 turns off orbits and flights.
// three.js is self-hosted (vendor/three/README.md): the site's CSP allows no CDN and no import map.
import * as THREE from './vendor/three/0.186.1/three.module.js';
import { OrbitControls } from './vendor/three/0.186.1/addons/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from './vendor/three/0.186.1/addons/CSS2DRenderer.js';

const U = window.__rwaUniverseView;
const params = new URLSearchParams(location.search);
const REDUCE = params.get('reduceMotion') === '1' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SHOWN = Math.max(1, Math.min(200, Number(params.get('planets')) || 48));
const LABELLED = 24;
const FLIGHT_MS = 1100;
const SUN_RADIUS = 5;
const PLANET_CENTRE_RADIUS = 1.3;
const MOON_CENTRE_RADIUS = 1.1;

const $ = (id) => document.getElementById(id);
const els = {
    stage: $('stage'), panel: $('panel'), crumbs: $('crumbs'), search: $('search'), searchInput: $('searchInput'), searchResults: $('searchResults'),
    kicker: $('panelKicker'), title: $('panelTitle'), summary: $('panelSummary'), details: $('panelDetails'),
    children: $('panelChildren'), back: $('backButton'), link: $('panelLink')
};

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function log(message) {
    console.log(`[universe ${new Date().toISOString()}] ${message}`);
}

function isNum(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

// --- renderer, camera, lights -------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
els.stage.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'labels';
els.stage.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#030712');
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 8000);
camera.position.set(0, 93, 118);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 1500;

scene.add(new THREE.AmbientLight(0xffffff, 0.3));
// Every centre is the sun of its own system: the light sits inside it.
scene.add(new THREE.PointLight(0xfff1d6, 2.4, 0, 0));

/** The panel covers part of the screen, so the picture's centre moves to the middle of what is left. */
function resize() {
    const { innerWidth: w, innerHeight: h } = window;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    const rect = els.panel.getBoundingClientRect();
    const wide = w > 720;
    camera.setViewOffset(w, h, wide ? Math.max(0, Math.round((w - rect.left) / 2)) : 0, wide ? 0 : Math.max(0, Math.round((h - rect.top) / 2)), w, h);
    camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(els.panel);
resize();

// --- textures and shared shapes -----------------------------------------------------------------

const SPHERE = new THREE.SphereGeometry(1, 48, 24);

function canvasTexture(width, height, paint) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    paint(canvas.getContext('2d'), width, height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

const GLOW = canvasTexture(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
});

/** Gas-giant bands in the issuer's colour, varied per token so neighbours do not look identical. */
const bandCache = new Map();
function bandTexture(color, seed) {
    const key = `${color}:${Math.floor(seed * 6)}`;
    if (bandCache.has(key)) return bandCache.get(key);
    const base = new THREE.Color(color);
    const texture = canvasTexture(256, 128, (ctx, w, h) => {
        for (let y = 0; y < h; y += 1) {
            const wave = Math.sin(y * 0.19 + seed * 40) * 0.5 + Math.sin(y * 0.05 + seed * 9) * 0.5;
            ctx.fillStyle = `#${base.clone().offsetHSL(0, 0, wave * 0.09).getHexString()}`;
            ctx.fillRect(0, y, w, 1);
        }
    });
    bandCache.set(key, texture);
    return texture;
}

/**
 * Each category's surface pattern (its `pattern` in the dimensions table) in its colour, so a
 * category reads by pattern as well as by hue. Drawn on an equirectangular 256×128 canvas; every
 * horizontal period divides 256 so the seam at the back of the sphere does not show. Cached: every
 * body of a category shares one texture, and clearing a system never disposes it.
 */
const patternCache = new Map();
function patternTexture(dimensionId) {
    if (patternCache.has(dimensionId)) return patternCache.get(dimensionId);
    const dim = dimensionById.get(dimensionId);
    const base = new THREE.Color(dim?.color ?? '#e2e8f0');
    const dark = `#${base.clone().offsetHSL(0, 0, -0.24).getHexString()}`;
    const light = `#${base.clone().offsetHSL(0, -0.05, 0.12).getHexString()}`;
    const texture = canvasTexture(256, 128, (ctx, w, h) => {
        ctx.fillStyle = `#${base.getHexString()}`;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = dark;
        ctx.strokeStyle = dark;
        switch (dim?.pattern) {
            case 'meridians':
                for (let x = 0; x < w; x += 32) ctx.fillRect(x, 0, 10, h);
                break;
            case 'grid':
                for (let x = 0; x < w; x += 32) ctx.fillRect(x, 0, 3, h);
                for (let y = 8; y < h; y += 16) ctx.fillRect(0, y, w, 3);
                break;
            case 'dots':
                for (let y = 8, row = 0; y < h; y += 16, row += 1) {
                    for (let x = (row % 2) * 8; x < w + 8; x += 16) {
                        ctx.beginPath();
                        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
                break;
            case 'checker':
                for (let y = 0; y < h; y += 16) for (let x = (y / 16) % 2 ? 0 : 16; x < w; x += 32) ctx.fillRect(x, y, 16, 16);
                break;
            case 'diagonal':
                ctx.lineWidth = 9;
                for (let x = -h; x < w + h; x += 32) {
                    ctx.beginPath();
                    ctx.moveTo(x, 0);
                    ctx.lineTo(x + h, h);
                    ctx.stroke();
                }
                break;
            case 'waves':
                ctx.lineWidth = 4;
                for (let y = 10; y < h; y += 18) {
                    ctx.beginPath();
                    for (let x = 0; x <= w; x += 2) ctx.lineTo(x, y + Math.sin((x / 64) * Math.PI * 2) * 5);
                    ctx.stroke();
                }
                break;
            case 'craters':
                ctx.lineWidth = 2;
                for (let i = 0; i < 26; i += 1) {
                    const x = U.hash01(`${dimensionId}${i}`, 11) * w;
                    const y = 12 + U.hash01(`${dimensionId}${i}`, 12) * (h - 24);
                    const r = 4 + U.hash01(`${dimensionId}${i}`, 13) * 9;
                    // Drawn twice, a width apart, so a crater on the seam wraps round.
                    for (const dx of [0, -w, w]) {
                        ctx.beginPath();
                        ctx.arc(x + dx, y, r, 0, Math.PI * 2);
                        ctx.fillStyle = dark;
                        ctx.fill();
                        ctx.strokeStyle = light;
                        ctx.stroke();
                    }
                }
                break;
            default:
                break;
        }
    });
    patternCache.set(dimensionId, texture);
    return texture;
}

/**
 * The marquee: a band round a body's equator (±23° of latitude, a little proud of the surface) that
 * carries the body's name, tiled so it wraps seamlessly, and scrolls by moving the texture offset.
 */
const BAND = new THREE.SphereGeometry(1.03, 96, 6, 0, Math.PI * 2, Math.PI / 2 - 0.4, 0.8);
const MARQUEE_W = 1024;
const MARQUEE_H = 128; // the band's circumference is about 8 times its height
const MARQUEE_SPEED = 0.025; // turns of the band per second

function marqueeTexture(text, color) {
    const texture = canvasTexture(MARQUEE_W, MARQUEE_H, (ctx, w, h) => {
        ctx.fillStyle = 'rgba(3, 7, 18, 0.62)';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, w, 4);
        ctx.fillRect(0, h - 4, w, 4);
        ctx.font = '700 84px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#f8fafc';
        const unit = `${text}   ·   `;
        const width = ctx.measureText(unit).width;
        // Whole copies only, spread evenly, so the seam at u = 0 / 1 never cuts a word; at least two, so
        // the half facing the camera always has the name on it (a long name is narrowed to fit).
        const copies = Math.max(2, Math.floor(w / width));
        const step = w / copies;
        const squeeze = Math.min(1, step / width);
        for (let i = 0; i < copies; i += 1) {
            ctx.save();
            ctx.translate(i * step, 0);
            ctx.scale(squeeze, 1);
            ctx.fillText(unit, 0, h / 2 + 4);
            ctx.restore();
        }
    });
    texture.wrapS = THREE.RepeatWrapping;
    return texture;
}

/** Adds a marquee with `text` round a sphere of radius `radius` inside `parent`; returns the band mesh. */
function addMarquee(parent, text, color, radius) {
    const band = new THREE.Mesh(BAND, new THREE.MeshBasicMaterial({
        map: marqueeTexture(text, color), transparent: true, depthWrite: false, side: THREE.FrontSide
    }));
    band.scale.setScalar(radius);
    band.userData.marquee = true;
    parent.add(band);
    return band;
}

function ringLine(radius, color, opacity) {
    const points = [];
    for (let i = 0; i <= 160; i += 1) {
        const a = (i / 160) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
}

(function stars() {
    const positions = new Float32Array(3000 * 3);
    for (let i = 0; i < 3000; i += 1) {
        const r = 1500 + Math.random() * 1500;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions.set([r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta)], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    scene.add(new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xc7d2fe, size: 1.4, sizeAttenuation: false })));
})();

// --- data ---------------------------------------------------------------------------------------

let DATA = null;
let IX = null;
let issuerBySlug = new Map();
let ruleLabels = new Map();
const attributeById = new Map();
const dimensionById = new Map();
const cards = new Map();

function valueTone(v) {
    return IX.values[v].tone ?? 'info';
}

function dimensionColor(attributeId) {
    return dimensionById.get(attributeById.get(attributeId)?.dimension)?.color ?? '#e2e8f0';
}

function tokenColor(t) {
    return U.issuerColor(DATA.issuers, IX.tokens[t].issuer);
}

/** A token's card, fetched once; what each of its moons means for it comes from here. */
async function loadCard(t) {
    const token = IX.tokens[t];
    if (cards.has(token.slug)) return cards.get(token.slug);
    const url = `./cards/${encodeURIComponent(token.slug)}.json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const card = await response.json();
    const relations = new Map(U.tokenMoons(card, { planet: token, issuer: issuerBySlug.get(token.issuer) ?? null, ruleLabels })
        .map((moon) => [moon.id, moon.relation]));
    const entry = { card, relations };
    cards.set(token.slug, entry);
    return entry;
}

// --- stops --------------------------------------------------------------------------------------

/**
 * A stop is where the walk stands: {kind:'planet', token}, {kind:'aspect', token, dimension} (one
 * dimension of a token, such as its custody, orbited by its values there) or {kind:'filter',
 * filters:[value…], without:[attribute…], groupBy:attribute|null}. Solana is the filter with nothing in it.
 */
function stopTokens(stop) {
    let tokens = IX.tokensWhere(stop.filters);
    if (stop.without.length) {
        const without = new Set(stop.without);
        tokens = tokens.filter((t) => !IX.byToken[t].some((v) => without.has(IX.values[v].attribute)));
    }
    return tokens;
}

function isSun(stop) {
    return stop.kind === 'filter' && stop.filters.length === 0 && stop.without.length === 0;
}

/** The token a planet or aspect stop is about; null for a filter. */
function tokenOfStop(stop) {
    return stop?.kind === 'planet' || stop?.kind === 'aspect' ? stop.token : null;
}

function stopKey(stop) {
    if (stop.kind === 'planet') return `@${encodeURIComponent(IX.tokens[stop.token].slug)}`;
    if (stop.kind === 'aspect') return `@${encodeURIComponent(IX.tokens[stop.token].slug)}~${stop.dimension}`;
    const parts = [...stop.filters.map((v) => encodeURIComponent(IX.values[v].id)), ...stop.without.map((a) => `!${encodeURIComponent(a)}`)];
    return `${parts.length ? parts.join('+') : '*'}${stop.groupBy ? `|${encodeURIComponent(stop.groupBy)}` : ''}`;
}

function parseStop(key) {
    if (key.startsWith('@')) {
        const [slug, dimension] = key.slice(1).split('~');
        const token = IX.tokenBySlug.get(decodeURIComponent(slug));
        if (token === undefined) return null;
        return dimension && dimensionById.has(dimension) ? { kind: 'aspect', token, dimension } : { kind: 'planet', token };
    }
    const [body, group] = key.split('|');
    const filters = [];
    const without = [];
    for (const part of body === '*' ? [] : body.split('+')) {
        if (part.startsWith('!')) without.push(decodeURIComponent(part.slice(1)));
        else {
            const v = IX.valueById.get(decodeURIComponent(part));
            if (v === undefined) return null;
            filters.push(v);
        }
    }
    const groupBy = group ? decodeURIComponent(group) : null;
    return { kind: 'filter', filters, without, groupBy: attributeById.has(groupBy) ? groupBy : null };
}

function stopLabel(stop) {
    if (stop.kind === 'planet') return IX.tokens[stop.token].symbol;
    if (stop.kind === 'aspect') return dimensionById.get(stop.dimension)?.label ?? stop.dimension;
    if (isSun(stop)) return 'Solana';
    if (stop.without.length) return attributeById.get(stop.without[stop.without.length - 1])?.none ?? 'None';
    return IX.values[stop.filters[stop.filters.length - 1]].label;
}

// --- building a system --------------------------------------------------------------------------

let system = null;

function clearSystem() {
    if (!system) return;
    scene.remove(system.group);
    system.group.traverse((object) => {
        if (object.isCSS2DObject) object.element.remove();
        if (object.geometry && object.geometry !== SPHERE && object.geometry !== BAND) object.geometry.dispose();
        if (object.userData.marquee) object.material.map.dispose();
        if (object.material) object.material.dispose();
    });
    system = null;
    hovered = null;
}

function makeLabel(text, className, dot, onClick) {
    const el = document.createElement('div');
    el.className = `body-label ${className}`;
    el.style.setProperty('--dot', dot);
    el.textContent = text;
    if (onClick) {
        el.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
    }
    return el;
}

function makeCentre(stop) {
    const group = new THREE.Group();
    let radius;
    let label;
    if (isSun(stop)) {
        radius = SUN_RADIUS;
        group.add(new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 32), new THREE.MeshBasicMaterial({ color: '#ffcf6e' })));
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: '#ffc46b', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        glow.scale.setScalar(radius * 6);
        group.add(glow);
        label = makeLabel('Solana', 'sun', '#ffd98a');
    } else if (stop.kind === 'planet') {
        radius = PLANET_CENTRE_RADIUS;
        const token = IX.tokens[stop.token];
        const color = tokenColor(stop.token);
        const bands = bandTexture(color, U.hash01(token.slug, 3));
        const mesh = new THREE.Mesh(SPHERE, new THREE.MeshStandardMaterial({
            color: 0xffffff, map: bands, emissive: 0xffffff, emissiveMap: bands, emissiveIntensity: 0.3, roughness: 0.8
        }));
        mesh.scale.setScalar(radius);
        group.add(mesh);
        label = makeLabel(token.symbol, 'planet focus', color);
    } else {
        radius = MOON_CENTRE_RADIUS;
        const attribute = stop.kind === 'aspect' ? null
            : stop.without.length ? stop.without[stop.without.length - 1] : IX.values[stop.filters[stop.filters.length - 1]].attribute;
        const dimensionId = stop.kind === 'aspect' ? stop.dimension : attributeById.get(attribute)?.dimension;
        const color = dimensionById.get(dimensionId)?.color ?? '#e2e8f0';
        const texture = patternTexture(dimensionId);
        const mesh = new THREE.Mesh(SPHERE, new THREE.MeshStandardMaterial({
            color: 0xffffff, map: texture, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: 0.4, roughness: 0.7
        }));
        mesh.scale.setScalar(radius);
        group.add(mesh);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending }));
        glow.scale.setScalar(radius * 4);
        group.add(glow);
        if (stop.kind === 'aspect') label = makeLabel(`${IX.tokens[stop.token].symbol} · ${stopLabel(stop)}`, 'moon focus', color);
        else {
            const tone = stop.without.length ? 'muted' : valueTone(stop.filters[stop.filters.length - 1]);
            label = makeLabel(stopLabel(stop), 'moon focus', U.TONE_COLORS[tone]);
        }
    }
    const labelObject = new CSS2DObject(label);
    labelObject.position.set(0, radius * 1.2, 0);
    group.add(labelObject);
    const band = addMarquee(group, label.textContent, label.style.getPropertyValue('--dot') || '#ffd98a', radius);
    return { group, radius, label: labelObject, band, labelText: label.textContent };
}

/** One orbiting body: a tilted plane, a spinning arm, and the sphere with its label at the arm's end. */
function makeOrbiter(parent, { orbit, size, color, texture = null, emissive = 0.15, label, dot, labelled, ringOpacity, item }) {
    const incl = new THREE.Group();
    incl.rotation.x = orbit.tilt;
    const spin = new THREE.Group();
    spin.rotation.y = orbit.angle;
    incl.add(spin);
    const anchor = new THREE.Group();
    anchor.position.set(orbit.radius, 0, 0);
    spin.add(anchor);
    // A textured body glows through its own pattern, so the glow never washes the pattern out.
    const mesh = new THREE.Mesh(SPHERE, new THREE.MeshStandardMaterial({
        color: texture ? 0xffffff : color, map: texture, emissive: texture ? 0xffffff : color, emissiveMap: texture,
        emissiveIntensity: emissive, roughness: 0.85, metalness: 0.05
    }));
    mesh.scale.setScalar(size);
    anchor.add(mesh);
    if (ringOpacity > 0) incl.add(ringLine(orbit.radius, color, ringOpacity));
    // The band sits on the anchor, not the mesh, so the planet's own spin does not carry the text.
    const band = addMarquee(anchor, label, dot, size);
    const body = { orbit, size, spin, anchor, mesh, band, labelled, item };
    const labelEl = makeLabel(label, 'orbiter', dot, () => enter(body));
    labelEl.addEventListener('pointerenter', () => setHover(body));
    labelEl.addEventListener('pointerleave', () => setHover(null));
    body.label = new CSS2DObject(labelEl);
    body.label.position.set(0, size * 1.2, 0);
    body.label.visible = labelled;
    anchor.add(body.label);
    parent.add(incl);
    mesh.userData.body = body;
    return body;
}

function belt(parent, items, inner) {
    if (!items.length) return;
    const positions = new Float32Array(items.length * 3);
    const colors = new Float32Array(items.length * 3);
    items.forEach((item, i) => {
        const a = U.hash01(item.key, 5) * Math.PI * 2;
        const r = inner + U.hash01(item.key, 6) * 12;
        positions.set([Math.cos(a) * r, (U.hash01(item.key, 7) - 0.5) * 3, Math.sin(a) * r], i * 3);
        const c = new THREE.Color(item.color);
        colors.set([c.r, c.g, c.b], i * 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parent.add(new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.45, vertexColors: true, transparent: true, opacity: 0.7 })));
}

function groupSize(count) {
    return 0.4 + 0.45 * Math.log10(count + 1);
}

/** The groups of a filter stop, the "has none" group last, each with the stop it opens. */
function groupsOf(stop, tokens) {
    const { groups, none } = IX.groupBy(tokens, stop.groupBy);
    const out = groups.map((g) => ({
        key: IX.values[g.value].id, label: IX.values[g.value].label, tone: valueTone(g.value), tokens: g.tokens,
        next: { kind: 'filter', filters: [...stop.filters, g.value], without: stop.without, groupBy: null }
    }));
    if (none.length) {
        out.push({
            key: `${stop.groupBy}:none`, label: attributeById.get(stop.groupBy)?.none ?? 'None', tone: 'muted', tokens: none,
            next: { kind: 'filter', filters: stop.filters, without: [...stop.without, stop.groupBy], groupBy: null }
        });
    }
    return out;
}

function buildSystem(stop) {
    clearSystem();
    const group = new THREE.Group();
    const centre = makeCentre(stop);
    group.add(centre.group);
    const bodies = [];
    // Things with one member only (a value no other token has, a group of one token) do not orbit:
    // opening one would show a system of one. The panel lists them instead.
    let singles = [];
    let extent = centre.radius * 2;

    if (stop.kind === 'planet') {
        // A token's moons are its dimensions (custody, rights, keys…); what it has in each is one level down.
        const aspects = IX.aspects(stop.token);
        const sizeOf = (a) => centre.radius * (0.16 + 0.05 * Math.sqrt(a.shared.length + a.single.length));
        const { radius, orbits } = U.evenRing(aspects.map((a) => ({ id: a.dimension, size: sizeOf(a) })), centre.radius);
        aspects.forEach((aspect, i) => {
            const dim = dimensionById.get(aspect.dimension);
            const n = aspect.shared.length + aspect.single.length;
            bodies.push(makeOrbiter(group, {
                orbit: orbits[i], size: orbits[i].size, color: dim.color, texture: patternTexture(aspect.dimension), emissive: 0.3, label: `${dim.label} · ${n}`, dot: dim.color, labelled: true, ringOpacity: 0,
                item: { kind: 'aspect', aspect }
            }));
            extent = Math.max(extent, radius + orbits[i].size);
        });
        group.add(ringLine(radius, '#c7d2fe', 0.2));
    } else if (stop.kind === 'aspect') {
        const aspect = IX.aspects(stop.token).find((a) => a.dimension === stop.dimension) ?? { shared: [], single: [] };
        singles = aspect.single.map((v) => ({ kind: 'value', v }));
        const moons = aspect.shared.map((v) => ({ id: IX.values[v].id, dimension: stop.dimension }));
        const { size, rings } = U.moonRings(moons, centre.radius);
        for (const ring of rings) {
            const color = dimensionById.get(ring.dimension)?.color ?? '#e2e8f0';
            for (const orbit of ring.orbits) {
                const v = IX.valueById.get(orbit.id);
                bodies.push(makeOrbiter(group, {
                    orbit, size, color, texture: patternTexture(stop.dimension), emissive: 0.3, label: IX.values[v].label, dot: U.TONE_COLORS[valueTone(v)], labelled: true, ringOpacity: 0,
                    item: { kind: 'value', v }
                }));
            }
            group.add(ringLine(ring.radius, color, 0.25));
            extent = Math.max(extent, ring.radius + size);
        }
    } else {
        const tokens = stopTokens(stop);
        let groups = [];
        if (stop.groupBy) {
            const { multi, single } = U.splitSingles(groupsOf(stop, tokens));
            groups = multi;
            singles = single.map((g) => ({ kind: 'single-group', label: g.label, tone: g.tone, t: g.tokens[0] })).sort((a, b) => a.t - b.t);
        }
        const items = stop.groupBy
            ? groups.map((g) => ({ ...g, kind: 'group', size: groupSize(g.tokens.length), color: dimensionColor(stop.groupBy) }))
            : tokens.map((t) => ({ kind: 'token', t, key: IX.tokens[t].slug, label: IX.tokens[t].symbol, size: U.planetRadius(IX.tokens[t].liquidityUsd), color: tokenColor(t) }));
        const { shown, rest } = U.splitForView(items, SHOWN);
        shown.forEach((item, rank) => {
            const orbit = U.planetOrbit(rank, item.key, centre.radius);
            bodies.push(makeOrbiter(group, {
                orbit, size: item.size, color: item.color,
                texture: item.kind === 'token' ? bandTexture(item.color, U.hash01(item.key, 3)) : patternTexture(attributeById.get(stop.groupBy)?.dimension),
                emissive: item.kind === 'token' ? 0.12 : 0.3,
                label: item.kind === 'group' ? `${item.label} · ${item.tokens.length}` : item.label,
                dot: item.kind === 'group' ? U.TONE_COLORS[item.tone] : item.color,
                labelled: rank < LABELLED, ringOpacity: 0.1, item
            }));
            extent = Math.max(extent, orbit.radius + item.size);
        });
        const inner = extent + 6;
        belt(group, rest, inner);
        group.userData.rest = rest.length;
        if (rest.length) extent = inner + 12;
    }
    scene.add(group);
    system = { stop, group, centre, bodies, singles, extent };
    return system;
}

// --- camera flights -----------------------------------------------------------------------------

let flight = null;

function worldOf(object) {
    return object.getWorldPosition(new THREE.Vector3());
}

/** Flies the camera to look at `target` (a point, or a function for a moving one) from `distance`. */
function fly(target, distance) {
    return new Promise((resolve) => {
        let dir = camera.position.clone().sub(controls.target);
        if (dir.lengthSq() < 1e-9) dir = new THREE.Vector3(0, 0.6, 1);
        dir.normalize();
        dir.y = Math.max(dir.y, 0.35);
        dir.normalize();
        flight = {
            start: performance.now(), duration: REDUCE ? 0 : FLIGHT_MS, target, distance, direction: dir,
            fromTarget: controls.target.clone(), fromPosition: camera.position.clone(), resolve
        };
    });
}

function easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function stepFlight(now) {
    if (!flight) return;
    const k = flight.duration === 0 ? 1 : Math.min(1, (now - flight.start) / flight.duration);
    const e = easeInOut(k);
    const target = typeof flight.target === 'function' ? flight.target() : flight.target;
    controls.target.lerpVectors(flight.fromTarget, target, e);
    camera.position.lerpVectors(flight.fromPosition, target.clone().addScaledVector(flight.direction, flight.distance), e);
    if (k >= 1) {
        const done = flight.resolve;
        flight = null;
        done();
    }
}

function frame(sys) {
    controls.minDistance = sys.centre.radius * 1.3;
    return fly(new THREE.Vector3(), U.frameDistance(sys.centre.radius, sys.extent, camera.aspect));
}

// --- the walk -----------------------------------------------------------------------------------

let trail = [];
let busy = false;
let queued = null;

/**
 * Goes to `stop`. From a clicked body, the camera first dives into it and it becomes the new centre.
 * Asked again mid-flight (a search pick, Esc), the latest request waits and runs when this one lands;
 * its body will be gone by then, so it goes without the dive.
 */
async function go(stop, { from = null, push = true } = {}) {
    if (busy) {
        queued = { stop, push };
        return;
    }
    busy = true;
    try {
        let nextTrail = trail;
        if (push) {
            const key = stopKey(stop);
            const at = trail.findIndex((s) => stopKey(s) === key);
            nextTrail = at >= 0 ? trail.slice(0, at + 1) : [...trail, stop];
        }
        let cardError = null;
        if (tokenOfStop(stop) !== null) {
            if (!cards.has(IX.tokens[stop.token].slug)) renderLoading(IX.tokens[stop.token].symbol);
            await loadCard(stop.token).catch((err) => {
                cardError = err;
                console.error(`[universe ${new Date().toISOString()}]`, err);
            });
        }
        // A moon reached from a token says what it means for that token, so read that card too
        // (a link can land here without the token ever having been opened).
        const previous = nextTrail.length > 1 ? nextTrail[nextTrail.length - 2] : null;
        if (stop.kind === 'filter' && tokenOfStop(previous) !== null) {
            await loadCard(previous.token).catch((err) => console.error(`[universe ${new Date().toISOString()}]`, err));
        }
        let relative = null;
        if (from) {
            await fly(() => worldOf(from.anchor), from.size * 6);
            relative = camera.position.clone().sub(worldOf(from.anchor)).divideScalar(from.size);
        }
        const sys = buildSystem(stop);
        if (relative) {
            camera.position.copy(relative.multiplyScalar(sys.centre.radius));
            controls.target.set(0, 0, 0);
        }
        trail = nextTrail;
        trail[trail.length - 1] = stop;
        renderPanel(cardError);
        renderCrumbs();
        history.replaceState(null, '', `#${trail.map(stopKey).join('/')}`);
        await frame(sys);
        document.body.dataset.stop = stopKey(stop);
    } finally {
        busy = false;
    }
    if (queued) {
        const next = queued;
        queued = null;
        await go(next.stop, { push: next.push });
    }
}

function enter(body) {
    if (body.item.kind === 'aspect') return go({ kind: 'aspect', token: system.stop.token, dimension: body.item.aspect.dimension }, { from: body });
    if (body.item.kind === 'value') return go({ kind: 'filter', filters: [body.item.v], without: [], groupBy: null }, { from: body });
    if (body.item.kind === 'token') return go({ kind: 'planet', token: body.item.t }, { from: body });
    return go(body.item.next, { from: body });
}

/** Back and the breadcrumbs cut the trail themselves, so they wait for a flight to land rather than queue. */
function back() {
    if (busy || trail.length < 2) return;
    trail = trail.slice(0, -1);
    go(trail[trail.length - 1], { push: false });
}

// --- panel and breadcrumbs ----------------------------------------------------------------------

function renderLoading(symbol) {
    els.kicker.textContent = 'Token';
    els.title.textContent = symbol;
    els.summary.textContent = 'Reading its card…';
    els.details.innerHTML = '';
    els.children.innerHTML = '';
}

function detailValue(value) {
    return /^https?:\/\//.test(value)
        ? `<a href="${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(value.replace(/^https?:\/\//, '').slice(0, 48))}${value.length > 56 ? '…' : ''}</a>`
        : esc(value);
}

function detailsHtml(pairs) {
    return pairs.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${detailValue(value)}</dd>`).join('');
}

function button(index, label, hint, dot) {
    return `<button type="button" class="child" data-orbiter="${index}" style="--dot:${esc(dot)}">`
        + `<span class="dot"></span><strong>${esc(label)}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</button>`;
}

/** A thing with one member: listed, not orbited. With a token index it opens that token. */
function lineItem(label, hint, dot, tag, token = null) {
    const inner = `<span class="dot"></span><strong>${esc(label)}${tag ? ` <em>${esc(tag)}</em>` : ''}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}`;
    return token === null
        ? `<div class="child line-item" style="--dot:${esc(dot)}">${inner}</div>`
        : `<button type="button" class="child line-item" data-token="${token}" style="--dot:${esc(dot)}">${inner}</button>`;
}

function groupBySelect(stop) {
    const byDimension = [...dimensionById.values()].map((dim) => {
        const options = IX.attributes.filter((a) => a.dimension === dim.id)
            .map((a) => `<option value="${esc(a.id)}"${stop.groupBy === a.id ? ' selected' : ''}>${esc(a.label)}</option>`).join('');
        return options ? `<optgroup label="${esc(dim.label)}">${options}</optgroup>` : '';
    }).join('');
    return `<label class="group-by">Group these tokens by <select id="groupBy"><option value="">nothing: show the tokens</option>${byDimension}</select></label>`;
}

function money(value) {
    return isNum(value) ? `$${value >= 100 ? Math.round(value).toLocaleString('en-US') : value.toFixed(2)}` : null;
}

function renderPanel(cardError = null) {
    const stop = system.stop;
    const bodies = system.bodies;
    els.back.hidden = trail.length < 2;
    els.link.hidden = true;
    if (stop.kind === 'planet') {
        const token = IX.tokens[stop.token];
        const issuer = issuerBySlug.get(token.issuer);
        const template = DATA.templates?.[token.template] ?? null;
        els.kicker.textContent = `Token · ${issuer?.name ?? token.issuer ?? ''}`;
        els.title.textContent = token.symbol;
        els.summary.textContent = cardError ? `Could not read its card (${cardError.message}); its moons still come from the tables.` : (token.name ?? '');
        els.details.innerHTML = detailsHtml([['Tracks', token.underlying], ['Price', money(token.priceUsd)], ['Liquidity', money(token.liquidityUsd)],
            ['Health', token.status], ...(template ? DATA.scenarios.map((s) => [s.label, template[s.id]?.headline]) : [])].filter(([, v]) => v));
        // One entry per dimension moon, previewing what is inside it.
        const list = bodies.map((b, i) => {
            const { aspect } = b.item;
            const dim = dimensionById.get(aspect.dimension);
            const inside = [...aspect.shared, ...aspect.single].map((v) => IX.values[v].label);
            const preview = inside.slice(0, 4).join(' · ') + (inside.length > 4 ? ` · and ${inside.length - 4} more` : '');
            return button(i, `${dim.label} · ${inside.length}`, preview, dim.color);
        }).join('');
        els.children.innerHTML = `<p class="hint-line">Each moon is one side of ${esc(token.symbol)}: its legal structure, custody, rights, keys, DeFi use. `
            + 'Open one to see what it has there, then open any of those to see every token that shares it.</p>'
            + `<h2>What ${esc(token.symbol)} is made of</h2>${list}`;
        els.link.hidden = false;
        els.link.href = `./cards/${encodeURIComponent(token.slug)}.html`;
        els.link.textContent = 'Open its card →';
        return;
    }

    if (stop.kind === 'aspect') {
        const token = IX.tokens[stop.token];
        const entry = cards.get(token.slug) ?? null;
        const dim = dimensionById.get(stop.dimension);
        const relationOf = (v) => entry?.relations.get(IX.values[v].id)?.summary ?? null;
        els.kicker.textContent = `${token.symbol} · ${token.name ?? ''}`;
        els.title.textContent = dim?.label ?? stop.dimension;
        els.summary.textContent = cardError ? `Could not read its card (${cardError.message}); its moons still come from the tables.`
            : `What ${token.symbol} has here. Each moon is shared with other tokens; the number is how many. Open one to see them all.`;
        els.details.innerHTML = '';
        // Grouped by attribute (Custodian, Attestor…) within the dimension.
        const attributeOfValue = (v) => IX.values[v].attribute;
        const sections = IX.attributes.filter((a) => a.dimension === stop.dimension).map((a) => {
            const own = bodies.map((b, i) => ({ b, i })).filter(({ b }) => attributeOfValue(b.item.v) === a.id);
            const alone = system.singles.filter((item) => attributeOfValue(item.v) === a.id);
            if (!own.length && !alone.length) return '';
            return `<h2>${esc(a.label)}</h2>`
                + own.map(({ b, i }) => button(i, `${IX.values[b.item.v].label} · ${IX.byValue[b.item.v].length}`, relationOf(b.item.v), U.TONE_COLORS[valueTone(b.item.v)])).join('')
                + alone.map((item) => lineItem(IX.values[item.v].label, relationOf(item.v), U.TONE_COLORS[valueTone(item.v)], `only ${token.symbol}`)).join('');
        }).join('');
        els.children.innerHTML = `${sections}${system.singles.length ? `<p class="hint-line">What only ${esc(token.symbol)} has is listed without a moon.</p>` : ''}`;
        els.link.hidden = false;
        els.link.href = `./cards/${encodeURIComponent(token.slug)}.html`;
        els.link.textContent = 'Open its card →';
        return;
    }

    const tokens = stopTokens(stop);
    if (isSun(stop)) {
        els.kicker.textContent = 'Universe';
        els.title.textContent = 'Tokenized stocks on Solana';
        els.summary.textContent = `${IX.tokens.length.toLocaleString('en-US')} tokens. A planet is a token: its size is its pool liquidity, its colour its issuer. `
            + 'Open a planet to see what it shares with others, or group them all by anything below.';
        els.details.innerHTML = '';
    } else {
        const labels = [...stop.filters.map((v) => IX.values[v].label), ...stop.without.map((a) => attributeById.get(a)?.none ?? a)];
        const last = stop.without.length ? null : stop.filters[stop.filters.length - 1];
        const attribute = stop.without.length ? stop.without[stop.without.length - 1] : IX.values[last].attribute;
        els.kicker.textContent = attributeById.get(attribute)?.label ?? '';
        els.title.textContent = stopLabel(stop);
        els.summary.textContent = `${tokens.length.toLocaleString('en-US')} token${tokens.length === 1 ? '' : 's'} ${labels.length > 1 ? `share all of: ${labels.join(' · ')}` : 'share this'}.`;
        const previous = trail.length > 1 ? trail[trail.length - 2] : null;
        const relation = tokenOfStop(previous) !== null && last !== null ? cards.get(IX.tokens[previous.token].slug)?.relations.get(IX.values[last].id) : null;
        els.details.innerHTML = relation ? `<dt>For ${esc(IX.tokens[previous.token].symbol)}</dt><dd>${esc(relation.summary ?? '')}</dd>${detailsHtml(relation.details ?? [])}` : '';
        const href = last !== null ? U.moonHref(IX.values[last].id) : null;
        if (href) {
            els.link.hidden = false;
            els.link.href = href;
            els.link.textContent = 'Open the page →';
        }
    }
    const list = bodies.slice(0, 14).map((b, i) => (b.item.kind === 'group'
        ? button(i, b.item.label, `${b.item.tokens.length} token${b.item.tokens.length === 1 ? '' : 's'}`, U.TONE_COLORS[b.item.tone])
        : button(i, IX.tokens[b.item.t].symbol, IX.tokens[b.item.t].name, b.item.color))).join('');
    const total = stop.groupBy ? system.bodies.length + (system.group.userData.rest ?? 0) : tokens.length;
    const more = total - Math.min(14, bodies.length);
    const SINGLES_LISTED = 60;
    const singles = system.singles.slice(0, SINGLES_LISTED)
        .map((item) => lineItem(item.label, IX.tokens[item.t].symbol, U.TONE_COLORS[item.tone], null, item.t)).join('');
    const singlesHtml = system.singles.length
        ? `<h2>Groups of one token · ${system.singles.length.toLocaleString('en-US')}</h2>${singles}`
            + (system.singles.length > SINGLES_LISTED ? `<p class="hint-line">and ${(system.singles.length - SINGLES_LISTED).toLocaleString('en-US')} more; find any token with the search box.</p>` : '')
        : '';
    const legend = !stop.groupBy
        ? `<div class="legend">${DATA.issuers.filter((i) => tokens.some((t) => IX.tokens[t].issuer === i.slug))
            .map((i) => `<span style="--dot:${esc(U.issuerColor(DATA.issuers, i.slug))}">${esc(i.name)}</span>`).join('')}</div>` : '';
    els.children.innerHTML = `${groupBySelect(stop)}${legend}<h2>${stop.groupBy ? `Grouped by ${esc(attributeById.get(stop.groupBy)?.label ?? '')}` : 'Biggest pools'}</h2>${list}`
        + (more > 0 ? `<p class="hint-line">and ${more.toLocaleString('en-US')} more${total > SHOWN ? ', the smallest in the outer belt' : ''}.</p>` : '')
        + singlesHtml;
    document.getElementById('groupBy').addEventListener('change', (event) => {
        go({ ...stop, groupBy: event.target.value || null }, { push: false });
    });
}

function renderCrumbs() {
    els.crumbs.innerHTML = trail.map((stop, i) => `${i ? '<span class="sep">›</span>' : ''}<button type="button" data-crumb="${i}"${i === trail.length - 1 ? ' aria-current="true"' : ''}>${esc(stopLabel(stop))}</button>`).join('');
}

els.crumbs.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-crumb]');
    if (!target || busy) return;
    const i = Number(target.dataset.crumb);
    trail = trail.slice(0, i + 1);
    go(trail[i], { push: false });
});
els.children.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-orbiter]');
    if (target) enter(system.bodies[Number(target.dataset.orbiter)]);
    const single = event.target.closest('button[data-token]');
    if (single) go({ kind: 'planet', token: Number(single.dataset.token) });
});
els.back.addEventListener('click', back);
window.addEventListener('keydown', (event) => {
    const typing = event.target.closest?.('input, select, textarea');
    if (event.key === 'Escape' && !typing) back();
    if (event.key === '/' && !typing) {
        event.preventDefault();
        els.searchInput.focus();
    }
});

// --- search -------------------------------------------------------------------------------------

/** The results under the search box: tokens, then the things tokens share; `active` is the highlighted one. */
let results = [];
let active = -1;

function resultOption(result, i) {
    return `<div class="result" role="option" id="result-${i}" data-result="${i}" aria-selected="${i === active}" style="--dot:${esc(result.dot)}">`
        + `<span class="dot"></span><strong>${esc(result.label)}</strong><small>${esc(result.hint)}</small></div>`;
}

function renderResults() {
    const query = els.searchInput.value;
    const found = IX ? U.search(IX, query) : { tokens: [], values: [] };
    const tokenResults = found.tokens.map(({ t }) => {
        const token = IX.tokens[t];
        return {
            section: 'Tokens', label: token.symbol, dot: tokenColor(t),
            hint: [token.name, issuerBySlug.get(token.issuer)?.name].filter(Boolean).join(' · '),
            stop: { kind: 'planet', token: t }
        };
    });
    const valueResults = found.values.map(({ v, count }) => {
        const value = IX.values[v];
        const only = count === 1 ? IX.byValue[v][0] : null;
        return {
            section: 'Shared by tokens', label: value.label, dot: U.TONE_COLORS[valueTone(v)],
            hint: `${attributeById.get(value.attribute)?.label ?? value.attribute} · ${only === null ? `${count.toLocaleString('en-US')} tokens` : `only ${IX.tokens[only].symbol}`}`,
            // A value only one token has would open a system of one: it opens that token instead.
            stop: only === null ? { kind: 'filter', filters: [v], without: [], groupBy: null } : { kind: 'planet', token: only }
        };
    });
    // The section holding the best match goes first, so Enter opens it; tokens win a tie.
    const valuesFirst = found.values.length && (!found.tokens.length || found.values[0].score < found.tokens[0].score);
    results = valuesFirst ? [...valueResults, ...tokenResults] : [...tokenResults, ...valueResults];
    active = results.length ? Math.min(Math.max(active, 0), results.length - 1) : -1;
    let html = '';
    let section = null;
    results.forEach((result, i) => {
        if (result.section !== section) {
            section = result.section;
            html += `<p class="result-section">${esc(section)}</p>`;
        }
        html += resultOption(result, i);
    });
    if (query.trim() && !results.length) html = '<p class="result-empty">Nothing by that name.</p>';
    els.searchResults.innerHTML = html;
    const open = query.trim() !== '';
    els.searchResults.hidden = !open;
    els.searchInput.setAttribute('aria-expanded', String(open));
    if (active >= 0) els.searchInput.setAttribute('aria-activedescendant', `result-${active}`);
    else els.searchInput.removeAttribute('aria-activedescendant');
}

function closeResults() {
    els.searchResults.hidden = true;
    els.searchInput.setAttribute('aria-expanded', 'false');
}

function pickResult(i) {
    const result = results[i];
    if (!result) return;
    els.searchInput.value = '';
    active = -1;
    closeResults();
    els.searchInput.blur();
    go(result.stop);
}

function moveActive(step) {
    if (!results.length) return;
    active = (active + step + results.length) % results.length;
    for (const el of els.searchResults.querySelectorAll('[data-result]')) el.setAttribute('aria-selected', String(Number(el.dataset.result) === active));
    els.searchInput.setAttribute('aria-activedescendant', `result-${active}`);
    document.getElementById(`result-${active}`)?.scrollIntoView({ block: 'nearest' });
}

els.search.addEventListener('submit', (event) => {
    event.preventDefault();
    pickResult(active >= 0 ? active : 0);
});
els.searchInput.addEventListener('input', () => {
    active = 0;
    renderResults();
});
els.searchInput.addEventListener('focus', () => {
    if (els.searchInput.value.trim()) renderResults();
});
els.searchInput.addEventListener('blur', closeResults);
els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveActive(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Escape') {
        event.stopPropagation();
        if (els.searchInput.value) {
            els.searchInput.value = '';
            closeResults();
        } else els.searchInput.blur();
    }
});
// pointerdown, not click: a click would come after the input's blur had already closed the list.
els.searchResults.addEventListener('pointerdown', (event) => {
    const option = event.target.closest('[data-result]');
    if (!option) return;
    event.preventDefault();
    pickResult(Number(option.dataset.result));
});

// --- picking ------------------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hovered = null;
let downAt = null;

function pick(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(system ? system.bodies.map((b) => b.mesh) : [], false)[0];
    return hit ? hit.object.userData.body : null;
}

function setHover(body) {
    if (hovered === body) return;
    if (hovered) {
        hovered.label.element.classList.remove('hover');
        hovered.label.visible = hovered.labelled;
    }
    hovered = body;
    if (hovered) {
        hovered.label.element.classList.add('hover');
        hovered.label.visible = true;
    }
    renderer.domElement.style.cursor = hovered ? 'pointer' : '';
}

renderer.domElement.addEventListener('pointerdown', (event) => {
    downAt = { x: event.clientX, y: event.clientY };
});
renderer.domElement.addEventListener('pointerup', (event) => {
    if (!downAt || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 6) return;
    const body = pick(event);
    if (body) enter(body);
});
renderer.domElement.addEventListener('pointermove', (event) => {
    if (!event.buttons) setHover(pick(event));
});

// --- labels -------------------------------------------------------------------------------------

const projected = new THREE.Vector3();

// A body at least this many pixels in radius on screen carries its name on its marquee (the text is
// about half the radius tall); a smaller one shows the band-less body with the label above it.
const MARQUEE_MIN_PX = 30;
const worldPoint = new THREE.Vector3();

function screenRadius(object, radius, height) {
    const distance = camera.position.distanceTo(object.getWorldPosition(worldPoint));
    return distance > 0 ? (radius / (distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * (height / 2) : Infinity;
}

/**
 * Each body shows its name one way: on its marquee when it is big enough on screen to read, else as
 * a label above it. Labels that would overlap one drawn before them are hidden, in body order (inner
 * rings and bigger pools first); the hovered body's label always shows. Boxes are estimated from the
 * text length.
 */
function declutter() {
    if (!system) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const placed = [];
    const centreReadable = screenRadius(system.centre.group, system.centre.radius, rect.height) >= MARQUEE_MIN_PX;
    system.centre.band.visible = centreReadable;
    system.centre.label.visible = !centreReadable;
    if (!centreReadable) {
        // The centre's label is placed first, so no orbiting label hides under it.
        projected.set(0, system.centre.radius * 1.2, 0).project(camera);
        const cx = (projected.x + 1) / 2 * rect.width;
        const cy = (1 - projected.y) / 2 * rect.height - 16;
        const cw = system.centre.labelText.length * 6.6 + 22;
        placed.push({ x0: cx - cw / 2, x1: cx + cw / 2, y0: cy - 9, y1: cy + 9 });
    }
    for (const body of system.bodies) {
        const readable = screenRadius(body.anchor, body.size, rect.height) >= MARQUEE_MIN_PX;
        body.band.visible = readable;
        if (readable || !body.labelled) {
            body.label.visible = body === hovered;
            continue;
        }
        body.anchor.getWorldPosition(projected).project(camera);
        const x = (projected.x + 1) / 2 * rect.width;
        const y = (1 - projected.y) / 2 * rect.height - 16;
        const w = body.label.element.textContent.length * 6.6 + 22;
        const box = { x0: x - w / 2, x1: x + w / 2, y0: y - 9, y1: y + 9 };
        const clear = projected.z < 1 && !placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
        body.label.visible = clear || body === hovered;
        if (clear) placed.push(box);
    }
}

// --- animation ----------------------------------------------------------------------------------

let last = performance.now();
let frames = 0;
function animate(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!REDUCE && system) {
        for (const body of system.bodies) {
            body.spin.rotation.y += body.orbit.speed * dt;
            body.mesh.rotation.y += dt * 0.12;
            if (body.band.visible) body.band.material.map.offset.x += MARQUEE_SPEED * dt;
        }
        system.centre.group.rotation.y += dt * 0.03;
        system.centre.band.material.map.offset.x += MARQUEE_SPEED * dt;
    }
    stepFlight(now);
    controls.update();
    frames += 1;
    if (frames % 6 === 0) declutter();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    requestAnimationFrame(animate);
}

// --- start --------------------------------------------------------------------------------------

/** The walk in the address, always starting from Solana so the breadcrumbs lead home. */
function trailFromHash() {
    const stops = location.hash.slice(1).split('/').filter(Boolean).map(parseStop).filter(Boolean);
    if (!stops.length || !isSun(stops[0])) stops.unshift({ kind: 'filter', filters: [], without: [], groupBy: null });
    return stops;
}

async function start() {
    const response = await fetch('./universe-view/index.json');
    if (!response.ok) throw new Error(`universe-view/index.json: HTTP ${response.status} (run node stocks/build-universe-view.mjs --run)`);
    DATA = await response.json();
    IX = U.tableIndex(DATA);
    issuerBySlug = new Map(DATA.issuers.map((issuer) => [issuer.slug, issuer]));
    ruleLabels = new Map(Object.entries(DATA.ruleLabels ?? {}));
    for (const a of IX.attributes) attributeById.set(a.id, a);
    for (const d of U.readTable(DATA.tables.dimensions)) dimensionById.set(d.id, d);
    log(`${IX.tokens.length} tokens, ${IX.values.length} shared values, ${IX.attributes.length} attributes; reduceMotion=${REDUCE}`);
    requestAnimationFrame(animate);
    const stops = trailFromHash();
    trail = stops.slice(0, -1);
    await go(stops[stops.length - 1]);
    window.addEventListener('hashchange', () => {
        if (location.hash.slice(1) === trail.map(stopKey).join('/')) return;
        const next = trailFromHash();
        trail = next.slice(0, -1);
        go(next[next.length - 1]);
    });
}

start().catch((err) => {
    console.error(`[universe ${new Date().toISOString()}]`, err);
    els.kicker.textContent = 'Could not open';
    els.title.textContent = 'Universe';
    els.summary.textContent = String(err.message ?? err);
});
