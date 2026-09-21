# RWA Sonar next steps

This roadmap follows the September 2026 UX refinement. The product goal is to make RWA Sonar the clearest and most evidence-grounded analytics product for tokenized stocks on Solana: simple at first glance, deep on demand, continuously monitored, and explicit about the difference between published claims and observed reality.

## Immediate

1. Review and commit the current UX refinement: anonymous “since your last visit” change tracking, clearer token-address terminology, contextual Learn links, and the refreshed public change journal.
2. Create a simpler asset decision page. Lead with what the holder owns, who can intervene, how the holder can exit, confirmed DeFi use, and the largest unresolved risk. Keep market tables, authorities, and raw evidence behind progressive disclosure.
3. Improve the same-stock comparison journey. Automatically group tokens representing the same underlying stock, emphasize meaningful differences, and provide a sourced plain-English synthesis without presenting it as investment advice.
4. Turn discrepancies into a first-class product feature. Add a dedicated claims-versus-reality view with filters for issuer, affected assets, holder impact, and unresolved or resolved state. Show the published claim, observed reality, source, and first-observed date side by side.
5. Add universal contextual explanations. Put a short “What does this mean?” explanation beside unusual fields and grades, with a link to the relevant Learn guide for claim rung, beneficial ownership, forced transfer, bankruptcy remoteness, redemption, and collateral enforceability.

## Next UX layer

6. Build a personalized, privacy-friendly home view with changes since the last visit, saved issuers, saved stocks and comparisons, new assets, and changed protocol support. Store preferences locally by default and retain optional cross-device watch links.
7. Introduce task-oriented navigation: find a token, compare products, understand what I own, see what changed, and find usable DeFi markets.
8. Make evidence provenance visually consistent. Every material conclusion should expose source authority, last checked time, direct claim versus inference, jurisdiction and holder scope, and conflicting evidence.
9. Rework large tables for progressive disclosure. Default to five or six decision-useful columns, allow advanced columns to be added, preserve filters and column choices in the URL, and provide Legal risk, Market activity, Issuer control, and DeFi presets.
10. Improve search results by grouping matches under underlying stock, token, issuer, and protocol, explaining why each result matched, and accepting token addresses without making addresses the main presentation.
11. Complete the mobile and accessibility pass across comparisons, dossiers, journal cards, and detail dialogs, including keyboard navigation, focus states, screen-reader labels, and alternatives to wide tables.
12. Add empty, loading, and failure states that distinguish none exists, none confirmed, not collected, stale, and collector failed, with a useful next action for every state.

## Analytics and research

13. Create protocol dossiers covering supported tokenized stocks, available actions, collateral parameters, exact evidence, and the outcomes after borrower default, protocol compromise, or lost access.
14. Add real-world change histories to issuer and asset pages, excluding RWA Sonar editorial corrections and showing before and after values with primary sources.
15. Improve holder analysis with historical counts and concentration, careful separation of token accounts from economic holders, and evidence-backed attribution of treasury, protocol, and venue accounts.
16. Improve market-quality analysis with historical liquidity, volume, organic share, venue count, premium, suspicious-volume flags, and concentrated-activity warnings without collapsing them into one opaque score.
17. Model redemption usability: legal availability versus observed successful redemption, including eligibility, geography, KYC, minimums, fees, timing, and operational evidence.
18. Expand issuer-control research by attributing authority keys to people, multisigs, programs, or unknown controllers; recording signer thresholds and upgrade authority; and alerting on changes.
19. Add structured document precedence so conflicting marketing pages, terms, prospectuses, mandatory law, and on-chain behavior can be evaluated by jurisdiction and holder class.
20. Build research-gap pages that rank unknowns by likely holder impact, say what evidence would resolve them, and separate not yet researched from not publicly disclosed.

## Product presentation

21. Refine the landing page around the differentiator: “L2Beat for tokenized real-world assets,” illustrated with one live discrepancy and one same-stock comparison rather than catalogue size alone.
22. Add short evidence-linked research briefs for important issuer changes, new DeFi support, control changes, and material legal-document changes.
23. Improve the pitch deck with one ownership-chain story, one claims-versus-reality story, one DeFi-enforceability story, and one automatically detected change.
24. Run a formal usability test with concrete questions, measuring completion time, wrong conclusions, and abandonment points, then use the findings for the next UX audit.
