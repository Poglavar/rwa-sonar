# stocks/ — tokenized-stock universe on Solana

Collects every tokenized equity we can find on Solana, its on-chain facts, and the market data
its issuer publishes about it. Collection scripts feed `build-stocks-db.mjs` (grades + `stocks-issuers.json`/`stocks-tokens.json`, see MODEL.md), `build-graph.mjs` (`stocks-graph.json`) and the `stocks.html`/`graph.html` pages. Node 24, ESM
`.mjs`, no npm dependencies (built-in `fetch` only).

## Run order

```bash
node stocks/fetch-universe.mjs --run        # npm run stocks:universe   → data/universe.json
node stocks/fetch-onchain.mjs --run         # npm run stocks:onchain    → data/onchain.json
node stocks/fetch-sponsor-apis.mjs --run    # npm run stocks:sponsors   → data/sponsor-apis.json
node stocks/fetch-reference-prices.mjs --run # npm run stocks:prices    → data/reference-prices.json
npm run stocks:all                          # all four, in order
```

`fetch-onchain.mjs` reads `data/universe.json`, so run the universe first. `fetch-sponsor-apis.mjs`
is independent. `fetch-reference-prices.mjs` reads both `universe.json` and `sponsor-apis.json`, so
it runs last. Every script prints its usage and exits without doing anything when given no
arguments or `--help`; `--run` is the switch that makes it work. Each one is resumable and
idempotent — progress is checkpointed into `data/raw/` after every query/batch, and a re-run skips
what is already there (`--force` re-fetches everything).

## Build and sync

The four fetchers only collect. Two more steps turn what they collected into the graded database
the stocks page reads, and repair the existing site records (MODEL.md §9):

```bash
npm run stocks:all      # the four fetchers, in order   → stocks/data/*.json
npm run stocks:build    # node stocks/build-stocks-db.mjs --run   → stocks-issuers.json + stocks-tokens.json (repo root)
npm run stocks:sync     # node stocks/sync-assets-db.mjs          → DRY RUN, prints a diff
npm run stocks:sync -- --apply   # writes rwa-assets-db.json + attestations-db.json
# then open stocks.html
```

- **`build-stocks-db.mjs --run`** joins `universe.json`, `onchain.json`, `sponsor-apis.json` and
  `reference-prices.json` with the dossiers in `data/issuers/` and writes the **two** files
  MODEL.md §10.1 specifies, both into the repo root (`--out-dir=<dir>` puts them elsewhere):
  - `stocks-issuers.json` (~590 kB) — the envelope carrying each input's own `fetchedAt` plus one
    full record per issuer exactly per MODEL.md §7 (dossier facts + `grades` + `control` + `market`
    + `tokenMints`). The page fetches this first: the grid and the cards need nothing else.
  - `stocks-tokens.json` (~860 kB) — the same envelope, one record per mint, and an `issuerIndex`
    of six display fields per issuer (`slug`, `name`, `status`, `legalForm`, `claimRung`,
    `maturityStageNum`). No dossier prose — no `documents`, `attestations`, `findings` or
    `vocabulary` — which is what keeps it under a megabyte; `stocks-page.test.js` asserts that.

  Both files carry the same `builtAt`, so a page that has the issuers and is still waiting for the
  mints cannot show two "as of" readings. Tokens join by mint; Ondo's API items join on
  `ticker === underlyingTicker` and only for Ondo tokens. Issuers sort by slug and tokens by mint,
  so rebuilding unchanged inputs produces unchanged files. It reports both file sizes and ends with
  a per-issuer line — stage, score, claim rung, verification strength, liquidity, volume, holders,
  median premium, paused mints — and a live-issuers-only total. Everything it is missing is warned
  about by name (a dossier without `status`, an issuer with tokens but no dossier, a mint with no
  on-chain row); nothing missing is ever silently read as zero.

  Both records also carry an **`activity`** block (MODEL.md §11.2 per token, §11.3 per issuer),
  joined from two sources that are never summed together: Jupiter's `stats24h` in `universe.json`
  gives the trade counts (`buys24`, `sells24`, `trades24`, `traders24`, `organicBuyers24`, and the
  `tradesPerTrader` ratio that is the wash-trading tell), and `data/venues.json` — the one OPTIONAL
  input, from `npm run stocks:venues` — gives the venue facts (`dexPairs`, `dexTxns24` from
  DexScreener's own `txns.h24`, `cexMarkets`, `venueCount`, `lastTradedAt`/`lastTradedVenue` from
  the CoinGecko tickers, and the cross-venue price gap `venueSpreadPct` between `venueSpreadLow` and
  `venueSpreadHigh` over the `venuesPriced` venues deep or busy enough to count: a DEX pool needs
  ≥ $10k liquidity, a CEX market ≥ $5k 24 h volume and a print within 2 h of the venues file's own
  `fetchedAt`, never the clock, so an old build regrades identically). CoinGecko lists DEX markets
  among its tickers, so a market whose name reduces to a `dexId` ("Raydium (CLMM)" → `raydium`) is
  the same venue twice and its copy is dropped, keeping the DexScreener side — two prints of one
  venue taken moments apart are not an arbitrage gap. Two different pools of the same dex are two
  venues and are both kept. Without `venues.json` the
  build warns and every venue-derived field is null; a token whose record came back empty gets 0
  instead, because looked-up-and-found-nothing is not the same fact as never-looked-up. The
  per-issuer aggregate sums the counts over the issuer's tokens — `traders24` is a Σ of per-token
  wallet counts and ships with a `tradersNote` saying wallets may overlap — while `venueCount`,
  `venuesTop` (the six biggest by 24 h volume, with liquidity only where a DEX pair reports it) and
  the median `venueSpreadMedianPct` are per-venue, not per-token. The build prints one §11.3 row
  per issuer and the five tokens with the highest trades per trader. The activity block costs
  ~170 kB, so `stocks-tokens.json` is written with a one-space indent to stay under its 1 MB
  budget — same fields and values, one key per line, 948 kB.
- **`sync-assets-db.mjs`** applies MODEL.md §4 to the two site data files and is a **dry run by
  default**: it prints, per issuer, whether the record is created or updated and every field that
  changes old → new, plus every attestation row it would delete and insert. Only `--apply` writes.
  Each file keeps its own indentation (4 spaces for `rwa-assets-db.json`, 2 for
  `attestations-db.json`), untouched records keep their position and new records are appended.
  `--only=<slugs>` narrows it to some issuers; `--apply --out-dir=<dir>` rehearses the write
  somewhere harmless. It writes only the TEN site booleans — a dossier value of `unknown` removes
  the key instead, and `reflectLegalDecisions` / `meetingOfMinds` / `assetSelfCustody` are removed
  if present, because index.html sums every non-general field and storing them shifts the score.
  An attestation whose schema still carries a `NEW:` prefix, or is absent from
  `attestation-types.json`, is skipped and reported rather than written (MODEL.md §5), and findings
  are never written here — they live in the dossiers and in `stocks-issuers.json`.

New files: `lib/grade.mjs` (pure grading rules, MODEL.md §3), `build-stocks-db.mjs`,
`sync-assets-db.mjs`, and their suites `grade.test.js` and `sync.test.js`.

## Tests

```bash
npm run stocks:test        # NODE_OPTIONS=--experimental-vm-modules npx jest stocks
```

`lib/classify.mjs` is pure (no I/O, no network) and covered by `classify.test.js` with fixtures
copied from real mainnet mints; `lib/pyth.mjs` and `lib/env.mjs` are likewise pure and covered by
`pyth.test.js`, with fixtures copied from real Hermes responses. **The `NODE_OPTIONS` flag is required**: plain `npx jest stocks`
fails with *"Must use import to load ES Module"*, because jest gates its `require(esm)` support on
`--experimental-vm-modules` (`vm.SourceTextModule` is unavailable without it). The repo has no jest
config, so the flag lives in the npm script, which calls `npx jest` because `node_modules/` is not
installed here.

## Outputs

Each committed file is `{ fetchedAt, source: {...}, items: [...] }`, sorted by mint so a re-run
produces a readable diff rather than a reshuffle. `fetchedAt` and the market numbers move every run;
nothing else should.

### `data/universe.json` — 441 tokens on 2026-09-16

Trimmed Jupiter record per token (`icon` and the 5m/1h/6h stat blocks dropped) plus:

| field | meaning |
|---|---|
| `issuer` | slug from the Jupiter issuer tag, else from a known mint authority, else from a known shared freeze authority (Superstate, Backpack), else `null` |
| `underlyingTicker` | listed instrument the token tracks, or `null` (private company / unknown issuer) |
| `listedOnJupiter` | `false` for entries that came only from `data/manual-mints.json` |
| `manualSource`, `note` | provenance for manual entries |

Per-issuer counts on 2026-09-16: ondo-global-markets 212, xstocks-backed 156, backpack-securities
48, prestocks 8, shift 8, superstate-opening-bell 4 (3 seeded via manual-mints.json), tessera 3,
bullish 1 and securitize 1 (both seeded; allowlisted registered shares that never reach a Jupiter pool).

### `data/onchain.json` — 441 mints

`{ mint, symbol, issuer, …capability flags…, owner, space }`. The flags flatten the Token-2022
extensions into the things that decide how controllable a tokenized share actually is:
`permanentDelegate` (+`permanentDelegateAddress`), `transferHookConfigured` /
`transferHookProgram`, `pausable` (+`paused`), `defaultAccountStateFrozen`, `transferFeeBps`,
`confidentialTransfers`, `scaledUiAmountMultiplier`, `metadataUri`, `metadataUpdateAuthority`,
plus `mintAuthority`, `freezeAuthority`, `decimals`, `supply`, `tokenProgram` and the raw
`extensionNames`. `source.counts` aggregates them; `source.missingMints` lists mints the RPC had no
account for (none on 2026-09-16).

### `data/sponsor-apis.json`

Four issuer-side sources, each in its own envelope with HTTP status: PreStocks, Tessera, Ondo
(asset registry, no mints) and Superstate (`/v2/instruments`, equities only: CUSIP, Solana
token address under chain id 900, transfer-agent total/circulating supply, split multiplier,
burn address, feature flags). `--only=<source>` re-fetches a subset and keeps the other
sources from the previous file.

Here `items` is **keyed by source** (`prestocks`, `tessera`, `ondo`) because the three payloads have
nothing in common; `source.sources[id]` carries each one's URL, `fetchedAt`, HTTP status, count and
error. PreStocks gains a computed `premiumPct = (tokenPrice/markPrice − 1) × 100`; Ondo gains
`impliedUnderlyingPrice = marketCap / sharesOutstanding` and keeps a flat `tagSlugs`, with
`priceHistory24h` and `iconSrc` dropped. PreStocks/Tessera sort by mint, Ondo by symbol (its
payload carries no mint). A failing source is reported at the end and makes the exit code non-zero,
but never aborts the others.

### `data/reference-prices.json` — 441 items

One record per token pairing Jupiter's `usdPrice` with a reference price for the **underlying listed
instrument**, plus `premiumPct = (jupiterPrice/refPrice − 1) × 100`. Sources are tried in descending
order of independence and the one used is recorded in `refSource`, because a premium measured
against an oracle and one measured against the issuer's own mark are not the same claim:

| `refSource` | where `refPrice` comes from | count on 2026-09-16 |
|---|---|---|
| `pyth` | Hermes `Equity.US.<TICKER>/USD` latest price, with `refConf`, `refPublishTime`, `refAgeSeconds` and the feed's `marketOpen` | 5 |
| `ondo-implied` | `impliedUnderlyingPrice` (`marketCap / sharesOutstanding`) from the Ondo registry in `sponsor-apis.json`, joined on ticker | 337 |
| `issuer-mark` | PreStocks / Tessera `markPrice` from `sponsor-apis.json`, joined on mint (private companies) | 11 |
| `null` | no reference found, or a leveraged token | 88 |

`refPrice`, `refConf` and `premiumPct` are `null` — **never 0** — when unknown, and `premiumPct` is
computed only when both prices are finite and positive. Leveraged Shift tokens get `refSource: null`
and `note: "leveraged; no 1:1 reference"`: a 2x/3x NAV is path-dependent, so any premium against
spot would be meaningless. `refPublishTime`/`refAgeSeconds` exist only for Pyth, the one source that
timestamps its own price; the sponsor payloads carry no publish time, so those stay null rather than
being filled with the run's fetch time, and the sponsor file's own `fetchedAt` is in
`source.inputs.sponsorApisFetchedAt`.

`underlyingTicker` here is the ticker the lookup actually used. For the untagged issuers
(`superstate-opening-bell`, `securitize`, `bullish`) `classify.mjs` leaves it null, so the token
symbol is used instead — that is how GLXY, EXOD and BLSH get a reference at all.

**The Pyth key is entitled to a small subset of equity feeds, and a batch fails as a whole.** A
`GET /v2/updates/price/latest` with 50 ids returns HTTP 403 `Not entitled: feed <id>` if *any one*
id is unentitled, so the script probes every unique feed on its own first (1 request each, 250 ms
apart) and batches only the entitled ones. That probe is the expensive part, so it is checkpointed
to `data/raw/pyth-entitlement-<date>.json` (`ok` / `not-entitled` / `error`) and reused for the rest
of the day; `ok`/`not-entitled` are final, `error` entries are re-probed next run and make the exit
code non-zero. `--force` re-probes everything. On 2026-09-16 only **3 of 244** matched feeds were
entitled — TSLA, QQQ and VOO — covering 5 tokens. Prices themselves are never cached.

### `data/manual-mints.json`

Hand-maintained seed, merged into the universe with `listedOnJupiter: false`. Currently empty. For
allowlisted tokens that never reach a Jupiter pool (Superstate Opening Bell shares are the
motivating case). Shape:

```json
[{ "mint": "", "symbol": "", "name": "", "issuer": "", "source": "url", "note": "" }]
```

A manual mint that also turns up on Jupiter keeps the Jupiter record and only contributes its `note`.

### `data/raw/` — gitignored

Full untrimmed responses with fetch timestamps, and the resume checkpoints:
`jupiter-search-<date>.json` (per-query log + the full raw record of every kept token),
`mints-parsed-<date>.json` (every jsonParsed account), `sponsor-<id>-<date>.json`, `pyth-feeds-<date>.json`, `pyth-entitlement-<date>.json` (the reusable entitlement probe) and `pyth-latest-<date>.json`. ~8 MB per day,
of which Ondo is 6 MB. Note the Jupiter raw file keeps full records only for tokens that passed the
stock-tag filter — the 118 queries returned 10 416 records in total and keeping them all would be mostly memecoins.

## Provenance and caveats

- **The universe is a union of searches, not an authoritative listing.** `lite-api.jup.ag/tokens/v2`
  has no working "all tokens with tag X" call (the tag endpoint rejects `stocks`), so
  `lib/jupiter.mjs` fires 118 queries — issuer/product words plus ~89 well-known tickers and company
  names — and keeps a record only if its `tags` contain `stocks`, `xstocks` or `equities`. An issuer
  whose name and tickers are all absent from that query list is invisible to this pipeline. Add
  queries, or seed `manual-mints.json`.
- **Jupiter rate-limits at roughly 60 calls/minute.** The default pace is 1100 ms and a 429 backs off
  2s/5s/15s; at 250 ms the last 16 of 118 queries were all rejected (2026-09-16). A query that still
  fails is recorded in `source.queriesFailed`, makes the exit code non-zero, and is retried by the
  next run — the checkpoint only treats error-free queries as done.
- **All 436 mints are Token-2022.** Not one is a classic SPL mint.
- **`transferHook.programId` was `null` on every single mint** on 2026-09-16: 432 mints reserve the
  hook slot but none has a hook program installed. The *authority* to install one later is retained,
  which is the thing worth grading — not the current (empty) value.
- **Every mint has a live `mintAuthority` and `freezeAuthority`.** No issuer has renounced either.
- **`scaledUiAmountMultiplier` is usually not 1** — 200 of 436 mints carry a multiplier that accrues
  dividends and splits (PPLTon and NFLXon at `10`, VUGx at `6`, PALLon at `5`, AZNx at `0.511`,
  SOX3S at `0.1`). **A raw `supply` read without applying it is wrong.** Any grading or valuation
  step must multiply.
- **`underlyingTicker` follows each issuer's symbol convention and nothing more.** It is null for
  PreStocks and Tessera (private companies) and for unknown issuers. Shift truncates its base
  symbols, so `TSL2L` reduces to `TSL`, not `TSLA`, and `SOX3L` to `SOX`, not `SOXX` — joining Shift
  to a real ticker needs a lookup table this pipeline does not have.
- **Backpack Securities uses a different mint authority for every token** (48 distinct ones for 48
  tokens), so `issuerFromMintAuthority` catches only SPCX. Tags are the primary signal; the authority
  table is the fallback for tokens with no issuer tag.
- **Tessera's API symbol is not the on-chain symbol** (`T-OpenAI` vs `tOpenAI`; the on-chain one is
  the API's `code`). Join Tessera on `mint`.
- **Ondo's own registry is much larger than its Solana float**: 452 assets, of which 240 have no
  Solana mint on Jupiter, and 97 were trading-paused when read. Every Jupiter Ondo symbol does appear
  in the API, so the join is safe in that direction only.
- **GLXY (Galaxy Digital Inc.) carries no issuer tag on Jupiter.** It is a Superstate Opening Bell
  share and is attributed through the shared Opening Bell freeze authority
  (`ISSUER_FREEZE_AUTHORITIES` in `lib/classify.mjs`); the other three Opening Bell mints
  (FWDI, HSDT, EXOD) never reach a Jupiter pool and come from `manual-mints.json`.
- **Prices come from two unrelated places and should not be mixed silently**: `usdPrice` in
  `universe.json` is Jupiter's AMM-derived price, while `sponsor-apis.json` carries the issuer's own
  mark price for the underlying. The gap between them is a finding, not an error — the PreStocks
  SPACEX token was 22.4% below its sponsor's mark on 2026-09-16.
- **Pyth is wired in but covers almost nothing with this key.** The Hermes feed *list* is public;
  the price endpoints need `PYTH_API_KEY` (read from the repo-root `.env` by `lib/env.mjs`, never
  logged) **and a per-feed grant on that key**. On 2026-09-16 the grant covered 3 of the 244 feeds
  our tickers match — TSLA, QQQ, VOO — and everything else answered `403 Not entitled`. The Pyth Pro
  / Lazer route (`POST pyth-lazer.dourolabs.app/v1/latest_price`, ids from
  `pyth.dourolabs.app/v1/symbols`) was tested the same day and has **identical** entitlements
  (TSLA 200, NVDA and AAPL 403), so it buys nothing and is not implemented.
- **`ondo-implied` is a quotient, not a quote.** `marketCap / sharesOutstanding` is the best
  independent underlying price available for 337 tokens, but it is only as good as Ondo's two
  inputs. It disagrees with Ondo's own `ondoPrice` by more than 5% for 16 of 442 assets, mostly by
  a clean split ratio (CRWD 4x, NFLX and KLAC 10x) where the token carries a
  `scaledUiAmountMultiplier` — which is the *expected* direction: the implied price is per real
  share, `ondoPrice` is per token. ENLV is off by 14x and is simply bad input data.
- **A premium on an illiquid mint is noise, not a finding.** The five largest absolute premiums on
  2026-09-16 were all on mints with essentially no Jupiter liquidity, where `usdPrice` is a stale
  AMM print: PYPLx +6119% ($0.05 liquidity), ASTSx +220% ($120), CRWDx +56% ($49). Filter on
  `liquidity` before quoting any premium — across the 47 tokens above $50k, p10/p50/p90 was
  −1.8 / −0.2 / +2.0 %.
- **DexScreener is not a source here.** It was reported (brief, 2026-09-16) to under-report liquidity
  and volume against Jupiter for these mints; not independently re-measured in this pipeline.
- **A paid RPC would make enumeration authoritative.** Helius or any provider that allows
  `getProgramAccounts` filtered by mint authority could list every mint an issuer has ever created,
  including ones with no pool and no Jupiter listing, which is exactly the blind spot
  `manual-mints.json` papers over. The public `api.mainnet-beta.solana.com` rejects those calls.

## Issuer dossiers, findings and the data model

- `data/issuers/<slug>.json` — one hand-researched dossier per issuer (legal form, holder claim,
  custody verification, redemption, transfer restrictions, rights, incidents, documents, the
  rwa-sonar vocabulary booleans with reasons, and attestations that reuse
  `attestation-types.json` slugs or propose `NEW:`-prefixed ones). Cited to primary sources;
  written 2026-09-16 for xStocks, Ondo Global Markets, Backpack Securities, Superstate Opening
  Bell, PreStocks, Tessera, Bullish, Securitize (SECZ), Shift (leveraged ETF wrappers), Ventuals
  (defunct, never on Solana), Remora Markets (defunct) and Republic Mirror (no verifiable Solana mint;
  not in the universe).
- `findings.md` — dated, evidenced log of everything verified during collection, including the
  facts that contradict published claims (all mints are Token-2022; no transfer hook program is
  set anywhere; which freeze keys have actually been used; register-vs-chain supply breaks).
- `SCHEMA-DRAFT.md` — the two-layer record model (machine token records vs issuer dossiers) and
  the derived grades a later step computes.

## Layout

```
stocks/
  lib/io.mjs            timestamped logs, atomic writeJson (tmp + rename), sleep, fetchJson, arg parsing
  lib/classify.mjs      PURE: issuer, underlying ticker, extension → capability flags
  lib/pyth.mjs          PURE: ticker → Hermes feed, integer+expo price decoding, premium
  lib/env.mjs           PURE parser + reader for the repo-root .env (PYTH_API_KEY)
  lib/jupiter.mjs       query list, search calls with 429 backoff, stock-tag filter, record trimming
  lib/solana-rpc.mjs    getMultipleAccounts batching (100/request) with 429 backoff
  fetch-universe.mjs    → data/universe.json
  fetch-onchain.mjs     → data/onchain.json
  fetch-sponsor-apis.mjs → data/sponsor-apis.json
  fetch-reference-prices.mjs → data/reference-prices.json
  classify.test.js      jest unit tests for lib/classify.mjs
  pyth.test.js          jest unit tests for lib/pyth.mjs and lib/env.mjs
```

## Venues

Optional `COINGECKO_API_KEY` in `../.env` (free Demo tier): the fetcher sends it as `x-cg-demo-api-key`, paces
CoinGecko at 2.1 s (30 req/min) instead of the keyless ~5 req/min, so a full run takes ~15 min instead of
~85. Ticker `trust_score` is null on the Demo tier too (measured 2026-09-16), so nothing may rank on it.

`fetch-venues.mjs` answers "where does this token actually trade?" from two keyless sources and
writes `data/venues.json` (MODEL.md §10.3). The two are never merged or summed, because they do not
measure the same thing; `lib/venues.mjs` (pure, 29 unit tests in `venues.test.js`) does the
aggregating.

```bash
node stocks/fetch-venues.mjs --run             # both sources
node stocks/fetch-venues.mjs --run --only-dex  # DexScreener only, ~2 min
node stocks/fetch-venues.mjs --run --max=6     # smoke test; --help for every flag
```

- **DexScreener** `GET /tokens/v1/solana/<mint>` → one record per on-chain pool: `dexId`,
  `pairAddress`, `quoteSymbol`, pool `liquidityUsd`, `volume24Usd`, `url`. Keyless and generous —
  441 mints at 250 ms apart in **2.2 min with zero 429s**.
- **CoinGecko** `coins/list?include_platform=true` (3.7 MB, cached for the day in `data/raw/`) maps
  `platforms.solana` → coin id by exact, case-sensitive base58 match, then `coins/<id>/tickers`
  gives one record per market: `market`, `marketId`, `base`, `target`, `volume24Usd`
  (`converted_volume.usd`), `trustScore`, `url`, `lastTradedAt`. A ticker carries **no liquidity
  figure at all**. 416 coins took **84.6 min** (see the rate-limit caveat).
- Every response is checkpointed **per item** to `data/raw/venues-checkpoint-<date>.json`, so a
  killed or rate-limited run resumes the same day and re-fetches only what failed (`ok`/`empty`/
  `not-found` are reused, `error` is retried). Verified: a run killed mid-phase resumed having made
  zero DexScreener requests, and a same-day re-run finished in **0.12 s with byte-identical
  `items`**. The file is shared, so never run two instances at once.

### `data/venues.json` — 441 items, one per mint, sorted by mint

`{ fetchedAt, source: { note, dexscreener, coingecko, checkpoint, inputs }, items: [ { mint, symbol,
issuer, coingeckoId, dex: [...], cex: [...] } ] }`

On 2026-09-16, **114 of 441 mints had a DEX pool** and **305 had at least one CoinGecko market**;
130 mints have neither, and 25 map to no coin id at all (mostly Shift's leveraged tokens and
Bullish/Securitize).

| dexId | Σ liquidity | Σ 24 h volume | mints |
|---|---|---|---|
| raydium | $11,233,005 | $25,187,395 | 68 |
| meteora | $9,066,544 | $5,463,119 | 21 |
| orca | $1,335,694 | $1,780,721 | 24 |
| meteoradbc | *not reported* | $0 | 1 |
| **total** | **$21,635,243** | **$32,431,235** | **114** |

52 distinct CoinGecko markets carry these tokens, Σ $282.4 M of 24 h volume across 1,576 tickers.
The top ten by Σ volume: LBank $68.9 M (89 mints), KCEX $47.9 M (47), Raydium (CLMM) $36.4 M (84),
MEXC $28.7 M (141), Ondo Stocks $18.0 M (165), Gate $11.6 M (67), Raydium $8.8 M (9), Bybit $7.9 M
(11), Meteora $6.7 M (65), CoinUp.io $6.1 M (2).

**The venue picture splits the issuers in three**, and it does not follow the ladder:

| issuer | tokens | on a DEX | on a CG market | Σ DEX liquidity | Σ CEX volume | top venue |
|---|---|---|---|---|---|---|
| ondo-global-markets | 212 | **4** | 171 | **$8,104** | **$164,735,316** | LBank (cex) |
| xstocks-backed | 156 | 51 | 81 | $9,136,063 | $80,954,526 | Raydium (CLMM) (cex) |
| backpack-securities | 48 | **48** | 44 | $10,140,331 | $34,879,814 | raydium (dex) |
| tessera | 3 | 3 | 3 | $1,800,516 | $853,438 | meteora (dex) |
| prestocks | 8 | 8 | 6 | $550,229 | $1,002,452 | Meteora (cex) |
| shift / superstate-opening-bell / securitize / bullish | 14 | 0 | 0 | — | — | **none** |

- **Ondo is a CEX product with a token, not a DEX asset.** 212 mints, 4 pools, $8 k of on-chain
  liquidity — against $164.7 M of 24 h CEX volume, 58% of the whole section's. Its own
  "Ondo Stocks" venue quotes 165 of them.
- **Backpack is the opposite**: every one of its 48 mints has a pool, and its top venue is a DEX.
- **14 tokens trade nowhere either source can see** — all four Superstate Opening Bell mints, all
  eight Shift leveraged wrappers, SECZ and the Bullish mint. For those, a "market reality" grade
  built on venue data has no input at all and must say so rather than score 0.

#### Caveats

- **CoinGecko's free tier is ~5 requests/min keyless, not the documented 30.** The 30/min figure
  applies to a Demo API *key*; without one, `coins/<id>/tickers` served 3–6 requests before
  answering 429, whatever the pace. The script therefore doubles its pace on each 429 (2.5 s → 5 →
  10 → 12 s ceiling) and never speeds back up in a run. It converged after **3 rate limits** and
  then ran 400 consecutive requests at 12 s with none, so 12 s (5/min) is the sustainable rate and
  ~85 min is the floor for a full keyless CEX pass. A Demo key would cut it to ~15 min.
- **`tickers[].trust_score` is null for every coin on the free tier** — 0 of 1,576. Re-measured the
  same day against `coins/bitcoin/tickers`: 100 of 100 null. The field is carried through as null
  rather than dropped, and `source.coingecko.tickersWithTrustScore` records the count so the
  emptiness is visible in the data instead of looking like a parse loss. **The MODEL.md §10.3
  `trustScore` field cannot be populated without a key**, so nothing downstream may rank on it.
- **`cex[]` is "markets CoinGecko lists", not "centralised venues only".** CoinGecko mixes DEX
  markets into the same array — Raydium (CLMM), Raydium and Meteora together are $51.9 M of that
  $282.4 M. A consumer splitting CEX from DEX must filter on `marketId`, not trust the array name.
  Note those DEX rows also disagree with DexScreener on the same pools, which is why §10.4 should
  take `traded-on` DEX edges from `dex[]` and CEX edges from `cex[]` rather than mixing them.
- **`is_anomaly` and `is_stale` tickers are not filtered.** This layer reports what the source says.
- **DexScreener's coverage is narrower than Jupiter's, but its liquidity is not systematically
  lower** — the "reported to under-report" caveat above is now measured against `universe.json` on
  the same day:
  - 210 mints have a positive Jupiter liquidity figure; DexScreener indexes **114**. The 96 it
    misses hold **$28,446 in total** (~$296 each) — dust.
  - On the 113 comparable mints the DexScreener/Jupiter liquidity ratio is **p10 0.16, median 1.09,
    p90 2.94**, and DexScreener is the *higher* of the two on 63 of 113. In aggregate its Σ is 25%
    lower ($21.6 M vs $28.9 M), from a few large mints whose pools it does not index.
  - **24 h volume is where the gap is real**: Σ $32.4 M against Jupiter's $140.8 M, a factor of 4.3.
    Some of that is a counting convention (Jupiter's `stats24h.buyVolume + sellVolume`, plus router
    volume across pools DexScreener does not index), so treat the two as not comparable rather than
    one being wrong. **Use Jupiter for volume, DexScreener for venue identity.**
- **A pair can name the mint on its quote side.** Exactly one does (TSMon on `meteoradbc`), so its
  `quoteSymbol` is the counter-asset rather than the quote token and the venue is not lost. It also
  reports no liquidity at all, which stays `null` — not `0`, which would read as a measured empty
  pool.

## Live tape

`fetch-recent-trades.mjs` collects **individual trades** — the one layer of this dataset where
per-trade truth exists, because every swap against a Solana pool is a transaction on the pool's
address that a public RPC will hand over. CEX trades are not available keyless, so the tape covers
sampled DEX pools and says so (MODEL.md §12). `lib/trades.mjs` is pure (66 unit tests in
`trades.test.js`, built on verbatim real transactions) and doubles as the browser module `live.html`
imports.

```bash
npm run stocks:trades                                          # one pass
node stocks/fetch-recent-trades.mjs --run --pools=3 --budget=10 # smoke test; --help for every flag
run-job start trades node stocks/fetch-recent-trades.mjs --run --every=180   # keep collecting
```

- **Sample**: the top 15 DEX pools by `volume24Usd` in `data/venues.json`, re-ranked every run, so a
  pool that goes quiet drops out by itself. Each SOL-quoted pool's `priceUsd/priceNative` from
  DexScreener gives `quoteUsdRate` (USD per SOL, ~$98.4 on 2026-09-16); USDC/USDT are 1 and need no
  request at all.
- **Per run**: `getSignaturesForAddress(pair, {limit: 50})`, then `getTransaction` for the successful
  signatures not already stored, oldest-first, round-robin across pools, capped at 120 transactions.
- **Decode**: the POOL's own token-balance deltas. The pool gaining the token is a `sell`, losing it
  a `buy` — reading the taker's side would be wrong for a routed swap, where the taker holds neither
  asset. `size`, `quoteAmount`, `priceQuote` and `priceUsd` follow; a missing input stays null.
- **Outputs**: `data/trades-24h.json` (rolling store, deduped by signature, pruned to 24 h, keeps
  `collectingSince`) and `stocks-trades.json` at the repo root. `fixtures/stocks-trades.sample.json`
  is 44 real trades from three of the pools, for building the page without a collector running.

### Measured, 2026-09-16 (two consecutive runs)

| | run 1 | run 2 |
|---|---|---|
| signatures seen (15 × 50) | 750 | 750 |
| transactions fetched | 120 | 120 |
| trades decoded | 104 | 84 |
| mentioned-but-not-traded | 16 | 36 |
| unreadable | 6 | **0** |
| wall time | 203.6 s | 210 s |
| window after the run | 104 trades | 188 trades, 134 fee payers, $35.1 k |

Run 2 re-read the same pools and stored **84 new trades and zero duplicates**, which is the dedupe
and the resume in one number.

- **42–49% of recent transactions on these pools REVERTED** (Σ `failedTx` / Σ `signaturesSeen`), and
  it is wildly uneven: SKHY/USDC 96%, METAx/USDC 96%, SPYx/SOL 98% in run 2, CRCLx/SOL 88%,
  GLDx/USDC 82% — against tOpenAI 10% and BROS 0%. These are losing arbitrage bots, and the share is
  the honest measure of how much of a pool's "activity" never happened. They are counted and **never
  fetched**: a reverted transaction changed no balance, so there is nothing in it to decode.
- **`maxSupportedTransactionVersion: 0` is not enough.** The RPC refuses a transaction whose version
  exceeds the one asked for (error −32015) and names the version it wants. Ten of run 2's 120 swaps
  were version 1 — 8% of real trades, silently lost until the refusal was retried at the named
  version. Run 2's `unreadable` count is 0 because of that retry; run 1's 6 were all this.
- **`getSignaturesForAddress` returns every transaction that MENTIONS the pool**, not just its
  trades. An arbitrage bot lists several pools among its accounts and trades through only some, so
  the pool's own vaults come back byte-identical. Verified on BROS (`So111=7446874521`,
  `BRVaZK=69492010` before *and* after, while other pools' balances moved). Those are correctly not
  trades; they are counted `undecodable` and remembered, so a later run does not re-buy them.
- **One sampled pool cannot be decoded at all: DKNG/ALLINU, the section's largest by 24 h volume
  ($5.2 M).** Its vaults are owned by `GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL` — Raydium's
  shared CP-Swap authority — not by the pair address, so the `owner === pair` rule can never match,
  and matching that authority instead would mix pools together. 19 transactions fetched, 0 trades.
  It also quotes in a **memecoin**, so even a decoded trade would have no USD price. It costs ~1/15
  of the budget per run for nothing; excluding it is a MODEL.md decision, not a code one.
- **A zero token balance arrives as `uiAmount: null`** with `uiAmountString: "0"`, and the float is
  lossy besides — one real balance reported `uiAmount: 17852175.049329627` against
  `uiAmountString: "17852175.049329628"`. Every delta is therefore computed from the raw integer
  `amount` with BigInt: exact zero detection (so float residue cannot invent a movement and inflate
  `routed`) and no lost digits.
- **The decode checks out against a source it never saw.** The SPYx/SOL sell in the test fixture
  resolves to **7.6755 SOL** per SPYx; DexScreener quoted the same pool at `priceNative` **7.6946**
  the same minute — 0.25% apart, which is the spread. That assertion is in `trades.test.js`.
- **The tape SAMPLES the hottest pools; it does not capture every trade.** The 50-signature window
  on SPYx/SOL spanned **137 seconds**, and a run takes ~210 s because the public RPC answered 61–74
  **429s** despite the 600 ms pacing (effective throughput ~34 transactions/minute, not the nominal
  100). With `--every` the sleep follows the run, so a pass costs run + interval; 386 successful
  signatures were seen in run 2 against a budget of 120, leaving 235 for later. A complete tape on
  these pools needs a paid RPC, not a smaller interval — the page must say "sampled", and
  `collectingSince` is what bounds any claim made from the window.
- **`pools[].signaturesSeen`, `failedTx`, `decoded` and `undecodable` describe the LAST RUN**, not
  the 24-hour window, so they do not sum to `trades.length`. `collectingSince` is never reset unless
  `data/trades-24h.json` is deleted.

### Round-trip prints are marked, not deleted

A transaction that swaps through the **same pool twice** nets the pool's token delta to almost
nothing while both quote legs land in full, so `quoteAmount / size` explodes. That produced a real
tape row of **"NVDAx buy 0.0082 @ $60,799.88"** for a share worth ~$180 — arithmetically correct,
economically meaningless, and it fed stored `priceUsd` and every hourly volume built from it.

Each pool therefore carries a `refPriceQuote`, its DexScreener price **in quote units**
(`priceNative`, or `priceUsd` for a stablecoin-quoted pool), and a trade is marked
`suspect: "round-trip"` when either

- `|priceQuote / refPriceQuote − 1| > 0.25`, or
- one program was invoked **more than once with the pool among its accounts** (counting inner
  instructions, which is where the AMM actually is — the router CPI's into it).

A suspect row is **kept** — the transaction is real and the page greys it — but `tradeVolumeUsd`
returns null for it, which is the single choke point that keeps it out of every hourly `volumeUsd`,
`totals.volumeUsd` and price statistic. `totals.suspect` counts them so the exclusion is visible
rather than silent. No reference price means "cannot judge", **not** "suspect" — otherwise
DKNG/ALLINU, which has no USD price at all, would have every row greyed.

Measured on a 450-trade window (2026-09-16): **5 suspect, 1.1%** — 1 each on SPYx/SOL, DJT/SOL and
NVDAx/SOL and 2 on SPCX/SOL, all SOL-quoted pools, all caught by the price band.

`--republish` rebuilds `stocks-trades.json` from the stored window with no RPC calls at all: it
refreshes the 15 reference prices from DexScreener (~6 s) and recomputes buckets and totals. The
structural half of the test needs the transaction, which the store does not keep, so a flag already
on a stored trade is preserved rather than recomputed away.

**Do not run it against a live `--every` loop.** The loop holds the store in memory for the whole
pass and flushes every 10 transactions, so its write lands on top of a concurrent republish — and
because it is one long-lived process, a code change does not reach it until the job is restarted.
