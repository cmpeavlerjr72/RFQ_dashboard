// "Engine Diagnostics" panel data (admin-only): LIVE performance telemetry for
// the pinmaker engines — per-minute book samples (E / worst cell / P(green) /
// shortfall), the fill ledger with EDGE-AT-FILL, machine-vs-game attribution,
// and rails counters. Produced by pinmaker/engine_diag_sync.py --loop 60 ->
// HF -flow dataset as engine_diag_<date>.json. Mirrors rester.ts exactly:
// only the admin instance serves real data; everyone else gets "admin-only".
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
const LOCAL_DIR = path.resolve(__dirname, "..", "..", "data", "pinmaker_shadow");
const ET_UTC_OFFSET_HOURS = 4;

export interface EngineDiagResult {
  date: string;
  source: "local" | "hf" | "empty" | "admin-only";
  generated_at?: number;
  series?: any[];
  fills?: any[];
  rails?: Record<string, number>;
  attribution?: any[];
  totals?: { edge_banked: number; n_fills: number; machine_line: number };
}

const cache = new TTLCache<EngineDiagResult>();
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function currentEtDate(): string {
  const d = new Date(Date.now() - ET_UTC_OFFSET_HOURS * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const EMPTY = (date: string, source: EngineDiagResult["source"]): EngineDiagResult =>
  ({ date, source });

export async function getEngineDiag(dateArg?: string, force = false): Promise<EngineDiagResult> {
  const date = dateArg && isYmd(dateArg) ? dateArg : currentEtDate();
  if (!IS_ADMIN) return EMPTY(date, "admin-only");
  const key = `ediag:${date}`;
  if (force) cache.set(key, undefined as any, 0);
  return cache.getOrFetch(key, async () => {
    // local first (home box), then the HF -flow mirror (Render)
    const local = path.join(LOCAL_DIR, `engine_diag_${date}.json`);
    try {
      if (fs.existsSync(local)) {
        const j = JSON.parse(fs.readFileSync(local, "utf-8"));
        return { ...j, source: "local" as const };
      }
    } catch { /* fall through to HF */ }
    try {
      const r = await fetch(`${HF_FLOW_BASE}/engine_diag_${date}.json`, {
        headers: process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {},
      });
      if (r.ok) {
        const j: any = await r.json();
        return { ...j, source: "hf" as const };
      }
    } catch { /* empty below */ }
    return EMPTY(date, "empty");
  }, 45_000);
}
