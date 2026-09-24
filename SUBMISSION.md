# Hackathon submission draft - RWA Sonar

Primary submission target: **Stocklana** on Hackathons Solana, main track. Official page checked on
22 September 2026: submissions close **Friday 25 September 2026, 4:00pm ET**; the page lists a
$100,000 main track, $126,000 total prize pool, 795 registered builders and 157 submissions at the
time checked.

Follow-on opportunity: **Colosseum Crypto World's Fair**. Official Colosseum page/rules checked on
22 September 2026: submissions are due **12 October 2026**; the Solana ecosystem track awards
$100,000 across 10 projects that integrate with Solana.

Live product: <https://rwasonar.com/>. X: [@RWASonar](https://x.com/RWASonar). Reviewed Stocklana
source branch: <https://github.com/Poglavar/rwa-sonar/tree/colosseum-worlds-fair>.

Official source links checked for this package:

- Stocklana: <https://hackathons.solana.com/hackathons/stocklana>
- Colosseum Crypto World's Fair: <https://colosseum.com/worldsfair>
- Crypto World's Fair official rules:
  <https://colosseum.com/legal/Crypto%20World%27s%20Fair%20Hackathon%20Rules.pdf>

## Punchline

**Don't trust the ticker. Inspect the token.**

## One-line description

RWA Sonar applies L2BEAT-style trust analysis to tokenized stocks on Solana: it shows what each
exact token represents, who controls it, where it can be used, and which claims the evidence
supports.

## Paragraph description

RWA Sonar shows what sits behind each tokenized stock ticker. It continuously
catalogues exact Solana token addresses and joins market and Token-2022 state to issuer terms,
custody and ownership chains, source-backed legal analysis, confirmed DeFi integrations and 38
failure scenarios. Its stock-first interface groups wrappers around the underlying company, gives a
plain-language answer before exposing detail, and lets users compare two versions of the same stock
without beginning in a database-sized table. Broad RWA dashboards show what exists and how
large or active it is. RWA Sonar explains what the holder owns, which parties the holder depends on,
and whether the token behaves as its issuer says it does.

## Current snapshot

Public build reviewed: **22 September 2026, 02:06:05 UTC**.

- **1,183** exact, issuer-attributed and chain-observed Solana token addresses across **12 issuer
  programmes** in the generated token dataset. Other tokens may exist outside this
  coverage.
- **9** reviewed legal + technology templates covering the catalogue by issuer programme and
  observed control recipe. A template is research analysis. It is not a legal opinion on any single asset.
- **11** health checks split across market, control, legal/evidence and DeFi-composability
  dimensions. Missing data remains unknown and never becomes a pass.
- **125** assets with confirmed current DeFi use in the **19 September 2026** composability
  snapshot, across **162** exact-token integrations, including **27** assets with lending/collateral
  use. Exact protocol support is separate from legal enforceability and exit quality.
- The public site refreshes generated outputs every **6 hours**. Inputs keep their own cadence:
  token authorities and trades hourly, legal/operational source checks, redemptions, case law and the
  model change assessment daily, CoinGecko enrichment once daily.

Findings to lead with (verify against the live pages before recording; each is dated):

- xStocks' permanent delegate (the power to move or burn holder tokens) is a Squads 2-of-3 vault
  with time lock 0, and across 1,844 transactions from 10 Jun 2025 to 18 Sep 2026 no transfer or
  burn names it as authority.
- On 24 Sep 2026, **81.0%** of priced xStocks supply ($2.03B of $2.50B, 99 priced mints) sat in
  issuer-attributed wallets, including an inventory wallet the issuer itself excludes from its
  circulating figure. The public float, about $475M, is an upper bound.
- Loopscale's docs call a key a co-signer that "cannot initiate actions on its own"; on chain it is
  the protocol admin and signs refinances alone (23 Sep 2026).
- Superstate's transfer agent "can reconstitute" lost or stolen tokens once loss and identity are
  confirmed (SEC Crypto Task Force letter, June 2025); not promised, liability capped.
- On 23 Sep 2026 the redemption scan read 218 Ondo redemptions in 17.9 covered hours.

## Demo focus

1. **AAPL comparison:** compare AAPLx and AAPLon from the stock-first view. The 22 Sep snapshot shows
   AAPLx with about **$591.7k** DEX liquidity and **$418.8k** reported 24h volume, while AAPLon has
   about **$885** liquidity and **$309** reported 24h volume. The point:
   legal claim, issuer controls, redemption route, market exit and DeFi support all differ
   under the same stock symbol.
2. **Standalone/no-pair example:** open FGDLx, the only wrapper in the catalogue for the Franklin
   Responsibly Sourced Gold ETF, exact mint `XspurdrAqbRJMQfAUEfh88QxE3XbSWxQGu3GneJR6e3`. The current
   snapshot has no confirmed DEX pair or centralised venue market. The report remains useful:
   ownership, issuer controls, conditional redemption, evidence limitations and failure scenarios
   stay inspectable while secondary-market exit is explicitly unavailable in the indexed data.
3. **Scoped watched change:** show the 19 Sep 2026 PreStocks transfer-fee change. All eight
   PreStocks mints changed from **50 bps** to **100 bps** at fee epoch 1039; evidence is the Solana
   programme authority account observed at slot 448348634. It is a fee/control change that affects
   holders. It says nothing about whether the underlying SPV exposure is adequately backed.

## What was built

- Stock-first discovery and global search by company, ticker, token symbol, issuer programme or exact
  Solana address.
- Same-underlying wrapper comparison (one, two or many wrappers) with a decision summary and
  evidence-backed differences.
- Static, shareable per-token cards readable without JavaScript, each with its own 1200×630 social
  preview image.
- Issuer dossiers, party/rights graph, nine reusable legal + control templates and conclusion-level
  citations with authority, precedence, jurisdiction, holder scope and review date.
- **Who holds the keys** (<https://rwasonar.com/powers.html>): every issuer programme × seven
  holder-affecting powers, each cell naming the holder kind (one key, m-of-n multisig with its time
  lock, a program and who can upgrade it, not installed, unknown) with addresses and recorded use.
- **Flows and float** (<https://rwasonar.com/flows.html>): daily creations and redemptions per issuer
  read from on-chain transactions, with covered hours per day; xStocks public float = supply minus
  issuer-attributed wallets.
- **Premium and concentration** (<https://rwasonar.com/tracking.html>): premium/discount of each
  wrapper to the underlying with market-closed shading; holder concentration against liquidity.
- **Exit routes** (<https://rwasonar.com/exits.html>): DEX pools by venue, issuer redemption route
  and its evidence state, lending markets, and a DeFi usage Sankey by proof stage.
- **What if** (<https://rwasonar.com/whatif.html>): failure scenarios answered per issuer as
  documented, inferred, litigated or unknown, with a scoreboard of documented answers.
- **This week** (<https://rwasonar.com/weekly/latest.html>): a generated weekly summary per ISO week.
- Four-dimensional health with transparent thresholds, historical charts and explicit missing-data
  states.
- Exact-address DeFi discovery with technical custody kept separate from legal enforcement and
  economic exit, plus protocol docs-versus-chain discrepancies (e.g. Loopscale).
- Monitoring: hourly chain watch, hourly trade collector (the live page reads only our API), daily
  document watcher with publisher-API and Wayback fallbacks, daily case-law watcher, daily on-chain
  redemption observer, daily model change assessment (batch, cost recorded, shown beside the diff and
  never deciding inclusion), and private Telegram digests via @rwa_sonar_bot for saved watches.
- A six-slide web-native pitch deck at <https://rwasonar.com/pitch/>.

## Pre-existing vs hackathon work

RWA Sonar existed before this Stocklana sprint as an RWA research/codebase and general site shell.
The hackathon branch concentrates the work into the Solana stock diligence product: exact-token
cataloguing, stock-first Explore/Compare, Token-2022 control decoding, issuer templates, DeFi
composability checks, generated cards, monitor/watch surfaces, API-backed rows, change journal and
the submission/pitch package.

Open-source components from others are used in the ordinary way through the project dependency tree.
The code license choice remains pending owner confirmation; the submission should not claim a
specific open-source license until that is authorized. Third-party documents, issuer terms, APIs and
market data remain owned by their respective providers; RWA Sonar records citations and derived
analysis, not ownership of those materials.

## Team

- **[Owner to add: team members, roles and relevant background.]** The pitch currently says only
  "Built by Simun".
- **[Owner to add: contact for judges and pilot users.]**
- **[Owner to add: demo video link.]**

## Positioning

| Product | Good at | RWA Sonar's additional question |
|---|---|---|
| RWA.xyz | Cross-chain RWA directory, categorisation and market size/activity | What does this exact Solana wrapper legally and technically give its holder? |
| DefiLlama RWA | AUM, TVL, flows, fees, utilization and rankings | Who can intervene, what can fail, and is exact-token protocol support enforceable and exit-ready? |
| L2BEAT | Making L2 trust assumptions, upgrades and security models legible | The same trust-assumption analysis for RWAs, extended through legal title, custody, redemption and insolvency. |

These tools complement each other. RWA Sonar covers the checks between seeing a ticker and deciding
to hold, integrate, lend against or monitor a tokenized stock.

## Sponsor and bounty fit

- **Main track:** strongest fit. Stocklana asks for a real user/problem, a working end-to-end demo,
  Solana relevance and execution; RWA Sonar is directly about making Solana tokenized stocks safer to
  inspect and use.
- **Pyth:** relevant but not a complete bounty claim by itself. The product uses the public Pyth feed
  catalogue and schedules for market-session context and can compare stock-token references where
  entitled feeds are available. Missing entitlement is shown rather than hidden.
- **Meteora:** relevant to venue discovery, liquidity and decoded trade monitoring. The product does
  not launch a Dynamic Bonding Curve pool, so it should not overclaim the DBC bounty.
- **PreStocks:** useful coverage exists, including all eight PreStocks mints and the 19 Sep transfer
  fee change. However, the official Stocklana bounty says projects integrating any non-PreStocks
  pre-IPO tokens are ineligible. Because RWA Sonar also covers Tessera and other issuers, do not claim
  PreStocks bounty eligibility without an explicit exception from the sponsor.
- **Tessera / Clawpump:** covered only where their public data and exact tokens are relevant. The
  product should not pivot into token launch/trading mechanics solely to chase a bounty.

## Business hypothesis

The public product should remain useful without a paywall. The revenue hypothesis is professional
monitoring/API access for teams that need exact-token alerts, diligence workflows, issuer/protocol
change history or integration risk screens. No revenue is validated yet; the next milestone is
pilot usage with investors, issuers, wallets, lending protocols or risk teams.

## Suggested three-minute recording

| Time | Shot |
|---|---|
| 0:00 | Open landing and state the problem: a ticker does not tell you the legal claim or who controls the token |
| 0:20 | Search Apple; compare AAPLx and AAPLon with market, control, legal/evidence and DeFi differences |
| 0:55 | Open one AAPL token card; show answer, reasoning, evidence and Token-2022 controls |
| 1:25 | Open FGDLx; show the single-wrapper, no-confirmed-market answer |
| 1:50 | Open "Who holds the keys"; show the xStocks move/burn cell (2-of-3, no time lock, unused through 18 Sep 2026), then flows.html's 81.0% float finding |
| 2:15 | Open the PreStocks fee change or this week's summary; show before/after and the Solana evidence |
| 2:40 | Close on public site, hackathon branch and pilot ask |

## Claims to make precisely

- Say **"1,183 exact, issuer-attributed and chain-observed token addresses in the 22 Sep 2026
  public snapshot"**, not "every stock token on Solana."
- Say **"first confirmed/catalogued by RWA Sonar"**, not "minted" or "issued that day."
- Say **"token accounts"**, not "holders" or "people," unless the source identifies beneficial
  holders.
- Say **"confirmed protocol support for the exact token address"**, not "composable" without the
  separate custody, enforcement and exit analysis.
- Say **"structural legal analysis"**, not legal opinion, court prediction, audit or guarantee.
- Say **"public build refreshes every 6 hours"**, while source categories have their own collection
  cadence and last-successful timestamps.
