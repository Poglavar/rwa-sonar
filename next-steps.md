# RWA Sonar — next steps

Open work only, as of 30 September 2026 (the Stocklana submission is in). Effort: **S** = under half a day, **M** = one to three days,
**L** = a week or more. Items marked **you** need your decision, account or people.

## Needs you (short, unblocks other work)

1. **Case-law dismissals** — **you**, S. Sign off the agent's 23 Sep decisions (38 dismissed, 2 confirmed) in
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
## Leftovers from the submission

4. **Small account chores** — **you**, S each.
   - Ask the Pyth contacts for a Pyth Pro token: `fetch-reference-prices.mjs` checks entitlement per
     feed, so hundreds of reference prices would appear without a code change.
   - GitHub About box: still "RWA Sonar - Analyze Real World Assets", no homepage, no topics (set
     tagline, rwasonar.com, topics such as solana, token-2022, tokenized-stocks, pyth). Optionally
     close the old tool-named branches and bot PRs #15 and #17.
   - Cloudflare: turn off Email Obfuscation (it breaks the pitch's mailto without JavaScript) and
     cache `*.json` for its existing 60 s.
   - Rotate the CoinMarketCap key once the CMC hackathon is over (it appeared in a chat).
5. **Real-user comprehension test** — **you**, S–M. Two or three people now, five eventually, using
   the tasks in `COMPREHENSION-REHEARSAL.md`. *Why:* everything so far is agent-tested. *Payoff:*
   the only real evidence that people understand the answers.

## Follow-ups

6. **Blocked sources, what is left** — S. Region-blocked pages now fall back to their newest
   Wayback capture; a capture older than a quote cannot mark it lost. Backed's `chains` quote
   ("…X Layer, Optimism") waits for a capture newer than 18 Sep. If the newest capture is itself
   blocked, the fallback gives up instead of trying an older one. The Republic (read via Wayback),
   PreStocks and Jupiter API claims still sit in `changed`.
7. **Closed-market view follow-ups** — S. Weekend depth samples accrue from the refresh's Saturday
   and Sunday runs; exposure at the Monday gap and Jupiter Lend's Sunday re-mark are not measured
   yet. Backpack and Ondo dossiers could carry the "priced from token trading" finding too (**you**
   decide). Cards may grow to 150 KiB (owner, 25 Sep).
8. **Page weight** — M. Phone payloads are heavy (DeFi view 1.66 MB gzip, monitor 974 KB, what-if
   759 KB): slimmer per-view JSON. assets.html loads logos from 12 third-party hosts: self-host them.
9. **Smaller polish** — S each. The chain watcher and power map still read a scheduled fee leg as
   the current one (the feed wording and cards handle it). The live tape hides every routed trade,
   including a person's Jupiter swap; telling them apart needs program ids in the trade API.
10. **Identity cleanup after judging ends** — S, decided 30 Sep: do it once Stocklana judging is over.
    (a) Remove the 11 "Zagreb" mentions from `colosseum-worlds-fair` (timezone example, role-name
    comments, a docroot comment; the same fix as `universe` 7e36e7a). (b) Rewrite history on every
    branch to drop the owner's name, home paths and "zagreb" (16 and 11 commits, two commit messages),
    then force-push and move the `stocklana-submission` tag; every commit id changes.
11. **Health follow-ups** — S, **you** decide. Organic flow cautions only above 25 trades per trader,
    and Ondo's scheduled `unavailable_in_session` is not a pause (both 25 Sep; either may be vetoed).
    The holder headline counts holder concentration from caution (one unlabelled wallet over 25 %):
    100 tokens are warning only because one unlabelled wallet holds over half the supply, often an
    issuer or distributor wallet we have not labelled.
12. **Remaining jargon** — S. The methodology text in `stocks.html` keeps technical terms on purpose;
    a card whose issuer claim label is itself technical ("synthetic exposure") keeps the stored label.
13. **New watchers, what is left** — S–M each. The entity watcher needs a Companies House key and the
    regulator watcher an FCA Register key (**you**) for the UK sources. The xStocks delegate multisig
    `Dsm8…` is only seen once it executes; watch its proposals. Corporate-action cautions for Hong Kong
    listings (1919, 386, 1209, 3808, 1928, 288) come from missing dividend data, not the issuer.
    Findings to review (**you**): the reserve "shortfalls" on LULUx, RKLBx, TRONx and BOTx are exactly
    the balance of `HmMxmEjTbpGqgDsCCmgNfQKCbeH6QcGe1xKn9UXqXFqk`, a wallet the xStocks authority
    funded that holds 61 xStocks (label it issuer inventory, or keep it as outstanding); lapsed LEIs
    of BitGo Trust Company and Securitize Capital; APHx ×2 and OPENAI ×1.486 restatements with no
    corporate action behind them; the FINRA AWC against Alpaca Securities (17 Mar 2026); the
    PreStocks transfer fee raised to 100 bps on 19 Sep by a 2-of-7 multisig with no time lock; the
    Bullish permanent-delegate burn of 25,100 BLSH.
14. **Archive throttle, live** — S. The document watcher's archive.org backoff and daily pause are
    tested at the decision level only; confirm on the first real refusal in the prod logs.

## Later

15. **Daily/weekly summary shorts** — postponed (24 Sep), M, 2–3 days. A sub-minute video built from the events feed:
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
16. **One pilot workflow** — **you**, L. Interview protocol-risk teams, wallets and exchanges; pick one
    recurring job (for example monitoring eligible collateral) with a success measure before building
    paid features.
17. **Minimal documented API for that pilot** — M. Pagination, evidence states, timestamps, versioning
    and one export with provenance. Clarify data and document rights.
18. **Measure value and upkeep** — M. Task success, return visits, useful versus noisy alerts, time
    from an external change to a reviewed answer, review cost per template. Keep editorial
    independence explicit if issuers become customers.
