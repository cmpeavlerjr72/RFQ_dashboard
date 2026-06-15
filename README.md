# Kalshi RFQ dashboard

Local Express proxy + static HTML page that shows your live Kalshi book without
hammering Kalshi or ESPN. Mirrors the polite-caching pattern from `Monte-Site`.

## Architecture

```
browser ─► Express server ─► (cached) ─► Kalshi /portfolio/*
                          └─► (cached) ─► Kalshi /markets/<ticker>
                          └─► (disk cache) ─► Kalshi /communications/rfqs/*
                          └─► (cached) ─► ESPN scoreboards
                          └─► reads ─► data/fills.jsonl (written by the runners)
```

Browser only ever talks to `localhost:8090`. The server signs Kalshi requests
in Node (RSA-PSS-SHA256, same as `src/quote_client.py`), caches with adaptive
TTLs, and serves the static frontend.

## TTLs

| Source                            | TTL                                     |
|-----------------------------------|------------------------------------------|
| `/portfolio/balance`              | 30 s                                     |
| `/portfolio/positions`            | 30 s                                     |
| `/markets/<ticker>`               | 60 s                                     |
| `/communications/rfqs/<rfq_id>`   | permanent (memory + disk: `data/dashboard_cache/rfq_legs/`) |
| ESPN scoreboard                   | 20 s when live games, 120 s otherwise (matches Monte-Site) |
| `data/fills.jsonl`                | re-read on each `/api/fills` hit (file is tiny) |

`?fresh=1` query param on any endpoint forces a refetch for one cycle.

## Bandwidth budget at steady state

One open browser tab + 5 active games:
- Kalshi: ~120 calls/hour
- ESPN: ~180 calls/hour

100 tabs open simultaneously: still ~120/hour Kalshi and ~180/hour ESPN
(server cache fans out one upstream call to every viewer).

## Setup

```sh
cd dashboard
npm install
cp .env.example .env
# edit .env to set KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PATH
npm run dev          # tsx watch — auto-restart on save
# or
npm run build && npm start
```

Open <http://localhost:8090>.

## Endpoints

| Endpoint                                | Purpose                                       |
|-----------------------------------------|-----------------------------------------------|
| `GET /api/health`                       | cache stats, upstream call count, last error  |
| `GET /api/kalshi/balance`               | cash + portfolio value                        |
| `GET /api/kalshi/positions[?fresh=1]`   | open positions                                |
| `GET /api/kalshi/market/:ticker`        | per-parlay yes_bid/yes_ask/last_price         |
| `POST /api/kalshi/markets`              | batch market lookup, body `{tickers:[...]}`   |
| `GET /api/kalshi/rfq/:rfq_id`           | RFQ legs (disk-cached forever)                |
| `GET /api/scoreboard?sport=mlb&date=…`  | ESPN scoreboard, adaptive TTL                 |
| `GET /api/fills`                        | reads `data/fills.jsonl`                      |

## How fills get into the dashboard

The Python runners write to `data/fills.jsonl` via `src/position_db.py`
immediately after a successful confirm. Schema is in that file's docstring.

To populate from existing run logs:
```sh
python sandbox/backfill_fills_to_hf.py
```

If `HF_TOKEN` is set, the same module mirrors `fills.jsonl` to a Hugging Face
dataset (default `cmpeavlerjr/kalshi-rfq-fills`) on a 5-second debounced
schedule. The dashboard does NOT read from HF directly — it reads the local
file. HF is the ship-it-public mirror.

## Deploy notes (later)

- Move static frontend to Vercel / HF Spaces (cheap CDN)
- Move Express server to Render / Fly / Railway with the Kalshi private key in
  the secrets store, port 8090
- Frontend reads from the deployed server URL instead of `localhost:8090`
- Add basic auth or IP allowlist on the proxy since it has signed Kalshi access
