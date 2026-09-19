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
6. **DeFi protocol watcher** (daily): compare each exact token address + protocol integration in
   `stocks/data/history/<date>/defi.json`; report support added/removed, configured maximum LTV
   changes, a live market becoming inactive, and deposited collateral value falling at least 25%
   from a prior value of at least $100,000. The first observation is a baseline, not an event.
   Published pool, reserve, vault, bank, config and oracle accounts are separately corroborated by
   batched Solana reads. Account existence supports the technical evidence; it does not prove the
   legal claim, economic value or that every advertised operation will succeed.
7. **Alerts**: the central alerts-server-telegram monitor carries findings from hourly checks and
   sends one consolidated 06:00 UTC summary. The RWA protocol watch contributes compact notice
   lines from the 00:17 refresh; later six-hourly refreshes never create extra Telegram messages.

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

## 6. Trust chain and what-if

The evidence model above answers "who said this?". The trust chain answers the two questions a
holder actually has: **who stands between me and the company**, and **what happens when one of them
fails**. One shared catalogue, `stocks/data/trust-chain.json`, so every issuer is measured against
the same list and a gap is visible AS a gap: **13 actors**, **9 rights flows**, **38 failure
modes**. The logic is one file, `stocks/lib/trustchain.js` (UMD, so the page, the builders and jest
all load the same copy) with `trustchain.mjs` adding the catalogue for the ESM callers.

### 6.1 The chain

`buildChain(issuer, catalogue)` turns a dossier (or a built issuer record) into:

- **nodes** — one per catalogue actor, filled from `parties.*` by each party's own `role`. An actor
  nobody fills still appears with `parties: []`, because an empty seat is the finding: no transfer
  agent means the token is not the share, no security agent means holders are unsecured. One
  exception, stated as a rule rather than a fudge: for `legalForm === 'registered-share'` the token
  issuer **is** the company, so when `parties.tokenIssuers` is empty the security issuers fill that
  seat.
- **links** — one per catalogue flow, each carrying the fields it rests on (`{field, value,
  claimStatus}`, a `null` status where nothing is claimed — a missing claim is not a weak claim),
  a one-line plain-text `summary` assembled from those values only, and **two independent grades**.

### 6.2 The two link grades

Neither is ever typed by hand; both are computed from the dossier's claims, so a link cannot look
firmer than the evidence under it. Colour is `evidence`, line style is `verification`.

| `evidence` | from the best claim status across the flow's fields |
|---|---|
| `documented` | a `confirmed` claim — the source's own words were read |
| `inferred` | an `inference` claim — our reading of the structure |
| `asserted` | `unverified` / `contradicted-corrected` / `changed` / `source-gone` |
| `unknown` | no claim touches any field the link rests on |

| `verification` | in this precedence |
|---|---|
| `onchain` | a claim read off the ledger (`method === 'onchain'`, i.e. an `rpc:` / `tx ` locator), **or** the flow rests on chain state (`keyGovernance.*`, `knownExtensions`, `tokenProgram`, `transferRestrictions.mechanism`) and that field's text or `keyGovernance.evidence` says "on-chain" |
| `attested` | the flow runs through the `attestor` or `custodian` **and** `custodyVerification.type` is a third-party type, **or** a claim on its fields cites a regulator's own host (`REGULATOR_HOSTS`) |
| `self-reported` | there are claims, but none of them qualifies above |
| `none` | no claim touches any of the flow's fields |

`issuer-statement` is deliberately **not** a third-party type: it is strength 1 in `lib/grade.mjs`
because it is the issuer's own word, and grading that `attested` would make the word mean nothing.
`onchain` can hold with no claims at all (the reading is recorded in `keyGovernance.evidence`), so
`verification: onchain` beside `evidence: unknown` is a real and meaningful pair.

### 6.3 The what-if answers

Each dossier answers the 38 modes in its own `whatIf[]` (schema in the catalogue's `whatIfSchema`),
with the same evidence discipline as `claims[]` — quote, url, locator, `accessedAt`:

| status | means |
|---|---|
| `documented` | the issuer's or regulator's own document addresses this case; `quote` holds the words |
| `inferred` | the documents do not address it but the structure implies the answer, labelled as our reading |
| `litigated` | a court, tribunal or regulator decided this or a materially identical case; `cases[]` cites it |
| `unknown` | we looked and the documents do not say; `searched[]` records where, so the gap itself is evidence |
| `not-applicable` | the case cannot arise for this structure; `note` says why |
| `missing` | **not a stored status** — the API's name for a mode with no answer row at all |

`validateWhatIf()` refuses an answer that claims more than it shows: an unknown or duplicate mode
id, a bad status, a `documented`/`litigated` with neither quote nor url, a `litigated` with no
`cases[]` (or a case with no name or url), an `unknown` with an empty `searched[]`, a missing
`outcome`, a missing or unparseable `accessedAt` (required on every status except
`not-applicable`, the one answer where nothing was read — that one needs a `note`). The loader runs
it over every dossier and **throws rather than half-loading a research pass**, `stocks/trustchain.test.js`
runs it over every real dossier in the suite, and the table's CHECK constraints are the last line.
`validateCatalogue()` does the same for the catalogue: duplicate ids, dangling actor/flow/mode
cross-references, and a mode no flow carries (which the chain could never reach).

### 6.4 Where it lands

- `stocks-issuers.json`: every issuer record gains `chain` (nodes + graded links) and
  `whatIfCounts` (the six counts). The full answers are **not** inlined — they are prose with
  quotes and case citations, and the API serves them. The record also gained `parties` and
  `knownExtensions`, because the chain must be rebuildable from the record alone, which is exactly
  what `/api/issuers/:slug/chain` does.
- `sonar.failure_mode` (the catalogue, `ord` = its position in the file, which is the display
  order) and `sonar.what_if` (`id` = `<issuer_slug>:<mode>`), loaded by
  `stocks/load-db.mjs --only=whatif`. A mode with no answer has **no row**; an answer a dossier no
  longer offers is **deleted**, because unlike a content-addressed claim the only way a
  `<issuer>:<mode>` row stops being offered is the researcher having withdrawn it.
- The source registry: every `whatIf[].url`, `whatIf[].cases[].url` and `whatIf[].searched[]` URL
  enters `sonar.source` and is watched and archived like any other, labelled by its failure **mode**
  (`xstocks-backed:whatIf[account-frozen].searched[0]`) rather than its array index, which moves
  whenever an answer is inserted above it.

### 6.5 Routes

| Route | Returns |
|---|---|
| `GET /api/failure-modes` | the 38 questions in catalogue order, each with its actor and flow labels and per-status counts across issuers, plus `missing` (issuers that have not answered it) |
| `GET /api/what-if?mode=&issuer=&status=&actor=&flow=&sort=&order=&limit=&offset=` | the answers, joined to their mode's question and actor and to their source; repeated parameters are OR |
| `GET /api/issuers/:slug/what-if` | one issuer's whole answer sheet: **all 38 modes** in catalogue order, unanswered ones with `status: "missing"` |
| `GET /api/issuers/:slug/chain` | the chain rebuilt from the stored `record` jsonb with the very same library the builder used, so the API and the built file can never show a differently graded chain |

## 7. Technology + legal templates

`stocks/lib/legal-templates.mjs` lifts issuer-level research into the reusable unit the assets
actually share: **issuer programme + observed control recipe**. The join is exact and covers every
current mint once. The output records the inheriting addresses and a separate exceptions list; an
asset does not override its template merely because its ticker or market differs.

The evidence treatment is deliberately multidimensional:

- six confidence facets (ownership, custody/insolvency, eligibility, redemption, corporate
  actions and technical control), each naming the strongest source class and the number of claims;
- a source register with authority, version, effective date, check date and archive URL as distinct
  fields—unknown version/effective date stays `null` and is displayed as **not structured**;
- a fixed precedence rule: mandatory law/registers, product-specific operative documents, base
  prospectus/programme terms, on-chain state for technical capability, operating documents and
  attestations, then marketing/third-party descriptions;
- every corrected/conflicting claim preserved beside the current conclusion; and
- redemption evidence labelled `documented-process` unless an actual completed transaction is
  recorded. A promise, UI route or operational manual is not a demonstrated redemption.

The insolvency view never converts vocabulary into a result. “Trust”, “segregated”, “first
priority” and “bankruptcy remote” are displayed with the holder's standing, enforcement agent,
commingling, perfection/priority and lien/set-off evidence found in the dossier; absent evidence is
shown as absent. No such label is presented as a litigated insolvency outcome unless the underlying
claim cites one.
