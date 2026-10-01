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

Ethereum state reads use a finalized canonical block hash. Conventional ERC-1967 and legacy Zeppelin slot values, `owner()` and `paused()` responses are observations, not proofs of every intervention capability or multisig threshold. Solana mint extensions are read at a finalized slot; fee epochs and time-dependent multipliers require a slot-specific epoch/time. Missing metadata remains unknown.

`data/deployment-observations.json` and `.last-rwa-deployment-watch-stats*.json` are private, ignored runtime files. The release builder embeds their scoped observations in the public runtime. A clean checkout can build without observations and correctly reports zero monitors. A polling baseline produces no change events. Decoder revisions establish a new baseline; only fields observed on both comparable reads can produce public deltas. Events retain first-observed and block times without inventing an exact change time.

The hourly `rwa-watch-deployments` PM2 entry runs at :11 before the existing :17 release refresh. The matching inactive outcome-check specification is `monitor-registration.json`, for `alerts-server-telegram/bot-list.json`. Install and activate that check when deployment is explicitly authorized, and verify the running scheduler and the output on the production host. The local implementation and one-off reads do not activate production jobs.

Cross-asset source URLs are deduplicated with stock sources in the existing registry. Product, instrument, holder context, terms snapshot and source IDs remain in `foundIn`; research-only rows have no fabricated stock issuer. `stocks/watch-sources.mjs --run --product=usdc` narrows fetch scope. Changing our source attribution is not an external document-change event. Hash changes remain source-review signals until material legal meaning is established.

Missing offering memoranda, constitutional documents, custodian contracts and current class bindings are stated as evidence gaps. Sources with inaccessible operative text are not promoted to verified legal rights. The historical catalogue and evidence database remain available as historical lenses with derived expiry/source-status labels.
