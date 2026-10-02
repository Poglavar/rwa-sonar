# RWA Sonar UX audit 1

**Reviewed:** 20 September 2026  
**Implementation review:** 21 September 2026
**Scope:** Live desktop and mobile experience across the landing page, analytics workspace, asset
and issuer detail, comparison, DeFi, Monitor, Watch, What If, Learn, methodology and review
surfaces. The interaction models of DefiLlama RWA, RWA.xyz and L2BEAT were used as adjacent
benchmarks.

## Implementation status — 21 September 2026

The first refinement pass has implemented the audit's central interaction model:

- one shared application shell and stable **Explore · Compare · Changes · Learn** navigation;
- a cobalt, coral, amber and ivory identity, with green reserved for supported/current states;
- compact application headers in place of repeated landing-page heroes;
- underlying-first Explore results, with exact token addresses nested one level down;
- two-wrapper comparison by default, a decision summary first and the full matrix optional;
- asset reports organized as **Answer → Reasoning → Evidence → Technical data**;
- bounded, static recent-addition previews rather than an auto-moving token strip;
- scenario-first What If entry points and progressively disclosed monitoring/research surfaces;
- plain “token” and “token address” language in primary journeys, reserving “mint” for technical
  evidence; and
- consistent public links into issuer, evidence, Learn and advanced research contexts.

This document remains the record of the pre-refinement audit, so the measurements and findings below
are intentionally preserved. The remaining work is validation and refinement rather than another
information-architecture reset: test the 30/60-second comprehension goals with real users, finish
terminology cleanup in deep research tables, make issuer dossiers fully route-addressable rather
than query-addressable, verify freshness/coverage labels on every metric, and measure DOM and mobile
scroll reductions against the baselines recorded here.

## Executive diagnosis

RWA Sonar already has a distinctive visual identity and unusually strong research. The problem is
not that the site looks bad. The problem is that it often exposes the structure of the dataset
instead of organizing the product around the questions a person is trying to answer.

The current experience is:

> Excellent research presented as an exhaustive dossier.

The target should be:

> An immediate, evidence-backed answer—with the trust boundary visible and deeper evidence
> available on demand.

That distinction should become the product's defining advantage.

## The UX north star

A visitor should be able to answer these five questions about any tokenized stock in less than 30
seconds:

1. What is this token?
2. What do I legally own?
3. Who can control, freeze or override it?
4. How can I redeem, sell or use it today?
5. What has changed, and how certain is this answer?

Everything else is supporting evidence.

The product should use four information layers everywhere:

1. **Answer** — the plain-English conclusion.
2. **Reasoning** — why RWA Sonar reached it.
3. **Evidence** — documents, onchain observations and quotations.
4. **Raw data** — technical fields, addresses and collector output.

At present, many pages show all four layers simultaneously.

## What is already excellent

- The visual language is memorable, editorial and more credible than the typical crypto dashboard.
- “A ticker is familiar. The token is not.” is a strong opening.
- “Market size tells you what exists. We show what you must trust.” accurately expresses the
  product.
- The plain-language legal verdict at the top of asset pages is excellent.
- Separating market, control, legal/evidence and DeFi health is far better than producing one
  misleading score.
- The claims-versus-observed-reality analysis is a genuine differentiator.
- The same-underlying comparison contains exceptionally valuable analysis.
- Confirmed DeFi usage is properly separated from theoretical composability.
- The What If research is unique intellectual property.
- The public change journal correctly distinguishes real-world changes from internal research
  corrections.
- The Learn content is organized around human questions rather than industry terminology.

The redesign should preserve the branding and analysis. This is primarily an
information-architecture and interaction problem, not a visual rebrand.

## Principal findings

### 1. Important answers compete with everything else

The asset page starts extremely well, but then becomes a roughly 12,000-pixel desktop page and
19,000-pixel mobile page. It has 16 major sections, more than 100 links and several full tables.

Legal rights, charts, controls, DeFi integrations, trust chains, hypothetical failures, source
documents, health formulas and raw data are all expanded. Valuable analysis consequently feels
intimidating, and the most important conclusion appears to be merely one field among hundreds.

The default asset page should fit its essential answer into two or three viewports:

- plain verdict;
- four-dimensional profile;
- what the holder owns;
- who can intervene;
- redemption and market exit;
- confirmed uses;
- most important discrepancy or change;
- evidence freshness.

Everything else should live behind **Why?**, **Show evidence** and **Technical details**.

### 2. The app repeatedly behaves like a landing page

The main analytics workspace repeats the large “Start with the stock…” hero above every tab. On a
390-pixel mobile screen this consumes most of the first viewport before the user reaches the task.

Large editorial heroes are appropriate on the landing and Learn pages. Operational pages need a
compact, persistent product header.

Use two shells:

- **Editorial shell:** landing, Learn and methodology; larger typography and narrative pacing.
- **Application shell:** Explore, Compare, Changes and asset pages; compact navigation, persistent
  search and immediate task access.

### 3. Discovery is organized around token addresses rather than investor questions

People normally begin with “Apple,” “AAPL” or “Which version of SPY should I use?” They do not begin
with a Solana mint address.

The current asset table leads with every individual token. Search for AAPL returns separate
wrappers, but does not immediately say:

> Two tokenized versions of Apple are available. Here is how they differ.

Make the underlying stock the primary discovery object. A result should show the company or ETF,
number of wrappers, issuers, high-level claim differences and a prominent comparison action. The
precise token address remains critical, but belongs one layer down.

### 4. Comparison is the strongest feature and one of the hardest to use

The comparison data is outstanding: ownership, failure mode, redemption, custody, default,
liquidation, hacks, key loss and evidence status.

But the full matrix is too wide. On mobile it is approximately 1,282 pixels wide inside a 326-pixel
content area. “Swipe horizontally” does not solve a comprehension problem.

Comparison should initially show two wrappers and a short decision summary:

- what you own;
- who can block transfer;
- cash redemption;
- market exit;
- confirmed collateral use;
- principal failure mode;
- evidence confidence.

Each question can then expand into the full answer and evidence. Desktop can offer an optional full
matrix; mobile should use stacked question cards and never require horizontal scrolling.

There need not be a fake winner. The product can describe a wrapper as having a stronger legal
claim, fewer control powers, better current liquidity, more confirmed DeFi utility or greater
uncertainty.

### 5. Research and collector interfaces dominate the public information architecture

Monitor, Watch and Review contain valuable material, but their default presentation resembles an
internal research console: thousands of links, hundreds of controls, every technical facet,
implementation field names, source-processing events and editorial review tasks. The Watch page
alone is roughly 35,000 pixels tall and contains more than 1,100 links.

Separate three things:

1. **Material holder changes** — redemption suspended, reserves changed, control authority changed,
   terms changed or protocol support removed.
2. **Catalogue changes** — newly discovered tokens, issuer coverage and venues.
3. **Research operations** — source health, raw observations, unsupported conclusions and the editor
   queue.

The first two are products. The third is an advanced transparency/research surface and should not
dominate normal navigation.

### 6. Too much industry and implementation language reaches the user

“Mint” appears throughout the public product: “Every mint,” “new mints” and “mints measured.” Other
unexplained terms include claim rung, ledger maturity, recipe, authority keys, rebase, oracle source,
organic flow and the cryptic `C F P` flags.

Use:

- **token** by default;
- **token address** when the exact issued token matters;
- **Solana mint address** only in technical details.

Every specialized term should have a plain label and optional explanation. For example:

> **Issuer can freeze transfers**  
> The token program contains an active freeze authority.

### 7. The site lacks one stable navigation model

Navigation differs across the landing page, analytics workspace, methodology, Learn, Watch,
Monitor, Review and asset pages. Asset pages have breadcrumbs but no persistent global navigation or
local table of contents.

Use one primary navigation everywhere:

- Explore
- Compare
- Changes
- Learn

Keep global search permanently visible. Put Methodology, Data coverage, Source health, Advanced
monitor, API and the Review queue under **Research** or **More**.

### 8. Freshness and coverage are present but not consistently legible

The site responsibly exposes coverage limitations, but the information appears in different forms
and locations. Some metrics say `477 / 1,182 mints measured`; others show timestamps or evidence
status.

There is also a concrete count inconsistency: the audited live catalogue showed 1,182 tokens while
the issuer funnel said 1,183.

Every metric should use the same compact context component:

> As of 20 Sep 2026 · 477 of 1,182 tokens measured · Onchain accounts, not verified people

The component should communicate the timestamp, numerator and denominator, source type,
market-open or market-closed state where relevant, evidence status and important limitations.

### 9. Several pages render far more interface than a user can process

Observed during the audit:

| Surface | Evidence | UX consequence |
|---|---:|---|
| Analytics overview | roughly 14,900 DOM nodes | Hidden/repeated content still burdens the page |
| “New on Solana” | hundreds of rendered links | Discovery feed overwhelms the main task |
| Asset report | roughly 12,000 px desktop / 19,000 px mobile | No clear boundary between answer and dossier |
| Monitor | roughly 7,900 DOM nodes and 868 links | Expert facets dominate the default experience |
| Watch | roughly 35,000 px and 1,165 links | Material changes disappear inside source operations |
| What If | 477 controls for 456 answers | Research taxonomy appears before the user's scenario |

Only the first five to ten items of a feed should render initially. Hidden tabs, long lists and
advanced sections should be lazy-rendered.

## Recommended product architecture

### Landing page

The landing page is already strong. Keep its visual identity, but make search or exploration the
primary action above the fold. Demonstrate the product with a specific example:

> Apple has two tokenized versions on Solana. They do not give holders identical rights.

### Explore

Default to underlying companies and funds rather than a flat list of token addresses. Each result
should show:

- underlying company or ETF;
- number of wrappers;
- issuers;
- best available legal claim;
- material control powers;
- confirmed DeFi uses;
- market/liquidity status;
- material discrepancies;
- comparison action.

An “All token addresses” table can remain available as an advanced view with configurable column
presets.

### Asset page

Recommended structure:

1. Verdict
2. Four dimensions
3. Rights and redemption
4. Control and intervention
5. Markets and holders
6. Confirmed DeFi use
7. Evidence and change history
8. Technical data

Use a sticky local section navigator on desktop and a compact section menu on mobile.

### Issuer page

Issuer details should become full, shareable URLs rather than very long modals. Lead with what the
issuer says holders own, what the documents support, the trust chain, who controls issuance,
transfer and redemption, insolvency and redemption implications, active discrepancies and recent
real-world changes. Documents and raw findings should be collapsed below the conclusions.

### Changes

Lead with materiality, not ingestion volume. Every entry should answer:

- What changed?
- Who or what caused it?
- Which assets are affected?
- Why might a holder care?
- What was true before?
- What is true now?
- What is the evidence?

Large batches of newly discovered token addresses should not displace legally or financially
important changes.

### DeFi

The next step is an actionable discovery interface organized around:

- what the user can do;
- which protocol supports it;
- which exact token is supported;
- whether the use is collateral, trading, liquidity provision or a vault;
- current limits or LTV;
- whether the position can be autonomously liquidated;
- what happens if the protocol is hacked or access is lost.

It should be navigable both from an asset and from a protocol.

### What If

Transform the 456-answer matrix into a scenario-first tool. Begin with choices such as:

- I lose my wallet key.
- The issuer fails.
- The token is frozen.
- A lending protocol is hacked.
- The protocol holds the token but loses access.
- The borrower defaults.
- The custodian becomes insolvent.

Then present the relevant answer for the selected issuer, or compare two issuers. Keep
**documented**, **inferred**, **litigated** and **unknown** visible.

## Interaction and visual rules

- One primary action per screen.
- No horizontally scrolling analytical comparison on mobile.
- No auto-moving data strips.
- No more than five to ten “new” items rendered initially.
- No unexplained acronyms or one-letter flags.
- Unknown must look different from bad.
- A stale result must look different from a current negative result.
- Legal strength must never be conflated with market liquidity.
- Onchain accounts must not be labelled as people or beneficial owners.
- A summary must never hide a qualification that could reverse its meaning.
- Every conclusion should expose its evidence in one action.
- Advanced detail should be available without becoming the default experience.

Status color should retain the same meaning throughout the product:

- green: supported/current;
- amber: qualified, incomplete or caution;
- red: material adverse condition;
- grey: unknown or unmeasured;
- cobalt: product navigation and identity, not a health state.

## Recommended implementation order

### Phase 1 — Fix the product frame

1. Introduce one shared application shell and global search.
2. Reduce the analytics hero to a compact header.
3. Standardize navigation and page naming.
4. Replace default “mint” terminology.
5. Create shared freshness, coverage and evidence-status components.
6. Fix the 1,182/1,183 inconsistency.
7. Limit and lazy-render “New on Solana.”

### Phase 2 — Rebuild the two decisive journeys

8. Redesign search and Explore around underlying stocks.
9. Rebuild asset detail using Answer → Reasoning → Evidence → Raw data.
10. Rebuild comparison for two-wrapper comprehension, especially on mobile.
11. Turn issuer modals into real issuer pages.

These are the highest-leverage changes because they determine what a new visitor understands about
the product.

### Phase 3 — Make ongoing intelligence useful

12. Split material changes, catalogue additions and source operations.
13. Rank changes by holder impact.
14. Build asset/protocol DeFi discovery.
15. Redesign What If around user scenarios.
16. Move Monitor and Review into clearly marked advanced research tools.

### Phase 4 — Polish and personalize

17. Add watchlists and “what changed since your last visit.”
18. Add shareable comparisons and saved filters.
19. Add contextual Learn links beside legal and technical concepts.
20. Measure actual user comprehension rather than raw engagement.

## Acceptance criteria

- A first-time visitor can identify what a token represents, who controls it and how they can exit
  within 60 seconds.
- Every primary task is reachable in no more than two navigation actions.
- Mobile comparison requires no horizontal scrolling.
- The default asset experience is no longer than roughly three viewports before advanced evidence.
- Search groups wrappers by underlying and offers comparison immediately.
- Hidden tabs and collapsed lists are rendered lazily; the analytics page falls well below its
  audited roughly 15,000 DOM nodes.
- No unexplained use of “mint” remains in the default interface.
- Every market, account and volume number communicates freshness and coverage.
- Real-world changes are prioritized above ingestion and collector events.
- Five usability-test participants can independently explain the difference between the stock, the
  token, the issuer claim and the observed controls.

## Strategic conclusion

RWA Sonar should not win by looking like a richer database. It should win by making difficult
legal, technical and market reality understandable faster than any other product—without hiding
uncertainty or evidence.
