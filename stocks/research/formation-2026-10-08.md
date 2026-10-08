<!-- Records the Formation announcement separately from existing protocol operation and audits prior monitor coverage. -->
# Formation: Orca–Loopscale merger coverage, 8 October 2026

**We covered the two protocols, but did not capture the announced merger.** The public protocol index contained 26 Orca and 8 Loopscale integration dossiers. Neither the curated research nor the reviewed live events recorded Formation.

The [primary announcement](https://x.com/formation_so/status/2107965006578921623), published **7 October 2026, 22:43:16 UTC**, says the combined team operates as Formation. Luke Truitt is CEO, Mary Gooneratne COO, and Christopher Montagano Chief Strategy & Legal Officer. The user's [Solana post](https://x.com/solana/status/2107964440935333991) appeared at 22:41:01 UTC and quoted the earlier co-founder announcement.

The [Orca FAQ](https://docs.orca.so/formation/faqs) and [Loopscale FAQ](https://docs.loopscale.com/resources/formation) say both products continue, existing positions need no migration, and programmes, upgrade authorities and multisigs remain unchanged. These are team statements; this audit did not independently re-decode both protocols' present control accounts.

ORCA remains the network token; Orca says no additional mint or dilution. Loopscale says it will not launch a separate token, that points continue accruing, and conversion details will follow. These statements do not establish an enforceable equity claim against Formation. The announced plan for a regulated securities venue is not evidence that such a venue has obtained permission or started operating.

## Why this matters to RWA analysis

Trading, credit and vault strategy operations now have a common announced team. That changes the organizational dependencies and potential conflicts we should investigate. It does not, by itself, combine collateral pools, change tokenholder rights, migrate contracts, or prove the same people can exercise every administrative key.

Keep Orca and Loopscale as separate protocol identities and retain their existing technical evidence. Add Formation above them as an announced operating-group relationship. Revisit governance ownership, legal counterparties, terms, risk/curator policies and any later contract migration when primary evidence appears. The legal merger documents, incorporated entity, consideration and customer-contract novation were not established by the public announcement.

## What the live audit showed

The [machine-readable audit](formation-coverage-2026-10-08.json) records:

- All **643** monitored sources were checked. Only Orca's homepage was present for these organizations; the two Formation FAQs and Formation website were absent.
- The Orca homepage was marked successful at **2026-10-08 03:23:55 UTC**, after the announcements, with no new change recorded. That does not establish whether the banner was present in the fetched version or why it was missed.
- All **718** watcher events since October 7 were inspected across both API pages. None captured this merger. Unrelated uses of “capital formation” were excluded.
- The newest 200 live public events, the published change log and the checked-in curated events also contained no merger event.

This is a coverage gap between monitoring protocol activity and detecting a new organizational relationship. A healthy on-chain collector cannot be expected to infer a merger from unchanged contracts.

## Local additions

Recorded the dated event and Formation relationship in the existing curated sources, and registered both official FAQs and the Formation announcement/site through the protocol-organizations registry. Source extraction discovers those URLs without deploying or running the watchers. No contracts or programme identifiers were renamed, and no live monitoring configuration was changed.

For future detection, monitor the explicit FAQ pages and announcement feeds; inspect changed organizational claims separately from on-chain configuration changes. An announcement can trigger review, but must not automatically rewrite legal entities or report a contract migration.
