# RWA Sonar — product audit and next steps

Updated 23 September 2026. This is the active roadmap, revised after reviewing the local working
tree based on `47add09`, generated data and pages, desktop/mobile journeys, the public site and pitch,
and current public collector-status responses. The 23 September revision adds a release-first
priority (P0-0), a judge's-first-three-minutes pass (P0-1) and findings F9–F11 from a critical
review of the code, the live site and the GitHub repository as a judge would meet them. The recent P1 changes are still uncommitted;
local findings below must not be mistaken for features already deployed. This was not a fresh
SSH/process-level production audit.

This revision supersedes the previous task numbering. Earlier context remains in
[UX-audit1.md](UX-audit1.md) and [COMPREHENSION-REHEARSAL.md](COMPREHENSION-REHEARSAL.md).

## Judgment: enough breadth; strengthen the answers

The project has enough functionality for a credible hackathon submission. Its strongest asset is
the connection between an exact Solana token address, its legal structure, technical controls,
actual protocol support, changes and evidence. The weakest points are consistency between those
layers, the effort required to reach a useful answer, and the absence of real-user validation.

The next release should be smaller in presentation and stronger in proof. Do not add another broad
feature layer before fixing misleading scope, control classification and recurring publication.
A polished interface is essential, but the durable advantage is maintained, auditable analysis
that helps someone make a decision—not attractive access to otherwise public data.

The product promise remains:

> Understand what this exact token gives you, who can intervene, where you can use it, how you can
> exit, and what you must continue to trust.

Comparison is the signature journey, not an admission requirement. A token with no competing
wrapper or no confirmed market must still receive a complete, useful standalone answer.
There is no pair-only product model: one, two, three and many wrappers are valid. Exact token
addresses remain visible when an issuer has more than one token for an underlying.

## Implementation checkpoint — local, not deployed

The 22 September engineering pass addresses the release, scope/control accuracy and decision-flow
defects below. The critical findings remain the audit baseline, not a description of every current
local page. The uncommitted work includes:

- Shared build/publication manifest, complete protocol/comparison output, exact-membership and
  build-time validation, a local release-evidence record and one generation-pointer switch across
  all 28 declared generated families. The first deployment freezes the legacy set before aliasing;
  runtime files and ordinary site assets remain outside this generated-release boundary. Public
  verification still belongs to M4.
- One scope-aware redemption contract now feeds cards, workspace details, comparison bundles,
  issuer and template pages, and token/issuer APIs. The TSLAx fee example cannot become an FGDLx
  fee; complete qualifications remain expandable, and raw API records are explicitly labelled.
  Operational redemption research is still open (item 10).
- Structured, role-specific authority facts drawn from existing research, including the Ondo
  unilateral multiplier path and 1-of-9 pause path; zero-bps fee capability is not treated as absent.
  Technical notes are separate from contractual limits, with original observation dates retained.
- Shared protocol proof-stage wording, explicit health coverage and a reviewed-inference contract.
  No existing conclusion was automatically promoted to reviewed, and no simulation was invented.
- A concrete comparison answer first, closed secondary details, search across views and scoped
  underlying payloads. All available wrappers start selected; a single wrapper works; no selection
  stays empty. The local SPCX example has four issuer wrappers and five exact tokens.
  The 17 tokens without an established underlying ticker keep standalone reports; comparison
  grouping does not guess their underlying from a brand or symbol.
- Focused watches for a comparison, one exact token, issuer programme or exact protocol market,
  with read-only sharing separated from owner authority. Personal delivery remains deliberately
  disabled until a verified private channel is bound.

**Release state on 23 September (the governing fact for everything below).** Submissions close
Friday 25 September 2026, 4:00pm ET (20:00 UTC). None of the 22 September work above is committed,
pushed or deployed: 108 modified and 14 new files sit in the worktree, while rwasonar.com still serves
`f1c0bae`. A judge today therefore meets the pre-fix product — for example, the live stocks page
still loads about 1.5 MB on the wire and 10.8 MB decoded before it is usable. The full local suite
is green (2,537 tests, 73 suites), so the constraint is release, not engineering.

Item 6 is **on hold at Simun's request**. The only pitch edit is “The ticker is familiar. The token
is mysterious.” The eight-slide structure and remaining content are unchanged. P0 owner-led work
and P2 evidence/pilot tasks remain open; synthetic fixtures do not substitute for human testing.

Local verification on 22 September: **2,537 tests across 73 fast suites passed**, including local
database round-trips for one- and four-wrapper watches. The release gate validated 1,183 card-index
entries, 162 protocol routes and 991 comparison bundles and recorded hashes for 28 artifact families
in the ignored `release-evidence.json`. Headed desktop/mobile inspection covered the real four-wrapper
SPCX matrix, one-wrapper selection, FGDL standalone, scoped fees and protocol return links. A later
headed check created and removed an exact-token watch, confirmed that a clean browser received only
read access, and inspected actor, holder-scope, consequence, time and evidence fields in change briefs.

AAPL initially loads **869,015 decoded JSON bytes** (compact discovery plus one bundle), versus
approximately 9.3 MB during the audit. The local server is uncompressed; this is not a production
transfer-size or timing claim. The widest generated card is again below the measured 96 KiB soft
target; the 112 KiB hard ceiling still blocks runaway output. No collectors, CoinGecko calls,
production migrations or deployment were run during the initial engineering pass. The evidence
watcher was subsequently run across all 540 active document sources; no CoinGecko enrichment or
deployment was performed.

## What exists, and what that does not prove

| Area | Observed state on 22 September | Important qualification |
|---|---|---|
| Catalogue | 1,183 local token addresses; 1,196 in the public tokens response | Dated snapshots, not proof of exhaustive coverage. |
| Underlying groups | 991 local groups: 146 with multiple issuer wrappers, 845 with one | About 85% have no cross-issuer comparison; standalone reports are core, not an edge case. |
| Research structure | 12 issuer dossiers, nine legal/technology templates, 38 failure scenarios | Catalogue breadth and dossier coverage use different denominators. |
| Decision surfaces | Discovery, search, comparison, token/issuer/template reports, evidence and external-change views | Useful foundations; repeated conclusions and navigation still increase reading effort. |
| Health | 11 checks across market, control, legal/evidence and DeFi | A dimension or summary colour is only as reliable as its input scope and coverage. |
| Protocol evidence | 162 local exact-token integration routes in the new P1 work | No integration records configuration decoding or read-only execution simulation as performed. |
| Operations | Public responses show current market, chain and DeFi observations; legal watching is degraded/partial | A successful run or recent build is not proof that every source was fetched or legally reviewed. |
| Presentation | Landing page, eight-slide HTML pitch, submission documentation and social identity | No demonstrated user traction or completed submission should be inferred. |

The previous P1 pass built mobile, protocol, redemption, review-queue and authority-attribution
foundations. It did not complete operational-redemption verification, protocol execution proof,
authority attribution or human comprehension testing. Keep those distinctions in status reports.

## Critical findings

### F1. Recurring refresh does not publish the complete product — resolved locally

The shared manifest now drives both refresh and deployment. All declared generated families are
hash-verified in an immutable generation and become visible through one pointer switch. A legacy
docroot is first frozen and aliased to its unchanged bytes, and deploy rsync preserves the live
pointer. This is atomic for the generated research release, not for unrelated HTML/CSS/runtime data.
Production verification remains part of M4.

[refresh-on-server.sh](stocks/refresh-on-server.sh) does not run the new protocol-dossier builder.
It also omits the discovery and funnel JSON files from its publication list, although
[build-stocks-db.mjs](stocks/build-stocks-db.mjs) regenerates them. A deploy can therefore publish
pages that subsequent collector refreshes do not maintain.

Public responses during this audit had different build times: discovery 06:27 UTC, tokens 07:45,
funnel 02:06. Discovery and tokens both contained 1,196 entries; equal counts do not establish
content consistency. The code omissions—not differing collection schedules alone—are the defect.

Publication also installs files sequentially and checks a narrow public timestamp. The next
release needs one declared artifact set, validation before publication and a way to retain the
last complete release on failure. Independent observation times must remain independent.

### F2. A product-specific fee leaks into another product's redemption answer — resolved locally

The shared answer model now distinguishes exact-product, programme and named-product-example
scope everywhere it is presented. FGDLx reports the TSLAx fee only as non-applicable source
context; programme pages label it as an example; APIs expose the same scoped fields and label their
raw research records. Full source wording is retained behind expandable disclosure.

The local FGDLx report correctly says, in its existing redemption text, that no FGDLx-specific fee
was confirmed and that TSLAx is only an issuer-programme example. Its new redemption-usability
block then displays the TSLAx issuance/redemption fee under a “Documented” badge.

The new block receives raw issuer redemption text in [cards.mjs](stocks/lib/cards.mjs), while
other presentation paths already qualify its scope. Some eligibility, minimum and timing answers
are also cut mid-sentence. This can remove the very condition that makes an answer accurate.

This is a release-quality issue, not a copy-polish issue. Use one scope-aware answer model across
cards, comparison, issuers, templates and APIs. Distinguish product terms, programme examples,
holder eligibility and genuinely unknown values. A byte budget must not be met by truncating
material legal qualifications.

### F3. Control ratings do not consistently follow the ultimate controller — resolved locally

The shared authority model now separates installed capability from effective governance, named
controller, role-specific threshold, upgrade path, observation and contractual limits. Exact-token
cards, issuer/template dossiers, health findings and token-detail APIs use that model. Ondo's direct
multiplier signer and 1-of-9 pause lead the conclusion; the PreStocks threshold retains its five
eligible voters and two initiate-only members. Unresolved final operators remain unknown. The API
and workspace also treat a configured `0 bps` fee as an installed capability, not an absence.

Existing issuer research contains multisig thresholds and exceptions that the new structured
authority presentation does not carry through. Examples include the researched xStocks
freeze/pause threshold, PreStocks voting-versus-initiation permissions, and Ondo role-specific
thresholds.

More seriously, the Ondo research notes describe an ordinary signer with unilateral multiplier
update power, while the summary classifies rebase governance as “program”. The health rule treats
program/multisig governance as strong; AAPLon consequently receives a good control dimension.
A program-controlled address is not, by itself, evidence of constrained ultimate control.

Structure and reconcile the existing evidence before commissioning more broad research. Separate
the immediate authority account, governing program, final signing/upgrade path, threshold,
attributed actor and applicable contractual power. Do not flatten different roles into a single
issuer-wide threshold.

There is also a latent classification issue: the new capability model treats a zero transfer-fee
rate as absence of capability. No current local fee record has a zero rate, so this is not a
demonstrated live-data misclassification. Nevertheless, extension presence, authority to change
the fee and current fee rate must remain separate.

### F4. Some headlines are stronger than the evidence underneath them

**Resolved locally.** User-facing action language now follows the exact-token proof stage:
source-listed, market-observed, configuration-decoded or simulated. A source listing or account
existence never reads as a successful borrow. The achieved stage carries its observation/fetch
date, unavailable sources cannot advance legal-review freshness, and reviewed inference requires
reasoning, applicable sources and scope without masquerading as source confirmation. Health keeps
known warnings and missing dimensions visible together; redemption keeps documented terms,
operational availability and independently observed success separate.

The local NVDAx/Kamino dossier opens with a live collateral/borrowing description. Its evidence
records exact-token support and account presence, but no established expected owner, configuration
decode or simulation. Reported activity is useful evidence, but is not the same as independently
observing the claimed user action succeed.

All 162 local integration records currently have decoding and simulation unperformed. This does
not mean every integration is unusable; it means the product must say exactly what it knows.
“Listed as collateral”, “accounts observed”, “configuration verified” and “action simulated”
should not collapse into an unqualified “you can borrow”.

Health and review labels have a related problem. In the local snapshot, 673 tokens have unknown
market health, yet no overall result is unknown: the summary intentionally selects the worst
known result. Preserve known warnings, but display missing coverage beside them. Similarly, the
review queue labels 65 conclusions “unsupported”; some are analytical inferences rather than
claims that could ever be established by a verbatim quotation. Distinguish reviewed, reasoned
inference from an unreviewed or genuinely unsupported assertion.

### F5. The mobile comparison still asks the reader to do too much work

The default AAPL comparison measured 6,415 CSS pixels high at a 390 × 844 viewport, without
horizontal overflow. The problem is not a prescribed maximum page height. It is repeated
differences, issuer summaries and open detail blocks, preceded by several layers of navigation.
The first viewport communicates a general promise rather than the concrete comparison result.

Use one compact answer, then optional supporting detail. A comparison should identify the actual
rights/control/exit difference, not merely say that wrappers differ. Shared properties should be
visually compressed. Keep search available across views, and add direct token/issuer return paths
from protocol dossiers.

The default discovery experience favours comparable groups even though 845 of 991 local groups
have one issuer wrapper. Maintain two equally valid entries: “Compare versions of this stock” and
“Understand this token”. No counterpart, no price or no market is not an empty-state failure.

### F6. Compact discovery has not made the comparison path compact

The inspected comparison loaded approximately 9.3 MB of decoded JSON, including the full token
and issuer datasets. This is a decoded payload measurement, not transferred/compressed bytes or a
clean-host timing benchmark. [stocks.js](stocks.js) still loads the full catalogue for this path.

A scoped comparison payload or generated bundle is a higher-value improvement than a framework
rewrite. Pagination exists for large tables; it does not solve loading all research data to
answer a two-token question.

### F7. The positioning needs proof and a narrower recurring user

“Other sites show numbers; we explain rights” is too broad. [RWA.xyz's current stock product](https://app.rwa.xyz/stocks)
already includes legal/regulatory, domicile and subscription/redemption information. Competition
should be described fairly; do not imply those products have no structural analysis.

The sharper claim is maintained, source-backed analysis connecting exact Solana token controls
with holder rights, executable uses and material changes. Demonstrate that connection with one
decision-changing example. Neither “L2BEAT for RWAs” nor “perfect UX” establishes defensibility
without reliable methodology, distinctive maintained evidence and repeat use.

Keep the public newcomer-friendly product. For the post-hackathon business, test one recurring
professional workflow first—such as a protocol risk team monitoring eligible collateral—rather
than simultaneously promising a tool for traders, issuers, institutions and every retail holder.

### F8. The pitch is dense, not unusually long

Both the local and public HTML decks have eight slides, not twelve. The local deck contains
roughly 725 words. The comparison example gives liquidity the largest numeric emphasis while
the distinctive rights/control analysis receives smaller text. Methodology and submission
housekeeping take space that should establish the user benefit, proof and team.

Recommendation: six main slides plus an optional appendix. This is an editorial choice for this
product and its short demo, not a universal slide-count rule. See the proposed narrative below.

### F9. The most distinctive analysis is missing from the demo and the pitch

The trust chain and the what-if layer — 13 actors, nine rights flows and 38 failure scenarios
answered for all 12 issuer programmes (456 answers: 330 documented, 67 inferred, 35 not applicable,
23 unknown, one litigated) — are the clearest decision-changing examples the product has, which is
exactly what F7 asks for. They appear in this roadmap only as a count and in the pitch not at all.

Examples already sourced and quoted: under the xStocks prospectus nobody can restore a lost key, and the only route is a
Swiss court cancellation the issuer itself calls "very challenging to achieve", while Superstate burns and reissues stolen tokens; Ondo holders cannot
petition and rank fourth in the waterfall; Shift's proof-of-reserve feed that is said to gate minting
does not exist. Recent dated changes suitable for the monitoring beat: Tessera's T-SpaceX issuer was
substituted by novation (effective 1 August, notified 27 August) and T-SpaceX entered its redemption
cycle with no proceeds; Republic's rSPAX payout trigger fired at the SpaceX IPO while the split basis
of its reference price is unresolved.

### F10. A judge's first three minutes are weaker than the product

Measured on the live site and repository on 23 September:

- GitHub's default branch is `main`, which has no README and no licence; the work lives on
  `colosseum-worlds-fair`. The repository looks empty to anyone who opens it from the submission.
- No page has an `og:image`; `stocks.html` has no og:title/description. Shared links render blank
  in Discord and X.
- The landing hero shows "Loading the latest monitored snapshot…" until JavaScript fills it; the
  static HTML carries no token or issuer count.
- Neither `/` nor `/stocks.html` links to the pitch (`/pitch/`) or to the code.
- The webroot is the repository root: `/package.json`, `/dev-server.mjs`, `/attestations-db.json`
  and `/placeholder-db.json` are served. Unknown paths (`/pitch.html`, `/README.md`) return 200 with
  the landing page instead of a 404. No HSTS, CSP, X-Frame-Options or nosniff headers.
- Hard-coded copy contradicts the data: `stocks.html` says programmes instantiate "up to 212 tokens";
  xStocks has 927. Three of the 12 issuer programmes (Remora and Ventuals, defunct; Republic, no
  mint yet) have no tokens, so "12 issuers" needs that qualification wherever it is a headline.
- The history chart offers a 30-day toggle over seven days of history.
- The README reads as an audit log ("not a claim that this uncommitted revision is deployed").
  Judges need what it is, why it matters, how to try it and why Solana; the qualifications belong
  here and in the methodology page.
- Intermittent 4–19 s asset stalls were seen in one external check (about 1 in 15 requests); the
  cause is unverified and must be checked before the demo is recorded.

### F11. Code structure is a post-hackathon debt, not a submission blocker

`stocks.js` is 5,083 lines and `stocks.css` 3,536, and a 637-line trust-chain/what-if style block
is mirrored verbatim into `card.css`. This slows every change and invites drift, but a refactor
now would add risk for no judge-visible gain. Record it and leave it until after judging.

## P0-0 — ship what already exists (Wednesday 23 September)

**Done 23 September, 03:10 CEST.** Committed in seven reviewed groups, pushed and deployed as
`a990c0e`; GitHub's default branch is `colosseum-worlds-fair`. The first deploy exposed a publisher
defect — generation directories created 0700 by `mkdtemp`, so nginx returned 404 for every generated
file for about 15 minutes (00:51–01:06 UTC) — fixed with a regression test and redeployed; the
deploy's public route checks now pass. Feature freeze is in effect. LICENSE still waits on M1.

Release before any further feature work. In order:

1. Commit the local work in reviewed groups (publication manifest; scoped redemption; authority
   model; proof stages/health; comparison/discovery; watches; research corrections including the
   22 September dossier fields and the SpaceX-Texas and xStocks prospectus-date corrections).
   Name every file swept in; do not commit `.env`, release evidence or raw collector output.
2. Push, deploy with `DEPLOY_BRANCH=colosseum-worlds-fair`, and verify on rwasonar.com that the
   public pages, API and generated families match the local release evidence (M4's checks).
3. Set GitHub's default branch to `colosseum-worlds-fair` until judging ends. This keeps `main`
   unmerged, as decided, and is reversible. Add a LICENSE once M1's licence decision is made.
4. Declare a feature freeze. After this point only P0-1, fixes to released defects and the video.

Acceptance: the live stocks page loads the compact discovery path; the public build identity equals
the pushed commit; the repository's front page shows the README.

## P0-1 — a judge's first three minutes (Wednesday–Thursday)

**Done 23 September**, live in `a990c0e` and the server's nginx config: og image and tags on every
public page and card; build-time headline counts refreshed by the recurring job; Pitch and Code
links; generated counts and qualified issuer headlines; history ranges limited to available data;
a judge-facing README; a real 404 page; dev/package files no longer served; HSTS, nosniff,
X-Frame-Options and Referrer-Policy headers. Not done: a Content-Security-Policy (needs a pass over
inline scripts and Clarity before it can be enforced). The 4–19 s stalls were measured again: the
origin answers in ≤0.1 s and a second network saw a worst case of 0.44 s over 40 requests, while
the laptop's network showed one 8 s stall — a client-network effect, not the site.

Small, judge-visible fixes from F10, each behind a fast test where it has logic:

- A static `og:image` (one real product answer, legible at thumbnail size) and og/twitter tags on
  every public page, stocks and cards included.
- Headline counts written into the HTML at build time, with the live fetch refining them.
- Visible links from the landing page and stocks page to the pitch and the GitHub branch.
- nginx: a real 404, dev and fixture files excluded from the webroot, HSTS, nosniff,
  X-Frame-Options and a CSP compatible with the pages' own scripts and Microsoft Clarity.
- Generated rather than hard-coded counts ("up to 212 tokens"); issuer headlines qualified by
  live/defunct/no-mint.
- Hide the 30-day history toggle until 30 days exist.
- README rewritten for judges: one paragraph of what and why, three links (live site, pitch, a
  what-if answer), how to run locally, Solana relevance, the evidence method in five lines; move
  the release qualifications to this file.
- Check the origin stalls from two networks before recording; if real, find the cause first.

## P0 — owner-led submission work remains open

These tasks still need Simun's decisions or real people; agent rehearsal is not a substitute.

- **M1 — Finish the submission package.** Record the focused three-minute demo; supply actual team
  information and the video URL; decide the code license; accurately distinguish pre-hackathon
  work. Keep third-party document/data rights separate from the code license.
- **M2 — Test comprehension with real people.** Before the video, two or three is realistic this
  week; say how many were tested and never describe fewer as validation. The target remains at
  least five. Include a newcomer, mobile user and
  potential professional user. Reuse the tasks in [COMPREHENSION-REHEARSAL.md](COMPREHENSION-REHEARSAL.md).
  Record wrong conclusions, time, evidence discovery and reasons to return. Four of five correctly
  explaining ownership, intervention and exit within 90 seconds is a proposed product target,
  not an established industry benchmark. Synthetic success is not user validation.
- **M3 — Reconfirm submission requirements.** Check the [official Stocklana page](https://hackathons.solana.com/hackathons/stocklana)
  and final form for the track, deadline and any sponsor-specific eligibility restrictions.
  Do not assume a general-track submission qualifies for every bounty.
- **M4 — Authorize and verify the final release.** After the engineering gates below, pin the
  commit and observation dates used in the demo. Check the public routes, API, generated pages,
  collector outcomes and morning digest, plus the actual deployed checkout/process state.
  Keep the previous complete release recoverable. Commit/push/deploy remain explicit actions.

Suggested demo: AAPL comparison → one material difference → its primary evidence → one what-if
contrast (for example "my keys are stolen": xStocks versus Superstate, each with its quoted source)
→ FGDLx standalone answer → one genuine dated issuer change and its holder impact (the Tessera
T-SpaceX novation or redemption cycle). Do not tour every workspace. Record against the deployed,
frozen release and pin the date shown.

## P1 — engineering and presentation, in this order

The acceptance criteria below remain the reference for the engineering work; see the checkpoint
above for local implementation scope. A local implementation is not a deployment or a fresh review
of the underlying legal evidence.

### 1. Make recurring publication complete and failure-safe

**Locally implemented; production verification remains in M4.**

Create one explicit artifact/build manifest shared by deployment and recurring refresh. Include
discovery, funnel, templates, health, review data, cards, issuer pages and protocol dossiers.
Build into staging, validate references and semantic consistency, then publish the complete set.
Record code/build identity and each source's own observation time.

Acceptance: a fixture changing protocol support or token membership updates every affected surface
through the recurring path; a failed required build does not replace the last complete release;
individual protocol routes, not just their index, are checked.

### 2. Unify scoped redemption and holder answers

**Locally implemented; fresh operational evidence remains item 10.**

Replace raw issuer prose reuse with structured, product/holder/jurisdiction-scoped answers. Carry
document authority, applicability and observation/review status through each presentation layer.
Use a short accurate summary with expandable complete conditions, not character truncation.

Acceptance: FGDLx does not acquire TSLAx fees; an issuer example cannot become a product fact;
eligibility/minimums agree across the token, issuer and comparison views. Contractual right,
operational route and observed successful redemption remain distinct.

### 3. Connect authority research to displayed control conclusions

**Locally implemented; unresolved controllers remain explicitly unknown.**

Promote already researched role-specific thresholds and limitations into the structured model.
Follow ultimate signing and upgrade paths; distinguish program accounts from constrained control.
Preserve transfer-fee configuration/withdrawal authorities already available in collector inputs.
Recompute affected control findings from this model.

Acceptance: the Ondo multiplier exception cannot coexist with an unqualified strong-control
conclusion; unknown operators remain unknown; zero current fee does not imply no fee-setting
capability; differently privileged multisig members are not counted as equivalent voters.

### 4. Align proof labels, headlines, health coverage and review status

**Locally implemented; proof stages and missing coverage remain explicit.**

Make action wording derive from the achieved proof stage and its date. Show known findings beside
missing/stale dimensions. Add an explicit reviewed-inference state requiring reasoning, applicable
sources and scope; do not manufacture “confirmed” status for legal analysis.

Acceptance: account existence cannot become execution proof; an unavailable source cannot refresh
legal-review time; missing market evidence remains visible beside a known warning; a documented
but unobserved redemption route never reads as independently verified.

### 5. Simplify the comparison and standalone journeys

**Locally implemented and checked with real multi-wrapper and standalone assets.**

Lead with the selected asset and one concise decision answer. Remove duplicate summaries and
collapse secondary detail. Keep search consistently available. Crosslink the exact token,
issuer, template, comparison, protocol market and relevant change without forcing a workspace
restart. Preserve keyboard operation, readable contrast and usable mobile tap targets.

Acceptance: AAPL shows a specific meaningful difference early; FGDLx has a useful answer without
a pair or price; a reader can reach the source and return without losing context. Evaluate with
real tasks, not arbitrary card sizes or a page-height target.

### 6. Rewrite the main pitch to six focused slides

Deferred by the later instruction to leave the pitch unchanged except for the one approved line.
The hold does not constrain the demo script, which can lead with a what-if answer (F9) without any
slide change.

Use the narrative below. Enlarge one real product answer, demote liquidity/volume from the visual
lead, and remove submission housekeeping from the pitch. Link supporting methodology and extra
examples as an appendix. Keep the HTML format and local/public pitch routes.

Acceptance: one point per slide, legible on a laptop or phone, no unsupported competitor/traction
claim, actual team/contact information and a clear pilot ask. Date or pin any demonstration numbers.

### 7. Add semantic regression tests and a release evidence record

**Locally implemented.** Cross-surface tests cover redemption scope, effective authority,
proof-stage language, missing health coverage and atomic generated publication. The ignored
release-evidence record captures validated hashes, counts, source dates and Git state without
claiming deployment.

Add fast tests for the failures found in this audit: cross-product terms leaking, an unconstrained
signer hidden behind a program label, unknown dimensions disappearing, weak proof promoted into an
action, and refresh/deploy artifact divergence. Check invariants across generated surfaces, not
only whether individual fields or HTML strings exist.

Acceptance: reintroducing each defect makes its test fail. Record which code, source snapshots and
public artifacts were validated. A large passing suite is not, by itself, proof of correct claims.

### 8. Load only the data needed for a decision

**Locally implemented.** Compact discovery loads first and the selected underlying bundle follows;
full issuer, history and catalogue detail stays on demand. AAPL's measured initial decoded JSON is
869,015 bytes locally rather than the audit's roughly 9.3 MB all-catalogue path; transfer size and
timing remain host-dependent and are not inferred from that decoded-byte measurement.

Serve/build scoped comparison and token-summary payloads. Reuse the existing paginated APIs and
compact discovery index. Load full issuer documents, histories and catalogue detail when requested.
Extract pure data-shaping modules when touching the large frontend, without a rewrite.

Acceptance: a two-token comparison no longer requires all token and issuer research JSON.
Measure decoded and transferred bytes separately, and record host conditions for timing claims.
Empty, unavailable and stale states must remain explicit.

## P2 — deepen evidence and make monitoring useful to a person

No further P2 work until P0-0 has shipped; after the freeze, P2 resumes post-submission.

### 9. Independently verify one featured lending market end to end

**Locally implemented for NVDAx collateral → USDC debt in Kamino's xStocks Pool.** The official
registry currently names the exact collateral and debt reserves; confirmed-slot account reads match
Kamino's published mainnet KLend programme ID. The retained SDK 12.0.0 decode records active status,
55% maximum LTV, 65% liquidation threshold, 5–10% liquidation bonus, exact collateral/debt caps
and the Scope oracle path. No borrow simulation was presented as proof: a meaningful simulation
would require a real funded borrower position and authorization, and configuration at one slot is
not evidence that a later user transaction will succeed.

Choose one actual market behind the featured NVDAx/Kamino route. Verify the expected program owner
against primary protocol material, decode current reserve/configuration state, and record caps,
active flags, oracle, debt asset, LTV and liquidation parameters. Use read-only simulation where
practical, with explicit limits; do not execute a financial transaction.

Separate a protocol/token aggregate from a specific market. Connect default liquidation, protocol
compromise and access loss to who controls the token and what exit is available afterward.
An observed or simulated action is not a guarantee of legal enforceability or future execution.

### 10. Research operational redemption for the featured templates

**Locally implemented for xStocks, Ondo and PreStocks.** Current official operating material
documents xStocks' 24/5 stablecoin and gated xPort share routes and Ondo's 24/5 stablecoin route,
with 24/7 availability limited to six named assets including NVDAon across Solana. PreStocks'
current product page, FAQ and Terms provide no public address, form, minimum, SLA or settlement
procedure, so its discretionary request language is not presented as an operational route. No
successful redemption was independently observed for any of the three; documented availability
and observed execution remain separate fields on cards, templates, issuer pages and APIs.

Prioritize xStocks, Ondo and a pre-IPO programme. Establish holder class, jurisdiction, KYC,
minimums, fees, settlement asset, timing and evidence that the relevant route is currently open.
Use product-specific primary terms, current official operating material and public observations.

If no successful redemption is independently evidenced, say so. Do not undertake a redemption,
create an account or contact an issuer without the necessary user authorization.

### 11. Resolve the highest-impact research queue with a clear review policy

**Locally implemented for the highest-impact queue on 2026-09-22.** A forced full-registry pass
evaluated 540/540 document-watchable sources with zero fetch failures: 438 unchanged/readable, 45
changed, 55 blocked and two gone (blocked/gone remain explicit outcomes, not successes). Explicit
official companion sources and safer XML/Markdown normalization
reduced false quote loss; all four remaining P0 ownership/redemption mismatches were compared with
current official text, corrected and re-verified. The rebuilt queue contains 101 maintained tasks:
P0 0, P1 62, P2 4 and P3 35. This is not a claim that every lower-priority gap is resolved.

Superseded claim rows now remain internal via an active/current boundary instead of leaking old
RWA Sonar research into the public claims API. Date-scoped publisher-chrome false alarms are
resolved internally, and host-scoped, versioned normalization prevents recurring CoinDesk,
Tekedia and CryptoTimes sidebars from creating future actor-change alerts. Targeted repair runs
write scoped diagnostic heartbeats and cannot overwrite full-registry collector health.
The final canonical pass detected two material events already covered by editorial resolutions;
they remain in the audit trail but are suppressed from the morning notice, which is empty for that
run. Seventy-three lower-priority quote mismatches remain queued rather than being misreported as
new issuer actions.

Continue the remaining P1 work by reviewing genuine first-version/source-change sequences and
document gaps in insolvency/priority, control, lender exit and corporate actions. The goal remains
trustworthy coverage, not a zero queue.

Document source authority, precedence, holder scope, reasoning and remaining uncertainty.
Keep retrieval, content change, analyst review and conclusion validity separate. Public legal
watching was degraded/partial at audit time; investigate blocked/error sources without counting
resumed observations as newly successful fetches. The goal is trustworthy coverage, not a zero queue.

Keep research corrections and collection false alarms internal. Publish genuine external changes
by issuers, venues, protocols or other actors, with current conclusions always shown to the public.

### 12. Extend existing saved comparisons into focused watches

Implemented locally on 2026-09-22: the typed persistence/API/diff pipeline and Changes-page UI now
support a comparison, one exact token address, one issuer programme or one exact protocol market.
Every alert names the exact target; first sight is a baseline; later reversals alert again. Shared
links use a separately rotatable read-only key, while the owner key stays in the creating browser.
Token reports, issuer dossiers and protocol dossiers deep-link into the corresponding form.

Still open: bind a watch to a verified private delivery channel before enabling the reserved digest
preference. The API currently rejects enablement, legacy enabled rows are excluded from global
notices, and the central operator Telegram digest never receives anonymous visitors' watch contents.

Saved comparisons and sharing already exist; do not rebuild them as a new feature. Extend the
model to a lone token, issuer or specific protocol market. Separate read-only sharing from edit
authority. Add an explicitly opted-in personal morning digest for material changes.

Acceptance: one daily message at the chosen morning time; additions/removals are identified by
exact token and market; LTV/inactivity/collateral changes are scoped; deduplication and acknowledgement
do not suppress a later genuine change. No maintenance noise or internal corrections.

### 13. Publish concise decision-relevant change briefs

Implemented locally on 2026-09-22. Public journal rows now separate event/effective time from first
observation and editorial review time, name the actor and affected holder classes, show before/after
where measured, state the practical consequence, and link to source or monitor evidence plus the
affected token or issuer report. Reviewed actor-change resolutions carry explicit holder scope;
catalogue and protocol observations use deliberately narrower generated scope language. Internal
research corrections and collection false alarms remain excluded.

Extend the existing changes view with a short answer: what changed, which actor changed it,
affected assets and holder classes, before/after, event time versus observation time, consequence
and source. Link directly back to the affected report or comparison.

Start with a few reviewed high-impact changes. Do not turn this into a generic news feed or
automatically imply that a changed webpage changed contractual rights.

## Beyond the hackathon — validate before expanding

### 14. Secure one recurring pilot workflow

Interview potential protocol-risk, wallet/research or exchange users, then select one primary
pilot. Test whether maintained exact-token due diligence or material-change monitoring changes a
real decision. Agree on a concrete workflow and success criterion before building paid features.
A conversation or expression of interest is not traction.

### 15. Productize the minimum API needed by that pilot

Use existing identifiers and endpoints. Document pagination, filters, evidence states, source and
review times, null values, versioning and breaking changes. Provide one useful comparison/current-
change export with provenance. Clarify data/source-document rights and reasonable access limits.

Acceptance: an external user completes the agreed integration using the documentation, without
requiring an internal tour of the repository. Do not build a general enterprise platform first.

### 16. Measure product value and the cost of keeping it truthful

Track correct task completion, return use, useful versus noisy alerts, stale critical evidence,
time from external change to reviewed answer, and review cost per maintained template. Collect only
appropriate, disclosed usage data; analytics installation requires its own implementation decision.

Keep editorial independence explicit if issuers become customers. Paid access, sponsorship or
data services must not purchase a favourable conclusion. Use evidence and pilot demand to decide
whether to expand coverage, hire research capacity or add paid monitoring.

## Pitch recommendation and best-practice context

There is no universal best-practice slide count. Context and delivery time matter:

- [Y Combinator's Demo Day guidance](https://www.ycombinator.com/blog/how-to-design-a-better-pitch-deck/)
  suggests five to seven memorable ideas/slides, with simplicity and legibility taking priority.
- [Guy Kawasaki's 10/20/30 rule](https://guykawasaki.com/the_102030_rule/)
  is a ten-slide, twenty-minute, thirty-point-font heuristic for a conventional pitch, not a
  requirement that every short hackathon pitch use ten slides.
- [Sequoia's pitch framework](https://sequoiacap.com/article/writing-a-business-plan/)
  is useful for checking purpose, problem, solution, market, competition, business and team coverage.
  Those topics need not become one slide each in a three-minute product presentation.

Eight slides is reasonable in the abstract. Six is the recommendation here because the current
deck repeats the explanation and overweights methodology. Product complexity is a reason to
sequence information better, not to make every audience learn every layer.

| Main slide | One job |
|---|---|
| 1. Problem and promise | A familiar stock ticker does not tell you what the token holder actually owns or controls. |
| 2. The product makes a decision easier | Show one AAPL difference, its consequence and evidence; include a small standalone-token example to show no pair is required. |
| 3. It stays useful after the first visit | One real, dated issuer/protocol change and the holder impact detected by the monitoring loop. |
| 4. Why this product, and why Solana | Exact address → rights, control and usable protocols; demonstrate a maintained connection, with fair competitor positioning. |
| 5. What is built and what comes next | Two or three dated proof points, working product/demo link, honest pilot status and the professional-workflow hypothesis. |
| 6. Team and ask | Actual builder/team credentials, the pilot/user feedback sought, contact and @RWASonar. |

Merge the current problem/comparison explanation; move standalone depth and methodological detail
to an appendix; fold the separate Solana slide into the differentiation proof. Remove deadlines,
license TODOs and submission-package administration from the audience-facing narrative. Avoid
giving addresses and market metrics more visual prominence than the main conclusion.

Use real screenshots or focused HTML product excerpts with readable annotations. Pin the demo's
numbers and date together rather than mixing a live counter with a static snapshot label.
An investor version can later expand to about ten slides when there is real market, business,
team and traction content—not invented TAM, revenue or users to fill a template.

## Explicitly deferred

- Wallet connection, swaps, borrowing and transaction execution.
- Splitting `stocks.js`, de-duplicating the shared trust-chain/what-if CSS and other structural
  refactors (F11) until after judging.
- A case-law watcher feeding the `litigated` status (first candidates: Securitize I v. tZERO,
  D. Del. 1:26-cv-00722, and Liquid Rarity Exchange v. Securitize I, 1:26-cv-00698) and a model
  that judges whether a changed document matters. Both were proposed; neither is started.
- New chains or broad new RWA categories before the core workflow is validated.
- Generic AI chat, unsourced explanations and broad news aggregation.
- A composite “safe” score hiding unlike risks or unknown evidence.
- More charts without a specific decision they improve.
- Higher-frequency CoinGecko enrichment or a paid tier merely to freshen headline market data.
- A wholesale framework migration, visual rebrand or additional navigation layer.
- Catalogue breadth without exact identity, attribution and an honest evidence boundary.

Daily CoinGecko enrichment remains proportionate: market context supports the product, while
identity, rights, controls, evidence and confirmed use are its primary value.

## Definition of done

A feature being built, a conclusion being reviewed, a release being published and a user finding
value are four different milestones. Record each honestly.

Every material answer must name its asset/programme and holder scope; distinguish observation,
actor assertion, analysis and uncertainty; show the strongest applicable sources and meaningful
timestamps; preserve missing/stale/blocked/unavailable states; and expose important qualifications
without forcing the reader through methodology first.

Every implementation must work for lone, two-wrapper, many-wrapper and no-confirmed-market tokens, include fast
behavioural tests, provide a verified local review link, and pass complete release/publication
checks before being described as deployed. Real people—not subagents—validate comprehension.
