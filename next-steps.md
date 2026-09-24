# RWA Sonar — next steps

Open work only, as of 24 September 2026 (evening). Effort: **S** = under half a day, **M** = one to three days,
**L** = a week or more. Items marked **you** need your decision, account or people.

## Needs you (short, unblocks other work)

1. **Case-law dismissals** — **you**, S. Sign off the candidate dismissals in
   `stocks/data/caselaw-reviewed.json`. *Payoff:* the `litigated` status becomes trustworthy.
2. **Ask who holds tokenized SECZ of record** — **you**, S. One email to Continental shareholder services
   or Securitize IR settles which of the three recorded models is true (holder on Continental's
   register, Securitize nominee with a token sub-register, or Securitize as co-registrar). *Payoff:* a
   precise ownership answer for the only transfer-agent-native issuer.
3. **Republic's binding note terms** — **you**, M. The operative Note and Risk Factors sit behind the
   investment checkout, which is why 8 of Republic's 38 answers stay unknown. Getting the documents
   (an account, or asking Republic) is the only route. *Payoff:* the thinnest dossier fills in.

## Submission (Stocklana, closes 25 Sep 20:00 UTC)

4. **Submission package** — **you**, S. Form text, team and contacts are ready in SUBMISSION.md
   "Form fields" (short description 266/280 characters, full 4,550/5,000), pitch slide 6 and the
   README "For judges" section. Still yours: record the pitch video (≤ 3 min) and paste its link;
   register on hackathons.solana.com and link a Solana wallet (required to submit); tick Pyth
   (Tessera optional).
5. **Real-user comprehension test** — **you**, S–M. Two or three people now, five eventually, using
   the tasks in `COMPREHENSION-REHEARSAL.md`. *Why:* everything so far is agent-tested. *Payoff:*
   the only real evidence that people understand the answers.
## Follow-ups

6. **Blocked sources, what is left** — S. CySEC is now read (GoDaddy's missing intermediate is
   shipped for that host) but our extractor drops its ASP.NET `<form>`, so only 71 characters come
   back; the same gap drops article text inside `<header>` on backed.fi news. CySEC's own
   certificate expires 27 Sep 2026. Eight Backed claims stay `changed` from region-blocked reads
   until a readable copy (e.g. Wayback) is found.
7. **Buyer-first pages** — **you** decide, M. From the 24 Sep buyer walkthrough: a buyer table at the
   top of the compare page (who can buy, what you own, price and premium, liquidity, where to trade,
   freeze/clawback, fees, redemption); price, status, "who can buy" and "where to trade" at the top
   of each card; our own quote-maintenance events off the cards; new visitors land on "Find a stock";
   home search higher on phones; plain words for rung / ledger maturity / source-listed / evidence
   backlog labels.
8. **Closed-market view follow-ups** — S. Weekend depth samples accrue from the refresh's Saturday
    and Sunday runs; exposure at the Monday gap and Jupiter Lend's Sunday re-mark are not measured
    yet. The widest card (QQQx) is 389 bytes under the 104 KiB card budget, so anything new on the
    cards needs a trim or a budget decision. Backpack and Ondo dossiers could carry the
    "priced from token trading" finding too (**you** decide).
9. **Older false "quote lost" events** — **you** decide, S. The 118 events raised from unreadable
    reads were dismissed on 24 Sep (false-alarm resolutions, nothing deleted). 60 more quote-lost
    events had the quote in the stored bytes and were missed by an older reader;
    `node stocks/dismiss-unreadable-events.mjs --run --apply --include-reader-fixed` would dismiss
    them too. 52 older events have no stored copy left to judge.
10. **Rebuild the change journal with the FinCEN renewal** — S. The resolution
    `backpack-trek-labs-fincen-renewal-2026-09-22` is recorded, but on prod the lost FinCEN quotes
    are events 904 and 905 (19 Sep) and the resolution says `detectedOn: 2026-09-22`, so it does not
    match them; event 164 exists only in the laptop database. Fix the resolution, then rerun.
11. **Holder rights on each card** — **you** decide, S–M. Cards show one-word "Dividends" and
    "Voting" rows; the full corporate-actions analysis sits collapsed on issuer pages in research
    wording. Proposal: one plain line per right (dividends, voting, splits, mergers and takeovers,
    spin-offs and rights issues, delisting, company reports) with its source, plus the token's
    recent dividend reinvestments and the next scheduled one from its on-chain multiplier.
## After the hackathon

12. **Daily/weekly summary shorts** — postponed (24 Sep), M, 2–3 days. A sub-minute video built from the events feed:
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
13. **One pilot workflow** — **you**, L. Interview protocol-risk teams, wallets and exchanges; pick one
    recurring job (for example monitoring eligible collateral) with a success measure before building
    paid features.
14. **Minimal documented API for that pilot** — M. Pagination, evidence states, timestamps, versioning
    and one export with provenance. Clarify data and document rights.
15. **Measure value and upkeep** — M. Task success, return visits, useful versus noisy alerts, time
    from an external change to a reviewed answer, review cost per template. Keep editorial
    independence explicit if issuers become customers.
