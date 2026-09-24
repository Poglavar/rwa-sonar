# RWA Sonar — next steps

Open work only, as of 24 September 2026. Effort: **S** = under half a day, **M** = one to three days,
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

4. **Submission package** — **you**, M. Three-minute demo video, team info, code licence, an honest
   pre-hackathon disclosure. Team members/roles, contact and the video link are marked
   `[Owner to add: …]` on pitch slide 6 and in SUBMISSION.md's Team section. Suggested demo: AAPL
   comparison → "keys stolen" what-if, xStocks against Superstate → who holds the keys → flows and
   float → a dated issuer change.
5. **Real-user comprehension test** — **you**, S–M. Two or three people now, five eventually, using
   the tasks in `COMPREHENSION-REHEARSAL.md`. *Why:* everything so far is agent-tested. *Payoff:*
   the only real evidence that people understand the answers.
6. **Submission gaps** — **you**, S. Rules checked 24 Sep (summary in the session scratchpad
   `prep/submission-rules.md`): deadline Fri 25 Sep 4:00 pm ET (20:00 UTC), run by the Solana
   Foundation; one link plus a linked Solana wallet; short description ≤ 280 characters, full
   description ≤ 5,000 (SUBMISSION.md is ~13k — cut it); up to 3 bounty tracks — Pyth fits,
   Tessera optionally, PreStocks is excluded (its rules bar projects that also cover other pre-IPO
   tokens). Still missing: a README "For judges" section, a licence, the pitch-slide-6 placeholders.

## Follow-ups

7. **Liquidations and price freezes collector** — in progress (24 Sep). Liquidations of stock
   collateral and lending-market price freezes on Kamino, Jupiter Lend, Nest and Loopscale, collected
   hourly and fed into the latest-events box.
8. **3 sources still blocked** — S. app.ventuals.com/sunset (browser-only; the same fact is checked
   through a JS chunk), securitize.io/investments/stocks (JS-only), CySEC announcements (incomplete
   TLS chain on their server).
9. **Buyer-first pages** — **you** decide, M. From the 24 Sep buyer walkthrough: a buyer table at the
   top of the compare page (who can buy, what you own, price and premium, liquidity, where to trade,
   freeze/clawback, fees, redemption); price, status, "who can buy" and "where to trade" at the top
   of each card; our own quote-maintenance events off the cards; new visitors land on "Find a stock";
   home search higher on phones; plain words for rung / ledger maturity / source-listed / evidence
   backlog labels.
10. **After-hours view** — **you** decide, M. Research in `stocks/research/after-hours-collateral-pricing.md`:
    only Nest prices stock collateral from 24/7 token trading; Kamino and Jupiter Lend use Chainlink
    equity prices and freeze (QQQx 44 h, METAx 65 h); Loopscale's xStock prices have not updated since
    26 Aug. Replace the closed-hours premium with "what each lender does when the market is closed",
    Solana depth, freeze episodes and Monday-gap exposure; wire the four proposed finding types.
11. **Watcher reads that look like changes** — M. Most document changes the model rated material in
    the last week were our reader failing (a geoblock page from the server's region, a script-only
    shell, an RPC info page). Classify those as unreadable at the watcher so they never become change
    events; the events ticker already shows only reviewed journal entries.
12. **Rebuild the change journal with the FinCEN renewal** — S. The resolution
    `backpack-trek-labs-fincen-renewal-2026-09-22` is recorded; the next pipeline run writes the
    entry, and watcher event 164 should be acknowledged in the database.

## After the hackathon

13. **Daily/weekly summary shorts** — postponed (24 Sep), M, 2–3 days. A sub-minute video built from the events feed:
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
14. **One pilot workflow** — **you**, L. Interview protocol-risk teams, wallets and exchanges; pick one
    recurring job (for example monitoring eligible collateral) with a success measure before building
    paid features.
15. **Minimal documented API for that pilot** — M. Pagination, evidence states, timestamps, versioning
    and one export with provenance. Clarify data and document rights.
16. **Measure value and upkeep** — M. Task success, return visits, useful versus noisy alerts, time
    from an external change to a reviewed answer, review cost per template. Keep editorial
    independence explicit if issuers become customers.
