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
