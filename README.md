# RWA Sonar — tokenized stocks on Solana

RWA Sonar grades "tokenized" assets by what they are in reality. This branch adds the
tokenized-stocks layer built for the Stocklana hackathon: every tokenized equity on Solana we
can find (hundreds of mints across a growing set of issuer programmes), graded on **what the holder legally owns** and
**what the issuer can do to the token on-chain**, with a health status per token whose rules are
printed next to their inputs. It is not a TVL dashboard; rwa.xyz and DefiLlama already exist.

## For judges

| Page | What it shows |
|---|---|
| `/stocks.html` | The two-axis grid (ledger maturity × claim depth), per-issuer dossiers with cited legal facts, 24 h trading activity, every mint in one table, the "New on Solana" ticker of recently first-seen mints, and per issuer a **trust-chain diagram** (13 actors, 9 graded rights flows) with the 38 what-if answers under it |
| `/cards/NVDAx.html` | One shareable card per token: what you own, reference price and premium, depth and activity, holder concentration, control surface, confirmed live DeFi uses, structural DeFi composability, verification, venues, trust chain, what-if answers and the eleven health rules. `/card.html?symbol=NVDAx` redirects. Readable with JavaScript off |
| `/monitor.html` | Health monitor: status counts, worst failing rule, the "New on Solana" ticker with its count in the header, filterable all-token table, change log from daily snapshots, curated event log, Meteora pool section |
| `/live.html` | Live trade tape decoded from pool transactions, "Go live" polling, 24 h replay |
| `/graph.html` | Who issues what, for whom, traded where: the parties graph |
| `/whatif.html` | The failure-mode matrix: the 38 questions every issuer is asked — keys stolen, custodian bankrupt, company acquired, regulator at the door — down the page, the issuers across it, and one cell per answer with its status. Tap a cell for the outcome, the quote it rests on and the source; a cell with nothing in it is a question nobody has answered for that issuer, drawn rather than left blank. Filterable by status and actor in the URL |
| `/watch.html` | What we keep watch on and what has moved: the source registry, the change feed, evidence freshness per issuer, and a claims lookup |
| `/methodology.html` | Public methodology, live collector-by-collector freshness, evidence precedence and explicit blind spots |
| `/review.html` | Prioritized public evidence-review inbox: missing, stale, conflicting and changed claims |
| `/learn/` | Six plain-language guides to ownership, insolvency, redemption, issuer powers, oracle risk and DeFi custody |

Run it locally with `npm run serve` and open the URL it prints. For API-backed pages, start the API
with `npm run dev --prefix api` and add `?api=http://localhost:3300` to the page URL. `npm test` runs
the fast headless suites (the database integration suite reports explicitly when `DATABASE_URL`
is unavailable).

### The thesis in three findings

- **The most "tokenized" product is not the most "real" one.** xStocks (Backed) and Ondo issue
  Swiss/Jersey ledger-based certificates where the chain is the legal register, and reach ledger
  maturity Level 2. Superstate, Bullish and Securitize put *registered shares* on chain, sit at
  Level 0 (the transfer agent's register is the main ledger, transfers are allowlisted) and have
  no trading venue at all. Two axes are needed to say both things.
- **Control is a fact, not a promise.** Every mint is Token-2022; no transfer hook is active
  anywhere; pause, freeze and permanent-delegate authorities are read from the mints, and whether
  the keys behind them are a multisig, a program or a hot wallet is recorded per issuer with the
  transaction evidence.
- **Market reality is measured, not quoted.** Trades are decoded from pool transactions, failed
  transaction shares on busy pools run 40–98 % (bot spam), wash-trading tells (trades per trader,
  organic share) come from Jupiter, and the on-chain price is compared with a reference price
  during and outside the underlying market's session using Pyth's trading schedules.

### Health rules

Eleven checks across market, control, legal/evidence and DeFi-composability dimensions, worst-of.
A rule with missing inputs is `unknown`, and unknown never
counts as a pass. Inputs and thresholds are printed on every card. Rules live in
`stocks/lib/health.mjs` and are covered by the headless test suite.

| Rule | good | caution | warning |
|---|---|---|---|
| Price tracking (\|premium\| to reference) | ≤ 1 % | ≤ 3 % | > 3 % |
| Pool liquidity (Jupiter, USD) | ≥ 100k | ≥ 10k | < 10k |
| Organic flow (organic share ≥ 10 % and ≤ 25 trades/trader) | both | one fails | both fail |
| Failed swaps (sampled pool signatures) | ≤ 20 % | ≤ 50 % | > 50 % |
| Holder concentration (top-1, excluding labelled issuer/burn accounts) | ≤ 25 % | ≤ 50 % | > 50 % |
| Reserve verification strength (0–5) | ≥ 3 | 1–2 | 0 |
| DeFi enforceability (reviewed tech + legal template) | permissionless custody and default enforcement | conditional support or eligibility | generic escrow blocked or default enforcement depends materially on the issuer |
| Authority keys (mint, freeze, delegate) | multisig or program | any hot key | — |
| Trading paused | no | — | yes |
| Frozen accounts in top 20 | 0 | ≥ 1 | — |
| Venue spread | ≤ 2 % | ≤ 5 % | > 5 % |

On 2026-09-17 that gives 23 good, 117 caution, 301 warning. The skew is the data: most
tokenized stocks on Solana are thinly held, thinly traded and off-price, and the card says which.

### Data sources

| Source | Used for | Key |
|---|---|---|
| Jupiter Tokens API v2 | universe, prices, liquidity, 24 h trade and trader counts | none |
| Solana RPC (Alchemy on the server, public RPC otherwise) | mint state and extensions, authorities, top-20 holders, live supply, pool transactions | app key |
| DexScreener, CoinGecko | DEX pools and CEX markets per mint, venue prices and spread | Demo key for CoinGecko |
| Pyth Hermes | equity feed list with trading schedules (keyless); reference prices where entitled (3 of 244 feeds on the free tier, reported honestly) | Pro key for prices |
| Meteora datapi | DLMM bin step, fees, 24 h fees and volume for the 22 Meteora pools; the DBC pool's account | none |
| Kamino public API | exact-mint lending markets, eligible debt categories, market size and LTV/liquidation terms | none |
| Jupiter Lend public API | exact-mint collateral/debt vaults, deposited collateral, positions and risk terms | none |
| Nest versioned deployment manifest | exact-mint nUSD collateral markets and LTV/liquidation terms | none |
| Project 0 hosted bank API | operational collateral banks matched by exact mint, collateral weights and deposits | none |
| Veda and Kraken product pages | the three exact xStocks with live Veda/Sentora yield vaults | none |
| Ondo, Superstate, PreStocks, Tessera APIs | the issuers' own marks, valuations, supply, trading status, holder counts | none |
| Issuer documents | prospectuses, terms, transfer-agent disclosures, filings, cited per issuer in `stocks/data/issuers/` | — |

Not collected: order-book depth on centralised venues, historical reference prices per trade
(the after-hours premium uses the reference price at build time), and anything behind a login.

### Repository map

- `stocks/README.md` — the pipeline: fetchers, builders, run order, every output file.
- `stocks/MODEL.md` — the grading model and its critique of the original site model.
- `stocks/findings.md` — dated evidence log.
- `SUBMISSION.md` — bounty claims and the demo video plan.
- `ecosystem.config.cjs`, `stocks/refresh-on-server.sh`, `deploy-to-server.sh` — how the live
  site keeps itself fresh (a 3-hourly trade collector and a 6-hourly refresh on the server).
