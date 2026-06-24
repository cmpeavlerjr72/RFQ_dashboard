// Builder-profile tab data: per-builder profiles of the impossible-parlay RFQ
// creators (creator_id from the WS feed, classified into whale/shark/fish/minnow
// + bot). Produced by sandbox/builder_agg.py -> HF flow repo as builders_<date>.json.
// ADMIN-ONLY: this is our counterparty intel, so only the admin instance serves it
// (every other portfolio, incl. the partner's Sim2Win, gets an empty result).
//
// Source: data/impossible_flow/builders_<date>.json locally (home box), else the
// HF -flow dataset. Mirrors impflow.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TTLCache } from "./cache.js";
import { PORTFOLIO } from "./accounts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_ADMIN = PORTFOLIO === "admin" || PORTFOLIO === "all";

const HF_FLOW_REPO = process.env.HF_FLOW_REPO ||
  (process.env.HF_FILLS_REPO || "mvpeav/kalshi-rfq-fills").replace("-fills", "-flow");
const HF_FLOW_BASE = `https://huggingface.co/datasets/${HF_FLOW_REPO}/resolve/main`;
const LOCAL_DIR = path.resolve(__dirname, "..", "..", "data", "impossible_flow");
const ET_UTC_OFFSET_HOURS = 4;

export interface BuilderRow {
  id: string; rfqs: number; cost: number; avg_cost: number;
  n_shapes: number; n_games: number; top_sport: string; avg_legs: number;
  rfq_per_min: number; tier: string; is_bot: boolean;
  first_ts: number | null; last_ts: number | null; top_shapes: [string, number][];
}
export interface BuildersResult {
  date: string; admin: boolean; source: "local" | "hf" | "empty" | "admin-only";
  updated_at?: string; generated_at?: string;
  summary: {
    n_rfqs: number; n_builders: number; n_bots: number; total_cost: number;
    by_tier: Record<string, number>; rfqs_by_tier: Record<string, number>;
    cost_by_tier: Record<string, number>;
  };
  builders: BuilderRow[];
}

const cache = new TTLCache<BuildersResult>();
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export function currentEtDate(): string {
  const d = new Date(Date.now() - ET_UTC_OFFSET_HOURS * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const EMPTY = (date: string, source: BuildersResult["source"]): BuildersResult => ({
  date, admin: IS_ADMIN, source,
  summary: { n_rfqs: 0, n_builders: 0, n_bots: 0, total_cost: 0, by_tier: {}, rfqs_by_tier: {}, cost_by_tier: {} },
  builders: [],
});

async function load(date: string): Promise<BuildersResult> {
  const name = `builders_${date}.json`;
  const local = path.join(LOCAL_DIR, name);
  if (fs.existsSync(local)) {
    try {
      const j = JSON.parse(fs.readFileSync(local, "utf-8"));
      return { ...j, admin: IS_ADMIN, source: "local" };
    } catch { /* fall through */ }
  }
  const token = process.env.HF_TOKEN;
  try {
    const resp = await fetch(`${HF_FLOW_BASE}/${name}`, {
      redirect: "follow",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!resp.ok) return EMPTY(date, "empty");
    const j = await resp.json();
    return { ...j, admin: IS_ADMIN, source: "hf" };
  } catch {
    return EMPTY(date, "empty");
  }
}

export async function getBuilders(dateRaw: string, force = false): Promise<BuildersResult> {
  // Admin-only intel: never serve builder data off a non-admin instance.
  if (!IS_ADMIN) return EMPTY(isYmd(dateRaw) ? dateRaw : currentEtDate(), "admin-only");
  const date = isYmd(dateRaw) ? dateRaw : currentEtDate();
  if (force) cache.set(date, undefined as any, 0);
  const ttl = date >= currentEtDate() ? 60_000 : 5 * 60_000;
  return cache.getOrFetch(date, () => load(date), ttl);
}
