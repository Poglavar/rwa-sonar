# RWA Sonar comprehension rehearsal

This is the Stocklana rehearsal script for item 36. It is designed for five delegated synthetic
participant runs before a real user test. Synthetic runs can find confusing copy and broken paths,
but they do not count as adoption, demand or proof that real users understand the product.

## Participant agents

Use cheaper/older models for the first pass, with no project context beyond the task and the live or
local URL. Record the model and prompt used beside each result.

1. Tokenization newcomer on mobile.
2. Solana user who understands wallets but not securities terms.
3. DeFi protocol risk reviewer.
4. Potential issuer/operator.
5. Market-data or research integrator.

## Tasks

1. Compare AAPL wrappers. Explain the biggest difference in legal claim, issuer control, exit and
   confirmed DeFi use.
2. Inspect EXOD or another single-wrapper stock. Explain why no confirmed DEX pair is a market-exit
   answer, not missing legal research.
3. Explain what NVDAx ownership and issuer control mean in one minute.
4. Find a currently supported collateral route and name the main lender-exit limitation.

## Scoring

Record:

- time to first correct answer;
- wrong conclusion, if any;
- dead end or confusing label;
- whether the participant found source evidence;
- whether they distinguished technical custody from legal rights;
- whether they treated unknown, registry presence or account existence as safe/guaranteed;
- whether they would revisit or pay for monitoring.

Acceptance target for the demo rehearsal: at least four of five synthetic participants can explain
ownership, intervention and exit within 60 seconds of opening a report, distinguish technical
custody from legal rights, and avoid treating unknown or registry presence as a guarantee.

## Feedback routing

- Navigation/search failure: fix item 29 surfaces.
- Report comprehension failure: fix item 30 opening answer and evidence controls.
- DeFi proof confusion: fix item 31 labels before recording.
- Monitoring confusion: fix item 32 review-state language.

## Synthetic run — 22 September 2026

Five isolated GPT-5.5 agents used the rendered local site in headed mobile/desktop browsers without
source-code context. This is a heuristic rehearsal, not human usability research or adoption
evidence. All five reached materially correct conclusions; the proposed speed target was not met.

| Persona / task | Time and result | Main friction found | Feedback applied |
|---|---|---|---|
| Tokenization newcomer, compare AAPL on mobile | About 2–3 minutes; correctly separated legal claim, intervention, conditional exit and exact-token DeFi use | Large stock selector preceded the answer; source lists were dense | Comparison answer now precedes a collapsed “Compare a different stock” control |
| Solana wallet user, explain NVDAx | About 1 minute after opening the report; correctly distinguished wallet custody from issuer/legal rights | Decision links led to generic Learn pages; evidence affordance was dense | The five decision cards now jump to this token’s ownership, control, exit and protocol sections |
| DeFi risk reviewer, find collateral and lender exit | About 10–15 minutes; correctly bounded Kamino registry/account proof and the KYC/liquidity exit constraints | Duplicate Kamino pool labels and important detail behind disclosures | Repeated market names are deduplicated; proof steps remain explicit and unperformed checks remain “not performed” |
| Issuer/operator, inspect no-market FGDLx | About 1 minute; understood that no confirmed market is independent from legal research and issuer redemption | A TSLAx fee example looked FGDLx-specific; “delegate unknown” looked inconsistent with reclaim power | Cross-product fee examples now say the exact token’s fee is unconfirmed; authority rows say governance is unknown |
| Research integrator, monitoring/API | About 3 minutes; distinguished retrieval, comparison, review and conclusion validity, and found a sourced protocol removal | Landing change opened an issuer, not the change record; freshness/SLA needs stronger product treatment | Landing updates now deep-link to the highlighted public-journal entry |

Observed comprehension was accurate but too slow for the four-of-five-within-60-seconds target.
The five fixes above were applied after the run and have not been re-tested by independent agents.
Real participant validation, willingness-to-pay evidence and monitoring-SLA validation remain open.
