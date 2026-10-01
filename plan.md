<!-- Implementation plan for making RWA Sonar's structure graphic the main entrance and using evidence-backed visual profiles and scenarios throughout the product. -->
# RWA Sonar visual experience plan

Date: 2026-10-01

Working branch: `unification`

Status: core visual experience implemented locally on `unification`; validation and remaining review limits are recorded below.

The earlier unification plan and its implementation record are preserved in [docs/unification-plan.md](docs/unification-plan.md). This plan builds on that work. Implementation is recorded against the individual steps below; this work has not been published to production.

## 1. Outcome

Make the collapsing graphic the main entrance to RWA Sonar. A visitor should quickly understand that many token addresses share issuers, legal structures, contract controls and dependencies, then investigate the parts that matter to them.

The reader journey is:

**Recognize the structure → notice its strengths and weaknesses → investigate the evidence.**

The interface should feel alive through purposeful movement, consistent issuer colors, recurring icons and simple analogies. It should help a reader identify reasons for confidence and caution without a numerical maturity score or an overall issuer grade.

Success means a reader can answer:

- What interest would I hold, and who owes or records that right?
- Which parts of the arrangement are established, conditional, problematic or unknown?
- How would I get out, and what depends on another party continuing to act?
- What changes if a particular party becomes unavailable?
- Where is the evidence, and does it apply to my holder context and exact token?

## 2. Product decisions

### The graphic is the navigation

The home page leads with a compact explanation and the interactive structure map. Selecting a branch reveals its products and a useful next action in the same view. Opening a report is a separate, explicit link, so exploration does not unexpectedly navigate away.

Use the same map component at the top of `explore.html`, connected to its filters and results. Keep search and a straightforward list available beside or immediately below it. Detailed reports and comparisons remain ordinary, linkable pages.

The initial map has three primary columns:

**Token clusters → issuer programmes → shared structures.**

Use a two-option control for the final column:

- **Legal structures** is the default: explain the interest the holder may have.
- **Contract controls** shows the existing control-recipe idea: explain the technical powers different tokens share.

“Issuer programmes” is the accurate label for the current stock grouping. A programme, issuing entity, distributor and brand are not interchangeable. Show the actual issuing entity when established, and keep uncertain entity relationships explicit.

Legal-form categories and exact shared terms must also remain distinct. Two fund shares can share a category while having different redemption rights. An exact terms-template grouping requires a reviewed identity and version; otherwise label the group as a structure type.

### Identity and judgment have separate visual roles

Issuer identity colors follow the same group across the map, product preview, report and comparison. They identify a branch; they do not rate it. Use a stable registry keyed by an explicit identity, not an array position or a display name. Existing programmes remain separate unless a reviewed mapping establishes a common issuer identity.

Finding colors communicate a specific conclusion:

| Meaning | Visual treatment | Example wording |
| --- | --- | --- |
| Established strength or capability | Green + check | “Direct redemption documented” |
| Condition, restriction or dependency | Amber + gate | “Approval required” |
| Demonstrated problem | Red + broken link | “Redemption suspended” |
| Important uncertainty | Gray + question mark | “Priority not established” |

These are examples of language, not new findings about any named product. Every production label needs scoped evidence.

Always show text and an icon with the color. Keep “Not applicable” as a separate neutral treatment with a reason. Retain stale evidence and conflicting sources as explicit evidence qualifiers; neither is silently converted into an ordinary restriction or a demonstrated failure.

Do not color an entire product or issuer green/red, count green icons into a hidden score, or rank products by the number of positive findings.

### Five recurring questions

Use the same order, labels and icons throughout the site:

| Profile feature | Suggested icon | Existing research dimensions | Reader's question |
| --- | --- | --- | --- |
| Ownership | Document / claim | `rights` and `ledger` | What do I own, and which record establishes it? |
| Backing | Vault | `backing` | What supports the claim, and who holds it? |
| Controls | Key | `controls` | Who can freeze, move, change or recover the token? |
| Exit | Door / route | `exit`, with relevant `access` conditions | Can I redeem or sell, through whom and on what terms? |
| Failure | Lifebuoy / interrupted route | `failure` | What remains available if an intermediary fails? |

The five features are a presentation layer over the seven existing analytical dimensions. Preserve the full dimensions, including access and authoritative ledger, in the report and comparison. Keep holding/transfer eligibility visible near holder context; it must not disappear into redemption details.

A feature can contain both a strength and a limitation. Show both when material, for example “Claim defined” plus “Register precedence unclear.” Do not collapse a mixed finding into a single reassuring badge.

Above the profile, write a concise editorial conclusion, for example:

> Clear claim. Access has gates. Failure terms need checking.

Its clauses must point to the relevant findings. Describe why confidence or caution is warranted; avoid universal “safe,” “best” or “fully backed” claims that the evidence cannot establish.

### Analogy and movement explain something

Use **a vault, its key and the route out** as the recurring explanatory vocabulary. Label the real parties and legal interests alongside the analogy. A vault must not imply segregated custody, direct ownership or guaranteed recovery where those points are unresolved. For synthetic exposure or contractual claims, use a claim/document representation where a physical vault would mislead.

Motion has a job: show grouping, trace a relationship, reveal a control, or illustrate a consequence. Membership lines show association. Moving particles or arrows indicating value transfer belong only in a documented flow explanation.

## 3. Existing implementation to build on

| Area | Current files / data | Planned use |
| --- | --- | --- |
| Landing funnel | `index.html`, `funnel-figure.js`, `funnel-figure.css` | Promote and evolve the existing graphic into the main entrance |
| Pure funnel data and geometry | `stocks/lib/funnel.mjs`, `stocks/lib/funnel-layout.js`, `stocks-funnel.json` | Reuse counting/layout concepts; preserve the explicitly Solana control view |
| Shared discovery | `explore.html`, `explore.js`, `explore.css`, `stocks/lib/rwa-catalogue.js` | Connect map selection, filters, results and product preview |
| Scoped research | `rwa/data/research.json`, `rwa/lib/research.js`, `rwa/lib/stock-research.mjs` | Resolve findings by programme/instrument, context, terms and deployment |
| Research build | `rwa/lib/build-research.mjs`, `rwa/build-research.mjs` | Produce validated display profiles from retained research |
| Reports and comparisons | `report.html`, `compare.html`, `research-page.js`, `research.css` | Render the same visual profile and evidence links |
| Stock templates and reports | `stocks/lib/legal-templates.mjs`, `stocks/build-legal-templates.mjs`, `stocks/build-cards.mjs` | Reuse scoped source material and bring shared visuals into generated pages |
| Scenarios and diagrams | `stocks/data/trust-chain.json`, issuer dossier `whatIf[]`, `stocks/lib/whatif-render.js`, `stocks/lib/schematics.js`, `stocks/lib/flow-diagram.js`, `trustchain.css` | Reuse actors, failure questions, sourced steps and diagram rendering |
| Shared theme and motion | `app-shell.css`, `theme.js`, `motion.css`, `landing.js` | Shared colors, focus styles, light/dark themes and reduced-motion behavior |
| Release boundary | `stocks/lib/release-manifest.mjs`, `stocks/validate-release.mjs` | Publish mutually consistent graph, profiles and research |

The current funnel is based on Solana stock addresses and technical recipes. Its programme count is not a count of distinct legal issuers, and its recipe column is not a legal-template column. The new all-RWA entrance needs explicit data shaping rather than changed labels over the existing stock-only totals.

The current research `state: supported` means a finding is documented. That finding can describe a restriction or a problem. It must never map automatically to green.

The existing what-if answer statuses describe evidence basis, including documented, inferred, litigated, unknown, not applicable and missing. They are not outcome ratings.

## 4. Implementation sequence

Implement the static, evidence-correct experience first, then animate it. Release A comprises phases 1–6: the entrance, profiles and coherent navigation. Release B adds the failure interactions in phase 7. Apply phase 8 verification to each release.

### Phase 1 — Define the visual contract and representative examples

- [x] Inventory existing issuer color assignments, icons, evidence badges, motion controls and generated report headers before adding new equivalents.
- [x] Choose a small set of existing research records covering cash, fund shares, bullion, credit/feeder interests and stock wrappers. Include programme-only research, multiple holder contexts, unresolved token binding, stale evidence and conflicting sources.
- [x] Write a reviewed example profile for each, using the existing sources and dates. Missing support becomes a visible gap rather than a research assumption.
- [x] Create reusable light/dark theme tokens for issuer identity, four finding treatments, evidence qualifiers, selection and muted branches in `app-shell.css`.
- [x] Choose one SVG icon treatment from the existing site assets, or a small local SVG set if there is no suitable shared set. Keep feature icons distinct from status icons.
- [x] Define compact, expanded and comparison forms of the five-feature profile, including mixed findings and long labels.
- [x] Establish layout examples at desktop, 375 px and 300 px, with keyboard focus and reduced motion.

**Acceptance:** The same issuer is recognizable across examples; positive findings, restrictions, known problems, unknowns and non-applicable cases can be distinguished without relying on color. Each profile retains a visible holder/research scope.

### Phase 2 — Add evidence-backed profiles and graph identities

- [x] Add stable finding IDs and structured presentation annotations to the canonical research inputs. Store a short label, its strength/condition/problem/unknown meaning, rationale and the finding references behind it. Keep annotations with research or its existing adapter; do not create a second unsynchronized findings database.
- [x] Add stable grouping IDs for issuer/programme identity, legal structure type, exact terms template where established, and contract-control recipe. Record the source and scope of each relationship.
- [x] Keep descriptive family membership separate from verified instrument/deployment binding. A programme-level legal structure remains a programme description when individual terms are unresolved.
- [x] Implement a pure profile builder, proposed as `rwa/lib/visual-profile.js`, using `resolveClaim()` and the existing applicability rules. Browser code should render its output rather than interpret legal prose.
- [x] Return all material feature findings, their evidence states/bases, source references, applicable context and original dates. Add a reviewed editorial conclusion whose clauses reference those findings.
- [x] Validate that each favorable or adverse assertion has adequate applicable evidence. An issuer statement must retain attribution where it cannot establish the stronger proposition. An interpretation remains labeled as analysis.
- [x] Resolve stale/conflicting evidence before treating a conclusion as currently established. If unresolved, show the historical proposition or disputed claims with their qualifier and an uncertainty treatment.
- [x] Invalidate or flag presentation annotations when their underlying claim, terms, scope or source version changes. A previously green phrase must not survive an incompatible research update unnoticed.
- [x] Extend research validation and the stock adapter without inheriting programme rights into unresolved individual tokens. A chain read never refreshes a legal review date.
- [x] Add meaningful unit tests for scope selection, mixed findings, missing data, conflicting evidence and annotation invalidation.

**Required distinctions:** Legal right versus observed execution; reserves versus enforceable holder claim; technical freeze power versus lawful recovery route; ability to hold versus right to redeem; issuer redemption versus secondary-market sale; “not obtained” versus “does not exist.”

**Acceptance:** Changing holder context or deployment produces only applicable findings. Documented restrictions stay amber, source conflicts remain visible, and an unknown finding cannot become positive through a default value or a keyword match.

### Phase 3 — Build the all-RWA structure map data

- [x] Add a pure map builder, proposed as `rwa/lib/structure-map.js`, and a thin CLI, proposed as `rwa/build-structure-map.mjs`. Generate `rwa-structure-map.json` from the current catalogue/research and relevant stock recipe data.
- [x] Build explicit nodes and typed edges for indexed deployments/token clusters, issuer programmes, legal structure types, reviewed terms templates and contract-control recipes.
- [x] Give every edge a relationship type, provenance, scope and known/unknown status. Do not infer issuer identity from a matching ticker, similar name or shared contract code.
- [x] Deduplicate deployments by network plus canonical address, respecting each network's address semantics. Count products, programmes, entities and deployments separately.
- [x] Represent a programme with several structures or control recipes through multiple valid links. A shared category does not imply identical rights, collateral or counterparties.
- [x] Keep unknown/unclassified groups and programmes without identified deployments visible. A zero-deployment programme is not an empty product universe.
- [x] Separate counts for the selected scope from overall coverage. Explain that the universe is indexed coverage, not a complete market census.
- [x] Use equal-width relationship lines initially. If node size encodes indexed deployment count, label that meaning. Any later count-weighted line needs a stated unit and deduplicated membership; neither area nor width implies value, volume or quality.
- [x] Keep the payload compact: group addresses instead of creating an animated DOM node for every token. Expand an issuer/product branch or use a filtered list for exact addresses.
- [x] Add the builder after its research/catalogue inputs in the release stages. Register the artifact, curated inputs and validation joins. Include it in the local research build command.
- [x] Test conservation of deployment counts where applicable, explicit unassigned membership, multi-membership deduplication, stable IDs and deterministic ordering. Legal-category totals may overlap and must say so.

**Acceptance:** Every visible count can be reconciled to its typed members, and every association can be explained. Missing legal bindings do not become implied rights merely because a connecting line exists.

### Phase 4 — Make the map the main entrance

- [x] Move the map into the main introductory area of `index.html`. Keep a short purpose statement, a visible instruction such as “Choose an issuer or structure to explore,” and direct access to search.
- [x] Extend the existing funnel geometry/rendering where useful. Put selection, grouping and path-highlighting rules in pure modules; keep DOM events and rendering in a thin page controller.
- [x] Default to the legal-structure view; make the contract-controls view one obvious switch away. Preserve the token-program detail within the relevant technical view, without adding a crowded fourth primary column on mobile.
- [x] Make each meaningful node keyboard and touch operable. First activation selects and highlights the branch; the adjacent summary supplies “View products” and report links.
- [x] On issuer selection, trace its products and structure/control links in its stable identity color, reduce emphasis on unrelated branches, and show the selected name plus typed counts.
- [x] On structure selection, highlight all applicable programmes and explain whether this is a broad structure category, an exact terms template or a technical recipe.
- [x] Show product previews with the five-feature profile only at a valid research scope. An issuer with several materially different products gets a product list, not a fabricated issuer-wide profile.
- [x] Add “Show all” and a concise visible selection trail. Keep unrelated branches discoverable rather than permanently hiding them.
- [x] Synchronize map selection with explorer filters/results through one state model. Preserve meaningful selection in URL parameters; support reload and browser Back/Forward. Invalid IDs should show an explicit unselected state rather than another product's report.
- [x] Use a persistent overview and selected-branch detail on small screens. Avoid shrinking a 1,100 px diagram into illegibility or making sideways scrolling the only route to the content.
- [x] Preserve the current explorer fixes: legible primary link, aligned selected row/detail, clear connector and no redundant Selected/Preview badges. Recalculate or replace the connector coherently if the layout changes.
- [x] Build a useful static summary and direct report/search links for no-JavaScript and loading/error states. Display an unavailable state on failed data load; do not replace missing current data with invented values.
- [x] Keep existing issuer, exact-token and Solana routes working. Update other funnel consumers deliberately and retain accurate scope labels where a view remains stock-only.

**Acceptance:** A visitor can select an issuer or a shared structure, identify the highlighted membership, open a product and return to the same selection. This works with touch, keyboard and browser history at 300–400 px and desktop widths.

### Phase 5 — Carry the profile through reports and comparisons

- [x] Put the editorial conclusion and five-feature profile near the top of `report.html`, below an explicit holder context and instrument/programme scope.
- [x] Give each feature a short primary statement and, where needed, a second material limitation. Expose evidence freshness and disputed/unknown status without forcing the reader to open a tooltip.
- [x] Make selecting a feature open or move focus to the relevant evidence section. Use stable anchors; show source title, operative locator, evidence basis and relevant dates within one interaction.
- [x] Preserve the full seven-dimension report, asset-specific analysis, wrapper dependencies and exact deployment observations beneath the concise profile.
- [x] Add the compact profile to the explorer's selected product preview. Keep list rows quiet enough to scan; do not repeat five animated panels in every result row.
- [x] Use the same pure profile builder and renderer on generated issuer/product reports where the research scope supports it. Label programme summaries and exact-token observations separately.
- [x] In `compare.html`, align the five features and their material sub-findings across products. Preserve the existing comparison modes and each side's context/terms selection.
- [x] Explain differences in plain language, including different exposures and conditions that are not directly comparable. Do not introduce a total score, green-count sort or “winner” badge.
- [x] Check that top-line profiles, comparison cells, detail sections and source links agree after any filter/context change.

**Acceptance:** The map preview, report and comparison give the same answer for the same scope. A reader can immediately name a supported strength and a material limitation, or see explicitly that the evidence does not establish them.

### Phase 6 — Add purposeful animation

Implement these as initial timing defaults, then refine in visual review:

| Trigger | Motion | Starting duration | End state |
| --- | --- | --- | --- |
| First visible map load | Token clusters gather into their programme grouping | 600–800 ms, once | Stable, selectable map |
| Select issuer/structure | Brief illumination of the relevant connections | 1–2 soft pulses, under 1.5 s total | Persistent branch highlight |
| Switch grouping | Existing nodes move to their new positions | 250–400 ms | New labels, counts and selection agree |
| Open a feature | Key, gate or evidence gap reveals the relevant relationship | 200–400 ms | The explanatory text and final diagram remain visible |
| Change failure scenario | Affected party dims and dependent routes change | 300–500 ms | A readable, labeled consequence map |

- [x] Animate stable node identities between layouts; do not briefly represent a token as changing issuer or legal owner when only the grouping changes.
- [x] Cancel or retarget an interrupted transition on rapid selection. Update semantic state and accessible content immediately; correctness must not depend on an animation finishing.
- [x] Add a visible motion toggle covering the affected experience. Remember the preference locally and integrate the existing `?reduceMotion` hook and `prefers-reduced-motion` behavior.
- [x] In reduced/static mode, show the same relationships and conclusions in their final state with no travel, pulsing or auto-scrolling.
- [x] Pause off-screen/hidden-tab activity and avoid idle animation loops. Use opacity/transforms and bounded transitions before considering a new animation dependency.
- [x] Preserve contrast while dimming branches. The unselected state must remain readable and operable; selection cannot depend on glow alone.
- [x] Reserve moving transaction particles for a separately labeled, sourced flow explanation. A pulse indicates selection, not live transactions, monitoring health or money moving.
- [x] Reconcile existing decorative home-page movement with the new entrance so attention stays on the current interaction.

**Acceptance:** Motion makes grouping and consequences easier to follow, leaves no perpetual work running when idle, and can be disabled without losing any information or navigation.

### Phase 7 — Add failure scenarios as the next layer

- [x] Start inside the product report with two explicit choices: “Issuer unavailable” and “Custodian fails.” Keep ordinary issuer unavailability distinct from legal insolvency; existing insolvency answers cannot silently answer an operational outage scenario.
- [x] Reuse the trust-chain actor catalogue, issuer `whatIf[]` answers and sourced schematics where their scope matches. Add cross-asset scenario data within the existing research system where needed; do not create a competing set of answers.
- [ ] Build each diagram from named parties and typed relationships: who holds assets, owes performance, processes redemption, maintains the record, holds a key or can enforce security.
- [x] Label the normal route before the scenario is activated. Distinguish the custody path, legal-claim path and operational exit path where they differ.
- [x] Define explicit scenario effects per relationship: available, interrupted, conditional or unknown. Dim the affected party, interrupt only routes supported as dependent on it, and leave documented alternatives visible.
- [x] Render an unknown consequence as a labeled gap. Do not propagate failure automatically through every connected node or equate service interruption with asset loss.
- [x] Label surviving legal routes as documented procedures/claims, with timing, eligibility and priority limits where known. A surviving route is not a guarantee of prompt payment or full recovery.
- [x] Keep evidence basis visible for each outcome: documented terms, analysis/inference, relevant adjudication, unknown or unanswered. A judgment in another case must retain the basis for its claimed relevance.
- [x] Separate hypothetical scenario styling from actual red problem findings. Activating a scenario must not make the product appear to have suffered a real current failure.
- [x] Provide a plain-text consequence summary and a “Return to normal” action. Scenario links should preserve product/context and open with a clear hypothetical label.
- [x] Add tests for scenario applicability, partial dependencies, alternative routes, unknown outcomes and restoration of the normal state.

**Acceptance:** A reader can see what relies on the unavailable party, which routes have documented alternatives and which outcomes remain unresolved. Each consequence has a source or an explicit analytical/unknown basis.

## 5. Verification and release steps

### Phase 8 — Verify each release against the real experience

- [x] Run focused headless tests for the new profile, map, selection and scenario rules. Tests must exercise observable outputs, including wrong-scope and missing-evidence cases.
- [ ] Extend the relevant existing suites: `stocks/rwa-research.test.js`, `stocks/rwa-stock-research.test.js`, `stocks/rwa-catalogue.test.js`, `stocks/funnel.test.js`, `stocks/funnel-layout.test.js`, scenario/schematic tests and release validation tests.
- [x] Run affected page/theme/global checks, including `landing-page.test.js`, `site-header.test.js`, `script-globals.test.js`, `theme-tokens.test.js`, `theme.test.js` and motion tests. Choose additional suites according to the files actually changed.
- [x] Rebuild research/catalogue/map artifacts from retained inputs; verify their joins and typed totals against the source records. Check that unchanged inputs produce unchanged semantic results.
- [x] Run the full fast headless test command before each release candidate. Report skipped database-dependent checks separately. No browser-driving test suite is part of the default workflow.
- [ ] Inspect the actual UI in a dedicated headed browser, using a no-cache dev server. Check both themes; desktop, 400, 375, 320 and 300 px; keyboard; touch-sized targets; static motion; long labels; many programmes; empty results; failed loading; rapid repeated selection; and Back/Forward navigation.
- [x] Verify link contrast, selected-row/detail alignment and connector placement against the earlier explorer issues. Check primary buttons after page-specific link styles apply.
- [ ] Check that status, focus and selection remain understandable with color removed. Inspect keyboard order, accessible names, focus restoration and announcements; avoid announcing every animation frame.
- [ ] Measure the map payload, initial rendering and a representative selection/grouping interaction on a quiet machine. Keep the initial view aggregated, with no per-address animation loop or off-screen recurring work.
- [x] Validate the release manifest and generated artifact URLs with the existing release validator. A broken profile/source join or missing map artifact fails release validation.
- [ ] Review every production profile's wording and provenance, rather than treating successful schema validation as an editorial review. Preserve original source, legal-review and chain-observation dates.
- [ ] Conduct a short comprehension review with people unfamiliar with the product if available. Ask them to identify a claim, an exit condition, an evidence gap and a scenario consequence. Record actual observations; do not call an internal walkthrough user research.
- [x] Provide local preview links and name the main elements consistently: **structure map**, **branch summary**, **product preview**, **five-feature profile**, **evidence detail**, **failure scenario**.

Suggested existing commands, run from the implementation worktree after the relevant changes:

```sh
# Rebuild shared research and catalogue; extend this script to include the new map builder.
npm run rwa:build

# Full existing headless suite, after focused checks pass.
npm test

# Validate a prepared release using the established publication origin.
node stocks/validate-release.mjs --run --base-url=https://rwasonar.com

# Final patch hygiene.
git diff --check
```

The release validator needs the required release artifacts to exist; a partial local build is not evidence of a valid full release. Use the existing release pipeline when preparing that candidate.

Prepare commits as coherent changes: visual/data contract, map navigation, profiles/comparison, motion, then scenarios. Commit/push and production publication follow the user's instructions at that point; this planning request does not activate production jobs or publish changes.

## 6. Completion criteria

Release A is complete when all of the following are true:

- The collapsing graphic is the first useful interaction on the home page and a working entrance to the shared explorer.
- Legal structures and contract controls are visibly distinguishable, with accurate coverage and grouping labels.
- Issuer identity colors remain stable across the map, previews, reports and comparisons.
- All currently reviewed products/programmes have applicable five-feature profiles, including explicit gaps where the evidence is insufficient.
- Concrete findings use color, icon and text together; mixed findings and scope limitations survive the summary.
- An editorial conclusion directs the reader to the reasons for confidence or caution, with evidence one interaction away.
- Motion explains selection/grouping, remains bounded, and has an equally functional static version.
- Existing report links, exact-token observations and comparison modes still work.
- Desktop and 300–400 px layouts, keyboard navigation, both themes and relevant headless checks pass.

Release B is complete when the two initial failure scenarios explain supported dependencies, documented alternatives and unknown outcomes at the selected product/context scope, with accessible static summaries and sourced consequences.

Neither release introduces a composite maturity score, an issuer-wide safety grade, inferred legal rights from common code, or a visual claim that is stronger than its evidence.

## 7. Implementation record — 2026-10-01

Implemented in `/Users/simun/Code/rwa-sonar-unification`, branch `unification`:

- The home page leads with the **structure map**: aggregated token clusters, stable programme colors, typed legal-structure and contract-control views, branch tracing, search, compact/all-programme views and **branch summaries**. Selection highlights related branches and uses shareable URLs, including browser history. The single catalogue search filters map membership and links directly to reports.
- The pure map includes separate reviewed terms/context records and provenance. A terms record is not asserted to be a shared exact template; unresolved token bindings remain unresolved. No common code or broad structure family transfers holder rights.
- A shared **five-feature profile** and evidence-backed editorial clauses appear in the **product preview**, reports, comparisons and generated programme/token pages. Icons and text accompany finding colors; no composite score is added. Display annotations invalidate when scoped claims or referenced sources change.
- Bounded connection pulses and node movement explain selection and regrouping. Animations are enabled by default and honor system reduction and `?reduceMotion`. Static mode preserves relationships and navigation.
- **Failure scenarios** offer normal arrangement, issuer unavailability and custodian failure, with explicit hypothetical labels, dated sources, separate claim/custody/exit outcomes and normal restoration. Existing stock dossier custody answers and party names retain their programme/sample caveats. An operational outage does not inherit an insolvency answer. Missing alternatives remain unknown.
- The duplicate catalogue/detail browser has been removed. Map connectors use layout offsets so motion cannot move them across search results.

Verification: the final full headless command passed 4,519 tests (3,330 stock/model, 185 API and 1,004 page/theme tests). Database-dependent checks require a database (62 were skipped). Release validation passed for 33 research subjects, 1,183 cards, 185 protocol dossiers and 998 comparison bundles. The map covers 1,207 deduplicated indexed deployments. Generated card HTML remains below the existing size limit.

Headed browser review covered both themes, desktop, 400, 375, 320 and 300 px; report/comparison overflow, source anchors, programme scenarios, invalid context, keyboard selection, history restoration, explorer link contrast, connector alignment and static motion were inspected. At 300 px, token/issuer rows had matching positions and static mode had no running animations. This does not substitute for the entire comprehensive browser checklist or reader research.

Remaining review/depth:

- Review every production short label against operative text, including source-attributed backing and sampled stock terms, before publication. This redesign does not obtain missing legal documents or refresh evidence dates.
- Expand the scenario diagram beyond the current three separate dependencies when sourced product-specific actors, recordkeepers, security agents, intervention keys and enforceable procedures support it. Current custody names come from retained programme party catalogues, with full role notes available; exact-token roles are not inferred.
- Complete the full keyboard/color-independent/accessibility and failed-loading/rapid-selection checklist, and measure rendering/interaction on a quiet machine. The map payload is 238,239 bytes. No performance timing claim is made: host load was 11.40/8.23/7.96 at the final check.
- Conduct the optional comprehension review with unfamiliar readers. None has been performed.

Local runtime gaps remain visible: current chain observations are older than their monitoring cadence; database material-change checks and some market/feed inputs are absent. The static snapshot refresh could not complete because `stocks-events.json` is absent locally; existing dated stock-only snapshot regions remain historical. The new map/profile artifacts and required release validation are complete.

Preview: `http://localhost:8117/`, `http://localhost:8117/explore.html`, `http://localhost:8117/report.html?product=paxg`, and `http://localhost:8117/report.html?product=stock%3Axstocks-backed&scenario=custodian-fails`.

Interaction refinement: cluster boxes are native selection buttons. View switching retains a group's originating legal/control membership and highlights its relationships in the other view, including reload/history URLs. Manual pause controls have been removed; system/URL reduced motion remains supported. “Control pattern unknown” describes an unclassified pattern, not absence of issuer powers. Single-context terms disclosures are replaced by a direct scope note; the headline is a plain summary of the linked feature cards.

Finding-language review: all 93 amber findings now carry visible explanations, and generic “described” labels are replaced by actual restrictions or named evidence gaps. Unsupported reserve/holdings checks and unreviewed investor terms are gray; direct-share products do not receive a reserve warning merely because their register is described. The dated Remora exit failure is explicitly dated. Research dates and source signatures are preserved. Full headless tests pass (4,519 tests; 62 database-dependent checks skipped), release validation passes, and the largest generated card is 126.5 kB, below the 128 kB target and 150 kB limit.

- Search consolidation: one catalogue-wide search in the map on home and explore; removed the duplicate explorer entry/detail section and homepage search. Search filters map membership and links directly to product and exact-token reports.

- Map presentation refinement: center search over legal/control tabs, fix the shortened caveat below the chart, remove profile divider/At a glance/branch links/manual motion controls, and show all filtered programmes without a compact-overview control.

- Filtered token clusters show matching tickers and distinguish matched addresses from programme totals. Removed the map preamble and moved live index counts, including distinct indexed chains, above the page title.

- Final positioning decision: selected branches and connections move to the top; compact views expand beyond seven rows when needed to include every connected programme matching the current search. Other visible rows remain dimmed and clickable. This supersedes the earlier fixed-position refinement.

Final verification after the branch-positioning revision: 4,525 fast tests passed, 62 database-dependent checks skipped; production-origin release validation passed. Headed selection checks confirmed selected issuers move first, the 24-member controls group expands fully, view switching retains its cohort, dimmed rows remain clickable, and mobile has no horizontal overflow.
