# RWA Sonar — current roadmap

Updated 21 September 2026. Completed work belongs in Git history and the dated research records;
this file contains only meaningful open work.

## Product and UX

- Validate the stock-first Explore, two-wrapper Compare and progressive asset reports with at least
  five first-time users. Measure whether they can explain the stock, token, issuer claim, observed
  controls and exit path within 60 seconds.
- Finish the remaining public-language pass in advanced Monitor, Watch and research tables: use
  “token” by default and explain “Solana mint address” only where the technical field matters.
- Turn issuer query views into durable, canonical issuer URLs with the same Answer → Reasoning →
  Evidence → Technical data structure as asset reports.
- Standardize freshness, measured coverage, source type, market-session context and “unknown versus
  checked zero” on every chart and headline metric.
- Measure DOM size, mobile scroll length and interaction cost against `UX-audit1.md`; lazy-render
  any advanced content that remains expensive while collapsed.
- Add lightweight “what changed since your last visit” and saved-filter affordances without making
  account creation a prerequisite.
- Continue contextual Learn links beside legal and technical terms, especially custody,
  beneficial ownership, redemption, insolvency and DeFi collateral enforcement.

## Research and analysis

- Close the highest-priority unresolved claim/evidence items in the public review queue, starting
  with rights whose uncertainty can reverse a holder conclusion.
- Deepen document-precedence and enforceability analysis for each issuer programme: operative terms,
  offering documents, custody agreements, security interests, governing law and holder standing.
- Expand protocol-side verification beyond registry presence: custody path, oracle dependency,
  liquidation authority, lender seizure/exit mechanics, caps and inactive-market behaviour.
- Track corporate actions and replacement-token mappings without treating a changed issuer registry
  as automatic issuance, retirement or circulation evidence.
- Distinguish beneficial holders from token accounts wherever reliable identity evidence becomes
  available; never infer people from account counts.
- Broaden RWA coverage only after the Solana-stock UX and evidence model are strong enough to remain
  comprehensible at larger scope.

## Monitoring and operations

- Keep every scheduled outcome visible in the morning digest: build, chain controls, evidence,
  protocols, snapshots, trades, data freshness and public endpoint health.
- Add explicit end-to-end freshness SLOs and alert only when a user-facing outcome is stale or
  materially changed, not merely because a collector ran.
- Periodically rehearse source outage, partial registry, RPC failure and stale-database scenarios so
  absence can never masquerade as removal or a checked zero.
- Continue recording exact observation time, source time, build time and publication time as
  different timestamps.

## Submission and distribution

- Replace changing snapshot counts in `README.md`, `SUBMISSION.md` and `/pitch/` immediately before
  final submission.
- Record a concise demo following the three-minute flow in `SUBMISSION.md`.
- Confirm bounty eligibility and whether one submission may be entered for multiple sponsor tracks.
- Prepare a small set of representative share links: an underlying comparison, an asset report, an
  issuer dossier, a material external change and a DeFi enforcement scenario.
