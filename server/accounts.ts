// Account registry — the dashboard's view of the shared account fact sheet.
// Reads accounts.json at the repo root (mirror of the runner's
// kalshi-rfq/config/accounts.json) so adding an account is a JSON edit, not a
// code change. Falls back to baked-in defaults (identical to the live values as
// of 2026-06-14) if the file is missing/unreadable, so the dashboard never
// breaks from a bad file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM has no __dirname; derive it from this module's URL.
const _dir = path.dirname(fileURLToPath(import.meta.url));

export interface DashAccount {
  key: string;            // runner/config key (primary/second/roth)
  marker: string;         // short tag (mp/tp/roth)
  label: string;          // Telegram label (MP/TP/ROTH)
  dashboardLabel: string; // dashboard UI account name (MVPeav/GPeavT/ROTH)
  envSuffix: string;      // KALSHI_*<suffix>
  fillsFile: string;      // local fill log name
  hfName: string;         // gzipped name on the private HF fills mirror
  allowedSports: string[];
  ownerTakes: boolean;    // owner also trades this account manually (taker exclude)
}

const DEFAULT_ACCOUNTS: DashAccount[] = [
  { key: "primary", marker: "mp", label: "MP", dashboardLabel: "MVPeav",
    envSuffix: "", fillsFile: "fills.jsonl", hfName: "fills_mvpeav.jsonl.gz",
    allowedSports: [], ownerTakes: false },
  { key: "second", marker: "tp", label: "TP", dashboardLabel: "GPeavT",
    envSuffix: "_SECOND", fillsFile: "fills_second.jsonl", hfName: "fills_gpeavt.jsonl.gz",
    allowedSports: [], ownerTakes: true },
  { key: "roth", marker: "roth", label: "ROTH", dashboardLabel: "ROTH",
    envSuffix: "_ROTH", fillsFile: "fills_roth.jsonl", hfName: "fills_roth.jsonl.gz",
    allowedSports: ["wc"], ownerTakes: false },
];

function loadAccounts(): DashAccount[] {
  const candidates = [
    path.resolve(process.cwd(), "accounts.json"),
    path.resolve(_dir, "..", "accounts.json"),
    path.resolve(_dir, "accounts.json"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      const list = (raw.accounts || []).map((a: any): DashAccount => ({
        key: a.key,
        marker: a.marker,
        label: a.label,
        dashboardLabel: a.dashboard_label || a.label,
        envSuffix: a.env_suffix || "",
        fillsFile: a.fills_file,
        hfName: a.hf_name || "",
        allowedSports: a.allowed_sports || [],
        ownerTakes: !!a.owner_takes,
      }));
      if (list.length) {
        console.log(`accounts: loaded ${list.length} from ${p}`);
        return list;
      }
    } catch (e) {
      console.warn(`accounts: failed to read ${p}:`, (e as any)?.message || e);
    }
  }
  console.warn("accounts: using baked-in DEFAULT_ACCOUNTS (no accounts.json found)");
  return DEFAULT_ACCOUNTS;
}

export const DASH_ACCOUNTS: DashAccount[] = loadAccounts();

const _byLabel = new Map(DASH_ACCOUNTS.map((a) => [a.dashboardLabel, a]));

export function byDashboardLabel(label: string): DashAccount | undefined {
  return _byLabel.get(label);
}

/** Env-var names for an account, derived from its suffix (matches the runner). */
export function envVarsFor(a: DashAccount): { keyId: string; inline: string; keyPath: string } {
  return {
    keyId: `KALSHI_API_KEY_ID${a.envSuffix}`,
    inline: `KALSHI_PRIVATE_KEY${a.envSuffix}`,
    keyPath: `KALSHI_PRIVATE_KEY_PATH${a.envSuffix}`,
  };
}

/** The default/primary account's dashboard label (first entry, or key==primary). */
export function defaultDashboardLabel(): string {
  const p = DASH_ACCOUNTS.find((a) => a.key === "primary") || DASH_ACCOUNTS[0];
  return p.dashboardLabel;
}
