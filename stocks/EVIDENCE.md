# Evidence and watch: every claim backed, every source watched

The pitch has three legs: we read the same data from a specific angle, we surface facts buried
in prospectuses, terms of service and small print, and **we keep watch**, so that a change in a
treasury wallet, a float, a venue list, a legal term, a smart-contract toggle or an authority key
is caught within a day and shown with its evidence. This document is the design for the third
leg and for the "extreme quotation" the first two need.

Starting point (2026-09-17): 12 issuer dossiers in `stocks/data/issuers/` cite 292 distinct URLs
(18 PDFs, 172 `documents[]` entries), findings and incidents carry a `source`, but only 12 of 108
structured dossier fields name their source inline, and no source is fetched again after the day
it was read. On-chain facts are refetched by the 6-hourly refresh and snapshotted daily, but a
change only shows as a diff of numbers, not as an event with evidence.

## 1. Data model (schema `sonar`)

| Table | One row per | Key columns |
|---|---|---|
| `source` | URL we rely on | `id`, `url`, `kind` (pdf, html, api, onchain), `title`, `issuer_slug`, `first_seen_at`, `last_checked_at`, `last_changed_at`, `check_every` (interval), `archive_url` (Wayback), `status` (ok, changed, gone, blocked), `content_hash`, `error` |
| `source_version` | fetch that produced new content | `source_id`, `fetched_at`, `content_hash`, `bytes`, `text_path` (normalised text on disk, gitignored), `raw_path`, `diff_summary`, `diff_severity`, `diff_method` (none, quote-lost, keyword, llm) |
| `claim` | one fact we assert | `id`, `subject_type` (issuer, token), `subject_id`, `field` (dotted path, e.g. `redemption.rails`), `value` (the structured value), `quote` (the exact words from the source), `source_id`, `locator` (page, section, anchor, on-chain account+field), `recorded_at`, `last_checked_at`, `last_confirmed_at`, `status` (confirmed, changed, source-gone, unverified), `method` (manual, extracted, onchain) |
| `change_event` | detected change | `id`, `detected_at`, `kind` (see §3), `subject_type`, `subject_id`, `field`, `before`, `after`, `severity` (info, caution, warning, critical), `evidence` (source_version ids, tx signatures, snapshot dates), `summary`, `acknowledged_at` |

Rules: `recorded_at` is when we wrote the claim, `last_checked_at` when a watcher last looked,
`last_confirmed_at` when the quote was last found verbatim. A claim whose quote disappears from
its source does not become false; it becomes `changed` with a change event and a human decides.

## 2. Watchers (one PM2 job, `stocks/watch-sources.mjs`, daily; parts hourly)

1. **Document watcher** (daily, per source by `check_every`): fetch with a browser-like UA
   and conditional headers; PDF → text with `pdftotext -layout`; HTML → readable main text
   (strip nav, scripts, dates and counters that churn); normalise whitespace; hash. Same hash →
   `last_checked_at` only. New hash → new `source_version`, diff against the previous text.
2. **Archive** every source on first sight and every new version: `https://web.archive.org/save/<url>`
   (Save Page Now; an archive.org account key raises the rate limit and returns the job id),
   store the resulting `web.archive.org/web/<ts>/<url>` as `archive_url` on the version. Keep our
   own raw copy too (`stocks/data/sources/<source-id>/<fetched_at>.pdf|html`, gitignored, pruned
   to the last five versions), because Wayback is slow and refuses some CDNs.
3. **Importance of a document change**, cheapest signal first:
   - **quote check**: every claim's `quote` is searched verbatim (whitespace-insensitive) in the
     new text; a lost quote is `warning` on that claim, no model needed;
   - **keyword diff**: changed lines containing redemption, fee, custody, custodian, jurisdiction,
     governing law, freeze, pause, clawback, burn, delegate, authority, terminate, suspend,
     eligibility, lock-up, dividend → `caution`;
   - **LLM judge** on the remaining diff (batch API, cost recorded per call as the workspace
     rules require): "does this change alter what a holder owns, can do, or can be done to
     them?" → severity + one-paragraph summary; never the only signal, always shown as "model
     assessment" with the diff beside it.
4. **On-chain watcher** (hourly for keys and toggles, daily for holdings): for every mint the
   Token-2022 extension state (pausable/paused, default-account-state, permanent delegate,
   transfer-fee config, transfer-hook program, scaled-UI multiplier, metadata pointer/URI) and the
   mint/freeze/update authorities; supply; the labelled treasury and authority wallets' balances
   (top-20 holders already daily); the venue list per mint; the metadata JSON at `metadataUri`
   (it is a document too, watched by 1). Each is a `claim` with `method = onchain` and a locator
   (account, field), so a change is a change event with before/after and the slot/signature.
5. **Market watcher** (from the existing snapshots): float and supply moves, liquidity drops,
   venue added/removed, volume regime change, top-1 holder change, multiplier (rebase) — already
   in `lib/changes.mjs`; they become `change_event` rows with the snapshot dates as evidence.
6. **Alerts**: one Telegram summary per run through alerts-server-telegram (counts per severity,
   the top three), and an outcome check on `sonar.change_event` / `source.last_checked_at`
   freshness so a silent watcher is noticed within a day.

## 3. Change kinds

`legal-term` (document diff touching a claim or a keyword), `document-gone` (404, replaced,
domain lapsed), `authority-key` (mint, freeze, delegate, hook, update authority rotated),
`extension-toggle` (paused, fee bps, hook program, default state, delegate set/unset),
`rebase` (scaled-UI multiplier), `supply` (mint/burn beyond a threshold), `treasury` (labelled
wallet balance move), `holder-concentration`, `venue` (pool or market listed/delisted),
`float`, `liquidity`, `metadata` (token metadata URI content), `status` (issuer live/defunct).

## 4. Presentation

- **Every claim gets a chip.** Structured fields on dossiers and cards render the value plus a
  small "§" chip; hover or tap shows: the quote, the source title with link, the locator, the
  archived copy link, `recorded` and `last checked` timestamps, and `changed on <date>` in warning
  colour when the source moved after the claim. Nothing else changes visually; the chip is the
  whole UI cost.
- **A "Watch" page** (`watch.html`, API-driven): what we watch (sources by kind and issuer, with
  last check and archive status), the change feed (change events newest first, filter by kind,
  severity, issuer), and per issuer an evidence freshness bar (claims confirmed in the last 24 h /
  7 d / older / changed). The monitor's change log becomes a view of this feed.
- **Cards and dossiers restructure** field by field: value → `{value, claims: [id]}` in the built
  files, so the page can draw the chip; the dossier JSON on disk keeps prose but every prose
  field gains `sources: [{url, locator, quote}]`, filled once by an assisted pass over the 292
  URLs and then maintained by the watchers.
- **Timestamps in the DB always, on the page on hover**, exactly as asked.

## 5. Build order

1. `source` registry from the dossiers (extract the 292 URLs, dedupe, classify, first archive
   pass), the fetch-normalise-hash-diff watcher, `source_version` on disk and in SQL, Wayback
   push, the quote check. Tests on the normaliser, hasher, differ and quote matcher with real
   PDFs from the dossiers.
2. `claim` table and the assisted extraction pass: for each dossier field, the quote and locator
   in its cited document; the chips on cards and dossiers; API routes `/api/claims`, `/api/sources`,
   `/api/changes`.
3. On-chain watcher hourly (extension state, authorities, treasury balances), change events,
   Telegram summary, outcome check.
4. Watch page and the monitor's change log switched to change events.
5. LLM judge on document diffs, with cost accounting and small-batch trial first.
