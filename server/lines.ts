// Lines tab backend: serves the Pinnacle/Bovada odds snapshots that the home
// box archives every 10 minutes (sandbox/prop_close_snapshotter.py) and
// mirrors, gzipped, to the PUBLIC HuggingFace dataset
// https://huggingface.co/datasets/mvpeav/kalshi-prop-closes — one
// prop_closes_<ET-date>.jsonl.gz per day. Public repo => no token here.
//
// Two endpoints:
//   GET /api/lines/catalog?date=YYYY-MM-DD   -> market catalog for dropdowns
//   GET /api/lines/series?date=...&id=...    -> time series for one market
//
// Cache: parsed day kept in memory; past days are immutable (cache forever),
// today refetches when older than 5 minutes (the snapshotter cadence).

import { gunzipSync } from "node:zlib";

const HF_BASE =
  "https://huggingface.co/datasets/mvpeav/kalshi-prop-closes/resolve/main";

type Row = any;

export interface MarketEntry {
  id: string;
  src: "pin" | "bov";
  sport: string;
  league: string;
  game: string;          // "Away @ Home" (pin) or event description (bov)
  start: number | null;  // epoch ms
  betType: string;       // Moneyline / Total / Spread / Team Total / prop units / bov market family
  label: string;         // full market label shown in the picker
  n: number;             // number of snapshots
  latestLine: number | null;
  limit: number | null;  // Pinnacle maxRiskStake (sharpness hint), latest seen
}

export interface SeriesPoint {
  t: number;             // epoch ms
  line: number | null;
  p: number | null;      // de-vigged primary prob: P(over) / P(home) / P(yes)
  p2: number | null;     // P(away) for ML
  p3: number | null;     // P(draw) for 3-way ML
  over: number | null;   // raw american prices for the tooltip/table
  under: number | null;
  limit: number | null;
}

interface DayData {
  fetchedAt: number;
  catalog: MarketEntry[];
  series: Map<string, SeriesPoint[]>;
}

const dayCache = new Map<string, DayData>();
const TODAY_TTL_MS = 5 * 60 * 1000;

function etToday(): string {
  const d = new Date(Date.now() - 4 * 3600 * 1000); // EDT approximation
  return d.toISOString().slice(0, 10);
}

function amerProb(a: unknown): number | null {
  if (a === null || a === undefined || a === "") return null;
  const s = String(a).trim().toUpperCase();
  if (s === "EVEN") return 0.5;
  const v = parseFloat(s.replace("+", ""));
  if (!isFinite(v) || v === 0) return null;
  return v < 0 ? -v / (-v + 100) : 100 / (v + 100);
}

function parseDay(rows: Row[]): DayData {
  const series = new Map<string, SeriesPoint[]>();
  const meta = new Map<string, MarketEntry>();

  for (const r of rows) {
    const t = Math.round((r.ts || 0) * 1000);
    if (r.src === "pin") {
      const teams: string[] = r.teams || [];
      const game = teams.length === 2 ? `${teams[1]} @ ${teams[0]}` : r.league || "?";
      const start = r.start ? Date.parse(r.start) : null;
      const period = r.period ? ` (P${r.period})` : "";
      let id: string, betType: string, label: string;
      if (r.cat === "Player Props") {
        id = `pin|${r.mid}|${r.type}|${r.period}`;
        betType = r.units || "Prop";
        label = `${r.desc || r.units}${period}`;
      } else {
        id = `pin|${r.mid}|${r.type}|${r.period}`;
        const t2: Record<string, string> = {
          moneyline: "Moneyline", total: "Total", spread: "Spread",
          team_total: "Team Total",
        };
        betType = t2[r.type] || r.type;
        label = `${betType}${period}`;
      }
      // de-vig from the prices array
      let line: number | null = null;
      let p: number | null = null, p2: number | null = null, p3: number | null = null;
      let over: number | null = null, under: number | null = null;
      const prices: Row[] = r.prices || [];
      const byName: Record<string, Row> = {};
      for (const pr of prices) {
        const key = (pr.designation || pr.name || "").toLowerCase();
        byName[key] = pr;
        if (pr.line !== null && pr.line !== undefined) line = pr.line;
      }
      const ov = byName["over"], un = byName["under"];
      if (ov || un) {
        const po = amerProb(ov?.price), pu = amerProb(un?.price);
        over = ov?.price ?? null; under = un?.price ?? null;
        if (po && pu) p = po / (po + pu);
      } else if (byName["home"] || byName["away"]) {
        const ph = amerProb(byName["home"]?.price);
        const pa = amerProb(byName["away"]?.price);
        const pd = amerProb(byName["draw"]?.price);
        const s = (ph || 0) + (pa || 0) + (pd || 0);
        if (s > 0) {
          p = ph ? ph / s : null;
          p2 = pa ? pa / s : null;
          p3 = pd ? pd / s : null;
        }
      } else if (prices.length === 2) {
        // specials with named Over/Under participants (name field)
        const po = amerProb(prices[0]?.price), pu = amerProb(prices[1]?.price);
        over = prices[0]?.price ?? null; under = prices[1]?.price ?? null;
        if (po && pu) p = po / (po + pu);
        if (prices[0]?.line != null) line = prices[0].line;
      }
      if (!meta.has(id)) {
        meta.set(id, {
          id, src: "pin", sport: r.sport, league: r.league || "", game,
          start: isFinite(start as number) ? (start as number) : null,
          betType, label, n: 0, latestLine: null, limit: null,
        });
      }
      const m = meta.get(id)!;
      m.n++;
      if (line !== null) m.latestLine = line;
      if (r.limit != null) m.limit = r.limit;
      const arr = series.get(id) || [];
      arr.push({ t, line, p, p2, p3, over, under, limit: r.limit ?? null });
      series.set(id, arr);
    } else if (r.src === "bov") {
      const id = `bov|${r.eid}|${r.desc}`;
      const betType = String(r.desc || "").split(" - ")[0];
      let line: number | null = null;
      let p: number | null = null;
      let over: number | null = null, under: number | null = null;
      const outs: Row[] = r.outcomes || [];
      const ov = outs.find((o) => o.name === "Over");
      const un = outs.find((o) => o.name === "Under");
      if (ov && un) {
        const po = amerProb(ov.price), pu = amerProb(un.price);
        over = ov.price ?? null; under = un.price ?? null;
        const lv = parseFloat(ov.line);
        if (isFinite(lv)) line = lv;
        if (po && pu) p = po / (po + pu);
      } else {
        // single-sided player lists (e.g. "Player to record a Hit") have one
        // price per player; skip — not chartable as one market.
        continue;
      }
      if (!meta.has(id)) {
        meta.set(id, {
          id, src: "bov", sport: r.sport || "mlb", league: "MLB (Bovada)",
          game: r.event || "?", start: r.start || null,
          betType, label: r.desc || betType, n: 0, latestLine: null, limit: null,
        });
      }
      const m = meta.get(id)!;
      m.n++;
      if (line !== null) m.latestLine = line;
      const arr = series.get(id) || [];
      arr.push({ t, line, p, p2: null, p3: null, over, under, limit: null });
      series.set(id, arr);
    }
  }
  for (const arr of series.values()) arr.sort((a, b) => a.t - b.t);
  const catalog = [...meta.values()].sort((a, b) =>
    a.sport.localeCompare(b.sport) || a.game.localeCompare(b.game) ||
    a.betType.localeCompare(b.betType) || a.label.localeCompare(b.label));
  return { fetchedAt: Date.now(), catalog, series };
}

async function loadDay(date: string): Promise<DayData> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("bad date");
  const cached = dayCache.get(date);
  const isToday = date === etToday();
  if (cached && (!isToday || Date.now() - cached.fetchedAt < TODAY_TTL_MS)) {
    return cached;
  }
  const url = `${HF_BASE}/prop_closes_${date}.jsonl.gz`;
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) {
    if (cached) return cached; // keep stale on transient HF error
    throw new Error(`no snapshot file for ${date} (HF ${resp.status})`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const text = gunzipSync(buf).toString("utf-8");
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  const day = parseDay(rows);
  dayCache.set(date, day);
  // bound the cache
  if (dayCache.size > 8) {
    const oldest = [...dayCache.keys()].sort()[0];
    if (oldest !== date) dayCache.delete(oldest);
  }
  return day;
}

export async function getLinesCatalog(date: string) {
  const day = await loadDay(date);
  return { date, generatedAt: day.fetchedAt, markets: day.catalog };
}

export async function getLinesSeries(date: string, id: string) {
  const day = await loadDay(date);
  const points = day.series.get(id);
  if (!points) throw new Error("unknown market id for that date");
  const market = day.catalog.find((m) => m.id === id) || null;
  return { date, id, market, points };
}
