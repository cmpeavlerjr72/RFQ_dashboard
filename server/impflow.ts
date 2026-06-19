// Impossible-flow tab data: the firehose of structurally-impossible RFQs across
// ALL games (incl. ones the sniper isn't quoting), rolled up per game with a
// 10-min time-series and a per-shape clearing table.
//
// Source: data/impossible_flow/agg_<date>.json, produced by
// sandbox/impossible_flow_agg.py from the read-only impossible_flow_feed.py
// capture. On the home box we read the local file; on Render we fetch it from
// the portfolio's HF -flow dataset (impflow_<date>.json) — same repo the quote
// flow uses. The artifact is small (one JSON), so we return it whole.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TTLCache } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HF_FLOW_REPO = process.env.HF_FLOW_REPO ||
  (process.env.HF_FILLS_REPO || "mvpeav/kalshi-rfq-fills").replace("-fills", "-flow");
const HF_FLOW_BASE = `https://huggingface.co/datasets/${HF_FLOW_REPO}/resolve/main`;

// dashboard/dist -> dashboard -> kalshi-rfq -> data/impossible_flow
const LOCAL_DIR = path.resolve(__dirname, "..", "..", "data", "impossible_flow");
const ET_UTC_OFFSET_HOURS = 4;

export interface ImpShape {
  shape: string;
  rfqs: number; risk: number;
  quoted: number; won: number; won_risk: number;
  clearing_no_c: number | null;
  clearing_lo: number | null; clearing_hi: number | null;
  traded_pct: number;
  our_bid_c: number | null;
}
export interface ImpGame {
  game: string; sport: string;
  rfqs: number; risk: number;
  quoted_rfqs: number; won_rfqs: number; won_risk: number;
  buckets: Array<{ ts: number; rfqs: number; risk: number; quoted: number; won: number; won_risk: number }>;
  shapes: ImpShape[];
}
export interface ImpFlowResult {
  date: string;
  updated_at: number | null;
  our_no_bid_c: number | null;
  bucket_s: number;
  summary: { rfqs: number; risk: number; quoted_rfqs: number; won_rfqs: number; won_risk: number; n_games: number };
  games: ImpGame[];
  source: "local" | "hf" | "empty";
  fetched_at: string;
}

const cache = new TTLCache<ImpFlowResult>();
function isYmd(s: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

export function currentEtDate(): string {
  const d = new Date(Date.now() - ET_UTC_OFFSET_HOURS * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const EMPTY = (date: string, source: ImpFlowResult["source"]): ImpFlowResult => ({
  date, updated_at: null, our_no_bid_c: null, bucket_s: 600,
  summary: { rfqs: 0, risk: 0, quoted_rfqs: 0, won_rfqs: 0, won_risk: 0, n_games: 0 },
  games: [], source, fetched_at: new Date().toISOString(),
});

async function load(date: string): Promise<ImpFlowResult> {
  const name = `agg_${date}.json`;
  const local = path.join(LOCAL_DIR, name);
  if (fs.existsSync(local)) {
    try {
      const j = JSON.parse(fs.readFileSync(local, "utf-8"));
      return { ...j, source: "local", fetched_at: new Date().toISOString() };
    } catch { /* fall through */ }
  }
  const token = process.env.HF_TOKEN;
  try {
    const resp = await fetch(`${HF_FLOW_BASE}/impflow_${date}.json`, {
      redirect: "follow",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!resp.ok) return EMPTY(date, "empty");
    const j = await resp.json();
    return { ...j, source: "hf", fetched_at: new Date().toISOString() };
  } catch {
    return EMPTY(date, "empty");
  }
}

export async function getImpFlow(dateRaw: string, force = false): Promise<ImpFlowResult> {
  const date = isYmd(dateRaw) ? dateRaw : currentEtDate();
  if (force) cache.set(date, undefined as any, 0);
  const ttl = date >= currentEtDate() ? 60_000 : 5 * 60_000;
  return cache.getOrFetch(date, () => load(date), ttl);
}
