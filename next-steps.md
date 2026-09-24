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

7. **Send Loopscale the private note** — **you**, S. Draft ready in the session scratchpad
   (`prep/loopscale-note.md`): the dead price feed first (9 xStock loans overdue since 27 Aug), the
   refinance-admin finding second (already public). **Hold the push and deploy until it is sent**:
   the stale-price data is in unpushed commits (`protocol-market-research.json`, `defi-usage.json`),
   and both files are served. No security contact is listed; the channel is your call.
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

13. **One pilot workflow** — **you**, L. Interview protocol-risk teams, wallets and exchanges; pick one
    recurring job (for example monitoring eligible collateral) with a success measure before building
    paid features.
14. **Minimal documented API for that pilot** — M. Pagination, evidence states, timestamps, versioning
    and one export with provenance. Clarify data and document rights.
15. **Measure value and upkeep** — M. Task success, return visits, useful versus noisy alerts, time
    from an external change to a reviewed answer, review cost per template. Keep editorial
    independence explicit if issuers become customers.
