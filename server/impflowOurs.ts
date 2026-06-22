// Admin-only "our position" overlay for the Impossible-Flow tab.
//
// This is OUR impossible-parlay exposure — the SAME number the Live tab shows as
// "Cost Paid". It reuses the server's getPositions() (KXMVE-only, and the
// partner's taker-only positions dropped on the TP account), so the flow tab's
// "ours" always equals the Live tab's Cost Paid on the same instance. Earlier
// versions summed today's /portfolio/fills, which can't match: Cost Paid is the
// cost basis of all currently-OPEN positions (cumulative), not today's fills.
//
// Positions are a current snapshot with no per-fill time, so "ours" is attributed
// per game (by combo ticker) but NOT time-bucketed. It only makes sense for the
// current day, so the caller skips it for past dates. Computed live, gated to
// PORTFOLIO=admin|all; NEVER written to HF or any shared artifact — the partner's
// dashboards never see our outflow.

import { getPositions, listAccounts } from "./kalshi.js";
import type { ImpFlowResult } from "./impflow.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Merge OUR open impossible-parlay exposure (= Cost Paid) into `result` and flag
 *  it admin. Best-effort: accounts without creds are skipped; any error leaves the
 *  public numbers intact (the caller wraps this and still serves `result`). */
export async function mergeOurFills(result: ImpFlowResult, date: string): Promise<void> {
  result.admin = true;
  if (!result?.games?.length) return;

  // ticker -> {gameIdx, shapeIdx} from the loaded public impflow (for per-game attribution).
  const tkMap = new Map<string, { gi: number; si: number }>();
  result.games.forEach((g, gi) => (g.shapes || []).forEach((s, si) => {
    for (const tk of (s as any).tickers || []) tkMap.set(tk, { gi, si });
  }));

  for (const g of result.games) {
    g.our_ct = 0; g.our_no = 0;
    for (const s of g.shapes) { s.our_ct = 0; s.our_no = 0; }
  }

  // pull open positions for every accessible account in parallel (same getPositions
  // the Live tab uses); missing creds -> [], not fatal.
  const perAcct = await Promise.all(listAccounts().map((a) =>
    getPositions(a).then((raw: any) => (raw?.market_positions as any[]) || []).catch(() => [])));

  let sumCt = 0, sumNo = 0, attrCt = 0, attrNo = 0;
  for (const positions of perAcct) {
    for (const p of positions) {
      const tk = p?.ticker || "";
      if (!tk.startsWith("KXMVE")) continue;            // belt-and-suspenders (getPositions already filters)
      const qty = Math.abs(parseFloat(p?.position_fp || "0"));
      if (!(qty > 0)) continue;
      const cost = parseFloat(p?.market_exposure_dollars || "0") || 0;   // = Cost Paid basis
      sumCt += qty; sumNo += cost;
      const loc = tkMap.get(tk);                        // attribute to a firehose game/shape if known
      if (loc) {
        const g = result.games[loc.gi];
        const s = g.shapes[loc.si];
        g.our_ct = (g.our_ct || 0) + qty; g.our_no = (g.our_no || 0) + cost;
        s.our_ct = (s.our_ct || 0) + qty; s.our_no = (s.our_no || 0) + cost;
        attrCt += qty; attrNo += cost;
      }
    }
  }
  for (const g of result.games) {
    g.our_ct = Math.round(g.our_ct || 0); g.our_no = r2(g.our_no || 0);
    for (const s of g.shapes) { s.our_ct = Math.round(s.our_ct || 0); s.our_no = r2(s.our_no || 0); }
  }
  result.summary.our_ct = Math.round(sumCt);             // = the Live tab's Cost Paid (contracts)
  result.summary.our_no = r2(sumNo);                     // = Cost Paid ($)
  result.summary.our_attr_ct = Math.round(attrCt);       // portion attributable to firehose games
  result.summary.our_attr_no = r2(attrNo);
}
