<!-- Operational reference for the shared RWA research model, builders and scoped deployment watcher. -->
# Shared RWA research

`data/research.json` contains curated public-source product reviews. `lib/stock-research.mjs` adapts stock dossiers as programme subjects, retaining original evidence dates and unresolved instrument bindings. `lib/research.js` validates scope and resolves findings without inheriting programme conclusions into individual tokens.

Build the report runtime and catalogue from retained inputs:

```sh
npm run rwa:build
node stocks/extract-sources.mjs --run
```

`rwa-research.json` is generated and published with the other release artifacts. Its build timestamp is not a legal-review, identity-check or chain-observation timestamp. Counts distinguish product reviews, programme dossiers, instrument research subjects, exposure families, indexed deployments, source-dated deployment identities, configured read scopes and recent successful observations. They do not aggregate reserve value or imply that every research subject has fully verified legal terms.

Read-only deployment polling:

```sh
npm run rwa:watch-deployments
node --env-file-if-exists=.env rwa/watch-deployments.mjs --run --only=usdc
npm run rwa:build
node stocks/build-change-journal.mjs --run
```

The watcher reads officially identified Ethereum and Solana addresses. `ETHEREUM_RPC_URL` and `SOLANA_RPC_URL` optionally select providers; defaults are public RPC services. It never signs transactions or sends notifications. Unsupported ABI/extension fields stay unknown. Failed required reads produce a nonzero exit, retain the last successful observation and mark the latest attempt failed. Completion statistics are written only after the requested scope finishes; product-specific runs use separate statistics files.

Ethereum state reads use a finalized canonical block hash. Conventional ERC-1967 and legacy Zeppelin slot values, `owner()`, `authority()` and `paused()` responses are observations, not proofs of every intervention capability or multisig threshold. Solana mint extensions are read at a finalized slot; fee epochs and time-dependent multipliers require a slot-specific epoch/time. Missing metadata remains unknown.

`data/deployment-observations.json` and `.last-rwa-deployment-watch-stats*.json` are private, ignored runtime files. The release builder embeds their scoped observations in the public runtime. A clean checkout can build without observations and correctly reports zero monitors. A polling baseline produces no change events. Decoder revisions establish a new baseline; only fields observed on both comparable reads can produce public deltas. Events retain first-observed and block times without inventing an exact change time.

The hourly `rwa-watch-deployments` PM2 entry runs at :11 before the existing :17 release refresh. The matching inactive outcome-check specifications are in `monitor-registration.json`, for `alerts-server-telegram/bot-list.json`. Install and activate that check when deployment is explicitly authorized, and verify the running scheduler and the output on the production host. The local implementation and one-off reads do not activate production jobs.

Cross-asset source URLs are deduplicated with stock sources in the existing registry. Product, instrument, holder context, terms snapshot and source IDs remain in `foundIn`; research-only rows have no fabricated stock issuer. `stocks/watch-sources.mjs --run --product=usdc` narrows fetch scope. Changing our source attribution is not an external document-change event. Hash changes remain source-review signals until material legal meaning is established.

Missing offering memoranda, constitutional documents, custodian contracts and current class bindings are stated as evidence gaps. Sources with inaccessible operative text are not promoted to verified legal rights. The historical catalogue and evidence database remain available as historical lenses with derived expiry/source-status labels.

## Visual experience

`npm run rwa:build` also produces `rwa-structure-map.json`, the compact navigation artifact. `lib/structure-map.js` shapes typed programme/structure/recipe/terms membership, deduplicates addresses with network-specific semantics and resolves selection without inferring legal bindings. The release manifest builds it after research and catalogue; release validation compares it with those retained inputs.

`lib/visual-profile.js` resolves five features through the existing scoped claim model. Presentation annotations live on native claims or in stock dossier `visualFindings`, with stable finding IDs, labels, rationale and a serialized signature of the underlying claim and referenced sources. Review and replace an annotation deliberately when evidence changes; do not automatically regenerate its signature to bless changed text. Unsupported, historical and conflicting findings remain qualified. Issuer colors identify programmes; finding colors evaluate particular assertions.

`lib/failure-scenario.js` resolves hypothetical outcomes only in their stated context and terms. Canonical `scenarios` carry mode, context/terms IDs, status, outcome, source IDs, original check date and separate claim/custody/exit route states. The stock adapter retains custody-insolvency answers and named party caveats from dossiers. Programme scenarios never bind unverified exact deployments, and issuer outage is distinct from insolvency.

The page controllers render these models with local SVG icons. Map animations are enabled by default, respect system reduction and `?reduceMotion`, and give static mode the same final semantic state. Bounded animation never supplies evidence or indicates live asset flows.

Caution and problem annotations require a nonempty `note` that explains the restriction, dependency or demonstrated issue in the card itself. A source merely describing a feature is not an adverse finding. Unreviewed offering terms, unchecked holdings and unresolved record priority use a specific evidence-gap label; the gap is a limit of this review rather than proof that a protection is absent.

## Cross-asset research and staged monitors (October 2026)

All 21 original products now have a source-scoped dependency and recourse review. New substantive reviews include the Spiko prospectus, August USDC examination, TER physical verification and September inventory, both linked TBILL agreements, WisdomTree dealing FAQ, current USTB documentation and USDhl bridge workflow. Accessible announcements remain distinct from operative offering documents. Missing private memoranda, custody agreements, class binding and governance keep their explicit gaps; this pass does not claim equal completeness across products.

`data/monitor-plan.json` lists every product's document sources, exact identified deployments, prepared observer and remaining research gaps. All entries are inactive. Ethereum and Solana readers cover 17 identified deployments. Other networks and unverified addresses remain explicit omissions, and conventional root-authority checks do not establish multisig signers or threshold governance.

Prepared local commands:

```sh
npm run rwa:watch-sources
npm run rwa:watch-deployments
npm run rwa:watch-fund-data
```

The first reuses the stock source watcher with `--rwa --no-db`: normalized text hashes, PDF extraction, source attribution, change review signals and failed-read reporting. It covers the original products without overwriting the full stock heartbeat. Blocked pages, empty shells, gated terms and inaccessible reports stay unresolved. Do not add `--archive` unless external archive submissions are authorized.

The fund-data watcher reads the official Superstate USTB registry and the USTBL Chainlink NAV feed identified by Spiko. It preserves null prices and unknown source periods. Configuration timestamps never become holdings dates. Oracle reads share one finalized block; invalid rounds fail and evidence older than seven days degrades the verdict. Neither feed verifies reserves or guarantees liquidity. Routine NAV/supply changes are observations; identity and deployment changes create review events.

Each job writes separate ignored runtime state and completion statistics. For the cross-asset document scope, blocked, gone, unreadable and reachable-but-unverified sources degrade completion instead of passing on reachability alone. Failed attempts preserve the last successful observation; an initial baseline creates no material change events. `monitor-registration.json` contains inactive outcome-check templates with expected output counts, zero-failure limits and source freshness checks. These are preparation artifacts, not installed external registrations. Production machine settings, installation, schedule activation and notifications remain deferred until deployment is authorized.

## Guided shared reports

`lib/report-view.js` is the pure presentation model used by `report.html`. Overview links to Ownership, Backing, Controls, Exit and Failure; all seven research dimensions remain available within those five topics. Sources groups documents by URL while retaining every citation, locator, quotation and review date. Evidence opens in a desktop drawer or mobile sheet. `research-page.js` keeps the holder and deployment selectors alive when topics change.

The stock adapter retains programme corporate-action, voting, dividend and authority details plus the complete researched scenario catalogue in `reportDetails`. Those details, custody actors, evidence profiles and exit terms are suppressed when an exact address is not bound to the reviewed instrument. Token observations remain available under Controls. The report does not convert a programme finding into token-specific rights.

Headless presentation and scope checks: `NODE_OPTIONS=--experimental-vm-modules npx jest stocks/rwa-report-view.test.js --runInBand`.

## Narrated story prototype

Backpack's programme report has a `#story` topic and a Watch the story entry on Overview. `lib/token-story.js` verifies the authored script against the seven finding/source signatures and the three retained failure cases, then provides the pure playback and scene state. `token-story-ui.js` binds local recorded audio, scrubbing, chapter controls and the report evidence drawer. Leaving the topic stops the audio. An unbound exact token cannot inherit this story.

`data/stories/backpack.json` contains the approved narration, evidence bindings, audio durations and generation metadata. `media/stories/backpack/` contains nine ElevenLabs recordings, using George and `eleven_multilingual_v2`. To regenerate, configure `ELEVENLABS_API_KEY` in a private environment and run `node --env-file=.env rwa/record-story.mjs --run`. The command checkpoints each completed clip and skips verified matching recordings on resume. No credential is delivered to the browser. API reference: https://elevenlabs.io/docs/api-reference/text-to-speech/convert.

Headless scope and playback checks: `NODE_OPTIONS=--experimental-vm-modules npx jest stocks/rwa-token-story.test.js --runInBand`.
