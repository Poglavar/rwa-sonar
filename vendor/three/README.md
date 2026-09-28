# three.js, self-hosted

The universe view (`universe.html`, `universe.js`) runs on three.js. The site's Content-Security-Policy
(`deploy/nginx/rwasonar-headers.conf`) allows scripts from the site itself only, and no inline script, so
neither a CDN nor an import map would load on rwasonar.com. These files are served from the site instead.

- `0.186.1/three.module.js`, `0.186.1/three.core.js`: `build/` of the npm package three@0.186.1, unchanged.
- `0.186.1/addons/OrbitControls.js` (`examples/jsm/controls/`) and `0.186.1/addons/CSS2DRenderer.js`
  (`examples/jsm/renderers/`): unchanged except one line each, `} from 'three';` rewritten to
  `} from '../three.module.js';`, which is what the import map used to resolve.
- `0.186.1/LICENSE`: the package's MIT licence.

Fetched from https://cdn.jsdelivr.net/npm/three@0.186.1/ on 28 Sep 2026. To upgrade, add a new version
folder the same way and change the three import paths at the top of `universe.js`.
