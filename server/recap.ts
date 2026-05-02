// Recap: pull /portfolio/fills + /portfolio/settlements for an ET-date range,
// group fills by parlay ticker, compute per-parlay cost / qty / pnl, and
// return aggregates. Mirrors sandbox/recap_kalshi_api_v2.py and recap_yesterday.py.
//
// Filter convention: a parlay belongs to the recap range if its FIRST FILL
// time falls inside [startEt 00:00, endEt 24:00) — i.e., the day we took the
// risk, regardless of when it later settled.

import { getJson, getMarketsBatch } from "./kalshi.js";
import { TTLCache } from "./cache.js";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface KalshiFill {
  ticker?: string;
  market_ticker?: string;
  created_time?: string;       // ISO8601, UTC
  side?: "yes" | "no" | string;
  count?: number;
  count_fp?: string;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  order_id?: string;
}

export interface KalshiSettlement {
  ticker?: string;
  market_result?: string;       // "yes" | "no" | "void" | ""
  settled_time?: string;
}

export interface RecapLeg {
  ticker: string;        // leg market_ticker (e.g. KXMLBSPREAD-26MAY02...-NYY)
  side: string;          // buyer-side label from /markets ("yes"|"no")
}

export interface ParlayRow {
  parlay_ticker: string;
  first_fill_iso: string;       // earliest fill timestamp (UTC ISO)
  side: string;                 // "yes" | "no" — the side WE took
  qty: number;                  // total contracts
  cost: number;                 // $ deployed (sum of count * price_dollars on our side)
  result: string | null;        // "yes" | "no" | "void" | null if unsettled
  pnl: number | null;           // realized $ pnl, null if unsettled
  status: "open" | "won" | "lost" | "void";
  settled_time_iso: string | null;
  n_fills: number;
  legs: RecapLeg[];             // leg tickers from /markets/{tk}.mve_selected_legs
  sub_title: string;            // text fallback if logos can't be derived
}

export interface DailyRow {
  date: string;             // YYYY-MM-DD ET
  n_parlays: number;
  cash_deployed: number;
  settled_cost: number;     // cost component of settled parlays only (denominator for ROI)
  realized_pnl: number;     // pnl of settled parlays
  cum_cash_deployed: number;
  cum_settled_cost: number;
  cum_realized_pnl: number;
  cum_roi_pct: number | null;
}

export type ConfidenceLevel = "none" | "noise" | "early" | "likely_real";

export interface ConfidenceInfo {
  level: ConfidenceLevel;
  label: string;                // plain-language label
  settled: number;
  // Friendly tooltip phrase. Hides Z/SE behind plain language.
  tooltip: string;
}

export interface RecapAgg {
  n_parlays: number;
  cash_deployed: number;        // sum cost of all parlays in range
  settled_count: number;
  open_count: number;
  wins: number;
  losses: number;
  voids: number;
  realized_pnl: number;         // sum pnl of settled parlays
  payouts: number;              // gross "money won": for winners, qty*1.0
  roi_pct: number | null;       // 100 * realized_pnl / cost_of_settled
  confidence: ConfidenceInfo;
}

export interface BreakdownTypeRow {
  type: "player" | "game";      // any-player-leg = player; otherwise game
  parlay_tickers: string[];     // members; frontend uses these for logo derivation
  agg: RecapAgg;
}

export interface SportBreakdownRow {
  sport: string;                // "NBA" | "MLB" | "NHL" | ... | "CROSS"
  parlay_tickers: string[];
  agg: RecapAgg;
  by_type: BreakdownTypeRow[];  // present types only, ordered player then game
}

export interface RecapResult {
  start_et: string;             // YYYY-MM-DD
  end_et: string;               // YYYY-MM-DD (inclusive)
  agg: RecapAgg;
  parlays: ParlayRow[];         // sorted by first_fill desc
  daily: DailyRow[];            // one row per ET day in range, asc; with cumulative cols
  sport_breakdown: SportBreakdownRow[];  // sorted by # parlays desc
  fetched_at: string;
  pages_fills: number;
  pages_settlements: number;
}

// ----------------------------------------------------------------------------
// Date helpers — ET day boundaries in UTC
// ----------------------------------------------------------------------------

// Approx ET → UTC offset. ET = UTC-4 during DST (Mar–Nov), UTC-5 in winter.
// Today's date is in May → DST applies. For the date ranges this dashboard
// would realistically be queried for (recent runs), DST is in effect; the
// recap_kalshi_api_v2.py reference also hard-codes a 4h shift (line 29-30).
// If we ever care about pre-DST history we can use a tz library, but for now
// we hardcode ET = UTC-4 to match the existing recap script.
const ET_UTC_OFFSET_HOURS = 4;

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** start of ET day in UTC ms */
function etDayStartUtcMs(ymd: string): number {
  // ymd 2026-04-30 → 2026-04-30T04:00:00Z
  return Date.parse(`${ymd}T${String(ET_UTC_OFFSET_HOURS).padStart(2, "0")}:00:00Z`);
}

/** start of NEXT ET day in UTC ms (i.e., end-exclusive of ymd) */
function etDayEndUtcMs(ymd: string): number {
  return etDayStartUtcMs(ymd) + 24 * 3600 * 1000;
}

function parseIsoMs(s: string | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

// ----------------------------------------------------------------------------
// Pagination — fills (newest first) until we go past startUtcMs
// ----------------------------------------------------------------------------

async function fetchFillsBack(startUtcMs: number, maxPages = 30): Promise<{ fills: KalshiFill[]; pages: number }> {
  const out: KalshiFill[] = [];
  let cursor = "";
  let pages = 0;
  for (let i = 0; i < maxPages; i++) {
    const q = "/portfolio/fills?limit=200" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const body = await getJson(q);
    pages++;
    const page: KalshiFill[] = body?.fills || [];
    out.push(...page);
    cursor = body?.cursor || "";
    if (!page.length || !cursor) break;
    // Stop once oldest fill on the page is before our window
    const oldest = page[page.length - 1]?.created_time;
    const oldestMs = parseIsoMs(oldest);
    if (oldestMs !== null && oldestMs < startUtcMs) break;
  }
  return { fills: out, pages };
}

async function fetchSettlementsBack(startUtcMs: number, maxPages = 30): Promise<{ settles: KalshiSettlement[]; pages: number }> {
  const out: KalshiSettlement[] = [];
  let cursor = "";
  let pages = 0;
  for (let i = 0; i < maxPages; i++) {
    const q = "/portfolio/settlements?limit=200" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const body = await getJson(q);
    pages++;
    const page: KalshiSettlement[] = body?.settlements || [];
    out.push(...page);
    cursor = body?.cursor || "";
    if (!page.length || !cursor) break;
    // Stop once oldest settlement on the page is well before window. We allow
    // an extra day of slack since settlements lag fills.
    const oldest = page[page.length - 1]?.settled_time;
    const oldestMs = parseIsoMs(oldest);
    if (oldestMs !== null && oldestMs < startUtcMs - 24 * 3600 * 1000) break;
  }
  return { settles: out, pages };
}

// ----------------------------------------------------------------------------
// Per-parlay aggregation
// ----------------------------------------------------------------------------

/** Derive ET-day (YYYY-MM-DD) from a UTC ISO timestamp. */
function etDayOf(iso: string): string {
  const ms = parseIsoMs(iso);
  if (ms === null) return "";
  const shifted = new Date(ms - ET_UTC_OFFSET_HOURS * 3600 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/** Inclusive ET-day list between two YYYY-MM-DD strings. */
function dateRangeEt(startEt: string, endEt: string): string[] {
  const out: string[] = [];
  let cur = etDayStartUtcMs(startEt);
  const end = etDayStartUtcMs(endEt);
  while (cur <= end) {
    const d = new Date(cur + ET_UTC_OFFSET_HOURS * 3600 * 1000); // back to ET-midnight wall time
    // We want the ET wall date; cur is UTC at ET-midnight, so re-add offset & format
    const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    out.push(ymd);
    cur += 24 * 3600 * 1000;
  }
  return out;
}

function buildDaily(rows: ParlayRow[], startEt: string, endEt: string): DailyRow[] {
  const days = dateRangeEt(startEt, endEt);
  const byDay = new Map<string, ParlayRow[]>();
  for (const d of days) byDay.set(d, []);
  for (const r of rows) {
    const d = etDayOf(r.first_fill_iso);
    if (byDay.has(d)) byDay.get(d)!.push(r);
  }
  let cumCash = 0, cumSettledCost = 0, cumPnl = 0;
  const out: DailyRow[] = [];
  for (const d of days) {
    const dayRows = byDay.get(d) || [];
    const cash = dayRows.reduce((a, r) => a + r.cost, 0);
    const settled = dayRows.filter((r) => r.pnl !== null);
    const settledCost = settled.reduce((a, r) => a + r.cost, 0);
    const pnl = settled.reduce((a, r) => a + (r.pnl || 0), 0);
    cumCash += cash;
    cumSettledCost += settledCost;
    cumPnl += pnl;
    out.push({
      date: d,
      n_parlays: dayRows.length,
      cash_deployed: cash,
      settled_cost: settledCost,
      realized_pnl: pnl,
      cum_cash_deployed: cumCash,
      cum_settled_cost: cumSettledCost,
      cum_realized_pnl: cumPnl,
      cum_roi_pct: cumSettledCost > 0 ? (100 * cumPnl) / cumSettledCost : null,
    });
  }
  return out;
}

function aggregateParlay(parlayTicker: string, fills: KalshiFill[], settle?: KalshiSettlement): ParlayRow {
  // Side = the side we took — use the first fill's side
  const sorted = [...fills].sort((a, b) =>
    String(a.created_time || "").localeCompare(String(b.created_time || ""))
  );
  const first = sorted[0];
  const side = String(first?.side || "no").toLowerCase();
  const firstFillIso = String(first?.created_time || "");

  let qty = 0;
  let cost = 0;
  for (const f of fills) {
    const c = parseFloat(f.count_fp || "") || (f.count ?? 0);
    qty += c;
    const priceStr = side === "yes" ? f.yes_price_dollars : f.no_price_dollars;
    const price = parseFloat(priceStr || "0") || 0;
    cost += c * price;
  }

  const result = settle?.market_result || null;
  let pnl: number | null = null;
  let status: ParlayRow["status"] = "open";
  if (!result) {
    pnl = null;
    status = "open";
  } else if (result === "void") {
    pnl = 0;
    status = "void";
  } else if (result === side) {
    pnl = qty * 1.0 - cost;
    status = "won";
  } else {
    pnl = -cost;
    status = "lost";
  }

  return {
    parlay_ticker: parlayTicker,
    first_fill_iso: firstFillIso,
    side,
    qty,
    cost,
    result,
    pnl,
    status,
    settled_time_iso: settle?.settled_time || null,
    n_fills: fills.length,
    legs: [],          // populated later by enrichLegs
    sub_title: "",
  };
}

// Match Kalshi market-ticker prefix to extract (sport, statCode).
// e.g. KXNBAPTS-...  -> sport=NBA, stat=PTS (player prop)
//      KXMLBSPREAD-... -> sport=MLB, stat=SPREAD (game-level)
const LEG_SPORT_RE = /^KX(NBA|MLB|NHL|NFL|WNBA|NCAA[A-Z]*|UFC|GOLF|F1|TENNIS|MLS|EPL|SOCCER)([A-Z0-9]+)-/;
const GAME_LEVEL_STATS = new Set(["GAME", "SPREAD", "TOTAL", "F5", "F5SPREAD", "F5TOTAL", "TEAMTOTAL", "RFI", "GOAL"]);

function classifyParlay(legs: RecapLeg[]): { sport: string; type: "player" | "game" } {
  const sports = new Set<string>();
  let hasPlayer = false, hasGame = false;
  for (const l of legs) {
    const m = l.ticker.match(LEG_SPORT_RE);
    if (!m) continue;
    sports.add(m[1]);
    if (GAME_LEVEL_STATS.has(m[2])) hasGame = true;
    else hasPlayer = true;
  }
  const sport = sports.size === 0 ? "UNKNOWN" : sports.size === 1 ? Array.from(sports)[0] : "CROSS";
  // A parlay with any player-prop leg is a "player" parlay; otherwise game-level.
  const type: "player" | "game" = hasPlayer ? "player" : "game";
  return { sport, type };
}

function buildSportBreakdown(rows: ParlayRow[]): SportBreakdownRow[] {
  const bySport = new Map<string, ParlayRow[]>();
  const byBucket = new Map<string, ParlayRow[]>();   // key = "${sport}|${type}"
  for (const r of rows) {
    const { sport, type } = classifyParlay(r.legs);
    if (!bySport.has(sport)) bySport.set(sport, []);
    bySport.get(sport)!.push(r);
    const bk = `${sport}|${type}`;
    if (!byBucket.has(bk)) byBucket.set(bk, []);
    byBucket.get(bk)!.push(r);
  }
  const out: SportBreakdownRow[] = [];
  for (const [sport, sportRows] of bySport) {
    const byType: BreakdownTypeRow[] = [];
    for (const t of ["player", "game"] as const) {
      const tRows = byBucket.get(`${sport}|${t}`) || [];
      if (!tRows.length) continue;
      byType.push({
        type: t,
        parlay_tickers: tRows.map((r) => r.parlay_ticker),
        agg: aggregateAll(tRows),
      });
    }
    out.push({
      sport,
      parlay_tickers: sportRows.map((r) => r.parlay_ticker),
      agg: aggregateAll(sportRows),
      by_type: byType,
    });
  }
  // Sort: most-parlays first, but always push UNKNOWN/CROSS to the bottom of their tier.
  out.sort((a, b) => {
    const rank = (s: string) => (s === "CROSS" ? 1 : s === "UNKNOWN" ? 2 : 0);
    if (rank(a.sport) !== rank(b.sport)) return rank(a.sport) - rank(b.sport);
    return b.parlay_tickers.length - a.parlay_tickers.length;
  });
  return out;
}

/** Pull /markets/{tk}.mve_selected_legs for each parlay and stuff legs+sub_title onto the row. */
async function enrichLegs(rows: ParlayRow[]): Promise<void> {
  if (rows.length === 0) return;
  const tickers = rows.map((r) => r.parlay_ticker);
  const markets = await getMarketsBatch(tickers);
  for (const r of rows) {
    const payload = markets[r.parlay_ticker];
    const m = payload?.market || payload;
    if (!m || payload?.error) continue;
    const legs: any[] = m?.mve_selected_legs || [];
    r.legs = legs
      .map((l) => ({
        ticker: String(l?.market_ticker || ""),
        side: String(l?.side || "yes").toLowerCase(),
      }))
      .filter((l) => l.ticker);
    r.sub_title = String(m?.no_sub_title || m?.yes_sub_title || "");
  }
}

// Per-parlay ROI standard deviation, derived empirically from our long-NO
// fill profile (avg yes_prob ~ 0.27 → NO wins ~73%, avg no_price ~0.75).
// Covers asymmetric +30-40% / -100% returns. Approximation is fine for chip
// thresholds — the tiers are coarse on purpose.
const PER_PARLAY_ROI_SIGMA = 0.63;

function classifyConfidence(roiPct: number | null, settled: number): ConfidenceInfo {
  if (settled === 0) {
    return {
      level: "none",
      label: "no data",
      settled,
      tooltip: "No settled parlays yet — wait for results to land.",
    };
  }
  if (settled < 10) {
    return {
      level: "noise",
      label: "Too early",
      settled,
      tooltip: `Only ${settled} settled — too small to read anything from. Watch this one.`,
    };
  }
  // Z-score of observed ROI vs zero, using assumed per-parlay sigma.
  const roi = (roiPct ?? 0) / 100;
  const se = PER_PARLAY_ROI_SIGMA / Math.sqrt(settled);
  const z = Math.abs(roi) / Math.max(se, 1e-9);
  if (z < 1) {
    return {
      level: "noise",
      label: "Noise",
      settled,
      tooltip: `${settled} settled — result is indistinguishable from random luck so far.`,
    };
  }
  if (z < 2) {
    return {
      level: "early",
      label: "Early signal",
      settled,
      tooltip: `${settled} settled — direction is emerging but not proven yet. Need a few hundred more to be sure.`,
    };
  }
  return {
    level: "likely_real",
    label: "Likely real",
    settled,
    tooltip: `${settled} settled — evidence is meaningfully strong. Edge appears real.`,
  };
}

function aggregateAll(rows: ParlayRow[]): RecapAgg {
  const n = rows.length;
  const cash = rows.reduce((a, r) => a + r.cost, 0);
  const settled = rows.filter((r) => r.pnl !== null);
  const wins = settled.filter((r) => r.status === "won");
  const losses = settled.filter((r) => r.status === "lost");
  const voids = settled.filter((r) => r.status === "void");
  const pnl = settled.reduce((a, r) => a + (r.pnl || 0), 0);
  const settledCost = settled.reduce((a, r) => a + r.cost, 0);
  const payouts = wins.reduce((a, r) => a + r.qty, 0);
  const roiPct = settledCost > 0 ? (100 * pnl) / settledCost : null;
  return {
    n_parlays: n,
    cash_deployed: cash,
    settled_count: settled.length,
    open_count: n - settled.length,
    wins: wins.length,
    losses: losses.length,
    voids: voids.length,
    realized_pnl: pnl,
    payouts,
    roi_pct: roiPct,
    confidence: classifyConfidence(roiPct, settled.length),
  };
}

// ----------------------------------------------------------------------------
// Public entry
// ----------------------------------------------------------------------------

const recapCache = new TTLCache<RecapResult>();

function ttlFor(endEt: string): number {
  // If end date is today (ET) or in the future, cache short — fills/settlements
  // still landing. Otherwise cache longer.
  const todayEt = currentEtDate();
  return endEt >= todayEt ? 60_000 : 5 * 60_000;
}

function currentEtDate(): string {
  const now = new Date();
  // Shift to ET by subtracting offset
  const ms = now.getTime() - ET_UTC_OFFSET_HOURS * 3600 * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function getRecap(startEt: string, endEt: string, force = false): Promise<RecapResult> {
  if (!isYmd(startEt) || !isYmd(endEt)) {
    throw new Error(`bad date format (expected YYYY-MM-DD): start=${startEt} end=${endEt}`);
  }
  if (endEt < startEt) {
    throw new Error(`end (${endEt}) is before start (${startEt})`);
  }

  const key = `${startEt}|${endEt}`;
  if (force) recapCache.set(key, undefined as any, 0);

  return recapCache.getOrFetch(
    key,
    async () => {
      const startUtcMs = etDayStartUtcMs(startEt);
      const endUtcMs = etDayEndUtcMs(endEt);

      const { fills, pages: pagesFills } = await fetchFillsBack(startUtcMs);
      const { settles, pages: pagesSettle } = await fetchSettlementsBack(startUtcMs);

      // Group fills by parlay ticker, restricted to those whose FIRST fill is
      // inside [start, end).
      const byParlay = new Map<string, KalshiFill[]>();
      for (const f of fills) {
        const tk = f.market_ticker || f.ticker || "";
        if (!tk) continue;
        const arr = byParlay.get(tk) || [];
        arr.push(f);
        byParlay.set(tk, arr);
      }
      const settleByTk = new Map<string, KalshiSettlement>();
      for (const s of settles) {
        if (s.ticker) settleByTk.set(s.ticker, s);
      }

      const rows: ParlayRow[] = [];
      for (const [tk, parlayFills] of byParlay) {
        const firstMs = Math.min(
          ...parlayFills.map((f) => parseIsoMs(f.created_time) ?? Infinity)
        );
        if (!Number.isFinite(firstMs)) continue;
        if (firstMs < startUtcMs || firstMs >= endUtcMs) continue;
        rows.push(aggregateParlay(tk, parlayFills, settleByTk.get(tk)));
      }
      rows.sort((a, b) => b.first_fill_iso.localeCompare(a.first_fill_iso));

      // Enrich with leg tickers from /markets — costs N upstream calls but cached
      // for the lifetime of the recapCache entry (60s/5min).
      await enrichLegs(rows);

      return {
        start_et: startEt,
        end_et: endEt,
        agg: aggregateAll(rows),
        parlays: rows,
        daily: buildDaily(rows, startEt, endEt),
        sport_breakdown: buildSportBreakdown(rows),
        fetched_at: new Date().toISOString(),
        pages_fills: pagesFills,
        pages_settlements: pagesSettle,
      };
    },
    ttlFor(endEt),
  );
}
