<!-- Draft data model for the Solana tokenized-stocks extension of rwa-sonar. Two record kinds: issuer dossier (hand-researched, cited) and token record (machine-collected). -->
# Stocks data model — draft v0 (2026-09-16)

## Principles
- Two layers, never mixed: **issuer dossier** (legal/custody facts, hand-researched with citations, ~7 records) and **token record** (per mint, machine-collected daily, ~400 records). A token inherits its issuer's dossier; only on-chain and market facts live per token.
- Every fact carries provenance: `source` (url or `rpc:getMultipleAccounts` etc.) and `observedAt`. Grades are derived, never stored as inputs.
- Existing rwa-sonar vocabulary booleans stay the backbone (blockchainIsMainLedger, unconditionalTransfers, bearerRedemption, forcedTransfers, titleDeed, tokenSelfCustody, issuerIndependent, presetJurisdiction, thirdPartyAttestations, aiReady, reflectLegalDecisions, meetingOfMinds) and the maturity levels 0–4. Equity-specific facts feed a second, sector-specific grade.

## Token record (machine-collected) — `stocks/data/*.json` merged into `stocks-issuers.json` / `stocks-tokens.json` (originally one `stocks-db.json`)
identity: mint, symbol, name, issuer (slug), underlyingTicker, underlyingName, instrumentType (stock|etf|cef|bond-etf|commodity-etf|private-company|leveraged), listedOnJupiter, chains (from CoinGecko platforms), coingeckoId
onchain (RPC): tokenProgram, decimals, supply, mintAuthority, freezeAuthority, permanentDelegate, transferHookConfigured, transferHookProgram, pausable, paused, defaultAccountStateFrozen, transferFeeBps, confidentialTransfers, uiMultiplier, metadataUri, metadataUpdateAuthority, authorityIsMultisig (per key: squads|program|hot|unknown), freezeEverExercised (from authority activity sample)
market (Jupiter): usdPrice, mcap, liquidity, holderCount, vol24, organicVol24, organicSharePct, traders24, top10HolderPct, firstPoolAt, venues (DexScreener dexIds), cex (CoinGecko tickers: exchange → 24h usd, trust score)
reference: refSource (pyth|ondo-implied|issuer-mark|none), refPrice, premiumPct, marketOpen (Pyth market_hours / Ondo session), offHoursTradable
issuerApi (when the issuer publishes one): ondo {ondoPrice, isTradingPaused, pauseReason, tagSlugs}, prestocks {markPrice, tokenPrice, impliedValuation, supply}, tessera {markPrice, holders, markValuation}

## Issuer dossier (hand-researched) — `stocks/data/issuers/<slug>.json`
Shape as briefed to the research agents: issuer, products, issuingEntity, entityJurisdiction, governingLaw, regulatoryStatus, legalForm (registered-share | spv-claim-redeemable | structured-note | tracker-certificate | spv-synthetic | derivative), holderClaim, underlyingCustodian, collateral {ratio, composition, rehypothecation, onLoanDisclosed}, custodyVerification {type, agent, frequency, link, machineReadable, endpoint}, securityInterest, bankruptcyRemote, redemption {available, eligibility, rails, fees, minimum, kyc}, transferRestrictions {allowlist, kycToHold, usPersonsExcluded, mechanism}, dividends, voting, corporateActions, pricing {referenceMarket, arbitrageable}, venues, chains, incidents[], documents[], vocabulary{…12 booleans with reasons}, attestations[] (attestation-types.json slugs), confidence, openQuestions, sources.

## Derived grades (computed, explainable, each with the inputs listed)
1. **Maturity level 0–4** (existing rwa-sonar rule) from the vocabulary booleans.
2. **Holder-claim tier** (equity-specific ladder): synthetic/derivative < tracker certificate (bearer debt) < structured note with security agent < SPV claim redeemable into securities entitlement < registered share on cap table.
3. **Control surface** (on-chain, per token): clawback (permanentDelegate) · freeze · pause · transfer fee · hook active · multisig-controlled keys · freeze exercised. Shown as facts, not summed.
4. **Verification strength**: none < issuer statement < auditor attestation (periodic) < daily verification agent < on-chain PoR feed < transfer-agent register. Plus machineReadable flag.
5. **Market reality**: DEX liquidity, organic share, premium vs reference, holder concentration, off-hours tradability. Thresholds documented on a methodology page.

## Known gaps (to state on the methodology page)
- Universe = Jupiter search union + manual seed (allowlisted tokens such as Superstate Opening Bell are not on Jupiter); authoritative per-issuer enumeration by mint authority needs a paid RPC.
- Pyth prices need a Pyth Pro key (feed list is public); fallback reference = Ondo-implied underlying price.
- After-hours volume share needs per-interval volume history (not in free CoinGecko/Jupiter); freeze-event counts come from a small recent sample per key, not full history.
