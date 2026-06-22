// Admin-only "our fills" overlay for the Impossible-Flow tab.
//
// Computed LIVE, server-side, from the Kalshi creds THIS instance holds: pulls
// /portfolio/fills for every accessible account, keeps only fills on the
// impossible combo tickers present in the loaded (public) impflow, and sums OUR
// cleared volume (contracts + NO-side $) per game / 10-min bucket / shape.
//
// It is NEVER written to HF or any shared artifact and is only invoked when
// PORTFOLIO is admin/all (see impflow.ts) — so the partner's Sim2Win dashboard
// (and every non-admin instance) never sees our money outflow. The combo tickers
// it keys off are public market ids; the $ that gets attached here is not.

import { getJson, listAccounts } from "./kalshi.js";
import type { ImpFlowResult } from "./impflow.js";

const ET_UTC_OFFSET_HOURS = 4;
const FILLS_MAX_PAGES = 40;   // ~8000 fills/acct — plenty for the last day or two

function etDayBounds(date: string): [number, number] {
  // date is YYYY-MM-DD in ET; midnight ET = that day 00:00 at -04:00.
  const lo = Date.parse(`${date}T00:00:00-0${ET_UTC_OFFSET_HOURS}:00`) / 1000;
  return [lo, lo + 86400];
}

function fillTs(f: any): number {
  let ts = Number(f?.ts);
  if (Number.isFinite(ts)) return ts > 1e12 ? ts / 1000 : ts;   // tolerate ms
  if (f?.created_time) { const p = Date.parse(f.created_time) / 1000; if (Number.isFinite(p)) return p; }
  return NaN;
}

interface OurAgg { ct: number; no: number }

// `account`'s fills that printed within [lo,hi) on a combo in `combos`, grouped
// ticker -> bucketTs -> {ct, no}. Pages the fills feed (newest-first) back to lo.
async function fillsForAccount(
  account: string, lo: number, hi: number, combos: Set<string>, bucketS: number,
): Promise<Map<string, Map<number, OurAgg>>> {
  const out = new Map<string, Map<number, OurAgg>>();
  let cursor = "";
  for (let i = 0; i < FILLS_MAX_PAGES; i++) {
    const q = "/portfolio/fills?limit=200" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const body = await getJson(account, q);
    const page: any[] = body?.fills || [];
    let reachedOlder = false;
    for (const f of page) {
      const ts = fillTs(f);
      if (!Number.isFinite(ts)) continue;
      if (ts < lo) { reachedOlder = true; continue; }   // newest-first -> rest are older too
      if (ts >= hi) continue;                            // after the date window
      const tk = f?.market_ticker || f?.ticker || "";
      if (!combos.has(tk)) continue;
      if (f?.action === "sell") continue;                // deployment = acquisitions, not exits
      const ct = Number(f?.count_fp ?? f?.count ?? 0);
      if (!(ct > 0)) continue;
      let nod = f?.no_price_dollars != null ? Number(f.no_price_dollars) : null;
      if (nod == null && f?.yes_price_dollars != null) nod = 1 - Number(f.yes_price_dollars);
      if (nod == null || !Number.isFinite(nod)) continue;
      const b = Math.floor(ts / bucketS) * bucketS;
      let byB = out.get(tk); if (!byB) { byB = new Map(); out.set(tk, byB); }
      let cell = byB.get(b); if (!cell) { cell = { ct: 0, no: 0 }; byB.set(b, cell); }
      cell.ct += ct; cell.no += ct * nod;
    }
    cursor = body?.cursor || "";
    if (!page.length || !cursor || reachedOlder) break;
  }
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Merge OUR cleared volume into `result` in place and flag it admin. Best-effort:
 *  accounts without creds on this instance are skipped; any error leaves the public
 *  numbers intact (caller wraps this and still serves `result`). */
export async function mergeOurFills(result: ImpFlowResult, date: string): Promise<void> {
  result.admin = true;
  if (!result?.games?.length) return;
  const bucketS = result.bucket_s || 600;
  const [lo, hi] = etDayBounds(date);

  // ticker -> {gameIdx, shapeIdx} from the loaded public impflow.
  const tkMap = new Map<string, { gi: number; si: number }>();
  result.games.forEach((g, gi) => (g.shapes || []).forEach((s, si) => {
    for (const tk of (s as any).tickers || []) tkMap.set(tk, { gi, si });
  }));
  const combos = new Set(tkMap.keys());
  if (!combos.size) return;

  // pull every accessible account in parallel; missing creds -> empty, not fatal.
  const perAcct = await Promise.all(listAccounts().map((a) =>
    fillsForAccount(a, lo, hi, combos, bucketS).catch(() => new Map<string, Map<number, OurAgg>>())));

  // init overlay fields
  for (const g of result.games) {
    g.our_ct = 0; g.our_no = 0;
    for (const b of g.buckets) { b.our_ct = 0; b.our_no = 0; }
    for (const s of g.shapes) { s.our_ct = 0; s.our_no = 0; }
  }
  let sumCt = 0, sumNo = 0;
  for (const byTk of perAcct) {
    for (const [tk, byB] of byTk) {
      const loc = tkMap.get(tk); if (!loc) continue;
      const g = result.games[loc.gi];
      const s = g.shapes[loc.si];
      for (const [bts, cell] of byB) {
        g.our_ct = (g.our_ct || 0) + cell.ct; g.our_no = (g.our_no || 0) + cell.no;
        s.our_ct = (s.our_ct || 0) + cell.ct; s.our_no = (s.our_no || 0) + cell.no;
        sumCt += cell.ct; sumNo += cell.no;
        let bk = g.buckets.find((x) => x.ts === bts);
        if (!bk) { bk = { ts: bts, rfqs: 0, risk: 0, cl_ct: 0, cl_no: 0, our_ct: 0, our_no: 0 }; g.buckets.push(bk); }
        bk.our_ct = (bk.our_ct || 0) + cell.ct; bk.our_no = (bk.our_no || 0) + cell.no;
      }
    }
  }
  for (const g of result.games) {
    g.our_ct = Math.round(g.our_ct || 0); g.our_no = r2(g.our_no || 0);
    g.buckets.sort((a, b) => a.ts - b.ts);
    for (const b of g.buckets) { b.our_ct = Math.round(b.our_ct || 0); b.our_no = r2(b.our_no || 0); }
    for (const s of g.shapes) { s.our_ct = Math.round(s.our_ct || 0); s.our_no = r2(s.our_no || 0); }
  }
  result.summary.our_ct = Math.round(sumCt);
  result.summary.our_no = r2(sumNo);
}
