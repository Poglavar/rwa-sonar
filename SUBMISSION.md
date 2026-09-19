# Stocklana submission notes

Deadline 2026-09-25. Needs the GitHub link and a live demo or a video.

## Bounty angles

- **Meteora** — the monitor's pool section lists every Meteora pool holding a tokenized stock
  (21 DLMM + 1 DBC) with bin step, fee tier, 24 h fees, volume, price against the reference,
  failed-transaction share and last trade from the tape. The DBC pool is pinned into the collector
  so it always has a tape; its bonding-curve state is reported as "not decodable keylessly"
  rather than guessed.
- **Pyth** — the trading schedule from the keyless feed list drives the open-versus-closed
  premium analytic (`stocks/lib/market-hours.mjs`, `stocks-afterhours.json`, shown on every
  card and as a monitor column). Price entitlement on the free tier covers 3 of 244 equity feeds
  and the cards say which source each reference price came from.
- **PreStocks** — every PreStocks token has a card joining their API's mark price, mark
  valuation, token price, implied valuation and supply to on-chain reality: the OPENAI +48.6 %
  rebase (scaled-UI multiplier 1 → 1.4861347 on 2026-07-17) is in the event log and the SPACEX
  mark gap (on-chain 23.6 % below the issuer's mark on 2026-09-17) is the card's banner.
- **Tessera** — the three T-Tokens get sector, issuer-reported holder count, mark price and
  valuation, plus tape coverage of their Meteora pools.

Check at submission whether one entry may be tagged for several bounties.

## Video (≤ 3 minutes)

| Time | Shot |
|---|---|
| 0:00 | `stocks.html` grid: two axes, why TVL is the wrong question |
| 0:20 | Superstate at Level 0 next to xStocks at Level 2: registered share versus ledger-based certificate |
| 0:45 | `cards/SPACEX.html`: warning banner, the issuer's mark versus the on-chain price, and the eleven rules across four health dimensions |
| 1:20 | `monitor.html`: status tiles, worst-rule strip, change log, the OPENAI rebase in the event log |
| 1:50 | Meteora section: DLMM fees and the failed-transaction share on the busy pools |
| 2:10 | `live.html`: the tape, "Go live", the 24 h replay |
| 2:35 | After-hours premium column and a card's open/closed medians |
| 2:50 | URLs and the repository |

## Live site

Deployed on rwasonar.com by `deploy-to-server.sh` (server pulls `main`); the collector
(`rwa-trades`, every 3 hours) and the refresh (`rwa-refresh`, four times a day) run under PM2
from the server clone and publish into the docroot. Keys live only in the server's `.env`.
