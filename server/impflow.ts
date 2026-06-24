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
import { PORTFOLIO } from "./accounts.js";
import { mergeOurFills, mergeOurFillsForDate } from "./impflowOurs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The all-portfolios admin instance (PORTFOLIO=admin|all) is the ONLY one that
// enriches the flow with our own fills. Every other instance — incl. the
// partner's Sim2Win — never computes it, so our outflow stays private.
const IS_ADMIN = PORTFOLIO === "admin" || PORTFOLIO === "all";

const HF_FLOW_REPO = process.env.HF_FLOW_REPO ||
  (process.env.HF_FILLS_REPO || "mvpeav/kalshi-rfq-fills").replace("-fills", "-flow");
const HF_FLOW_BASE = `https://huggingface.co/datasets/${HF_FLOW_REPO}/resolve/main`;

// dashboard/dist -> dashboard -> kalshi-rfq -> data/impossible_flow
const LOCAL_DIR = path.resolve(__dirname, "..", "..", "data", "impossible_flow");
const ET_UTC_OFFSET_HOURS = 4;

// cleared_ct / cleared_no = the TRUE volume that cleared on the combo, measured off
// the public trade tape (real count_fp + NO-side $) — not the old 1:1 RFQ->trade
// match, which missed every resting/CLOB fill and ~27x under-counted. rfqs / risk
// stay the firehose DEMAND (count / taker target $). "our fills" is an admin-only
// overlay merged in by the route (never in the published artifact).
export interface ImpSizeBucket { label: string; n: number; risk: number }
export interface ImpShape {
  shape: string;
  rfqs: number; risk: number;
  cleared_ct: number; cleared_no: number;
  clearing_no_c: number | null;
  clearing_lo: number | null; clearing_hi: number | null;
  naive_no_c: number | null;
  our_bid_c: number | null;
  size_buckets: ImpSizeBucket[];
  tickers?: string[];                  // combo market(s) — keys the admin our-fills overlay
  our_ct?: number; our_no?: number;   // admin-only
}
export interface ImpGame {
  game: string; sport: string;
  rfqs: number; risk: number;
  cleared_ct: number; cleared_no: number;
  buckets: Array<{ ts: number; rfqs: number; risk: number; cl_ct: number; cl_no: number;
                   our_ct?: number; our_no?: number }>;
  shapes: ImpShape[];
  our_ct?: number; our_no?: number;    // admin-only
}
export interface ImpFlowResult {
  date: string;
  updated_at: number | null;
  our_no_bid_c: number | null;
  bucket_s: number;
  summary: { rfqs: number; risk: number; cleared_ct: number; cleared_no: number; n_games: number;
             our_ct?: number; our_no?: number;          // admin: ALL our maker impossible-parlay fills
             our_attr_ct?: number; our_attr_no?: number };  // admin: the part shown on the game cards
  games: ImpGame[];
  source: "local" | "hf" | "empty";
  fetched_at: string;
  admin?: boolean;   // true iff this response includes the our-fills overlay
}

const cache = new TTLCache<ImpFlowResult>();
function isYmd(s: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

export function currentEtDate(): string {
  const d = new Date(Date.now() - ET_UTC_OFFSET_HOURS * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const EMPTY = (date: string, source: ImpFlowResult["source"]): ImpFlowResult => ({
  date, updated_at: null, our_no_bid_c: null, bucket_s: 600,
  summary: { rfqs: 0, risk: 0, cleared_ct: 0, cleared_no: 0, n_games: 0 },
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
  return cache.getOrFetch(date, async () => {
    const r = await load(date);
    // Our overlay (admin only). TODAY: live positions = the Live tab's Cost Paid.
    // PAST dates: that day's fills off the Kalshi API (positions have settled
    // away) — so we can compare how WE did vs. the market on prior days. Best-
    // effort: an overlay error must not blank the public cleared numbers.
    if (IS_ADMIN) {
      try {
        if (date >= currentEtDate()) await mergeOurFills(r, date);
        else await mergeOurFillsForDate(r, date);
      } catch (e) {
        console.warn(`impflow: our-fills overlay failed for ${date}:`, (e as any)?.message || e);
      }
    }
    return r;
  }, ttl);
}
