# RWA Sonar — next steps

Open work only, as of 23 September 2026. Effort: **S** = under half a day, **M** = one to three days,
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
   pre-hackathon disclosure. Suggested demo: AAPL comparison → one material difference and its
   source → "keys stolen" what-if, xStocks against Superstate → a dated issuer change.
5. **Real-user comprehension test** — **you**, S–M. Two or three people now, five eventually, using
   the tasks in `COMPREHENSION-REHEARSAL.md`. *Why:* everything so far is agent-tested. *Payoff:*
   the only real evidence that people understand the answers.
6. **Recheck the submission rules** — **you**, S. Track, deadline, and which bounties a single entry
   can claim.
7. **Pitch to six slides** — M, on hold at your request. Lead with a what-if answer, demote liquidity
    figures, drop housekeeping. *Payoff:* a sharper story for judges and investors.

## Follow-ups

8. **Put protocol discrepancies where findings live** — S–M. Docs-vs-chain findings for a market (e.g.
   Loopscale's refinance admin, which its docs call a co-signer that "cannot initiate actions on its
   own" but which signs refinances alone; its 3/5 vs 4-of-7 upgrade multisig) appear only on the
   market's protocol page. Feed them into the stocks page's "Claims vs reality" view, the change
   journal and the affected token cards (SECZ). *Payoff:* this is the product's core kind of finding
   and it is currently hard to find.
9. **Send Loopscale the private note** — **you**, S. The public tweet covered the multisig; the
    refinance-admin finding goes privately (draft in the 23 Sep session).
10. **Card size back under target** — S. QQQx, SPYx and NVDAx are ~97.6 kB against the 96 kB soft
    target after the material-changes block and the redemption-feed row; the soft-target test will
    fail once the server data carries the feed. Trim repeated markup or raise the target deliberately.
11. **One xStocks redemption figure, not two** — S. Cards show the one-off dossier snapshot
    ("4 completed redemptions") beside the recurring scan ("6 in the last 19 h"). Let the recurring
    feed supersede the snapshot once it covers the same window.
12. **Two lost Remora quotes** — S, research. `redemption.rails` (Raydium TSLAr pool figures moved) and
    `pricing.notes` (app.rwa.xyz) no longer match their live pages; re-quote stable text.
13. **Telegram control for saved comparisons** — S. Only token/issuer/market watches on watch.html get
    "Get this on Telegram"; saved comparisons on stocks.html don't.
14. **Remaining blocked sources** — M. 14 of 56 blocked sources still need a real browser (JS apps:
    app.ventuals, app.shiftrwa, raydium, bybit, cysec, securitize.io home; Vercel/Cloudflare walls) or a
    better citation (individual Dropbox file links instead of a 31 MB folder zip).
15. **Confirm tonight's jobs** — S. The Wayback-toolbar fix (no chrome-only changes in the next watcher
    runs) and the first traffic-monitor offload at 04:40 UTC (~2 GB, check the alerts entry stays green).
16. **Server disk, remaining options** — **you**, S. At 89% (14 GB free) after today's cleanup. Left:
    traffic-monitor offload (running nightly from 24 Sep), and the zet-tocnost restore comments that
    still name the archived 8-Sep backup tables (restoring now means `pg_restore` from the Hetzner box
    first — see `hbox-crypt:db-archives/prod-retired-tables-2026-09-23`).

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
