// Recap: pull /portfolio/fills + /portfolio/settlements for an ET-date range,
// group fills by parlay ticker, compute per-parlay cost / qty / pnl, and
// return aggregates. Mirrors sandbox/recap_kalshi_api_v2.py and recap_yesterday.py.
//
// Filter convention: a parlay belongs to the recap range if its FIRST FILL
// time falls inside [startEt 00:00, endEt 24:00) — i.e., the day we took the
// risk, regardless of when it later settled.

import { getJson, getMarketsBatch, accountOwnerTakes, getBalance, getPositions } from "./kalshi.js";
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
  is_taker?: boolean;          // true = filled as the taker (TP owner's own bets)
}

export interface KalshiSettlement {
  ticker?: string;
  market_result?: string;       // "yes" | "no" | "void" | "scalar" | ""
  settled_time?: string;
  // For "scalar" MVE settlements Kalshi returns gross payout (in cents) here.
  // Absent / 0 for binary yes/no/void results.
  revenue?: number;
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
  // Win rate over decided settlements: 100 * wins / (wins + losses). Voids
  // excluded from both numerator and denominator.
  win_rate_pct: number | null;
  // Equal-weighted average fill price across decided parlays (wins + losses,
  // voids excluded), in percent. Each parlay's per-contract price (cost/qty)
  // counted once, regardless of size. This is the apples-to-apples threshold
  // for parlay-count win rate: at any single fill priced p you need to win
  // with prob > p to be EV-positive, so on average you need WR > mean(p).
  // If win_rate_pct exceeds this, the strategy has positive per-parlay edge.
  //
  // NOTE: this is the parlay-count interpretable threshold. Realized ROI can
  // deviate from (WR - this) per-parlay because larger fills weight more in
  // the dollar PnL — but on a representative sample, beating this number
  // tracks net profitability.
  breakeven_wr_pct: number | null;
  // Payoff profile across decided parlays: mean realized $ pnl of winners
  // (>0) and of losers (<0). null when that bucket is empty. The win:loss
  // size ratio (avg_win / |avg_loss|) read against win_rate is the clean
  // asymmetry check for a long-NO premium book.
  avg_win: number | null;
  avg_loss: number | null;
  confidence: ConfidenceInfo;
}

export interface LegCountRow {
  n_legs: number;               // number of legs in the parlay; 0 = unknown (leg enrichment missed)
  parlay_tickers: string[];
  agg: RecapAgg;
}

export interface BreakdownStatRow {
  stat_set: string;             // sorted-distinct stat codes joined by "+", e.g. "PTS+REB+AST"
  stats: string[];              // raw stat codes (sorted)
  parlay_tickers: string[];
  agg: RecapAgg;
}

export interface BreakdownTypeRow {
  type: "player" | "game";      // any-player-leg = player; otherwise game
  parlay_tickers: string[];     // members; frontend uses these for logo derivation
  agg: RecapAgg;
  by_stat: BreakdownStatRow[];  // stat-level sub-buckets, sorted by # parlays desc
}

export interface SportBreakdownRow {
  sport: string;                // "NBA" | "MLB" | "NHL" | ... | "CROSS"
  parlay_tickers: string[];
  agg: RecapAgg;
  by_type: BreakdownTypeRow[];  // present types only, ordered player then game
}

// Account-growth block: takes the recap's settled realized P&L (the "growth",
// attributed by FILL date — a bet filled 6/15 that settles 6/16 counts for 6/15)
// and expresses it as a % of the account balance at the START of the period.
//
// The anchor is the REALIZED balance = cash + cost basis of open positions
// (Σ market_exposure), NOT equity. Equity marks open positions to market, so it
// drifts with live odds; the realized balance holds open bets at the price we
// paid, so it changes ONLY when a position settles. (It also equals the runner's
// own --bankroll figure.) That makes the reconstruction exact:
//   starting_balance = realized_balance_now − realized P&L of every parlay
//                      FIRST-FILLED on/after the period start (to now)
// rolls the current balance back to what it was at the period start, after any
// pre-period fills had settled — with no mark-to-market term to approximate.
// Then:
//   growth_pct      = growth_dollars / starting_balance
//   avg_daily_pct   = compounded daily rate over the window's ET days
//   doubling_days   = ln(2) / ln(1 + daily_rate)
export interface BalanceGrowth {
  current_balance: number | null;    // $ now = cash + open-position cost basis; null if fetch failed
  realized_since_start: number;      // $ realized P&L of settled parlays first-filled >= period start (to now)
  starting_balance: number | null;   // $ account value at period start; null without balance
  ending_balance: number | null;     // starting_balance + growth_dollars
  growth_dollars: number;            // = agg.realized_pnl (settled P&L over the period)
  growth_pct: number | null;         // 100 * growth_dollars / starting_balance
  n_days: number;                    // ET days in [start, end] inclusive
  avg_daily_pct: number | null;      // compounded daily growth rate, %
  avg_daily_dollars: number;         // growth_dollars / n_days
  doubling_days: number | null;      // projected days to double at avg_daily_pct
  has_balance: boolean;              // false when the live balance fetch failed
}

export interface RecapResult {
  start_et: string;             // YYYY-MM-DD
  end_et: string;               // YYYY-MM-DD (inclusive)
  agg: RecapAgg;
  balance_growth: BalanceGrowth;
  parlays: ParlayRow[];         // sorted by first_fill desc
  daily: DailyRow[];            // one row per ET day in range, asc; with cumulative cols
  sport_breakdown: SportBreakdownRow[];  // sorted by # parlays desc
  leg_count_breakdown: LegCountRow[];    // grouped by # legs, asc (unknown last)
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

async function fetchFillsBack(account: string, startUtcMs: number, maxPages = 30): Promise<{ fills: KalshiFill[]; pages: number }> {
  const out: KalshiFill[] = [];
  let cursor = "";
  let pages = 0;
  for (let i = 0; i < maxPages; i++) {
    const q = "/portfolio/fills?limit=200" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const body = await getJson(account, q);
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

async function fetchSettlementsBack(account: string, startUtcMs: number, maxPages = 30): Promise<{ settles: KalshiSettlement[]; pages: number }> {
  const out: KalshiSettlement[] = [];
  let cursor = "";
  let pages = 0;
  for (let i = 0; i < maxPages; i++) {
    const q = "/portfolio/settlements?limit=200" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const body = await getJson(account, q);
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

/** Build the account-growth block from the period's settled P&L + a starting
 *  balance reconstructed from current equity and realized-P&L-since-start. */
function makeBalanceGrowth(
  startEt: string,
  endEt: string,
  growthDollars: number,
  currentBalance: number | null,
  realizedSinceStart: number,
  hasBalance: boolean,
): BalanceGrowth {
  const nDays = dateRangeEt(startEt, endEt).length;
  const startingBalance =
    hasBalance && currentBalance != null ? currentBalance - realizedSinceStart : null;
  const endingBalance = startingBalance != null ? startingBalance + growthDollars : null;
  const growthPct =
    startingBalance != null && startingBalance > 0 ? (100 * growthDollars) / startingBalance : null;

  let avgDailyPct: number | null = null;
  let doublingDays: number | null = null;
  if (
    startingBalance != null && startingBalance > 0 &&
    endingBalance != null && endingBalance > 0 && nDays > 0
  ) {
    const dailyRate = Math.pow(endingBalance / startingBalance, 1 / nDays) - 1;
    avgDailyPct = dailyRate * 100;
    if (dailyRate > 1e-9) doublingDays = Math.log(2) / Math.log(1 + dailyRate);
  }

  return {
    current_balance: hasBalance ? currentBalance : null,
    realized_since_start: realizedSinceStart,
    starting_balance: startingBalance,
    ending_balance: endingBalance,
    growth_dollars: growthDollars,
    growth_pct: growthPct,
    n_days: nDays,
    avg_daily_pct: avgDailyPct,
    avg_daily_dollars: nDays > 0 ? growthDollars / nDays : growthDollars,
    doubling_days: doublingDays,
    has_balance: hasBalance,
  };
}

/** Live REALIZED balance ($) = available cash + cost basis of open positions
 *  (Σ market_exposure over our KXMVE book). Holding open bets at cost (not MTM)
 *  means this only moves on settlement — the right anchor for settled-P&L growth,
 *  and it matches the runner's --bankroll. Returns null on any failure so the
 *  recap still renders (growth block degrades to "balance unavailable"). */
async function fetchRealizedBalanceDollars(account: string): Promise<number | null> {
  try {
    const [bal, pos] = await Promise.all([
      getBalance(account),
      getPositions(account).catch(() => null),
    ]);
    if (!bal) return null;
    const cashDollars = (bal as any).balance_dollars != null
      ? Number((bal as any).balance_dollars)
      : (Number((bal as any).balance) || 0) / 100;
    if (!Number.isFinite(cashDollars)) return null;
    const openCostDollars = ((pos as any)?.market_positions || []).reduce(
      (s: number, p: any) => s + (Number(p?.market_exposure_dollars) || 0), 0,
    );
    return cashDollars + openCostDollars;
  } catch {
    return null;
  }
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
  } else if (result === "scalar") {
    // MVE scalar settlement: Kalshi pays gross `revenue` cents on our position.
    // Sign of net pnl decides win/loss bucket.
    const revenueDollars = (settle?.revenue ?? 0) / 100;
    pnl = revenueDollars - cost;
    status = pnl >= 0 ? "won" : "lost";
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
// Match the KX{SPORT}{STAT}- prefix. SPORT is the longest known league
// token; STAT is what follows up to the first dash.
// Tennis tour codes (ATPMATCH, WTAMATCH) are normalised to ATP/WTA below.
// Club soccer league codes (LALIGA, SERIEA, BUNDESLIGA, LIGUE1, EPL, MLS) are
// normalised to SOCCER. INTLFRIENDLY (international friendlies) and WC (World
// Cup) are kept SEPARATE so the recap breaks them out into their own sections.
// INTLFRIENDLY must precede WC; neither overlaps another token's prefix.
const LEG_SPORT_RE = /^KX(NBA|MLB|NHL|NFL|WNBA|NCAA[A-Z]*|UFC|GOLF|F1|TENNIS|ATPMATCH|WTAMATCH|MLS|EPL|LALIGA|SERIEA|BUNDESLIGA|LIGUE1|INTLFRIENDLY|WC|SOCCER|IPL|CRICKET)([A-Z0-9]+)-/;
const GAME_LEVEL_STATS = new Set([
  "GAME", "SPREAD", "TOTAL", "F5", "F5SPREAD", "F5TOTAL", "TEAMTOTAL",
  "RFI", "GOAL",
  // IPL game-level stats
  "FIRST10",
  // Soccer game-level stats (full match, BTTS, first half + its variants)
  "BTTS", "1H", "1HSPREAD", "1HTOTAL", "1HBTTS",
]);

const SOCCER_LEAGUE_CODES = new Set(["LALIGA", "SERIEA", "BUNDESLIGA", "LIGUE1", "EPL", "MLS"]);
const TENNIS_TOUR_CODES = new Set(["ATPMATCH", "WTAMATCH"]);

function normaliseSportCode(code: string): string {
  if (TENNIS_TOUR_CODES.has(code)) return code === "ATPMATCH" ? "ATP" : "WTA";
  if (SOCCER_LEAGUE_CODES.has(code)) return "SOCCER";
  if (code === "CRICKET") return "IPL";
  return code;
}

function classifyParlay(legs: RecapLeg[]): { sport: string; type: "player" | "game"; stats: string[] } {
  const sports = new Set<string>();
  const playerStats = new Set<string>();
  const gameStats = new Set<string>();
  for (const l of legs) {
    const m = l.ticker.match(LEG_SPORT_RE);
    if (!m) continue;
    sports.add(normaliseSportCode(m[1]));
    const stat = m[2];
    if (GAME_LEVEL_STATS.has(stat)) gameStats.add(stat);
    else playerStats.add(stat);
  }
  const sport = sports.size === 0 ? "UNKNOWN" : sports.size === 1 ? Array.from(sports)[0] : "CROSS";
  // A parlay with any player-prop leg is a "player" parlay; otherwise game-level.
  const type: "player" | "game" = playerStats.size > 0 ? "player" : "game";
  // Stat set is drawn from the relevant bucket: player parlays bucket by their
  // player stats (e.g. "PTS+REB+AST"), game parlays by their game stats
  // ("SPREAD+TOTAL"). Sorted for stable bucket keys.
  const statSet = type === "player" ? playerStats : gameStats;
  const stats = Array.from(statSet).sort();
  return { sport, type, stats };
}

function buildSportBreakdown(rows: ParlayRow[]): SportBreakdownRow[] {
  const bySport = new Map<string, ParlayRow[]>();
  const byBucket = new Map<string, ParlayRow[]>();   // key = "${sport}|${type}"
  // Stat-level grouping: "${sport}|${type}|${stat_set}" → rows. Each parlay
  // contributes to exactly one stat bucket (the sorted-join of its distinct
  // stat codes), so per-stat aggregates sum back to the parent type-row.
  const byStat = new Map<string, { stats: string[]; rows: ParlayRow[] }>();
  for (const r of rows) {
    const { sport, type, stats } = classifyParlay(r.legs);
    if (!bySport.has(sport)) bySport.set(sport, []);
    bySport.get(sport)!.push(r);
    const bk = `${sport}|${type}`;
    if (!byBucket.has(bk)) byBucket.set(bk, []);
    byBucket.get(bk)!.push(r);
    const statSet = stats.length ? stats.join("+") : "UNKNOWN";
    const sk = `${bk}|${statSet}`;
    if (!byStat.has(sk)) byStat.set(sk, { stats, rows: [] });
    byStat.get(sk)!.rows.push(r);
  }
  const out: SportBreakdownRow[] = [];
  for (const [sport, sportRows] of bySport) {
    const byType: BreakdownTypeRow[] = [];
    for (const t of ["player", "game"] as const) {
      const tRows = byBucket.get(`${sport}|${t}`) || [];
      if (!tRows.length) continue;
      // Collect stat sub-buckets for this (sport, type), sorted by #parlays desc.
      const statRows: BreakdownStatRow[] = [];
      for (const [key, bucket] of byStat) {
        if (!key.startsWith(`${sport}|${t}|`)) continue;
        const statSet = key.slice(`${sport}|${t}|`.length);
        statRows.push({
          stat_set: statSet,
          stats: bucket.stats,
          parlay_tickers: bucket.rows.map((r) => r.parlay_ticker),
          agg: aggregateAll(bucket.rows),
        });
      }
      statRows.sort((a, b) => {
        // Push UNKNOWN to the bottom; otherwise rank by #parlays desc.
        const rank = (s: string) => (s === "UNKNOWN" ? 1 : 0);
        if (rank(a.stat_set) !== rank(b.stat_set)) return rank(a.stat_set) - rank(b.stat_set);
        return b.parlay_tickers.length - a.parlay_tickers.length;
      });
      byType.push({
        type: t,
        parlay_tickers: tRows.map((r) => r.parlay_ticker),
        agg: aggregateAll(tRows),
        by_stat: statRows,
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

/** Group parlays by leg count. Rows with no enriched legs bucket as n_legs=0
 *  ("unknown") and sort to the bottom. Reuses aggregateAll so each row carries
 *  the same ROI / WR / break-even / confidence as the sport breakdown. */
function buildLegCountBreakdown(rows: ParlayRow[]): LegCountRow[] {
  const byN = new Map<number, ParlayRow[]>();
  for (const r of rows) {
    const n = r.legs.length;
    if (!byN.has(n)) byN.set(n, []);
    byN.get(n)!.push(r);
  }
  const out: LegCountRow[] = [];
  for (const [n, rs] of byN) {
    out.push({ n_legs: n, parlay_tickers: rs.map((r) => r.parlay_ticker), agg: aggregateAll(rs) });
  }
  out.sort((a, b) => {
    // Unknown (0 legs) always last; otherwise ascending leg count.
    if ((a.n_legs === 0) !== (b.n_legs === 0)) return a.n_legs === 0 ? 1 : -1;
    return a.n_legs - b.n_legs;
  });
  return out;
}

/** Pull /markets/{tk}.mve_selected_legs for each parlay and stuff legs+sub_title onto the row. */
async function enrichLegs(account: string, rows: ParlayRow[]): Promise<void> {
  if (rows.length === 0) return;
  const tickers = rows.map((r) => r.parlay_ticker);
  const markets = await getMarketsBatch(account, tickers);
  for (const r of rows) {
    const payload = markets[r.parlay_ticker];
    const m = payload?.market || payload;
    if (m && !payload?.error) {
      const legs: any[] = m?.mve_selected_legs || [];
      r.legs = legs
        .map((l) => ({
          ticker: String(l?.market_ticker || ""),
          side: String(l?.side || "yes").toLowerCase(),
        }))
        .filter((l) => l.ticker);
      r.sub_title = String(m?.no_sub_title || m?.yes_sub_title || "");
    }
    // Single-market bets (MLB player props etc.) have no mve_selected_legs — the
    // market IS the leg. Fall back to the market's own ticker so it classifies by
    // sport (KXMLBRBI -> MLB player prop, stat RBI/HR) and renders, instead of
    // vanishing as a legless "unknown" row. KXMVE parlays keep 0 legs on an
    // enrichment miss (they'd mis-classify as UNKNOWN anyway, no worse than today).
    if (r.legs.length === 0 && !r.parlay_ticker.startsWith("KXMVE")) {
      r.legs = [{ ticker: r.parlay_ticker, side: r.side }];
    }
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
  const avgWin = wins.length ? wins.reduce((a, r) => a + (r.pnl || 0), 0) / wins.length : null;
  const avgLoss = losses.length ? losses.reduce((a, r) => a + (r.pnl || 0), 0) / losses.length : null;
  const roiPct = settledCost > 0 ? (100 * pnl) / settledCost : null;
  const decided = [...wins, ...losses];
  const wlDenom = decided.length;
  const winRatePct = wlDenom > 0 ? (100 * wins.length) / wlDenom : null;
  // Equal-weighted avg fill price across DECIDED parlays (wins + losses only;
  // voids excluded since they refund cost). Each parlay's per-contract price
  // (cost/qty) counts once regardless of qty. This is the parlay-count
  // interpretable break-even threshold — beat it on WR and you have edge.
  const breakevenWrPct = wlDenom > 0
    ? (100 * decided.reduce((a, r) => a + (r.qty > 0 ? r.cost / r.qty : 0), 0)) / wlDenom
    : null;
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
    win_rate_pct: winRatePct,
    breakeven_wr_pct: breakevenWrPct,
    avg_win: avgWin,
    avg_loss: avgLoss,
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

export async function getRecap(account: string, startEt: string, endEt: string, force = false): Promise<RecapResult> {
  if (!isYmd(startEt) || !isYmd(endEt)) {
    throw new Error(`bad date format (expected YYYY-MM-DD): start=${startEt} end=${endEt}`);
  }
  if (endEt < startEt) {
    throw new Error(`end (${endEt}) is before start (${startEt})`);
  }

  const key = `${account}|${startEt}|${endEt}`;
  if (force) recapCache.set(key, undefined as any, 0);

  return recapCache.getOrFetch(
    key,
    async () => {
      const startUtcMs = etDayStartUtcMs(startEt);
      const endUtcMs = etDayEndUtcMs(endEt);

      const { fills, pages: pagesFills } = await fetchFillsBack(account, startUtcMs);
      const { settles, pages: pagesSettle } = await fetchSettlementsBack(account, startUtcMs);

      // Group fills by parlay ticker, restricted to those whose FIRST fill is
      // inside [start, end). Skip non-sports tickers the dashboard is
      // configured to hide (elections, etc. — see EXCLUDED_TICKER_PREFIXES
      // in public/teams.js). Kept in sync manually; this list mirrors the
      // front-end exclusion so server-side aggregates also reflect the
      // hidden positions.
      const EXCLUDED_TICKER_PREFIXES = [
        "KXGAPRIMARY",
        // 2026-05-12 yes-side LaLiga parlay fill (pre long-no-only fix).
        // Single-trade exclude so it doesn't distort recap aggregates.
        "KXMVECROSSCATEGORY-S2026DCED9D7F34E-03691C96109",
      ];
      const isExcluded = (tk: string): boolean =>
        EXCLUDED_TICKER_PREFIXES.some((p) => tk.startsWith(p));

      // On the brother's account (GPeavT) the owner places his own bets, which
      // fill as TAKER orders. Those are not our maker activity and must not
      // pollute the recap — drop every taker fill there. MP (default) and ROTH
      // are pure-maker books, left untouched (a stray taker there would be a real
      // cost we want to keep visible). 2026-06-03; ownerTakes flag 2026-06-14.
      const excludeTakers = accountOwnerTakes(account);

      const byParlay = new Map<string, KalshiFill[]>();
      for (const f of fills) {
        if (excludeTakers && f.is_taker) continue;
        const tk = f.market_ticker || f.ticker || "";
        if (!tk) continue;
        if (isExcluded(tk)) continue;
        const arr = byParlay.get(tk) || [];
        arr.push(f);
        byParlay.set(tk, arr);
      }
      const settleByTk = new Map<string, KalshiSettlement>();
      for (const s of settles) {
        if (s.ticker) settleByTk.set(s.ticker, s);
      }

      // Build in-window rows, and in the same pass accumulate the realized P&L
      // of EVERY settled parlay first-filled on/after the period start (no upper
      // bound — fills between the window end and "now" count too). That sum,
      // subtracted from current equity, reconstructs the starting balance.
      const rows: ParlayRow[] = [];
      let realizedSinceStart = 0;
      for (const [tk, parlayFills] of byParlay) {
        const firstMs = Math.min(
          ...parlayFills.map((f) => parseIsoMs(f.created_time) ?? Infinity)
        );
        if (!Number.isFinite(firstMs)) continue;
        if (firstMs < startUtcMs) continue;   // first-filled before the period — excluded from both
        // SETTLED parlays are handled by the targeted pass below (the page-capped fills here
        // can be incomplete for a settled parlay, mis-stating its cost basis). Only build
        // OPEN-parlay rows from the bulk fills.
        if (settleByTk.get(tk)?.market_result) continue;
        const row = aggregateParlay(tk, parlayFills, undefined);
        if (row.pnl != null) realizedSinceStart += row.pnl;   // open => null, so no-op
        if (firstMs >= endUtcMs) continue;    // after the window — counts for since-start only
        rows.push(row);
      }

      // SETTLED parlays — the realized P&L the growth block reports. fetchFillsBack is
      // PAGE-CAPPED (30×200), and the bait/rester generate enough fills to blow past it, so
      // most settled parlays' (older) fills never land in byParlay and their P&L was being
      // DROPPED (the recap showed only the few settled parlays with recent fills). The
      // settlements list, by contrast, is small and fully fetched — so drive settled P&L off
      // IT, pulling each held ticker's complete fills via a targeted query (immune to the cap)
      // for an exact cost basis. Skip markets we never held (no targeted call for those).
      // Recap markets = our KXMVE parlays PLUS single-market sports bets we held
      // (MLB player props KXMLBRBI / KXMLBHR carry no mve_selected_legs, so they
      // are NOT KXMVE — the old `!startsWith("KXMVE")` guard silently dropped every
      // settled prop from the recap, showing "no exposure" the morning after).
      // LEG_SPORT_RE recognises the KX{SPORT} prefix; heldCt>0 below still restricts
      // to markets we actually held, so this never pulls in a market we didn't bet.
      const isRecapMarket = (t: string): boolean => t.startsWith("KXMVE") || LEG_SPORT_RE.test(t);
      for (const [tk, settle] of settleByTk) {
        if (!settle.market_result || isExcluded(tk) || !isRecapMarket(tk)) continue;
        const heldCt = (Number((settle as any).no_count_fp) || 0) + (Number((settle as any).yes_count_fp) || 0);
        if (heldCt <= 0) continue;                       // a settled market we didn't hold
        let tf: KalshiFill[];
        try {
          tf = (await getJson(account, `/portfolio/fills?ticker=${encodeURIComponent(tk)}&limit=200`))?.fills || [];
        } catch { continue; }
        const real = excludeTakers ? tf.filter((f) => !f.is_taker) : tf;
        if (!real.length) continue;
        const firstMs = Math.min(...real.map((f) => parseIsoMs(f.created_time) ?? Infinity));
        if (!Number.isFinite(firstMs) || firstMs < startUtcMs) continue;  // first-filled before the period
        const row = aggregateParlay(tk, real, settle);
        if (row.pnl != null) realizedSinceStart += row.pnl;
        if (firstMs < endUtcMs) rows.push(row);
      }
      rows.sort((a, b) => b.first_fill_iso.localeCompare(a.first_fill_iso));

      // Enrich with leg tickers from /markets — costs N upstream calls but cached
      // for the lifetime of the recapCache entry (60s/5min).
      await enrichLegs(account, rows);

      // Account-growth: anchor the period's settled P&L to the starting balance.
      const currentBalance = await fetchRealizedBalanceDollars(account);
      const agg = aggregateAll(rows);
      const balanceGrowth = makeBalanceGrowth(
        startEt, endEt, agg.realized_pnl, currentBalance, realizedSinceStart, currentBalance != null,
      );

      return {
        start_et: startEt,
        end_et: endEt,
        agg,
        balance_growth: balanceGrowth,
        parlays: rows,
        daily: buildDaily(rows, startEt, endEt),
        sport_breakdown: buildSportBreakdown(rows),
        leg_count_breakdown: buildLegCountBreakdown(rows),
        fetched_at: new Date().toISOString(),
        pages_fills: pagesFills,
        pages_settlements: pagesSettle,
      };
    },
    ttlFor(endEt),
  );
}

// "Overall" recap = every real account's recap rows concatenated and
// re-aggregated, so the totals/daily/breakdowns reflect the whole book.
export async function getRecapOverall(
  accounts: string[], startEt: string, endEt: string, force = false,
): Promise<RecapResult> {
  const results = await Promise.all(
    accounts.map((a) => getRecap(a, startEt, endEt, force).catch(() => null)));
  const ok = results.filter(Boolean) as RecapResult[];
  const rows = ok.flatMap((r) => r.parlays || []);
  rows.sort((a, b) => (b.first_fill_iso || "").localeCompare(a.first_fill_iso || ""));
  const agg = aggregateAll(rows);

  // Overall growth = sum of per-account balance / realized-since-start, re-derived
  // through makeBalanceGrowth so the % / doubling math is consistent.
  const anyBalance = ok.some((r) => r.balance_growth?.has_balance);
  const sumBalance = ok.reduce((s, r) => s + (r.balance_growth?.current_balance ?? 0), 0);
  const sumSince = ok.reduce((s, r) => s + (r.balance_growth?.realized_since_start ?? 0), 0);
  const balanceGrowth = makeBalanceGrowth(
    startEt, endEt, agg.realized_pnl, anyBalance ? sumBalance : null, sumSince, anyBalance,
  );

  return {
    start_et: startEt,
    end_et: endEt,
    agg,
    balance_growth: balanceGrowth,
    parlays: rows,
    daily: buildDaily(rows, startEt, endEt),
    sport_breakdown: buildSportBreakdown(rows),
    leg_count_breakdown: buildLegCountBreakdown(rows),
    fetched_at: new Date().toISOString(),
    pages_fills: ok.reduce((s, r) => s + (r.pages_fills || 0), 0),
    pages_settlements: ok.reduce((s, r) => s + (r.pages_settlements || 0), 0),
  } as RecapResult;
}
