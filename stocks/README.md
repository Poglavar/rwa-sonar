# stocks/ — tokenized-stock universe on Solana

Collects every tokenized equity we can find on Solana, its on-chain facts, and the market data
its issuer publishes about it. Collection scripts feed `build-stocks-db.mjs` (grades + `stocks-db.json`, see MODEL.md) and the `stocks.html` page. Node 24, ESM
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
npm run stocks:build    # node stocks/build-stocks-db.mjs --run   → stocks-db.json (repo root)
npm run stocks:sync     # node stocks/sync-assets-db.mjs          → DRY RUN, prints a diff
npm run stocks:sync -- --apply   # writes rwa-assets-db.json + attestations-db.json
# then open stocks.html
```

- **`build-stocks-db.mjs --run`** joins `universe.json`, `onchain.json`, `sponsor-apis.json` and
  `reference-prices.json` with the dossiers in `data/issuers/` and writes `stocks-db.json` exactly
  per MODEL.md §7: an envelope carrying each input's own `fetchedAt`, one record per issuer (dossier
  facts + `grades` + `control` + `market` + `tokenMints`) and one per mint. Tokens join by mint;
  Ondo's API items join on `ticker === underlyingTicker` and only for Ondo tokens. Issuers sort by
  slug and tokens by mint, so rebuilding unchanged inputs produces an unchanged file. It ends with a
  per-issuer line — stage, score, claim rung, verification strength, liquidity, volume, holders,
  median premium, paused mints — and a live-issuers-only total. Everything it is missing is warned
  about by name (a dossier without `status`, an issuer with tokens but no dossier, a mint with no
  on-chain row); nothing missing is ever silently read as zero.
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
  are never written here — they live in the dossiers and in `stocks-db.json`.

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
