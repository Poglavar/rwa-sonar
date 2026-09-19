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
| `/api/history/overview` | Daily catalogue, summed holder-account, 24 h volume and liquidity series for the public overview |
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
| `/api/claims?issuer=&field=&status=&method=&sort=&order=&limit=&offset=` | Claims from `sonar.claim`, in TRUST order by default, each joined to its source |
| `/api/issuers/:slug/claims` | One issuer's claims plus a per-status summary. 404 when unknown |
| `/api/sources?issuer=&kind=&status=` | The watched URLs from `sonar.source`, with `last_checked_at`, `archive_url` and their claim/version counts |
| `/api/changes?kind=&severity=&issuer=&since=&limit=` | The change feed from `sonar.change_event`, newest first |
| `/api/rules` | The health rule ids with their labels, descriptions and thresholds |
| `/api/failure-modes` | The 38 shared failure modes in catalogue order, each with its actor and flow labels and per-status counts across issuers, plus `missing` |
| `/api/what-if?mode=&issuer=&status=&actor=&flow=&sort=&order=&limit=&offset=` | The what-if answers from `sonar.what_if`, joined to their mode's question and actor and to their source |
| `/api/issuers/:slug/what-if` | One issuer's whole answer sheet: **all 38 modes**, unanswered ones with `status: "missing"`. 404 when unknown |
| `/api/issuers/:slug/chain` | The trust chain rebuilt from the issuer's stored `record`: a node per actor, a link per rights flow with its two grades. 404 when unknown |

### Examples

```bash
curl -s localhost:3300/api/health
# {"ok":true,"now":"…","counts":{"issuers":12,"tokens":471,"snapshots":912,"trades":3000},…}

curl -s localhost:3300/api/history/overview

curl -s 'localhost:3300/api/facets?by=recipe,health' | head -c 400
# {"total":471,…,"facets":{"recipe":[{"value":"token-2022 · pausable","count":230},…]}}

# Every facet at once (26 of them) — the whole navigation state in one request:
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

The 26 filter names are also the 26 facet names, so a facet can never offer a value its own
filter would reject. A comma list is OR (`?issuer=shift,prestocks`); the literal value `null`
means IS NULL, so the null bucket a facet reports is clickable like any other. An **unknown**
parameter name is a `400 unknown_filter`, never silently ignored — a dropped filter returns a
wrong answer that looks right.

Token columns: `issuer`, `instrument`, `recipe`, `program`, `health`, `market_health`,
`control_health`, `legal_health`, `composability_health`, `worst_rule`, `reference`,
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

`sort` is a whitelist — `symbol`, `usd_price`, `liquidity_usd`, `volume24_usd`, `trades24`,
`traders24`, `premium_pct`, `holder_count`, `first_seen_at`, `last_traded_at`, `health_status`,
`market_health`, `control_health`, `legal_health`, `composability_health`, `worst_rule`, `venue_spread_pct`,
`top1_share_pct` — and anything else is a `400 unknown_sort`, not a silent default. NULLs sort last
in both directions. `limit` defaults to 50 and is clamped to 500; `offset` is clamped to ≥ 0.

**`sort=health_status` orders by SEVERITY**, not alphabetically: `good, caution, warning`, then
everything unmeasured. The bare column sorts `caution, good, unknown, warning`, which puts the two
ends of the scale in the middle and makes the column useless as a sort.

### Multi-value filters

A filter takes its values in three forms, and the difference matters for values that contain a
comma:

```
?issuer=shift,prestocks            one occurrence  -> comma list (OR)
?issuer=shift&issuer=prestocks     repeated        -> one value per occurrence, never split
?jurisdiction[]=Cayman, with …     the [] form     -> ONE literal value, never split
```

The `[]` form exists because **six of the nine `jurisdiction` values contain a comma**, so before it
there was no way to filter on them at all — the page listed them with their counts and could not
offer them. A repeated plain parameter is not comma-split either: two occurrences are already two
values, and splitting them would make `?x=a,b&x=c` mean something different from `?x[]=a,b&x[]=c`.
Duplicate values are deduplicated before they reach the `ANY()` array. Every route reads
`c.req.queries()` rather than `c.req.query()`, because the latter keeps only the LAST occurrence —
`?status=a&status=b` would silently filter on `b` alone.

## Consumers

`monitor.html` is the first page to read this API instead of the files. It calls `/api/health`
once, then `/api/facets` (no `by`, so all 26) and `/api/tokens` on every filter change — debounced
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

- **The after-hours gap** is not in the slim row (nor anywhere in the schema), so that one column
  still reads `stocks-afterhours.json`.

Four gaps that were listed here and are now closed (2026-09-18):

- **Rule labels** are served by `/api/rules`, read once at import from the repo-root
  `stocks-health.json`. `monitor.js` still holds its `RULE_LABELS` map, now redundant rather than
  necessary; a test still locks it to the same file.
- **A filter value containing a comma** is expressible through the `[]` form above.
- **`worst_rule`, `venue_spread_pct` and `top1_share_pct` are sortable**, and `monitor.html` offers
  all three.
- **`sort=health_status` orders by severity.**

## Tests

```bash
npm run test:api          # from the repo root; also part of `npm test`
```

- `test/evidence.test.js` — the claim, source and change-event builders, plus the three closed
  gaps: that a comma-bearing value reaches the parameter array and never the SQL text, that a
  repeated parameter is OR rather than last-one-wins, and that the severity CASE is what the
  statement carries.
- `test/query.test.js` and `test/facets.test.js` — the pure builders. No database, no server:
  they assert the generated SQL text and the parameter array, that no user value ever reaches the
  statement text, whitelist rejection, clamping, and the facet-excludes-its-own-filter rule.
- `test/whatif.test.js` — the trust-chain surface: the `failure_mode` / `what_if` builders (an
  unanswered mode must survive the LEFT JOIN, `missing` must be derived and never stored, the
  catalogue `ord` must be the sort), plus the four routes against the real database — including
  that the chain the API serves is byte-identical to the one the builder wrote into
  `stocks-issuers.json`, since both run the same `stocks/lib/trustchain.js`.
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
