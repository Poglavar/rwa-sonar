<!-- How the RWA Sonar explainer shorts are made: script → ElevenLabs narration → SVG stage posed per frame → MP4. -->
# Explainer shorts

Short vertical (1080×1920) cartoon explainers of RWA Sonar, made to post on X. Everything is code, so a changed line is a re-render, not a re-shoot. Adapted from the Show & Tell shorts pipeline.

All issuers and protocols in the shorts are **fictional**: issuers Oakmere, Northgate and Redcliff; protocols Lanternfish Lend (lending market), Saltmarsh Vaults (yield vault) and Brinepool (LP pool). Tokens are shown as `AAPL · Oakmere`, never as a branded symbol. `content.test.mjs` fails if a real issuer or protocol name, or a symbol like `AAPLx`, gets into a script or scene.

| File | Role |
| --- | --- |
| `shorts/<id>.json` | The script: voice, one narration line per scene, and `captionReplace` (spoken form → written form in captions). |
| `voice.mjs` | ElevenLabs narration per scene with character timestamps, cached by content hash. Dry run by default. Every billed request goes into `out/voice-costs.json`. |
| `stage.html`, `stage.css`, `stage-kit.js`, `stage-load.js` | The cast (John, the dolphin guide) and stylised site panels as one SVG. `renderAt(t)` poses everything for time `t`. |
| `scenes/<id>.js` | One short's scenes. `c.cue(scene, n)` syncs a visual to the n-th spoken sentence. |
| `render.mjs` | Scene lengths come from the audio and captions from the timestamps. Frames from headless Chrome are piped into ffmpeg. |

```bash
cd video && npm install                                  # Playwright only; uses the system Chrome (channel 'chrome')
node video/voice.mjs video/shorts/john-buys.json          # shows what would be billed
node video/voice.mjs video/shorts/john-buys.json --apply  # generates narration (needs ELEVENLABS_API_KEY in video/.env)
node video/render.mjs video/shorts/john-buys.json --stills             # contact sheet out/john-buys-stills.png
node video/render.mjs video/shorts/john-buys.json --stills --estimate  # same, before narration exists (16 chars/s)
node video/render.mjs video/shorts/john-buys.json         # out/john-buys.mp4 (add --width 540 for a fast draft)
node --test video/render.test.mjs video/content.test.mjs
```

The five shorts are `john-buys`, `john-yield`, `john-cant-sleep`, `the-catch` and `the-weekend`. `video/.env`, `cache/`, `out/` and `node_modules/` are gitignored. The dolphin art comes from `../images/dolphin-detectives/`.
