# stocks/ — tokenized-stock universe on Solana

Collects every tokenized equity we can find on Solana, its on-chain facts, and the market data
its issuer publishes about it. Collection scripts feed `build-stocks-db.mjs` (grades + `stocks-issuers.json`/`stocks-tokens.json`, see MODEL.md), `build-graph.mjs` (`stocks-graph.json`) and the `stocks.html`/`graph.html` pages. Node 24, ESM
`.mjs`, no npm dependencies (built-in `fetch` only).

## Run order

```bash
node stocks/fetch-sponsor-apis.mjs --run    # npm run stocks:sponsors   → data/sponsor-apis.json
node stocks/fetch-universe.mjs --run        # npm run stocks:universe   → data/universe.json + discovery-candidates.json
node stocks/fetch-onchain.mjs --run         # npm run stocks:onchain    → data/onchain.json
node stocks/build-mint-identities.mjs --run # npm run stocks:mint-identities → data/mint-identities.json
node stocks/fetch-onchain.mjs --run --in=stocks/data/mint-identities.json --out=stocks/data/identity-onchain.json # npm run stocks:identity-onchain
node stocks/build-mint-identities.mjs --run # rebuild with full chain observations
node stocks/fetch-reference-prices.mjs --run # npm run stocks:prices    → data/reference-prices.json
npm run stocks:all                          # complete identity-aware pipeline, in order
```

`fetch-sponsor-apis.mjs` is independent and runs first because its exact-mint registries are an
admission signal for new discoveries. `fetch-onchain.mjs` reads only the admitted
`data/universe.json`, never the candidate inbox. `fetch-reference-prices.mjs` reads both
`universe.json` and `sponsor-apis.json`, so it runs last. Every script prints its usage and exits without doing anything when given no
arguments or `--help`; `--run` is the switch that makes it work. Each one is resumable and
idempotent — progress is checkpointed into `data/raw/` after every query/batch, and a re-run skips
what is already there (`--force` re-fetches everything).

**`fetch-universe.mjs` reads its own previous output before it writes it**, because the universe is
monotonic (`lib/universe.mjs`): a mint the current run's searches did not return is carried over
from the existing `data/universe.json` rather than dropped. So run it in place — pointing `--out` at
a fresh path throws the accumulated `firstSeenAt` history away and makes every mint look new.
It also reads `data/discovery-candidates.json`: a newly searched address is not published unless a
reviewed manual source, issuer exact-mint registry, or concordant verified issuer tag + known
programme authority corroborates it. Uncertain or conflicting identities stay in the durable
candidate inbox and become P1/P0 items in the public evidence-review queue.

## Build and sync

The fetchers only collect. Build steps turn what they collected into the graded database
the stocks page reads, and repair the existing site records (MODEL.md §9):

```bash
npm run stocks:all      # the four fetchers, in order   → stocks/data/*.json
npm run stocks:build    # node stocks/build-stocks-db.mjs --run   → stocks-issuers.json + stocks-tokens.json (repo root)
npm run stocks:legal-templates # → stocks-legal-templates.json + templates/ (canonical URLs need --base-url)
npm run stocks:collector-status # → stocks-collector-status.json (safe public freshness/coverage aggregate)
npm run stocks:review-queue # → stocks-review-queue.json (prioritized missing/stale/changed evidence)
npm run stocks:review-ack -- --event=123 # editor-only: acknowledge one reviewed change event
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
  if present, because assets.html sums every non-general field and storing them shifts the score.
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

### `data/universe.json` — 533 catalogued tokens on 2026-09-20

Trimmed Jupiter record per token (`icon` and the 5m/1h/6h stat blocks dropped) plus:

| field | meaning |
|---|---|
| `issuer` | slug from the Jupiter issuer tag, else from a known mint authority, else from a known shared freeze authority (Superstate, Backpack), else `null` |
| `underlyingTicker` | listed instrument the token tracks, or `null` (private company / unknown issuer) |
| `listedOnJupiter` | `false` for entries that came only from `data/manual-mints.json` |
| `manualSource`, `note` | provenance for manual entries |
| `seenInSearch` | `true` when THIS run's searches returned the mint; `false` for a record carried over from the previous run, whose market numbers are therefore the last ones we saw rather than today's |
| `firstSeenAt` | the run that first returned the mint. Set once and carried over for good, so a mint that drops out and comes back keeps it |
| `lastSeenAt` | the last run that actually returned it — never advanced for a carried-over mint, which is the whole point of recording it |

`source.counts` carries `seenInSearch`, `carriedOverUnseen` and `newThisRun` beside the total.

### `data/discovery-candidates.json` — quarantine before publication

Jupiter search tags are leads, not proof of authenticity. `lib/discovery-candidates.mjs` compares a
new exact mint against issuer registries, reviewed manual sources, known programme authorities,
issuer tags, verification metadata, the inferred underlying ticker and known protocol listings.
Only the first three kinds of corroboration can admit an address automatically; a protocol listing
is useful evidence but cannot establish the issuer or the holder's legal rights. Conflicting issuer
signals are critical. Candidates remain visible across search-ranking gaps and are routed into
`stocks-review-queue.json`; they do not reach `universe.json`, on-chain collection, cards, tables or
asset counts until confirmed.

Per-issuer counts on 2026-09-20: ondo-global-markets 268, xstocks-backed 185, backpack-securities
55, prestocks 8, shift 8, superstate-opening-bell 4 (3 seeded via manual-mints.json), tessera 3,
bullish 1 and securitize 1 (both seeded; allowlisted registered shares that never reach a Jupiter pool).

#### The universe is monotonic, because Jupiter's search ranking is not stable

`lib/universe.mjs` (`mergeUniverse`, pure, unit-tested in `universe.test.js`) merges each run over
the previous file: a returned mint gets fresh data, and a mint the run did not return is KEPT with
its old record and `seenInSearch: false`.

This is not a precaution, it is a measurement. Re-running the same 118 queries on 2026-09-17 against
the 441 mints known on 2026-09-16 **dropped 24 and added 30** — and a direct
`?query=<symbol>` still returned two of the dropped ones (CRWVx `Xs3trf…`, ABTon `129gRo…`) with
their full `stocks`/`xstocks`/`equities` tags. Nothing had been delisted; the ranking inside each
100-record page had simply moved. Before the merge that read as 30 `new-mint` and 24 `removed-mint`
in the daily change log, which is a fabricated event in both directions.

`firstSeenAt` for the 441 mints of 2026-09-16 was seeded from that day's universe `fetchedAt`
(`2026-09-16T20:27:15Z`), the earliest date any file on disk proves, and nothing was backdated
further. That founding cohort is therefore left out of the `newMints` feed: on the first recorded day
every mint in existence was "first seen", so the date is a lower bound, not an arrival anyone watched.

### `data/onchain.json` — 533 mints on 2026-09-20

`{ mint, symbol, issuer, …capability flags…, owner, space }`. The flags flatten the Token-2022
extensions into the things that decide how controllable a tokenized share actually is:
`permanentDelegate` (+`permanentDelegateAddress`), `transferHookConfigured` /
`transferHookProgram`, `pausable` (+`paused`), `defaultAccountStateFrozen`, `transferFeeBps`,
`confidentialTransfers`, `scaledUiAmountMultiplier`, `metadataUri`, `metadataUpdateAuthority`,
plus `mintAuthority`, `freezeAuthority`, `decimals`, `supply`, `tokenProgram` and the raw
`extensionNames`. `source.counts` aggregates them; `source.missingMints` lists mints the RPC had no
account for (none on 2026-09-16).

### `data/sponsor-apis.json`

Seven issuer-side sources, each in its own envelope with HTTP status: PreStocks, Tessera, Ondo
(asset registry, no mints), Superstate (`/v2/instruments`, equities only: CUSIP, Solana token
address under chain id 900, transfer-agent total/circulating supply, split multiplier, burn
address and feature flags), xStocks (the paginated public asset/exact-mint registry plus its
separate proof-of-reserves feed) and
Backpack (currently enabled `.US` Solana deposit/withdrawal addresses). `--only=<source>`
re-fetches a subset and keeps the other sources from the previous file. A failed refresh also
keeps that source's last successful rows, but marks its envelope `ok: false`: consumers must treat
it as cached evidence, never as a current empty registry or proof that every token was removed.

Here `items` is **keyed by source** because the payloads have
nothing in common; `source.sources[id]` carries each one's URL, `fetchedAt`, HTTP status, count and
error. PreStocks gains a computed `premiumPct = (tokenPrice/markPrice − 1) × 100`; Ondo gains
`impliedUnderlyingPrice = marketCap / sharesOutstanding` and keeps a flat `tagSlugs`, with
`priceHistory24h` and `iconSrc` dropped. PreStocks/Tessera sort by mint, Ondo by symbol (its
payload carries no mint). A failing source is reported at the end and makes the exit code non-zero,
but never aborts the others.

### `data/mint-identities.json` — identity is not full catalogue coverage

This provenance-first union joins the market catalogue, issuer exact-mint registries, reviewed
manual sources and finalized mint-account observations. On 2026-09-20 it contains **1,183 exact
Solana addresses**: 899 confirmed by a successfully fetched issuer registry, 533 fully catalogued
and all 1,183 observed on-chain. The remaining 650 await catalogue, market and legal joins—not mint
account verification. The counts are
kept separate deliberately: being listed by an issuer proves token identity, not liquidity,
circulating supply, legal rights or that anybody holds it.

`currentIssuerRegistry` is `listed` / `not-listed` only when that issuer feed succeeded. If the
feed failed, it becomes `last-known-listed` or `unavailable`; failure is never interpreted as a
delisting. Six previously catalogued addresses were absent from the successful 2026-09-20 feeds:
the zero-supply legacy Backpack XYZ mint, plus IVZx, GMEDx, DOCUx, ARWRx and TEFx, all with non-zero
raw supply. Those five xStocks cases are a review queue, not an automatic removal decision.

`data/identity-onchain.json` is the wider chain observation layer. It uses the same parser as
`onchain.json` but reads the full identity register, including issuer-listed addresses not yet in
the product catalogue. The 2026-09-20 pass found every one of the 1,183 accounts and every account
used Token-2022. All 650 registry-only addresses had non-zero mint supply and were unpaused, but
that does **not** mean all supply circulates: the xStocks reserve feed reported positive circulation
for 725 of its 826 returned symbols and zero circulation for 101. Its pagination metadata claimed
926 rows while only 826 were returned, and two current registry products (FGDLx and NWGx) were
missing. `mint-identities.json` therefore publishes separate identity, chain, catalogue and
operational statuses instead of collapsing them into one “active token” boolean.

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
  queries, or seed `manual-mints.json`. **The ranking inside those pages also moves day to day**, so
  the output is the union merged over the previous file and never shrinks — see "The universe is
  monotonic" above.
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
  lib/universe.mjs      PURE: monotonic merge of a run over the previous universe, firstSeenAt/lastSeenAt
  lib/solana-rpc.mjs    getMultipleAccounts batching (100/request) with 429 backoff
  fetch-universe.mjs    → data/universe.json
  fetch-onchain.mjs     → data/onchain.json
  fetch-sponsor-apis.mjs → data/sponsor-apis.json
  fetch-reference-prices.mjs → data/reference-prices.json
  classify.test.js      jest unit tests for lib/classify.mjs
  universe.test.js      jest unit tests for lib/universe.mjs (carry-over, first/last seen, gaps)
  pyth.test.js          jest unit tests for lib/pyth.mjs and lib/env.mjs
```

## Venues

Optional `COINGECKO_API_KEY` in `../.env` (free Demo tier): the fetcher sends it as `x-cg-demo-api-key`, paces
CoinGecko at 2.1 s (30 req/min) instead of the keyless ~5 req/min, so a full run takes ~15 min instead of
~85. Ticker `trust_score` is null on the Demo tier too (measured 2026-09-16), so nothing may rank on it.

`fetch-venues.mjs` answers "where does this token actually trade?" from two keyless sources and
writes `data/venues.json` (MODEL.md §10.3). The two are never merged or summed, because they do not
measure the same thing; the pure helpers in `lib/venues.mjs` do the aggregating and daily rotation.

```bash
node stocks/fetch-venues.mjs --run                    # DexScreener only, ~2 min
node stocks/fetch-venues.mjs --run --with-coingecko  # explicit/manual opt-in to both sources
node stocks/fetch-venues.mjs --run --only-cex --coin-limit=250  # scheduled daily rotation
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
- **Scheduled policy:** the midnight-UTC refresh queries at most 250 unique CoinGecko ids, choosing
  unseen/oldest first. Including the daily coin-list request, the baseline is **7,530 calls in a
  30-day month or 7,781 in a 31-day month**, before retries, against the 10,000-call Demo allowance.
  The current 466-id universe turns over in about 1.9 days. The six-hourly DexScreener refresh
  carries CoinGecko rows forward with their original timestamp rather than wiping or re-dating them.
- Every response is checkpointed **per item** to `data/raw/venues-checkpoint-<date>.json`, so a
  killed or rate-limited run resumes the same day and re-fetches only what failed (`ok`/`empty`/
  `not-found` are reused, `error` is retried). Verified: a run killed mid-phase resumed having made
  zero DexScreener requests, and a same-day re-run finished in **0.12 s with byte-identical
  `items`**. The file is shared, so never run two instances at once.

### `data/venues.json` — 441 items, one per mint, sorted by mint

`{ fetchedAt, source: { note, dexscreener, coingecko, checkpoint, inputs }, items: [ { mint, symbol,
issuer, coingeckoId, dexFetchedAt, cexFetchedAt, dex: [...], cex: [...] } ] }`

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

- **A full daily CoinGecko pass does not fit the free quota.** The current 466 mapped ids require
  467 requests including the coin list: **14,010/month at 30 days** or **14,477 at 31 days**. That
  is why the scheduled job rotates 250 ids rather than pretending “daily” means every asset daily.
- **Carried-forward CoinGecko prices are not live prices.** They remain useful for venue coverage,
  reported volume and last-trade context, but once the CoinGecko snapshot is more than two hours
  older than the combined venues file it is excluded from the live cross-venue spread calculation.

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
  Both live outputs are runtime state and are gitignored; the first is the collector’s durable local
  store and the second is its public-page payload. Tests always read the deterministic fixture.

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

## After-hours premium

`npm run stocks:afterhours` (`stocks/build-afterhours.mjs --run`) → **`stocks-afterhours.json`**:
per tokenized stock, the premium it traded at while its underlying market was **open** against the
premium it traded at while that market was **closed**, and the gap between them.

The session boundary is not guessed. Every equity feed in the **keyless** Hermes feed list
(`/v2/price_feeds`) carries `attributes.schedule`, Pyth's market-schedule string:

```
America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/C,1127/0930-1300,1225/C,...
```

`<IANA timezone>;<7 weekly entries Mon..Sun>;<holiday overrides MMDD/...>`, an entry being `C`,
`HHMM-HHMM`, or ranges joined by `&` (a lunch break). `stocks/fetch-reference-prices.mjs` now
persists that string and the feed's `marketHours` (`{isOpen, nextOpen, nextClose}`) on every item
that matched a feed — **355 of 441 tokens** — and because the feed list needs no key, those fields
are filled in whether or not the key may read that feed's *price*. Only prices need the entitlement.

`stocks/lib/market-hours.mjs` parses the string and answers `sessionAt(schedule, atMs)` →
`open | closed | holiday | unknown`, converting the instant into the schedule's own timezone with
`Intl.DateTimeFormat.formatToParts` (so DST needs no table), open **inclusive** and close
**exclusive**, holiday `C` reported in its own right and a half-day override (`1127/0930-1300`)
honoured as a shortened trading day. Unparseable text yields `null`, and a null schedule is
`unknown` — never "closed".

`stocks/lib/afterhours.mjs` then, per mint with **both** a parsed schedule and a reference price:
premium per trade = `priceUsd / refPrice − 1` in percent, trades bucketed by session (a holiday
counts as closed), each side the **median** of its bucket or `null` below **5 trades**, and
`gapPct = closedPremiumPct − openPremiumPct` (null if either side is null). Suspect (round-trip)
trades and trades with no USD price are excluded and counted in `skipped`. A mint with no Pyth feed
— PreStocks' private companies, Tessera, and DJT/DKNG which matched a feed but have no reference
price — has no listed market to be open or closed at all, so it is **omitted** and listed in
`omittedMints` with its reason and trade count rather than emitted as a row of nulls.

**The caveat, restated in the file's own `note`:** `refPrice` is the *last* reference price at
build time, not a per-trade historical reference. While the underlying is shut that price does not
move, so the closed-session figure is sound; the open-session figure is measured against a
reference that has since moved. Re-run `stocks:prices` and this build together.

Measured on the first 2664-trade window (2026-09-16, collected 19:55–22:47 UTC): 10 measurable
mints, **1825 closed-session trades and 8 open-session ones** — the tape started five minutes
before the 16:00 New York close, so only METAx has both sides (open −1.23%, closed −1.19%, gap
+0.03%). Widest closed-session premiums: CRCLx −5.44% on 276 trades, SPCX +3.49% on 243, GLDx
−1.90% on 372. The gap column only becomes meaningful once the tape spans a whole session.

## Holders

`fetch-holders.mjs` answers "who actually holds this token?" from the chain rather than from an
aggregator — the concentration layer behind the claim that a tokenized share has a market.
`lib/holders.mjs` is pure (60 unit tests in `holders.test.js`, every fixture a verbatim mainnet
response) and does all the arithmetic; the fetcher only calls the RPC, checkpoints and shapes.

```bash
npm run stocks:holders                          # node stocks/fetch-holders.mjs --run
node stocks/fetch-holders.mjs --run --max=5     # smoke test; --help for every flag
node stocks/fetch-holders.mjs --run --force     # ignore today's checkpoint and re-read everything
run-job start holders node stocks/fetch-holders.mjs --run   # ~4 min; outlives the agent
```

Needs `SOLANA_RPC_URL` in `../.env` (Alchemy free tier is enough). Only the RPC **host** is ever
logged. The public endpoint is the fallback and will rate-limit a 441-mint run.

### Three phases, one run

1. **The supply.** `getMultipleAccounts({encoding:'jsonParsed'})` over the 441 **mint** addresses,
   5 batches of 100, for each mint's current `supply` and `decimals`.
2. **The balances.** `getTokenLargestAccounts` once per mint → the up-to-20 biggest **token
   accounts** and their raw amounts.
3. **The wallets.** `getMultipleAccounts({encoding:'jsonParsed'})` over those token accounts, in
   batches of 100, for each account's `owner` and its frozen/initialized `state`.

Token accounts are not holders — one wallet can hold several — so `dedupeOwners()` collapses them
and `distinctOwnersTop20` says how many wallets the 20 accounts actually are.

**The supply is read in the same run as the balances, and that is the whole point of phase 1.** The
first run took the denominator from `data/onchain.json`, fetched eight hours earlier, and **66 of
441 mints came out holding more than 100% of their own supply** — CRCLon at 3,483%. Twenty-seven of
those were the stale denominator; the other 39 were the arithmetic (below). `onchain.json` is still
read, for the authority **labels** only, and the output records `supplyFetchedAt` separately from
`inputs.onchainFetchedAtLabelsOnly` so the two can never be confused again.

### Shares are raw/raw, and cumulative shares are one division

`supplyUi` and `amountUi` are **raw base units / 10^decimals**. The Token-2022 scaled-UI multiplier
is deliberately **not** applied even though 200 of the 441 mints carry one: the RPC applies it to a
token account's `uiAmount` but **not** to the mint's `supply` (measured 2026-09-16: AAPLx amount
`11406226514867` with decimals 8 came back as `uiAmount` 114435.13612376, a ×1.0033 on a raw
114062.26514867), and it accrues over time, so dividing a scaled numerator by an unscaled
denominator would overstate every share by the multiplier. Raw over raw, the multiplier cancels.
Multiply by `onchain.json`'s `scaledUiAmountMultiplier` yourself for the issuer-displayed count.

`top1SharePct` / `top5SharePct` / `top20SharePct` are **Σraw / supply — one division**, not a sum of
the per-account quotients. 39 mints are held *entirely* by their top 20, and summing `n` rounded
quotients put them at `100.00000000000001`: a share above 100% that no denominator could fix,
because it was the arithmetic. `Σraw` is exact in BigInt, so a fully-held mint is exactly `100` and
"a share over 100% is a bug" is a real invariant. The run prints how many mints break it.

A mint with **no supply figure, or supply 0** (24 of the 441 — HSDT and the unminted Ondo mints)
reports **null** shares, never 0. HSDT has supply `0` and still answers with 20 live allowlist
accounts, and a 0% there would read as "measured, holds nothing" for accounts that hold every token
in existence.

### Labels are deliberately tiny

`ownerLabel` is `issuer-authority`, `burn-address`, or **null**. An owner is only named when
something in this repo can name it, because a guessed label ("probably an exchange") gets read as
evidence. `null` is the honest "we know the wallet, not who holds it".

- **`issuer-authority`** — the key is an authority over one of the 441 mints. Read from data, never
  hardcoded: the authority *address* fields of each `onchain.json` record (`mintAuthority`,
  `freezeAuthority`, `permanentDelegateAddress`, `metadataUpdateAuthority`) **plus** every authority
  on the live mint accounts phase 1 already fetched — `mintAuthority`, `freezeAuthority` and each
  extension's `authority`/`delegate`/`updateAuthority`.
- **`burn-address`** — the single entry in `KNOWN_OWNERS`: Superstate's shared Solana equity burn
  address, cited by its dossier, by `burnAddressSolana` on every Superstate instrument in
  `sponsor-apis.json` and by `findings.md`. A burn label wins over an authority label for the same
  key, because "this supply was retired" is the stronger statement.

Reading the extension authorities off the live mint accounts is what closes the gap: `onchain.json`
flattens the Token-2022 extensions to capability *flags* and keeps only two authority addresses, so
**`S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS`** — the `scaledUiAmountConfig` authority shared by
all 156 xStocks mints, and the largest holder of essentially every xStock — appeared in no field of
it and went unlabelled. It is now labelled from the chain, in the same run, with nothing hardcoded.
Labels are global rather than per mint: an issuer's authority key holding a position in a *different*
issuer's token is exactly the kind of thing worth seeing.

### `data/holders.json` — 441 items, one per mint, sorted by mint

`{ fetchedAt, source: { note, rpcHost, supplyFetchedAt, …counts…, checkpoint, inputs, errors },
items: [ { mint, symbol, issuer, supplyUi, top20: [ { tokenAccount, owner, amountUi, sharePct,
state, ownerLabel } ], top1SharePct, top5SharePct, top20SharePct, distinctOwnersTop20,
frozenAccountsTop20 } ] }`

`top20` is the top **token accounts**, biggest-first. An account the RPC answered `null` for (closed)
or that a failed batch never resolved keeps `owner: null` — and two unread accounts stay two
unknowns rather than collapsing into one wallet. An account naming a *different* mint than the one
queried is reported as a `mintMismatch` and not attributed to either.

Every phase checkpoints into `data/raw/holders-checkpoint-<date>.json` and the three resume
**independently**, so a failure in one never costs the others their requests. That file is shared —
never run two instances at once.

### The `holders` block on token records

`build-stocks-db.mjs` reads `data/holders.json` as an **optional** input (like `venues.json`: it
warns by name when missing and leaves the block `null`, which reads as "not collected" rather than
"nobody holds it") and puts a slim block on every token in `stocks-tokens.json`:

```json
"holders": { "supplyUi": 153763.45, "top1SharePct": 74.18, "top5SharePct": 82.84,
             "top20SharePct": 82.84, "distinctOwnersTop20": 2, "frozenAccountsTop20": 0,
             "top1OwnerLabel": "issuer-authority", "fetchedAt": "..." }
```

The `top20` list itself is **not** carried over — it is ~1.8 MB of the 2.4 MB `holders.json`, and
`stocks-tokens.json` has a byte budget `stocks-page.test.js` asserts. A consumer that wants the
individual accounts reads `holders.json`. `sources.holders` in both built files carries the file's
own `fetchedAt` plus its `supplyFetchedAt`.

## Monitor, snapshots and change log

`monitor.html` is the health monitor: the four overall status counts, separate market, control,
legal/evidence and DeFi-composability distributions, which rule is the worst failing check across the universe, the
"New on Solana" ticker of mints the universe first saw
in the last fortnight (also on `stocks.html`), every mint in one filterable and sortable table, what
changed since yesterday, the curated event log, and the Meteora pools joined against the collected
trade tape. **It never re-implements a health rule.** Every status on that page is read from the
API, loaded from the verdicts `build-health.mjs` writes using `lib/health.mjs` — the one copy of the
eleven checks. `monitor.js` only shapes, filters, sorts, joins and renders; its pure section is
exported and covered by `monitor-page.test.js` in the repo root (`npx jest monitor-page`).

```
npm run stocks:snapshot     # node stocks/snapshot.mjs --run  → stocks/data/history/<date>/
npm run stocks:changes      # node stocks/build-changes.mjs --run → stocks-changes.json
```

### Daily snapshots — `stocks/data/history/<date>/`

`snapshot.mjs --run [--date=YYYY-MM-DD]` freezes one day of the universe into
`tokens.json` and `issuers.json`, each `{date, builtAt, healthGeneratedAt, items:[...]}` sorted by
mint / slug. `builtAt` is the **source build's** timestamp, not the time the snapshot ran, so a day
reconstructed after the fact still says which build it describes. Only the diffable fields are kept
(`lib/changes.mjs` `snapshotTokenRow` / `snapshotIssuerRow`): identity, the four control booleans
plus the transfer fee, liquidity / volume / holder count, premium, venue spread, the holder
concentration and the health verdict. `supplyRaw` and `uiMultiplier` stay **strings** — both exceed
what a double represents exactly — and are compared as numbers only at diff time.

Every recorded number is cut to **six significant figures**, which is what makes a re-run
byte-identical: re-snapshotting an unchanged day produces no git diff at all. Re-running the same
date simply overwrites it. A day of 441 mints is ~250 KB; that is close to the floor for rows keyed
by readable names (the 21 field names alone cost ~130 KB across 441 rows), so a real reduction means
dropping fields or going columnar, not reformatting.

An older day can be synthesised from a committed build:

```bash
git show <ref>:stocks-tokens.json  > /tmp/tokens.json
git show <ref>:stocks-issuers.json > /tmp/issuers.json
node stocks/snapshot.mjs --run --date=2026-09-16 \
    --from-tokens=/tmp/tokens.json --from-issuers=/tmp/issuers.json --from-health=none
```

A build older than the holders fetch or the health rules leaves those fields `null`, and **a field
that is null on either side can never fire a numeric or health change** — so a reconstructed day
cannot invent movement. That is why the 2026-09-16 → 2026-09-17 diff lists no health change even
though all 441 health fields differ: the earlier build had no health file at all.

### The change log — `stocks-changes.json`

`build-changes.mjs --run [--days=30]` diffs every consecutive pair of snapshot days and writes
`{generatedAt, kinds:[{id,label}], days, latest:{from,to,changes}, history:[{from,to,counts}],
newMintWindowDays, newMints, eventKinds, events}`. The **full** change list is kept for the newest
pair only; every older pair is reduced to counts per kind, so the file stays small however many days
accumulate. `kinds` travels with the data so the page groups the log in the order the diff declares
rather than keeping its own copy. `events` is `stocks/data/events.json` newest-first, with that
file's own kind descriptions.

`diffSnapshots` (pure, `stocks/changes.test.js`) reports only moves worth a line:

| kind | fires when |
|---|---|
| `new-mint` / `removed-mint` | the mint is on one side only — an absent mint has *gone*, it has not been paused. `new-mint` also carries `firstSeenAt`. Since the universe became monotonic a mint Jupiter's search merely skipped is present on both days with `seenInSearch: false`, so it is **not** a removal; the kind now fires only when a mint really leaves the build |
| `paused` / `unpaused` | `control.paused` flipped |
| `rebase` / `reverse-split` | `uiMultiplier` ratio ≥ 1.05 / ≤ 0.5 — a restatement of every holder's balance |
| `multiplier-change` | any other multiplier move ≥ 0.1 %, so ordinary accrual drift stays out |
| `health-worse` / `health-better` | the status moved within good < caution < warning; **any transition into or out of `unknown` is ignored** |
| `liquidity-drop` / `liquidity-rise` | a fall > 50 % or a rise > 100 % **from ≥ $1,000** — a $3 pool doubling is not news; a 50.0 % fall does not fire, a 50.1 % one does |
| `spread-wide` | `venueSpreadPct` crossed *above* 5 — already-wide stays quiet |
| `frozen-appeared` | `frozenAccountsTop20` went 0 → ≥ 1 |
| `control-change` | `pausable`, `clawback`, `allowlist` or `hookActive` flipped (one record each) |

#### `newMints` — the "New on Solana" strip

`selectNewMints` (pure, same test file) reads `stocks-tokens.json` and returns every token whose
`firstSeenAt` falls inside the last **14 days**, newest first, as `{mint, symbol, name, issuer,
issuerName, firstSeenAt, cardSlug}` — the slug from `lib/cards.mjs` `assignSlugs`, so a chip links to
the card the build actually wrote. `stocks.html` and `monitor.html` scroll it as the "New on Solana"
ticker (`newMintChips` in `stocks.js` / `monitor.js`, styled in `stocks.css`), and the monitor's data
line carries the count as a link to the strip. Two exclusions keep it honest:

- a token with **no `firstSeenAt`** is left out rather than dated today (a build older than the
  provenance fields says nothing about when its mints appeared);
- a token first seen **on or before the first recorded snapshot day** is left out, because on that
  day every mint in existence was "first seen" — 441 of them — and `firstSeenAt` is a lower bound
  there, not an arrival.

The chip says *first seen*, not *minted*: it is the day Jupiter's search first returned the mint to
this pipeline. On 2026-09-17 the feed had 30 mints, of which 8 had a first pool younger than three
days; the rest are older mints the search only surfaced then.

Records come out ordered by mint, and within a mint in the declared kind order, so the same two days
always produce byte-identical output.

### What the monitor page reads

The health distributions, facets and paginated token rows come from `/api/facets` and
`/api/tokens`. The remaining sections read `stocks-tokens.json` (market numbers, reference
premium, last trade, and the issuer display names — note `issuerIndex` is an **array** of
`{slug, name, …}`, not an object keyed by slug), `stocks-afterhours.json` (the session gap),
`stocks-changes.json`, `stocks/data/meteora.json` and `stocks-trades.json` (per-pool failed-signature
share and newest trade), plus `cards/index.json` when it exists — a mint the card index names uses
that slug, otherwise `fmt.cardSlug(symbol, mint)`. The tiles take their counts from API facets
rather than recounting, so a tile cannot disagree with the filtered result; a pool the trade
collector never reached shows a dash for its failed share, never `0 %`; and `unknown` sorts last in
**both** directions, because "not measured" is not the smallest liquidity in the set.

## Cards and health

Two builders, both pure-function-first and both re-runnable at any time from the files already on
disk — neither touches the network.

```
npm run stocks:health                                     -> stocks-health.json   (repo root)
npm run stocks:cards -- --base-url=https://rwasonar.com   -> cards/               (gitignored)
```

### `stocks-health.json` — the thin one

`build-health.mjs` runs the eleven `lib/health.mjs` rules over every mint and keeps only the verdict.
The conservative overall status remains, but every item also carries independent `market`,
`control`, `legal` and `composability` dimension verdicts; the top level carries their count distributions:
`{generatedAt, sources, counts, dimensions, byDimension, byWorstRule, rules: HEALTH_RULES,
items:[{mint, symbol, issuer, status, worstRuleId, dimensions, rules, values}]}`,
sorted by mint. No rule `inputs`, no notes — that keeps it at about **402 kB** for 471 mints, small
enough for a page to fetch despite the four dimension verdicts, which is why it is written compact.
Values are cut to six significant figures. `rules` carries the rule
definitions once, so a consumer can label and threshold a status without importing anything.

A rule whose inputs are missing is `unknown`, and `unknown` is never counted as bad: `counts.unknown`
is its own number and `byWorstRule` only counts judged statuses.

### `cards/` — one static page per token

`build-cards.mjs` writes `cards/<slug>.html`, `cards/<slug>.json` and `cards/index.json`
(`[{slug, symbol, mint, issuer, status}]`, sorted by slug). It reads the built market files plus the
reviewed `stocks/data/composability-templates.json` and observed `stocks/data/defi-usage.json` —
`stocks-tokens.json`, `stocks-issuers.json`, `stocks/data/holders.json`, `stocks/data/venues.json`,
`stocks-trades.json`, `stocks-afterhours.json`, `stocks/data/meteora.json` — and calls
`evaluateHealth` **itself** rather than reading `stocks-health.json`, because a card shows each
rule's `inputs` and the health file deliberately drops them.

- **Everything is rendered at build time**, so a card is complete with JavaScript off. `card.js` only
  appends the relative age to each `<time>` and wires the copy-mint button.
- **`--base-url` is required for `og:url` and the canonical link.** Without it both tags are simply
  absent and the run says so: a builder has no request to derive an origin from, and a wrong
  absolute URL in a shared card is a dead link nobody sees fail.
- **Slug** = the symbol when it matches `^[A-Za-z0-9._-]+$`, else the symbol with each unsafe run
  hyphenated, else `mint-<first 8>`. Two tokens wanting one slug (compared
  **case-insensitively**, because macOS is case-insensitive and the server is not) both get
  `-<first 6 of mint>`. None of the 471 symbols collide today, so `stocks.js` computes a row's
  "Card ↗" link with `fmt.cardSlug` instead of fetching the index; `stocks/cards.test.js` fails the
  day that stops being true.
- **Determinism**: nothing reads a clock, every number is cut to six significant figures, and
  `builtAt` appears in exactly two places (one `<time datetime>` and the record). Two builds from the
  same inputs are byte-identical apart from that stamp — pinned by a test, and easy to check by hand
  with `diff <(sed 's/builtAt[^,]*//' …)`.
- **Size**: the 517-card production build reached 100.8 kB at the top end on 2026-09-19; the build FAILS on any
  card over `CARD_BYTE_BUDGET` (104 kB). The ceiling retains tight headroom after adding action-level
  DeFi custody mechanics, account corroboration and the lender exit verdict, without silently dropping
  a required section.
- **The published record** (`cards/<slug>.json`, and the same bytes inlined as
  `<script type="application/json" id="card-data">`) is therefore the machine-readable half: identity,
  every rule's status, value and `inputs`, the numbers, holder shares, the control surface, the
  venues and the per-source timestamps. `<` is escaped as `<` so dossier prose can never close
  the script element early.
- **At most five wallet addresses per card**, each shown truncated with the full address in a
  `title`. A card is not a holder dump; the top-20 list stays in `stocks/data/holders.json`.
- `card.html?mint=…` / `?symbol=…` at the repo root is a 1 kB shim: it resolves the token against
  `cards/index.json` and replaces itself with the card, so a card can be linked by mint or ticker
  without knowing its file name. With JavaScript off it says so and links to `stocks.html`.

`cards/` is gitignored — 882 files that change on every refresh. Rebuild it on the server as part of
the refresh; never edit a card by hand.

### One copy of the formatters

`stocks/lib/fmt.js` is UMD-wrapped (`module.exports` in node, `window.__rwaFmt` in a browser) and
holds the display formatters — `fmtMoney`, `fmtPrice`, `fmtPct`, `fmtSignedPct`, `fmtNumber`,
`fmtDateTime`, `fmtRelativeTime`, `escapeHtml`, `isSafeUrl`, `humanizeSlug`, `DASH`, `cardSlug`,
`roundSignificant` and the rest. `stocks.js` resolves it (`typeof __rwaFmt !== 'undefined' ? __rwaFmt
: require(...)`) and re-exports the same objects, and `stocks.html` loads it **before** `stocks.js`;
the ESM builders `import fmt from './lib/fmt.js'`. There is no second copy of any of them, and
`stocks-page.test.js` asserts both the identity of the shared objects and the script order.

## Funnel and recipes

Two dimensions added on 2026-09-17, both pure and both built rather than counted in the browser.

### The control recipe — `stocks/lib/recipe.mjs`

`controlRecipe(token)` reads a built token record (`{tokenProgram, control}`) and returns
`{program, extensions, label}`: the token program by name, the control extensions that are **ON**,
and one display label — `token-2022 · pausable + clawback`. It lives in its own file rather than in
`lib/grade.mjs` (already 590 lines of scoring rules) because three callers group by it, and a label
spelled two ways is two recipes.

- `extensions` is `pausable`, `clawback` (permanent delegate), `allowlist` (default-frozen account
  state), `transfer-fee`, `transfer-hook`, always in **that** canonical order and never
  alphabetical: the label is a fixed sentence, so the same switches always produce the same string.
  Adding a flag means appending to `RECIPE_EXTENSIONS`, never re-sorting it.
- **`transfer-fee` is ON whenever the extension is installed, 0 bps included.** A recipe is what the
  issuer *can* technically do, and a configured 0 bps still reserves the right to charge — the same
  reading the issuer card's Fee badge already gives.
- **`unknown` and `… · none` are different facts.** A mint whose control flags are all null has not
  been read from the chain yet and is labelled `unknown`; a profiled mint with nothing switched on is
  `token-2022 · none`. A raw program id nobody knows becomes `unknown` in the program slot rather
  than being printed as an id.
- The raw-id → name mapping is `tokenProgramName()` in `lib/classify.mjs` — the one place it exists,
  now exported, and it passes an already-mapped name through so either shape can be handed to it.
- Every token record carries `recipe`, and every issuer record carries `recipes: [{label, mints}]`
  (`recipeTally`, sorted by mints desc then label). Those counts always sum to the issuer's
  `tokenMints.length`; `funnel.test.js` asserts that against the built files.

Six recipes across 471 mints on 2026-09-17: `pausable` (230, Ondo), `pausable + clawback` (224,
xStocks + Backpack + Shift), `pausable + clawback + transfer-fee` (8, PreStocks), `clawback +
allowlist` (4, Superstate), `transfer-fee` (3, Tessera), `pausable + clawback + allowlist` (2,
Securitize + Bullish). One token program, Token-2022, holds all 471; no transfer hook is active
anywhere.

### Confirmed DeFi use — `stocks/data/defi-usage.json`

`npm run stocks:defi` builds an observed-use record for **every current mint**, including an empty
`integrations[]` when nothing is confirmed. This layer does not infer use from Token-2022
compatibility or from an issuer naming an ecosystem partner. It accepts only:

- an exact collateral mint in Kamino's live `/markets/collateral-reserves` registry, including
  market size, debt category and current LTV/liquidation terms;
- an exact collateral mint in Jupiter Lend's live borrow-vault registry, including enabled debt
  assets, deposited collateral, open positions and current LTV/liquidation terms;
- an exact collateral mint in Nest's versioned mainnet deployment manifest, including the canonical
  market/vault addresses and nUSD LTV/liquidation terms;
- an exact mint in Project 0's current hosted bank registry, counted only when its bank is
  operational, collateral-tier and has a positive initial collateral weight;
- an exact liquidity mint in Save's official reserve API, counted as collateral only when its
  configured loan-to-value ratio is positive;
- an observed DEX pool for the exact mint, with Meteora pools cross-checked against Meteora's own
  per-pool API where possible; or
- a reviewed asset-specific live product in `data/defi-integrations.json`, currently the Veda vaults
  for SPYx, QQQx and NVDAx exposed through Kraken Pro and curated by Sentora.

Each integration names its protocol, status, available actions, access restrictions, live metrics,
product link and evidence link. Actions are also published as explicit capability records: what the
user can do, whether a protocol account takes custody, and whether enforcement is by code alone or
also depends on an operator. Lending records retain the terms their source actually exposes: maximum
and liquidation LTV, liquidation penalty, oracle provider/staleness, collateral weights, utilisation
and capacity limits where available. `live` means current value or activity is observed; `available`
means a protocol market/pool is configured but the checked source does not establish current value
or activity.

The collector also extracts every protocol-published pool, reserve, vault, bank, collateral-config
and oracle account address, then checks them in batches with Solana `getMultipleAccounts`. Existence
on chain corroborates the published account and its owner; it does **not** prove that the protocol's
marketing, legal claim or liquidation economics are correct. The 2026-09-19 run checked 189 unique
accounts: all 189 existed, corroborating 152 of 155 integrations. The remaining three are the
hand-reviewed Veda products, whose official product pages do not publish a directly attributable
Solana vault address.

The
six-hourly server refresh runs this after `stocks-tokens.json` is rebuilt, so a newly discovered mint
cannot inherit another asset's integration. The 2026-09-19 snapshot covers 471 assets: 118 have at
least one confirmed use, 27 have at least one lending/collateral integration (12 Kamino, 4 Jupiter
Lend and 22 Nest; protocols overlap on some assets), 3 have a yield vault, 114 have a DEX pool, and
353 have none confirmed. Project 0's 145 current bank rows and Save's 753 current reserve rows were
checked on the same run and matched zero stock-token addresses; those zeroes are published as checked
coverage, not silently treated as proof that every other lending protocol was also checked.

The every-mint table gives each asset a compact protocol/action list; its detail panel and generated
card show metrics and evidence. This is deliberately separate from the next structural assessment:
an asset can be technically composable with no adopter, or actively used despite material legal and
control risks.

### Daily protocol watch — `stocks-defi-changes.json`

The midnight UTC refresh writes `stocks/data/history/<date>/defi.json`: one slim row per exact token
address and protocol, with status, maximum and liquidation LTV ranges, liquidation penalty, oracle,
capacity and utilisation fields, corroborated-account counts, and deposited collateral value where
the protocol reports them. The first day is only a baseline. Every later day is
compared with the previous daily snapshot by `stocks/build-defi-changes.mjs`, which reports:

- a token address added to or removed from a protocol's observed registry;
- any change to a configured maximum LTV range where both days report one;
- a market changing from `live` to a non-live status; and
- lending collateral value falling at least 25% when the previous value was at least $100,000.

The value floor keeps a tiny or empty market from generating dramatic percentage alerts. A missing
measurement is unknown, not zero, and never fires an LTV or collateral-value event. Human text says
“token”; every event still carries the exact mint address and both snapshot timestamps as evidence.

`stocks-defi-changes.json` publishes the full comparison and up to six compact `noticeLines`. The
central `alerts-server-telegram` monitor checks only the 00:17 refresh for this purpose, retains
those lines across its hourly checks, and includes them in its single 06:00 UTC morning digest. The
other six-hourly refreshes do not write protocol snapshots or send messages. If the midnight
protocol fetch fails, no stale snapshot is written; the next successful midnight compares with the
last genuine observation, while the normal refresh-health alert reports the failed run.

```bash
npm run stocks:defi-snapshot
npm run stocks:defi-changes
```

### Saved comparison watches — Postgres + the morning digest

The same-stock workbench can save a comparison on the server. `POST /api/watchlists` returns a
random watch id and owner key; only the key hash is stored. The cross-device link carries the raw
key after `#`, so nginx and API request logs never receive it. There are no user accounts or
cookies: possession of the link is authority to read, replace or delete that watch.

The midnight refresh runs `stocks/build-watchlist-changes.mjs` after the database load. A new or
edited watch records a baseline without raising an alert. Later daily runs compare cash-redemption,
confirmed collateral, exit-after-default, confirmed protocol list, legal-review status and a
greater-than-40% liquidity fall. The job writes the latest per-watch changes back to Postgres and
adds bounded, key-free `noticeLines` to `.last-refresh-stats.json`. The central monitor therefore
delivers them in the existing single 06:00 UTC Telegram digest; it does not send per-change or
per-user messages.

```bash
npm run stocks:watchlist-changes
```

### DeFi composability — `stocks/data/composability-templates.json`

Composability is reviewed once per **issuer legal programme + exact control recipe**, not copied as
471 apparently independent opinions. The current universe has nine such combinations. A coverage
test compares their keys with every current token, so a newly discovered issuer or extension mix is
`unknown` and breaks the test until somebody reviews it; it never inherits a nearby conclusion.

The headline status asks one narrow question: can a permissionless smart-contract lender custody the
token and realise value after borrower default without discretionary issuer help? The token page and
card now turn that into a separate **exit-after-default** verdict: autonomous, conditional,
issuer-dependent, fragile, unavailable or unknown. It deliberately separates technical custody from
economic control and combines the reviewed default outcome with confirmed collateral markets, exact-
token DEX exits and holder redemption rights. Each template also
answers four outcomes separately: smart-contract escrow, borrower default, protocol hack and
inaccessible contract/key. The last two are deliberately not reduced to “good” or “bad”: a permanent
delegate may rescue a hacked protocol while also making otherwise valid protocol custody non-final.
Every template therefore says both what the mint can technically do and whether possession carries
the legal/economic right a lender expects. An issuer capability is never presented as a duty to help.

As reviewed on 2026-09-19, 398 mints are `caution` and 73 are `warning`; none qualifies as fully
permissionless `good`. Tessera is closest to autonomous collateral because its contingent redemption
right follows the token, but its transfer fee and freeze authority still require explicit protocol
support. The allowlisted registered-share templates are legally strong assets but poor generic DeFi
collateral: the escrow and liquidation accounts must be approved by the transfer agent.

### The funnel — `stocks/lib/funnel.mjs` → `stocks-funnel.json`

`buildFunnel(tokens, issuers)` counts the four columns the stocks page draws above the grid — mints
by instrument type → issuer programmes → control recipes → token programs — plus one edge per step
carrying the number of mints that take it. `build-stocks-db.mjs` writes it as the third repo-root
file, `stocks-funnel.json` (~7 kB, same `builtAt` as the other two), so the graphic shows the
build's own numbers and a test can pin them.

- A column's `total` is **the mints represented in it**, i.e. the sum of its node counts — not the
  number of nodes. The reader gets "12 programmes" by counting circles; the heading prints
  `total` for the mints column and the node count for every later one, which is the funnel itself:
  471 → 12 → 6 → 1.
- **An issuer with no mints is a node with `count: 0` and its `status`**, not an omission, so the
  page's count of programmes and the funnel's cannot disagree. The graphic draws those hollow.
- A mint whose issuer we cannot name keeps its mint, recipe and program node and **loses its two
  issuer edges** rather than being invented into a programme; the issuers column's total is then
  visibly lower than the mints column's, which is the honest reading.

The graphic itself is an inline SVG built by `stocks.js` from `funnelLayout(funnel, {width, height})`
— a pure function in the same CommonJS tail as the other page helpers. Circle **area** is
proportional to the mint count (`r ∝ √count`, against the biggest count anywhere in the funnel, so a
circle is comparable across columns) with a floor so a one-mint programme is still a dot; connector
width follows the edge count, also floored; every `y` is clamped inside the box, and an edge whose
endpoints are not both nodes is dropped instead of drawn to nowhere. Issuer circles carry
`data-slug`, so the page's existing click delegate opens the dossier (Enter/Space are wired by hand,
because an SVG group is not a button). Colours are the theme's own custom properties, so dark and
light need no second set of values; `stocks-page.test.js` asserts there is no literal colour in the
block. The SVG keeps its natural 1100 px width and `.funnel-scroll` scrolls at phone widths — the
page body never does.

There is no sample fixture for the funnel, so `?db=sample` skips the fetch and the section hides
itself rather than mixing live counts into fixture ones. Same for a missing file.

## The `sonar` Postgres schema

The built files answer the questions the pages ask. They cannot answer a question that needs a
*group by* across two of them, or one that needs yesterday as well as today, and the trade tape
throws away everything older than 24 h on every publish. So the same data is also loaded into
schema **`sonar`** of the one shared Postgres database (`geodata` — same name on the laptop, on
valhalla and on prod; never a new database, always a new schema).

    node stocks/load-db.mjs --run [--ddl] [--only=issuers,tokens,snapshots,trades,claims,whatif]
    npm run stocks:db

`db/2026-09-17-sonar-stocks.sql` is the DDL: idempotent, re-runnable as a no-op, and it makes
`geo_user` the owner of everything (the connecting role — `zagreb_user` or `magician` — is a
member, so the file `SET ROLE`s to it; DDL needs *ownership*, and `CREATE INDEX IF NOT EXISTS`
checks it even when the index already exists, so one table owned by the wrong role would abort a
whole later migration). `--ddl` applies it first and is what the server refresh passes.

Tables, loaded in FK order, one transaction each:

| table | from | key |
|---|---|---|
| `sonar.stock_issuer` | `stocks-issuers.json` | `slug` |
| `sonar.stock_token` | `stocks-tokens.json` + `stocks-health.json` | `mint` |
| `sonar.stock_token_snapshot` | every `stocks/data/history/<date>/tokens.json` | `(snapshot_date, mint)` |
| `sonar.stock_trade` | `stocks-trades.json` `.trades[]` | `sig` |
| `sonar.claim` | every `stocks/data/issuers/<slug>.json` `claims[]` + quoted findings/incidents/attestations | `<issuer>:<field>:<sha1(url\|quote)[0:8]>` |
| `sonar.failure_mode` | `stocks/data/trust-chain.json` `failureModes[]` | `id` (`ord` = position in the file) |
| `sonar.what_if` | every `stocks/data/issuers/<slug>.json` `whatIf[]` | `<issuer_slug>:<mode>` |

The daily token snapshot is also the public trend record (about 440 KiB at 471 tokens, with a
560 KiB guard sized for the current 517-token production universe). In addition to the fields used for
day-over-day alerts, each row keeps the displayed supply, reported market value, underlying ticker,
an explicit operational-active verdict, the four independent health dimensions, and counts of
confirmed exact-address DeFi protocols and integrations. Missing measurements remain null. “Active”
means the issuer dossier is live and the token was measured as unpaused or not pausable; absent
control data is not treated as activity. `db/2026-09-19-sonar-snapshot-history.sql` upgrades existing
installations before `/api/history/overview` aggregates those fields.

The two what-if tables have their own DDL (`db/2026-09-18-sonar-whatif.sql`) and their own rules,
both in `stocks/EVIDENCE.md` §6: a failure mode an issuer has not answered has **no row** (the gap
is the finding, and the API reports it as `status: "missing"`), an answer a dossier no longer offers
is **deleted**, and the loader runs `validateWhatIf()` over every dossier first and throws rather
than half-loading a research pass.

Each table keeps the facets worth grouping by as real typed columns **and** the whole source record
as `jsonb` (`record`, or `row` on a snapshot), so flattening loses nothing — the record round-trips
byte-for-byte. Issuer-level facets (legal form, claim rung, maturity, verification) live on
`stock_issuer` and are reached by joining, rather than being copied onto 471 token rows.

Three properties make this safe to run on every refresh:

- **Idempotent.** Every load is one `INSERT … ON CONFLICT DO UPDATE` whose `WHERE` compares each
  loaded column with `IS DISTINCT FROM`. When nothing changed the row is skipped entirely, so not
  even `updated_at` moves — measured: a second consecutive run reports `0 inserted or updated` on
  all four tables and leaves every `updated_at` equal to its `created_at`. Tamper with one column
  in the database and the next run touches exactly that one row and repairs it, so the guard is
  not decoration.
- **The trade table accumulates.** The JSON keeps a rolling 24 h window; the table keeps
  everything it has ever been shown. A signature already present has only `suspect` refreshed (a
  trade can be re-flagged once its neighbours are known) — its price, size and side are never
  rewritten by a later file. A trade with no `time` is skipped rather than given the collector's
  clock as an event time.
- **No new dependency.** The pipeline has zero npm packages, so the loader shells out to `psql`
  with the whole document embedded as one dollar-quoted `::jsonb` literal. The tag is chosen
  against the document's own bytes (`$sonar$`, else `$sonar1$`, …), so nothing in the data can
  terminate the literal early. `DATABASE_URL` comes from the repo `.env` and is never logged — a
  run prints the host and database name only.

`stocks/lib/db-load.mjs` holds the builders and is pure: document in, SQL text out, no connection.
`stocks/db-load.test.js` therefore tests the SQL as text, without a database — including that every
column the builders insert actually exists in the DDL file, which is what catches a rename.

### What the schema is for

```sql
-- mints by control recipe
SELECT coalesce(recipe_label, '(none)') AS recipe, count(*) AS mints,
       count(DISTINCT issuer_slug) AS issuers
  FROM sonar.stock_token GROUP BY 1 ORDER BY mints DESC;

-- mints by the issuer's legal form (the reason the facets are not copied onto every token)
SELECT i.legal_form, i.claim_rung, count(*) AS mints, count(DISTINCT i.slug) AS issuers
  FROM sonar.stock_token t JOIN sonar.stock_issuer i ON i.slug = t.issuer_slug
 GROUP BY 1, 2 ORDER BY mints DESC;

-- health status crossed with issuer
SELECT issuer_slug,
       count(*) FILTER (WHERE health_status = 'good')    AS good,
       count(*) FILTER (WHERE health_status = 'caution') AS caution,
       count(*) FILTER (WHERE health_status = 'warning') AS warning,
       count(*) AS mints
  FROM sonar.stock_token GROUP BY 1 ORDER BY warning DESC;

-- liquidity and volume by issuer
SELECT i.slug, count(*) AS mints, round(sum(t.liquidity_usd)::numeric, 0) AS liquidity_usd,
       round(sum(t.volume24_usd)::numeric, 0) AS vol24_usd
  FROM sonar.stock_token t JOIN sonar.stock_issuer i ON i.slug = t.issuer_slug
 GROUP BY 1 ORDER BY mints DESC;

-- mints by instrument type
SELECT instrument_type, count(*) AS mints, round(avg(premium_pct)::numeric, 3) AS avg_premium_pct
  FROM sonar.stock_token GROUP BY 1 ORDER BY mints DESC;

-- new mints in the last 14 days
SELECT first_seen_at::date AS day, count(*) AS new_mints,
       string_agg(symbol, ', ' ORDER BY symbol) AS symbols
  FROM sonar.stock_token WHERE first_seen_at >= now() - interval '14 days'
 GROUP BY 1 ORDER BY 1 DESC;

-- trades per day per dex, from the accumulating tape
SELECT "time"::date AS day, dex, count(*) AS trades, count(DISTINCT mint) AS mints,
       count(*) FILTER (WHERE suspect IS NOT NULL) AS suspect
  FROM sonar.stock_trade GROUP BY 1, 2 ORDER BY 1 DESC, trades DESC;
```

The same seven are kept as an `-- Examples` block at the end of the DDL, so they travel with the
schema. First local load (2026-09-17): 12 issuers, 471 tokens, 912 snapshot rows over 2 dates,
3,000 trades over 2 days, in 1.4 s.

## Sources and watch

The dossiers cite documents; nothing re-read them after the day they were read. This is the first
slice of `stocks/EVIDENCE.md`: a registry of every URL the dossiers rely on, and a watcher that
fetches each one, normalises it to text, hashes it, and reports what changed — so a redemption
clause, a fee schedule or a custodian that moves is caught within a day, with the diff beside it.

```
npm run stocks:sources    # node stocks/extract-sources.mjs --run   -> stocks/data/sources.json
npm run stocks:watch      # node stocks/watch-sources.mjs --run     -> files, checkpoint, Postgres
```

### The registry (`stocks/extract-sources.mjs`, `stocks/lib/sources.mjs`)

Every string in every dossier under `stocks/data/issuers/` and in `stocks/data/canonical-parties.json`
is walked, and every `http(s)` URL in it is collected **with the field path it was found in**. That
path is the point: it says which claim leans on the document, so `documents[3].url`,
`findings[2].evidence`, `attestations[5].link` and a URL buried in `redemption.fees` prose are all
recorded, and a URL cited by three dossiers keeps all three citations.

- **Deduped by a normalised URL**: fragment dropped, `utm_*`/`gclid`/`fbclid` dropped, host
  lowercased, empty path becomes `/`. Every other query parameter is KEPT, because
  `?alt=media&token=…` on gitbook/firebase *is* the document.
- **Classified** `pdf` (by extension), `api` (an `api.*`/`lite-api.*`/`data.*` host, an `/api/`
  path, or `.json`) or `html`. The served `content-type` overrides this guess at fetch time.
- **Titled** with the `documents[].title` when that is where the URL came from, otherwise with the
  field path itself — `xstocks-backed:findings[7].evidence` is a more useful name than `null`.
- **Truncated citations are reported, not guessed.** Two URLs in the dossiers are written with an
  ellipsis (`…/solana/token...`, `?query=...`); they are listed in `truncatedCitations` and never
  fetched, because what is left of them is not a URL.

Measured (2026-09-17): **337 distinct URLs** — 266 html, 53 api, 18 pdf — over 12 issuers plus 51
cited only by `canonical-parties.json`, 6 of them cited by more than one dossier. Busiest hosts:
`www.sec.gov` 30, `lite-api.jup.ag` 23, `shiftrwa.gitbook.io` 15, `docs.ondo.finance` 14,
`support.backpack.exchange` 12, `docs.superstate.com` 9, `cdn.sanity.io` 7, `docs.tessera.pe` 7,
`learn.backpack.exchange` 7, `data.sec.gov` 6.

### The watcher (`stocks/watch-sources.mjs`, `stocks/lib/watch.mjs`, `stocks/lib/textdiff.mjs`)

Sources are ordered **round-robin by host**, so the 1.5 s per-host floor almost never costs
wall-clock time (337 fetches in ~7 minutes). Each fetch sends the stored
`If-None-Match`/`If-Modified-Since`, has a 30 s timeout, and backs off 5 s then 15 s on 429/503.

The User-Agent is a **browser string by default and per-host where a host requires otherwise**
(`HOST_USER_AGENTS` in `lib/watch.mjs`). A browser string is what keeps most bot walls down, but the
SEC's access policy requires automated requests to declare who is asking: `*.sec.gov` gets
`rwa-sonar source-watch contact@rwasonar.com`, and all 44 `sec.gov`/`archive.org` sources answer
`ok` with it. Add a host to the table rather than weakening the default for everyone.

**Normalisation decides everything**, because it is what gets hashed:

| kind | how |
|---|---|
| `pdf` | `pdftotext -layout` over stdin/stdout — no temp file is ever written into the repo |
| `html` | `script/style/noscript/nav/header/footer/form/svg/iframe` bodies removed, tags stripped, entities decoded |
| `api` | JSON re-serialised with **keys sorted**, so a server shuffling its key order is not a change |
| neither | watched as BYTES: one marker line `binary <type> <n> bytes sha256:<digest>` |

Then **churn lines are dropped**: a bare date or timestamp, a relative time (`2 hours ago`), a
counter (`1,204 views`), a cookie banner, a spinner. A *labelled* date (`Last updated 2026-09-08`)
is deliberately KEPT — it only moves when the document moves, and on a terms page it is the most
informative line there. A bare base58 string is kept too: an authority key appearing in a document
is exactly the signal this exists to catch.

Outcomes, and what each one means:

| status | when | consequence |
|---|---|---|
| `ok` | 304, or 200 with the same hash | `last_checked_at` only — no version, no event |
| `changed` | 200 with a new hash | new `source_version`, raw + text kept on disk, line diff, severity |
| `gone` | 404, 410, or the host stopped resolving | `change_event` `document-gone`, severity `warning` |
| `blocked` | 400/401/403/405/406/451, a bot wall in the body, a JavaScript-only page, or 429 after backoff | recorded with the reason, not retried forever |
| `error` | 5xx, timeout, connection reset | **the run does not report success and exits non-zero** |

A **bot wall is recognised from the body**, never from the headers: every Cloudflare-fronted site
sends `cf-ray` on a perfectly good 200, and a header check marked most of the web as blocked on the
first run. A vendor header only annotates a status that already refused us.

**Severity** (EVIDENCE.md §2.3): a changed line carrying one of redemption, fee, custody,
custodian, jurisdiction, governing law, freeze, pause, clawback, burn, delegate, authority,
terminate, suspend, eligibility, lock-up, dividend is `caution` and writes a `legal-term` change
event naming the keywords; anything else is `info` and writes only a version row. Matching is on
word boundaries, so `transferFeeBps` in a JSON body is not the word "fee". **`api` sources are
capped at `info`** and never raise an event: a price endpoint changes between two fetches by
design, and their movement belongs to the market and on-chain watchers (EVIDENCE.md §2.4-§2.5), not
to the document watcher. The quote check that makes a lost quote a `warning` is slice 2 —
`claimQuoteCheckHook()` is its named, inert placeholder and returns `null` rather than "nothing
lost".

The diff (`lib/textdiff.mjs`) is an exact LCS while the changed region fits a 4M-cell table; above
that it splits on lines unique to both sides (patience anchors) and diffs each gap, and a region
with nothing to anchor on becomes one replace block. `method` always says which produced it. The
unified output is capped at 400 lines because it is stored and displayed; the counts are never
capped.

### Files and tables

```
stocks/data/sources.json                        the registry (committed)
stocks/data/sources/<id>/<fetched_at>.{pdf,html,json,txt}   raw + normalised, last 5 versions (gitignored)
stocks/data/sources-state.json                  per-URL hash/etag/last-checked (gitignored)
stocks/data/raw/sources-<date>.json             per-source checkpoint, resumable (gitignored)
```

`<id>` is `left(sha256(url), 12)` — the same value as `sonar.source.id`, so nothing has to look an
id up and a re-run addresses exactly the same rows. `check_every` is stored (default `1 day`) but this slice still looks at **every** source on every
run; selecting only what is overdue belongs to the scheduled job in slice 3, and the query for it is
in the DDL's examples. `db/2026-09-18-sonar-evidence.sql` creates
`sonar.source`, `sonar.source_version` and `sonar.change_event` (idempotent, `geo_user`-owned);
`--ddl` applies it, and the load is the same dollar-quoted-jsonb-through-`psql` pattern as
`stocks/load-db.mjs`, with the same `IS DISTINCT FROM` guard so an unchanged re-run does not move
`updated_at`. `first_seen_at` is insert-only; `last_modified` and `etag` are only ever the server's
own header values.

```sql
-- what we watch, and in what state
SELECT status, kind, count(*) FROM sonar.source GROUP BY 1, 2 ORDER BY 3 DESC;

-- the change feed, newest first
SELECT detected_at, kind, severity, subject_id, summary
  FROM sonar.change_event ORDER BY detected_at DESC LIMIT 50;

-- dead links we cite (findings, not failures)
SELECT issuer_slug, url, http_status, error FROM sonar.source WHERE status = 'gone';
```

### What the first runs found (2026-09-17)

- **First run: 337 sources, 0 errors, ~7 minutes.** 302 first versions stored; 2 gone; 33 blocked
  on 18 hosts.
- **A re-run over the same 337 is a no-op where it should be**: `ok=260 changed=44 blocked=31
  gone=2 error=0`, exit 0. Every one of the **18 PDFs** was unchanged (`http-304`), as were 213 html
  sources and all 44 `sec.gov`/`archive.org` documents. **No prospectus, terms page, docs page or
  SEC filing moved.** The 44 that changed are 20 live API endpoints (by design, capped at `info`)
  and 24 pages carrying live widgets — coindesk and solanacompass articles with a rotating "related
  news" strip, `polymarket.com`, `kraken.com`, `ondo.finance/global-markets`, `superstate.com/assets`.
- **Transient failures do redden a run, by design.** An earlier sweep ended `error=3` on an
  `archive.org` 503, a `data.chain.link` `ECONNRESET` and a `docs.ondo.finance` connect timeout, and
  exited non-zero. A daily job should carry a retry pass for exactly that class before it reports —
  `archive.org`'s own 503s are now recorded as `blocked` instead (see `tolerates503`), because its
  APIs were answering "temporarily offline" for part of 2026-09-17 and one third party's maintenance
  window must not be indistinguishable from a broken watch.
- **Live price tickers were the one real churn source found by the second run**, and they are why
  the HTML normaliser drops a bare price or percentage line: a decrypt.co article reported a
  432-line change eleven minutes after the first fetch, all of it a BTC/ETH/BNB strip above the
  text. With the rule the same page churns by single digits or not at all.
- **Wayback refuses us.** `--archive --limit=20` attempted 20 saves and archived **0**: an
  anonymous `GET https://web.archive.org/save/<url>` answers **HTTP 500** with the Save Page Now
  form and no `Content-Location`, reproducible with plain curl, so it is their policy and not our
  client. `archive_url` stays null rather than being invented, the failures are logged and never
  fatal, and the fix is the archive.org account key EVIDENCE.md §2.2 already names. After
  `ARCHIVE_GIVE_UP_AFTER` (5) consecutive failures a pass says `archive-unavailable` once and stops
  attempting, because an offline archive is one fact about the archive, not 300 facts about our
  sources — and each attempt costs 5 s of pacing.
- **Two cited URLs are dead.** `https://remoramarkets.xyz/proof-of-reserves`
  (remora-markets:`underlyingCustodian`) — the **domain no longer resolves**, and it is cited as the
  proof-of-reserves endpoint. `https://tools.prnewswire.com/en-us/live/20823/release/20250630EN21069`
  (xstocks-backed:`sources[14]`) — 404.
- **Blocked hosts** are bot walls (`republic.com`, `europe.republic.com`, `www.theblock.co`,
  `www.businesswire.com`, `thedefiant.io`, `notice.co`, `learn.notice.co`, `www.coingecko.com`,
  `www.fsc.gi`, `www.jerseyfsc.org`, `cdn.prod.website-files.com`), rate limits that survive two
  backoffs (`explorer.solana.com` 5, `data.chain.link` 3, `kalshi.com` 1), a query API that needs
  parameters (`8k2tqa6n.api.sanity.io`) and **three JavaScript-only pages** whose text does not
  exist without a browser: both `url.prestocks.com` terms links (they redirect to Notion, which
  normalises to the single word "Notion"), `securitize.io` and `www.anduril.com`. A PreStocks terms
  of service that cannot be read by a fetch is itself a finding.
- **All 18 PDFs extracted.** The largest is a 210-page, 2,033,115-byte prospectus on Sanity's CDN
  (cited by the Ondo dossier): `pdftotext -layout` turned it into 605,034 characters of text. Next:
  164 pages / 466,993 chars (Backed's base prospectus) and 173 pages / 529,727 chars.
- **One document needed a bigger client**: `superstate.com/assets/fwdi` sends a 14,990-byte `link:`
  preload header, 17,456 bytes of headers in total, which is past undici's 16 KB cap — `fetch`
  reports `UND_ERR_HEADERS_OVERFLOW` and no body. It is refetched through `node:https` with a
  256 KB `maxHeaderSize`, which reads it fine (4,612 characters).

Tests: `stocks/sources.test.js`, `stocks/textdiff.test.js`, `stocks/watch.test.js`. The
normalisation tests run against two real sources saved once under `stocks/fixtures/sources/` —
Backed's legal-documentation page and pages 1-2 of the Shift DAO Series 17 operating agreement,
with the `pdftotext -layout` output kept beside the PDF so the suite needs no poppler binary. One
test cross-checks every status, kind, severity and diff method the code can write against the check
constraints in the DDL file, because a value the constraint forbids is a run that dies at the load
step hours after the fetching.

## Claims and evidence

Slice 2 of `EVIDENCE.md`: **every structured dossier field carries the words it came from**, and the
page, the cards, Postgres and the API all read the same set.

A claim is one asserted fact — a dossier field path, the verbatim `quote`, the `url`, the `locator`
that finds it again, `accessedAt`, a `status` and an optional `note`:

```json
{ "field": "redemption.rails", "quote": "USDC or another mutually agreed form of value",
  "url": "https://…/tos", "locator": "p. 41, s. 4.1.1",
  "accessedAt": "2026-09-18T10:22:00Z", "status": "confirmed" }
```

Claims live in each dossier's own `claims[]` array. A `findings`, `incidents` or `attestations`
entry that has gained a `quote` (and `accessedAt`, and sometimes `quoteNote`) **is** a claim too and
is read as one under the field `findings[3]`, `incidents[0]`, `attestations[2]`.

- `stocks/lib/evidence.js` is the one copy of the logic — field-path parsing (`redemption.rails`,
  `products[0]`, `vocabulary.titleDeed.value`, `parties["custodians"]`), the value at that path,
  the per-field index behind a chip, the trust ordering and the coverage arithmetic. UMD like
  `fmt.js`, so the browser loads the same file the builders import through `lib/evidence.mjs`.
- `stocks/lib/trustchain.js` is the same idea one level up: the trust chain and the what-if
  answers. It reads `stocks/data/trust-chain.json` (13 actors, 9 rights flows, 38 failure modes)
  and turns a dossier into a node per actor and a link per flow, each link graded twice from the
  claims above — `evidence` (documented / inferred / asserted / unknown) and `verification`
  (onchain / attested / self-reported / none). It also indexes and validates each dossier's
  `whatIf[]` answers. UMD like `evidence.js`, imported by the builders and the API through
  `lib/trustchain.mjs`. The full rules are in `stocks/EVIDENCE.md` §6.
- **What needs a source** is `stocks/data/claim-fields.json` — 39 patterns, with `vocabulary.*.value`
  expanded against each dossier's own keys, and a path counted only when the record actually holds a
  value there (a field with nothing in it has nothing to quote). One file, read by the builders and
  fetched by `stocks.js`, so the coverage number on a card, in `stocks-issuers.json` and in the
  panel can never be three different numbers.
- **Coverage is fields with at least one CONFIRMED claim.** An `unverified` claim (written down,
  nobody has re-read it) or an `inference` (our reading, not the source's words) is a claim but not
  a source, and is counted separately. `contradicted-corrected` is an internal editorial-history
  status: the research dossier and database retain it, while publication exposes the current quote
  as confirmed evidence and removes the correction narrative.
- **An inference has neither a quote nor a URL** — that is its shape — so it carries a `note`
  naming what it rests on, and the derived list keeps it. Dropping those (an early version required
  quote-or-url) silently removed 8 real claims from the coverage counts and from SQL.
- **`method` is derived from the locator**, never declared: `rpc:…` and `tx <sig>` are `onchain`,
  everything else `manual`.

### In Postgres

`db/2026-09-18-sonar-claims.sql` creates `sonar.claim`; `node stocks/load-db.mjs --run --ddl
--only=claims` loads it (the `--ddl` flag now applies all three `db/` files in dependency order,
since the claim's `source_id` references `sonar.source`). The id is **content-addressed** —
`<issuer_slug>:<field>:<first 8 hex of sha1(url|quote)>` — so a re-load is an upsert that addresses
exactly the same row without looking anything up, and a second run touches nothing.

Two consequences of that, both deliberate:

- `source_id` is resolved by **exact URL** against `sonar.source` inside the statement. No match
  leaves it null rather than dropping the claim (489 of 1,263 rows joined on the first full load).
- **Editing a quote or a URL produces a new id**, so the old row stays behind. Nothing deletes it —
  `EVIDENCE.md` is explicit that a claim whose words have moved becomes `changed` for a human to
  decide — but the loader counts the rows no dossier offers any more and **warns**, per issuer, with
  the oldest `recorded_at`. The first real load left exactly one.
- `recorded_at` is set on insert only; `last_checked_at` and `last_confirmed_at` are seeded from
  `accessedAt` on insert and then belong to `stocks/watch-sources.mjs`, which measures them by
  re-reading the source. Refreshing them from a dossier would make a stale claim look freshly
  checked.
- The two CHECK constraints say what they mean: a claim must carry **a quote, a URL or a note**
  (31 of 1,263 have neither quote nor URL, every one with a note), and a **`confirmed` claim must
  have a quote or a URL** — you cannot claim the source's own words were found without having them.

### On the page and on the cards

Every field with a claim gets a small `§` chip after its value; a field that needs one and has none
gets a hollow `§?`. The chip is a `<details>` — it opens by tap and by keyboard with no script, and
the summary's `title` gives the one-line hover — showing the quote, the source (under the title the
dossier gave it, cut to one line with the whole of it in the attribute), the locator, the
timestamps formatted with the full ISO in a `title`, the status badge (`unverified` in the caution
colour, external `changed` / `source-gone` states in warning, `inference` muted) and the note. A line in the panel
header and in the card footer reads `Evidence: 48 of 49 fields sourced · last checked 17 Sep 2026
15:40 UTC`.

Two things worth knowing before changing them:

- A popover inside the panel's scroll container is clipped by it, so `stocks.js` scrolls an opening
  chip into view (with `scroll-margin-block`, or the box lands flush against the edge and reads as
  cut) and closes the others. Below 560 px the popover is anchored to the whole row rather than to
  the chip — anchored to the chip it ran off the left edge at 360 px, measured at −19 px on the
  panel and −116 px on a card.
- **A card is byte-capped and the chips cost real bytes.** `CARD_BYTE_BUDGET` is 104 kB, just above
  the measured 100.8 kB production maximum across 517 cards.
  The summary's `title` no longer
  repeats the quote the popover shows one tap away (−5.5 kB on the widest card), the inlined record
  carries the evidence **summary** only (−9.3 kB; the claims are rendered above it and served in
  full by `/api/issuers/:slug/claims`), and the card shows the strongest claim per field with the
  quote cut to `QUOTE_MAX`. The build still FAILS on a card over the ceiling, and
  `stocks/cards.test.js` prints the widest real card's size on every run.
- The panel additionally gained rows the need list requires but nothing rendered — lifecycle
  status, what the holder owns, the issuer's stated token program, redemption fees/KYC/minimum, and
  a **Ledger maturity vocabulary** section for the twelve maturity questions, which are a third of
  what needs a source and previously had nowhere to show a chip.

### API

`/api/claims?issuer=&field=&status=&method=&sort=&order=&limit=&offset=` (default order is TRUST
order, not alphabetical), `/api/issuers/:slug/claims` (with a per-status summary),
`/api/sources?issuer=&kind=&status=` (with `last_checked_at` and `archive_url`),
`/api/changes?kind=&severity=&issuer=&since=&limit=` and `/api/rules` — the health rule ids with
their labels, descriptions and thresholds, read once at import from `stocks-health.json`, which is
the gap `monitor.js` papered over with a hard-coded `RULE_LABELS` map.

Three gaps the monitor page found are closed at the same time: a **filter value containing a comma**
is now expressible (`?jurisdiction[]=Cayman Islands, with a Swiss arm`; a repeated plain parameter
is OR too, and neither form is comma-split), `worst_rule`, `venue_spread_pct` and `top1_share_pct`
are **sortable**, and `health_status` sorts by **severity** (good, caution, warning, then
unmeasured) instead of alphabetically — which had put the two ends of the scale in the middle.
`monitor.html` now offers those three columns as sortable.

Tests: `stocks/evidence.test.js` (the shared logic, against `stocks/fixtures/dossier-claims.sample.json`
— a hand-written dossier carrying every field-path form, every status, an inference with neither a
quote nor a URL, and an entry with no status at all, because the real dossiers gained their claims
one issuer at a time and a test reading them would have passed on an empty array), the claim suites
in `stocks/db-load.test.js` (id determinism, the value at each path form, insert-only timestamps,
both DDL checks against the real dossiers), `stocks/cards.test.js`, `stocks-page.test.js` and
`api/test/evidence.test.js`.

## Reusable technology + legal templates

`node stocks/build-legal-templates.mjs --run --base-url=https://rwasonar.com` joins each reviewed
entry in `data/composability-templates.json` to the corresponding issuer dossier and every token
whose **issuer plus observed control-recipe label** matches it. It writes:

- `stocks-legal-templates.json`, the machine-readable catalogue;
- `templates/index.html`, the public catalogue; and
- `templates/<template-id>.html` plus `.json`, one first-class dossier per structure.

The current nine templates cover all 471 locally built token addresses. An asset inherits the
template only on an exact issuer/recipe match; `inheritance.exceptions[]` is deliberately separate
and empty until an asset-specific conclusion is actually recorded. The pages link back to the
individual token cards, and cards, issuer panels and the composability matrix link into the template.

The generated analysis keeps nine things separate instead of producing a legal score:

1. a visual ownership path from the underlying company through the actual custodial/issuer/token
   links to the holder, plus the transfer agent, security agent, provider, attestor and legal actors
   that can interrupt or enforce it;
2. document authority and an explicit six-level precedence policy;
3. real source changes and source-backed actor conflicts, while internal editorial corrections stay out of the public page;
4. jurisdiction, contractual eligibility and technical transferability;
5. insolvency standing, security-agent dependency, segregation/commingling, perfection/priority
   and custodian-lien evidence where the dossier actually says something;
6. dividends, voting and other corporate actions;
7. the redemption route, including fees, minimums, KYC and timing gaps; and
8. six independent evidence-confidence facets; and
9. a conclusion ledger that keeps each statement beside its exact quotations and clause/page
   locators, evidence kind (observed fact, issuer/document assertion, interpretation or unresolved),
   source authority/precedence, governing law, holder scope and review date.

`document.version` and `document.effectiveDate` are present in the output even when null. A date
embedded in a title is not silently promoted into legal metadata; the page prints **not structured**
until research records it deliberately. The same rule applies to redemption evidence: issuer terms
can establish a documented process, but only an observed transaction establishes an exercised
redemption. All current templates say `documented-process`, not `observed-transaction`.

The server refresh builds the templates after the stock database and before the token cards, then
publishes both the JSON and the generated directory. Tests: `stocks/legal-templates.test.js`, plus
the link assertions in `stocks/cards.test.js` and `stocks-page.test.js`.

## Chain watcher

`stocks/watch-chain.mjs --run [--ddl] [--only=<issuer>] [--limit=n] [--rpc=<url>] [--wallets=n]
[--metadata=n] [--no-db] [--no-telegram]` — slice 3 of `EVIDENCE.md` (§2.4), hourly. The document
watcher above refetches the PDFs and pages the dossiers cite once a day; this is its on-chain half,
and it runs hourly because a key rotation or a pause is a different kind of news from a terms-of-
service edit. All the decisions are pure and live in `stocks/lib/chainwatch.mjs`
(`stocks/chainwatch.test.js`, 56 tests); the CLI does the IO.

What a run reads, and what it costs: every mint in `stocks-tokens.json` with
`getMultipleAccounts(jsonParsed)`, 100 per call and 250 ms apart (**5 calls** for 471 mints), the
lamports of the labelled wallets in **1 more**, and one `getTokenAccountsByOwner` per labelled
wallet (**40**) — **46 RPC calls per run, measured, ≈ 1.1 k a day at hourly**, the same order as the
3-hourly trade collector's ≈ 3 k and comfortably inside the Alchemy free tier. The 83 s a full run
takes is almost entirely the **50 metadata documents** (1/s pacing, 10 s timeout); those are plain
HTTPS, not RPC. `--wallets=0 --metadata=0` reduces a run to the 5 account batches.

`sonar.mint_state` (`db/2026-09-18-sonar-chain.sql`) keeps **one row per mint per observed state**,
not per read: a mint whose `state_hash` equals the latest stored hash is not written at all. The 22
comparable columns (of 26; `mint`, `observed_at`, `slot` and `state_hash` describe the reading) are
every authority (mint, freeze, permanent delegate, fee config, withdraw
withheld, hook, scaled-UI, metadata update), every toggle (pausable, paused, default-frozen,
transfer-fee bps and cap, withheld amount, hook program), the scaled-UI multiplier with its
*scheduled* successor and effective date, the metadata URI, and the sha256 of the metadata JSON.
`slot` is the response's own `context.slot` — the chain's statement of when the values were true —
and is deliberately **not** hashed, or every mint would be "changed" hourly.
`sonar.wallet_balance` keeps one row per (wallet, mint, reading) in UI units, `mint` null for SOL.

Changes become `sonar.change_event` rows with `before`/`after`, the slot/observed_at pair and the
account as `evidence`: `authority-key` (warning) for a rotated key, `extension-toggle` (warning) for
paused / default-frozen / fee bps / a hook switched on or off, `rebase` (caution, warning past
×1.05 or ×0.5) for the multiplier and its schedule, `supply` (info ≥ 1 %, caution ≥ 10 %),
`metadata` (caution) for a moved URI or a changed document, `treasury` (info ≥ 5 %, caution ≥ 25 %;
SOL judged absolutely at 100 SOL) for a labelled wallet's balance.

Eight decisions worth keeping, most of them ways of NOT crying wolf:

- **A first sight is a baseline, not 471 events.** A mint with no stored state raises no field
  events at all; its issuer gets one `info` "baseline recorded" instead. Measured: the first run
  wrote 471 states and **9 events**, one per issuer.
- **A `null` metadata hash means "not fetched", never "empty".** A null → hash transition is a first
  observation and raises nothing; only hash → different hash is a `metadata` event. The hash is
  carried forward while the URI is unchanged, so the universe is not re-fetched hourly — a cold
  start works through it 50 at a time, in mint order.
- **A supply move under 1 % is not news.** Ondo's supplies move with every subscription: the second
  run, 90 s after the first, saw **10 supply moves and 4 withheld-fee moves, and raised 0 events**
  while still recording all 63 changed states (50 of them only because a metadata hash was filled
  in). That is the property to re-check after any change here: *rows may grow, the feed may not*.
- **`paused: null` is not `paused: false`.** A mint that CANNOT be paused is a different fact from
  one that is currently unpaused, so the plain SPL-token case leaves the column null.
- **A hook program set or unset is a toggle; one program swapped for another is a rotation.** Same
  severity, different sentence — the only field that appears in two kinds.
- **Numbers are text everywhere.** Supply is a u64 and the scaled-UI multiplier has 16 significant
  digits, so both are carried as decimal strings, inserted with `(r->>'x')::numeric` and read back
  with `::text`. A `row_to_json` round trip through a JSON number is how a watcher invents a change
  that never happened; there is a test that a state written and read back diffs as unchanged.
  `maximumFee` is the one value JSON.parse has already rounded before this code sees it (u64::MAX
  arrives as a double), so it is stored as that double's exact digits — stable, which is what the
  hash needs.
- **`decimals` changing is `critical`.** It cannot happen on a Token-2022 mint, and if it ever does,
  every balance in every wallet has been re-denominated.
- **40 wallets is a cap, not the count.** `buildOwnerLabels` can name 83 addresses and each costs a
  call, so the run reads the keys `classify.mjs` names outright plus the busiest authorities, ranked
  deterministically. 7 of the 40 have no account on chain at all, which is recorded as 0 SOL — an
  address with no account holds no lamports, and that is the RPC's answer rather than a guess.

Alerts: one Telegram summary per run, and only when there are events or failures (counts per kind
and severity, the worst three, the duration). It posts with `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_CHAT_ID` from `.env` (`stocks/lib/telegram.mjs`); **this repo has neither**, so today the
summary is logged verbatim with a line saying it was not sent. A failed send is never fatal.
`.last-chain-watch-stats.json` (gitignored) carries the counts for an outcome check, and
`rwa-watch-chain` is registered in `alerts-server-telegram/bot-list.json` with a `db-rows` freshness
check on `sonar.mint_state.observed_at`.

A per-item failure poisons the exit code: a mint the RPC has no account for, an unparseable mint
account, a malformed wallet balance, or a metadata fetch that failed for a reason that is ours
(5xx, timeout, reset). A metadata 404 or 403 is a *finding* about the citation and logged as such,
exactly as `gone` and `blocked` are for the document watcher — the taxonomy is shared
(`decideOutcome` in `stocks/lib/watch.mjs`), not duplicated.
