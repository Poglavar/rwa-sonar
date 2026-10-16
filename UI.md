# UI reference

The bounded `sonar-animation.html` page uses `sonar-animation.css`. Its theme roles are `--color-canvas`, `--color-sonar`, and `--color-signal`; `.sonar-container`, `.sonar-ring`, `.sonar-center`, `.grid`, and `.status` define the animation. There is no runtime geometry. The page is a decorative public animation with a main landmark and status announcement; reduced-motion preferences stop animation.

The asset explorer uses `assets.css` for catalogue actions, logo wrappers, tickers and vocabulary layout, and `styles.css` for modal controls and the attestation diagram. Sort actions are native buttons with `aria-sort` on the column; asset names open dialogs from the keyboard. Dialogs retain labelled controls, Escape/Tab behavior and focus restoration. Light logo backing retains its original alpha and outline, separately from UI theme colors. Fixed validity-ring colors describe attestation status.

Runtime exceptions are narrow data encodings: circle positions (`--circle-left`, `--circle-top`), attestor colors (`--attestor-color`), SVG coordinates and expiry arc dash lengths. How-it-works category colors (`--category-color`), chart/SVG geometry and monitor/watch percentage widths remain data-derived. Static hit-target paint lives in `how-it-works.css`; animation styling remains in its separate animation stylesheet.

On narrow screens the asset dialog stacks the diagram above the lens controls and scrolls vertically. At 380px and below CSS scales the entire fixed-coordinate diagram to 80%; JavaScript coordinates and attestation data remain unchanged. Desktop layout retains the side-by-side presentation.
