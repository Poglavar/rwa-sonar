# Hackathon submission draft — RWA Sonar

Submission deadline: 25 September 2026. Live product: <https://rwasonar.com/>. Repository:
<https://github.com/Poglavar/rwa-sonar>.

## Punchline

**Don't trust the ticker. Inspect the token.**

## One-line description

RWA Sonar is the L2BEAT-style transparency layer for tokenized stocks on Solana: it shows what each
token really represents, who controls it, where it actually works, and which claims the evidence
supports.

## Paragraph description

RWA Sonar turns tokenized stocks from familiar tickers into inspectable systems. It continuously
catalogues exact Solana token addresses and joins live market and Token-2022 state to issuer terms,
custody and ownership chains, source-backed legal analysis, confirmed DeFi integrations and 38
failure scenarios. Users can search, compare different wrappers around the same underlying stock,
inspect four independent health dimensions, and see when an issuer, authority, venue, protocol or
source changes. Where broad RWA dashboards are designed primarily to show what exists and how large
or active it is, RWA Sonar is designed to explain what the holder owns, what must be trusted, and
whether the token's real behaviour matches the claim made about it.

## Long description

A stock ticker is familiar; the token carrying it is not. Two Solana tokens can both track the same
company while giving the holder different legal claims, redemption rights, transfer restrictions,
issuer dependencies and outcomes in insolvency. A market-price dashboard cannot answer whether the
underlying shares are segregated, who is actually obligated to the holder, whether the token itself
is the legal register, or whether a pause, freeze, clawback or allowlist can override possession.
RWA Sonar makes those assumptions visible.

The current product catalogues 1,183 exact, issuer-attributed and chain-observed Solana token
addresses. Each token receives a shareable report that combines identity, price and liquidity,
holder concentration, trading activity, live Token-2022 authorities and extensions, the issuer's
legal structure, cited evidence, and confirmed protocol support. The same-underlying comparison view
lets a user place two wrappers around one stock side by side and compare the legal claim, redemption
path, controls, market quality, DeFi custody and lender exit after default—not just price.

RWA Sonar deliberately refuses to compress unlike risks into a single reassuring score. Eleven
checks are split into four dimensions: market, control, legal/evidence and DeFi composability. Every
threshold and input is visible; missing information remains unknown. Nine reviewed legal +
technology templates cover the whole catalogue, but a conclusion is inherited only when the exact
issuer programme and observed control recipe match. Thirty-eight what-if scenarios then make the
structure concrete: what happens if the holder loses keys, a protocol is hacked, a borrower
defaults, an issuer or custodian fails, a company is acquired, or a regulator intervenes?

DeFi support is treated as an observed fact rather than a compatibility claim. The system checks
exact token addresses against live lending, collateral, vault and pool registries, corroborates
published protocol accounts on Solana, records LTV and liquidation terms where available, and keeps
technical custody separate from legal and economic control. The current snapshot confirms 162
integrations across 125 assets, including 27 assets with a live lending or collateral use. It also
publishes checked zeroes: scanning a protocol that supports none of these assets is evidence too.

The product is designed to keep watching after the research is published. A six-hour build refreshes
the catalogue and analytics; an hourly watcher checks token authorities, extension state and
scheduled rebases; a daily watcher revisits the legal and operational sources; daily protocol
snapshots detect listings, removals, LTV changes, inactive markets and large collateral-value falls.
The public change journal records genuine external changes by issuers, venues, protocols and on-chain
actors. Internal research corrections are not presented as market history: users always see the best
current analysis, while real-world changes retain their before/after evidence.

This is where the product is closest in spirit to L2BEAT. L2BEAT made it normal to evaluate an L2 by
its security and trust assumptions rather than only by value or transaction counts. RWA Sonar applies
that discipline to tokenized assets, then extends it across the off-chain chain of title, custody,
contractual rights and enforcement that an RWA necessarily introduces. The result is not a
replacement for a market directory; it is the missing diligence layer between a ticker and a
decision to hold, trade, integrate or accept the token as collateral.

## What is built

- A calm landing page with catalogue, holder-account and reported-volume history plus a sourced
  external-change feed.
- Global search by company, ticker, token symbol, issuer programme or exact Solana address.
- Paginated API-backed catalogue and trade views rather than loading the full dataset into the page.
- Same-underlying comparisons, saved as capability links and checked for meaningful daily changes.
- One static, shareable card per token, readable without JavaScript and indexed by search engines.
- Issuer dossiers, a party/rights graph, nine reusable legal + control templates and conclusion-level
  citations with authority, precedence, jurisdiction, holder scope and review date.
- Four-dimensional health, transparent thresholds, historical charts and explicit missing-data
  states.
- Exact-address DeFi discovery across Kamino, Jupiter Lend, Nest, Project 0, Save, DEX pools and
  reviewed yield products, with account corroboration and liquidation/exit analysis.
- A live decoded DEX tape, historical trade API, reference-price premium, venue spread, market-hours
  context and failed-transaction sampling.
- Source and chain watchers, daily snapshots, public external-change journal, prioritized research
  queue and a single morning operations digest.
- Six plain-language guides to ownership, insolvency, redemption, issuer powers, oracle risk and why
  protocol custody is not necessarily legal ownership.

## Positioning against adjacent products

| Product | Primary question it is well suited to answer | RWA Sonar's additional question |
|---|---|---|
| RWA.xyz | What tokenized assets exist across chains, how are they classified, and what is their value/activity? | What does this exact Solana wrapper legally and technically give its holder, and which evidence supports that conclusion? |
| DefiLlama RWA | How large is the market, where is AUM/TVL, how are flows and DeFi utilization changing? | Who can intervene, what can fail, is an exact token really usable in a protocol, and can collateral be seized and exited after default? |
| L2BEAT | What are an L2's security, liveness, upgrade and decentralization assumptions? | The analogous trust-assumption analysis for RWAs, extended through legal title, custody, redemption, insolvency and off-chain enforcement. |

The comparison is complementary, not adversarial. RWA.xyz and DefiLlama solve broad market-mapping
problems. RWA Sonar specializes in source-backed, continuously monitored product diligence.

## Claims to make precisely

- Say **“1,183 catalogued, issuer-attributed and chain-observed token addresses”**, not “every stock
  token on Solana.” The catalogue is broad but cannot prove that an undiscovered address does not
  exist.
- Say **“first confirmed/catalogued by RWA Sonar”**, not “minted” or “issued that day.”
- Say **“token accounts”**, not “holders” or “people,” unless the source itself identifies beneficial
  holders.
- Say **“confirmed protocol support for the exact token address”**, not “composable” without the
  separate custody, enforcement and exit analysis.
- Say **“structural legal analysis”**, not a legal opinion, court prediction, audit or guarantee.
- Say **“claims versus observable reality”**: operative documents are evidence of rights; chain state
  is evidence of technical capability; neither silently proves the other.

## Suggested three-minute demo

| Time | Shot |
|---|---|
| 0:00 | Landing page: “Don't trust the ticker,” catalogue growth and the distinction between discovery and issuance |
| 0:20 | Search and compare: open two wrappers around the same underlying and show divergent claims, controls and DeFi outcomes |
| 0:50 | One asset card: layperson verdict, four health dimensions, exact evidence and the control surface |
| 1:20 | Issuer trust chain and one or two of the 38 failure scenarios |
| 1:45 | DeFi view: exact supported protocols, current LTV/liquidation terms and the lender-exit verdict |
| 2:10 | Monitor/watch: daily change journal, source evidence and an on-chain or protocol change |
| 2:35 | Methodology/learn: unknown is not safe; explain why a token account is not ownership of a share |
| 2:50 | Live site, open-source repository and the continuously running collectors |

## Sponsor and bounty angles

- **Meteora** — exact stock-token pools with bin step, fee tier, fees, volume, reference-price gap,
  failed-transaction share and decoded trades. The DBC pool is pinned into the collector so it
  retains tape coverage; undecodable state is labelled rather than guessed.
- **Pyth** — the keyless feed catalogue and trading schedules drive market-session context for the
  premium analysis. Price coverage is reported source by source and missing entitlement remains
  visible.
- **PreStocks** — all eight tokens join issuer marks and valuations to chain and market reality,
  including the OPENAI scaled-UI rebase and SPACEX mark-versus-market discrepancy.
- **Tessera** — all three T-Tokens join issuer-reported product data to exact Meteora pools, chain
  controls, holder data and the transfer-fee/freeze implications for DeFi custody.

Confirm at submission time whether one entry may be tagged for multiple bounties and replace any
snapshot number that has changed since this document's 20 September 2026 review.
