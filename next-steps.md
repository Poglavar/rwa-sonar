# RWA Sonar next steps — hackathon audit and priority reset

Reviewed 22 September 2026 against commit `05c5bf6` on `colosseum-worlds-fair`, the live site,
public API, production publication state, research artifacts, README, submission draft and pitch.
This is a review and proposed roadmap; the actions below have not been implemented by this audit.
The worktree was clean at the start. The earlier [UX audit](UX-audit1.md) remains the historical
baseline. Original task numbers 1–24 are retained below; new audit actions use 25–36.

## Product judgment

There is enough functionality for a strong hackathon entry. The combination of exact-token
identity, legal claim analysis, issuer controls, confirmed protocol support and continuing
monitoring is worth preserving. The source-backed comparison is the strongest product journey.
The next iteration should concentrate that value and make its conclusions more dependable.

The current weakness is the distance between having the research and helping someone use it.
The site still presents too many entry points, repeated explanations and research taxonomies.
Several reassuring labels imply more than their underlying checks establish. Some generated
pages were absent from the deployed release during this audit. A longer feature list will not
resolve those problems. The general case for tokenization is outside this hackathon product's
core job and should be removed from the main journey or reduced to a short optional explanation.

Proposed primary user: someone considering holding or using a tokenized stock who understands a
wallet but cannot evaluate a prospectus, custody chain and token program unaided. A protocol risk
team is a promising second audience and potential customer; that is a hypothesis to validate,
not traction to claim. The core promise should be:

> Understand what this stock token gives you, where you can use it, and what you must trust.

Make the journey branch naturally after discovery:

- **Two or more wrappers:** compare the legal claim, controls, exit and confirmed use, then inspect
  the evidence and follow material changes. This is the signature experience.
- **One wrapper:** open a standalone diligence report that answers the same questions without an
  empty or forced comparison. A token with no DEX pair must still have a useful report: market exit
  is shown as unavailable or unconfirmed while ownership, control, redemption, evidence and
  theoretical/confirmed DeFi use remain fully inspectable.

Retain the deeper research surfaces, but put them behind these journeys. Keep the current visual
identity and plain-JavaScript architecture; neither needs a wholesale replacement for the hackathon.

## What has actually been achieved

- Stock-first discovery, grouped search, two-wrapper comparison, private saved items, shareable
  comparison watches, configurable token tables and explicit missing/error states.
- A substantial research model: reusable legal/technology templates, jurisdiction and holder
  scope, authority/precedence metadata, claims-versus-reality records, a trust graph and failure
  scenarios. Template inheritance is the right way to scale research across many tokens.
- Exact-address DeFi listings with actions, market parameters, source links and limited on-chain
  corroboration; theoretical composability is separately explained.
- Static token reports, generated issuer/template dossiers, paginated token/trade API routes,
  historical snapshots, hourly control observation and daily source watching.
- A better visual hierarchy, keyboard/focus improvements, mobile comparison cards, a public
  change journal, Learn guides and a web-native pitch.

The live snapshot during the review reported 1,183 token addresses and six daily observations
(16–21 September). The live DeFi view reported 133 addresses with some confirmed support, 27 with
lending/collateral support and 1,050 with none confirmed. These are coverage observations, not
counts of independent legal reviews, active users or proven executable positions. The older
125-asset figure in the pitch/submission is explicitly a reviewed snapshot but needs its date
beside it. Keep catalogue breadth, active circulation, measured markets and reviewed legal
templates as different denominators.

## Critical findings and their evidence

| Finding | Observed evidence | Consequence |
|---|---|---|
| Generated issuer routes were not ready after deployment | At approximately 00:20 UTC on 22 September, `/issuers/xstocks-backed.html` and `/issuers/ondo-global-markets.html` returned the landing-page HTML. SSH confirmed both the checkout and docroot lacked `issuers/`; a refresh was still collecting market data. | The advertised dossier journey was broken even though Git, the landing page and API health looked correct. New generated pages currently depend on a subsequent network-bound refresh. |
| Legal health means less than its name suggests | The live NVDAx card displayed **Legal / evidence: good — Reserve verification**. The xStocks comparison reported three required fields lacking evidence and 32 claims awaiting rechecking. `stocks/lib/health.mjs` puts only the reserve-verification rule in the legal dimension. | A passing reserve-evidence grade can look like a complete legal assessment. The richer evidence model is not connected to this headline verdict. |
| Mobile still delays the answer | At 390×844 on the AAPL comparison, its section heading began around y=826; the first decision difference began around y=1,979. The page was about 6,670 px tall. NVDAx was about 6,615 px tall with five expanded DeFi entries. | The repeated introduction, metadata and filters consume the first screens. Items 2, 3 and 11 have implementations, but their comprehension goals are not yet met. |
| Disclosure hides content without removing its cost | Explore contained about 11,367 DOM elements; comparison about 11,331. `stocks.js` initializes other views and fetches full issuer/token artifacts as well as API-backed rows. | API pagination does not yet mean a small initial page. The submission's claim that the full dataset is not loaded needs qualification. |
| Public history boundaries are inconsistent | AAPL history tooltips included first-read `baseline recorded` events for hundreds of issuer tokens. The underlying-history query in `api/src/routes/history.js` selects issuer events without the public-journal filter. | Initial collection appears alongside events that actually changed the asset. This violates the intended distinction between research activity and external change. |
| Journal priority is too coarse | Two Ondo documentation URL moves led the highest-impact group above a PreStocks fee change. A document relocation was described as potentially changing holder rights although the entry itself says the redemption channel remained documented. | An important change can be buried under maintenance context. Event category alone is not enough to determine holder impact. |
| Discrepancy scope needs finer judgment | The reserve-API coverage issue is attached to the whole xStocks programme, including NVDAx, although the cited missing reserve rows concern two named products. Backpack's programme name still says SPCX on AMD/MU listings. | Programme-wide evidence limitations and asset-specific adverse facts are too easy to confuse. These are scope/presentation findings, not proof that the underlying legal analysis is wrong. |
| On-chain corroboration is limited | `stocks/fetch-defi-usage.mjs` requests zero account-data bytes; `stocks/lib/defi-usage.mjs` grants its on-chain tier when at least one referenced account exists. Owners are recorded, but the tier does not require decoded mint/configuration or a successful transaction. | Account existence supports registry evidence; it does not independently prove usable collateral, current borrow capacity or liquidation. The UI partially explains this, but headline labels should be equally precise. |
| The watcher needs an evidence-recovery workflow | A live collector-status response showed 543 checked source URLs: 74 blocked, three errors and one gone, with 191 marked changed. | A recent attempt is different from readable, unchanged evidence or a reviewed conclusion. “Continuously monitored” must preserve those distinctions. These counts do not establish 191 material legal changes. |
| The pitch is still mostly a feature presentation | Twelve slides describe the model, but there is no complete named asset example. Slide 8 labels an unattributed 70%→60% collateral-factor example “Observed change.” | Judges must imagine the payoff. Use a sourced event, or label an illustration explicitly. Add actual team information and validation evidence without inventing either. |
| Submission/source packaging has gaps | The pitch links to the repository root; GitHub's default branch is `main`, while this release is on `colosseum-worlds-fair`. No repository license file was found and GitHub reports no license. The deck says “Colosseum · 2026.” | Reviewers may land on the wrong code. Public source availability and an explicit open-source license are different. Name the actual competition in the submitted version. |

These are spot observations, not a full security audit or a legal re-review of every conclusion.
The scheduled refresh may repair the missing issuer pages; that would not remove the deployment
ordering defect. Page geometry was measured on the live site, not inferred from screenshots.
Host load was elevated, so no load-time or frame-rate benchmark is claimed.

## Product narrative and competitive corrections

Remove the large “Why tokenize an asset at all?” section from the primary landing journey, or
reduce it to a short optional Learn link. It came from a different line of work and currently
interrupts the direct product story. The landing page should explain RWA Sonar's job—understanding
one token or comparing available wrappers—rather than making the general case for tokenization.

The competitive story also needs updating. RWA.xyz publishes a tokenization-structure framework
and holder-rights/primary-market categories; DefiLlama exposes redemption, KYC, transferability,
self-custody and attestation fields. Our differentiation must be demonstrated through scoped
conclusions, direct evidence, contradictory claims, exact Solana controls and enforcement paths.
Do not imply competitors only count TVL. Sources checked for this review:
[RWA.xyz documentation index](https://docs.rwa.xyz/llms.txt),
[RWA.xyz data catalog](https://app.rwa.xyz/catalog),
[DefiLlama equity dashboard](https://defillama.com/rwa/category/stocks-equities).
The [L2BEAT analogy](https://l2beat.com/faq) remains useful for informed audiences; a first-time
visitor should understand our value without knowing L2BEAT.

## New audit actions — do these before adding breadth

### 25. Make generated pages part of a complete release — P0

Build issuer, template and token pages from the current retained snapshot before exposing code
that links to them. Separate the deterministic publication build from optional fresh collection.
Keep the last complete release available until its replacement validates; do not let a slow
vendor request decide whether core pages exist. Add public content checks for a representative
card, both featured issuers, a template, comparison, search and an actual API query. Missing static
resources must not silently return the home page with HTTP 200.

Done when: the two failed issuer URLs return issuer-specific headings/canonicals and required
assets immediately after a deploy, including when external collection is unavailable. Verify
the generated release, not just the checkout SHA. A release/snapshot identifier should expose
cross-artifact consistency without forcing independently observed inputs to share fake timestamps.

### 26. Correct the meaning of the four health dimensions — P0

Keep the dimensions separate. Show reserve evidence as its own factual check; make the legal
summary draw on missing required evidence, stale/changed sources, unresolved relevant conflicts,
holder scope and pending review. Avoid replacing it with another opaque numeric score. Distinguish
structural rights from confidence in the evidence: a well-documented weak claim is not a strong claim.

Done when: the same token/template gives a consistent legal-review state on its card, comparison,
issuer page and monitor. NVDAx cannot imply complete legal assurance solely because a reserve
evidence grade passes. Missing inputs stay unknown and the qualification is beside the conclusion.

### 27. Audit the five published discrepancies and template scope — P0

Review each record for matching product, date, jurisdiction, holder class and meaning on both
sides. Distinguish a direct contradiction, a qualification, a coverage gap and an unresolved
interpretation. For example, assess whether “unrestricted shares” and allowlisted token transfers
refer to different concepts before presenting them as a contradiction. Do not treat a multiplier
of 1 at one observation as proof that future corporate-action adjustments cannot occur.

Separate programme-wide conclusions from product-specific exceptions. Rename the general Backpack
programme label; retain SPCX-specific facts only where applicable. Explain precisely how a reserve
coverage gap affects an individual card, without implying its reserves are missing. Remove
unsupported probability language such as “most likely” failure mode; state the dependency and
scenario instead. Preserve current best analysis; internal corrections remain outside public history.

Done when: all five conflict cards have an explicit scope, current primary evidence, a proportionate
holder implication and clear conditions for resolution. A reader can distinguish confirmed adverse
facts from limitations of our evidence in one screen.

### 28. Enforce the public-change boundary everywhere — P0

Use the same eligibility policy in chart overlays, the journal, landing updates, saved briefings
and issuer/asset histories. Exclude collection baselines and editorial corrections. Keep catalogue
discoveries explicitly labelled. Rank by the demonstrated consequence: a moved URL should not
outrank a transfer-fee increase unless the move actually changes access to governing evidence.
Separate event/effective time, first observation and editorial review time; never silently substitute
the observation date for an unknown event date.

Done when: AAPL history has no first-read baseline markers, and a real fee/control/redemption
change leads a documentation relocation. Every highlighted change says what changed, whose action
caused it, which products are affected and why a holder should care.

### 29. Put the useful decision path above the fold — P1, before recording the demo

Replace the landing hero's dominant catalogue-growth card with a real two-wrapper example and a
search entry. Preserve the existing growth/funnel work under coverage or market context. Avoid
repeating the catalogue chart in two sections. Show the available history interval before offering
30/90-day controls for a six-day series. Remove or substantially reduce the general tokenization
explainer so this example and search remain the main story.

In the app, replace the repeated multi-line hero and coverage blocks with a compact title/search
row. Put the selected stock and actual differences before filters, saved-watch controls and lengthy
methodology. Consolidate global search and stock filtering so typing AAPL does not leave an
unrelated directory occupying the next screen. Make the answer specific to the selected pair;
if both have the same broad claim category, say so. Underlying results must choose their action
from the data: **Compare wrappers** for two or more genuinely comparable products and **Inspect
token** for a single wrapper. Do not send a single product into an empty comparison screen.

Done when: at 390 px width, a returning comparison link shows a concrete difference in the first
viewport; a newcomer can reach it with search plus one selection. A stock with one wrapper reaches
a complete standalone answer just as quickly. Replace arbitrary byte/height targets with task
outcomes, while retaining sensible technical budgets.

### 30. Finish the answer-first asset report and evidence interaction — P1

Lead with a concise answer to ownership, intervention, exit and usable DeFi, followed by the most
material applicable uncertainty. Summarize confirmed protocols by action; expand individual markets
only when requested. Remove repeated conclusions and fix small presentation defects such as the
joined sentences in the NVDAx opening. Replace cryptic “§” disclosures with labelled evidence
controls, preserving clause-level access and keyboard operation. Treat the asset report as a
first-class destination, not merely the detail page beneath comparison.

For a token with no comparable wrapper, explain its structure against the underlying stock and
RWA Sonar's evidence model rather than manufacturing a relative verdict. For a token with no live
DEX pair, show **No confirmed secondary-market exit** and the exact coverage/time checked. Continue
to explain primary redemption, transfer restrictions, issuer intervention and any confirmed
non-trading protocol use. Lack of a pair is a decision-relevant answer, not an empty page.

Done when: the default report's essential story fits roughly two or three mobile screens, any
qualification capable of reversing the answer is visible there, and one action reveals the source
and exact clause. The 38-scenario library remains available without dominating the default report.
The report is equally coherent for a lone wrapper, a token with no DEX pair and a liquid member of
a multi-wrapper comparison.

### 31. Make DeFi support claims match the proof — P1

Expose distinct evidence states: named by a product page, listed in an exact-token registry,
referenced accounts exist, configuration decoded, read-only execution simulated, or activity
observed. These states should not imply that all checks have happened. For featured collateral
markets, verify expected account owner/program, collateral mint, active flags, caps, debt asset,
oracle and liquidation parameters before claiming independently verified configuration.

Make eligibility and lender exit visible next to the action. Analyse rightful seizure after default,
protocol compromise and inaccessible keys/program separately, including discretionary issuer powers.
Executable-price checks and simulations can be future evidence without moving user funds.

Done when: registry presence cannot be read as a successful loan or guaranteed liquidation, partial
account checks remain partial, and the demo's specific market shows its parameters and limitations.

### 32. Turn monitoring into reviewed, usable evidence — P1

Prioritize blocked/changed sources underlying high-impact ownership, redemption, collateral and
insolvency conclusions. Record successful retrieval, relevant content comparison, human/analyst
review and conclusion validity separately. A quote still appearing on a page does not prove the
rest of the governing arrangement stayed unchanged. Rank recovery work by affected conclusions;
avoid forcing every low-value URL into urgent review. Retain the single morning digest.

Done when: featured conclusions have readable primary evidence or an explicit limitation, the
highest-impact source gaps have named resolution criteria, and recent collection attempts never
make old analysis appear freshly reviewed. Avoid announcing completion merely because all jobs ran.

### 33. Simplify initial rendering and release verification — P1/P2

Lazy-initialize inactive views and load a compact discovery index rather than full dossiers for
the first search. Reuse existing API/query helpers; split the large `stocks.js` by bounded features
as they are touched, with pure transformations kept testable. Prefer a narrow extraction to a new
frontend framework. Add consistency tests across card, API, comparison and template conclusions,
including unknown/stale data, source changes and publication manifests.

Done when: opening Explore does not render unrelated DeFi/issuer/research panels, measurements show
a substantial reduction from the audited ~11,000 DOM nodes, and the same token yields the same
scoped conclusion everywhere. Record device/network/load conditions for performance comparisons.
Fix the test command's duplicate `stocks-page` execution and provide a one-command local startup
with explicit static/API readiness. A dated demo fixture can support a recording rehearsal but must
never masquerade as current live data.

### 34. Rebuild the pitch around proof and correct the submission package — P0/P1

Keep it short: about eight core slides plus optional appendix. Show the problem, one named user's
decision, a real comparison, a standalone token for which no comparison is available, one carefully
scoped discrepancy, one sourced external change, how the system works on Solana, the competitive
distinction, and the team/next milestone. The comparison should remain the main demo; the standalone
example proves the product covers the rest of the catalogue. Include a clear request for pilot users.
Describe professional monitoring/API revenue as a hypothesis until validated. Replace the
unattributed LTV example with an actual sourced event or mark it illustrative.

Update README, SUBMISSION and pitch together: dates and denominators on every count; six-hour
publication versus daily cached inputs; account existence versus decoded verification; researched
templates versus independently reviewed assets. Link directly to the hackathon branch or a pinned
release. State what existed before the hackathon and what was built during it. Select an explicit
code license with the owner and distinguish rights in third-party documents/data.

Done when: a three-minute recording demonstrates an answer, evidence and monitoring without a tour
of every tab; all linked routes work; the repository link opens the reviewed code; and the prose
matches the implemented evidence strength.

### 35. Confirm the competition and sponsor fit — P0, before submission

The [official Stocklana rules](https://hackathons.solana.com/hackathons/stocklana), checked on
22 September, give a deadline of **25 September 2026, 16:00 ET** and emphasize a real user/problem,
an end-to-end demo, Solana relevance and execution. They describe Colosseum World's Fair as a
subsequent opportunity; make the deck and application name the correct event.

The PreStocks bounty explicitly excludes projects integrating other pre-IPO tokens. Our Tessera
coverage therefore conflicts with that bounty's published condition. Prefer the independent
multi-issuer product and main track; confirm eligibility before claiming any sponsor track. Meteora
DBC and Pyth awards require substantive relevant use, so merely collecting sponsor data is not
sufficient evidence of fit. Do not expand into trading/token launches solely to chase a bounty.

Done when: the submission has an eligible track, correct event name, required links and a reviewed
description of the actual integration. No claim of eligibility depends on an assumed exception.

### 36. Test comprehension with five people — P1, with immediate feedback into 29–30

Use four concrete tasks: compare AAPL wrappers; inspect a stock with only one wrapper; explain what
NVDAx ownership and issuer control mean; find a currently supported collateral route and its main
exit limitation. Include one token with no DEX pair and verify that the participant understands the
absence of a confirmed market without mistaking it for missing legal research. Include someone
unfamiliar with tokenization, mobile users and a potential integrator. Record time, wrong conclusions,
dead ends and whether users can find the evidence. Ask what they would revisit and whether they
would use/pay for monitoring; do not count the interview as adoption.

Done when: at least four of five can explain ownership, intervention and exit within 60 seconds of
opening a report, distinguish technical custody from legal rights, and avoid interpreting unknown
or registry presence as safe/guaranteed. These are proposed acceptance targets, not measured results.

## Recommended sequence and scope control

1. Address **25–28** first: working public routes, honest verdicts, scoped discrepancies, true history.
2. Complete **35** now and prepare **34** alongside the product work; eligibility and the submission
   deadline should not be discovered after recording.
3. Concentrate the visible experience through **29–30**, run **36**, then fix the observed failures.
4. Apply **31–32** to the assets/protocols actually featured in the demo. Expand after the evidence
   model is proven. Do the parts of **33** required for that journey before broad refactoring.

If time is short, reduce the demo to one comparison, one standalone token, one discrepancy and one
monitored change. Do not trade away correct evidence to fit a larger catalogue or more screens. Freeze new asset
classes/chains, trading execution, wallet connection, generic AI chat, broad news aggregation,
extra market charts and new paid data subscriptions until they solve a demonstrated user problem.
Daily CoinGecko enrichment remains proportionate to the product's current purpose.

## Original roadmap — preserved IDs and revised status

“Implemented” below describes shipped code, not proof of usability or complete production coverage.
Several original tasks need refinement through the new audit actions; they should not simply be
reimplemented as new features.

| ID | Original work | Reassessment / next treatment |
|---|---|---|
| 1 | Commit the UX refinement and visit/change tracking | Implemented and released through `05c5bf6`; address publication verification in 25. |
| 2 | Simpler asset decision page | Implemented; make it a first-class path for lone wrappers and tokens without DEX pairs in 26 and 30. |
| 3 | Same-stock comparison journey | Implemented; preserve it as the signature feature while removing repeated setup and generic synthesis in 29. |
| 4 | Claims-versus-reality view | Implemented with five published records; review scope and severity in 27. |
| 5 | Contextual explanations | Implemented in several paths; finish labelled evidence controls in 30. |
| 6 | Private personalized home and saved items | Implemented; validate usefulness in 36 before extending personalization. |
| 7 | Task-oriented navigation | Implemented; simplify overlapping navigation/search under 29. |
| 8 | Consistent provenance | Implemented components; align actual evidence strength and status in 26–27, 31–32. |
| 9 | Progressive, configurable tables | Implemented; initial full-artifact loading and eager rendering remain under 33. |
| 10 | Grouped explanatory search | Implemented; connect search and underlying results more clearly in 29. |
| 11 | Mobile and accessibility pass | Partly validated; spacing, ordering and end-to-end comprehension still need 29–30 and 36. |
| 12 | Explicit loading/empty/failure states | Implemented in core flows; extend verification to API outages and missing generated routes in 25/33. |
| 13 | Protocol dossiers | Next research/product priority after 31: per-market routes, actions, parameters and the three custody-loss scenarios. Reuse existing protocol cards. |
| 14 | Issuer and asset change histories | Partly present. Apply 28 before adding more history surfaces. |
| 15 | Holder history and attribution | Defer broad expansion. Improve labels and attach evidence to treasury/protocol/venue attribution; never infer people from accounts. |
| 16 | Market-quality history | Charts and checks already exist. Prioritize source alignment, stale-price handling, coverage and executable-size context over additional charts or a composite score. |
| 17 | Redemption usability | High-value follow-up: distinguish holder eligibility and legal right from observed redemptions, with fees/minimums/timing and blocked routes. |
| 18 | Authority attribution | Already partly researched. Extend decoded signer thresholds, program/upgrade ownership and change attribution where it affects collateral or recovery. |
| 19 | Document precedence and scope | Structured fields already exist. Improve conclusion-level applicability and exceptions through 27/32 rather than adding another precedence table. |
| 20 | Ranked research gaps | Review queue already exists. Curate the few unresolved questions that could reverse a holder's decision; distinguish unresearched, undisclosed, blocked and unresolvable. |
| 21 | Landing-page differentiation | Accelerated into 29 and the competitive/narrative corrections above. |
| 22 | Evidence-linked research briefs | After 28, publish concise briefs only for material external changes. Avoid a general news feed. |
| 23 | Evidence-led pitch | Accelerated into 34–35. |
| 24 | Formal usability study | Accelerated and made concrete in 36. |

Post-hackathon order: deepen **13 and 17**, then selected **18–20**, followed by **15–16 and 22**
when user demand supports them. The longer-term defensibility is the maintained evidence graph,
consistent interpretations, verified change history and demonstrated comprehension—not data volume.

## Validation performed for this audit

- Headed-browser inspection of production landing, Explore/search, AAPL comparison, NVDAx,
  discrepancies, DeFi, Changes, pitch and an issuer route; desktop and 390 px mobile spot checks.
  The audit browser was closed afterward. No automated browser suite was run.
- Read-only public health/collector responses and production checkout, generated-directory and
  refresh-log inspection. A refresh was active; changing counts/timestamps are not frozen benchmarks.
- Code and data review, including the health rules, DeFi corroboration, history API, initialization,
  generated-page builders and publication flow. Two bounded read-only reviews used GPT-5.6 Luna.
- The existing stock, API and page suites passed: 42/9/13 suite executions and 1,795/159/654 test
  executions respectively. These totals overlap because `stocks-page` runs twice. API integration
  tests used the configured database via in-process requests; they do not verify nginx or publication.
- Official hackathon rules and current competitor documentation were checked directly. No user
  interviews, new issuer attestations, funded transactions or independent legal sign-off occurred.

Only this roadmap was changed by the audit. No implementation, commit or deployment was performed.
