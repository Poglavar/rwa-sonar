# RWA Sonar — next steps

Open work only, as of 23 September 2026. Effort: **S** = under half a day, **M** = one to three days,
**L** = a week or more. Items marked **you** need your decision, account or people.

## Needs you (short, unblocks other work)

1. **Case-law dismissals** — **you**, S. Sign off the candidate dismissals in
   `stocks/data/caselaw-reviewed.json`. *Payoff:* the `litigated` status becomes trustworthy.
2. **Post the tweet series** — **you**, S. Use the fact-checked wording from 23 Sep (Bullish and
   Loopscale cleared as drafted; xStocks, SECZ, Tessera, Superstate, Ondo reworded). Tag only current
   handles, one post a day. *Payoff:* issuer attention and corrections.
3. **Ask who holds tokenized SECZ of record** — **you**, S. One email to Continental shareholder services
   or Securitize IR settles which of the three recorded models is true (holder on Continental's
   register, Securitize nominee with a token sub-register, or Securitize as co-registrar). *Payoff:* a
   precise ownership answer for the only transfer-agent-native issuer.
4. **Republic's binding note terms** — **you**, M. The operative Note and Risk Factors sit behind the
   investment checkout, which is why 8 of Republic's 38 answers stay unknown. Getting the documents
   (an account, or asking Republic) is the only route. *Payoff:* the thinnest dossier fills in.

## Submission (Stocklana, closes 25 Sep 20:00 UTC)

5. **Submission package** — **you**, M. Three-minute demo video, team info, code licence, an honest
   pre-hackathon disclosure. Suggested demo: AAPL comparison → one material difference and its
   source → "keys stolen" what-if, xStocks against Superstate → a dated issuer change.
6. **Real-user comprehension test** — **you**, S–M. Two or three people now, five eventually, using
   the tasks in `COMPREHENSION-REHEARSAL.md`. *Why:* everything so far is agent-tested. *Payoff:*
   the only real evidence that people understand the answers.
7. **Recheck the submission rules** — **you**, S. Track, deadline, and which bounties a single entry
   can claim.
8. **Pitch to six slides** — M, on hold at your request. Lead with a what-if answer, demote liquidity
    figures, drop housekeeping. *Payoff:* a sharper story for judges and investors.

## Follow-ups from the 23 September work

9. **Free more space on the prod server** — **you**, S. The disk sat at 93% after the release cleanup.
   Candidates, safest first: npm cache (0.8 GB), old Puppeteer Chrome 119/121 (0.9 GB), dead NFT
   tables `twitter_tweet`/`website_text` (0.9 GB), 8-Sep backup tables (~1 GB), the 4-Sep
   `parcel_co` dump (1.8 GB), unused Playwright browsers (up to 2.9 GB), traffic-monitor retention
   (up to 4.8 GB), `zet.stop_arrivals` bloat (1–3 GB). Most belong to other projects, so pick which.
10. **Show the redemption feed on pages** — S. The daily observer's state (observed / none in N days /
    scan failed / stale, Superstate's on-chain leg, why PreStocks and Tessera can't be observed) is in
    the issuer data but not rendered on issuer pages and cards. *Payoff:* "redemptions work" becomes
    visible and dated.
11. **Telegram control for saved comparisons** — S. Only token/issuer/market watches on watch.html get
    "Get this on Telegram"; saved comparisons on stocks.html don't. *Payoff:* the most common watch
    type can be delivered.
12. **Remaining blocked sources** — M. 14 of 56 blocked sources still need a real browser (JS apps:
    app.ventuals, app.shiftrwa, raydium, bybit, cysec, securitize.io home; Vercel/Cloudflare walls) or
    a better citation (individual Dropbox file links instead of a 31 MB folder zip). *Payoff:* the last
    unwatched evidence.
13. **Confirm the Wayback-toolbar fix** — S. Check the next watcher runs produce no chrome-only changes.
14. **Review the Remora Jupiter change** — S, research. The cited Jupiter quote now answers
    `TOKEN_NOT_TRADABLE` instead of `NO_ROUTES_FOUND`; update the Remora redemption evidence.
15. **Document the watcher changes** — S. `stocks/EVIDENCE.md` §2.8 and the README should cover
    `--only-blocked`, companion sources (`read_via = companion`), archive.today linking and what-if
    companion verification.
16. **Send Loopscale the documentation note** — **you**, S. Their security page says a 3/5 upgrade
    multisig (chain: 4 of 7 with a 24 h lock) and calls the refinance admin a co-signer that can't act
    alone (it signs refinances alone). A polite draft exists in the 23 Sep session.

## Make it feel alive

17. **Dolphin cut-outs swimming across the night scene** — M. Needs new transparent art. Highest
    visual impact, highest cost.

## After the hackathon

18. **One pilot workflow** — **you**, L. Interview protocol-risk teams, wallets and exchanges; pick one
    recurring job (for example monitoring eligible collateral) with a success measure before building
    paid features.
19. **Minimal documented API for that pilot** — M. Pagination, evidence states, timestamps, versioning
    and one export with provenance. Clarify data and document rights.
20. **Measure value and upkeep** — M. Task success, return visits, useful versus noisy alerts, time
    from an external change to a reviewed answer, review cost per template. Keep editorial
    independence explicit if issuers become customers.
