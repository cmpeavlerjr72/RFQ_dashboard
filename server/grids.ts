// Same-game quadrant-grid feasibility snapshots (the "zero-risk grid" concept:
// rest all four win/loss x over/under same-game parlays; if all four clear at
// fair+edge the set locks profit regardless of outcome). Produced by
// pinmaker/grid_tester.py -> HF dataset grids_latest.json every ~10 min.
// ADMIN-ONLY: research telemetry — no other instance (incl. Sim2Win) serves
// it, and the nav link only renders on the admin brand (see brand.js).
import { TTLCache } from "./cache.js";
import { PORTFOLIO } from "./accounts.js";

const IS_ADMIN = PORTFOLIO === "admin" || PORTFOLIO === "all";
const HF_GRID_REPO = process.env.HF_GRID_REPO || "mvpeav/kalshi-grid-tester";
const HF_BASE = `https://huggingface.co/datasets/${HF_GRID_REPO}/resolve/main`;

export interface GridsResult {
  admin: boolean;
  source: "hf" | "empty" | "admin-only";
  ts?: number;
  at_et?: string;
  window_min?: number;
  context?: Record<string, number>;
  n_grids?: number;
  grids?: unknown[];
}

const cache = new TTLCache<GridsResult>();
const EMPTY = (source: GridsResult["source"]): GridsResult => ({
  admin: IS_ADMIN, source, n_grids: 0, grids: [],
});

async function load(): Promise<GridsResult> {
  const token = process.env.HF_TOKEN;
  try {
    const resp = await fetch(`${HF_BASE}/grids_latest.json`, {
      redirect: "follow",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!resp.ok) return EMPTY("empty");
    const j = await resp.json();
    return { ...j, admin: IS_ADMIN, source: "hf" };
  } catch {
    return EMPTY("empty");
  }
}

export async function getGrids(force = false): Promise<GridsResult> {
  // Admin-only research telemetry: never serve grids off a non-admin instance.
  if (!IS_ADMIN) return EMPTY("admin-only");
  if (force) cache.set("latest", undefined as any, 0);
  return cache.getOrFetch("latest", () => load(), 60_000);
}
