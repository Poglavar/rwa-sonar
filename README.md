# RWA Sonar — tokenized stocks on Solana, explained

> **Don't trust the ticker. Inspect the token.**

Live product: [rwasonar.com](https://rwasonar.com/) · X: [@RWASonar](https://x.com/RWASonar)

RWA Sonar is a public transparency and analytics layer for tokenized real-world assets. Its
current focus is Solana stocks: identify the exact token, explain what its holder actually owns,
show who can intervene on-chain and off-chain, verify where it can really be used, and keep watching
for changes. The product borrows the most useful idea from L2BEAT—make trust assumptions and the gap
between claims and observable reality legible—but applies it to assets whose risks also run through
issuers, custodians, transfer agents, legal documents and courts.

## Current scope

The repository snapshot rebuilt on 22 September 2026 from retained source inputs contains the
following. These are local build figures, not a claim that this uncommitted revision is deployed
or that rebuilding re-observed the sources:

- **1,183** exact, issuer-attributed and chain-observed Solana token addresses across **12
  issuer programmes**, each with a static shareable card;
- **9 legal + technology templates** covering all 1,183 tokens, so common conclusions are inherited
  only by an exact issuer-programme and observed control-recipe match;
- **11 health checks** kept separate across market, control, legal/evidence and DeFi-composability
  dimensions—missing data remains unknown and never becomes a pass;
- **125 assets with source-listed or market-observed DeFi support** across **162 exact-token integrations**, including
  27 assets with a lending/collateral use in the 19 September 2026 composability snapshot, plus
  explicit checked zeroes where a protocol supports no stock tokens. Listing/account observations,
  decoded configuration and simulated execution are separate proof stages; the current records
  do not establish that configuration decoding or execution simulation was performed;
- **38 failure scenarios** per issuer, covering loss, hacks, insolvency, control-key failures,
  corporate actions, redemption and the practical ability of a lender to enforce against collateral;
- daily catalogue, holder and volume history, an accumulating trade API, an hourly control watcher,
  a daily evidence watcher, a public external-change journal and a prioritized research queue.

These are observations of a changing system, not claims of exhaustive market coverage. A newly
catalogued address is not necessarily newly issued, a token account is not a person, and minted
supply is not automatically circulating supply.

The local continuation after release `346adf6` adds a first **fees and incentives** view at
`economics.html`: three initially researched programmes, with nine others explicitly pending.
It separates holder costs, issuer revenue, taxes, contractual caps and actor incentive analysis;
it is not a complete quote engine. Sources retain their original observation/review dates.
The accompanying dolphin-detective artwork and placement proposals are at
`design/dolphin-detectives/`; these do not change the existing eight-slide pitch.

For Stocklana reviewers: the hackathon work is on the
[`colosseum-worlds-fair`](https://github.com/Poglavar/rwa-sonar/tree/colosseum-worlds-fair)
branch. The submission package is aimed first at the Stocklana main track, whose official deadline
is 25 September 2026 at 4:00pm ET; Colosseum Crypto World's Fair is a separate follow-on opportunity.
The code license choice remains pending owner confirmation; do not claim a specific open-source
license until that is authorized. Third-party issuer documents, APIs and market data remain owned by
their respective providers.

## Why this is different

[RWA.xyz](https://rwa.xyz/) is a broad, cross-chain directory and market-data platform.
[DefiLlama's RWA dashboard](https://defillama.com/rwa) is especially strong at AUM, flows, DeFi TVL,
utilization and rankings. RWA Sonar complements those products by going much deeper on one hard
question: **what has to remain true for this particular token to behave like the stock exposure its
ticker suggests?**

That means RWA Sonar does not stop at price or market cap. It joins the exact Solana address to:

- the legal claim and governing documents;
- the issuer, custodian, transfer agent, security agent and other dependencies;
- live Token-2022 authorities and extensions, including pause, freeze, clawback, allowlist, fees and
  rebasing;
- observed holders, markets, reference prices, spreads and decoded DEX trades;
- confirmed, exact-address protocol support and the terms under which collateral can be liquidated;
- claim-versus-reality discrepancies, source changes and on-chain changes, all with evidence.

The inspiration is [L2BEAT](https://l2beat.com/faq): usage metrics matter, but trust assumptions,
control paths and failure modes deserve first-class treatment. For RWAs, that analysis cannot end at
the smart contract. RWA Sonar follows the chain from the underlying company and custodian through
the legal wrapper and token issuer to the holder and any DeFi protocol that takes custody.

## Product surfaces

The public experience is deliberately progressive: start with the underlying stock, understand
one wrapper or compare two, three or many, read the plain-language answer, then open the reasoning, cited evidence and
raw technical data only when needed. The stable product navigation is **Explore · Compare · Changes
· Learn**; collector and research operations remain available as advanced transparency surfaces.

| Page | What it answers |
|---|---|
| [`/`](https://rwasonar.com/) | What changed, how the catalogue is growing, and why the legal/control layer matters |
| [`/stocks.html`](https://rwasonar.com/stocks.html) | A task-led stock workspace with grouped explanatory search, a private personal briefing, wrapper comparisons, scoped evidence provenance, claims-versus-reality conflicts, confirmed DeFi use and shareable token-table views |
| [`/cards/NVDAx.html`](https://rwasonar.com/cards/NVDAx.html) | One shareable, JavaScript-optional report that starts with ownership, intervention, exit, confirmed DeFi use and the largest unresolved risk |
| [`/issuers/xstocks-backed.html`](https://rwasonar.com/issuers/xstocks-backed.html) | One canonical programme dossier: plain-English claim, redemption, controls, discrepancies, evidence context and exact assets |
| `/protocols/` | Exact-token protocol dossiers separating source listing, account observations, configuration decoding and read-only simulation, with return links to the token and issuer |
| [`/monitor.html`](https://rwasonar.com/monitor.html) | Paginated token health, four independent dimensions, snapshot changes and protocol changes |
| [`/watch.html`](https://rwasonar.com/watch.html) | Watched sources and source-backed external changes, ranked by likely holder impact separately from watcher severity |
| [`/whatif.html`](https://rwasonar.com/whatif.html) | A 38-scenario matrix: what happens if an actor, key, custodian, issuer or protocol fails? |
| [`/templates/`](https://rwasonar.com/templates/) | Reusable legal + control-recipe dossiers with ownership paths and source-backed conclusions |
| [`/graph.html`](https://rwasonar.com/graph.html) | The parties and rights flows behind each issuer programme |
| [`/live.html`](https://rwasonar.com/live.html) | Decoded Solana DEX trades plus paginated historical trade data |
| [`/learn/`](https://rwasonar.com/learn/) | Plain-language guides to ownership, insolvency, redemption, issuer powers, oracles and DeFi custody |
| [`/methodology.html`](https://rwasonar.com/methodology.html) | Evidence precedence, collector freshness, health definitions and known blind spots |
| [`/review.html`](https://rwasonar.com/review.html) | The prioritized evidence gaps and unresolved external changes still needing human review |
| [`/pitch/`](https://rwasonar.com/pitch/) | A short, web-native presentation of the problem, product, differentiation, current execution and vision |

The public JSON API supports search, facets, paginated token and trade views, per-token history,
issuers, claims, source changes, failure scenarios and saved comparison watches. See
[`api/README.md`](api/README.md) for routes and examples.

The current local refinement loads the compact catalogue plus only the selected underlying's
`comparisons/` bundle. All its wrappers are selected initially; selection and requirements can be
changed explicitly. A one-wrapper selection remains a useful report. Supporting questions, the
full research matrix and history open on demand. Product-specific redemption examples never
silently become another token's terms, and reviewed inference remains distinct from a confirmed fact.

## How it stays current

- The public build refreshes every **6 hours**; generated pages and public JSON outputs are rebuilt
  in dependency order, while each source category keeps its own last-successful timestamp.
- The live trade collector samples the busiest pools every **3 hours**.
- Token authorities, extensions, scheduled rebases and labelled wallets are checked **hourly**.
- Cited legal and operational sources are checked **daily**.
- CoinGecko CEX-market enrichment runs only **once daily**, capped at 250 ticker calls—about 7,530
  calls in a 30-day month—while keyless DEX data can refresh every six hours.
- Material external changes are rolled into one **morning digest** instead of generating alert spam.

Deploy and recurring refresh share a generated-artifact manifest and validation gate, including
protocol dossiers and comparison bundles. `release-evidence.json` records local candidate hashes,
code identity, validation time and separate source dates; it is not proof of public availability.
Publication stages every required artifact before replacement and rolls back on failure. Each
artifact-family rename is atomic, but the whole release is not a single atomic switch.

Automation detects and records change; it does not silently invent a legal conclusion. Internal
research corrections are not public history: the public product shows the best current analysis.
Real changes by an issuer, venue, protocol or on-chain authority remain dated, visible and sourced.

## Run locally

```bash
npm install
npm install --prefix api
npm start
```

Open the URL printed by the server. `npm start` launches the static site and the API on loopback,
then prints separate static/API readiness lines. If `DATABASE_URL` is not present or the database
is unreachable, the static site still starts and the API-backed panels show their unavailable state.

For a static-only preview:

```bash
npm run serve
```

Local pages normally discover the API on port 3300. For a deterministic preview, especially when
the static site uses a different hostname or port, open it with an explicit API origin:

```text
http://127.0.0.1:8113/stocks.html?api=http://127.0.0.1:3300
```

`npm test` runs the fast headless stock, API and page suites without the previous duplicate
`stocks-page` execution. Data collectors are explicit `--run` jobs; see
[`stocks/README.md`](stocks/README.md) before refreshing any external source.

## Hackathon package

This branch is the reviewed Stocklana submission branch:
<https://github.com/Poglavar/rwa-sonar/tree/colosseum-worlds-fair>. The live submission should use
that branch or a pinned release rather than the repository default branch.

Project updates and public research notes: [@RWASonar on X](https://x.com/RWASonar).

Before the hackathon, the project had the broader RWA Sonar shell and earlier RWA catalogue work.
During this Stocklana build, the stock-first Solana workflow was expanded into exact-token discovery,
issuer dossiers, same-stock comparison, shareable asset reports, confirmed DeFi support, public
watch/review surfaces, generated issuer/template pages and the proof-led pitch. The repository
contains third-party public documents and market/API observations used as evidence; any code license
does not grant new rights in those external materials.

## License

The code license choice remains pending owner confirmation. Do not claim a specific open-source
license until that is authorized. Third-party source documents, issuer marks, APIs and market data
remain under their own terms.

## Repository map

- [`SUBMISSION.md`](SUBMISSION.md) — submission-ready short and long descriptions, differentiation
  and demo flow.
- [`UX-audit1.md`](UX-audit1.md) — the first full UX audit, implementation status and remaining
  validation work.
- [`TODO.md`](TODO.md) — the current product and research backlog.
- [`next-steps.md`](next-steps.md) — the ordered product, UX and research roadmap following the
  September 2026 refinement.
- [`stocks/README.md`](stocks/README.md) — collection/build pipeline, outputs and operational rules.
- [`stocks/MODEL.md`](stocks/MODEL.md) — the legal/technical grading model and its limits.
- [`stocks/EVIDENCE.md`](stocks/EVIDENCE.md) — claims, source watching, change detection and review.
- [`stocks/findings.md`](stocks/findings.md) — dated research notes and primary-source findings.
- `ecosystem.config.cjs`, `stocks/refresh-on-server.sh`, `deploy-to-server.sh` — production refresh
  and publication.

RWA Sonar is research, not investment or legal advice. Every conclusion should be independently
verified before relying on it.
