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
8. **Remora's Jupiter quote** — S, research. `redemption.eligibility` cites a Jupiter
   `swap/v1/quote?inputMint=ALTP6…` URL whose response no longer carries the quoted text; re-quote.
9. **Sources still blocked** — M. Homepages cited without a quote (raydium.io, bybit.com, securitize.io,
   anduril.com, the CySEC listing, a CourtListener opinion) need a companion quote or an exclusion from
   the watch; Chainlink `data.chain.link` streams (tKalshi, tOpenAI) sit behind Vercel's check even in a
   headed browser (the reference-data-directory JSON is a lead); the Ondo folder links and four Remora
   2025 Wayback captures are unreadable as cited.
10. **Card size over target again** — S. On server data SPYx, NVDAx, QQQx, TSLAx and SECZ are
    104.6–107.6 kB against the 104 KiB soft target (112 KiB hard limit), after the docs-vs-chain rows.
11. **Confirm tonight's jobs** — S. The Wayback-toolbar fix (no chrome-only changes in the next watcher
    runs) and the first traffic-monitor offload at 04:40 UTC (~2 GB, check the alerts entry stays green).

## Make it feel alive

12. **Dolphin cut-outs swimming across the night scene** — M. Needs new transparent art. Highest
    visual impact, highest cost.

## After the hackathon

13. **One pilot workflow** — **you**, L. Interview protocol-risk teams, wallets and exchanges; pick one
    recurring job (for example monitoring eligible collateral) with a success measure before building
    paid features.
14. **Minimal documented API for that pilot** — M. Pagination, evidence states, timestamps, versioning
    and one export with provenance. Clarify data and document rights.
15. **Measure value and upkeep** — M. Task success, return visits, useful versus noisy alerts, time
    from an external change to a reviewed answer, review cost per template. Keep editorial
    independence explicit if issuers become customers.
