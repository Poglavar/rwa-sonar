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
`status: "live" | "defunct" | "not-launched"` on issuer records and on `rwa-assets-db.json` records.
Defunct records render greyed and are excluded from headline aggregates. `status` is a string, so the
existing score loop (which only counts "yes"/"no" values) ignores it.

### 2.7 Key governance per issuer (observed, in the dossier)
`keyGovernance: { mint: G, freeze: G, delegate: G, evidence: "..." }` with
`G ∈ "multisig" | "program" | "hot-key" | "unknown"` from `stocks/findings.md` ("Authority keys in practice",
"Multisig evidence", Superstate/Bullish/Securitize notes). Multisig = Squads program seen in the key's
transactions; program = the authority account is owned by an executable program or is a PDA; hot-key = a
plain system-owned funded wallet.

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
`attestations-db.json`; they live in the issuer records and `stocks-db.json`.

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

## 7. `stocks-db.json` (repo root; built by `stocks/build-stocks-db.mjs`)
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
      market: { tokens, tokensListedOnJupiter, dexLiquidityUsd, vol24Usd, organicSharePct, holdersSum,
                medianTop10Pct, premiumMedianPct, premiumSampleSize, zeroVolumeShare, pausedTokens },
      tokenMints: [mint…] } … ],
  tokens: [ { mint, symbol, name, issuer, underlyingTicker, instrumentType, listedOnJupiter, decimals,
      supplyRaw, uiMultiplier, supplyUi, tokenProgram, metadataUri,
      control: { clawback, freezeAuthority, pausable, paused, allowlist, transferFeeBps, hookActive },
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
`npm run stocks:all` (fetchers) → `npm run stocks:build` (stocks-db.json) → `npm run stocks:sync` (dry-run;
`-- --apply` to write rwa-assets-db.json / attestations-db.json) → open `stocks.html`.
