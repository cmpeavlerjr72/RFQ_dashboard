# RFQ dashboard

Express proxy + static HTML page that shows Kalshi positions, parlay legs,
and live game state — without hammering Kalshi or ESPN. The server signs
Kalshi requests in Node (RSA-PSS-SHA256) and caches every upstream call with
adaptive TTLs, so even with multiple viewers the proxy makes ~120 Kalshi
calls/hour total.

## Local dev

```sh
npm install
cp .env.example .env
# edit .env with your KALSHI_API_KEY_ID and either KALSHI_PRIVATE_KEY (PEM contents)
# or KALSHI_PRIVATE_KEY_PATH (path to .pem file)
npm run dev
```

Open <http://localhost:8090>.

## Deploy to Render (free web service)

1. Connect this repo as a new Render web service.
2. Pick the **free** plan; runtime auto-detects as Node.
3. Build command: `npm ci && npm run build`
4. Start command: `npm start`
5. Set env vars:
   - `KALSHI_ENV` = `PROD`
   - `KALSHI_API_KEY_ID` = your Kalshi API key id
   - `KALSHI_PRIVATE_KEY` = the entire `.pem` contents (newlines as `\n`),
     **OR** upload `kalshi.pem` as a Render Secret File at `/etc/secrets/kalshi.pem`
     and set `KALSHI_PRIVATE_KEY_PATH=/etc/secrets/kalshi.pem`.

`render.yaml` at the repo root preconfigures the build/start commands; you only
need to fill in the secret env vars.

## ⚠️ Auth before exposing publicly

This proxy holds your signed Kalshi credentials. Anyone who can reach the URL
can query your portfolio (positions, balance, RFQ legs). They cannot place
trades — there is no order endpoint exposed — but the read-only data is
sensitive.

Before pinning the Render URL anywhere, add **basic auth or an IP allowlist**.
The simplest approach is a few lines of Express middleware reading `BASIC_AUTH_USER`
and `BASIC_AUTH_PASS` env vars; happy to add this on request.

## API endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | cache stats, upstream call count, last error |
| `GET /api/kalshi/balance` | cash + portfolio value |
| `GET /api/kalshi/positions[?fresh=1]` | open positions |
| `GET /api/kalshi/market/:ticker` | per-parlay yes_bid/yes_ask/last_price |
| `POST /api/kalshi/markets` | batch market lookup, body `{tickers:[...]}` (max 100/request) |
| `GET /api/kalshi/rfq/:rfq_id` | RFQ legs (disk-cached forever) |
| `GET /api/scoreboard?sport=nba&date=YYYYMMDD` | ESPN scoreboard, adaptive TTL |
| `GET /api/fills` | reads `FILLS_PATH` if set; else empty array |

## Cache TTLs

| Source | TTL |
|---|---|
| `/portfolio/balance` | 30 s |
| `/portfolio/positions` | 30 s |
| `/markets/<ticker>` | 60 s |
| `/communications/rfqs/<rfq_id>` | permanent (memory + disk) |
| ESPN scoreboard | 20 s when live games, 120 s otherwise |

Add `?fresh=1` on any endpoint to force a refetch for one cycle.
