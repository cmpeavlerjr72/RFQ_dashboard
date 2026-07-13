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
  getTakerInfo,
  getMarket,
  getMarketsBatch,
  getEventMarkets,
  getRfqLegs,
  recoverParlay,
  getSoccerStartData,
  cacheStats as kalshiCacheStats,
  resolveAccount,
  listAccounts,
  DEFAULT_ACCOUNT,
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
import { getRecap, getRecapOverall } from "./recap.js";
import { getFlow } from "./flow.js";
import { getImpFlow } from "./impflow.js";
import { getBuilders } from "./builders.js";
import { getGrids } from "./grids.js";
import { getRester } from "./rester.js";
import { getEngineDiag } from "./engineDiag.js";
import { getUfcAthleteImage } from "./ufcimg.js";
import { getClv } from "./clv.js";
import { getPartnerRecap, partnerCacheStats } from "./partner.js";
import { getLinesCatalog, getLinesSeries } from "./lines.js";
import { getProps } from "./props.js";
import { DASH_ACCOUNTS, byDashboardLabel, PORTFOLIO } from "./accounts.js";
import { getMomentum } from "./momentum.js";

// Load .env from dashboard/.env (next to package.json)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const PORT = Number(process.env.PORT || 8090);
// Branding for THIS instance (the front-end reads /api/config). Two Render
// services, one codebase: MVPeav (peavler) and Sim2Win (heuermann). Override via
// DASH_BRAND / DASH_TITLE env; defaults derive from PORTFOLIO so peavler is
// unchanged ("MVPeav Dashboard").
const DASH_BRAND = process.env.DASH_BRAND ||
  (PORTFOLIO === "peavler" ? "MVPeav"
    : PORTFOLIO === "heuermann" ? "Sim2Win"
    : PORTFOLIO === "beatty" ? "Beatty"
    : (PORTFOLIO === "all" || PORTFOLIO === "admin") ? "Admin"
    : PORTFOLIO);
const DASH_TITLE = process.env.DASH_TITLE || `${DASH_BRAND} Dashboard`;

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json({ limit: "1mb" }));

// ----------------------------------------------------------------------------
// Health
// ----------------------------------------------------------------------------

let upstreamCallCount = 0;
let lastError: { ts: number; msg: string } | null = null;

// "Overall" = a virtual account that aggregates every real account (MP+TP+ROTH):
// summed balance, merged positions, concatenated fills. It has no creds, so the
// account-independent lookups (markets/rfq/recover) sign as the default account.
const OVERALL = "Overall";
const REAL_ACCOUNTS = DASH_ACCOUNTS.map((a) => a.dashboardLabel);
function isOverall(a: string): boolean { return a === OVERALL; }
// Which Kalshi account a request targets. Read from ?account=, validated and
// defaulted to MVPeav by resolveAccount(); "Overall" passes through verbatim.
function acct(req: Request): string {
  const raw = String(req.query.account || "");
  return raw === OVERALL ? OVERALL : resolveAccount(raw);
}
// For account-independent reads (market price, RFQ legs) under Overall, sign as
// a single real account — the data is the same regardless of which.
function signAcct(a: string): string { return isOverall(a) ? DEFAULT_ACCOUNT : a; }

// Frontend uses this to populate the account switcher (+ the Overall aggregate).
app.get("/api/accounts", (_req, res) => {
  res.json({ accounts: [...listAccounts(), OVERALL] });
});

// Per-instance branding/identity so the SAME front-end renders as MVPeav or
// Sim2Win purely from env (no code fork). brand.js reads this on every page.
app.get("/api/config", (_req, res) => {
  res.json({ portfolio: PORTFOLIO, brand: DASH_BRAND, title: DASH_TITLE });
});

// Live FotMob match-momentum per WC game (keyed by Kalshi chunk, +=home).
app.get("/api/momentum", async (_req, res) => {
  try { res.json(await getMomentum()); }
  catch { res.json({ games: {} }); }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    // Deployed commit (Render injects RENDER_GIT_COMMIT at build) — lets us verify
    // exactly which commit is live instead of inferring from behavior.
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "local",
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

// Overall = sum balance + portfolio_value across every real account.
async function combinedBalance() {
  const bals = await Promise.all(REAL_ACCOUNTS.map((a) => getBalance(a).catch(() => ({}))));
  const bal = bals.reduce((s, b: any) => s + (Number(b.balance) || 0), 0);
  const pv = bals.reduce((s, b: any) => s + (Number(b.portfolio_value) || 0), 0);
  return { balance: bal, portfolio_value: pv, balance_dollars: (bal / 100).toFixed(4),
           updated_ts: Math.floor(Date.now() / 1000) };
}

// Overall = merge every real account's (already taker-filtered) positions,
// summing size + exposure for any parlay held in more than one account.
async function combinedPositions(force: boolean) {
  const all = await Promise.all(REAL_ACCOUNTS.map((a) => getPositions(a, force).catch(() => ({}))));
  const byTicker = new Map<string, any>();
  const events: any[] = [];
  for (const p of all as any[]) {
    for (const m of (p.market_positions || [])) {
      const prev = byTicker.get(m.ticker);
      if (prev) {
        prev.position_fp = String((Number(prev.position_fp) || 0) + (Number(m.position_fp) || 0));
        prev.position = (Number(prev.position) || 0) + (Number(m.position) || 0);
        prev.market_exposure_dollars =
          (Number(prev.market_exposure_dollars) || 0) + (Number(m.market_exposure_dollars) || 0);
      } else { byTicker.set(m.ticker, { ...m }); }
    }
    for (const e of (p.event_positions || [])) events.push(e);
  }
  return { market_positions: [...byTicker.values()], event_positions: events, cursor: "" };
}

app.get("/api/kalshi/balance", async (req, res, next) => {
  try {
    upstreamCallCount++;
    const a = acct(req);
    res.json(isOverall(a) ? await combinedBalance() : await getBalance(a));
  } catch (e) { next(e); }
});

app.get("/api/kalshi/positions", async (req, res, next) => {
  try {
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    const a = acct(req);
    res.json(isOverall(a) ? await combinedPositions(force) : await getPositions(a, force));
  } catch (e) { next(e); }
});

// Taker/maker contract counts per ticker (recent fills) — TAKER pill data.
app.get("/api/kalshi/taker-info", async (req, res, next) => {
  try {
    upstreamCallCount++;
    const a = acct(req);
    if (isOverall(a)) {
      const parts = await Promise.all(
        REAL_ACCOUNTS.map((x) => getTakerInfo(x).catch(() => ({ tickers: {} }))),
      );
      const tickers: Record<string, { taker_ct: number; maker_ct: number }> = {};
      for (const part of parts as any[]) {
        for (const [tk, v] of Object.entries((part && part.tickers) || {})) {
          const row = tickers[tk] || (tickers[tk] = { taker_ct: 0, maker_ct: 0 });
          row.taker_ct += Number((v as any).taker_ct) || 0;
          row.maker_ct += Number((v as any).maker_ct) || 0;
        }
      }
      return res.json({ tickers });
    }
    res.json(await getTakerInfo(a));
  } catch (e) { next(e); }
});

app.get("/api/kalshi/market/:ticker", async (req, res, next) => {
  try {
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    res.json(await getMarket(signAcct(acct(req)), req.params.ticker, force));
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
    res.json(await getMarketsBatch(signAcct(acct(req)), tickers));
  } catch (e) { next(e); }
});

// All strikes under one event ticker (e.g. a game's full total ladder).
app.get("/api/kalshi/event-markets/:eventTicker", async (req, res, next) => {
  try {
    upstreamCallCount++;
    res.json(await getEventMarkets(signAcct(acct(req)), req.params.eventTicker));
  } catch (e) { next(e); }
});

app.get("/api/kalshi/rfq/:rfqId", async (req, res, next) => {
  try {
    upstreamCallCount++;
    res.json(await getRfqLegs(signAcct(acct(req)), req.params.rfqId));
  } catch (e) { next(e); }
});

// Recover legs for an open parlay ticker without needing a local fills file —
// walks fills → order → quote → rfq on Kalshi. Cached forever per ticker.
app.get("/api/kalshi/recover/:ticker", async (req, res, next) => {
  try {
    upstreamCallCount++;
    const a = acct(req);
    if (isOverall(a)) {
      // The parlay may belong to any real account — try each, take the first hit.
      for (const label of REAL_ACCOUNTS) {
        try {
          const r: any = await recoverParlay(label, req.params.ticker);
          if (r && Array.isArray(r.legs) && r.legs.length) return res.json(r);
        } catch { /* try next account */ }
      }
      return res.json({ legs: [] });
    }
    res.json(await recoverParlay(a, req.params.ticker));
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

const VALID_SPORTS: Sport[] = ["mlb", "nhl", "nba", "wnba", "ufc", "atp", "wta",
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

// UFC.com athlete full-body image (hero cutout) — cached server-side lookup.
app.get("/api/ufc/athlete-image", async (req, res, next) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    const url = await getUfcAthleteImage(name);
    res.json({ name, url });
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
// Account -> fills file + env override come from the registry (accounts.json):
// the override var is FILLS_PATH<env_suffix>, matching the credential vars
// (MVPeav -> FILLS_PATH, GPeavT -> FILLS_PATH_SECOND, ROTH -> FILLS_PATH_ROTH).
function fillsPathFor(account: string): string {
  const a = byDashboardLabel(account);
  const fillsFile = a ? a.fillsFile : `fills_${account.toLowerCase()}.jsonl`;
  const envVar = `FILLS_PATH${a ? a.envSuffix : "_" + account.toUpperCase()}`;
  if (process.env[envVar]) return path.resolve(process.cwd(), process.env[envVar]!);
  return path.resolve(__dirname, "..", "..", "data", fillsFile);
}

// Deployed (Render) fallback: the home box mirrors both fill logs, gzipped,
// to the PRIVATE HF dataset mvpeav/kalshi-rfq-fills every 5 min
// (sandbox/fills_hf_sync.py — KalshiRFQ_FillsHFSync). Private because fills
// are the live trading book; Render authenticates with the HF_TOKEN env var.
// This is what lets the deployed dashboard show fill-enriched parlay cards
// (fill timestamps + the corr-adjusted win%/EV chip, 2026-06-11). No token
// or missing repo file -> {fills: []}, the pre-existing deployed behavior.
// HF fills repo is PER PORTFOLIO so each book's dashboard reads only its own
// fills (Sim2Win sets HF_FILLS_REPO=mvpeav/kalshi-rfq-fills-heuermann). Default
// is peavler's repo, so MVPeav is unchanged.
const HF_FILLS_REPO = process.env.HF_FILLS_REPO || "mvpeav/kalshi-rfq-fills";
const HF_FILLS_BASE =
  `https://huggingface.co/datasets/${HF_FILLS_REPO}/resolve/main`;
// account dashboard label -> gzipped name on the HF mirror (from accounts.json).
const HF_FILLS_NAME: Record<string, string> = Object.fromEntries(
  DASH_ACCOUNTS.filter((a) => a.hfName).map((a) => [a.dashboardLabel, a.hfName]),
);
// 20s (was 60): the home box now mirrors fills EVENT-DRIVEN (notifier kicks
// the sync on each verified fill, q5min task is just a backstop), so the
// server cache is the next-largest term in corr-chip latency on Render.
const HF_FILLS_TTL_MS = 20 * 1000;
const hfFillsCache = new Map<string, { fetchedAt: number; fills: any[] }>();

async function hfFills(account: string): Promise<any[]> {
  const name = HF_FILLS_NAME[account];
  const token = process.env.HF_TOKEN;
  if (!name || !token) return [];
  const cached = hfFillsCache.get(account);
  if (cached && Date.now() - cached.fetchedAt < HF_FILLS_TTL_MS) return cached.fills;
  try {
    const resp = await fetch(`${HF_FILLS_BASE}/${name}`, {
      redirect: "follow",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return cached ? cached.fills : []; // keep stale on HF error
    const { gunzipSync } = await import("node:zlib");
    const text = gunzipSync(Buffer.from(await resp.arrayBuffer())).toString("utf-8");
    const fills = text.split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    hfFillsCache.set(account, { fetchedAt: Date.now(), fills });
    return fills;
  } catch {
    return cached ? cached.fills : [];
  }
}

// One real account's fills — local file if present (home), else the HF mirror.
async function fetchAccountFills(account: string): Promise<any[]> {
  const fillsPath = fillsPathFor(account);
  if (!fs.existsSync(fillsPath)) return await hfFills(account);
  try {
    return fs.readFileSync(fillsPath, "utf-8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

app.get("/api/fills", async (req, res) => {
  try {
    const account = acct(req);
    if (isOverall(account)) {
      const per = await Promise.all(REAL_ACCOUNTS.map((a) => fetchAccountFills(a)));
      const fills = per.flat();
      return res.json({ fills, count: fills.length, source: "overall" });
    }
    const fills = await fetchAccountFills(account);
    res.json({ fills, count: fills.length });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ----------------------------------------------------------------------------
// Recap — historical RFQ performance for an ET date or date range
// ----------------------------------------------------------------------------

app.get("/api/flow", async (req, res, next) => {
  try {
    const date = String(req.query.date || "").trim();
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    res.json(await getFlow(date, force));
  } catch (e) { next(e); }
});

// Impossible-flow: the firehose of structurally-impossible RFQs across all games
// (incl. ones we don't quote), per game with a per-shape clearing table.
app.get("/api/impflow", async (req, res, next) => {
  try {
    const date = String(req.query.date || "").trim();
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    res.json(await getImpFlow(date, force));
  } catch (e) { next(e); }
});

// Builder profiles (admin-only): per-counterparty impossible-parlay RFQ creators.
app.get("/api/builders", async (req, res, next) => {
  try {
    const date = String(req.query.date || "").trim();
    const force = String(req.query.fresh || "") === "1";
    res.json(await getBuilders(date, force));
  } catch (e) { next(e); }
});

// Same-game quadrant grids (admin-only): grid-tester feasibility snapshots.
app.get("/api/grids", async (req, res, next) => {
  try {
    res.json(await getGrids(String(req.query.fresh || "") === "1"));
  } catch (e) { next(e); }
});

// Our resting book (admin-only): our resting impossible-parlay orders + top markets,
// rendered as the Flow-tab "Our Resting Book" panel.
app.get("/api/rester", async (req, res, next) => {
  try {
    const date = String(req.query.date || "").trim();
    const force = String(req.query.fresh || "") === "1";
    res.json(await getRester(date, force));
  } catch (e) { next(e); }
});

// Engine diagnostics (admin-only): live pinmaker telemetry — machine-vs-game
// attribution, fill ledger with edge-at-fill, rails audit. Flow-tab panel.
app.get("/api/engine-diag", async (req, res, next) => {
  try {
    const date = String(req.query.date || "").trim();
    const force = String(req.query.fresh || "") === "1";
    res.json(await getEngineDiag(date, force));
  } catch (e) { next(e); }
});

// CLV vs Pinnacle close (recap tab). Maps the selected account (dashboardLabel /
// Overall) to the producer's account keys, scoped to THIS dashboard's portfolio.
app.get("/api/clv", async (req, res, next) => {
  try {
    const date = String(req.query.date || "").trim();
    const force = String(req.query.fresh || "") === "1";
    const a = acct(req);
    const keys = isOverall(a)
      ? DASH_ACCOUNTS.map((x) => x.key)
      : ([byDashboardLabel(a)?.key].filter(Boolean) as string[]);
    upstreamCallCount++;
    res.json(await getClv(date, keys, a, force));
  } catch (e) { next(e); }
});

app.get("/api/recap", async (req, res, next) => {
  try {
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || start).trim();
    if (!start) return res.status(400).json({ error: "start=YYYY-MM-DD required" });
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    const a = acct(req);
    const payload = isOverall(a)
      ? await getRecapOverall(REAL_ACCOUNTS, start, end, force)
      : await getRecap(a, start, end, force);
    res.json(payload);
  } catch (e) { next(e); }
});

// Prop maker book: our live MLB RBI/HR positions + resting orders, grouped
// into game cards with live ESPN scores. See dashboard/server/props.ts.
app.get("/api/props", async (req, res, next) => {
  try {
    const force = String(req.query.fresh || "") === "1";
    upstreamCallCount++;
    res.json(await getProps(acct(req), force));
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
  console.log(`  Portfolio:   ${PORTFOLIO}  (${DASH_TITLE})`);
  console.log(`  Kalshi env:  ${process.env.KALSHI_ENV || "PROD"}`);
  console.log(`  HF fills:    ${HF_FILLS_REPO}`);
  console.log(`  Accounts:    ${listAccounts().join(", ") || "(none yet)"}`);
  console.log(`  Fills file:  ${fillsPathFor(DEFAULT_ACCOUNT)} (${DEFAULT_ACCOUNT})`);
});
