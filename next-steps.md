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
4. **Post the tweet series** — **you**, S. Use the fact-checked wording (Bullish cleared; the others
   reworded). Tag only current handles, one post a day. *Payoff:* issuer attention and corrections.

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

## Finish what is half-built

9. **Change judge on production** — S. Collect or re-run the stuck batch (if it expires, send one item
   through the non-batch API to test the request format), apply the `change_judgment` DDL on the server
   and schedule the judge there. *Why:* the watch page's "Material changes" filter is empty on the
   live site. *Payoff:* separates real term changes from noise.
10. **Link issuer dossiers to their what-if answers** — S. The `/issuers/*.html` pages show neither the
    38 answers nor a link to them, and the what-if panel doesn't link back to the dossier. *Payoff:*
    high — the dossiers are what tweets and judges link to.
11. **Bot-walled sources** — M. About 60 of the 569 watched documents (~10%) are blocked. Add a
    headless-browser fetch path or better archive fallbacks. *Payoff:* monitoring coverage you can
    claim without caveats.
12. **Phone polish left over from the QA pass** — S each:
    - the assets page still has the old standalone header;
    - the graph opens too zoomed out to read on a phone;
    - comparison filters aren't kept in the URL, and a stale heading shows while a comparison loads;
    - 13px checkboxes, and small chips on the graph page;
    - three cards (SPYx, NVDAx, QQQx) are 0.1–0.4 kB over the 96 kB target.

## Deepen the evidence

13. **Thinnest dossiers** — M each. Tessera (23 of 38 documented), Shift (25, 3 unknown), Republic
    (8 unknown) and Superstate (8 inferred). *Payoff:* fewer "unknown" cells on the most-viewed page.
14. **Where tokenized SECZ is recorded** — S. The filings name Continental as SECZ's transfer agent,
    but it isn't settled whether tokenized holdings sit on Continental's register or on Securitize's
    own transfer-agent ledger. *Payoff:* a precise ownership answer for the only transfer-agent-native
    issuer.
15. **Small wording fixes from the tweet check** — S. Ventuals' "within hours" is undated; Backpack's
    Anjouan broker notice applies only in some regions; Remora's operator name survives only in the
    archived privacy policy. *Payoff:* the site states exactly what the sources support.
16. **A second verified lending market** — M. So far only NVDAx collateral in Kamino's xStocks Pool is
    decoded end to end. Do the SECZ/Loopscale market next (loan state, oracle, liquidation terms).
    *Payoff:* moves another integration from "listed" to "configuration verified".
17. **Observed redemptions** — M–L. No successful redemption has been independently observed for any
    issuer. Find public on-chain redemption flows (burn plus payout) for xStocks and Ondo.
    *Payoff:* turns "documented route" into "route seen working".

## Make it feel alive (after the three motions shipped today)

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
