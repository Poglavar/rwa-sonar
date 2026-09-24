// Decorative motion stays decorative: every animation sits behind prefers-reduced-motion (in every
// stylesheet that animates anything), each page with a dolphin companion or the night-watch scene
// loads motion.css, and the headlamp layer has one glow per painted beam.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (file) => readFileSync(join(__dirname, file), 'utf8');

/** CSS with every `@media (prefers-reduced-motion: no-preference) {…}` block and @keyframes removed. */
function outsideMotionGuard(css) {
    let out = css;
    for (const opener of ['@media (prefers-reduced-motion: no-preference)', '@keyframes']) {
        for (let at = out.indexOf(opener); at !== -1; at = out.indexOf(opener)) {
            let depth = 0;
            let i = out.indexOf('{', at);
            for (; i < out.length; i++) {
                if (out[i] === '{') depth++;
                else if (out[i] === '}' && --depth === 0) break;
            }
            out = out.slice(0, at) + out.slice(i + 1);
        }
    }
    return out;
}

test('no animation runs outside the reduced-motion guard', () => {
    for (const file of ['motion.css', 'app-shell.css', 'landing.css', 'whatif.css', 'stocks.css', 'watch.css', 'research-art.css']) {
        expect(outsideMotionGuard(read(file))).not.toMatch(/\banimation\s*:/);
    }
});

test('the guard helper really strips a guarded animation and keeps an unguarded one', () => {
    expect(outsideMotionGuard('@media (prefers-reduced-motion: no-preference) { a { animation: x 1s; } }')).not.toMatch(/animation/);
    expect(outsideMotionGuard('a { animation: x 1s; }')).toMatch(/animation/);
});

test('pages with a dolphin companion or the night-watch scene load motion.css', () => {
    for (const page of ['index.html', 'stocks.html', 'watch.html', 'economics.html', 'learn/index.html', 'pitch/index.html']) {
        const html = read(page);
        expect(html).toMatch(/<link rel="stylesheet" href="[./]*motion\.css\?v=/);
        expect(html).toMatch(/class="[^"]*(dolphin-bob|lamp-scene)/);
    }
});

test('the night-watch scene has one glow per painted headlamp beam', () => {
    for (const page of ['index.html', 'pitch/index.html']) {
        const glow = read(page).match(/<span class="lamp-glow" aria-hidden="true">(.*?)<\/span>/)[1];
        expect(glow.match(/<i><\/i>/g)).toHaveLength(5);
    }
    expect(read('motion.css').match(/\.lamp-glow i:nth-child\(\d\)/g)).toHaveLength(5);
});

/** The body of the first `@media (prefers-reduced-motion: no-preference) {…}` block in `css`. */
function insideMotionGuard(css) {
    const at = css.indexOf('@media (prefers-reduced-motion: no-preference)');
    let depth = 0;
    let i = css.indexOf('{', at);
    const start = i;
    for (; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}' && --depth === 0) break;
    }
    return css.slice(start + 1, i);
}

describe('swimming scout', () => {
    const css = read('motion.css');
    const guarded = insideMotionGuard(css);

    test('the landing lane is decorative: aria-hidden, the small scout cut-out, empty alt, inside the night-watch story', () => {
        const html = read('index.html');
        const story = html.slice(html.indexOf('<section id="below-the-surface"'), html.indexOf('</section>', html.indexOf('<section id="below-the-surface"')));
        expect(story).toContain('<div class="swim-lane" aria-hidden="true">');
        const imgs = story.match(/<img src="\.\/images\/dolphin-detectives\/scout-v1-384\.webp"[^>]*>/g);
        expect(imgs).toHaveLength(2);
        for (const img of imgs) expect(img).toContain('alt=""');
    });

    test('the lane only shows, and the swim only runs, when motion is allowed', () => {
        expect(outsideMotionGuard(css)).toMatch(/\.swim-lane \{ display: none; \}/);
        expect(guarded).toMatch(/:root \.swim-lane \{\s*display: block;/);
        expect(guarded).toMatch(/pointer-events: none/);
        for (const name of ['swim-lap', 'swim-face', 'swim-wave']) {
            expect(guarded).toContain(`@keyframes ${name}`);
            expect(css.split(`@keyframes ${name}`)).toHaveLength(2);
        }
        // The ?reduceMotion URL hook stops it too.
        expect(guarded).toMatch(/\.reduce-motion \.swim-lane \{ display: none; \}/);
        expect(guarded).toMatch(/\.reduce-motion \.dolphin-bob \{ animation: none; \}/);
    });

    test('the scout faces the way it travels, and turns only while resting off-screen', () => {
        const frames = (name) => guarded.slice(guarded.indexOf(`@keyframes ${name}`)).match(/\{([\s\S]*?\}\s*)+?\s*\}/)[0];
        const lap = frames('swim-lap');
        const face = frames('swim-face');
        // Rest windows: off the right edge 40-50%, off the left edge 90-100%.
        expect(lap).toMatch(/40%, 50% \{ transform: translateX\(calc\(100% \+ var\(--swim-w/);
        expect(lap).toMatch(/90% \{ transform: translateX\(0\)/);
        const flips = [...face.matchAll(/([\d.]+)%(?:, [\d.]+%)? \{ transform: scaleX\((-?1)\)/g)].map(([, at, dir]) => ({ at: Number(at), dir }));
        expect(flips).toEqual([{ at: 0, dir: '1' }, { at: 45, dir: '-1' }, { at: 95, dir: '1' }]);
        const resting = (p) => (p > 40 && p < 50) || (p > 90 && p <= 100);
        for (const { at } of flips.slice(1)) expect(resting(at)).toBe(true);
        // Both layers share the lap length and delay, so the turn stays in sync with the travel.
        expect(guarded).toMatch(/\.swim-path \{[^}]*animation: swim-lap var\(--swim-lap, 34s\)[^}]*animation-delay: var\(--swim-delay, 0s\)/);
        expect(guarded).toMatch(/\.swim-body img \{[^}]*animation: swim-face var\(--swim-lap, 34s\)[^}]*animation-delay: var\(--swim-delay, 0s\)/);
    });

    test('companions idle on three loops of unrelated length, so they never move in lockstep', () => {
        const rule = guarded.match(/\.dolphin-bob \{\s*animation: ([^;]+);/)[1];
        const seconds = [...rule.matchAll(/([\d.]+)s/g)].map(([, s]) => Number(s));
        expect(rule).toMatch(/dolphin-drift .*dolphin-tilt .*dolphin-roll /);
        expect(new Set(seconds).size).toBe(3);
        for (const name of ['dolphin-drift', 'dolphin-tilt', 'dolphin-roll']) expect(guarded).toContain(`@keyframes ${name}`);
    });
});
