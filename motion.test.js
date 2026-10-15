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

test('animated farm companions load the reduced-motion stylesheet', () => {
    for (const page of ['stocks.html', 'watch.html', 'economics.html', 'learn/index.html']) {
        const html = read(page);
        expect(html).toMatch(/<link rel="stylesheet" href="[./]*motion\.css\?v=/);
        expect(html).toMatch(/class="[^"]*joe-idle/);
        expect(html).not.toMatch(/images\/dolphin-detectives/);
    }
});

test('decorative weather is hidden from assistive technology; Joe has an image description', () => {
    const html = read('index.html');
    expect(html).toMatch(/class="farm-sun" aria-hidden="true"/);
    expect(html).toMatch(/class="farm-cloud cloud-one" aria-hidden="true"/);
    expect(html).toMatch(/joe-and-friends\.webp"[^>]+alt="Honest Joe[^"]+"/);
    expect(html).not.toContain('researchBackdropVideo');
    expect(html).not.toContain('swim-lane');
});
