# RWA Sonar — next steps

Open work only, as of 23 September 2026. Effort: **S** = under half a day, **M** = one to three days,
**L** = a week or more. Items marked **you** need your decision, account or people.

## Needs you (short, unblocks other work)

1. **Telegram watch digests** — **you**, S. Create the bot in BotFather and hand over the token; then
   set the four `WATCH_*` env vars on the server, register the webhook, start `rwa-watch-digest` and
   add its outcome check. *Why:* watches exist but can't deliver anything. *Payoff:* the first
   feature that brings a person back daily.
2. **Live-page RPC endpoint** — **you**, S. The site's security policy (CSP) only lets the page connect
   to publicnode, so WebSocket mode and the "custom RPC" box can't work. Decide: allow any https/wss
   endpoint, or relabel the box as fixed. *Payoff:* removes a broken-looking control.
3. **Case-law dismissals** — **you**, S. Sign off the candidate dismissals in
   `stocks/data/caselaw-reviewed.json`. *Payoff:* the `litigated` status becomes trustworthy.
4. **Post the tweet series** — **you**, S. Use the fact-checked wording from 23 Sep (Bullish and
   Loopscale cleared as drafted; xStocks, SECZ, Tessera, Superstate, Ondo reworded). Tag only current
   handles, one post a day. *Payoff:* issuer attention and corrections.
5. **Ask who holds tokenized SECZ of record** — **you**, S. One email to Continental shareholder services
   or Securitize IR settles which of the three recorded models is true (holder on Continental's
   register, Securitize nominee with a token sub-register, or Securitize as co-registrar). *Payoff:* a
   precise ownership answer for the only transfer-agent-native issuer.
6. **Republic's binding note terms** — **you**, M. The operative Note and Risk Factors sit behind the
   investment checkout, which is why 8 of Republic's 38 answers stay unknown. Getting the documents
   (an account, or asking Republic) is the only route. *Payoff:* the thinnest dossier fills in.

## Submission (Stocklana, closes 25 Sep 20:00 UTC)

7. **Submission package** — **you**, M. Three-minute demo video, team info, code licence, an honest
   pre-hackathon disclosure. Suggested demo: AAPL comparison → one material difference and its
   source → "keys stolen" what-if, xStocks against Superstate → a dated issuer change.
8. **Real-user comprehension test** — **you**, S–M. Two or three people now, five eventually, using
   the tasks in `COMPREHENSION-REHEARSAL.md`. *Why:* everything so far is agent-tested. *Payoff:*
   the only real evidence that people understand the answers.
9. **Recheck the submission rules** — **you**, S. Track, deadline, and which bounties a single entry
   can claim.
10. **Pitch to six slides** — M, on hold at your request. Lead with a what-if answer, demote liquidity
    figures, drop housekeeping. *Payoff:* a sharper story for judges and investors.

## Follow-ups from the 23 September work

11. **Make redemption observation recurring** — M. Today's Ondo and xStocks observations were a one-off
    scan (`stocks/lib/redemption-observation.mjs`). Run it daily over new transactions and extend it to
    PreStocks, Tessera and Superstate. *Payoff:* "redemptions are working" stays a live fact, and a
    stop in redemptions becomes a detectable event.
12. **Show the change judge's verdicts where people look** — S. Judgments now run daily (backlog being
    cleared). Surface "material" verdicts in the watch digest and on token cards, always beside the
    diff and labelled as a model assessment. *Payoff:* real term changes stop drowning in noise.
13. **Quote sources the watcher can't check yet** — S–M.
    - Some Tessera claims quote raw API JSON that includes live numbers (holder count); re-quote only
      stable fields.
    - Pages that render only in a browser (e.g. Superstate's newsroom) can't back a what-if answer:
      extend `quoteVerificationSources` from `claims[]` to `whatIf[]`.
    - *Payoff:* no false "quote lost" alarms, more usable primary sources.
14. **Bot-walled sources** — M. About 60 of the 569 watched documents (~10%) are blocked. Add a
    headless-browser fetch path or better archive fallbacks. *Payoff:* monitoring coverage you can
    claim without caveats.
15. **Confirm the Wayback-toolbar fix** — S. Sources that cite a Wayback link are now fetched as raw
    `id_` captures; the toolbar noise couldn't be reproduced, so check tomorrow's watcher run produces
    no chrome-only changes. *Payoff:* fewer false document changes.
16. **Timing-sensitive release tests** — S. `publish-release`/`validate-release` hit 5 s timeouts when
    the laptop is loaded (they pass alone). Raise their timeouts or remove the timing dependence.
    *Payoff:* a red suite always means a real failure.
17. **Evidence gaps surfaced today** — S each, research:
    - Securitize's two programs are upgradable by one ordinary key (`8d36iv2Y…`), and SECZ's authorities
      moved from plain keys to a program address only on 2026-08-11 — reflect this in its control rating.
    - Loopscale's docs say "3-of-5" for upgrades; the chain says 4 of 7. Record the discrepancy (and
      tell Loopscale).
    - A SECZ liquidation on Loopscale needs Securitize to thaw a liquidator account first; show that
      under the lender-exit analysis.
    - xStocks redemptions return tokens to issuer inventory instead of burning them, unlike the
      prospectus's "de-activated" wording; decide whether it is a discrepancy worth flagging.

## Make it feel alive (after the three motions shipped 23 Sep)

18. **Dolphins that react** — S. The patrol dolphin pings when a fresh material change exists, and the
    scout's lamp flickers while data loads. *Payoff:* motion that carries meaning.
19. **Live trade ticker on the landing page** — S. A thin strip of the newest real trades from the
    tape. *Payoff:* proof the site is live, from data we already collect.
20. **Count-up numbers, what-if matrix reveal, hover lift on cards** — S. Small first-view polish, all
    behind reduced-motion.
21. **Dolphin cut-outs swimming across the night scene** — M. Needs new transparent art. Highest
    visual impact, highest cost.

## After the hackathon

22. **One pilot workflow** — **you**, L. Interview protocol-risk teams, wallets and exchanges; pick one
    recurring job (for example monitoring eligible collateral) with a success measure before building
    paid features.
23. **Minimal documented API for that pilot** — M. Pagination, evidence states, timestamps, versioning
    and one export with provenance. Clarify data and document rights.
24. **Measure value and upkeep** — M. Task success, return visits, useful versus noisy alerts, time
    from an external change to a reviewed answer, review cost per template. Keep editorial
    independence explicit if issuers become customers.
