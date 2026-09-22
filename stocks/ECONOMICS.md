<!-- Data contract, research boundaries and integration plan for fees and actor incentives. -->
# Fees, costs and incentives

The user made actor economics a first-class product dimension on 22 September 2026. The question
is not merely “how much is the fee?” but “who is paid for what, and does that arrangement continue
to serve the holder over time?”

## First implementation

`economics.html` reads the curated `stocks/data/economics.json` through the pure
`stocks/lib/economics.js` model. All twelve catalogue programmes have an entry. Ondo, xStocks and
PreStocks have initial, partial research; the other nine are expressly unreviewed. This is not
complete coverage of every actor, product or route, nor a new legal opinion on all existing terms.

The view supports a single programme or any number of programmes, for example:

- `/economics.html?issuer=xstocks-backed&product=FGDLx`
- `/economics.html?issuers=ondo-global-markets,xstocks-backed,prestocks`

Product-specific examples never automatically apply to another ticker. Route, chain and holder
conditions are checked independently of the scope label. An unresolved condition means context is
still needed, not that a fee applies. Programme comparisons intentionally compare disclosures, not
personalised cost quotes. Unknown figures remain `null`; there is no summed fee or ranking.

Sources keep separate observation, page-check and document dates. The dataset's assembly date
is not a fresh observation of a transfer fee or a re-review of a prospectus. Two official Ondo HTML
pages and the TSLAx product page were checked on 22 September; the initial view reuses earlier
dossier observations for governing PDFs and PreStocks. The PreStocks terms could not be freshly
retrieved in this pass. The view does not add a collector or make additional CoinGecko calls.

## Holder cost path

Keep these amounts separate until an exact route and a valid calculation basis are known:

| Layer | Research questions |
|---|---|
| Enter | Issuance, onboarding, broker commission, quote spread, wallet/venue fee, FX and network cost |
| Hold | Management, administration, custody, underlying fund expense and financing deductions |
| Move / use | Token transfer fee, bridge, liquidity provision, borrow interest and protocol charges |
| Exit | Exchange spread/slippage versus direct redemption fee, settlement and minimum-size constraints |
| Tax | Underlying withholding versus the holder's own taxes; tax is not issuer fee revenue |
| Stress | Liquidation incentive, recovery expenses, termination and insolvency waterfall priority |

Current charge, measured deduction, contractual permission, published ceiling, temporary waiver and
unknown amount are different assertions. A cap in a programme prospectus and a lower product-page
allowance must not be added together or silently substituted for the applicable Final Terms.

## Follow each economic relationship

Expand from the known legal chain: issuer/SPV and sponsor, broker, custodian/sub-custodian, asset or
fund manager, administrator/transfer agent, security agent/trustee, attestor/oracle provider,
distributor/wallet, exchange/market maker, liquidity provider, lender/DeFi protocol, liquidator and
bridge where applicable. A role is a research question until its actual participant is identified.
The underlying company is a separate actor; issuing a wrapper does not itself pay that company.

For each applicable relationship establish:

1. Named payer and recipient, including related-party connections and ultimate beneficiary when evidenced.
2. Basis: fixed fee, AUM, transaction volume, spread, performance, asset lending, interest or subsidy.
3. Who bears the cost economically, even where a different entity pays the invoice.
4. Current amount, permitted ceiling, denomination, basis, frequency and any minimum/maximum.
5. Who can change or waive it, notice/consent requirements, and how a holder can leave.
6. Incentive analysis: what supports continued service, what conflicts with holder outcomes, and who bears loss.
7. Under low AUM, low activity, subsidy expiry, provider replacement, termination or insolvency, what changes?

Do not invent an intermediary's fixed-fee business model from its job title. Do not equate a token
fee-withdrawal authority with the legal revenue beneficiary. Permission to lend securities does not
establish that assets are lent, who earns the income, or that holders participate in it.

## Evidence and monitoring integration

The first edition is a curated view, not an autonomous economics watcher. Its source URLs overlap
existing dossiers, but this does not establish watcher coverage for every economics assertion.
The existing morning-digest policy should remain unchanged when this research is extended.

The next bounded research pass should resolve exact current product schedules/Final Terms,
service-provider compensation and related-party relationships, securities-lending income allocation,
and route-specific DEX/lending charges. Then register explicit economics source dependencies and
compare structured changes in charge, cap, recipient, discretion and waiver expiry. A changed page
should trigger review, not automatically rewrite a legal conclusion or report that a fee changed.

Only after exact route coverage is adequate should a scenario calculator estimate costs. It must
show missing components, assumptions, quote time/expiry and whether repeated transfer fees compound.
Do not call a partial sum the total cost of ownership.

## Tests

`stocks/economics-model.test.js` locks scope matching, unknown preservation and real-data invariants.
`economics-page.test.js` covers safe rendering, source dates, explicit load failure and one/two/many
programme selection. These run without a browser. Manual headed inspection covers the new page and
the separate dolphin artwork/placement concepts at `/design/dolphin-detectives/`.
