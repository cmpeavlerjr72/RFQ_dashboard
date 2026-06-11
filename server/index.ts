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
  getEventMarkets,
  getRfqLegs,
  recoverParlay,
  getSoccerStartData,
  cacheStats as kalshiCacheStats,
  resolveAccount,
  listAccounts,
} from "./kalshi.js";
import {
  getScoreboard,
  getBoxscore,
  getRoster,
  Sport,
  currentETDate,
  cacheStats as espnCacheStats,
  boxscoreCacheStats,
  rosterCacheStats,
} from "./espn.js";
import { getRecap } from "./recap.js";
import { getPartnerRecap, partnerCacheStats } from "./partner.js";
import { getLinesCatalog, getLinesSeries } from "./lines.js";

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

// Which Kalshi account a request targets. Read from ?account=, validated and
// defaulted to MVPeav by resolveAccount() so missing/garbage values are safe.
function acct(req: Request): string {
  return resolveAccount(req.query.account as string | undefined);
}

// Frontend uses this to populate the account switcher.
app.get("/api/accounts", (_req, res) => {
  res.json({ accounts: listAccounts() });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    upstreamCallCount,
    kalshi: kalshiCacheStats(),
    espn: espnCacheStats(),
    boxscore: boxscoreCacheStats(),
    roster: rosterCacheStats(),
    lastError,
  });
});

// ----------------------------------------------------------------------------
// Kalshi endpoints
// ----------------------------------------------------------------------------

app.get("/api/kalshi/balance", async (req, res, next) => {
  try {
    upstreamCallCount++;
    res.json(await getBalance(acct(req)));
  } catch (e) { next(e); }
});

app.get("/api/kalshi/positions", async (req, res, next) => {
  try {
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    res.json(await getPositions(acct(req), force));
  } catch (e) { next(e); }
});

app.get("/api/kalshi/market/:ticker", async (req, res, next) => {
  try {
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    res.json(await getMarket(acct(req), req.params.ticker, force));
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
    res.json(await getMarketsBatch(acct(req), tickers));
  } catch (e) { next(e); }
});

// All strikes under one event ticker (e.g. a game's full total ladder).
app.get("/api/kalshi/event-markets/:eventTicker", async (req, res, next) => {
  try {
    upstreamCallCount++;
    res.json(await getEventMarkets(acct(req), req.params.eventTicker));
  } catch (e) { next(e); }
});

app.get("/api/kalshi/rfq/:rfqId", async (req, res, next) => {
  try {
    upstreamCallCount++;
    res.json(await getRfqLegs(acct(req), req.params.rfqId));
  } catch (e) { next(e); }
});

// Recover legs for an open parlay ticker without needing a local fills file —
// walks fills → order → quote → rfq on Kalshi. Cached forever per ticker.
app.get("/api/kalshi/recover/:ticker", async (req, res, next) => {
  try {
    upstreamCallCount++;
    res.json(await recoverParlay(acct(req), req.params.ticker));
  } catch (e) { next(e); }
});

// Soccer kickoff times + live/final scores from Kalshi, keyed by ML event
// ticker. Lets the frontend show a kickoff time AND the live/final score on
// soccer cards ESPN has no data for (e.g. lower-tier international friendlies).
// Pulled from Kalshi (milestone feed + /live_data), so it works on the Render
// deploy (no local files needed).
app.get("/api/start-times", async (req, res, next) => {
  try {
    upstreamCallCount++;
    const data = await getSoccerStartData(acct(req));
    res.json({ ...data, source: "kalshi-milestone" });
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------------------
// ESPN endpoint
// ----------------------------------------------------------------------------

const VALID_SPORTS: Sport[] = ["mlb", "nhl", "nba", "ufc", "atp", "wta",
  "epl", "laliga", "seriea", "bundesliga", "ligue1", "ucl",
  "wcup", "intlfriendly"];

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

app.get("/api/roster", async (req, res, next) => {
  try {
    const sport = String(req.query.sport || "").toLowerCase() as Sport;
    if (!VALID_SPORTS.includes(sport)) {
      return res.status(400).json({ error: `bad sport: ${sport}` });
    }
    const teamId = String(req.query.teamId || "");
    if (!teamId) return res.status(400).json({ error: "teamId required" });
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    const payload = await getRoster(sport, teamId, force);
    res.json({ sport, teamId, payload, cached_at: new Date().toISOString() });
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------------------
// Fills endpoint — reads local fills.jsonl produced by the runners
// ----------------------------------------------------------------------------

// Per-account local fills file. MVPeav keeps the original FILLS_PATH (default
// data/fills.jsonl); GPeavT (TP) uses FILLS_PATH_SECOND (default
// data/fills_second.jsonl — the runner's actual TP fill log; 2026-06-11 fix:
// the generic fills_<account>.jsonl fallback resolved to a nonexistent
// fills_gpeavt.jsonl, so the TP page NEVER got fill enrichment — no fill
// timestamps and no corr-adjusted win%/EV).
// This file is only an optional fast-path for the live open-positions panel —
// positions + leg recovery come from Kalshi regardless (see kalshi.ts), so a
// missing file just yields {fills: []}, exactly like the deployed MVPeav case.
function fillsPathFor(account: string): string {
  if (account === "MVPeav") {
    return process.env.FILLS_PATH
      ? path.resolve(process.cwd(), process.env.FILLS_PATH)
      : path.resolve(__dirname, "..", "..", "data", "fills.jsonl");
  }
  if (account === "GPeavT") {
    return process.env.FILLS_PATH_SECOND
      ? path.resolve(process.cwd(), process.env.FILLS_PATH_SECOND)
      : path.resolve(__dirname, "..", "..", "data", "fills_second.jsonl");
  }
  // Suffix convention for any future accounts: FILLS_PATH_<ACCOUNT-UPPER>
  const envVar = `FILLS_PATH_${account.toUpperCase()}`;
  if (process.env[envVar]) return path.resolve(process.cwd(), process.env[envVar]!);
  return path.resolve(__dirname, "..", "..", "data", `fills_${account.toLowerCase()}.jsonl`);
}

app.get("/api/fills", (req, res) => {
  const fillsPath = fillsPathFor(acct(req));
  if (!fs.existsSync(fillsPath)) return res.json({ fills: [] });
  try {
    const text = fs.readFileSync(fillsPath, "utf-8");
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
// Recap — historical RFQ performance for an ET date or date range
// ----------------------------------------------------------------------------

app.get("/api/recap", async (req, res, next) => {
  try {
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || start).trim();
    if (!start) return res.status(400).json({ error: "start=YYYY-MM-DD required" });
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    const payload = await getRecap(acct(req), start, end, force);
    res.json(payload);
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------------------
// Partner recap — scrapes http://137.184.206.173:8877/ for side-by-side
// comparison against our own /api/recap. Long TTL (10 min); stale fallback
// on upstream failure rather than throwing. See dashboard/server/partner.ts.
// ----------------------------------------------------------------------------

app.get("/api/partner-recap", async (req, res, next) => {
  try {
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    const payload = await getPartnerRecap(force);
    res.json(payload);
  } catch (e) { next(e); }
});

app.get("/api/partner-recap/health", (_req, res) => {
  res.json(partnerCacheStats());
});

// ----------------------------------------------------------------------------
// Lines tab — Pinnacle/Bovada snapshot archive (public HF dataset; see lines.ts)
// ----------------------------------------------------------------------------

app.get("/api/lines/catalog", async (req, res, next) => {
  try {
    const date = String(req.query.date || "");
    res.json(await getLinesCatalog(date));
  } catch (e) { next(e); }
});

app.get("/api/lines/series", async (req, res, next) => {
  try {
    const date = String(req.query.date || "");
    const id = String(req.query.id || "");
    res.json(await getLinesSeries(date, id));
  } catch (e) { next(e); }
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
  console.log(`  Accounts:    ${listAccounts().join(", ")}`);
  console.log(`  Fills file:  ${fillsPathFor("MVPeav")} (MVPeav)`);
});
