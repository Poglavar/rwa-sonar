<!-- Research record for the Securitize Stocks launch: documentary conclusions, chain observations and unresolved account-specific questions. -->
# Securitize Stocks: launch review, 8 October 2026

**The new stock tokens give a broker-recorded beneficial interest with a documented exit into conventional shares. They are not the same legal product as issuer-sponsored SECZ.** The strongest protection is the stated share entitlement and independent-of-issuer-adoption DRS exit. The main dependencies are Securitize's books, compliance decisions, underlying custody and the administrative keys.

This is a programme review. Exact addresses are verified against the official catalogue, but authenticated order disclosures and signed customer agreements were not accessed. GOOGL also has an unresolved launch/catalogue share-class mismatch.

## What the documents establish

| Area | Finding | Evidence |
| --- | --- | --- |
| Ownership | CET holders are described as beneficial owners of specifically credited share positions. Ordinary ETs expressly lack that beneficial ownership and have different exit rights. | [CET disclosure][disclosure], sections 2, 4.1, 5.1–5.4 |
| Legal ledger | SM's books govern the security entitlement. A token transfer instructs a book-entry debit/credit; recording it completes the legal transfer. | [Account agreement][account], “SM as Securities Intermediary” |
| Backing | 1:1 backing and no lending are issuer statements. No independent dated share-to-token reconciliation or exact upstream custody account was located. | [Launch][launch]; disclosure sections 4.2 and 6.2; account agreement custody provisions |
| Exit | CET cash redemption is excluded. Holders may sell or request conversion and DRS transfer to an accepting DTCC-member broker. This route does not require the stock issuer to adopt tokenization. No completed CET DRS transfer was verified. | Disclosure sections 4.5–4.6; [fee schedule][fees] |
| Costs and access | Published CET commission is 0.1%; DRS transfer-out is $30 plus receiving-broker charges. KYC/AML and approved wallets apply. FAQ lists 04:00–17:30 ET trading. | [FAQ][faq]; fee schedule |
| Corporate actions | SM passes through actions against the underlying position; fees, tax, early election deadlines and processing delay matter. Votes are expected to pass through, subject to the unpublished-on-page proxy policy. | Disclosure section 8 |
| Failure | Article 8 protects interests in assets actually held for entitlement holders, subject to priority rules. That does not establish pool completeness, immediate recovery or SIPC eligibility for every custody model. | [New York UCC 8-503][ucc]; [8-511][priority]; [SIPC][sipc] |

## Issues that need clarification

- **Self-custody and SIPC:** the agreement excludes held-away wallet assets from protection through SM, while describing expected protection for CET underlying-share positions. That distinction needs an account-specific answer; neither blanket protection nor blanket exclusion of the underlying shares is established.
- **Broker lien:** SM takes a lien for customer obligations over assets it carries. Held-away wallet assets are carved out absent a separate control agreement. Upstream custodian liens have not been checked.
- **Document precedence:** the account agreement prevails over the entitlement disclosure in conflicts. The disclosure separately overrides specified general platform terms. The library's Markets Terms link returned 404 during this review.
- **GOOG / GOOGL:** the launch says GOOG; the catalogue and product page identify GOOGL Class A, ISIN US02079K3059 / CUSIP 02079K305. Do not silently treat the share classes as interchangeable.
- **Regional account chain:** April 2026 EU terms describe a reception/transmission service and no custody by Securitize Europe. The exact relationship between an EU client, that firm and the US intermediary requires the actual onboarding agreements.
- **Administrative powers:** self-custody does not eliminate the token programme's intervention powers. Authority signing policy and mint/thaw programme upgrade paths remain unverified.

The account agreement generally uses “Custodial” for CET, while the entitlement disclosure uses “Convertible”. This review records that terminology mismatch; the executed order documents must identify the actual product. An ET is not assigned the CET conversion rights.

## What was observed on-chain

All 12 new catalogue addresses existed as Token-2022 mints at finalized slot **454613378**, observed **2026-10-08T17:36:33.771067+00:00**. All had positive supply, default-frozen accounts, permanent delegate, pause capability and scaled-UI authority. None was paused; multipliers were 1. No active transfer-hook or transfer-fee extension was found in these observations.

The delegate, pause, scaled-UI and metadata authority is shared:
`Ui3bQKRdTzNRv21sPuXTgmzuz4dLh3sH3B9Y5sxapSR`.
It is an on-curve, funded, system-owned zero-data account (finalized slot 454614970). This identifies one on-chain authority, not how many people or MPC approvals are required. AAPL's mint/freeze authority is off-curve and absent as an account; its controlling programme was not identified.

A [successful AAPL swap][swap] exchanged **10 USDC for 0.029543 AAPL tokens**, including a separate 0.01 USDC fee leg. This proves a secondary exchange occurred; it does not verify backing, independent counterparties or a DRS exit. Block time is retained separately from observation time in the [observation record](securitize-stocks-2026-10-08.observations.json).

| Catalogue symbol | Official Solana mint |
| --- | --- |
| AAPL | `3J7XcwApkHKUKnNL6bbrA5pmFhCKZ3RB9VG63aAukBzD` |
| AMZN | `8kVtvtb8cj512xeweEchkNVUccvcXq2Yo7CvDPZpytBP` |
| CRCL | `8NxJNxfZKW2ST1ZmNbthRoHbXB9yB4Gi7V7vVV3KH38h` |
| GOOGL | `2qXFRgxeYUkc19JBAzRvZZReAhVTWFd31m9qM2C3a2GK` |
| META | `3jVWyof7Ks14Kpd4GmKk6c8ktErxPMEwD9XR2VfJKeu1` |
| MSFT | `6V4gLu7aC63e6CTEJXu71wtx5FMrZ3FQoST7UXXqgPuQ` |
| MSTR | `4V3ZstipcG21LbEB5usTx4VcJGjcsxKnrExPK1QwaJC1` |
| NFLX | `3i57nfnGeTccVgPfNG2PGAkdH7Mfs81mG2CwijtBTbcX` |
| NVDA | `6yqHep7MGiy3tTkQv54BkjiATGdVszWZCp36j1VPCsF3` |
| PLTR | `hRhNSeHmMDuUntu44WSu5D25gy8R35ctw3UG3HeCHKi` |
| SPCX | `CkZoZ5vu2uuayHzJgavBjARyEeGrTMWMmbbt867jAFrj` |
| TSLA | `HMgreFGFGZswE8L2zF2hNeWaSunwFAV93gWiTB9tjFUv` |

The same official catalogue now publishes the existing SECZ mint. Its earlier metadata-only identity gap is resolved; its separate register-continuity questions remain open.

## Coverage and monitoring

Before this review, main and unification had the SECZ dossier but no Securitize Stocks CET dossier or these 12 token addresses. The public stock catalogue also contained only SECZ for Securitize.

The local research change adds a distinct CET programme, reviewed exact-mint seeds, sourced holder-rights entries and a dated launch event. The existing chain collector can pick up the seeds when the catalogue is next refreshed. It does not claim that monitoring is already active.

The source registry now discovers the catalogue, FAQ, disclosure library, fee table and both agreements. **The two agreement downloads are DOCX, despite being presented as generic document links. The initial audit found no DOCX text reader.** This change adds a bounded Word reader to the existing hash, clause-diff and quote-check pipeline. It reads both agreements successfully and retains document text while ignoring editor metadata; tables, notes and accepted tracked changes are covered by tests. Their original byte hashes and formats remain in the observation record. A rendered disclosure-library link inventory and an explicit catalogue parser would also be more dependable than an HTML-only homepage watch. The public catalogue API returned 403; the reviewed catalogue came from the public server-rendered page.

Prepared monitor priorities: exact mint additions and share-class changes; authority/pause/freeze changes; agreement replacements and clause changes; commission/DRS fees; trading windows; redemption availability; independently published reserve reports. No monitor jobs, database writes or notifications were triggered by this research.

[disclosure]: https://cdn.builder.io/o/assets%2Fd39b51a544e84e2fbb2445f58c6c6f2c%2Ff4e08e665f6c4dd5acd83a5cc7fda905?alt=media&token=25f5b338-6342-4e22-a8df-8524b558f798&apiKey=d39b51a544e84e2fbb2445f58c6c6f2c
[account]: https://cdn.builder.io/o/assets%2Fd39b51a544e84e2fbb2445f58c6c6f2c%2Fd0cf0550f96f4acd8a0fbc95ecd93878?alt=media&token=f44f0bf3-2984-4535-ae58-eba6fe4901ca&apiKey=d39b51a544e84e2fbb2445f58c6c6f2c
[launch]: https://x.com/Securitize/status/2108180783827411451
[fees]: https://securitize.io/fee-schedule-table
[faq]: https://stocks.securitize.io/faq
[ucc]: https://www.nysenate.gov/legislation/laws/UCC/8-503
[priority]: https://www.nysenate.gov/legislation/laws/UCC/8-511
[sipc]: https://www.sipc.org/for-investors/what-sipc-protects
[swap]: https://explorer.solana.com/tx/2ggjAjXokTeQRr3WggB2MxrbfKnHLTiANb4vCPQbUkZUQQJ4Gedd1d1cxSL3mdUziuRaAzhjnxakfAxp8s4dLrJt
