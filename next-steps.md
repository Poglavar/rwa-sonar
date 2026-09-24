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
6. **Recheck the submission rules** — **you**, S. Track, deadline, and which bounties a single entry
   can claim.

## Follow-ups

7. **Send Loopscale the private note** — **you**, S. The public tweet covered the multisig; the
   refinance-admin finding goes privately (draft in the 23 Sep session).
8. **Last 6 lost quotes** — S, research. Remora `pricing.notes` quotes a live DefiLlama value (re-quote
   stable text); Securitize `custodyVerification.agent` quotes text that is not in the cited file
   (the page assembles it in the browser); xStocks claims 118–121 each combine three transactions
   but cite only the payout — re-quote to the payout transaction and add claims for the deposit and
   sweep legs with their own transaction URLs.
9. **3 sources still blocked** — S. app.ventuals.com/sunset (browser-only text; the same fact is now
   checked through a JS chunk), securitize.io/investments/stocks (JS-only), CySEC announcements
   (the server sends an incomplete TLS chain). PreStocks' FAQ bundle `page-eda8c…js` is gone and is
   still cited in 38 places.
10. **Buyer-first pages** — **you** decide, M. From the 24 Sep buyer walkthrough: a buyer table at the
    top of the compare page (who can buy, what you own, price and premium, liquidity, where to trade,
    freeze/clawback, fees, redemption); price, status, "who can buy" and "where to trade" at the top
    of each card; our own quote-maintenance events off the cards; new visitors land on "Find a stock";
    home search higher on phones; plain words for rung / ledger maturity / source-listed / evidence
    backlog labels.
11. **Exchange data freshness** — S. CoinGecko is fetched at 250 coins a day for 1,169 mapped coins,
    so exchange prices and volumes on a card can be ~5 days old and are shown as current. Refresh the
    highest-volume coins daily, rotate the rest, and label exchange data with its date.
12. **After-hours view** — **you** decide, M. Research in `stocks/research/after-hours-collateral-pricing.md`:
    only Nest prices stock collateral from 24/7 token trading; Kamino and Jupiter Lend use Chainlink
    equity prices and freeze (QQQx 44 h, METAx 65 h); Loopscale's xStock prices have not updated since
    26 Aug. Replace the closed-hours premium with "what each lender does when the market is closed",
    Solana depth, freeze episodes and Monday-gap exposure; wire the four proposed finding types.
13. **Loopscale: stuck loans and exposure** — S. Add the dead price feed (9 xStock loans overdue since
    27 Aug) to the private note (item 7). Our DeFi data counts vault allocations ($30–80k per token)
    as "lent against"; open principal is ~$3.9k — fix the measure.
14. **Backpack's FinCEN registration number changed** — S. 31000329581307 → 31000339714338 between 18
    and 22 Sep; add a change-journal entry and update `stocks/findings.md`.

## After the hackathon

15. **One pilot workflow** — **you**, L. Interview protocol-risk teams, wallets and exchanges; pick one
    recurring job (for example monitoring eligible collateral) with a success measure before building
    paid features.
16. **Minimal documented API for that pilot** — M. Pagination, evidence states, timestamps, versioning
    and one export with provenance. Clarify data and document rights.
17. **Measure value and upkeep** — M. Task success, return visits, useful versus noisy alerts, time
    from an external change to a reviewed answer, review cost per template. Keep editorial
    independence explicit if issuers become customers.
