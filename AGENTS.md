Unless overriden here, follow instructions from /Users/simun/Code/AGENTS.md

## Cursor Cloud specific instructions

### Project overview

RWA Sonar is a static website (vanilla HTML + CSS + JS) with no build system, no package manager, and no external dependencies. All data is stored in flat JSON files loaded via `fetch()` at runtime.

### Running the dev server

Serve the project root with any static HTTP server. The site uses `fetch()` for JSON data so the `file://` protocol will not work.

```bash
python3 -m http.server 8080 --directory /workspace
```

Then open `http://localhost:8080` in a browser.

### Key files

- `index.html` — entry point, contains all inline JS logic for the assets table
- `asset-modal.js` — asset card modal with attestation circles
- `styles.css` — modal and attestation circle styles
- `rwa-assets-db.json` — asset catalog (the "database")
- `attestations-db.json`, `attestation-types.json`, `recipes-db.json` — attestation data

### Notes

- There is no linter, test suite, or build step configured in this repository.
- Deployment is via `deploy-to-server.sh` (rsync over SSH) — not relevant for local development.
- External images (asset logos, blockchain icons) load from CDNs; they may not render in offline/restricted environments but core functionality still works.
