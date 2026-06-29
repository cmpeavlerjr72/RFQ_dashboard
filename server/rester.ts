// "Our Resting Book" panel data (admin-only): OUR resting impossible-parlay orders
// across every account + the top markets by 5-min demand, annotated with coverage,
// clearing, and whether we're top-of-book. Produced by sandbox/rester_status_sync.py
// -> HF -flow dataset as rester_<date>.json.
//
// ADMIN-ONLY: this is our own positions/competition, so only the admin instance
// (PORTFOLIO=admin|all) serves it; every other portfolio (incl. the partner's
// Sim2Win) gets an empty "admin-only" result and the Flow-tab panel stays hidden.
//
// Source: data/impossible_flow/rester_<date>.json locally (home box), else the HF
// -flow dataset. Mirrors builders.ts / impflow.ts.
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

export interface ResterMarket {
  ticker: string; shape: string; game: string;
  m5: number; m15: number; vol: number;
  clear_no_c: number | null; best_no_c: number | null;
  our_cov: number; our_filled: number; our_no_c: number | null;
  fill_pct: number | null; top_of_book: boolean | null;
  held: boolean; n_accts: number; status: string | null;
}
export interface ResterAccount {
  label: string; cash: number; locked: number; free: number; n_resting: number;
}
export interface ResterResult {
  date: string; admin: boolean;
  source: "local" | "hf" | "empty" | "admin-only";
  generated_at?: number;
  totals: { cash: number; locked: number; open: number; filled: number; free: number };
  accounts: ResterAccount[];
  markets: ResterMarket[];
}

const cache = new TTLCache<ResterResult>();
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export function currentEtDate(): string {
  const d = new Date(Date.now() - ET_UTC_OFFSET_HOURS * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const EMPTY = (date: string, source: ResterResult["source"]): ResterResult => ({
  date, admin: IS_ADMIN, source,
  totals: { cash: 0, locked: 0, open: 0, filled: 0, free: 0 },
  accounts: [], markets: [],
});

async function load(date: string): Promise<ResterResult> {
  const name = `rester_${date}.json`;
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

export async function getRester(dateRaw: string, force = false): Promise<ResterResult> {
  // Admin-only: never serve our positions off a non-admin instance.
  if (!IS_ADMIN) return EMPTY(isYmd(dateRaw) ? dateRaw : currentEtDate(), "admin-only");
  const date = isYmd(dateRaw) ? dateRaw : currentEtDate();
  if (force) cache.set(date, undefined as any, 0);
  // Resting book is live data; short TTL so the panel tracks the producer's 5-min push.
  const ttl = date >= currentEtDate() ? 60_000 : 5 * 60_000;
  return cache.getOrFetch(date, () => load(date), ttl);
}
