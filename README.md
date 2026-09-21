# RWA Sonar — tokenized stocks on Solana, explained

> **Don't trust the ticker. Inspect the token.**

RWA Sonar is an open-source transparency and analytics layer for tokenized real-world assets. Its
current focus is Solana stocks: identify the exact token, explain what its holder actually owns,
show who can intervene on-chain and off-chain, verify where it can really be used, and keep watching
for changes. The product borrows the most useful idea from L2BEAT—make trust assumptions and the gap
between claims and observable reality legible—but applies it to assets whose risks also run through
issuers, custodians, transfer agents, legal documents and courts.

## Current scope

As reviewed on 21 September 2026, the current published data snapshot (built 20 September) contains:

- **1,183** exact, issuer-attributed and chain-observed Solana token addresses across **9 active
  issuer programmes**, each with a static shareable card;
- **9 legal + technology templates** covering all 1,183 tokens, so common conclusions are inherited
  only by an exact issuer-programme and observed control-recipe match;
- **11 health checks** kept separate across market, control, legal/evidence and DeFi-composability
  dimensions—missing data remains unknown and never becomes a pass;
- **125 assets with confirmed current DeFi use** across **162 exact-token integrations**, including
  27 assets with a lending/collateral use, plus explicit checked zeroes where a protocol supports no
  stock tokens;
- **38 failure scenarios** per issuer, covering loss, hacks, insolvency, control-key failures,
  corporate actions, redemption and the practical ability of a lender to enforce against collateral;
- daily catalogue, holder and volume history, an accumulating trade API, an hourly control watcher,
  a daily evidence watcher, a public external-change journal and a prioritized research queue.

These are observations of a changing system, not claims of exhaustive market coverage. A newly
catalogued address is not necessarily newly issued, a token account is not a person, and minted
supply is not automatically circulating supply.

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

The public experience is deliberately progressive: start with the underlying stock, choose or
compare its wrappers, read the plain-language answer, then open the reasoning, cited evidence and
raw technical data only when needed. The stable product navigation is **Explore · Compare · Changes
· Learn**; collector and research operations remain available as advanced transparency surfaces.

| Page | What it answers |
|---|---|
| [`/`](https://rwasonar.com/) | What changed, how the catalogue is growing, and why the legal/control layer matters |
| [`/stocks.html`](https://rwasonar.com/stocks.html) | Explore underlying companies and funds first, open their exact wrappers, or compare two versions of the same stock |
| [`/cards/NVDAx.html`](https://rwasonar.com/cards/NVDAx.html) | One shareable, JavaScript-optional report organized as answer → reasoning → evidence → technical data |
| [`/monitor.html`](https://rwasonar.com/monitor.html) | Paginated token health, four independent dimensions, snapshot changes and protocol changes |
| [`/watch.html`](https://rwasonar.com/watch.html) | Watched sources, external change events, evidence freshness and individual claims |
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

## How it stays current

- The public build refreshes every **6 hours**; exact issuer registries, chain state, reference
  prices, holders, DEX markets, DeFi registries and generated pages are rebuilt in dependency order.
- The live trade collector samples the busiest pools every **3 hours**.
- Token authorities, extensions, scheduled rebases and labelled wallets are checked **hourly**.
- Cited legal and operational sources are checked **daily**.
- CoinGecko CEX-market enrichment runs only **once daily**, capped at 250 ticker calls—about 7,530
  calls in a 30-day month—while keyless DEX data can refresh every six hours.
- Material external changes are rolled into one **morning digest** instead of generating alert spam.

Automation detects and records change; it does not silently invent a legal conclusion. Internal
research corrections are not public history: the public product shows the best current analysis.
Real changes by an issuer, venue, protocol or on-chain authority remain dated, visible and sourced.

## Run locally

```bash
npm install
npm run serve
```

Open the URL printed by the server. API-backed pages also need:

```bash
npm install --prefix api
npm run dev --prefix api
```

Local pages normally discover the API on port 3300. For a deterministic preview, especially when
the static site uses a different hostname or port, open it with an explicit API origin:

```text
http://127.0.0.1:8113/stocks.html?api=http://127.0.0.1:3300
```

`npm test` runs the fast headless stock, API and page suites. Data collectors are explicit `--run`
jobs; see
[`stocks/README.md`](stocks/README.md) before refreshing any external source.

## Repository map

- [`SUBMISSION.md`](SUBMISSION.md) — submission-ready short and long descriptions, differentiation
  and demo flow.
- [`UX-audit1.md`](UX-audit1.md) — the first full UX audit, implementation status and remaining
  validation work.
- [`TODO.md`](TODO.md) — the current product and research backlog.
- [`stocks/README.md`](stocks/README.md) — collection/build pipeline, outputs and operational rules.
- [`stocks/MODEL.md`](stocks/MODEL.md) — the legal/technical grading model and its limits.
- [`stocks/EVIDENCE.md`](stocks/EVIDENCE.md) — claims, source watching, change detection and review.
- [`stocks/findings.md`](stocks/findings.md) — dated research notes and primary-source findings.
- `ecosystem.config.cjs`, `stocks/refresh-on-server.sh`, `deploy-to-server.sh` — production refresh
  and publication.

RWA Sonar is research, not investment or legal advice. Every conclusion should be independently
verified before relying on it.
