# RWA Sonar — next steps

Open work only, as of 25 September 2026 (early morning, UTC). Effort: **S** = under half a day, **M** = one to three days,
**L** = a week or more. Items marked **you** need your decision, account or people.

## Needs you (short, unblocks other work)

1. **Case-law dismissals** — **you**, S. Sign off the candidate dismissals in
   `stocks/data/caselaw-reviewed.json`. *Payoff:* the `litigated` status becomes trustworthy.
2. **Who holds tokenized SECZ of record** — **you**, waiting. Asked Continental shareholder services
   (cstmail@continentalstock.com) on 25 Sep: which of the three recorded models applies (holder on
   Continental's register, Securitize nominee with a token sub-register, or Securitize as
   co-registrar), which record governs, the route back to DRS, and who sends proxies and dividends.
   *Payoff:* a precise ownership answer for the only transfer-agent-native issuer.
3. **Republic's binding note terms** — **you**, waiting. Asked Republic (investors@republic.co, cc
   team@republic.co) on 25 Sep for the operative Note and Risk Factors, the payout timing and price
   after SpaceX's June 2026 listing, the reference price after the 5-for-1 split, keepwell vs
   guarantee, the official Solana mint, token controls and the unknown what-if cases. *Payoff:* the
   thinnest dossier fills in (8 of 38 answers unknown).
## Submission (Stocklana, closes 25 Sep 20:00 UTC)

4. **Submission package** — **you**, S. Ready in SUBMISSION.md: every form field, the short
   description (261/280 characters) and full description (4,970/5,000), the competition answer
   (Positioning), and a three-minute recording path checked against the live site. Pitch slide 6 and
   the README "For judges" section carry the team and MIT licence. Still yours:
   - record the pitch video (≤ 3 min) and paste its link;
   - register on hackathons.solana.com and link a Solana wallet (required to submit);
   - tick Pyth (Tessera optional);
   - add any real traction numbers (followers, Telegram members, replies from issuers or protocols):
     the database holds 1 saved watch and 0 Telegram bindings, so there is no usage figure to quote;
   - ask the Pyth bounty contacts for a hackathon Pyth Pro token: `fetch-reference-prices.mjs` checks
     entitlement per feed, so hundreds of reference prices would appear without a code change;
   - GitHub About box (tagline, homepage rwasonar.com, topics such as solana, token-2022,
     tokenized-stocks, pyth); optionally close the old tool-named branches and bot PRs #15 and #17;
   - Cloudflare: turn off Email Obfuscation (it breaks the mailto on the pitch without JavaScript)
     and cache `*.json` for its existing 60 s (phone load times).
5. **Real-user comprehension test** — **you**, S–M. Two or three people now, five eventually, using
   the tasks in `COMPREHENSION-REHEARSAL.md`. *Why:* everything so far is agent-tested. *Payoff:*
   the only real evidence that people understand the answers.

## Follow-ups

6. **Blocked sources, what is left** — S, after judging. CySEC is now read (GoDaddy's missing
   intermediate is shipped for that host) but our text extractor drops its ASP.NET `<form>`, so only
   71 characters come back; the same gap drops article text inside `<header>` on backed.fi news.
   Changing the extractor changes every stored reading, so do it with a re-baseline, not the day
   before judging. CySEC's own certificate expires 27 Sep 2026. Eight Backed claims stay `changed`
   from region-blocked reads until a readable copy (e.g. Wayback) is found; they show on the changes
   page and the issuer evidence, not on the cards.
7. **Closed-market view follow-ups** — S. Weekend depth samples accrue from the refresh's Saturday
   and Sunday runs; exposure at the Monday gap and Jupiter Lend's Sunday re-mark are not measured
   yet. Backpack and Ondo dossiers could carry the "priced from token trading" finding too (**you**
   decide). Cards may grow to 150 KiB (owner, 25 Sep).
8. **Speed and weight** — M. `/api/changes` takes 0.8–1 s (every other endpoint 125–350 ms): EXPLAIN
    and index, or precompute. Phone payloads are heavy (DeFi view 1.66 MB gzip, monitor 974 KB,
    what-if 759 KB): slimmer per-view JSON. assets.html loads logos from 12 third-party hosts:
    self-host them.
9. **Smaller polish** — S each. The live tape could hide routed bot trades by default; weekly
    "Headlines" are counts, not stories; `/api/` returns 404 although the API has a route list; build
    scripts (`/stocks/*.mjs`) are served publicly (no secrets; exclude them after checking no page
    loads one); the chain watcher and power map still read a scheduled fee leg as the current one
    (the feed wording and cards handle it).
10. **Home path in git history** — S, **you** decide. `AGENTS.md` no longer names a home directory,
    but 7 older commits do. Only a history rewrite removes it; not before judging.

11. **Pre-IPO watches across devices** — S. Comparisons of pre-IPO tokens (OpenAI, Kalshi, SpaceX
    with PreStocks or Tessera) save in the browser, but the cross-device watch API matches on the
    listed ticker, which pre-IPO tokens do not have. Needs a `company_key` column loaded by db-load.
12. **Health follow-ups** — S. Two thresholds changed on 25 Sep because they measured the opposite
    of their purpose: organic flow now cautions only above 25 trades per trader (deep markets are
    mostly arbitrage), and Ondo's scheduled `unavailable_in_session` is no longer a pause (**you**
    may veto either). Card titles and preview images still use the worst of all eleven checks.
13. **Remaining jargon** — S. Card preview alt text ("rung 2 of 4"), the card's lower protocol
    support section ("source-listed", protocol-proof.js), the raw "Transfer restrictions" flags row,
    grid axes ("Level 0–4", "0 synthetic exposure").

## After the hackathon

14. **Daily/weekly summary shorts** — postponed (24 Sep), M, 2–3 days. A sub-minute video built from the events feed:
    issuer changes, token terms changes, key/fee/pause changes, lending support added or dropped,
    and large market moves, naming the three biggest ("…of which A +10 %, B +15 %, C +22 %"); nothing
    said when nothing passed the bar. *Rules:* only reviewed journal entries, on-chain facts and
    thresholded market numbers (never unreviewed watcher rows); traders or organic volume rather than
    raw volume (bot trading dominates); no year-on-year until a year of history exists. *Plumbing:*
    a pure, tested script generator; a "daily briefing" scene template in `video/`; a nightly render
    that sends the draft to the owner's Telegram for one-tap approval; post to the Telegram channel,
    X by hand or via its API once costs are checked. *Needs first:* a liquidation and oracle-freeze
    collector (Kamino, Jupiter Lend, Nest, Loopscale), and an ElevenLabs plan sized for ~15–20k
    characters a month (or captions only). *Start:* a weekly short plus a text-only daily post;
    go daily video only if engagement justifies it.
15. **One pilot workflow** — **you**, L. Interview protocol-risk teams, wallets and exchanges; pick one
    recurring job (for example monitoring eligible collateral) with a success measure before building
    paid features.
16. **Minimal documented API for that pilot** — M. Pagination, evidence states, timestamps, versioning
    and one export with provenance. Clarify data and document rights.
17. **Measure value and upkeep** — M. Task success, return visits, useful versus noisy alerts, time
    from an external change to a reviewed answer, review cost per template. Keep editorial
    independence explicit if issuers become customers.
