// Flow tab data: read the box-produced rollup parquet (10-min buckets x
// sport/stat/game, quoted + filled) for an ET date and hand the tidy cells to
// the frontend, which pivots them into the time-series / leaderboard / funnel.
//
// Source: the portfolio's flow dataset on HF (HF_FLOW_REPO, default = the fills
// repo with -fills -> -flow), produced by sandbox/flow_hf_sync.py. On the home
// box the local data/flow/*.parquet is read directly; on Render we fetch HF.
//
// The rollup is tiny (tens of KB/day), so we return all cells and let the client
// do the pivoting — maximum stylistic flexibility, minimal server logic.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TTLCache } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HF_FLOW_REPO = process.env.HF_FLOW_REPO ||
  (process.env.HF_FILLS_REPO || "mvpeav/kalshi-rfq-fills").replace("-fills", "-flow");
const HF_FLOW_BASE = `https://huggingface.co/datasets/${HF_FLOW_REPO}/resolve/main`;

// data/flow on the home box: dashboard/dist -> dashboard -> kalshi-rfq -> data/flow
const LOCAL_FLOW_DIR = path.resolve(__dirname, "..", "..", "data", "flow");

const ET_UTC_OFFSET_HOURS = 4;

export interface FlowCell {
  bucket_ts: number;     // epoch seconds, 10-min window start
  dim: string;           // "ALL" | "sport" | "stat" | "game"
  key: string;           // value (or "ALL")
  legs: number;
  leg_risk: number;      // $ quoted (additive)
  rfqs: number;          // distinct quoted RFQs in this cell
  filled_rfqs: number;   // distinct filled RFQs (quoted here that later filled)
  filled_risk: number;   // $ filled (additive)
}

export interface FlowResult {
  date: string;
  bucket_s: number;
  rows: FlowCell[];
  sports: string[];                 // distinct sports, by $ quoted desc
  summary: {
    quoted_rfqs: number; quoted_legs: number; quoted_risk: number;
    filled_rfqs: number; filled_risk: number;
    conversion_pct: number | null;  // filled_rfqs / quoted_rfqs
    fill_dollar_pct: number | null;  // filled_risk / quoted_risk
    n_buckets: number;
  };
  source: "local" | "hf" | "empty";
  fetched_at: string;
}

const flowCache = new TTLCache<FlowResult>();

function isYmd(s: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

export function currentEtDate(): string {
  const ms = Date.now() - ET_UTC_OFFSET_HOURS * 3600 * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const num = (v: any) => (typeof v === "bigint" ? Number(v) : Number(v) || 0);

async function parseParquet(ab: ArrayBuffer): Promise<FlowCell[]> {
  const { parquetReadObjects } = await import("hyparquet");
  const raw: any[] = await parquetReadObjects({ file: ab });
  return raw.map((r) => ({
    bucket_ts: num(r.bucket_ts),
    dim: String(r.dim),
    key: String(r.key),
    legs: num(r.legs),
    leg_risk: num(r.leg_risk),
    rfqs: num(r.rfqs),
    filled_rfqs: num(r.filled_rfqs),
    filled_risk: num(r.filled_risk),
  }));
}

async function loadCells(date: string): Promise<{ rows: FlowCell[]; source: FlowResult["source"] }> {
  const name = `flow_agg_${date}.parquet`;
  // Local first (home box).
  const local = path.join(LOCAL_FLOW_DIR, name);
  if (fs.existsSync(local)) {
    try {
      const buf = fs.readFileSync(local);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return { rows: await parseParquet(ab as ArrayBuffer), source: "local" };
    } catch { /* fall through to HF */ }
  }
  // HF mirror (Render).
  const token = process.env.HF_TOKEN;
  try {
    const resp = await fetch(`${HF_FLOW_BASE}/${name}`, {
      redirect: "follow",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!resp.ok) return { rows: [], source: "empty" };
    return { rows: await parseParquet(await resp.arrayBuffer()), source: "hf" };
  } catch {
    return { rows: [], source: "empty" };
  }
}

function summarize(rows: FlowCell[], date: string, source: FlowResult["source"]): FlowResult {
  const all = rows.filter((r) => r.dim === "ALL");
  const quoted_rfqs = all.reduce((s, r) => s + r.rfqs, 0);
  const quoted_legs = all.reduce((s, r) => s + r.legs, 0);
  const quoted_risk = all.reduce((s, r) => s + r.leg_risk, 0);
  const filled_rfqs = all.reduce((s, r) => s + r.filled_rfqs, 0);
  const filled_risk = all.reduce((s, r) => s + r.filled_risk, 0);

  const sportRisk = new Map<string, number>();
  for (const r of rows) {
    if (r.dim !== "sport") continue;
    sportRisk.set(r.key, (sportRisk.get(r.key) || 0) + r.leg_risk);
  }
  const sports = [...sportRisk.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  return {
    date,
    bucket_s: 600,
    rows,
    sports,
    summary: {
      quoted_rfqs, quoted_legs, quoted_risk, filled_rfqs, filled_risk,
      conversion_pct: quoted_rfqs > 0 ? (100 * filled_rfqs) / quoted_rfqs : null,
      fill_dollar_pct: quoted_risk > 0 ? (100 * filled_risk) / quoted_risk : null,
      n_buckets: new Set(all.map((r) => r.bucket_ts)).size,
    },
    source,
    fetched_at: new Date().toISOString(),
  };
}

export async function getFlow(dateRaw: string, force = false): Promise<FlowResult> {
  const date = isYmd(dateRaw) ? dateRaw : currentEtDate();
  const key = date;
  if (force) flowCache.set(key, undefined as any, 0);
  // Today is still filling, so cache short; past days are stable.
  const ttl = date >= currentEtDate() ? 60_000 : 5 * 60_000;
  return flowCache.getOrFetch(
    key,
    async () => {
      const { rows, source } = await loadCells(date);
      return summarize(rows, date, source);
    },
    ttl,
  );
}
