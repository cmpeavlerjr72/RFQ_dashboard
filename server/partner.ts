// Partner-dashboard scraper.
//
// The partner runs a Kalshi RFQ dashboard at http://137.184.206.173:8877/.
// It server-renders HTML — no JSON API — so we scrape the PnL tab tables
// into the same shape our /api/recap returns, then compare side-by-side in
// the new Comparison tab. Long-TTL cached (10 min): the partner's data
// changes on the settlement timescale and we want to be polite to their
// box. Per feedback_polite_apis.md.
//
// Stale fallback: if the upstream is down we serve the last good payload
// with a clear `stale: true` marker rather than throwing.

const PARTNER_URL = process.env.PARTNER_DASHBOARD_URL
  || "http://137.184.206.173:8877/";
const FETCH_TIMEOUT_MS = 30_000;
const TTL_MS = 10 * 60 * 1000;             // 10 minutes
const STALE_GRACE_MS = 24 * 3600 * 1000;   // serve stale for up to 24h

export interface PartnerRow {
  label: string;            // date / week / sport / prop-type label
  n: number;
  wins?: number | null;
  losses?: number | null;
  volume_dollars?: number | null;
  pnl_dollars: number;
  roi_pct: number;          // percent (e.g. -6.8 means -6.8%)
  dollar_per_fill?: number | null;
  drift_c?: number | null;
  sig_p?: number | null;
  // For By-Prop-Type rows we split "Total (NBA)" → type + sport so the UI
  // can group / align. Null on tables where it doesn't apply.
  prop_type?: string | null;
  sport?: string | null;
}

export interface PartnerRecap {
  fetched_at: string;
  source_url: string;
  stale: boolean;            // true if served from stale cache
  stale_age_ms?: number;
  parser_warnings: string[];
  by_day: PartnerRow[];
  by_week: PartnerRow[];
  by_month: PartnerRow[];
  by_sport: PartnerRow[];
  by_prop_type: PartnerRow[];
  pregame_vs_live: PartnerRow[];          // {label: "Pregame"|"Live", ...}
  pregame_by_prop_type: PartnerRow[];
  live_by_prop_type: PartnerRow[];
}

// ---------------------------------------------------------------------------
// Cell parsers
// ---------------------------------------------------------------------------

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
}

function parseMoney(s: string): number | null {
  const t = stripTags(s).replace(/[$,\s]/g, "");
  if (!t || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parsePct(s: string): number | null {
  const t = stripTags(s).replace(/[%\s]/g, "");
  if (!t || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseCents(s: string): number | null {
  const t = stripTags(s).replace(/[c\s]/g, "");
  if (!t || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseSig(s: string): number | null {
  const m = stripTags(s).match(/p=([0-9.]+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseInt0(s: string): number {
  const t = stripTags(s).replace(/[,\s]/g, "");
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseWL(s: string): [number | null, number | null] {
  const m = stripTags(s).match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return [null, null];
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

function parseTypeSport(label: string): { prop_type: string; sport: string | null } {
  const m = label.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!m) return { prop_type: label, sport: null };
  return { prop_type: m[1].trim(), sport: m[2].trim() };
}

// ---------------------------------------------------------------------------
// HTML → row matrices
// ---------------------------------------------------------------------------

function extractSectionTables(html: string): Array<{ section: string; rows: string[][] }> {
  // Restrict to the PnL tab so positions/legs tables can't accidentally
  // hijack a section name. The partner's HTML emits one table per
  // <div class="sect">NAME</div> header inside #tab-pnl.
  const tabMatch = html.match(
    /<div class="tab-content" id="tab-pnl"[^>]*>([\s\S]*?)<div class="tab-content" id="tab-legs"/
  );
  const body = tabMatch ? tabMatch[1] : html;

  const re = /<div class="sect">([^<]+)<\/div>|<table\b[^>]*>([\s\S]*?)<\/table>/g;
  const out: Array<{ section: string; rows: string[][] }> = [];
  let currentSection: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1] !== undefined) {
      currentSection = m[1].trim();
    } else if (m[2] !== undefined && currentSection) {
      const rows: string[][] = [];
      const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
      let tm: RegExpExecArray | null;
      while ((tm = trRe.exec(m[2])) !== null) {
        const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g;
        const cells: string[] = [];
        let cm: RegExpExecArray | null;
        while ((cm = cellRe.exec(tm[1])) !== null) cells.push(cm[1]);
        if (cells.length) rows.push(cells);
      }
      out.push({ section: currentSection, rows });
      currentSection = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-row builders
// ---------------------------------------------------------------------------

// By Day/Week/Month: label | n | W/L | Volume | P&L | ROI | Drift | Sig
function buildPeriodRow(cells: string[]): PartnerRow {
  const [w, l] = parseWL(cells[2] ?? "");
  return {
    label: stripTags(cells[0] ?? ""),
    n: parseInt0(cells[1] ?? "0"),
    wins: w,
    losses: l,
    volume_dollars: parseMoney(cells[3] ?? ""),
    pnl_dollars: parseMoney(cells[4] ?? "") ?? 0,
    roi_pct: parsePct(cells[5] ?? "") ?? 0,
    drift_c: parseCents(cells[6] ?? ""),
    sig_p: parseSig(cells[7] ?? ""),
  };
}

// By Sport / By Prop Type: label | n | W/L | P&L | ROI | $/fill | Sig
function buildSportPropRow(cells: string[], splitTypeSport = false): PartnerRow {
  const [w, l] = parseWL(cells[2] ?? "");
  const label = stripTags(cells[0] ?? "");
  const row: PartnerRow = {
    label,
    n: parseInt0(cells[1] ?? "0"),
    wins: w,
    losses: l,
    pnl_dollars: parseMoney(cells[3] ?? "") ?? 0,
    roi_pct: parsePct(cells[4] ?? "") ?? 0,
    dollar_per_fill: parseMoney(cells[5] ?? ""),
    sig_p: parseSig(cells[6] ?? ""),
  };
  if (splitTypeSport) {
    const { prop_type, sport } = parseTypeSport(label);
    row.prop_type = prop_type;
    row.sport = sport;
  } else {
    row.sport = label;
  }
  return row;
}

// Pregame vs Live: label | n | W/L | P&L | ROI | $/fill (no Sig)
function buildPregameLiveRow(cells: string[]): PartnerRow {
  const [w, l] = parseWL(cells[2] ?? "");
  return {
    label: stripTags(cells[0] ?? ""),
    n: parseInt0(cells[1] ?? "0"),
    wins: w,
    losses: l,
    pnl_dollars: parseMoney(cells[3] ?? "") ?? 0,
    roi_pct: parsePct(cells[4] ?? "") ?? 0,
    dollar_per_fill: parseMoney(cells[5] ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

function parsePartnerHtml(html: string): Omit<PartnerRecap, "fetched_at" | "source_url" | "stale" | "stale_age_ms"> {
  const sections = extractSectionTables(html);
  const warnings: string[] = [];
  const out = {
    parser_warnings: warnings,
    by_day: [] as PartnerRow[],
    by_week: [] as PartnerRow[],
    by_month: [] as PartnerRow[],
    by_sport: [] as PartnerRow[],
    by_prop_type: [] as PartnerRow[],
    pregame_vs_live: [] as PartnerRow[],
    pregame_by_prop_type: [] as PartnerRow[],
    live_by_prop_type: [] as PartnerRow[],
  };

  const used: Record<string, boolean> = {};
  for (const { section, rows } of sections) {
    if (used[section]) continue;
    used[section] = true;
    const dataRows = rows.slice(1);     // drop header row
    switch (section) {
      case "By Day":               out.by_day = dataRows.map(buildPeriodRow); break;
      case "By Week":              out.by_week = dataRows.map(buildPeriodRow); break;
      case "By Month":             out.by_month = dataRows.map(buildPeriodRow); break;
      case "By Sport":             out.by_sport = dataRows.map((c) => buildSportPropRow(c, false)); break;
      case "By Prop Type":         out.by_prop_type = dataRows.map((c) => buildSportPropRow(c, true)); break;
      case "Pregame vs Live":      out.pregame_vs_live = dataRows.map(buildPregameLiveRow); break;
      case "Pregame by Prop Type": out.pregame_by_prop_type = dataRows.map((c) => buildSportPropRow(c, true)); break;
      case "Live by Prop Type":    out.live_by_prop_type = dataRows.map((c) => buildSportPropRow(c, true)); break;
      default:                     warnings.push(`unknown section "${section}" — skipped`);
    }
  }

  for (const key of ["by_day", "by_sport", "by_prop_type"] as const) {
    if (out[key].length === 0) warnings.push(`section "${key}" parsed 0 rows`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch + cache + stale fallback
// ---------------------------------------------------------------------------

async function fetchPartnerHtml(): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(PARTNER_URL, {
      signal: ctrl.signal,
      headers: { "user-agent": "kalshi-rfq-dashboard/1.0 (comparison-tab)" },
    });
    if (!resp.ok) throw new Error(`partner upstream HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

// Single-entry cache + a sidecar holding the last good payload for grace
// fallback. We collapse concurrent in-flight fetches via the loader promise.
let cachedAt = 0;
let cachedPayload: PartnerRecap | null = null;
let inflight: Promise<PartnerRecap> | null = null;

export async function getPartnerRecap(force = false): Promise<PartnerRecap> {
  const now = Date.now();
  if (!force && cachedPayload && now - cachedAt < TTL_MS) {
    return cachedPayload;
  }
  if (inflight) return inflight;

  inflight = (async (): Promise<PartnerRecap> => {
    try {
      const html = await fetchPartnerHtml();
      const parsed = parsePartnerHtml(html);
      const payload: PartnerRecap = {
        fetched_at: new Date().toISOString(),
        source_url: PARTNER_URL,
        stale: false,
        ...parsed,
      };
      cachedAt = Date.now();
      cachedPayload = payload;
      return payload;
    } catch (e: any) {
      // Fall back to last good if within grace window.
      if (cachedPayload && Date.now() - cachedAt < STALE_GRACE_MS) {
        return {
          ...cachedPayload,
          stale: true,
          stale_age_ms: Date.now() - cachedAt,
          parser_warnings: [
            ...(cachedPayload.parser_warnings || []),
            `upstream fetch failed (${String(e?.message || e)}) — serving last good payload`,
          ],
        };
      }
      // Nothing in cache — surface empty result with the error.
      return {
        fetched_at: new Date().toISOString(),
        source_url: PARTNER_URL,
        stale: true,
        parser_warnings: [`upstream fetch failed: ${String(e?.message || e)}`],
        by_day: [], by_week: [], by_month: [],
        by_sport: [], by_prop_type: [],
        pregame_vs_live: [], pregame_by_prop_type: [], live_by_prop_type: [],
      };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function partnerCacheStats() {
  return {
    has_cache: cachedPayload !== null,
    age_ms: cachedPayload ? Date.now() - cachedAt : null,
    ttl_ms: TTL_MS,
    stale_grace_ms: STALE_GRACE_MS,
    last_stale: cachedPayload?.stale ?? null,
  };
}
