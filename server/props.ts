// Props book: our live MLB RBI/HR prop maker positions + resting orders,
// grouped into game cards with live ESPN scores. Powers /api/props and the
// Props tab. Reads the DEFAULT account (MVPeav = MP) — the account the prop
// maker (pinmaker/mlb_prop_maker.py) rests orders on.

import { getJson, getMarketsBatch, DEFAULT_ACCOUNT } from "./kalshi.js";
import { getScoreboard, currentETDate } from "./espn.js";
import { TTLCache } from "./cache.js";

const cache = new TTLCache<any>();

const MLB_CODES = new Set([
  "ATH","ATL","AZ","BAL","BOS","CHC","CIN","CLE","COL","CWS","DET","HOU","KC",
  "LAA","LAD","MIA","MIL","MIN","NYM","NYY","PHI","PIT","SD","SEA","SF","STL",
  "TB","TEX","TOR","WSH",
]);
// ESPN abbreviation -> our Kalshi code
const ESPN_ALIAS: Record<string, string> = {
  ARI: "AZ", CHW: "CWS", OAK: "ATH", ATH: "ATH", WAS: "WSH", SFG: "SF",
  SDP: "SD", KCR: "KC", TBR: "TB", WSN: "WSH",
};

function num(x: any): number { const v = parseFloat(String(x)); return isFinite(v) ? v : 0; }

const MONS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
// Today's Kalshi ticker date tag (e.g. "26JUL08"), DST-safe via currentETDate.
// Used to keep the fills scan scoped to the current slate.
function todayTicketTag(): string {
  const ymd = currentETDate();                 // YYYYMMDD in America/New_York
  return `${ymd.slice(2, 4)}${MONS[parseInt(ymd.slice(4, 6), 10) - 1]}${ymd.slice(6, 8)}`;
}

function splitTeams(pair: string): [string, string] | null {
  for (let i = 2; i <= 3; i++) {
    const a = pair.slice(0, i), b = pair.slice(i);
    if (MLB_CODES.has(a) && MLB_CODES.has(b)) return [a, b];
  }
  return null;
}

function parseChunk(chunk: string) {
  const m = /^(\d{2}[A-Z]{3}\d{2})(\d{4})([A-Z]+?)(G\d)?$/.exec(chunk || "");
  if (!m) return null;
  const t = splitTeams(m[3]);
  if (!t) return null;
  return { date: m[1], hhmm: m[2], away: t[0], home: t[1], dh: m[4] || "" };
}

function kindOf(series: string, line: number): string {
  if (series === "KXMLBHR") return "HR";
  if (series === "KXMLBRBI") return line <= 0.5 ? "RBI" : "RBI2";
  return series.replace("KXMLB", "");
}

// Build an ESPN score index keyed by "AWAY@HOME" (our codes).
function espnIndex(payload: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const e of (payload?.events || [])) {
    const comp = e?.competitions?.[0];
    if (!comp) continue;
    const cs = comp.competitors || [];
    const home = cs.find((c: any) => c.homeAway === "home");
    const away = cs.find((c: any) => c.homeAway === "away");
    if (!home || !away) continue;
    const norm = (ab: string) => ESPN_ALIAS[ab] || ab;
    const hc = norm(home.team?.abbreviation || "");
    const ac = norm(away.team?.abbreviation || "");
    const st = e?.status?.type || {};
    out[`${ac}@${hc}`] = {
      state: st.state,                       // pre | in | post
      detail: st.shortDetail || st.detail || "",
      awayScore: away.score != null ? Number(away.score) : null,
      homeScore: home.score != null ? Number(home.score) : null,
      awayName: away.team?.shortDisplayName || away.team?.abbreviation,
      homeName: home.team?.shortDisplayName || home.team?.abbreviation,
    };
  }
  return out;
}

export async function getProps(account: string = DEFAULT_ACCOUNT, force = false): Promise<any> {
  const key = `${account}:props`;
  if (force) cache.set(key, undefined as any, 0);
  return cache.getOrFetch(key, async () => {
    // 1) resting orders (MP) on our prop series
    const ordJson = await getJson(account, "/portfolio/orders?status=resting&limit=1000");
    const orders = (ordJson?.orders || []).filter((o: any) =>
      String(o.ticker || "").startsWith("KXMLBRBI") || String(o.ticker || "").startsWith("KXMLBHR"));
    // 2) fills — the authoritative record of what we've filled. Positions drop
    // to zero the instant a market settles, so sourcing from them would make
    // settled props vanish; fills persist, so settled bets still render as
    // WON/LOST cards. We only ever rest NO on these series, so a ticker's net
    // long-NO size is just the sum of its fill counts. Scoped to today's slate.
    const tag = todayTicketTag();
    const fillJson = await getJson(account, "/portfolio/fills?limit=1000");
    const fills = (fillJson?.fills || []).filter((f: any) => {
      const tk = String(f.ticker || "");
      return (tk.startsWith("KXMLBRBI") || tk.startsWith("KXMLBHR")) && tk.includes(tag);
    });
    const fillAgg: Record<string, { ct: number; cost: number }> = {};
    for (const f of fills) {
      const ct = num(f.count_fp || f.count);
      if (!ct) continue;
      const tk = f.ticker;
      (fillAgg[tk] ||= { ct: 0, cost: 0 });
      fillAgg[tk].ct += ct;
      fillAgg[tk].cost += ct * num(f.no_price_dollars);   // NO price paid × ct
    }

    // 3) union of tickers -> fetch current markets (player subtitle, bid/ask, result)
    const tickers = Array.from(new Set([
      ...orders.map((o: any) => o.ticker),
      ...Object.keys(fillAgg),
    ]));
    const markets = tickers.length ? await getMarketsBatch(account, tickers) : {};

    // 4) build per-ticker rows
    const rows: Record<string, any> = {};
    const rowFor = (tk: string) => {
      if (!rows[tk]) {
        const series = tk.split("-")[0];
        const chunk = tk.split("-")[1];
        const mk = markets[tk]?.market || markets[tk] || {};
        const line = num(mk.floor_strike);
        rows[tk] = {
          ticker: tk, series, chunk,
          player: (mk.yes_sub_title || "").split(":")[0].trim() || tk.split("-").slice(2).join("-"),
          kind: kindOf(series, line), line: line + 0.5,
          cur_bid: num(mk.yes_bid_dollars), cur_ask: num(mk.yes_ask_dollars),
          result: mk.result || null,
          resting_ct: 0, filled_ct: 0, our_yes: 0, collat: 0, realized: 0,
        };
      }
      return rows[tk];
    };
    for (const o of orders) {
      const r = rowFor(o.ticker);
      r.resting_ct += num(o.remaining_count_fp || o.remaining_count);
      r.our_yes = num(o.yes_price_dollars) || r.our_yes;   // our resting sell-YES price
    }
    for (const [tk, agg] of Object.entries(fillAgg)) {
      const r = rowFor(tk);
      r.filled_ct += agg.ct;
      r.collat += agg.cost;                              // cost basis paid (NO × ct)
      // our implied sell-YES price from the avg NO fill, for the edge display —
      // don't clobber a live resting-order price if this ticker still has one.
      if (agg.ct > 0 && !r.our_yes) r.our_yes = 1 - agg.cost / agg.ct;
    }

    // 5) group by game, join ESPN
    let scoreboard: any = {};
    try { scoreboard = espnIndex(await getScoreboard("mlb", currentETDate())); } catch { /* best effort */ }
    const games: Record<string, any> = {};
    for (const r of Object.values<any>(rows)) {
      const c = parseChunk(r.chunk);
      const gk = r.chunk;
      if (!games[gk]) {
        const espn = c ? scoreboard[`${c.away}@${c.home}`] : null;
        games[gk] = {
          chunk: gk, away: c?.away || "?", home: c?.home || "?", hhmm: c?.hhmm || "",
          espn: espn || null, props: [],
          collateral: 0, filled_ct: 0, resting_ct: 0,
        };
      }
      const g = games[gk];
      const mid = r.cur_bid && r.cur_ask ? (r.cur_bid + r.cur_ask) / 2 : null;
      r.edge_c = (r.our_yes && mid) ? Math.round((r.our_yes - mid) * 1000) / 10 : null;
      r.status = r.result ? "settled" : (r.filled_ct > 0 ? (r.resting_ct > 0 ? "partial" : "filled")
        : "resting");
      // win/loss if settled: we hold NO -> win when result == 'no'
      r.won = r.result ? (r.result === "no") : null;
      // realized maker P&L once settled: a NO that holds pays $1/ct
      // (profit = ct − cost); a NO that loses forfeits the cost basis.
      if (r.result && r.filled_ct > 0) {
        r.realized = r.won ? (r.filled_ct - r.collat) : -r.collat;
      }
      g.props.push(r);
      g.collateral += r.collat + r.resting_ct * (1 - r.our_yes);
      g.filled_ct += r.filled_ct; g.resting_ct += r.resting_ct;
    }
    const gameList = Object.values<any>(games).sort((a, b) => (a.hhmm || "").localeCompare(b.hhmm || ""));
    for (const g of gameList) g.props.sort((a: any, b: any) => (b.edge_c || 0) - (a.edge_c || 0));

    const summary = {
      games: gameList.length,
      props: Object.keys(rows).length,
      resting_ct: gameList.reduce((s, g) => s + g.resting_ct, 0),
      filled_ct: gameList.reduce((s, g) => s + g.filled_ct, 0),
      collateral: Math.round(gameList.reduce((s, g) => s + g.collateral, 0) * 100) / 100,
      realized: Math.round(Object.values<any>(rows).reduce((s, r) => s + (r.realized || 0), 0) * 100) / 100,
    };
    return { account, updated: new Date().toISOString(), summary, games: gameList };
  }, 20_000);
}
