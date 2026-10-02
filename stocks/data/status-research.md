<!-- Lifecycle-status research behind the `status`, `statusCheckedAt` and `statusNote` fields on every
rwa-assets-db.json record (MODEL.md §2.6). One row per asset with the evidence it rests on, then the
cases where the evidence did not settle the question. Re-check dates before citing any figure here. -->
# Lifecycle status of every rwa-assets-db.json record — researched 2026-09-16

`live` = the product can be minted/redeemed or traded today · `defunct` = wound down, delisted or the
issuer is gone · `not-launched` = announced, contracts may exist, no supply or no trading yet. A
renamed or migrated product keeps `live` and says so (MODEL.md §2.6).

**Result: 28 live, 3 defunct, 1 not-launched. Nothing was left without a status** — every one of the
21 previously unrecorded records reached a verdict on a primary source.

## The 21 records that had no `status`

Researched from issuer/fund pages, SEC filings and the tokens' own on-chain supply.

| asset | status | checked | evidence | note |
|---|---|---|---|---|
| Circle USDC | `live` | 2026-09-16 | https://www.circle.com/usdc | Circle's own page states $74.2B USDC in circulation as of 2026-09-14 and still offers mint and redemption via Circle Mint. |
| TER Gold | `live` | 2026-09-16 | https://ter.bt/ | ter.bt offers mint and redemption and the mint holds 11,606,617 TER (~116 kg gold); on-chain symbol is TER, not TERG. |
| Paxos Gold | `live` | 2026-09-16 | https://paxos.com/paxgold | Paxos still sells and redeems PAXG, 431,926 oz across 87,491 holders on-chain; the page notes PAXG is unavailable in the EU. |
| Tether Gold | `live` | 2026-09-16 | https://gold.tether.to | 707,747 XAUT outstanding (~$3.1B) and gold.tether.to still offers it; XAUt0 is an additional omnichain build, not a rename. |
| Apollo ACRED | `live` | 2026-09-16 | https://securitize.io/primary-market/apollo-diversified-credit-securitize-fund | Securitize still offers the Apollo Diversified Credit Securitize Fund; $95.4M asset value, NAV $1,110 today. |
| Superstate USTB | `live` | 2026-09-16 | https://docs.superstate.com/investors/tokenized-funds/available-funds/invesco-ustb | **Renamed** Invesco Short Duration US Govt Securities Fund; Invesco replaced Superstate as manager, USTB ticker kept. |
| Circle USYC | `live` | 2026-09-16 | https://www.circle.com/usyc | Circle's page shows $312.98M AUM; Hashnote's fund was acquired by Circle in Jan 2025, the token was not renamed, and it is now multi-chain. |
| Janus Henderson JTRSY | `live` | 2026-09-16 | https://www.anemoy.io/funds/jtrsy | 582.5M JTRSY on Ethereum with daily USDC subscriptions; **formerly** the Anemoy Liquid Treasury Fund (LTF), renamed for Janus Henderson. |
| Hamilton Lane SCOPE | `live` | 2026-09-16 | https://securitize.io/primary-market/hl-scope | Securitize still offers the HLSCOPE feeder ($4.29M AUM, 43 holders) and added a TRON leg on 2026-06-02. |
| OpenEden TBILL | `live` | 2026-09-16 | https://etherscan.io/token/0xdd50c053c096cb04a3e3362e2b622529ec5f2e8a | $245.9M vault value, minting open; the Ethereum token **migrated** to `0xdd50C053…` and BNY is now investment manager. |
| Spiko USTBL | `live` | 2026-09-16 | https://data.spiko.io/ | Spiko's own data portal shows $172.90M AUM, NAV 1.0959, an AMF-approved sub-fund of the French Spiko SICAV. |
| WisdomTree WTGXX | `live` | 2026-09-16 | https://www.sec.gov/Archives/edgar/data/1859001/000121465925012992/wtd497wtgxx.htm | **Renamed** WisdomTree Treasury Money Market Digital Fund ~2025-11-01 per Form 497; WTGXX ticker and tokenized class kept. |
| Felix USDhl | `defunct` | 2026-09-16 | https://usefelix.gitbook.io/usdhl/llms-full.txt | Felix's own docs carry a "Sunsetting USDhl" notice pointing users to USDH; only 357,610 USDhl remain on HyperEVM. |
| Theo thBILL | `live` | 2026-09-16 | https://theo.xyz/thbill | The product page is labelled LIVE with $175M+ TVL and an open deposit flow; the HyperEVM leg holds 1,298,496 thBILL. |
| BlackRock BUIDL | `live` | 2026-09-16 | https://securitize.io/blackrock/buidl | $2.68B AUM and Securitize still offers it exclusively; the Solana leg holds 993,191,100 BUIDL. |
| Franklin Templeton FOBXX | `live` | 2026-09-16 | https://digitalassets.franklintempleton.com/benji/ | 497K summary prospectus filed 2026-08-01 shows the fund offering shares; the Solana BENJI leg holds 110,460.74. |
| Ondo USDY | `live` | 2026-09-16 | https://ondo.finance/usdy | Ondo's page shows $2.24B TVL on 2026-09-15 with daily subscriptions and redemptions; the Solana leg holds 157.2M USDY. |
| Ondo OUSG | `live` | 2026-09-16 | https://ondo.finance/ousg | $330.7M TVL and 24/7 mint/redeem on Ondo's page, but the recorded Solana mint's supply is **0** — that leg is empty. |
| VanEck VBILL | `live` | 2026-09-16 | https://securitize.io/primary-market/vaneck-vbill | Securitize still offers it with daily liquidity and the Solana leg holds 14,565,007 VBILL, though total AUM fell ~70% in 30d. |
| Uranium Digital | `not-launched` | 2026-09-16 | https://www.uraniumdigital.com | The issuer's own site still reads "Coming Soon" and publishes no ticker or mint; no verified token exists on Solana. |
| Oro GOLD | `live` | 2026-09-16 | https://orogold-1.gitbook.io/oro | The mint holds 576.26 GOLD across 10,924 holders with mint/redeem documented as active; orogold.app now **redirects** to oro.finance. |

## The 11 equity records that already had `status`

`status` unchanged (it came from MODEL.md §4 and the issuer dossiers); this run added
`statusCheckedAt` and a `statusNote` drawn from each dossier's documents and incident register.

| asset | status | checked | evidence | note |
|---|---|---|---|---|
| Kraken xStocks | `live` | 2026-09-16 | https://assets.backed.fi/legal-documentation | FMA-approved Backed Assets (JE) base prospectus 2026-05-08 (valid to 2027-05-07) + 2026-07-27 supplement; 100+ xStocks offered. |
| Ondo Global Markets | `live` | 2026-09-16 | https://ondo.finance/ondo-stocks | Mint/redeem open on app.ondo.finance and Ankura daily verification reports published; the product page is now `/ondo-stocks`. |
| Backpack Securities SPCX | `live` | 2026-09-16 | https://api.backpack.exchange/api/v1/markets | `SPCX.US_USDC` spot and perp markets both "Open" per the exchange API on 2026-09-16; two-way conversion open to KYC'd users. |
| Opening Bell by Superstate | `live` | 2026-09-16 | https://docs.superstate.com/investors/tokenized-equities | FWDI and GLXY registered shares tokenized on Solana; burn-to-book-entry redemption still offered to allowlisted holders. |
| Bullish BLSH | `live` | 2026-09-16 | https://www.sec.gov/Archives/edgar/data/1872195/000143774926027408/ex_1003753.htm | Tokenized BLSH trading opened 2026-08-12 (Form 6-K, 2026-08-13); EQ is the transfer agent of record. |
| Securitize SECZ | `live` | 2026-09-16 | https://www.sec.gov/Archives/edgar/data/2094496/000162828026051182/secz-20260731.htm | Tokenized SECZ enabled at the 2026-07-02 NYSE listing, on Solana and Avalanche, per the S-1 of 2026-07-31. |
| PreStocks | `live` | 2026-09-16 | https://prestocks.com/api/prestocks | 8 PreStocks tokens served by the public API and Jupiter-routable on 2026-09-16; ToS last updated 2026-09-08. |
| Shift leveraged tokens | `live` | 2026-09-16 | https://shiftrwa.gitbook.io/shift_education/legal/trade/operating-agreements | 8 Series mints Jupiter-verified and mintable on 2026-09-16, though shiftrwa.xyz now leads with yield vaults. |
| Tessera | `live` | 2026-09-16 | https://docs.tessera.pe/features/redemption | tOpenAI, tKalshi and tSpaceX all offered on 2026-09-16 with redemption windows and Chainlink proof-of-reserve feeds. |
| Remora Markets | `defunct` | 2026-09-16 | https://panews.io/articles/019c8d3d-c961-7660-b66c-62e7be695653 | Step Finance wound down Step, SolanaFloor and Remora on 2026-02-23 after a treasury hack; domains dead, ~$2M still held. |
| Ventuals Pre-IPO | `defunct` | 2026-09-16 | https://docs.ventuals.com/sunset-guide | Sunset announced 2026-06-15; every pre-IPO, index and commodity market settled at TWAP marks and halted by 2026-06-18. |

## Renames, migrations and manager changes found

Each of these keeps `live` per §2.6, but the record's *other* fields are now stale. **None of them was
corrected here** — this pass owns only the three status fields.

1. **Superstate USTB is no longer a Superstate fund.** Invesco Advisers replaced Superstate as
   investment manager (announced 2026-03-24) and the fund is now the *Invesco Short Duration US
   Government Securities Fund*. Ticker, token contract and Superstate's transfer-agent/portal role are
   unchanged. The record's `name` ("Superstate USTB") and `issuer` ("Superstate") are therefore both
   stale. Verified directly against `docs.superstate.com/…/invesco-ustb`, which now names Invesco.
2. **WisdomTree WTGXX was renamed** from *Government* to *Treasury Money Market Digital Fund*,
   effective on or about 2025-11-01 (SEC Form 497), narrowing its universe to GENIUS-Act-permissible
   reserve assets. Not a merger or liquidation.
3. **JTRSY was formerly the Anemoy Liquid Treasury Fund (LTF)**, renamed after Janus Henderson became
   sub-investment manager. `JAAA` is a *separate* Janus Henderson/Centrifuge CLO product, not this one.
4. **OpenEden TBILL migrated its Ethereum token** from `0xad6250f0…97b0F` to `0xdd50C053…f2e8a`, and
   BNY Investment Management is now investment manager with BNY as custodian.
5. **USYC changed hands, not names.** Circle acquired Hashnote and USYC in Jan 2025; the underlying
   fund is still legally the Hashnote International Short Duration Yield Fund Ltd. (Cayman). The
   record's Ethereum-only footprint is stale — it now also runs on Arc, BSC, Solana, Canton and NEAR.
6. **Felix USDhl migrates to USDH.** The successor is a different token with a different backer;
   the Superstate/BlackRock association belongs to USDH, not to USDhl.
7. **Oro's domain moved**: `orogold.app` 301s to `oro.finance` (verified).
8. **Ondo's Global Markets page moved** to `/ondo-stocks` (`/global-markets` 308s).

## Ambiguities and stale record fields

Nothing below blocked a verdict, but each is a caveat on the figure or an error in a field this pass
does not own.

- **Ondo OUSG's Solana leg is empty.** `getTokenSupply` on the recorded mint
  `i7u4r16Tcs…` returns **0**, while rwa.xyz reports ~624,604 OUSG on Solana. The mint account exists,
  is initialised and is labelled OUSG, so the address is right. A Jupiter token search for OUSG found
  no second verified Solana mint — only pump.fun impostors, including two calling themselves
  "J.P. Morgan Tokenized Money Fund". Either the leg was fully redeemed or rwa.xyz is tracking
  something not found. `live` rests on Ondo's own page ($330.7M TVL, 24/7 mint/redeem), not on Solana.
- **Uranium Digital's `not-launched` means "no public token".** The site says "Coming Soon" and no
  ticker or mint is published anywhere on it; CoinDesk (2026-02-07) reported it would be "fully
  operational later this quarter" and no primary evidence says it was. Because the model is
  institutional, a permissioned token could exist without appearing in any public list. Do not
  conflate with **uranium.io** (xU3O8 on Tezos/Etherlink) — a different issuer whose token does trade.
- **Two `website` values in the record are dead or wrong.** `spiko.finance` does **not resolve**
  (NXDOMAIN; the live domain is `spiko.io`), and `felix.exchange` serves an unrelated parked IIS
  default page (Felix's real site is `usefelix.xyz`). Not fixed here.
- **Three tickers disagree with the chain.** TER Gold's on-chain symbol is **TER**, not `TERG`;
  Hamilton Lane's on-chain ticker is **HLSCOPE** (`SCOPE` is the underlying fund); Franklin's on-chain
  token is branded **BENJI** while `FOBXX` remains the fund's legal ticker. Not fixed here.
- **Securitize product pages are client-rendered**, so ACRED, HLSCOPE and VBILL could not be read for
  explicit "open for subscription" wording. `live` rests on the slug returning fund-specific copy
  (invalid slugs 404), today-dated non-zero AUM, and — for HLSCOPE — Securitize adding a TRON leg on
  2026-06-02, which nobody does to a wound-down feeder.
- **AUM figures whose only source is an aggregator**: OpenEden TBILL's $245.9M, VanEck VBILL's $57.2M
  total, WisdomTree's ~$1.23B and Franklin FOBXX's ~$726–844M all come from rwa.xyz, not an issuer
  page. Every *supply* figure in this file is primary (block explorer or RPC).
- **USYC AUM is contested**: Circle's own page says $313M while secondary write-ups claim ~$3B. The
  issuer's number is used here; the ~10× gap is unresolved.
- **VBILL fell ~70% in 30 days** — a large redemption, with nothing indicating closure. Worth
  re-checking.
- **Felix USDhl minting is not proven closed**: the docs say the protocol "will remain active and
  usable in perpetuity". `defunct` rests on the issuer's own sunset notice plus collapsed supply, not
  on a disabled mint. Also ignore CoinGecko's 8.889B "total supply" — that is the HyperCore HIP-1
  genesis allocation, not circulating supply.
- **Theo thBILL's basket composition today is unverified** (`docs.theo.xyz` returns 403). tULTRA
  (Standard Chartered Libeara / Wellington / FundBridge) was the launch constituent; whether it is
  still the only one is unconfirmed. Status is unaffected.
- **Two gold figures are derived, not published**: TER's ~116 kg comes from multiplying the on-chain
  supply by the stated 0.01 g/token, and neither ter.bt nor the press publishes an AUM. Paxos
  publishes no supply figure on its product page either; 431,926 oz is from Etherscan.
- **Oro's mint is not issuer-published.** `oro.finance` is a JS-only app, so the mint address
  `GoLDppdjB1vDTPSGxyMJFqdnj134yH6Prg9eqsGDiw6A` was established from the vanity mint authority
  (`orowZ7k1kEw…`) and metadata served from the issuer's own GitHub org, not from the site. Two
  impostor tokens exist, one of which lists `orogold.app` as its website.
- **SEC Archives URLs 403 to a bare `curl`** (EDGAR requires a declared User-Agent). They are live in
  a browser; the links are correct.
