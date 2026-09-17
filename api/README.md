# `api/` — read-only JSON API over schema `sonar`

The site's pages read the built `stocks-*.json` files. This API reads the same data out of
Postgres instead, which lets it answer the questions a file cannot: **any combination of facets**
(issuer × recipe × health × legal form × jurisdiction …), **per-day snapshot history**, and the
**trade tape past the rolling 24 h window** the JSON keeps.

> **One page has been switched over: `monitor.html`.** `stocks.html`, `live.html`, `graph.html`
> and the cards still fetch the static files, exactly as before.

Read-only by construction: every statement is a `SELECT`, there is no route that writes, and no
DDL lives here (the schema is `db/2026-09-17-sonar-stocks.sql`, loaded by `stocks/load-db.mjs`).

## Run it locally

```bash
cd api
npm install                                   # first time only
node --env-file=../.env src/server.js         # reads DATABASE_URL from the repo-root .env
PORT=3399 node --env-file=../.env src/server.js
```

It binds **127.0.0.1 only** — never `0.0.0.0` — on `PORT`, default **3300**. The startup line
reports the database host and name, never the URL:

```
[2026-09-17T14:25:33Z] rwa-sonar-api starting; database localhost:5432/geodata
[2026-09-17T14:25:33Z] schema sonar reachable; 471 tokens
[2026-09-17T14:25:33Z] listening on http://127.0.0.1:3300 (11 routes)
[2026-09-17T14:25:36Z] nj2p0p GET /api/health 200 12.2ms
```

The last line is the per-request format: **request id, method, path+query, status, ms**. A
statement over 500 ms adds a `WARN slow query …` line with the request id above it.

## Routes

All GET, all under `/api`. Every successful response is `Content-Type: application/json` with
`Cache-Control: public, max-age=60`; an error response is `no-store` (caching a 400 for a minute
would hide the fix from the next request) and carries `{"error": {"code", "message"}}`.

| Route | Returns |
|---|---|
| `/api` | The route list |
| `/api/health` | `{ok, now, counts:{issuers,tokens,snapshots,trades}, latestSnapshotDate, latestTradeAt, latestBuildAt}` |
| `/api/facets?by=&<filters>` | `{total, filters, q, facets:{<name>:[{value,count,…}]}}` |
| `/api/tokens?<filters>&q=&sort=&order=&limit=&offset=` | `{total, limit, offset, sort, order, filters, q, items:[slim]}` |
| `/api/tokens/:mint` | Full `record` jsonb + health, issuer summary, `snapshotDates`, `tradesInDb`. 404 when unknown |
| `/api/tokens/:mint/history?days=` | Snapshot rows by date **ascending**, typed columns only |
| `/api/tokens/:mint/trades?limit=&before=` | Trades newest first, keyset cursor |
| `/api/issuers` | Every issuer with grades, status, recipes, `mint_count`, `tokens_in_db`, health counts |
| `/api/issuers/:slug` | Full `record` + its tokens' slim rows + health counts |
| `/api/search?q=` | `{tokens:[≤20 slim], issuers:[≤5]}` |
| `/api/trades/recent?limit=&before=` | The tape, newest first |
| `/api/trades/daily?days=` | Per day per dex: trades, volume, traders, mints, suspect |

### Examples

```bash
curl -s localhost:3300/api/health
# {"ok":true,"now":"…","counts":{"issuers":12,"tokens":471,"snapshots":912,"trades":3000},…}

curl -s 'localhost:3300/api/facets?by=recipe,health' | head -c 400
# {"total":471,…,"facets":{"recipe":[{"value":"token-2022 · pausable","count":230},…]}}

# Every facet at once (22 of them) — the whole navigation state in one request:
curl -s 'localhost:3300/api/facets' | head -c 600

# Warning-status tokens of two issuers, biggest 24 h volume first:
curl -s 'localhost:3300/api/tokens?issuer=ondo-global-markets,xstocks-backed&health=warning&sort=volume24_usd&order=desc&limit=10'

curl -s 'localhost:3300/api/tokens?q=nvda&limit=5'
curl -s 'localhost:3300/api/tokens/XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W' | head -c 300
curl -s 'localhost:3300/api/tokens/XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W/history?days=7'
curl -s 'localhost:3300/api/issuers/prestocks' | head -c 300
curl -s 'localhost:3300/api/search?q=tesla'
curl -s 'localhost:3300/api/trades/daily?days=30'
```

Paginating the tape uses the cursor the previous page hands back — never `OFFSET`, because the
table keeps growing under the client:

```bash
curl -s 'localhost:3300/api/trades/recent?limit=5'          # → "nextBefore":"2026-09-17T09:58:11.000Z,5ZHt4…"
curl -s 'localhost:3300/api/trades/recent?limit=5&before=2026-09-17T09:58:11.000Z,5ZHt4…'
```

### Filters and facets

The 22 filter names are also the 22 facet names, so a facet can never offer a value its own
filter would reject. A comma list is OR (`?issuer=shift,prestocks`); the literal value `null`
means IS NULL, so the null bucket a facet reports is clickable like any other. An **unknown**
parameter name is a `400 unknown_filter`, never silently ignored — a dropped filter returns a
wrong answer that looks right.

Token columns: `issuer`, `instrument`, `recipe`, `program`, `health`, `worst_rule`, `reference`,
`pausable`, `paused`, `clawback`, `allowlist`, `transfer_fee` (`transfer_fee_bps > 0`),
`hook_active`, `seen_in_search`, `first_seen_day` (the UTC day of `first_seen_at`).
Issuer columns, reached by join: `legal_form`, `claim_rung`, `maturity_stage`,
`verification_type`, `key_governance_mint`, `key_governance_freeze`, `jurisdiction`.

**Faceted navigation proper:** a facet's counts exclude *its own* filter and apply every other
one. `?by=health,issuer&health=warning` returns the full health breakdown (so you can switch to
`caution`) and an issuer breakdown of the warning tokens only. `total` is the count matching
*all* filters.

`jurisdiction` is the one awkward facet: it comes from `stock_issuer.entity_jurisdiction`, which
holds researched prose rather than a country code (one issuer's value runs past 700 characters).
The exact string stays in `value` because that is what the filter takes, and a shortened `label`
is added beside it for a chip.

`sort` is a whitelist — `symbol`, `liquidity_usd`, `volume24_usd`, `premium_pct`, `holder_count`,
`first_seen_at`, `last_traded_at`, `health_status` — and anything else is a `400 unknown_sort`,
not a silent default. NULLs sort last in both directions. `limit` defaults to 50 and is clamped
to 500; `offset` is clamped to ≥ 0.

## Consumers

`monitor.html` is the first page to read this API instead of the files. It calls `/api/health`
once, then `/api/facets` (no `by`, so all 22) and `/api/tokens` on every filter change — debounced
150 ms, with a sequence number so a slow earlier answer cannot repaint the table. Its filter state
lives in the page's own query string, which means **a filtered view is a link**:

```
monitor.html?recipe=token-2022%20%C2%B7%20pausable&health=warning&sort=liquidity_usd&page=2
```

Where the API is comes from `stocks/lib/api-base.js` (`window.__rwaApi`): `?api=<origin>` wins,
then `<meta name="rwa-api-base">`, then the empty string — same origin, which is production.
Only an `http(s)://host[:port]` is accepted, so `?api=javascript:…` cannot steer the page's
fetches. `apiUrl(path, params)` builds the query string: an array becomes the comma list this API
reads as OR, `null`/`''` are dropped and `false`/`0` are kept.

**CORS**: `/api/*` answers any origin for `GET`, `HEAD` and `OPTIONS` only, with no credentials.
That is what lets a page on the dev server (`localhost:8113`) call the API on `localhost:3300`;
production is same-origin and never sees the header. Without it the browser reports the block as a
network failure with **no status code**, which looks exactly like the API being down.

What the page needed and this API does not serve, so it is worth knowing before the next page is
switched over:

- **Rule labels.** `worst_rule` is the rule *id* (`keyControl`, `failedTx`). The display names live
  in `stocks/lib/health.mjs` and travel in `stocks-health.json`, not here, so `monitor.js` holds a
  `RULE_LABELS` map that a test compares against that file.
- **The after-hours gap** is not in the slim row (nor anywhere in the schema), so that one column
  still reads `stocks-afterhours.json`.
- **A facet value containing a comma cannot be filtered**, because a comma is the OR separator —
  six of the nine `jurisdiction` values contain one. The page lists them with their counts but does
  not offer them as filters, since asking would silently return zero tokens.
- **`sort=health_status` orders alphabetically**, not by severity: `caution, good, unknown,
  warning`. `worst_rule`, `venue_spread_pct` and `top1_share_pct` are not sortable at all, so those
  columns are not offered as sortable in the table.

## Tests

```bash
npm run test:api          # from the repo root; also part of `npm test`
```

- `test/query.test.js` and `test/facets.test.js` — the pure builders. No database, no server:
  they assert the generated SQL text and the parameter array, that no user value ever reaches the
  statement text, whitelist rejection, clamping, and the facet-excludes-its-own-filter rule.
- `test/routes.integration.test.js` — the app in-process (`app.request()`, no port) against the
  real local database. Skipped with a printed message when `DATABASE_URL` is absent, so:

```bash
set -a; . ./.env; set +a; npm run test:api     # runs the integration suite too
```

## Deployment shape

Wiring the deploy, PM2 and nginx is the orchestrator's job — `deploy-to-server.sh`,
`ecosystem.config.cjs` and `stocks/refresh-on-server.sh` are deliberately untouched here. The
shape it needs:

```js
// ecosystem.config.cjs — a third app beside rwa-trades and rwa-refresh
{
    name: 'rwa-sonar-api',
    cwd: '/root/code/rwa-sonar/api',
    script: 'src/server.js',
    interpreter: 'node',
    // DATABASE_URL is a secret and stays in the clone's .env; --env-file loads it into the
    // process, so it is never in this file and never in a log line.
    node_args: '--env-file=/root/code/rwa-sonar/.env',
    env: { TZ: 'UTC', PORT: 3300 },
    autorestart: true,
    error_file: './logs/rwa-sonar-api-error.log',
    out_file: './logs/rwa-sonar-api-out.log',
    merge_logs: true
}
```

Restart with the **file**, or PM2 re-reads nothing:
`pm2 restart ecosystem.config.cjs --only rwa-sonar-api --update-env`. Then verify from the
process, not the deploy log: `cat /proc/$(pm2 pid rwa-sonar-api)/environ | tr '\0' '\n' | grep -c DATABASE_URL`.

nginx publishes it under the existing static vhost, so the pages can eventually call `/api/…`
same-origin with no CORS:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3300;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

`npm ci` in `api/` on the server: `api/package-lock.json` is committed for exactly that (the
repo-root `.gitignore` un-ignores it), and `api/node_modules/` is not.
