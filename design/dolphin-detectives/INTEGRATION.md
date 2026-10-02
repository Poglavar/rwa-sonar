<!-- Asset provenance, delivery variants, and placement rules for the integrated research mascots. -->
# Dolphin detectives · integration v2

Created with the built-in image-generation tool on 22 September 2026, using the original iceberg and scout artwork as style references. PNG masters remain in `images/dolphin-detectives/`; WebP delivery copies preserve the compositions. No stock artwork, collector data or measured risk proportions appear in these illustrations.

## Placements

- Landing: night-watch scene after the real AAPL comparison, with links to source changes and methodology.
- Pitch: night-watch artwork on the existing cover; the deck remains eight slides.
- Methodology: daylight team survey beside the introduction, above and separate from live collector states.
- Learn: small scout beside the introduction.
- Changes: small patrol companion beside the introduction, with detailed monitoring mechanics in a disclosure.
- Analytics overview: small scout in the starting-point heading, outside data and warning panels.
- Fees & incentives: existing scout, now using a smaller delivery image.
- Design gallery: both new scenes, originals and placement links, clearly labelled as illustrative art.

## Delivery and accessibility

Landscape masters and full WebPs are 1536 × 1024. Each new scene has a 768 × 512 WebP for smaller screens. Scout and patrol have 384px / 256px delivery variants for small spots. Keep intrinsic image dimensions and responsive sizing to reserve layout space. Use meaningful alt text for the iceberg scenes and empty alt for decorative companions. Keep captions and all research copy in HTML, outside the images. Below-the-fold art uses lazy loading. No live-status icons, safety seals or illustrations behind evidence tables.

## Verification

The integration passed all 14 fast page-test suites (691 tests). Asset checks cover original dimensions, WebP signatures, byte budgets, local references and the retained eight-slide structure; the pitch caption also has a contrast regression check. Manual headed-browser review covered desktop and 320–390px phone layouts, light/dark presentation, full scene framing, and the monitoring disclosure. No browser automation test suite or collector refresh was run for this artwork pass.

## Night watch · exact prompt

```text
Use case: illustration-story.
Asset type: wide editorial night-watch illustration for RWA Sonar's website and HTML pitch.
Input images: image 1 is the existing iceberg illustration to reinterpret; image 2 is the dolphin character reference. Preserve their refined blue ink-and-gouache drawing style and the recognizable streamlined headlamp dolphin, but change the scene, scale, lighting and number of dolphins.
Primary request: pull the camera far back and turn the iceberg scene into an ocean-at-night expedition. Show the entire immense iceberg in a clear above/below-water cross section. Its small moonlit tip rises above a quiet waterline in the upper quarter; the much larger, faceted underwater structure descends into a deep dark navy ocean. FIVE small dolphin detectives investigate different submerged sections with practical headlamps. Light cones from the dolphins illuminate distinct patches and planes of the submerged ice; much of the structure remains in shadow.
Composition/framing: landscape 3:2. An environmental wide shot, with lots of ocean and a strong sense of scale. No close-up animal. All five dolphins are small relative to the iceberg: largest at most about 8% of image width, others 3–6%. Place them naturally at different depths and distances on both sides of the iceberg, two as very small distant/background silhouettes. Their full silhouettes and narrow lamp straps are visible. The light beams converge on different ice facets, never out of their tails. Entire iceberg comfortably inside frame.
Style/medium: sophisticated adult editorial illustration, delicate indigo outlines, crisp angular ice planes, layered gouache and fine paper grain. Match the existing art family, calm and curious, quietly charming rather than cute. Anatomically recognizable dolphins with natural fins and tiny eyes. No human limbs or clothing.
Lighting/mood: very dark ocean, midnight navy and desaturated cobalt; small pale moonlight on the above-water tip; five localized soft warm-white/ice-blue headlamp beams revealing underwater detail. Luminous ice where the beams land, restrained volumetric light, no neon lasers. Quiet, capable nighttime field research.
Color palette: ink navy #0b182d, deep ocean blue, cobalt #3154d8, ice white and a little warm ivory in the lamps. Full-bleed opaque dark background, no white margins.
Constraints: art only. No writing, labels, numbers, logos, diagrams, financial symbols, coins, treasure, badges, speech bubbles, big eyes, detective hats, scary animals or watermark. The iceberg is a metaphor, not a measured quantitative diagram. Keep the entire environment readable when reduced to a web illustration.
```

## Daylight survey · exact prompt

```text
Use case: illustration-story.
Asset type: wide daylight field-survey illustration for RWA Sonar's educational and research-methodology pages.
Input images: image 1 is the existing iceberg illustration to expand; image 2 is the character reference. Keep their precise indigo ink, soft gouache washes, angular blue-white ice, and natural headlamp dolphin design.
Primary request: pull back from the original view and show a TEAM of FOUR small dolphin detectives surveying a large iceberg in a calm pale-blue sea. Show the iceberg's small sunlit tip above the waterline and the much larger whole submerged structure. One dolphin inspects a facet at mid-depth with a small headlamp beam, a second investigates the lower ice, and two much smaller dolphins swim in the distant background. Every dolphin wears a simple practical headlamp. The scene should feel spacious and quietly collaborative, with the iceberg and ocean dominating rather than a close-up mascot.
Composition/framing: landscape 3:2 canvas; whole iceberg and all four dolphins visible, with generous space. Waterline near the upper quarter. Dolphins have complete natural silhouettes; the largest occupies at most about 9% of image width, distant ones 3–5%. Several different swimming angles and distances, never a row of repeated clones. Environmental view, no foreground close-up.
Style/medium: same refined adult editorial ink-and-gouache style as the references, subtle paper grain, spare contours, translucent mist-blue water and precise ice facets. Warm curiosity, tiny natural eyes, understated closed-mouth smiles, no childish exaggeration.
Color palette: ice white, pale sky and mist blue, soft cobalt #3154d8, indigo outlines and off-white #f7f5f0. Air above water and outer edges fade into off-white paper with no hard border. The headlamps have a subtle warm ivory glow even in daylight.
Constraints: art only, no embedded text, labels, numbers, badges, brands, charts, financial objects, treasure, hats, human limbs or watermark. All fins remain fins. Preserve the existing art-family identity. The iceberg is a metaphor, not a quantitative diagram.
```

## Motion (added 23 September 2026)

`motion.css` adds three decorative motions, all behind `prefers-reduced-motion: no-preference` (enforced by `motion.test.js`):

- The small companions (stocks scout, learn scout, watch patrol, economics scout) carry `.dolphin-bob`: a 5px float with a 1.6° tilt on a 6.5s loop.
- The night-watch scene (landing, pitch) wraps the painting in `.lamp-scene` with five `.lamp-glow` pools placed where the painted beams land, breathing out of step on a 7s loop. The painting itself is unchanged.
- The sonar logo sweeps once on load and its contact blips: the SVG wedge in `motion.css`, the CSS `.app-brand-mark` (via a registered `--sonar-sweep` angle) in `app-shell.css`.

Motion never touches data, evidence or warnings, and nothing but the logo moves on load.
