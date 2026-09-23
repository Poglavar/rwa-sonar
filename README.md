# RWA Sonar — tokenized stocks on Solana, explained

> **Don't trust the ticker. Inspect the token.**

Live product: [rwasonar.com](https://rwasonar.com/) · X: [@RWASonar](https://x.com/RWASonar)

RWA Sonar is a public transparency and analytics layer for tokenized real-world assets. Its
current focus is Solana stocks: identify the exact token, explain what its holder actually owns,
show who can intervene on-chain and off-chain, verify where it can really be used, and keep watching
for changes. The product borrows the most useful idea from L2BEAT—make trust assumptions and the gap
between claims and observable reality legible—but applies it to assets whose risks also run through
issuers, custodians, transfer agents, legal documents and courts.

**Try it:** [the stock workspace](https://rwasonar.com/stocks.html) ·
[a shareable token report (NVDAx)](https://rwasonar.com/cards/NVDAx.html) ·
[the what-if matrix](https://rwasonar.com/whatif.html) · [the pitch](https://rwasonar.com/pitch/)

## The problem, in one example

Two tokens can both say "AAPL" and give their holders very different things. Ask one question of two
issuers — *what happens if my keys are stolen?* — and the documents answer differently:

- **xStocks (Backed):** nothing comes back as of right. Under the prospectus neither the network nor
  the issuer can restore a lost key; the only replacement route is a Swiss court cancellation which
  the issuer itself calls "very challenging to achieve".
- **Superstate Opening Bell:** stolen tokens are reconstituted — burned and reissued to a verified
  wallet — and a thief's wallet cannot receive the shares at all, because every account starts frozen
  until allowlisted.

Every answer on the site links to the exact words it rests on, with the source, locator, date read
and an archived copy.

## What it does

For each exact Solana token address, RWA Sonar answers five questions — **what you own, who can
intervene, where you can use it, how you exit, and what you must keep trusting** — and keeps
watching for changes:

- **Identity and structure:** about 1,300 exact token addresses across 12 issuer programmes (nine
  with live tokens; Remora and Ventuals are defunct, Republic has no mint yet), each with a
  shareable report and a legal-and-control template.
- **Control:** live Token-2022 authorities and extensions — freeze, pause, permanent delegate,
  allowlist, transfer fees, rebasing multipliers — attributed to the key, multisig or program that
  actually holds them.
- **What if:** a trust chain of 13 actors and nine rights flows, and 38 failure scenarios answered
  for every issuer from its own documents. Each answer is *documented*, *inferred* (the reasoning is
  shown), *litigated* (with the decision) or *unknown* (with where we looked). Nothing is invented.
- **Use and exit:** exact-token DeFi support, separating a source listing from observed accounts,
  decoded market configuration and simulation; redemption separating the legal right, eligibility,
  the current official route and any observed completion.
- **Watching:** an hourly on-chain control watcher, a daily watcher over 500+ cited documents that
  checks every quoted claim verbatim and archives each version to the Wayback Machine, a daily
  on-chain redemption observer, a decoded trade tape, and a public journal of material external
  changes.

Coverage is a dated observation of a changing system, not a claim of exhaustive coverage; the
[methodology](https://rwasonar.com/methodology.html) lists the evidence rules and known blind spots.

### Why Solana

Solana's Token-2022 puts the issuer's powers on-chain: who can freeze, claw back, pause, rebase or
charge a fee is readable from the mint account. RWA Sonar reads those powers for every tokenized
stock on Solana, follows them to the key or multisig that holds them, and sets them beside what the
legal documents promise — the gap between the two is where holder risk lives.

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
| [`/watch.html`](https://rwasonar.com/watch.html) | Focused exact-token, issuer and protocol-market watches; source-backed external changes with actor, affected holders, consequence and evidence, ranked by likely holder impact separately from watcher severity |
| [`/whatif.html`](https://rwasonar.com/whatif.html) | A 38-scenario matrix: what happens if an actor, key, custodian, issuer or protocol fails? |
| [`/templates/`](https://rwasonar.com/templates/) | Reusable legal + control-recipe dossiers with ownership paths and source-backed conclusions |
| [`/graph.html`](https://rwasonar.com/graph.html) | The parties and rights flows behind each issuer programme |
| [`/live.html`](https://rwasonar.com/live.html) | Decoded Solana DEX trades (collected hourly on the server, served by our API) plus paginated historical trade data |
| [`/learn/`](https://rwasonar.com/learn/) | Plain-language guides to ownership, insolvency, redemption, issuer powers, oracles and DeFi custody |
| [`/methodology.html`](https://rwasonar.com/methodology.html) | Evidence precedence, collector freshness, health definitions and known blind spots |
| [`/review.html`](https://rwasonar.com/review.html) | The prioritized evidence gaps and unresolved external changes still needing human review |
| [`/pitch/`](https://rwasonar.com/pitch/) | A short, web-native presentation of the problem, product, differentiation, current execution and vision |

The public JSON API supports search, facets, paginated token and trade views, per-token history,
issuers, claims, source changes, failure scenarios and saved comparison watches. See
[`api/README.md`](api/README.md) for routes and examples.

## How it stays current

- The public build refreshes every **6 hours**; generated pages and public JSON outputs are rebuilt
  in dependency order, while each source category keeps its own last-successful timestamp.
- The trade collector samples the busiest pools **hourly** on the server; `live.html` reads only our API, never a Solana RPC.
- Token authorities, extensions, scheduled rebases and labelled wallets are checked **hourly**.
- Cited legal and operational sources are checked **daily**. When a page refuses a script, the
  watcher reads the publisher's own API for that page or its newest Wayback capture, and the record
  says which. An archive.today copy is linked, never read.
- Redemptions are observed on-chain **daily** (Ondo GM burns, xStocks deposit→payout, Superstate
  conversions). The scan is checkpointed, and a failed or partial one is never reported as "no
  redemptions".
- Changed documents get a **daily** model assessment (at most 10 per day, costed per item). It is
  shown beside the diff and never decides what is included.
- CoinGecko CEX-market enrichment runs only **once daily**, capped at 250 ticker calls—about 7,530
  calls in a 30-day month—while keyless DEX data can refresh every six hours.
- Material external changes are rolled into one **morning digest** instead of generating alert spam.

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

Built for the Stocklana hackathon on the
[`colosseum-worlds-fair`](https://github.com/Poglavar/rwa-sonar/tree/colosseum-worlds-fair) branch.
Before the hackathon the project was a broader RWA catalogue; during Stocklana it became the
stock-first Solana product described here: exact-token discovery, issuer dossiers, same-stock
comparison, shareable reports, the what-if matrix, confirmed DeFi support, watchers and the pitch.
Updates: [@RWASonar on X](https://x.com/RWASonar).

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
