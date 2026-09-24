# RWA Sonar — tokenized stocks on Solana, explained

> **The ticker is familiar. The token is mysterious.**

Live product: [rwasonar.com](https://rwasonar.com/) · X: [@RWASonar](https://x.com/RWASonar) ·
Pitch: [rwasonar.com/pitch/](https://rwasonar.com/pitch/)

RWA Sonar reads the legal documents and the Solana chain behind every tokenized stock it can find
and answers five questions for each exact token address: **what the holder actually owns, who can
intervene, how to exit, where it is used in DeFi, and what changed**. Every answer links to the words
or the transaction it rests on, with the source, locator, date read and, where possible, an
archived copy.

The idea comes from [L2BEAT](https://l2beat.com/faq): list the trust assumptions, and show where
published claims differ from what can be observed. For tokenized stocks the smart contract is only
part of the picture, so the analysis also covers issuers, custodians, transfer agents, legal terms
and courts.

**Try it:** [compare Apple's wrappers](https://rwasonar.com/stocks.html?view=compare&compare=AAPL) ·
[who holds the keys](https://rwasonar.com/powers.html) ·
[flows and float](https://rwasonar.com/flows.html) ·
[exit routes](https://rwasonar.com/exits.html) ·
[what if…](https://rwasonar.com/whatif.html) ·
[this week](https://rwasonar.com/weekly/latest.html) ·
[a token report (NVDAx)](https://rwasonar.com/cards/NVDAx.html)

## For judges

- **Live:** <https://rwasonar.com/> (the jobs run on the server; the site rebuilds every 6 hours and
  the latest-events box on the home page reads the live API). **Pitch deck:** <https://rwasonar.com/pitch/>.
- **A three-minute route:**
  1. [Compare Apple's tokens](https://rwasonar.com/stocks.html?view=compare&compare=AAPL): AAPLx
     and AAPLon share a ticker but differ in what you own, who controls the token and where you can exit.
  2. [Who holds the keys](https://rwasonar.com/powers.html): each issuer's power to freeze, move,
     burn, mint, pause, rebase or charge fees, and who holds it.
  3. [What if…](https://rwasonar.com/whatif.html), then a token's card such as
     [NVDAx](https://rwasonar.com/cards/NVDAx.html), and the home page's latest events.
- **Built during Stocklana:** the repository dates from 13 Feb 2026 as a broad RWA catalogue; `main`
  at `8f58030` (19 Aug 2026) is the pre-hackathon state, and every commit on this branch dates from
  16 Sep 2026 onwards. [`SUBMISSION.md`](SUBMISSION.md) has the form text and the full disclosure.
- **Run it:** `npm install && npm install --prefix api && npm start` (details under
  [Run locally](#run-locally)); `npm test` runs the fast headless suites.
- **Team:** Poglavar Svemira, solo ([@poglavars](https://x.com/poglavars) on X,
  [@svemirsky](https://t.me/svemirsky) on Telegram).

## The problem, in one example

Two tokens can both say "AAPL" and give their holders different things. AAPLx (xStocks) is a
tracker certificate whose mint the issuer can pause, freeze and claw back; AAPLon (Ondo) is a
structured note that can be paused and frozen but has no clawback. Neither makes the holder a
registered Apple shareholder.

Ask two issuers the same question, *what happens if my keys are stolen?*, and their documents answer
differently:

- **xStocks (Backed):** nothing comes back as of right. Under the prospectus neither the network nor
  the issuer can restore a lost key; the only replacement route is a Swiss court cancellation which
  the issuer itself calls "very challenging to achieve".
- **Superstate Opening Bell:** in a June 2025 letter to the SEC's Crypto Task Force, Superstate says
  its transfer agent "can reconstitute" tokens (burn them and credit new ones) once the loss and the
  holder's identity are confirmed. It is not promised, its Terms put hack risk on the holder, and its
  liability is capped.

## What the evidence has shown

Dated findings from the current data, each linked from the page named:

- **xStocks' power to move or burn any holder's tokens sits behind a 2-of-3 multisig with no time
  lock** (read 20 Sep 2026). The permanent delegate on every xStocks mint is a Squads v4 vault with
  threshold 2 of 3, time lock 0 and unnamed members. It has not been used on Solana: across all
  1,844 transactions touching it from 10 Jun 2025 to 18 Sep 2026, no transfer or burn names it as
  authority. ([powers.html](https://rwasonar.com/powers.html))
- **81.0% of priced xStocks supply sits in issuer wallets** (read 24 Sep 2026). Redeemed xStocks
  are not burned; the prospectus defines de-activation as a transfer back to the issuer. For the 99
  xStocks with a market price, $2.03B of $2.50B of supply was in issuer-attributed wallets. These
  include an inventory wallet the issuer itself excludes from its circulating figure. The
  resulting public float, about $475M, is an upper bound. ([flows.html](https://rwasonar.com/flows.html))
- **Loopscale's docs and the chain disagree** (23 Sep 2026). The docs call one key a co-signer that
  "cannot initiate actions on its own"; on chain it is the protocol admin and signs refinances
  alone. The docs describe a 3-of-5 upgrade multisig; the chain shows 4 of 7 voters and a 24-hour
  time lock. (the SECZ/Loopscale protocol dossier)
- **SECZ's controls come down to single keys.** Its pause authority is an ordinary keypair with no
  multisig or time lock, and both Securitize programmes that hold mint and freeze are upgradeable by
  one on-curve key. ([powers.html](https://rwasonar.com/powers.html),
  [issuer dossier](https://rwasonar.com/issuers/securitize.html))
- **Redemptions are observed on chain.** On 23 Sep 2026 the recurring scan read 218
  Ondo redemptions and 370 creations in the 17.9 hours it covered, and 244 xStocks de-activation
  deposits in 22.5 hours. ([flows.html](https://rwasonar.com/flows.html))

## Pages

The stable navigation is **Explore · Compare · Changes · Learn**; the analysis pages sit under the
**Research** menu. Every page family renders the same header (see UI roles below).

| Page | What it answers |
|---|---|
| [`/`](https://rwasonar.com/) | What RWA Sonar is, where to start, three sourced findings, what is watched and how often |
| [`/stocks.html`](https://rwasonar.com/stocks.html) | Stock-first search and comparison of every wrapper of one stock (one, two or many), issuer panels, claims-versus-reality conflicts, DeFi use, a private briefing and shareable table views |
| [`/cards/NVDAx.html`](https://rwasonar.com/cards/NVDAx.html) | One static, JavaScript-optional report per token, with its own social preview image |
| [`/issuers/`](https://rwasonar.com/issuers/xstocks-backed.html) | One dossier per issuer programme: claim, redemption (documented, operational, observed), controls, discrepancies, evidence, assets |
| [`/powers.html`](https://rwasonar.com/powers.html) | Who holds the keys: each issuer programme × seven powers (mint, freeze, move or burn, pause, rebase, transfer fee, upgrade), and whether one key, a multisig, a program, nobody or an unknown party holds each |
| [`/flows.html`](https://rwasonar.com/flows.html) | Daily creations and redemptions per issuer read from the chain, like ETF flows, with covered hours per day; xStocks public float |
| [`/tracking.html`](https://rwasonar.com/tracking.html) | Premium or discount of each wrapper to the underlying share, with US market-closed hours shaded; holder concentration against liquidity |
| [`/exits.html`](https://rwasonar.com/exits.html) | Exit routes per wrapper: DEX pool liquidity by venue, issuer redemption route and its evidence state, lending markets; a DeFi usage Sankey by proof stage |
| [`/whatif.html`](https://rwasonar.com/whatif.html) | Failure scenarios answered per issuer as documented, inferred, litigated or unknown, with a scoreboard of how many answers each issuer's documents support |
| [`/weekly/latest.html`](https://rwasonar.com/weekly/latest.html) | This week in tokenized stocks: material changes (model assessment), issuer/venue/protocol changes, new tokens, observed redemptions, new discrepancies |
| [`/watch.html`](https://rwasonar.com/watch.html) | The change feed, and saved watches on a token, issuer or protocol market with an optional private Telegram digest |
| `/protocols/` | Exact-token protocol dossiers: source listing, observed accounts, decoded configuration, docs-versus-chain discrepancies |
| [`/templates/`](https://rwasonar.com/templates/) | Reusable legal + control-recipe dossiers with ownership paths |
| [`/graph.html`](https://rwasonar.com/graph.html) | The parties behind each programme and how rights pass between them |
| [`/economics.html`](https://rwasonar.com/economics.html) | Fees charged to holders and compensation to other actors |
| [`/live.html`](https://rwasonar.com/live.html) | Decoded DEX trades, collected hourly on the server and served by our API |
| [`/monitor.html`](https://rwasonar.com/monitor.html) | Token health across four dimensions, snapshot and protocol changes |
| [`/review.html`](https://rwasonar.com/review.html) | Evidence gaps and unreviewed external changes, prioritised |
| [`/learn/`](https://rwasonar.com/learn/) | Plain-language guides to ownership, insolvency, redemption, issuer powers, oracles and DeFi custody |
| [`/methodology.html`](https://rwasonar.com/methodology.html) | Evidence rules, monitoring jobs, model-assessment policy, redemption and float definitions, discrepancy types, live collector health, blind spots |
| [`/pitch/`](https://rwasonar.com/pitch/) | A six-slide web deck |

The public JSON API (`/api/`) serves search, facets, paginated tokens and trades, per-token
history, issuers, claims, source changes, failure scenarios and saved watches. See
[`api/README.md`](api/README.md).

## UI roles

One element role, one look, on every page. The palette (`--rwa-*`, light and dark) and the role
classes live in [`app-shell.css`](app-shell.css), which every page links; page stylesheets alias the
palette in their own variable names and never copy it. [`site-header.test.js`](site-header.test.js)
fails when a page drifts.

| Role | Canonical style | Where |
|---|---|---|
| Site header | brand mark + "RWA Sonar", Explore · Compare · Changes · Learn, then the **Research** menu; muted links, current page ink and bold | `.app-header`, markup from `stocks/lib/site-nav.js` (`siteHeaderHtml`) |
| Theme switch | last item of the header row: 32px icon button (half circle Auto, sun Light, moon Dark), control-line border, muted, cobalt on hover; a click cycles Auto → Light → Dark, remembered per browser. Under 360px it moves to the end of the Research menu as "Theme: …" | `.theme-switch`; `theme.js`, loaded first in every `<head>`, sets `<html data-theme>`, which every dark rule keys on (no `prefers-color-scheme` queries) |
| Primary action | cobalt fill, `--rwa-on-accent` text, 8px radius, min 44px tall | `.button.button-primary` (on `<a>` or `<button>`) |
| Secondary action | panel fill, control-line border, ink text, cobalt on hover | `.button` |
| Filter chip / toggle, pressed | cobalt border, `--rwa-pressed-bg`, `--rwa-pressed-text`, weight 750 | `--rwa-pressed-*` in each page's `-active` / `[aria-pressed="true"]` rule |
| View tabs | selected tab filled with ink | `.workspace-tabs` (stocks); `assets.html` keeps folder tabs with a cobalt top edge |
| Text link | `--rwa-cobalt-dark`, underline offset .18em | `a` (per page, from the token) |
| "More →" link | cobalt-dark, weight ~780, no underline | section-heading links |
| Eyebrow | .75rem, 800, .12em tracking, uppercase, cobalt-dark | `.eyebrow` |
| Page title | Georgia 500, negative tracking | `h1` |
| Body text | Inter stack (`--rwa-font`) | `body` |
| Focus | 3px cobalt ring at 42%, 2px offset | `:focus-visible` (`--rwa-focus`) |
| Inputs | panel fill, control-line border, 8px radius, inherited font | per page |
| Status | good `--rwa-green` · caution `--rwa-amber` · warning `--sev-warning` · critical `--rwa-red` · unknown `--rwa-muted` | status pills and chips |
| Small coral text | `--rwa-coral-text` (plain `--rwa-coral` is decoration only: 3.4:1) | kickers on cards |
| Page column | `min(1180px, 100% − 40px)` (20px gutters), 12px gutters under 720px | `.app-header`, `main` |
| Footer | contact block | `site-contact.css` |

Deliberately different: the pitch deck (`/pitch/`) keeps its own dark stage and deck bar; charts,
the trust map and the dolphin art keep their own series colours; `assets.html` keeps a full-width
table layout; the generated pages without page scripts (issuers, templates, weekly, protocols) carry the same
Research menu without `nav-menus.js`, so it closes from its own summary only (their one script is
`theme.js`). The pitch deck and the `card.html` redirect shim load `theme.js` but show no switch: the
deck has no light/dark themes and the shim has no header.

## The data

- **Catalogue:** 1,183 exact, issuer-attributed and chain-observed Solana token addresses across
  12 issuer programmes (9 with live tokens; Remora and Ventuals are defunct, Republic has no mint yet)
  in the 22 Sep 2026 build. Admission needs a reviewed source or an issuer's own exact-mint registry.
- **Issuer dossiers** (`stocks/data/issuers/`): hand-researched, every structured field carrying the
  quote, URL, locator and date it came from.
- **Machine-collected records** (`stocks/data/*.json`): mint state, venues, holders, reference
  prices, trades, DeFi integrations, redemption observations, xStocks inventory. Built outputs are
  the `stocks-*.json` files at the root, also loaded into the Postgres schema `sonar`.
- **Daily snapshots** (`stocks/data/history/<date>/`) are committed and are the product's history.

## How it stays current

| Cadence (UTC) | Job | What it does |
|---|---|---|
| Hourly | `rwa-watch-chain` | Every catalogued mint's authorities, extensions, rebase multiplier, supply, metadata and labelled wallets; a change becomes a dated event with its slot |
| Hourly | `rwa-trades` | Decodes swaps on the busiest pools; `live.html` reads only our API, never a Solana RPC |
| Hourly | `rwa-watch-lending` | Liquidations of stock collateral and collateral price freezes at Kamino, Jupiter Lend, Nest and Loopscale, read from the lending programs' own transactions |
| Hourly | `rwa-watch-digest` | Private Telegram digests via @rwa_sonar_bot for saved watches, at the hour each owner chose |
| Daily 02:41 | `rwa-watch` | Re-reads every cited source (576 on 23 Sep 2026), diffs it, re-checks quotes verbatim; falls back to the publisher's API, then a raw Wayback capture; archive.today is linked, never read |
| Daily 04:23 | `rwa-watch-caselaw` | CourtListener and SEC litigation feeds for every issuer's entities; a hit is a lead for review, never an automatic "litigated" |
| Daily 06:47 | `rwa-judge` | A model reads up to 10 changed documents in one batch; the verdict is shown as a model assessment beside the diff and never decides inclusion; cost recorded per item |
| Daily 23:05 | `rwa-redemptions` | Checkpointed on-chain scan: Ondo burns, xStocks de-activations, Superstate conversions; PreStocks and Tessera recorded as not observable |
| Every 6 h | `rwa-refresh` | Rebuilds and publishes every generated file (catalogue, cards and preview images, power map, flows and float, tracking, exits, weekly, review queue) |

A day that was not read is shown as missing, never as zero, and a failed scan is never shown as "none".
Corrections to our own research are kept internally. Changes made by issuers, venues, protocols
and on-chain authorities are published with a date and a source.

## What is not covered

- The catalogue is built from searches, since no official registry exists; an address we have not discovered is absent.
- Holder counts are token accounts; one person can hold many, so they cannot say how many people own a token.
- xStocks creations and Superstate conversions into tokens are not collected; PreStocks and Tessera
  redemptions cannot be seen on chain; other issuers have no redemption scan.
- The xStocks float is an upper bound, and most xStocks have no market price to value it with.
- Legal analysis reads the structure of the documents. It is not a legal opinion and does not predict a court outcome.
- Model assessments can be wrong; they never filter what is shown.

## Run locally

```bash
npm install
npm install --prefix api
npm start
```

`npm start` serves the site and the API on loopback and prints both readiness lines. Without a
reachable `DATABASE_URL` the static site still starts and the API-backed panels show their
unavailable state. For a static-only preview:

```bash
npm run serve
```

Pages find the API on port 3300 by default; pass an explicit origin when the hosts differ:
`http://127.0.0.1:8113/stocks.html?api=http://127.0.0.1:3300`.

`npm test` runs the fast headless stock, API and page suites. Data collectors are explicit `--run`
jobs; read [`stocks/README.md`](stocks/README.md) before refreshing any external source.

## Hackathon package

Built for Stocklana on the
[`colosseum-worlds-fair`](https://github.com/Poglavar/rwa-sonar/tree/colosseum-worlds-fair) branch.
Before the hackathon the project was a broader RWA catalogue; during Stocklana it became the
Solana stock product described here. See [`SUBMISSION.md`](SUBMISSION.md).

## License

The code license choice remains pending owner confirmation. Do not claim a specific open-source
license until that is authorized. Third-party documents, issuer marks, APIs and market data remain
under their own terms.

## Repository map

- [`SUBMISSION.md`](SUBMISSION.md): submission descriptions, demo flow, claims to make precisely.
- [`next-steps.md`](next-steps.md): open work.
- [`TODO.md`](TODO.md): product and research backlog; [`UX-audit1.md`](UX-audit1.md): the first UX audit.
- [`stocks/README.md`](stocks/README.md): collection/build pipeline, outputs and operational rules.
- [`stocks/MODEL.md`](stocks/MODEL.md): the legal/technical grading model and its limits.
- [`stocks/EVIDENCE.md`](stocks/EVIDENCE.md): claims, source watching, change detection and review.
- [`stocks/findings.md`](stocks/findings.md): dated research notes.
- [`api/README.md`](api/README.md): API routes and private watch digests.
- `ecosystem.config.cjs`, `stocks/refresh-on-server.sh`, `deploy-to-server.sh`: production jobs,
  refresh and publication.

RWA Sonar is research, not investment or legal advice. Verify every conclusion before relying on it.
