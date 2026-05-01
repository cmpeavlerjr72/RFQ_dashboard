// Express app: Kalshi proxy + ESPN proxy + static frontend.
// All inbound HTTP from the browser; this server is the ONLY thing that talks
// to Kalshi or ESPN. Caches sit in front of every upstream call.

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import compression from "compression";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import {
  getBalance,
  getPositions,
  getMarket,
  getMarketsBatch,
  getRfqLegs,
  recoverParlay,
  cacheStats as kalshiCacheStats,
} from "./kalshi.js";
import {
  getScoreboard,
  getBoxscore,
  Sport,
  currentETDate,
  cacheStats as espnCacheStats,
  boxscoreCacheStats,
} from "./espn.js";

// Load .env from dashboard/.env (next to package.json)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const PORT = Number(process.env.PORT || 8090);

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json({ limit: "1mb" }));

// ----------------------------------------------------------------------------
// Health
// ----------------------------------------------------------------------------

let upstreamCallCount = 0;
let lastError: { ts: number; msg: string } | null = null;

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    upstreamCallCount,
    kalshi: kalshiCacheStats(),
    espn: espnCacheStats(),
    boxscore: boxscoreCacheStats(),
    lastError,
  });
});

// ----------------------------------------------------------------------------
// Kalshi endpoints
// ----------------------------------------------------------------------------

app.get("/api/kalshi/balance", async (_req, res, next) => {
  try {
    upstreamCallCount++;
    res.json(await getBalance());
  } catch (e) { next(e); }
});

app.get("/api/kalshi/positions", async (req, res, next) => {
  try {
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    res.json(await getPositions(force));
  } catch (e) { next(e); }
});

app.get("/api/kalshi/market/:ticker", async (req, res, next) => {
  try {
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    res.json(await getMarket(req.params.ticker, force));
  } catch (e) { next(e); }
});

// Body: {tickers: string[]} -> {ticker: payload, ...}
app.post("/api/kalshi/markets", async (req, res, next) => {
  try {
    const tickers: string[] = Array.isArray(req.body?.tickers) ? req.body.tickers : [];
    if (tickers.length > 100) {
      return res.status(400).json({ error: "max 100 tickers per request" });
    }
    upstreamCallCount++;
    res.json(await getMarketsBatch(tickers));
  } catch (e) { next(e); }
});

app.get("/api/kalshi/rfq/:rfqId", async (req, res, next) => {
  try {
    upstreamCallCount++;
    res.json(await getRfqLegs(req.params.rfqId));
  } catch (e) { next(e); }
});

// Recover legs for an open parlay ticker without needing a local fills file —
// walks fills → order → quote → rfq on Kalshi. Cached forever per ticker.
app.get("/api/kalshi/recover/:ticker", async (req, res, next) => {
  try {
    upstreamCallCount++;
    res.json(await recoverParlay(req.params.ticker));
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------------------
// ESPN endpoint
// ----------------------------------------------------------------------------

const VALID_SPORTS: Sport[] = ["mlb", "nhl", "nba", "ufc", "atp", "wta"];

app.get("/api/scoreboard", async (req, res, next) => {
  try {
    const sport = String(req.query.sport || "mlb").toLowerCase() as Sport;
    if (!VALID_SPORTS.includes(sport)) {
      return res.status(400).json({ error: `bad sport: ${sport}` });
    }
    const date = (req.query.date as string) || currentETDate();
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    const payload = await getScoreboard(sport, date, force);
    res.json({ sport, date, payload, cached_at: new Date().toISOString() });
  } catch (e) { next(e); }
});

app.get("/api/boxscore", async (req, res, next) => {
  try {
    const sport = String(req.query.sport || "mlb").toLowerCase() as Sport;
    if (!VALID_SPORTS.includes(sport)) {
      return res.status(400).json({ error: `bad sport: ${sport}` });
    }
    const eventId = String(req.query.eventId || "");
    if (!eventId) return res.status(400).json({ error: "eventId required" });
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    const payload = await getBoxscore(sport, eventId, force);
    res.json({ sport, eventId, payload, cached_at: new Date().toISOString() });
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------------------
// Fills endpoint — reads local fills.jsonl produced by the runners
// ----------------------------------------------------------------------------

const FILLS_PATH = process.env.FILLS_PATH
  ? path.resolve(process.cwd(), process.env.FILLS_PATH)
  : path.resolve(__dirname, "..", "..", "data", "fills.jsonl");

app.get("/api/fills", (_req, res) => {
  if (!fs.existsSync(FILLS_PATH)) return res.json({ fills: [] });
  try {
    const text = fs.readFileSync(FILLS_PATH, "utf-8");
    const lines = text.split("\n").filter(Boolean);
    const fills = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    res.json({ fills, count: fills.length });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ----------------------------------------------------------------------------
// Static frontend
// ----------------------------------------------------------------------------

const publicDir = path.resolve(__dirname, "..", "public");
app.use(express.static(publicDir));

// SPA-style fallback so deep links still serve index.html
app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ----------------------------------------------------------------------------
// Error handler
// ----------------------------------------------------------------------------

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("ERR:", err?.message || err);
  lastError = { ts: Date.now(), msg: String(err?.message || err) };
  res.status(500).json({ error: "internal", message: String(err?.message || err) });
});

app.listen(PORT, () => {
  console.log(`kalshi-dashboard listening on http://localhost:${PORT}`);
  console.log(`  Kalshi env:  ${process.env.KALSHI_ENV || "PROD"}`);
  console.log(`  Fills file:  ${FILLS_PATH}`);
});
