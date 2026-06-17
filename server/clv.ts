// CLV-vs-Pinnacle data for the recap tab. The closing fair of every parlay/leg
// needs the Python Dixon-Coles score model, so it CANNOT be computed in the TS
// server — it is produced by sandbox/clv_sync.py -> data/clv_<date>.json (one
// doc/day, per-account RAW weighted sums so accounts combine by addition).
//
// This module loads that doc (local on the box, HF mirror on Render — same
// local-first pattern as flow.ts), then combines the requested account keys and
// DERIVES the display numbers (¢/contract, %stake, leg gap pp). Scoping to the
// dashboard's own PORTFOLIO accounts is done by the caller (index.ts), so the
// twin Sim2Win/MVPeav services never see each other's books.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TTLCache } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HF_CLV_REPO = process.env.HF_CLV_REPO ||
  (process.env.HF_FILLS_REPO || "mvpeav/kalshi-rfq-fills").replace("-fills", "-clv");
const HF_CLV_BASE = `https://huggingface.co/datasets/${HF_CLV_REPO}/resolve/main`;
// dashboard/dist -> dashboard -> kalshi-rfq -> data
const LOCAL_DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const ET_UTC_OFFSET_HOURS = 4;

// ---- raw producer node shapes (see clv_sync.py) ----
interface PkNode { n: number; ct: number; stake: number; v_net: number; v_markup: number; v_drift: number; }
interface LkNode { n: number; w: number; gap_w: number; our_w: number; close_w: number; }
interface GameRaw { kpi: PkNode; bettypes: Record<string, LkNode>; n_unpriced?: number; unpriced_stake?: number; }
interface AcctRaw { kpi: PkNode; games: Record<string, GameRaw>; coverage: { covered_stake: number; total_stake: number; n_priced: number; n_unpriced: number; n_kalshi: number; source?: string }; }
interface ClvDoc {
  date: string; schema: number; games_modeled: string[];
  game_labels: Record<string, string>; portfolio_of: Record<string, string>;
  accounts: Record<string, AcctRaw>;
}

// ---- derived (client-facing) shapes ----
export interface Metric { cents_per_contract: number; pct_stake: number | null; }
export interface KpiView { n: number; ct: number; stake: number; net: Metric; markup: Metric; drift: Metric; }
export interface BetTypeView { type: string; n: number; gap_pp: number; our_p: number; close_p: number; }
export interface GameView { chunk: string; label: string; kpi: KpiView | null; bettypes: BetTypeView[]; n_unpriced: number; }
export interface ClvView {
  date: string; available: boolean; view: string; games_modeled: string[];
  coverage: { pct_stake: number | null; n_priced: number; n_unpriced: number; n_kalshi: number; producer_source: string };
  kpi: KpiView | null; games: GameView[]; source: "local" | "hf" | "empty";
}

const docCache = new TTLCache<{ doc: ClvDoc | null; source: ClvView["source"] }>();

function isYmd(s: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
export function currentEtDate(): string {
  const d = new Date(Date.now() - ET_UTC_OFFSET_HOURS * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function loadDoc(date: string): Promise<{ doc: ClvDoc | null; source: ClvView["source"] }> {
  const name = `clv_${date}.json`;
  const local = path.join(LOCAL_DATA_DIR, name);
  if (fs.existsSync(local)) {
    try { return { doc: JSON.parse(fs.readFileSync(local, "utf-8")), source: "local" }; }
    catch { /* fall through */ }
  }
  const token = process.env.HF_TOKEN;
  try {
    const resp = await fetch(`${HF_CLV_BASE}/${name}`, {
      redirect: "follow", headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!resp.ok) return { doc: null, source: "empty" };
    return { doc: (await resp.json()) as ClvDoc, source: "hf" };
  } catch { return { doc: null, source: "empty" }; }
}

// ---- combine (add raw sums) + derive ----
const pk0 = (): PkNode => ({ n: 0, ct: 0, stake: 0, v_net: 0, v_markup: 0, v_drift: 0 });
const lk0 = (): LkNode => ({ n: 0, w: 0, gap_w: 0, our_w: 0, close_w: 0 });
function pkAdd(a: PkNode, b?: PkNode) { if (!b) return; a.n += b.n; a.ct += b.ct; a.stake += b.stake; a.v_net += b.v_net; a.v_markup += b.v_markup; a.v_drift += b.v_drift; }
function lkAdd(a: LkNode, b?: LkNode) { if (!b) return; a.n += b.n; a.w += b.w; a.gap_w += b.gap_w; a.our_w += b.our_w; a.close_w += b.close_w; }

function derivePk(pk: PkNode): KpiView | null {
  if (!pk || pk.ct <= 0) return null;
  const m = (v: number): Metric => ({
    cents_per_contract: (v / pk.ct) * 100,
    pct_stake: pk.stake ? (v / pk.stake) * 100 : null,
  });
  return { n: pk.n, ct: pk.ct, stake: pk.stake, net: m(pk.v_net), markup: m(pk.v_markup), drift: m(pk.v_drift) };
}
function deriveLk(type: string, lk: LkNode): BetTypeView | null {
  if (!lk || lk.w <= 0) return null;
  return { type, n: lk.n, gap_pp: (lk.gap_w / lk.w) * 100, our_p: lk.our_w / lk.w, close_p: lk.close_w / lk.w };
}

const BT_ORDER = ["ML", "Total", "Spread", "BTTS", "Other"];

/** Combine the given account keys from the day's doc into a client view. Keys
 *  not present in the doc are skipped. Returns available:false when nothing matched. */
export function viewFromDoc(doc: ClvDoc | null, keys: string[], view: string,
                            source: ClvView["source"], date: string): ClvView {
  const empty: ClvView = {
    date, available: false, view, games_modeled: doc?.games_modeled || [],
    coverage: { pct_stake: null, n_priced: 0, n_unpriced: 0, n_kalshi: 0, producer_source: "" },
    kpi: null, games: [], source,
  };
  if (!doc) return empty;
  const accts = keys.map((k) => doc.accounts[k]).filter(Boolean) as AcctRaw[];
  if (!accts.length) return empty;

  const kpi = pk0();
  let covStake = 0, totStake = 0, nPriced = 0, nUnpriced = 0, nKalshi = 0;
  const srcs = new Set<string>();
  const games = new Map<string, { kpi: PkNode; bt: Map<string, LkNode>; unpriced: number }>();
  for (const a of accts) {
    pkAdd(kpi, a.kpi);
    covStake += a.coverage.covered_stake; totStake += a.coverage.total_stake;
    nPriced += a.coverage.n_priced; nUnpriced += a.coverage.n_unpriced; nKalshi += a.coverage.n_kalshi;
    if (a.coverage.source) srcs.add(a.coverage.source);
    for (const [chunk, g] of Object.entries(a.games)) {
      const gg = games.get(chunk) || { kpi: pk0(), bt: new Map<string, LkNode>(), unpriced: 0 };
      pkAdd(gg.kpi, g.kpi);
      gg.unpriced += g.n_unpriced || 0;
      for (const [t, lk] of Object.entries(g.bettypes || {})) {
        const cur = gg.bt.get(t) || lk0(); lkAdd(cur, lk); gg.bt.set(t, cur);
      }
      games.set(chunk, gg);
    }
  }
  const gameViews: GameView[] = [...games.entries()].map(([chunk, g]) => ({
    chunk, label: doc.game_labels[chunk] || chunk, kpi: derivePk(g.kpi), n_unpriced: g.unpriced,
    bettypes: [...g.bt.entries()]
      .map(([t, lk]) => deriveLk(t, lk))
      .filter((b): b is BetTypeView => !!b)
      .sort((x, y) => BT_ORDER.indexOf(x.type) - BT_ORDER.indexOf(y.type)),
  }))
    // biggest book first (priced stake, then unpriced count)
    .sort((x, y) => (y.kpi?.stake || 0) - (x.kpi?.stake || 0) || (y.n_unpriced - x.n_unpriced));

  return {
    date, available: true, view, games_modeled: doc.games_modeled,
    coverage: { pct_stake: totStake ? (100 * covStake) / totStake : null,
                n_priced: nPriced, n_unpriced: nUnpriced, n_kalshi: nKalshi,
                producer_source: [...srcs].join(",") },
    kpi: derivePk(kpi), games: gameViews, source,
  };
}

export async function getClv(dateRaw: string, keys: string[], view: string, force = false): Promise<ClvView> {
  const date = isYmd(dateRaw) ? dateRaw : currentEtDate();
  if (force) docCache.set(date, undefined as any, 0);
  const ttl = date >= currentEtDate() ? 60_000 : 5 * 60_000;
  const { doc, source } = await docCache.getOrFetch(date, () => loadDoc(date), ttl);
  return viewFromDoc(doc, keys, view, source, date);
}
