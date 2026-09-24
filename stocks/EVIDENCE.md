# Evidence and source watching

RWA Sonar does three things: it reads the same data from a specific angle, it surfaces facts buried
in prospectuses, terms of service and small print, and **it watches the sources**, so that a change in a
treasury wallet, a float, a venue list, a legal term, a smart-contract toggle or an authority key
is caught within a day and shown with its evidence. This document is the design for the watching
and for the "extreme quotation" (an exact quote behind every claim) that the first two need.

Starting point (2026-09-17): 12 issuer dossiers in `stocks/data/issuers/` cite 292 distinct URLs
(18 PDFs, 172 `documents[]` entries), findings and incidents carry a `source`, but only 12 of 108
structured dossier fields name their source inline, and no source is fetched again after the day
it was read. On-chain facts are refetched by the 6-hourly refresh and snapshotted daily, but a
change shows only as a diff of numbers, with no event and no evidence attached.

## 1. Data model (schema `sonar`)

| Table | One row per | Key columns |
|---|---|---|
| `source` | URL we rely on | `id`, `url`, `kind` (pdf, html, api, onchain), `title`, `issuer_slug`, `first_seen_at`, `last_checked_at`, `last_changed_at`, `check_every` (interval), `archive_url` (Wayback), `status` (ok, changed, gone, blocked, reachable-unverified), `content_hash`, `error` |
| `source_version` | fetch that produced new content | `source_id`, `fetched_at`, `content_hash`, `bytes`, `text_path` (normalised text on disk, gitignored), `raw_path`, `diff_summary`, `diff_severity`, `diff_method` (none, quote-lost, keyword, llm) |
| `claim` | one fact we assert | `id`, `subject_type` (issuer, token), `subject_id`, `field` (dotted path, e.g. `redemption.rails`), `value` (the structured value), `quote` (the exact words from the source), `source_id`, `locator` (page, section, anchor, on-chain account+field), `recorded_at`, `last_checked_at`, `last_confirmed_at`, `status` (confirmed, changed, source-gone, unverified), `method` (manual, extracted, onchain) |
| `change_event` | detected change | `id`, `detected_at`, `kind` (see §3), `subject_type`, `subject_id`, `field`, `before`, `after`, `severity` (info, caution, warning, critical), `evidence` (source_version ids, tx signatures, snapshot dates), `summary`, `acknowledged_at` |

`sonar.claim.active` separates the current dossier claim set from retained internal history. Editing
a quote or URL creates a new content-addressed claim id; the previous row stays in Postgres for
audit but becomes inactive. Public claim queries and the review queue include active rows only, so
RWA Sonar's own research corrections never reappear as current evidence.

Rules: `recorded_at` is when we wrote the claim, `last_checked_at` when a watcher last looked,
`last_confirmed_at` when the quote was last found verbatim. A claim whose quote disappears from
its source is marked `changed` (it is not marked false), a change event is raised, and a human decides.

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
   new text; presentation-only XML/Markdown syntax is ignored. If a reader-facing page is
   client-rendered, the dossier may explicitly name its same-publisher machine-readable companion
   in `quoteVerificationSources`; the public citation remains the readable page and the watcher
   checks the companion. It never searches unrelated issuer pages opportunistically. A lost quote
   is `warning` on that claim, no model needed;
   - **keyword diff**: changed lines containing redemption, fee, custody, custodian, jurisdiction,
     governing law, freeze, pause, clawback, burn, delegate, authority, terminate, suspend,
     eligibility, lock-up, dividend → `caution`;
   - **LLM judge** on the remaining diff (batch API, cost recorded per call as the workspace
     rules require): "does this change alter what a holder owns, can do, or can be done to
     them?" → severity + one-paragraph summary; never the only signal, always shown as "model
   assessment" with the diff beside it.
   Direct Solana RPC endpoints and explorer account/transaction links remain provenance locators,
   but are excluded from document hashing and quote matching. Their state is refreshed by the
   on-chain watcher; treating an RPC endpoint's generic HTTP body as the cited account response
   creates false quote-loss alerts. Parameterised API families cited without the parameters needed
   for a valid request are excluded too, while exact query URLs remain watchable.
4. **On-chain watcher** (hourly for keys and toggles, daily for holdings): for every mint the
   Token-2022 extension state (pausable/paused, default-account-state, permanent delegate,
   transfer-fee config, transfer-hook program, scaled-UI multiplier, metadata pointer/URI) and the
   mint/freeze/update authorities; supply; the labelled treasury and authority wallets' balances
   (top-20 holders already daily); the venue list per mint; the metadata JSON at `metadataUri`
   (it is a document too, watched by 1). Each is a `claim` with `method = onchain` and a locator
   (account, field), so a change is a change event with before/after and the slot/signature.
5. **Market watcher** (from the existing snapshots): float and supply moves, liquidity drops,
   venue added/removed, volume regime change, top-1 holder change, multiplier (rebase), all already
   in `lib/changes.mjs`; they become `change_event` rows with the snapshot dates as evidence.
6. **DeFi protocol watcher** (daily): compare each exact token address + protocol integration in
   `stocks/data/history/<date>/defi.json`; report support added/removed, configured maximum LTV
   changes, a live market becoming inactive, and deposited collateral value falling at least 25%
   from a prior value of at least $100,000. The first observation is stored as a baseline and raises no event.
   Published pool, reserve, vault, bank, config and oracle accounts are separately corroborated by
   batched Solana reads. Account existence supports the technical evidence; it does not prove the
   legal claim, economic value or that every advertised operation will succeed.
7. **Alerts**: the central alerts-server-telegram monitor carries findings from hourly checks and
   sends one consolidated 06:00 UTC summary. The RWA protocol watch contributes compact notice
   lines from the 00:17 refresh. Saved comparison/focused watches are re-evaluated by the refresh,
   but their contents never enter the operator's Telegram summary. Personal delivery remains
   disabled until a watch can be bound to a verified private channel.

### 2.8 Pages a plain fetch cannot read (2026-09-23)

- **Client-rendered Next.js pages.** When the markup gives a short text (< 600 chars) and the
  page carries `self.__next_f.push([1,"…"])` flight payloads, `lib/nextflight.mjs` decodes the
  stream, splices `T` text rows in where the tree references them, and keeps only element
  `children` (no props, router state, `$L…` references or chunk ids). The checkpoint records
  `via: next-flight`. ventuals.com/terms went from 23 characters (the page title) to 31,086, and
  its 28 dossier quotes are now checked (all found); before, a 304 on the stored title meant they
  were never checked at all. HTML extraction is now normaliser generation 2: each HTML source is
  fetched once without its etag and the baseline is refreshed without a change event.
- **Hosts that refuse us** (401/403 or a bot wall; not 429, 400 or JavaScript-only pages): the
  newest 200 capture from the Wayback CDX API, fetched as `…/web/<ts>id_/<url>` (2 s pacing, at
  most 40 per run). The result is `ok`/`changed` against the stored hash, but with `via: wayback`,
  `captureTimestamp` and `captureUrl` in the checkpoint and state. `http_status` stays the live
  403; `sonar.source` and `sonar.source_version` carry `read_via = 'wayback'` and `capture_at`
  (the CDX timestamp of the capture, never our fetch time; db/2026-09-23-sonar-source-provenance.sql),
  and `error` stays null because a successful archived read is not a fetch error. The run log and
  checkpoint `reason` still read "live fetch blocked (…); text read from the Wayback capture of
  <date> — <url>", and watch.html shows "read from the Wayback capture of <date>" on the source
  row. Change events carry the capture fields in `evidence`, and their summaries and version diff
  summaries start with `[Wayback capture of <date>; live page refused us]`. `read_via` records
  every reader: html, next-flight, pdf, api, binary, notion, drive, wayback, and `live` for a 304
  with no earlier reader on record.
- **Quote check reads the unfiltered text** (2026-09-23). The churn filter drops a price alone on
  its line (`$275` on republic.com/rspax), so quotes containing such an amount read as lost. The
  quote check now reads the same extraction without the churn filter (`normaliseLines`
  `keepChurn`); the hash and diff keep the filtered text. A read that produced no fresh text (304,
  same Wayback capture) re-reads the stored raw copy for it, trusted only when the re-read
  reproduces the stored hash.
- **Blocked sources are not checkable** (2026-09-23). A quote whose source is `blocked` gets no
  verdict: it is counted as "not checkable" in the run summary, never lost, and its claim row is
  left untouched. A 304 over a stored copy that is itself a JavaScript shell (app.ventuals.com/sunset,
  stored as the 8 characters "Ventuals") is `blocked` too, as its live read would be.
- **Browser-UA-only hosts** needed no change. Every 401/403 source answers a bare
  `User-Agent`-only fetch exactly as it answers the watcher's full header set.
- **Same-publisher companion APIs** (`lib/companions.mjs`). Three hosts serve a shell to a script
  and the same document to their own API: npmjs.com (a Cloudflare 403) is read from
  `registry.npmjs.org/<package>`, crates.io (an empty Ember page) from `crates.io/api/v1/crates/<name>`,
  and securitize.io's `/disclosure/<slug>` and `/disclosure-library` pages (a React app) from the
  Builder.io content API, with the public key Securitize's own bundle ships to every browser (a
  401/403 there means Securitize rotated the key). Used only when the live page refused us or
  rendered nothing (never after a 404 or 429), and tried before Wayback because it gives the
  publisher's current words. The companion JSON is reduced to what a reader of the page sees
  (description, versions, README, text blocks, links), without download counters or `updated_at`.
  The source keeps the cited URL; state carries `companionUrl`, `read_via = 'companion'`, and the
  reason reads "live page unreadable (…); text read from the publisher's <reader> companion — <url>".
  These pages are fetched without an etag, since one would describe the shell. Unlike
  `quoteVerificationSources` (§2.3), which a dossier declares per citation, this is a fixed host
  table.
- **More refusals go to Wayback.** Vercel's "Security Checkpoint" page, served as HTTP 429
  (kalshi.com, data.chain.link), counts as a bot wall: no backoff, straight to the capture. So does an
  expired TLS certificate (remora.markets): certificate checks stay on, and an archived capture is
  the only copy left to read.
- **Wayback index down.** When the CDX query fails and the text we already stand on is a capture,
  the source stays `ok` on that capture ("Wayback index unavailable (…); newer captures not checked
  — standing on the capture read last run") instead of becoming `blocked` for the day. The run log and
  stats count these as `stoodOnPrevious`.
- **archive.today is linked, never read.** When Wayback holds no 200 capture, the archive.today
  Memento timemap (`archive.ph/timemap/<url>`, `lib/archive-today.mjs`) is asked for its newest
  memento. The memento pages sit behind a reCAPTCHA for scripted clients (HTTP 429 "One more
  step"), and the watcher does not solve CAPTCHAs, so the source stays `blocked`. The memento's URL
  and its own datetime go into the reason and state (`archiveTodayUrl`), and `archive_url` stays
  empty so a later `--archive` pass still asks Wayback for a capture.
- **Stale captures are refreshed.** With `--archive` (the daily production run), a source read from
  a capture more than 7 days old (`WAYBACK_STALE_DAYS`) is sent to Save Page Now, and the next
  run reads the new capture. Before this, businesswire.com was being watched through a capture of
  2026-06-08, and every daily `ok` re-confirmed a page three months old.
- **Cited Wayback links are read raw.** A source that is itself a `web.archive.org/web/<ts>/<url>`
  link is fetched as the `…/web/<ts>id_/<url>` capture. Fetched as cited, the Wayback toolbar
  ("About this capture", TIMESTAMPS) came with it and was recorded as a document change (event 2056,
  which the change judge flagged).
- **An API's error answer can be the evidence.** An exact query URL whose cited response is a
  400/422 JSON body is read like any document. For example, Remora cites Jupiter's
  `/swap/v1/quote?inputMint=…` answering `{"error":"The token … is not tradable","errorCode":"TOKEN_NOT_TRADABLE"}`.
  The outcome reads "same hash (http-400 JSON answer is the cited response)" or "new hash (…)", and
  the source is not marked `blocked`. Only a JSON body counts, and only on a URL with its query. A bare route family
  (`…/swap/v1/quote`, a Sanity `/data/query/<dataset>` without `query`, a Drive `download` without
  `id`) only answers "missing parameter", which proves nothing. `isDocumentWatchable` keeps it out
  of the watch, as §2.3 already did for Raydium's bare `/pools/info/mint`.
- **What-if answers are verified like claims.** `whatIf[]` quotes go through the same
  `quoteVerificationSources` mapping as `claims[]` (`dossierQuotes` in `lib/watch.mjs`), so an
  answer citing a client-rendered page is checked against its declared companion.
- **`--only-blocked` re-reads.** Selects only the sources whose stored state says the live host did
  not give us the document last time: `blocked`, read from a Wayback capture, or read through a
  companion. It never reuses the day's checkpoint entries for them, though the checkpoint is kept
  and added to. It writes `.last-source-watch-stats-only-blocked.json` (scoped like `--only`/`--limit`),
  never the full-run heartbeat. With `--no-db` it measures what a fallback change buys without
  re-fetching the other ~500 sources. Measured 2026-09-23: blocked sources went from 41 to 14.
- **A refusal nothing quotes is `reachable-unverified`** (2026-09-24, `quotelessRefusal` in
  `lib/watch.mjs`, db/2026-09-24-sonar-source-reachable.sql). A homepage in a `website` field, a
  listing in a what-if's `searched` trail, or a Dropbox folder cited as "the series" has no quote to
  check. Its citation needs only that the host still answers at that address. When such a source
  is refused or renders nothing but the host answered with an HTTP status, it is
  `reachable-unverified`, not `blocked`. A 404/410 still makes it `gone`. With no HTTP answer at
  all (timeout, expired certificate) it stays `blocked`. As soon as a quote relies on the source,
  the same refusal is `blocked` again.
- **Solscan transaction pages are read from the chain** (2026-09-24). `solscan.io/tx/<sig>`
  answers scripts with a 403 and has no Wayback captures. Its companion is Solana RPC
  `getTransaction` (jsonParsed, finalized, through `SOLANA_RPC_URL`; the keyed URL is never logged
  or stored). `solanaTxText` in `lib/companions.mjs` renders it in a fixed order: identity,
  verbatim program logs, decoded instructions, token balance changes. Quotes on these claims quote
  that rendering, with `…` between fragments. They do not quote Solscan's UI wording.
- **A WordPress page published empty is read, not called a JavaScript shell** (2026-09-24,
  `emptyPublishedPage`). Remora's 2025 Whitepaper, Terms, Privacy and KYC pages are theme markup
  around an empty `page-content` div. The emptiness is what the dossier cites.
- **Four reader fixes** (2026-09-24, found while re-quoting lost quotes):
  1. A body labelled `application/octet-stream` that is valid UTF-8 is read as text
     (`looksLikeText`). Securitize serves its DRS broker instructions `.md` that way.
  2. A `contradicted-corrected` claim whose note says `SUPERSEDED`, with a confirmed successor on
     the same field and URL, leaves the watch, as a `changed` one already did. Its status is kept.
  3. The quote reading keeps `<button>` text and appends inline `<script>` payloads. The hashed
     reading has neither. Superstate's asset page ships its holdings as a SvelteKit data object.
  4. Validators (etag, last-modified) are stored only from a 2xx body (`responseValidators`), and
     are sent back only with that proof (`validatorStatus`). A Vercel 404 page's etag had been
     stored, and the conditional GET was answered 304, so a dead PreStocks bundle read as `ok`.
     A state entry from before this rule gets one unconditional GET.
- **An incomplete TLS chain is `blocked`**, not `error`: `tls: incomplete certificate chain`.
  www.cysec.gov.cy omits its intermediate certificate. Browsers fetch the intermediate themselves,
  Node does not.

### 2.9 Scheduled beside the watchers (2026-09-23)

- **Change judge** (`stocks/judge-changes.mjs`, `lib/change-judge.mjs`; PM2 `rwa-judge`, 06:47
  UTC). This is the §2.3 LLM judge. Once a day it sends one Message Batches batch of the 10 newest unjudged
  `legal-term`/`document-gone`/`quote-lost` changes, one item per change (events with the same
  source and content hash are judged once), to `claude-sonnet-5`. It asks whether the change
  alters what a holder owns, can do, or can have done to them. Each answer goes to
  `sonar.change_judgment` with its tokens and `cost_usd`, and to the shared `llm-cost` ledger. An answer whose
  `quotedChange` fragments are not verbatim in the change text, or that says a change is material
  without quoting it, is stored `invalid` and never shown as text. The batch id is checkpointed
  before polling, so the next run resumes it and does not pay twice. A batch still open after 12 h
  (`STALLED_BATCH_MS`) is canceled (unprocessed requests are not billed), and that run judges
  directly. `--direct` does the same by hand: online calls at full price, at most 10, stored with
  `batch_id = 'direct'`. More than 25 items needs `--allow-large`. The second batch, 10 items,
  finished in about 45 minutes and cost $0.049. The verdict is shown as "model assessment" beside
  the diff and never decides what is included.
- **Redemption observer** (`stocks/observe-redemptions.mjs`; PM2 `rwa-redemptions`, 23:05 UTC).
  It reads new transactions since each address's checkpoint: Ondo GM `redeem_for_usdc` burns;
  xStocks deposits to the redemption address, their sweep and the treasury's USDC payout inside a
  180 s window (linked by inference); and Superstate burn-to-book-entry conversions. It classifies
  them and folds them into `stocks/data/redemption-observations.json`, which the 00:17 refresh builds
  into each issuer's redemption block. Reads are oldest-first, at most 1,500 `getTransaction` calls
  per address per run. Coverage extends only over what was read, and an unread backlog is carried
  over to the next run. A failed or partial scan is recorded as `scan-failed`/partial, never as "no redemptions". PreStocks and
  Tessera are recorded as not observable, with a 1–3 call tripwire. Telegram is off; its
  `noticeLines` reach the morning digest through the central monitor. An observed completion is
  what §7 calls a demonstrated redemption; without one the label stays `documented-process`.

## 3. Change kinds

`legal-term` (document diff touching a claim or a keyword), `document-gone` (404, replaced,
domain lapsed), `authority-key` (mint, freeze, delegate, hook, update authority rotated),
`extension-toggle` (paused, fee bps, hook program, default state, delegate set/unset),
`rebase` (scaled-UI multiplier), `supply` (mint/burn beyond a threshold), `treasury` (labelled
wallet balance move), `holder-concentration`, `venue` (pool or market listed/delisted),
`float`, `liquidity`, `metadata` (token metadata URI content), `status` (issuer live/defunct).
`litigation` (stocks/watch-caselaw.mjs: a new CourtListener opinion or RECAP docket, a new SEC
litigation release or administrative proceeding, or a new docket entry naming an issuer's legal
entity or party. It is a candidate for review and never sets a what-if answer to `litigated`).

## 4. Presentation

- **Every claim gets a chip.** Structured fields on dossiers and cards render the value plus a
  small "§" chip; hover or tap shows: the quote, the source title with link, the locator, the
  archived copy link, `recorded` and `last checked` timestamps, and `changed on <date>` in warning
  colour when the source moved after the claim. The chip is the only visual change.
- **A conflict gets a side-by-side discrepancy record.** `discrepancies[]`
  contains a stable `id`, title, severity, observation date, impact, and two opposing
  sides: `claim` and `reality`. Each side has its own plain-language text and one or more
  `{label, url, locator, accessedAt}` sources. The issuer card shows a compact count above the
  fold; opening it shows both propositions and both source trails together. This is reserved for
  a present conflict between published material and stronger/later documentary, code, API or
  on-chain evidence. A historical correction to our own analysis remains
  `contradicted-corrected` in the research dossier and internal claim table, but publication
  normalises it to confirmed current evidence and removes the correction note. It is never a
  public warning or issuer discrepancy.
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
fails**. There is one shared catalogue, `stocks/data/trust-chain.json`, so every issuer is measured against
the same list and anything missing shows up as missing: **13 actors**, **9 rights flows**, **38 failure
modes**. The logic is one file, `stocks/lib/trustchain.js` (UMD, so the page, the builders and jest
all load the same copy) with `trustchain.mjs` adding the catalogue for the ESM callers.

### 6.1 The chain

`buildChain(issuer, catalogue)` turns a dossier (or a built issuer record) into:

- **nodes**: one per catalogue actor, filled from `parties.*` by each party's own `role`. An actor
  nobody fills still appears with `parties: []`, because the empty role is itself the finding: no transfer
  agent means the token is not the share, no security agent means holders are unsecured. One
  exception: for `legalForm === 'registered-share'` the token
  issuer **is** the company, so when `parties.tokenIssuers` is empty the security issuers fill that
  role.
- **links**: one per catalogue flow, each carrying the fields it rests on (`{field, value,
  claimStatus}`, with a `null` status where nothing is claimed, so a missing claim stays distinct from a weak one),
  a one-line plain-text `summary` assembled from those values only, and **two independent grades**.

### 6.2 The two link grades

Neither is ever typed by hand; both are computed from the dossier's claims, so a link cannot look
stronger than its evidence. Colour is `evidence`, line style is `verification`.

| `evidence` | from the best claim status across the flow's fields |
|---|---|
| `documented` | a `confirmed` claim — the source's own words were read |
| `inferred` | an `inference` claim — our reading of the structure |
| `asserted` | `unverified` / `changed` / `source-gone` |
| `unknown` | no claim touches any field the link rests on |

| `verification` | in this precedence |
|---|---|
| `onchain` | a claim read off the ledger (`method === 'onchain'`, i.e. an `rpc:` / `tx ` locator), **or** the flow rests on chain state (`keyGovernance.*`, `knownExtensions`, `tokenProgram`, `transferRestrictions.mechanism`) and that field's text or `keyGovernance.evidence` says "on-chain" |
| `attested` | the flow runs through the `attestor` or `custodian` **and** `custodyVerification.type` is a third-party type, **or** a claim on its fields cites a regulator's own host (`REGULATOR_HOSTS`) |
| `self-reported` | there are claims, but none of them qualifies above |
| `none` | no claim touches any of the flow's fields |

`issuer-statement` is **not** a third-party type: it is strength 1 in `lib/grade.mjs`
because it is the issuer's own word, and grading it `attested` would make `attested` meaningless.
`onchain` can hold with no claims at all (the reading is recorded in `keyGovernance.evidence`), so
`verification: onchain` beside `evidence: unknown` is a valid combination.

### 6.3 The what-if answers

Each dossier answers the 38 modes in its own `whatIf[]` (schema in the catalogue's `whatIfSchema`),
with the same evidence fields as `claims[]` (quote, url, locator, `accessedAt`):

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
`not-applicable`, where nothing was read and a `note` is required instead). The loader runs
it over every dossier and **throws, so a research pass is never half-loaded**, `stocks/trustchain.test.js`
runs it over every real dossier in the suite, and the table's CHECK constraints are the final check.
`validateCatalogue()` does the same for the catalogue: duplicate ids, dangling actor/flow/mode
cross-references, and a mode no flow carries (which the chain could never reach).

### 6.4 Where it lands

- `stocks-issuers.json`: every issuer record gains `chain` (nodes + graded links) and
  `whatIfCounts` (the six counts). The full answers (prose with quotes and case citations) are
  **not** inlined; the API serves them. The record also gained `parties` and
  `knownExtensions`, so the chain can be rebuilt from the record alone, as
  `/api/issuers/:slug/chain` does.
- `sonar.failure_mode` (the catalogue, `ord` = its position in the file, which is the display
  order) and `sonar.what_if` (`id` = `<issuer_slug>:<mode>`), loaded by
  `stocks/load-db.mjs --only=whatif`. A mode with no answer has **no row**; an answer a dossier no
  longer offers is **deleted**, because unlike a content-addressed claim the only way a
  `<issuer>:<mode>` row stops being offered is the researcher having withdrawn it.
- The source registry: every `whatIf[].url`, `whatIf[].cases[].url` and `whatIf[].searched[]` URL
  enters `sonar.source` and is watched and archived like any other, labelled by its failure **mode**
  (`xstocks-backed:whatIf[account-frozen].searched[0]`). The array index is not used because it
  shifts whenever an answer is inserted above it.

### 6.5 Routes

| Route | Returns |
|---|---|
| `GET /api/failure-modes` | the 38 questions in catalogue order, each with its actor and flow labels and per-status counts across issuers, plus `missing` (issuers that have not answered it) |
| `GET /api/what-if?mode=&issuer=&status=&actor=&flow=&sort=&order=&limit=&offset=` | the answers, joined to their mode's question and actor and to their source; repeated parameters are OR |
| `GET /api/issuers/:slug/what-if` | one issuer's whole answer sheet: **all 38 modes** in catalogue order, unanswered ones with `status: "missing"` |
| `GET /api/issuers/:slug/chain` | the chain rebuilt from the stored `record` jsonb with the very same library the builder used, so the API and the built file can never show a differently graded chain |

## 7. Technology + legal templates

`stocks/lib/legal-templates.mjs` groups issuer-level research by the unit the assets
share: **issuer programme + observed control recipe**. The join is exact and covers every
current mint once. The output records the inheriting addresses and a separate exceptions list; a
different ticker or market alone does not make an asset an exception to its template.

Evidence is recorded along several separate dimensions:

- six confidence facets (ownership, custody/insolvency, eligibility, redemption, corporate
  actions and technical control), each naming the strongest source class and the number of claims;
- a source register with authority, version, effective date, check date and archive URL as distinct
  fields; an unknown version/effective date stays `null` and is displayed as **not structured**;
- a fixed precedence rule: mandatory law/registers, product-specific operative documents, base
  prospectus/programme terms, on-chain state for technical capability, operating documents and
  attestations, then marketing/third-party descriptions;
- every unresolved external source change preserved beside the current conclusion; and
- redemption evidence labelled `documented-process` unless an actual completed transaction is
  recorded. A promise, UI route or operational manual is not a demonstrated redemption.

The insolvency view never treats a word in the documents as an outcome. “Trust”, “segregated”, “first
priority” and “bankruptcy remote” are displayed with the holder's standing, enforcement agent,
commingling, perfection/priority and lien/set-off evidence found in the dossier; absent evidence is
shown as absent. No such label is presented as a litigated insolvency outcome unless the underlying
claim cites one.
