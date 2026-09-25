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

## Form fields (Stocklana, hackathons.solana.com)

Paste these into the form. Limits checked 24 Sep 2026: short description ≤ 280 characters, full
description ≤ 5,000 characters (Markdown), up to 3 sponsor tracks, a linked Solana wallet required.

| Field | Value |
|---|---|
| Project name | RWA Sonar |
| GitHub repository | <https://github.com/Poglavar/rwa-sonar/tree/colosseum-worlds-fair> |
| Demo URL | <https://rwasonar.com/> |
| Pitch video URL (≤ 3 min) | [recorded by the owner; paste the YouTube or Loom link] |
| Technical video URL (≤ 5 min, optional) | — |
| Team | Poglavar Svemira (solo) |
| Sponsor tracks | Pyth; optionally Tessera. Not PreStocks (its rules exclude projects that also cover other pre-IPO tokens), not Meteora or Clawpump (no DBC pool or token launch). |

### Short description (261 of 280 characters)

```text
Don't trust the ticker, inspect the token. For anyone buying, lending against or integrating a tokenized stock on Solana: what each token legally gives you, who can freeze, move or burn it, how to exit or borrow, and what changed, with a source for every claim.
```

### Full description (4,988 of 5,000 characters)

````markdown
## RWA Sonar: tokenized stocks on Solana, explained

**Don't trust the ticker. Inspect the token.**

AAPLx and AAPLon both say "Apple". One is a tracker certificate whose issuer can pause, freeze and claw back your tokens; the other is an Ondo note with no clawback. Neither makes you an Apple shareholder. A wallet or explorer shows none of this, and Solana now has more than 1,400 such token addresses.

RWA Sonar answers, for every exact token address, from the chain and the issuer's own documents: what you own, who holds the keys, how you get out, where it works in DeFi, and what changed. Every answer links to the quote or the transaction.

**Who it's for:** holders choosing between wrappers of the same stock; lenders and risk teams deciding what to accept as collateral; wallets and integrators that need a trust label per mint.

**Live:** https://rwasonar.com · **Pitch:** https://rwasonar.com/pitch/

### What you can do
- **Compare a stock's tokens** side by side: legal claim, controls, exit routes, DeFi support.
- **Open a token's card**: a plain answer first, then the evidence.
- **Who holds the keys:** 12 issuer programmes × 7 holder-affecting powers, each held by one key, a multisig (with threshold and time lock), a program, nobody, or unknown.
- **What if:** 38 failure scenarios per issuer (insolvency, stolen keys...), answered as documented, inferred, litigated or unknown.
- **Flows and float, exit routes, premium, weekly summary, latest events**, and saved watches with private Telegram alerts.

### Why Solana
Token-2022 puts the issuer's powers in the mint: permanent delegate, freeze, pause, transfer fee, scaled-UI multiplier. On Solana anyone can check, hourly, whether a mint allows more than the prospectus says. RWA Sonar decodes these per mint, resolves Squads multisigs and time locks, reads mints, burns and redemptions from transactions, and checks exact-mint support at Kamino, Jupiter Lend, Loopscale, Nest and DEX pools.

### Pyth
Cards read live Pyth prices on Solana without a key, from Pyth's own price accounts (PriceUpdateV2, Pyth's publish times): the stock's feed and, where it exists, the token's 24/7 feed, for the premium and the weekend gap. Pyth's market-hours schedules set the session for premiums and the closed-market view. The lending watcher checks the Pyth accounts lenders read against each market's maximum age: the ones Loopscale reads stopped updating on 26 Aug, while other Pyth accounts for the same stocks are live.

### What the evidence shows (dated)
- PreStocks raised its transfer fee from 0.50% to 1.00% on all eight tokens (19 Sep), then on 24 Sep scheduled 3.00% on seven, uncapped, from Solana epoch 1043 (about 26 Sep). Our hourly chain watcher flagged it the same day, before it takes effect.
- xStocks' power to move or burn holders' tokens sits with a 2-of-3 Squads vault with no time lock. In 1,845 transactions (10 Jun 2025 to 23 Sep 2026) it was never used.
- On 24 Sep, about 82% of priced xStocks supply ($2.23B of $2.73B) sat in issuer-attributed wallets. The public float is at most about $0.5B.
- Loopscale's xStock prices have not updated since 26 Aug (TSLA since 11 Sep): nine loans ($3,911) are past due and can neither roll over nor be liquidated.
- Our lending watcher measured the freezes around corporate actions: Kamino held QQQx for 44 hours and METAx for 65 (18 to 21 Sep), Jupiter Lend QQQx for 43. Nobody could borrow, withdraw against debt or be liquidated.

### Coverage
1,404 token addresses from 9 live issuer programmes (12 reviewed, including two wound down); 9 reviewed legal and technology templates; 11 health checks. Missing data stays "unknown" and never counts as a pass. Structural research, not legal advice.

### How it's built
Node.js jobs on one server: hourly chain, trade and lending watchers; a daily document watcher keeping every version; case-law and redemption watchers; a model-assisted change review (batched, costs recorded, never decides what is published). PostgreSQL holds the history; the static site rebuilds every 6 hours. Sources: Solana RPC, Jupiter, Pyth, CoinGecko, issuer APIs.

### Business model and next steps
The public site stays free. Revenue hypothesis: paid alerts and an API for lenders, wallets and risk teams (exact-mint change feeds, collateral screens). No revenue yet; next: one pilot integrator and more lending markets.

### Built during Stocklana
The repository started on 13 Feb 2026 as a broad RWA catalogue. The last pre-hackathon state is `main` at `8f58030` (19 Aug 2026). Every commit on the `colosseum-worlds-fair` branch (230+) dates from 16 Sep 2026 onwards; the first ones import catalogue data fetched that day. MIT-licensed; open-source dependencies via npm.

### Team
Poglavar Svemira, solo: research, legal analysis, data pipelines and the site. X [@poglavars](https://x.com/poglavars) · Telegram [@svemirsky](https://t.me/svemirsky) · poglavar.svemira@gmail.com · [github.com/Poglavar](https://github.com/Poglavar)
````

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

*As of 22 Sep 2026; the Form fields above carry the current numbers.*

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
The concrete boundary: the repository was created on 13 Feb 2026; `main` at `8f58030` (19 Aug 2026)
is the pre-hackathon state; every commit on `colosseum-worlds-fair` dates from 16 Sep 2026 onwards.
The hackathon branch concentrates the work into the Solana stock diligence product: exact-token
cataloguing, stock-first Explore/Compare, Token-2022 control decoding, issuer templates, DeFi
composability checks, generated cards, monitor/watch surfaces, API-backed rows, change journal and
the submission/pitch package.

Open-source components from others are used in the ordinary way through the project dependency tree.
The code is open source under the [MIT License](LICENSE) (chosen 24 Sep 2026). Third-party documents,
issuer terms, APIs and market data remain owned by their respective providers; RWA Sonar records
citations and derived analysis, not ownership of those materials.

## Team

- **Poglavar Svemira**, a one-person team: research, legal analysis, on-chain data pipelines and the site.
- Contact for judges and pilot users: X [@poglavars](https://x.com/poglavars), Telegram
  [@svemirsky](https://t.me/svemirsky), poglavar.svemira@gmail.com, GitHub
  [Poglavar](https://github.com/Poglavar). Project account: [@RWASonar](https://x.com/RWASonar).
- Pitch video: recorded by the owner; the link goes in the form's Pitch Video URL field.

## Positioning

**One line for judges:** RWA.xyz and DefiLlama tell you how big tokenized stocks are; RWA Sonar
tells you what you actually own when you hold one, who can take it away, and whether the issuer's
claims match the chain: L2BEAT for tokenized stocks.

| Product | Good at | What it does not answer | What RWA Sonar adds |
|---|---|---|---|
| RWA.xyz | Cross-chain RWA market data: value, holders, transfers, issuer league tables | What a holder legally owns, who controls the token, what happens in a failure | Per exact token address: legal claim, on-chain powers, redemption, shareholder rights, dated evidence |
| DefiLlama RWA | TVL, AUM, flows, fees, rankings | Whether DeFi support is enforceable; what collateral does when the market is closed | What each lender does when the market is closed, observed freezes and liquidations, confirmed exact-token support |
| L2BEAT | Trust assumptions of L2s: who can upgrade, censor, what is claimed vs true | Tokenized assets | The same method for tokenized stocks, extended past the contract to issuers, custodians, transfer agents, legal terms and courts |
| Explorers and dashboards (Solscan, Birdeye, DEX Screener, Dune) | Raw transactions and market charts | What those transactions mean | Mints, redemptions and issuer wallets decoded into flows and float; Token-2022 extensions into "who can freeze or burn your tokens" |
| Issuer transparency pages | Proof of reserves and attestations | Anything the issuer does not say about itself | Independent cross-checks, including where the issuer's docs contradict the chain |
| Risk firms (e.g. LlamaRisk, Chaos Labs) | Deep collateral assessments for a paying protocol | Usually one-off, per client, not public or continuous | Public, continuous, one method for every token, with alerts on change |

These tools complement each other. RWA Sonar covers the checks between seeing a ticker and deciding
to hold, integrate, lend against or monitor a tokenized stock.

- **"Why won't RWA.xyz just add this?"** The hard part is not the chart: it is reading prospectuses,
  trust deeds and terms, decoding each issuer's on-chain powers, and re-checking both every day.
  That is legal and chain work data aggregators are not built for.
- **"Who pays?"** A hypothesis for pilots: lending protocols deciding what collateral to accept,
  wallets and exchanges deciding what to list and what warnings to show, issuers wanting
  independent verification. The public site stays free.

## Sponsor and bounty fit

- **Main track:** strongest fit. Stocklana asks for a real user/problem, a working end-to-end demo,
  Solana relevance and execution; RWA Sonar is directly about making Solana tokenized stocks safer to
  inspect and use.
- **Pyth (tick it):** the product uses the public Pyth feed catalogue and schedules for market-session
  context and compares stock-token prices with Pyth references where our feeds are entitled (missing
  entitlement is shown, not hidden). The lending research and watcher read Pyth on-chain: Loopscale's
  Pyth push accounts for its xStock collateral stopped updating on 26 Aug 2026, and Nest values xStock
  collateral from Pyth Lazer's 24/7 token feeds. The form allows up to 3 sponsor tracks.
- **Meteora:** relevant to venue discovery, liquidity and decoded trade monitoring. The product does
  not launch a Dynamic Bonding Curve pool, so it should not overclaim the DBC bounty.
- **PreStocks:** useful coverage exists, including all eight PreStocks mints and the 19 Sep transfer
  fee change. However, the official Stocklana bounty says projects integrating any non-PreStocks
  pre-IPO tokens are ineligible. Because RWA Sonar also covers Tessera and other issuers, do not claim
  PreStocks bounty eligibility without an explicit exception from the sponsor.
- **Tessera (optional):** the catalogue covers tOpenAI, tKalshi and tSpaceX with the issuer's own
  marks beside on-chain reality. The bounty asks for something that "drives value" to Tessera tokens,
  and diligence is only an indirect fit.
- **Clawpump:** no fit; it needs a token launched with a stock-paired pool.

## Business hypothesis

The public product should remain useful without a paywall. The revenue hypothesis is professional
monitoring/API access for teams that need exact-token alerts, diligence workflows, issuer/protocol
change history or integration risk screens. No revenue is validated yet; the next milestone is
pilot usage with investors, issuers, wallets, lending protocols or risk teams.

## Suggested three-minute recording

Checked against the live site on 24–25 Sep 2026. Avoid the flows charts and the monitor's status
counts unless the latest deploy has fixed them.

| Time | Shot |
|---|---|
| 0:00 | Home: "The ticker is familiar. The token is mysterious." The AAPLx vs AAPLon example and the latest-events box |
| 0:30 | Type "Apple" in the home search, open AAPL, compare the two wrappers (legal form, controls, liquidity, rights) |
| 1:00 | AAPLx card: the five things to know first, the shareholder-rights strip, then Markets → "When the market is closed" (Kamino freezes at the close, Nest liquidates on the 24/7 price) |
| 1:45 | SECZ card: a registered share, all five rights ✓, and "Claim ≠ observed reality" (Loopscale's docs say co-signer, the chain says admin) |
| 2:10 | Who holds the keys: the grid, then the xStocks move/burn cell (2-of-3, no time lock, unused in 1,845 transactions to 23 Sep) |
| 2:35 | The PreStocks event: a 3 % uncapped transfer fee scheduled on 7 tokens from epoch 1043, caught before it takes effect; close on the watch page and rwasonar.com |

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
