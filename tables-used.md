# Tables used by this repo

The `sonar` schema in geodata, written by the prod jobs (ecosystem.config.cjs) and read by the API.
`sync-tables` pulls these from prod into the local database. The personal saved-watch tables hold
users' watches and encrypted Telegram chat ids, so they are never copied off prod.

- sonar.stock_issuer
- sonar.stock_token
- sonar.stock_token_snapshot
- sonar.stock_trade
- sonar.what_if
- sonar.mint_state
- sonar.wallet_balance
- sonar.change_event
- sonar.change_judgment
- sonar.review_resolution
- sonar.failure_mode
- sonar.claim
- sonar.source
- sonar.source_version
- sonar.litigation_case
- sonar.litigation_query
- sonar.lending_scan
- sonar.lending_price_freeze
- sonar.lending_liquidation
- sonar.stock_watchlist (local-only)
- sonar.stock_watch_binding (local-only)
- sonar.stock_watch_delivery (local-only)
- sonar.stock_watch_event (local-only)
- sonar.stock_watch_digest_log (local-only)
