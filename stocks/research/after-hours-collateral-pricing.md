<!-- Research note: what price each Solana lending market uses for tokenized-stock collateral outside US market hours, and whether an after-hours dump can move that price enough to trigger liquidations. -->

# After-hours pricing of tokenized-stock collateral on Solana lending markets

Research date: Thursday 2026-09-24. All live reads were taken between 14:23 and 14:58 UTC, during the US regular session. Weekend behaviour comes from on-chain transaction history (2026-09-16 to 2026-09-24) and Kamino's hourly reserve history (2026-09-11 to 2026-09-24). Structured facts are in `stocks/data/protocol-market-research.json` under `oraclePricing`.

## Short answer

- **No market we found lets an on-chain dump of an xStock liquidate borrowers at Kamino or Jupiter Lend.** Both value xStocks from Chainlink's equity-market price. Selling the token on Solana does not reach that number.
- **Nest does price xStocks from the token's own 24/7 price** (Pyth `Crypto.<T>X/USD` feeds). There, a weekend fall in the token price liquidates positions even if the stock opens flat on Monday. The largest Nest SPYx position ($96k collateral, 65,000 nUSD debt) is liquidated by a 15.6 % fall in that feed. Moving the feed that far requires moving the prices its publishers see. We could not establish which venues those are.
- **Nest's Backpack and Ondo markets use a price Nest signs from a Jupiter order quote.** For QQQon and SPYon, Solana liquidity is a few thousand dollars or less (Jupiter's price API reported $259 and $9,202): a $5,000 sale moved the QQQon executable price 20 % at 14:39 UTC. Nest does not document how it turns a quote into a price, so the manipulation cost is unknown. Each of these markets holds one position of about $3,500.
- **Kamino's gates can be tripped by token trading, which freezes the reserve.** For xStocks the gate is a 5 % band against the 24/7 token price. For STRCx it is a 10 % band against one Raydium pool. While frozen, nobody can borrow and nobody can be liquidated. For STRCx, about $75–80k sold into the Raydium pool is enough.
- **The larger measured risk is the opposite one: prices that stop.**
  - QQQx was frozen for about 44 hours at both Kamino and Jupiter Lend around a dividend multiplier change (Sat 2026-09-19 17:29 UTC to Mon 2026-09-21 12:31 or 13:42 UTC). METAx was frozen at Kamino for about 65 hours.
  - During those windows nobody could borrow, withdraw against debt, or be liquidated.
  - Loopscale's xStock price accounts have not been updated since 2026-08-26 (TSLA since 2026-09-12), so its xStock loans can neither roll nor be liquidated.
- **Monday gaps are real.** Kamino holds Friday's regular-session close all weekend. It then moves in one step at the open: MSTRx +8.7 % and METAx +7.0 % on 2026-09-21. No liquidation happened on the seven Kamino stock reserves we scanned (0 liquidation instructions in 3,649 transactions).

## Per-market table

| Market | Price source (read on-chain) | When the US market is closed | Staleness and pause rules | Dump-to-liquidate feasible? | Evidence |
|---|---|---|---|---|---|
| **Kamino xStocks Pool** `5wJeMr…` (QQQx, GOOGLx, TSLAx, MSTRx, AAPLx, NVDAx, SPYx, CRCLx, HOODx; METAx hidden) and **Kamino Sentora xStocks Market** `8BNUWR…` (QQQx, NVDAx, SPYx; the collateral leg of xStocks Vaults) | Scope `CappedFloored` entry capped and floored to the Chainlink Data Streams v10 xStocks report: `price × currentMultiplier`. Two gates: (1) `MostRecentOf` with the Pyth Lazer 24/7 token feed `Crypto.<T>X/USD`, max 5 % apart, both ≤ 60 s old. (2) A 5 % reference check against Pyth Lazer `Equity.US.<T>/USD`, whose sessions include pre, post and overnight. | Value held at the last regular-session close. Weekends, nights, pre- and post-market all show the Friday or evening close. The reserve keeps working while both gates hold. It freezes when the 24/7 token price or the extended-hours equity price moves more than 5 % away from the close. It also freezes around corporate actions: the Chainlink entry is suspended from 24 h before activation until an admin resumes it. | Max price age 300 s. A stale price blocks borrow, withdraw-with-debt and liquidation. A TWAP divergence over 5 % (3 % for CRCLx) or a price outside the heuristic band blocks borrow and withdraw-with-debt. Neither of those blocks liquidation. | **No.** The value is the Chainlink equity price. Token dumps can only freeze the reserve (dump-to-freeze), which needs a >5 % move in the Pyth 24/7 token feed. | Reserves decoded at slot 450054870, Scope at 450054990/450055060. Kamino hourly history. 3,649 transactions scanned. `ResumeSuspendedPrice` txs `26SQ52zV…` and `2fsSorcb…`. |
| **Kamino STRCx Pool** `B7a2Dm…` (STRCx) | Same cap and floor to Chainlink v10 STRCx. The `MostRecentOf` partner is the **Raydium CLMM pool `DU9dgBU6…` spot price**, max 10 % apart. The reference check is Pyth `Equity.US.STRC/USD` at 10 %. | Frozen at close; 20 closed-hour moves ≤0.04 % in 13 days. | Same KLend rules. Liquidation bonus 2–5 %. | **No.** A dump of **about $75–80k into the Raydium pool freezes the reserve**: selling 700 STRCx moved that pool's marginal price −8 %, and larger sizes found no route. | Grid of direct-route quotes 14:37 UTC. |
| **Kamino Superstate Pool** `CF32kn…` (FWDI, GLXY) | Scope `MultiplicationChain`: Superstate redemption rate (24/7) × Pyth Lazer `Equity.US.FWDI/USD` (regular session only) or `Equity.US.GLXY/USD` (regular, pre and post). | FWDI frozen outside 09:30–16:00 ET. GLXY moves 04:00–20:00 ET on weekdays and is frozen overnight and at weekends. | Max price age 185 s. FWDI reserve: 2 transactions since 2026-09-16, so we have no staleness evidence. | **No.** No DEX market exists for either token. FWDI debt sits at ~19 % LTV against a 40 % threshold. | Kamino hourly history. Registry sizes. |
| **Jupiter Lend** xStocks vaults 77–84 (TSLAx, SPYx, QQQx, NVDAx; USDC and JupUSD) | Jupiter Lend oracle program `jupnw4B…`, one `ChainlinkDataStreams` cache per token. The stored price is the Chainlink **24/5 v11 `mid`** of the live session (regular, extended or overnight) × the v10 `currentMultiplier`. The equity `price` and the 24/7 `tokenizedPrice` are not used. | Moves Sunday 20:00 ET to Friday 20:00 ET, including overnight (v11 status 4). Frozen from Friday 20:00 ET to Sunday 20:00 ET. The cache keeps refreshing, so reads succeed. QQQx refreshes stopped Sat 17:29 UTC at the dividend-multiplier report and resumed Mon 12:31 UTC by multisig. | Docs: 600 s max age for user operations, 7,200 s for liquidations. A stale price reverts with `PriceTooOld`. There is also a per-cache `xstocks_suspended` switch. | **No.** There is no DEX input. Exposure moves to the overnight equity quote, which Chainlink says comes from a single provider. | Caches decoded with the oracle IDL v0.1.8 at slot 450054933. Refresh transaction `3B6WhPUS…`. Suspension lift `4yhWfLvG…`. |
| **Nest** xStocks and SPCX (Pyth Lazer) | Nest `refresh_lazer_oracle` with Pyth Lazer **`Crypto.<T>X/USD` 24/7 token feeds**. Backpack's SPCX uses the xStocks SPCXx feed (3329). An underlying-equity feed id is stored but unused. Nest values collateral at `price − confidence`. | Moves 24/7 with the token. Borrow and withdraw transactions succeeded at weekends. | Max age 120 s; confidence ≤ 2 %. No market-hours rule. Liquidation penalty 8 %, close factor 50 %. Only the protocol's liquidation authority has been seen liquidating. | **Yes, in principle.** Liquidation follows the token's own traded price. Moving it needs the venues Pyth's 10–11 publishers read (not established). On Solana alone a $2M SPYx sale moved the executable price 24 % (14:47 UTC). | Positions decoded at slot 450059312. Nest manifest, IDL and price API. |
| **Nest** Backpack (MU, SNDK, DRAM, BOT, SKHY, HOOD, INTC, MSTR, TTWO) and Ondo (SPYon, QQQon), `jupiter-signed` | A price signed by a Nest key (`FuHvd8…`) from a source Nest labels `jupiter-order`, with confidence fixed at 2 % of price. | Moves 24/7. Weekend refreshes are signed and accepted. | Max age 120 s; the signed payload expires 125 s after publish. | **Possibly, cheaply, for SPYon and QQQon** (Solana depth of a few thousand dollars). Upward manipulation, to borrow nUSD against inflated collateral, is the larger protocol risk. How Nest derives the price is **not established**. | Nest API 14:26:57 UTC. Quotes 14:38 UTC. |
| **Loopscale** "USDC Orca" / "USDG Orca" vaults (TSLAx, NVDAx, SPYx, CRCLx) | Pyth push accounts (`PriceUpdateV2`) for **`Equity.US.SPY/CRCL/NVDA/TSLA/USD`**, oracle type 6. Max age 900 s; uncertainty ≤ 5 %. | Frozen when closed. The SPY, CRCL and NVDA accounts were last published **2026-08-26 15:54:46 UTC** and TSLA **2026-09-11 23:59:59 UTC**. They were still stale at 14:47 UTC today. | Docs: a stale price reverts the transaction, and "Lending and liquidation activity is be paused if oracle feeds are stale". Liquidators are whitelisted. | **No.** The price does not move at all. The 12 open xStock loans (~$3.9k principal) have been overdue since 2026-08-27, neither rolled nor liquidated. | Accounts re-read at slot 450060109. |
| **Loopscale** "USDC RWA" (SECZ) | Existing entry `loopscale:secz-usdc-usdc-rwa-vault`: RedStone `SECZ_EOD` end-of-day price via BEAM. | Daily price. The 65,535 s max age means weekends can block price-dependent actions. | See existing entry. | **No.** No DEX market; the price is an end-of-day value. | Existing research entry. |
| **Project 0** (marginfi), **Save** (Solend) | No stock token listed. None of 1,183 universe mints is among Project 0's 145 banks or Save's 753 reserves. | — | — | — | APIs read 14:29 UTC. |

## How each market prices the collateral

### Kamino (KLend + Scope)

Every Kamino stock reserve points at Scope price account `3t4JZcu…` (mappings `4zh6bmb…`, configuration `6cMwdbr…`). The reserve's `TokenInfo` sits at byte 5032 of the 8,624-byte reserve.

| Market | Token | Reserve | LTV / liq. | Max age price / TWAP (s) | TWAP divergence | Heuristic band (USD) | Scope price / TWAP entry |
|---|---|---|---|---|---|---|---|
| xStocks Pool | QQQx | `2jerdA…` | 70 / 72 | 300 / 300 | 500 bps | 400–900 | 347 / 281 |
| xStocks Pool | GOOGLx | `4wg6rE…` | 60 / 70 | 300 / 500 | 500 | 224–520 | 326 / 265 |
| xStocks Pool | TSLAx | `5iTicz…` | 55 / 65 | 300 / 300 | 500 | 300–520 | 338 / 273 |
| xStocks Pool | MSTRx | `Cwy2WJ…` | 30 / 40 | 300 / 300 | 500 | 65–250 | 335 / 271 |
| xStocks Pool | METAx (hidden) | `AJPrye…` | 35 / 45 | 300 / 0 | off | 592–820 | 329 / 267 |
| xStocks Pool | AAPLx | `CKJbqa…` | 40 / 50 | 300 / 300 | 500 | 190–400 | 317 / 259 |
| xStocks Pool | NVDAx | `7B66Az…` | 55 / 65 | 300 / 300 | 500 | 100–250 | 332 / 269 |
| xStocks Pool | SPYx | `UvXjBu…` | 73 / 75 | 300 / 300 | 500 | 515–858 | 344 / 279 |
| xStocks Pool | CRCLx | `57qagn…` | 30 / 40 | 300 / 300 | 300 | 62–110 | 323 / 263 |
| xStocks Pool | HOODx | `4UBJu5…` | 30 / 40 | 300 / 300 | 500 | 54–130 | 320 / 261 |
| Sentora xStocks | QQQx | `w6diwH…` | 70 / 78 | 300 / 300 | 500 | 500.50–855 | 347 / 281 |
| Sentora xStocks | NVDAx | `4WqQtj…` | 62 / 73 | 300 / 300 | 500 | 150–254 | 332 / 269 |
| Sentora xStocks | SPYx | `7Yh74h…` | 72 / 79 | 300 / 300 | 500 | 539–924 | 344 / 279 |
| STRCx Pool | STRCx | `3gJZGX…` | 50 / 65 | 300 / 300 | 200 | 93–110 | 394 / 303 |
| Superstate Pool | FWDI | `2ZdH2K…` | 25 / 40 | 185 / 185 | 500 | 3.00–10.32 | 495 / 496 |
| Superstate Pool | GLXY | `4v8hN3…` | 30 / 45 | 185 / 185 | 500 | 10–30 | 497 / 498 |

**The NVDAx chain, as decoded** (the other xStocks have the same shape with their own indices):

- **332 `CappedFloored`**: source 331, cap = 268, floor = 268. Its value is always the value of 268; its timestamp is 331's.
- **331 `MostRecentOf`**: sources 268 and 330. Both must be ≤ 60 s old and within 500 bps of each other. Any failure is an error; there is no fallback.
- **268 `ChainlinkX`**: Chainlink Data Streams v10 feed `0x000a37a5…918a`. The stored value is `price × current_multiplier`; `tokenized_price` is never read. The market-status behaviour is `AllUpdates`. Its reference price is 411, with 500 bps tolerance; a breach fails the refresh. The entry is suspended from 24 h before a corporate-action activation until an admin resumes it.
- **330 `PythLazer`**: feed 1833 `Crypto.NVDAX/USD`, schedule open 7 days, the 24/7 token price.
- **411 `PythLazer`**: feed 1314 `Equity.US.NVDA/USD`, with regular, pre-market, post-market and overnight sessions.

**STRCx** has the same shape, except that the second `MostRecentOf` source (391) is a `RaydiumAmmV3AtoB` read of the STRCx/USDC pool `DU9dgBU6…` and the band is 1,000 bps.

**Superstate** uses `MultiplicationChain` (max age 60 s): redemption-rate feed × equity feed. GLXY uses feeds 2329 × 2288; FWDI uses 2988 × 2948.

**What Kamino's history shows.** The Kamino API gives hourly `assetOraclePriceUSD` from 2026-09-11 12:00 to 2026-09-24 13:00 UTC, 314 points per reserve.
- NVDAx sat at **222.3476 from Fri 2026-09-18 21:00 to Mon 2026-09-21 13:00 UTC** and was 224.5664 at 14:00.
- Across 241 closed-hour intervals, the xStocks changed by at most 0.2 % (1–33 tiny flips). FWDI never changed.
- GLXY changed in 90 of them (max 2.8 %), all within 04:00–20:00 ET.

**Operations continued over the weekend at the frozen price.**
- On the NVDAx reserve, 254 of 261 weekend transactions succeeded, including 11 borrows. Example: `HMofZ8c7…`, Sat 2026-09-19 14:12:15 UTC, NVDAx priced at 222.3476.
- Every xStock except QQQx and METAx stayed fresh through the whole weekend. For example, CRCLx had 147 fresh refreshes and 0 stale.

**Freezes observed in transaction logs.** A reserve counts as stale when a KLend refresh logs "Price is too old token=[X]".

| Token | Stale window (UTC) | Cause |
|---|---|---|
| QQQx | Sat 09-19 17:28–18:03 → Mon 09-21 13:42 (TWAP fresh 14:21) | Corporate-action suspension. Resumed by Scope admin `ResumeSuspendedPrice` for entry 280 at 13:42:13 (`26SQ52zV…`). Stored data: observations 2026-09-19T17:28:25Z, activation 2026-09-19T23:00:00Z. |
| METAx | Fri 09-18 20:30–22:42 → Mon 09-21 13:42 | Corporate-action suspension, resumed at 13:42:33 (`2fsSorcb…`). Activation 2026-09-19T00:30:00Z. |
| MSTRx | Mon 09-21 ~08:46 → 13:34, then TWAP check failed until ~14:00 | Not established. It starts in US pre-market and MSTR opened +8.7 %, which fits the 5 % bands. A withdraw failed at 12:26:07 with `age=13211 max_age=300` (`2utY2The…`). |
| CRCLx | Mon 09-21 09:39–09:46 and 12:07–13:16 | Not established; same pattern. |
| HOODx | Mon 09-21 11:53–11:54 and 13:00 | Not established. |
| All xStocks and STRCx | Thu 09-24 ~08:39 → 09:08 | Upstream. Jupiter Lend's Chainlink caches show the same 08:38–09:08 refresh gap. A deposit at 09:01:07 logged `age=1287` for NVDAx, GOOGLx, SPYx and AAPLx (`2FqsYtM2…`). |

**Rules** (KLend `a0876097`, `state/last_update.rs` and `lending_market/lending_operations.rs`):

| Condition | Blocks |
|---|---|
| Price older than max age | Borrow, withdraw from an obligation with debt, and **liquidation**. `LIQUIDATION_CHECKS` = loaded + age + usage allowed. |
| TWAP divergence, TWAP age, or heuristic band | Borrow and withdraw-with-debt only. Liquidation is still allowed. |
| Stale price | Deposit and repay still work. |

One stale collateral reserve blocks the whole obligation, because the obligation's flags are the AND of every reserve.

**Docs versus chain.**
- Kamino's oracle page says: "If a provider's feed goes stale, deviates significantly from other providers, or fails a validation check, Scope automatically falls back to the next-best source." The xStocks chains use `MostRecentOf`, which errors when any source is stale or when sources diverge, and we observed multi-hour and multi-day freezes.
- Kamino's 2025 xStocks launch post describes the price band and says the design lets "xStock prices on Kamino avoid onchain liquidity constraints". The later STRCx chain does use an on-chain pool as its gate.

### Jupiter Lend

All eight xStock vaults read one `ChainlinkDataStreamsCache` per token, owned by the oracle program `jupnw4B6…`.

**Feeds.** Each cache holds four Chainlink feeds: one v10 xStocks feed, plus three v11 "RWA Advanced" feeds for the Regular, Extended and Overnight sessions.

**Stored price.** The stored price is the v11 `mid` × v10 `currentMultiplier`. This was proved on QQQx at 14:22:01 UTC: 737.18985 × 1.0034560758968376 = 739.737634…, which is exactly the stored value. Simulated `get_both_exchange_rate` returns the same number for "operate" and "liquidate".

**Timing.**
- Refreshes land about every 4 minutes in every session, submitted by keepers.
- On weeknights the price follows the overnight session. At 03:03 UTC today the QQQx v11 Overnight mid was 740.43 (status 4), while the v10 equity `price` stayed at 740.96 from the 16:00 ET close.
- At weekends (Friday 20:00 to Sunday 20:00 ET) the inputs are frozen and the cache keeps refreshing. TSLAx had successful reads all weekend. Whether the frozen weekend value is the Friday close or the last overnight mid (TSLAx: 364.33 vs 368.925) was not established.
- QQQx stopped refreshing Sat 2026-09-19 17:29 UTC, on the first report that carried the dividend multiplier (activation 2026-09-19T23:00:00Z). User operations failed with `PriceTooOld` on Sunday and Monday. A multisig lifted the suspension at Mon 12:31 UTC (`4yhWfLvG…`).

**Sizes.** API at 14:23 UTC:

| Vault | Collateral supplied | Debt |
|---|---|---|
| SPYx/USDC | 14,736 SPYx | 4.43M USDC |
| SPYx/JupUSD | 2,656 SPYx | 1.11M JupUSD |
| QQQx (both vaults) | 2,290 | 0.91M |
| TSLAx (both vaults) | 4,197 | 0.53M |
| NVDAx (both vaults) | 6,045 | 0.38M |

Liquidation thresholds are 85 % (SPYx, QQQx) and 75 % (TSLAx, NVDAx); the penalty is 3 %.

**Docs versus chain.** Jupiter's developer oracle page does not list the `ChainlinkDataStreams` source type the vaults use.

### Nest (nUSD)

The manifest `docs.nestusd.com/deployments/mainnet.json` and the on-chain `CollateralConfig` accounts agree.

**Terms.**
- xStocks: borrow LTV 50–70 %, liquidation threshold 60–80 %.
- Backpack tokens: 40 / 50 %.
- Ondo tokens: 60–70 / 70–80 %.
- Every market: `maxStalenessSeconds` 120, `maxConfidenceBps` 200, liquidation penalty 800 bps, close factor 5,000 bps.

**Oracles.**
- xStocks use Pyth Lazer `Crypto.<T>X/USD` (24/7).
- Backpack and Ondo tokens use a Nest-signed price labelled `jupiter-order`, signed by `FuHvd8…`. It carries a fixed 2 % confidence, so collateral is valued at 98 % of that price.
- Nest's docs say minting nUSD and withdrawing collateral with debt "require a fresh oracle update in the same transaction".
- Nothing in Nest's docs, manifest or program pauses anything outside US hours.

**Positions** (all `Vault` accounts decoded at slot 450059312, 14:43 UTC; Nest API prices at 14:26:57 UTC; collateral valued at price − confidence):

| Market | Positions with debt | Collateral | Debt (nUSD) | Smallest fall to liquidation | Collateral liquidatable at −20 % |
|---|---|---|---|---|---|
| SPYx | 26 | $152,570 | 101,833 | 13.2 % | $148,873 |
| GOOGLx | 5 | $6,237 | 2,878 | 16.8 % | $5,234 |
| AAPLx | 5 | $6,174 | 2,511 | 15.6 % | $3,488 |
| SPCXx | 13 | $7,349 | 1,629 | 14.3 % | $1,875 |
| METAx | 3 | $3,420 | 1,602 | 20.2 % | $0 (at −30 %: $3,226) |
| QQQx | 4 | $837 | 330 | 15.3 % | $185 |
| NVDAx | 11 | $856 | 140 | 18.0 % | $0 |
| CRCLx | 14 | $14,450 | 2,875 | 30.9 % | $0 |
| QQQon | 1 | $3,559 | 1,789 | 28.2 % | $0 (at −30 %: $3,559) |
| SPYon | 1 | $3,368 | 1,720 | 36.1 % | $0 |

The largest SPYx position is 125 SPYx ($96,298) against 65,000 nUSD: LTV 67.5 %, liquidated by a 15.6 % fall.

### Loopscale

**Pricing.** Both xStock-accepting vaults use `MarketInformation` entries with oracle type 6, pointing at Pyth push `PriceUpdateV2` accounts for the listed shares (verification "Full"):

| Token | Account | Share feed | Last price | Published (UTC) | Age at 14:47 UTC |
|---|---|---|---|---|---|
| SPYx | `9owhtgrd…` | SPY | 765.48 | 2026-08-26 15:54:46 | 695 h |
| CRCLx | `7zWGncBP…` | CRCL | 88.78 | 2026-08-26 15:54:46 | 695 h |
| NVDAx | `2w1Tg1XT…` | NVDA | 211.02 | 2026-08-26 15:54:46 | 695 h |
| TSLAx | `E8WFH8br…` | TSLA | 365.28 | 2026-09-11 23:59:59 | 303 h |

Terms: max age 900 s; LTV 60 / 75 % for SPYx and 40 / 60 % for the others.

**Loans.**
- 12 loans hold xStock collateral, about $3.9k of principal.
- Every USDC Orca xStock ledger ended 2026-08-27 13:32:29 UTC. None has been rolled or liquidated since.
- The ledger `8FVLU7…` rolled only on US trading days at 09:30–09:35 ET until 2026-08-26.

**Discrepancy in our own data.** `defi-usage.json` shows $30.5k / $21.3k / $80.6k / $4.0k "lent against" TSLAx / NVDAx / SPYx / CRCLx. These figures are the vaults' `currentAllocationAmount`. Open principal against xStocks is about $3.9k.

**SECZ.** See the existing entry `loopscale:secz-usdc-usdc-rwa-vault` (RedStone end-of-day price).

### Other venues

- The top-holder scan (`defi-footprint.json`) finds stock tokens in Kamino, Jupiter Lend, Nest, Loopscale, Exponent and many DEX pools. Exponent holds $1.18M of STRCx in a yield-stripping vault, which does not lend against it.
- Project 0 and Save list no stock token (both APIs read at 14:29 UTC).
- Unknown program owners (for example `defAh9DW…`, which holds PreStocks tokens) were not identified as lending markets.

## Can an after-hours dump trigger liquidations? (question 3)

A dump-to-liquidate needs the collateral price to follow the market being dumped. Case by case:

1. **Kamino xStocks: no.**
   - The liquidation price is Chainlink's equity price, capped and floored in Scope. On-chain selling cannot move it.
   - Selling can push the Pyth 24/7 token feed more than 5 % from the close, which freezes the reserve for everyone within 300 s: no borrows, no liquidations.
   - That feed has 3 or more publishers (10–11 observed on SPYx payloads). Its venues are not published, and Chainlink describes its own `tokenizedPrice` as centralized-exchange trading. The cost to push it 5 % is **not established**.
   - Last weekend no xStock tripped the band. The on-chain weekend premium over the reference price was largest for CRCLx (+7.3 % median trade premium on 2026-09-19/20 against an Ondo-implied reference) and still did not trip it.
2. **Kamino STRCx: freeze only.**
   - At 14:37 UTC, direct-route quotes into Raydium pool `DU9dgBU6…` gave these marginal price moves:

     | STRCx sold | Proceeds | Marginal pool price |
     |---|---|---|
     | 400 | ~$42.7k | −1.6 % |
     | 600 | ~$63.6k | −4.7 % |
     | 700 | ~$73.6k | −8.0 % |
     | 800 or more | — | no route (pool liquidity exhausted) |

   - About $75–80k of STRCx sold into that pool therefore passes the 10 % band. The STRCx reserve then freezes. It holds about $0.70M of deposits (Kamino API, 13:00 UTC) with about $0.13M borrowed against them (registry, 01:08 UTC). The value itself does not move, so nobody is liquidated.
3. **Kamino Superstate and Loopscale: no.** There is no market to dump (FWDI, GLXY, SECZ), or the price does not move at all (Loopscale).
4. **Jupiter Lend: not via Solana.** The price follows Chainlink's 24/5 session mids. Overnight that is one provider's quote on an alternative trading system. Moving it means trading the underlying share overnight, which we did not assess.
5. **Nest xStocks: the price does follow the token.**
   - Liquidating the largest SPYx borrower needs a 15.6 % fall in Pyth `Crypto.SPYX/USD`; the most levered SPYx position needs 13.2 %.
   - Solana depth at 14:30–14:47 UTC, selling SPYx to USDC across all routes on Jupiter:

     | Sale size | Average price impact |
     |---|---|
     | $250k | 0.2 % |
     | $1M | 1.3 % |
     | $2M | 23.8 % |
     | $5M | 74.7 % |

   - If Pyth's SPYx publishers read Solana DEX prices, roughly $1.5–2M of selling would reach the threshold. If they read centralized exchanges, more is needed: CoinGecko listed about $13M of 24 h SPYx volume on those venues on 2026-09-20 (`stocks/data/venues.json`). Weekend depth was not measured.
   - The only liquidator observed is Nest's own liquidation authority, and the penalty is 8 % on at most half the debt (≈ $2,600 on the largest position). A dump like this destroys value for the seller. The realistic risk is a genuine thin-market weekend move liquidating borrowers whose stock does not move on Monday.
6. **Nest Backpack and Ondo (`jupiter-signed`): feasible in principle.**
   - Solana depth for QQQon: a $5k sale moved the executable price 20.7 %, $25k 82.9 %. SPYon: 0.1 % at $5k, 63.5 % at $25k (14:38 UTC).
   - Both markets hold one position each ($3.6k and $3.4k), needing 28 % and 36 % falls.
   - The bigger concern is the reverse. If the signed price follows a buy-side push, an attacker could post inflated QQQon or SPYon and mint nUSD against it. The market caps (1e11 raw, i.e. $100k of nUSD at 6 decimals, for the Ondo markets) bound that.
   - Nest's `jupiter-order` price (740.53 for QQQon at 14:26:40 UTC) was close to the stock price Jupiter's price API reported for QQQon (736.6 at 14:33:59 UTC). The quote probably reaches market makers beyond the Solana order book. The method is **not established**, so this stays a question rather than a finding.

**Second-order effect: liquidators selling seized collateral into the same thin pools.**
- Of the oracles above, only the Kamino STRCx gate and the Nest xStock and `jupiter-signed` prices can see on-chain trading. Only Nest's value moves with it.
- Everywhere else, liquidator selling does not change the price used, but it limits how much can be liquidated profitably. On-chain depth at 14:30 UTC was:

  | Token | Sale | Average impact |
  |---|---|---|
  | GOOGLx | $250k | 3.6 % |
  | GOOGLx | $1M | 73 % |
  | TSLAx | $250k | 1.1 % |
  | TSLAx | $1M | 44.5 % |
  | AAPLx | $250k | 5.9 % |
  | AAPLx | $1M | 82 % |
  | QQQx | $1M | 20 % |

- Against that: Kamino's xStocks Pool holds $1.79M of GOOGLx and $2.16M of TSLAx collateral in indebted obligations, and Jupiter Lend holds $11.4M of SPYx in one vault.
- A large down-gap at the open would produce liquidations bigger than the pools can absorb at the 3 % (Jupiter Lend) or 5–10 % (Kamino) bonus. Liquidators would then have to redeem through the issuer or hedge on centralized exchanges. Otherwise liquidations stall and lenders carry the gap.
- Depth was measured once, during US hours. The oracle-priced market makers that supply most small-size depth (Riptide, HumidiFi, BinaryFi, ZeroFi, TesseraV) may quote differently at night and at weekends.

## Frozen at Friday's close while the stock gaps on Monday (question 4)

**Kamino.**
- The price stays at Friday's regular close through the weekend and moves in one step at 09:30 ET Monday.
- Friday 21:00 to Monday 14:00 UTC on 2026-09-18/21: MSTRx +8.71 %, METAx +6.97 %, GLXY +4.65 %, FWDI +4.55 %, CRCLx +3.96 %, TSLAx +3.22 %, HOODx +1.61 %, QQQx +1.56 %, GOOGLx +1.27 %, NVDAx +1.00 %, SPYx +0.79 %, STRCx +0.41 %, AAPLx +0.06 %.
- If the 24/7 token or extended-hours equity price leaves the 5 % band before the open, the reserve freezes. Nobody can then be liquidated until Chainlink's regular-session price catches up at the open. For a down-gap, borrowers are liquidated at the gapped price and lenders carry any shortfall beyond the bonus.
- After a gap larger than 5 %, the 1-hour TWAP check blocks new borrowing for up to an hour but does not block liquidation. This was seen on MSTRx at 13:40 UTC Monday.
- Exposure: in the xStocks Pool, 1,131 obligations hold stock collateral with debt: $14.3M total deposits, $4.41M debt (slot 450059788, values as stored at each obligation's last refresh). Of these:

  | Price fall | Obligations liquidatable | Collateral | Debt |
  |---|---|---|---|
  | 5 % | 87 | $0.25M | $0.17M |
  | 10 % | 113 | $0.77M | $0.49M |
  | 20 % | 268 | $2.00M | $1.20M |

- SPYx (73 / 75) and QQQx (70 / 72) leave a borrower at maximum LTV only about 2.7–2.8 % of room before liquidation.
- xStocks Vaults' Sentora obligations (01:07 UTC): QQQx at 68 % LTV (12.8 % to liquidation), SPYx 69 % (12.7 %), NVDAx 58 % (20.5 %).

**Jupiter Lend.** The weekly gap arrives at Sunday 20:00 ET, when the overnight session reopens. By Monday's open the price has already been moving for 13.5 hours. It is priced from a single-provider overnight mid. The 7,200 s liquidation age limit means liquidations can use a price up to two hours old.

**Nest.** There is no Monday gap in the oracle, because the token price moves over the weekend. The gap risk becomes a weekend-liquidity risk: borrowers are liquidated on what the token does on thin weekend markets, whatever the stock does on Monday.

**Loopscale.** The xStock prices are weeks old. Nothing can be liquidated, whatever the stock does.

**Corporate actions.** Chainlink's own guidance is to "Treat any multiplier change (splits, dividends, etc) and `activationDateTime` as a maintenance window".
- Kamino and Jupiter Lend both did this for QQQx on 2026-09-19/21, and Kamino for METAx. The effect was about 44–65 hours in which QQQx or METAx borrowers could not borrow or withdraw and could not be liquidated.
- Neither protocol documents these windows to borrowers.

## What this means for a holder who borrows against tokenized stock (question 5)

**Kamino (xStocks Pool, Sentora xStocks Market, and xStocks Vaults through Sentora).**
- Your collateral is valued at the last US regular-session price. Weekend or night trading of the token does not liquidate you.
- On Monday morning your position is re-marked in one step to the opening price. If the stock opens down, you can be liquidated immediately with no chance to add collateral at the old price.
- If the token or pre-market price moves more than 5 % before the open, or during a dividend or split window, the market freezes. You cannot borrow more or withdraw collateral, but you can still deposit and repay. On SPYx and QQQx the gap between the maximum borrow and liquidation is under 3 %.

**Kamino STRCx.** Same as above. In addition, anyone who sells about $75–80k of STRCx into the main Raydium pool can freeze the market while the pool stays dislocated.

**Kamino Superstate (FWDI, GLXY).** Valued at the listed share's session price (GLXY includes pre- and post-market). There is no on-chain market in these tokens.

**Jupiter Lend.** Valued at Chainlink's 24/5 price, including overnight trading from Sunday evening to Friday evening. Your weekly re-mark comes at Sunday 20:00 ET from one overnight data provider. It can freeze around dividends, as QQQx did from Saturday to Monday.

**Nest xStocks.** Valued at the token's own 24/7 price. A thin weekend sell-off in the token can liquidate you (8 % penalty, up to half the debt) even if the stock is unchanged when the market opens. Nest has no market-hours protection.

**Nest Backpack and Ondo tokens.** Valued at a price Nest signs from a Jupiter quote, minus 2 %. For SPYon and QQQon the on-chain market is so thin that the quote is easy to move. How much that matters depends on a method Nest does not publish.

**Loopscale xStocks.** The price has not updated since August. You cannot open, roll or be liquidated. Existing loans are stuck past their end date. Your collateral is safe from price liquidation but locked, and the lender cannot get out either.

## Recommendation for the site: the "after-hours premium"

**Recommendation: reframe it.** Replace the closed-hours premium column with an **after-hours liquidity and oracle behaviour** view per token and per market. The reasons:

- **The premium does not predict losses on its own.** It measures how far weekend or night trades sit from a price that is not being set. What decides whether a holder loses money is which price each lending market uses when the stock is closed. As measured above, that is one of four things: the Friday close (Kamino), the 24/5 overnight price (Jupiter Lend), the token's own 24/7 price (Nest), or a stale price (Loopscale).
- **The number becomes meaningful when paired with a market that prices from token trading.** Then it tells a borrower how far the collateral price moved at the weekend. Show it there as "weekend move in the price your lender uses", and drop it elsewhere.
- **Freezes are the effect we can measure most concretely, and the current column cannot show them.** Examples: QQQx 44 h, METAx 65 h, Loopscale 4 weeks.

What to show per token:
1. For each lending market that accepts it: the price source when the market is closed, with one of the labels "frozen at close", "24/5 overnight", "24/7 token price", "signed quote" or "stale since …". Include the market's liquidation threshold.
2. On-chain depth: the USD sale that moves the Solana price 5 % and 10 %, measured on a weekday afternoon and on a weekend. The collector can reuse Jupiter keyless quotes the way this note did.
3. Freeze episodes in the last 30 days, per market, from transaction logs ("Price is too old", `PriceTooOld`, `ResumeSuspendedPrice`).
4. The Monday gap per token: Friday close to Monday open. For Kamino and Jupiter Lend, pair it with collateral within that gap of liquidation.
5. Keep the weekend premium only for tokens that a 24/7-priced lender (Nest) accepts, labelled as the weekend move in that lender's price.

## Proposed `finding-types.json` entries (not wired)

- **`collateral-priced-from-token-trading`**
  - category: valuation; polarity: negative; defaultSeverity: caution.
  - Description: a lending market values the tokenized stock from the token's own 24/7 trading price (for example a Pyth `Crypto.<T>X/USD` feed or a quote-derived signed price) instead of the listed share. Weekend and night moves in thin token markets can liquidate borrowers whatever the stock does.
  - How to verify: decode the market's oracle configuration (Nest `CollateralConfig.xstock_usd_feed_id` / `oracleProvider`) and look the feed up in the Pyth Lazer symbol list (asset_type crypto, schedule `O,O,O,O,O,O,O`).
- **`collateral-oracle-suspended-around-corporate-action`**
  - category: market; polarity: negative; defaultSeverity: caution.
  - Description: the lending market stops updating the collateral price from about 24 hours before a split or dividend multiplier change until an operator resumes it. While stopped, borrowing, withdrawing against debt and liquidation are all blocked.
  - How to verify: transaction logs on the reserve ("Price is too old token=[X]", `PriceTooOld`) around the v10 `activationDateTime`, plus the operator's resume transaction (Scope `ResumeSuspendedPrice`, Jupiter `LogChainlinkDataStreamsFeedSuspended`).
- **`collateral-oracle-stale-blocks-liquidation`**
  - category: market; polarity: negative; defaultSeverity: warning.
  - Description: the collateral price account has not been updated for longer than the market's maximum age, so loans against it can neither be rolled nor liquidated.
  - How to verify: decode the oracle account's publish time (Pyth `PriceUpdateV2` offset 93) and compare it with the market's max age. Loopscale xStocks: 695 h old against 900 s.
- **`protocol-docs-oracle-fallback-contradicted`**
  - category: governance (documentation vs chain); polarity: negative; defaultSeverity: info.
  - Description: protocol documentation says the price aggregator falls back to another source when one goes stale, but the configured chain errors instead and the reserve has been observed stale for hours or days.
  - How to verify: Kamino `security/oracles.md` statement against Scope `MostRecentOf` in the decoded mapping, and the logged staleness windows.

## Not established

- **Pyth Lazer 24/7 token feeds.** Which venues and publishers make up `Crypto.<T>X/USD`, and whether they read Solana DEX prices. This decides the cost of a Kamino dump-to-freeze or a Nest dump-to-liquidate.
- **Nest's signed price.** How Nest turns a `jupiter-order` quote into a price (endpoint, size, side, sanity bounds), and who operates signer `FuHvd8…`.
- **Who can liquidate on Nest.** Only the protocol's liquidation authority has been observed.
- **Kamino Monday freezes.** The exact cause of the MSTRx, CRCLx and HOODx freezes on 2026-09-21: the equity-reference band or the token band.
- **Jupiter Lend.**
  - The deployed Data Streams source code, so the exact max ages and whether a suspension blocks reads or only refreshes.
  - The weekend stored value: Friday close or last overnight mid.
  - Holiday behaviour.
- **Loopscale.** Why the Pyth push accounts stopped after 2026-08-26, and whether a liquidator posting a fresh price in the same transaction could unblock the loans.
- **Depth outside US hours.** All depth figures are from 14:30–14:47 UTC on a weekday.
- **Kamino FWDI and GLXY.** Whether the reserves go stale overnight: only 2 FWDI transactions and no GLXY activity since 2026-09-16.

## Sources and reads

On-chain reads used the project's Solana RPC. `getProgramAccounts` calls used the public mainnet RPC. Scratch decoders are not committed. The offsets are those listed in `oraclePricing.method` in the JSON.

**Kamino.**
- Reserves: 16 stock reserves at slot 450054870, 2026-09-24T14:23:39Z.
- Scope accounts:
  - OraclePrices `3t4JZcu…` at 450054990 (14:24:11Z)
  - OracleMappings `4zh6bmb…` at 450055060 (14:24:30Z)
  - Configuration `6cMwdbr…` at 450058730 (14:40:47Z)
- Obligations: 7,035 in `5wJeMr…` at 450059788 (14:45:31Z).
- Hourly history: `https://api.kamino.finance/kamino-market/<market>/reserves/<reserve>/metrics/history?env=mainnet-beta&start=2026-09-11T12:00:00.000Z&end=2026-09-24T14:00:00.000Z&frequency=hour`, read 14:27:54Z–14:28:07Z.
- Transaction scan: 3,649 transactions touching seven stock reserves from 2026-09-16 to 2026-09-24T14:28Z, fetched 14:34–14:41Z. Scope admin transactions read at about 14:41–14:42Z.
- Code: Kamino-Finance/scope `fe535236` (`oracles/chainlink.rs`, `oracles/most_recent_of.rs`, `oracles/capped_floored.rs`, `handlers/handler_refresh_chainlink_price.rs`) and Kamino-Finance/klend `a0876097` (`state/last_update.rs`, `lending_market/lending_operations.rs`, `utils/prices/checks.rs`), read 14:23–14:29Z.
- Docs:
  - https://kamino.com/docs/security/oracles.md, line 49 (fallback statement), read 14:46:36Z.
  - https://gov.kamino.finance/t/792 (2025-07-14 xStocks post; price band), read 14:46:36Z.

**Chainlink.**
- https://docs.chain.link/data-streams/reference/report-schema-v10 (field table: "`price` … Last traded price from the real-world equity market"; "`tokenizedPrice` … Aggregated price across centralized exchanges where the tokenized asset trades"), read 14:23:41Z.
- https://docs.chain.link/data-streams/tokenized-asset-streams ("The `price` field does not update during weekends…"), read 14:24:11Z.
- https://docs.chain.link/data-streams/rwa-streams/24-5-us-equities-user-guide ("Extended and overnight session price feeds are currently sourced from a single data provider"), read 14:24:06Z.
- https://docs.chain.link/data-streams/tokenized-asset-streams/handling-stock-splits ("Treat any multiplier change … as a maintenance window"), read 14:24:11Z.
- https://docs.chain.link/data-streams/rwa-streams/handling-market-events ("A large price jump at market open could cause sudden liquidations…"), read 14:24:17Z.

**Pyth.**
- Pyth Lazer symbol list https://history.pyth-lazer.dourolabs.app/history/v1/symbols (feeds 1833, 1314, 1837, 1363, 1808, 1163, 1847, 1435, 1827, 1294, 1824, 1792, 922, 1843, 1398, 1798, 1815, 1182, 2419, 2288, 2329, 2948, 2988), read 14:33:21Z.
- https://docs.pyth.network/price-feeds/pro/faq (carry-forward outside hours since 2026-03-23), read 14:33:03Z.

**Jupiter Lend.**
- API https://api.jup.ag/lend/v1/borrow/vaults, read 14:23:20Z.
- Oracle and cache accounts at slot 450054933 (14:23:48Z).
- IDL `jup-ag/jupiter-lend` `a484ddcf` `target/idl/oracle.json`, read 14:36:31Z.
- Refresh transactions `3B6WhPUS…` and `66GGD6oG…` (QQQx, 14:22 UTC) and suspension-lift transaction `4yhWfLvG…` (2026-09-21T12:31:24Z).
- Docs: https://jupiter-support.mintlify.app/user-docs/earn/lend/oracles-and-contract-priced (600 s / 7,200 s), read 14:35:47Z.

**Nest.**
- Manifest https://docs.nestusd.com/deployments/mainnet.json, read 14:23:29Z.
- IDL https://docs.nestusd.com/idl/nest_core.json, read 14:24:08Z.
- Price API https://api.nestusd.com/api/prices, read 14:26:57Z.
- https://docs.nestusd.com/developers/concepts/ ("For a $100 price and $0.20 confidence interval, Nest values the token at $99.80."), read 14:44:36Z.
- https://docs.nestusd.com/developers/reference/oracle-transactions/ ("Minting nUSD and withdrawing collateral with debt require a fresh oracle update in the same transaction."), read 14:24:27Z.
- `CollateralConfig` accounts at slot 450055456. `Vault` accounts at slot 450059312 (14:43:22Z).

**Loopscale.**
- https://docs.loopscale.com/resources/asset-parameters ("If a price is stale or its uncertainty is too high, the transaction reverts rather than falling back to a degraded value."), read 14:30:57Z.
- https://docs.loopscale.com/partners/curators/security ("Lending and liquidation activity is be paused if oracle feeds are stale or compromised."), read 14:31:15Z.
- `MarketInformation` at slot 450056672.
- Pyth accounts re-read at slot 450060109 (14:47:00Z).

**Depth.**
- Jupiter keyless quotes `https://lite-api.jup.ag/swap/v1/quote` (all routes; direct-route with `dexes=Raydium CLMM` for STRCx), 14:30:14Z–14:47:27Z.
- Jupiter price v3 at the same times.

**Coverage.** https://ai.0.xyz/v1/banks (14:29:22Z) and https://api.save.finance/v1/reserves?scope=all (14:29:25Z).
