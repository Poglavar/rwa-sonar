<!-- The model behind the Solana tokenized-stocks section: what the data showed about the current rwa-sonar vocabulary, the reformed model, exact record shapes, grading rules and the site structure. Every builder works from this file. -->
# Tokenized stocks on Solana — model and reforms (2026-09-16)

Scope: the stocks section first. Items marked **[SITE-WIDE]** touch the whole site and are implemented
additively: nothing that exists today is removed or re-scored unless listed under §4 Repairs.

## 1. What the stocks data showed about the current model

1. **The ladder grades the wrapper, not the claim.** The four pillars measure how far a token behaves like a
   bearer digital asset with legal integration. Applied from primary documents to Solana stock issuers:
   xStocks Level 2, Ondo Level 2, PreStocks Level 2, Tessera Level 3, Superstate 0, Bullish 0, Securitize 0,
   Backpack 0. The three products where the holder owns the registered share sit at the bottom. That is the
   vocabulary working as designed (the thesis is that the chain should be the main ledger), but on its own
   it reads as "PreStocks is more mature than Superstate". The missing dimension is *what the holder legally
   owns*; today that is the single boolean `titleDeed`.
2. **`forcedTransfers` conflates capability with legal process.** On Solana the capability is a mint
   extension (permanent delegate), present on 226 of 441 mints, mostly held by single keys or unnamed
   programs with no published procedure. The dossiers already separate the two: `forcedTransfers` =
   mechanism exists; `reflectLegalDecisions` = the mechanism is bound to a legal process. Level 4 keys on
   the mechanism. (Left as is for now; see §6.)
3. **There is no place for observed facts.** Attestations are positive statements by an attestor
   (TODO.md). The dossiers proposed 39 new slugs and 25 of them are negative or neutral observations
   (e.g. `collateral-may-be-lent-to-prime-borrower`). Nobody attests to them; we observed them. They need a
   separate layer.
4. **Existing equity records are wrong or stale.** Kraken xStocks and Ondo Global Markets say
   `blockchainIsMainLedger: no` while their own base prospectus / sales terms make the chain the securities
   ledger under Swiss CO art. 973d; Ondo is recorded as transfer-restricted (it is not); both are recorded as
   "SPL" (all 441 mints are Token-2022); Remora Markets and Ventuals are defunct and the model has no notion
   of "defunct"; Ondo's attestation `token-represents-equity` is false (structured note).
5. **`aiReady` is defined as derived yet stored and scored as an independent boolean** (double counting).
   `thirdPartyAttestations` is a boolean while the evidence ranges from nothing to a real-time
   transfer-agent register.
6. **The unit of analysis is the issuer programme** (one wrapper, one document set, one control surface)
   instantiated as up to 212 mints. Grading per mint repeats the issuer; grading only per issuer hides
   per-mint facts (fees, multipliers, paused mints, liquidity, premium).

## 2. The reformed model

### 2.1 Two layers (unchanged)
Issuer records: hand-researched, cited, `stocks/data/issuers/<slug>.json`. Token records: machine-collected,
`stocks/data/*.json`. A token inherits its issuer's legal facts; only on-chain and market facts live per token.

### 2.2 Two axes instead of one ladder **[SITE-WIDE, additive]**
- **Ledger maturity** = the existing Maturity Stage (Level 0–4) and Maturity Score, computed exactly as
  `index.html` computes them (§3.1). Unchanged.
- **Claim depth** = what the holder legally owns, a 0–4 rung (§3.2). Equity-specific for now.
The stocks page shows issuers on a 5×5 grid (x = claim depth, y = ledger maturity) so that "most tokenized"
and "most real" are visibly different things.

### 2.3 Control surface — facts, never summed
Per issuer, aggregated from its mints (§3.3): clawback, freeze, pause, allowlist, transfer fee, hook
active, key governance, freeze exercised. Rendered as icons with tooltips. Per token, the raw flags.

### 2.4 Verification strength 0–5 (§3.4), replacing the boolean reading of `thirdPartyAttestations`
for the stocks page only; the boolean stays in the main table.

### 2.5 Findings layer **[SITE-WIDE, additive]**
`finding-types.json` (repo root, sibling of `attestation-types.json`) defines observed-fact types:
`{schema, name, category, polarity: "negative"|"neutral", defaultSeverity: "info"|"caution"|"warning"|"critical", description, howToVerify}`.
Each issuer record carries `findings: [{schema, severity, observer: "rwa-sonar", observedAt: "YYYY-MM-DD", evidence: "<url or 'rpc:<method> <address>'>", statement}]`.
Attestations remain positive statements by an attestor and keep the `attestations-db.json` shape.

### 2.6 Lifecycle status **[SITE-WIDE, additive]**
`status: "live" | "defunct" | "not-launched"` on issuer records and on `rwa-assets-db.json` records, with
`statusCheckedAt` (YYYY-MM-DD) and `statusNote` (≤ 200 chars: what was checked and the source URL).
`live` = the product can be minted/redeemed or traded today; `defunct` = wound down, delisted or the
issuer is gone; `not-launched` = announced, contracts may exist, no supply or no trading yet. A product
that was renamed or migrated keeps `live` and says so in `statusNote`.
Defunct records render greyed and are excluded from headline aggregates. `status` is a string, so the
existing score loop (which only counts "yes"/"no" values) ignores it.

### 2.7 Key governance per issuer (observed, in the dossier)
`keyGovernance: { mint: G, freeze: G, delegate: G, rebase: G, evidence: "..." }` with
`G ∈ "multisig" | "program" | "hot-key" | "none" | "unknown"` from `stocks/findings.md` ("Authority keys in
practice", "Multisig evidence", Superstate/Bullish/Securitize notes). Multisig = Squads program seen in the
key's transactions; program = the authority account is owned by an executable program or is a PDA; hot-key =
a plain system-owned funded wallet; none = the mints carry no such authority at all (only `rebase` reaches
this today — a mint with no scaled-UI-amount extension).

`rebase` is the FOURTH authority: the Token-2022 scaled-UI-amount (`scaledUiAmountConfig`) authority, read
per mint from `stocks/data/onchain.json`'s raw parsed accounts. It is not a lesser key. One signature from
it restates every holder's displayed balance without touching a single token account — PreStocks did it
undisclosed on SPACEX (×5, 2026-06-10) and OPENAI (×1.4861347, 2026-07-17), and Shift's SOX3S sits at ×0.1
today. On all 165 xStocks mints it is `S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS`, a key distinct from
the mint, freeze/pause and permanent-delegate keys. Where the rebase authority IS one of the other three
keys, it inherits that key's characterisation rather than being characterised twice.

## 3. Grading rules — `stocks/lib/grade.mjs`, pure, unit-tested

### 3.1 Ledger maturity (must equal `index.html`)
```
maturityStageNum(v): !yes(blockchainIsMainLedger) → 0; !yes(unconditionalTransfers) → 1;
                     !yes(bearerRedemption) → 2; !yes(forcedTransfers) → 3; else 4
maturityScore(v):    Σ over the TEN site booleans [blockchainIsMainLedger, unconditionalTransfers,
                     bearerRedemption, forcedTransfers, titleDeed, tokenSelfCustody, issuerIndependent,
                     presetJurisdiction, thirdPartyAttestations, aiReady] of (+1 if "yes", −1 if "no", 0 otherwise)
```
`v` is the dossier `vocabulary` object (`{key: {value, reason}}`) or a flat `{key: "yes"|"no"}`; accept both.
The dossiers' extra booleans (`reflectLegalDecisions`, `meetingOfMinds`, `assetSelfCustody`) are NOT scored
here and are NEVER written into `rwa-assets-db.json` (the page would sum them).

### 3.2 Claim depth
```
0 "synthetic exposure"                legalForm ∈ derivative, spv-synthetic
1 "unsecured claim on the issuer"     legalForm ∈ structured-note, tracker-certificate, debt-note  AND securityInterest.exists !== true
2 "secured claim on collateral"       legalForm ∈ structured-note, tracker-certificate, debt-note  AND securityInterest.exists === true
3 "beneficial interest in the security"  legalForm = spv-claim-redeemable
4 "registered share"                  legalForm = registered-share
null                                  other / unknown
```

### 3.3 Control surface (aggregate over the issuer's tokens in `onchain.json`)
For each of clawback (`permanentDelegate`), freezeAuthority (non-null), pausable, allowlist
(`defaultAccountStateFrozen`), hookActive (`transferHookProgram` non-null): `"all" | "some" | "none"`.
`transferFeeBps`: sorted distinct non-null values. `pausedNow`: count of `paused === true`.
`keyGovernance` and `freezeExercised` come from the dossier (`keyGovernance`, and a finding of type
`freeze-authority-has-been-exercised` → "yes"; else "unknown"; never "no" without evidence).

### 3.4 Verification strength
```
0 none            custodyVerification.type = none | unknown
1 issuer          issuer statement only (type absent but documents claim backing)   — use when type === "issuer-statement"
2 auditor         auditor-attestation (periodic)
3 daily agent     daily-verification-agent
4 on-chain PoR    chainlink-por
5 register        transfer-agent-register
```
plus `machineReadable` (boolean from the dossier).

### 3.5 Market reality per issuer (from `universe.json` + `reference-prices.json`, live tokens only)
`tokens, tokensListedOnJupiter, dexLiquidityUsd (Σ liquidity), vol24Usd (Σ buy+sell), organicSharePct
(Σ organic / Σ total ×100), holdersSum, medianTop10Pct, premiumMedianPct and premiumSampleSize (tokens with
liquidity > 50 000 and a finite premium), zeroVolumeShare (tokens with vol24 = 0 / tokens), pausedTokens`.
All sums use `Number.isFinite` guards; a missing value is skipped, never treated as 0.

### 3.6 Instrument type per token
`instrumentType ∈ stock | etf | fixed-income | commodity | crypto-etp | private-company | leveraged | unknown`:
Ondo from its `tagSlugs` (instrument-type stock/etf/cef and asset-class fixed-income/commodities/crypto-native);
prestocks, tessera → private-company; shift → leveraged; superstate, bullish, securitize → stock;
xstocks: `etf` if the name contains "ETF" or the underlying ticker is in a small documented ETF list
(SPY, QQQ, VOO, GLD, SLV, IWM, DIA, TLT, XLF, XLK, XLE, VTI, ITOT, BND, ARKK, IBIT, ETHA), else `stock`.

## 4. Repairs to existing site data (applied by `stocks/sync-assets-db.mjs --apply`; dry-run by default)
Issuer → `rwa-assets-db.json` record (keep existing `name`, `asset_image`, `asset_image_background`,
`website` when a record exists; upsert the rest):

| slug | record name | type | status |
|---|---|---|---|
| xstocks-backed | Kraken xStocks | Tokenized Equity (Tracker Certificates) | live |
| ondo-global-markets | Ondo Global Markets | Tokenized Equity (Structured Notes) | live |
| backpack-securities | Backpack Securities SPCX | Tokenized Equity (Trust Claim) | live |
| superstate-opening-bell | Opening Bell by Superstate | Tokenized Equity (Registered Shares) | live |
| bullish | Bullish BLSH | Tokenized Equity (Registered Shares) | live |
| securitize | Securitize SECZ | Tokenized Equity (Registered Shares) | live |
| prestocks | PreStocks | Tokenized Pre-IPO Exposure (Synthetic) | live |
| shift | Shift leveraged tokens | Tokenized Leveraged ETF Exposure (Derivative) | live |
| tessera | Tessera | Pre-IPO Loan Participation | live |
| remora-markets | Remora Markets | Tokenized Equity | defunct |
| ventuals | Ventuals Pre-IPO | Pre-IPO Perpetual Futures (Derivative) | defunct |

Fields written: `type`, `status`, `blockchain: "Solana"` (Ventuals: "Hyperliquid"), `tokenStandard:
"Token-2022"` (Ventuals: "n/a (perpetual positions)"), `contractAddress` (first sample mint), `description`
(≤ 320 chars, factual, from `holderClaim`), the TEN booleans from the dossier vocabulary ("yes"/"no";
"unknown" → key removed), `website`, `issuer`. New records get `asset_image` from the token metadata image
URI when one exists, else a neutral SVG data URI like `placeholder-db.json` uses.
Attestations: for each of these ten record names, delete the existing rows in `attestations-db.json` and
insert the dossier's (positive) attestations with `assetName` = record name. Findings are NOT written to
`attestations-db.json`; they live in the issuer records and `stocks-issuers.json`.

## 5. Attestation reconciliation policy (`stocks/reconcile.test.js` enforces it)
- Every `attestations[].schema` in an issuer record must exist in `attestation-types.json`; every
  `findings[].schema` in `finding-types.json`; slugs unique in both files; no `NEW:` prefix survives.
- Map the dossiers' `NEW:` slugs: reuse an existing type when the statement is the same claim
  (e.g. `onchain-holder-is-registered-beneficiary` → `token-represents-direct-ownership`;
  `digital-transfer-agent-maintains-subsidiary-register` → `offchain-register-is-authoritative-record`;
  `token-is-same-class-and-cusip-as-listed-security` → `token-represents-equity` with the CUSIP in `statement`);
  add a new positive type when no existing one fits (e.g. `issuer-publishes-canonical-mint-address`,
  `entire-cap-table-tokenized`, `token-venue-is-a-regulated-exchange`, `onchain-authority-is-program-derived`,
  `corporate-actions-applied-via-onchain-multiplier`, `allowlist-publicly-enumerable`,
  `redemption-rail-live`, `collateral-substitution-limits-disclosed`, `verification-report-published-at-contractual-location`,
  `non-security-legal-opinion-obtained`, `winddown-settlement-methodology-published`,
  `vault-depositors-repaid-in-full-at-winddown`); turn every negative or neutral observation into a finding type
  (e.g. `collateral-may-be-lent-to-prime-borrower`, `issuer-may-mint-against-expected-exposure`,
  `token-expires-worthless-after-deadline`, `issuer-may-rebase-holder-balances`, `transfer-fee-charged-on-chain`,
  `issuer-legal-entity-not-publicly-identified`, `issuer-has-wound-down`, `undisclosed-freeze-authority-on-mint`,
  `transfer-hook-claimed-but-not-deployed`, `register-and-chain-supply-differ`, `marketed-exemption-differs-from-filed-exemption`,
  `payout-valuation-issuer-determined`, `issuer-decides-authoritative-chain-on-fork`,
  `freeze-authority-has-been-exercised`, `authority-key-is-hot-wallet`, `no-token-terms-published`).
- Attestation records keep `attestor`, `attestationDate`, `expiryDate`, `status`, `onchain`, `link`, `statement`.

## 6. Proposals deferred (not implemented now, listed for the vocabulary page)
- Level 4 should key on `reflectLegalDecisions` (mechanism bound to legal process), not on the bare
  `forcedTransfers` capability.
- `aiReady` should be derived at render time, not stored/scored.
- `thirdPartyAttestations` should become verification strength site-wide.

## 7. Built database — `stocks-issuers.json` + `stocks-tokens.json` (repo root; built by `stocks/build-stocks-db.mjs`; the single `stocks-db.json` was split per §10.1)
```
{ builtAt, sources: { universe, onchain, sponsorApis, referencePrices, issuers: [slug…] },
  issuers: [ { slug, name, status, chains, products, issuingEntity, entityJurisdiction, governingLaw,
      regulatoryStatus, legalForm, holderClaim, underlyingCustodian, collateral, custodyVerification,
      securityInterest, bankruptcyRemote, redemption, transferRestrictions, dividends, voting,
      corporateActions, pricing, venues, incidents, documents, openQuestions, confidence, sources,
      keyGovernance, vocabulary, attestations, findings,
      grades: { maturityStageNum, maturityStage, maturityScore, claimRung, claimLabel,
                verificationStrength, verificationLabel, machineReadableVerification },
      control: { clawback, freezeAuthority, pausable, allowlist, hookActive, transferFeeBps, pausedNow,
                 keyGovernance, freezeExercised },
      recipes: [{label, mints}],   // lib/recipe.mjs: program + the SIX control extensions that are on
      market: { tokens, tokensListedOnJupiter, dexLiquidityUsd, vol24Usd, organicSharePct, holdersSum,
                medianTop10Pct, premiumMedianPct, premiumSampleSize, zeroVolumeShare, pausedTokens },
      tokenMints: [mint…] } … ],
  tokens: [ { mint, symbol, name, issuer, underlyingTicker, instrumentType, listedOnJupiter, decimals,
      supplyRaw, uiMultiplier, supplyUi, tokenProgram, metadataUri,
      control: { clawback, freezeAuthority, pausable, paused, allowlist, transferFeeBps, hookActive,
                 rebase },   // `rebase` = the scaled-UI-amount extension is installed on this mint
      market: { usdPrice, mcap, liquidity, holderCount, vol24, organicVol24, organicSharePct, traders24,
                top10HolderPct, firstPoolAt },
      reference: { source, price, premiumPct, marketOpen, ageSeconds, note },
      issuerApi: <the matching sponsor-apis item or null> } … ] }
```
`supplyUi = supplyRaw / 10^decimals × uiMultiplier` (the multiplier is the Token-2022 scaled-UI-amount
config; Jupiter's `usdPrice` is already multiplier-adjusted, so never multiply prices).
Issuers sorted by slug; tokens sorted by mint. Defunct issuers are included with `tokenMints: []` unless
the universe still holds their mints.

## 8. Site structure
- `stocks.html` + `stocks.js` + `stocks.css` (link from the header nav of `index.html`; reuse `styles.css`
  tokens and dark mode). Sections: (1) header with method note and data date; (2) the 5×5 grid of issuers
  (CSS grid, no chart library; bubble size ∝ log liquidity; defunct greyed); (3) issuer cards with grades,
  control icons, verification strength, market reality, findings/attestations counts; click → detail panel
  (dossier facts, documents, incidents, open questions, attestations, findings); (4) token table (441 rows,
  filter by issuer, search, sortable) with price, reference, premium, liquidity, volume, holders, flags;
  (5) methodology + gaps. Mobile-first (300–400 px), cache-busted `?v=` on script/style tags, all text in the
  HTML/JS (no i18n on this site), no `localStorage` dependence.
- `index.html`: add the nav link and a `.asset-defunct` row class when `row.status === "defunct"`. Nothing else.

## 9. Build order
`npm run stocks:all` (fetchers) → `npm run stocks:build` (stocks-issuers.json + stocks-tokens.json) → `npm run stocks:sync` (dry-run;
`-- --apply` to write rwa-assets-db.json / attestations-db.json) → open `stocks.html`.

## 10. Split database, parties graph and venues (added 2026-09-16, second pass)

### 10.1 Split (replaces `stocks-db.json`; no legacy file kept)
- `stocks-issuers.json`: `{ builtAt, sources, issuers: [ …§7 issuer records… ] }`.
- `stocks-tokens.json`: `{ builtAt, sources, issuerIndex: [{slug, name, status, legalForm, claimRung, maturityStageNum}], tokens: [ …§7 token records… ] }`.
  The page loads issuers first (cards + grid), tokens second (table), each with `{cache:'no-store'}`.

### 10.2 Parties (structured, cited) — new `parties` object in every issuer dossier
```
"parties": {
  "securitiesIssuers":     [P…],  // the listed company whose share is referenced/held (per token for register-mirrored programmes; null for wrappers with many underlyings — then the programme itself is the node)
  "tokenIssuers":          [P…],  // the legal entity issuing the token/wrapper (Backed Assets (JE) Ltd, Ondo Global Markets (BVI) Ltd, Trek Nexus Markets Ltd, SHIFT DAO LLC, …)
  "tokenizationProviders": [P…],  // platform/tooling operator when distinct from the issuer (Superstate, Securitize, Backpack/Trek Labs)
  "transferAgents":        [P…],  // registered transfer agents (Superstate Services LLC, Equity Stock Transfer, Equiniti, Securitize Transfer Agent LLC)
  "custodians":            [P…],  // where the underlying sits (Alpaca Securities, DekaBank, InCore Bank, regulated broker-dealers named by Ondo, …)
  "verificationAgents":    [P…],  // Ankura Trust Company, The Network Firm, Chainlink (PoR feed operator)
  "distributors":          [P…],  // CEXs/brokers that list or sell the token (Kraken, Bybit, Backpack Exchange, Bullish Exchange, Jupiter as router)
  "regulators":            [P…],  // FMA Liechtenstein, JFSC, SEC, FINRA, GFSC, VARA, RMI registrar
  "parents":               [P…],  // owners (Payward Europe/Kraken owns Backed Finance AG; Trek Labs = Backpack; Step Finance → Remora)
  "audience":              [P…]   // who may hold: "non-US persons", "KYC-verified Backpack users", "allowlisted wallets", "everyone (no KYC)"
}
P = { "name": <canonical>, "role": <same as the array key, singular>, "jurisdiction": "", "identifier": "" (CIK / LEI / licence no. / ISIN), "note": "", "source": "<url>" }
```
Canonical names (exact strings, so nodes merge across dossiers): Kraken, Bybit, Backpack Exchange, Bullish Exchange,
Jupiter, Raydium, Orca, Meteora, Kamino, Superstate, Securitize, Equiniti Trust Company, Equity Stock Transfer,
Ankura Trust Company, The Network Firm, Chainlink, Alpaca Securities, DekaBank, Security Agent Services AG,
Backed Finance AG, Backed Assets (JE) Limited, Payward Europe (Kraken), Trek Labs, Trek Nexus Markets, Trek Forge,
Sunrise, Ondo Global Markets (BVI) Limited, Ondo Finance, SHIFT DAO LLC, MINS LLC, Tessera Works Foundation,
RepublicX LLC, OpenDeal (Republic), Step Finance, FMA Liechtenstein, JFSC, SEC, FINRA, GFSC, VARA, Nasdaq, NYSE.

### 10.3 Venues per token — `stocks/fetch-venues.mjs` → `stocks/data/venues.json`
Keyless. Per token: DexScreener `GET https://api.dexscreener.com/tokens/v1/solana/<mint>` → pairs
`{dexId, pairAddress, quoteSymbol, liquidityUsd, volume24Usd, url}`; CoinGecko tickers
`GET https://api.coingecko.com/api/v3/coins/<id>/tickers` (id from `coins/list?include_platform=true`
matched on the Solana platform address; 377 of 441 map) → `{market, base, target, volume24Usd, trustScore, url}`.
Checkpoint per mint; pace DexScreener ≥ 250 ms and CoinGecko ≥ 2.5 s (free tier ~30/min); resume same day.

### 10.4 Graph — `stocks/build-graph.mjs` → `stocks-graph.json`
```
{ builtAt, nodes: [{ id, label, type, meta }], edges: [{ from, to, type, weight, via: [issuerSlug…], note }] }
node.type ∈ programme | security-issuer | token-issuer | tokenization-provider | transfer-agent | custodian |
            verification-agent | distributor | dex | lending | regulator | parent | audience
edge.type ∈ issues | wraps | tokenizes-for | keeps-register | custodies | verifies | distributes | traded-on |
            lends-on | regulated-by | owned-by | offered-to
```
Programme nodes are the 12 issuer records. Party edges come from `parties`; `traded-on` edges from
`venues.json` aggregated per programme (weight = Σ liquidity, fallback Σ volume; CEX from CoinGecko markets,
DEX from DexScreener dexIds); `lends-on` for Kamino when a dossier names it. `id` = slugified canonical name.

### 10.5 Graph page — `graph.html` + `graph.js` + `graph.css`
Force-directed layout in a pure, tested module `graph-layout.js` (no libraries; ~100 nodes), SVG rendering,
node colour by type, edge width by log weight, legend, filter chips per edge type, click a node → side panel
with its connections grouped by relation, search box, pan/zoom (pointer + touch), and a "focus programme"
select that dims everything not within two hops. Mobile: the SVG scales to the viewport; the panel becomes a
bottom sheet.

## 11. Trading activity and the glossary (added 2026-09-16, third pass)

### 11.1 What "liquidity" and the other market words mean here
- **Liquidity** — USD value of the reserves in the token's DEX pools (Jupiter's aggregate over Raydium, Orca,
  Meteora pools): depth that can absorb a trade, not a count of trades. A CEX venue never reports it.
- **Volume 24h** — USD traded in the last 24 h (Jupiter, all routes). **Organic volume** — the part Jupiter
  classifies as non-bot flow; **organic share** = organic / total. **Trades 24h** — number of buys + sells;
  **Traders 24h** — distinct trading wallets; **Trades per trader** — the wash-trading tell (a few wallets
  producing thousands of trades). **Holders** — token accounts with a balance (Jupiter). **Top-10 %** — share
  of supply in the ten largest accounts. **Venues** — distinct DEX ids (DexScreener) + exchange markets
  (CoinGecko) where the token has a pair; **Last trade** — the most recent `last_traded_at` across CoinGecko
  tickers (per-venue timestamps; no on-chain per-trade history is collected).
- Not collected (say so on the page): per-trade on-chain history, counterparty/wallet-level analysis, order-book
  depth on CEXs, exact trade timestamps on DEXs.

### 11.2 Per-token `activity` (build-stocks-db.mjs; sources: universe stats24h, venues.json)
```
activity: { buys24, sells24, trades24, traders24, organicBuyers24, tradesPerTrader,
            dexPairs, dexTxns24, cexMarkets, venueCount, lastTradedAt, lastTradedVenue }
```
`dexTxns24` = Σ DexScreener `txns.h24.buys + sells` over the token's pairs (kept in venues.json as
`txns24` per pair, shaped from the raw checkpoint); `lastTradedAt` = max `lastTradedAt` over `cex[]` (ISO),
`lastTradedVenue` its market. Every field null when unknown, never 0.

### 11.3 Per-issuer `activity` aggregate (live tokens only)
```
activity: { tokensTraded24 (tokens with trades24 > 0), trades24, traders24 (Σ, wallets may overlap across
            tokens — say so), tradesPerTrader, organicSharePct, venueCount (distinct venues across tokens),
            venuesTop: [{name, kind: dex|cex, volume24Usd, liquidityUsd}], lastTradedAt, lastTradedVenue }
```

### 11.4 Page
- Grid row labels (Level 0–4) get `title` tooltips with the ladder definitions, mirroring the column captions.
- A **Trading activity** overview table between the grid and the issuer cards: one row per live issuer —
  tokens traded 24h / tokens, trades 24h, traders 24h, trades per trader, organic %, venues, last trade
  (relative + absolute on hover), with a one-line note on what is and is not collected.
- **Token detail panel**: clicking a token row opens a dialog (same pattern as the issuer panel) with
  sections Identity & on-chain (mint, program, decimals, supply UI-adjusted, control flags, metadata URI),
  Market (price, liquidity, volume, organic share, holders, top-10 %), Trading activity (§11.2 fields),
  Venues (each DEX pair with liquidity/volume/txns and each CEX market with volume and last trade, linked),
  Reference (source, price, premium, market open/closed, age).
- Token table gains columns Trades 24h, Traders 24h, Last trade; the Liquidity header gets a `title` with
  the §11.1 definition; a Glossary subsection under Methodology repeats §11.1.

## 12. Live tape and the 24-hour replay (added 2026-09-16, fourth pass)

### 12.1 What is real and what is not
Per-trade data exists only for Solana DEX pools: every swap is a transaction on the pool address, readable
from the public RPC. Exchange (CEX) trades are not available keyless, so the tape covers the sampled DEX pools
and says so. Nothing is interpolated: the replay animates trades that were actually collected.

### 12.2 Collector — `stocks/fetch-recent-trades.mjs` (+ pure `stocks/lib/trades.mjs`, tested)
- Sample set: the top 15 DEX pools by `volume24Usd` in `stocks/data/venues.json` (`pairAddress`, `dexId`,
  `quoteMint` — added to `shapeDexPair`), refreshed each run; DexScreener `priceUsd/priceNative` per pool
  gives `quoteUsdRate` (USD per quote unit) for SOL-quoted pools; USDC/USDT-quoted pools use 1.
- Per run: `getSignaturesForAddress(pair, {limit: 50})`; failed signatures (`err`) are counted per pool as
  `failedTx` and never fetched; successful ones not yet stored are fetched with
  `getTransaction(sig, {encoding: 'jsonParsed', maxSupportedTransactionVersion: 0})`, paced ≥ 600 ms,
  exponential backoff on 429, a run budget of ≤ 120 transactions.
- Decode (pure, from `meta.preTokenBalances/postTokenBalances`): the POOL's own deltas (owner === pair)
  for the tracked mint (`tokenDelta`) and the quote mint (`quoteDelta`); side = "sell" when the pool gained
  the token, "buy" when it lost it; `size = |tokenDelta|`, `quoteAmount = |quoteDelta|`,
  `priceQuote = quoteAmount / size`, `priceUsd = priceQuote × quoteUsdRate`; `feePayer` = accountKeys[0];
  `routed` = true when the transaction moved more than two distinct mints (aggregator/arbitrage path);
  `programs` = distinct non-compute program ids. A transaction with no pool delta for the mint is skipped
  and counted as `undecodable`.
- Store `stocks/data/trades-24h.json` (rolling: dedupe by signature, prune older than 24 h, keep
  `collectingSince`), and publish `stocks-trades.json` (repo root) =
  `{ generatedAt, collectingSince, pools:[{pair, mint, symbol, dex, quoteMint, quoteSymbol, quoteUsdRate,
  signaturesSeen, failedTx, decoded, undecodable}], trades:[…newest first…],
  hourly:[{hourStart, byDex:{[dexId]:{trades, volumeUsd, buys, sells, traders}}}] (24 buckets ending now),
  totals:{trades, volumeUsd, traders, failedShare} }`.
- `--every=<s>` loops with timestamped progress (`k/N pools · new trades · failed share · next run in`);
  restartable; `--once` default. Scheduling: `run-job start trades node stocks/fetch-recent-trades.mjs --run --every=120`.

### 12.3 Page — `live.html` + `live.js` + `live.css` (module script; imports `stocks/lib/trades.mjs`)
- **Tape**: the 20 newest trades (token, venue, side, size, price USD, relative time ticking every second,
  routed/arb label, Solscan link), newest first, re-read from `./stocks-trades.json` every 60 s; a
  "collected since" line; a per-pool failed-transaction share ("bot spam") strip.
- **Go live** toggle (off by default): opens a WebSocket to a public RPC (default
  `wss://api.mainnet-beta.solana.com`, editable field), `logsSubscribe` with `mentions: [pair]` for each
  sampled pool at `confirmed`; failed logs increment the live failed counter; successful signatures are
  fetched over HTTPS with the same decode, queued ≥ 400 ms apart, queue capped at 50 (excess dropped and
  shown as "throttled"); new trades prepend to the tape with a highlight. Disconnect cleanly on toggle-off
  and on page hide.
- **24-hour replay**: SVG timeline of the 24 hourly buckets stacked by venue (trades and volume), a cursor
  sweeping the window over ~30 s with counters accumulating (trades, volume USD, distinct traders, failed
  share); play/pause/restart; when fewer than 24 h were collected the empty hours are hatched and the caption
  says "collecting since …". Honours `prefers-reduced-motion` (no auto-play; step buttons instead).
- Nav link on index, stocks and graph pages. Mobile: tape as cards, timeline scrolls in its own container.
