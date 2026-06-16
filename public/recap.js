// Recap page — pull /api/recap for an ET date or date range and render
// summary KPIs + (optional) cumulative ROI chart + parlay table.

import { legTeams, teamLogoUrl, setLogoContext } from "/labels.js";
import { buildAthleteFlagIndex, MLB_STAT_LABELS, NBA_STAT_LABELS } from "/teams.js";
import { initAccountPicker, withAccount } from "/account.js";

// Stat-code → human label dictionaries the breakdown rows draw from. The MLB
// and NBA player maps live in teams.js; the rest are inline because they're
// small and don't need to be shared.
const NHL_STAT_LABELS = {
  GOAL: "goal", PTS: "points", AST: "assists", FIRSTGOAL: "first goal",
};
const GAME_STAT_LABELS = {
  GAME: "moneyline", SPREAD: "spread", TOTAL: "total",
  F5: "first-5", F5SPREAD: "first-5 spread", F5TOTAL: "first-5 total",
  TEAMTOTAL: "team total", RFI: "run in 1st",
  FIRST10: "first 10 overs",
  BTTS: "both teams score", "1H": "1st half result",
};

// Map a single stat code to a pretty label, scoped to a sport when possible
// so "PTS" resolves correctly across NBA/NHL.
function statCodeLabel(code, sport) {
  const s = (sport || "").toUpperCase();
  if (GAME_STAT_LABELS[code]) return GAME_STAT_LABELS[code];
  if (s === "MLB" && MLB_STAT_LABELS[code]) return MLB_STAT_LABELS[code];
  if (s === "NBA" && NBA_STAT_LABELS[code]) return NBA_STAT_LABELS[code];
  if (s === "WNBA" && NBA_STAT_LABELS[code]) return NBA_STAT_LABELS[code];
  if (s === "NHL" && NHL_STAT_LABELS[code]) return NHL_STAT_LABELS[code];
  // Fallback to whichever bucket has it
  return MLB_STAT_LABELS[code] || NBA_STAT_LABELS[code] || NHL_STAT_LABELS[code] || code.toLowerCase();
}

// Render the stat-set label for a sub-row. Multi-stat parlays show e.g.
// "points + rebounds + assists"; single-stat shows "points".
function statSetLabel(stats, sport) {
  if (!stats || !stats.length) return "Unknown";
  return stats.map((s) => statCodeLabel(s, sport)).join(" + ");
}

const $ = (id) => document.getElementById(id);

const state = {
  loading: false,
  data: null,
};

function setStatus(text, cls = "") {
  $("status-text").textContent = text;
  const dot = $("status-dot");
  dot.classList.remove("live", "error", "fetching");
  if (cls) dot.classList.add(cls);
}

function fmtMoney(n, signed = false) {
  if (n == null || isNaN(n)) return "-";
  const abs = Math.abs(n).toFixed(2);
  if (signed) return `${n >= 0 ? "+" : "-"}$${abs}`;
  return n < 0 ? `-$${abs}` : `$${abs}`;
}
function fmtPct(n, signed = true) {
  if (n == null || isNaN(n)) return "-";
  const v = n.toFixed(1);
  if (signed) return `${n >= 0 ? "+" : ""}${v}%`;
  return `${v}%`;
}
function pnlClass(n) {
  if (n == null || n === 0) return "";
  return n > 0 ? "pos" : "neg";
}
// Color the win rate green/red relative to break-even. Tiny gaps (< 0.5pt)
// stay neutral — sample noise dominates differences inside that band.
function wrVsBeClass(wr, be) {
  if (wr == null || be == null) return "";
  const gap = wr - be;
  if (Math.abs(gap) < 0.5) return "";
  return gap > 0 ? "pos" : "neg";
}
function statusBadge(s) {
  switch (s) {
    case "won":  return `<span class="badge alive">won</span>`;
    case "lost": return `<span class="badge dead">lost</span>`;
    case "void": return `<span class="badge partial">void</span>`;
    default:      return `<span class="badge">open</span>`;
  }
}
function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtFillTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  // Render in ET (UTC-4 during DST). Crude but matches our recap convention.
  const etMs = d.getTime() - 4 * 3600 * 1000;
  const e = new Date(etMs);
  const mm = String(e.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(e.getUTCDate()).padStart(2, "0");
  const hh = String(e.getUTCHours()).padStart(2, "0");
  const mn = String(e.getUTCMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mn} ET`;
}

function todayEt() {
  // Browser-local "today" rough approximation; ET conversion would need a tz lib
  // — but for a date picker default this is fine.
  const now = new Date();
  const etMs = now.getTime() - 4 * 3600 * 1000;
  const d = new Date(etMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function yesterdayEt() {
  const now = new Date();
  const etMs = now.getTime() - 4 * 3600 * 1000 - 24 * 3600 * 1000;
  const d = new Date(etMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Fetch ATP/WTA scoreboards over the recap date range and feed the player
// flag index to labels.js so tennis legs render a country flag in the
// logo strip. Best-effort — failures degrade silently to abbrev-only badges.
async function loadTennisFlagsForRange(start, end) {
  const dates = [];
  for (let cur = new Date(start + "T00:00:00Z"); cur <= new Date(end + "T00:00:00Z"); cur.setUTCDate(cur.getUTCDate() + 1)) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const d = String(cur.getUTCDate()).padStart(2, "0");
    dates.push(`${y}${m}${d}`);
  }
  const scoreboards = {};
  await Promise.all(
    dates.flatMap((date) =>
      ["atp", "wta"].map(async (sport) => {
        try {
          const r = await fetch(withAccount(`/api/scoreboard?sport=${sport}&date=${date}`));
          if (!r.ok) return;
          const body = await r.json();
          scoreboards[`${sport}:${date}`] = body.payload || body;
        } catch (_e) { /* ignore */ }
      }),
    ),
  );
  const flagIdx = buildAthleteFlagIndex(scoreboards);
  setLogoContext({ playerFlagIdx: flagIdx });
}

async function loadRecap({ force = false } = {}) {
  const start = $("start-date").value;
  const useRange = $("range-toggle").checked;
  const end = useRange ? $("end-date").value : start;
  if (!start || !end) {
    setStatus("pick a date", "error");
    return;
  }
  if (end < start) {
    setStatus("end < start", "error");
    return;
  }
  state.loading = true;
  setStatus(`loading ${start}${start !== end ? `…${end}` : ""}…`, "fetching");
  $("load-btn").disabled = true;
  $("refresh-btn").disabled = true;
  try {
    // Kick off tennis-flag prefetch in parallel with the recap fetch — it
    // populates the module-level logo context used during render.
    const flagsP = loadTennisFlagsForRange(start, end);
    const url = withAccount(`/api/recap?start=${start}&end=${end}${force ? "&fresh=1" : ""}`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.data = await r.json();
    await flagsP;
    render(state.data);
    loadClv(start);                 // independent; degrades on its own
    setStatus("loaded", "live");
  } catch (e) {
    setStatus(`error: ${e.message || e}`, "error");
    $("summary").innerHTML = `<div class="empty">${escapeHtml(String(e.message || e))}</div>`;
    $("parlays-table-wrap").innerHTML = "";
  } finally {
    state.loading = false;
    $("load-btn").disabled = false;
    $("refresh-btn").disabled = false;
  }
}

function kpi(label, value, cls = "", extraHtml = "") {
  return `
    <div class="kpi">
      <div class="label">${label}</div>
      <div class="value ${cls}">${value}</div>
      ${extraHtml}
    </div>
  `;
}

/**
 * Confidence chip — short label + color, with a plain-language tooltip.
 * "likely_real" inherits direction color from sign of ROI; everything else is neutral.
 */
function confidenceChip(conf, roiPct) {
  if (!conf || conf.level === "none") return "";
  let dirCls = "";
  if (conf.level === "likely_real") {
    dirCls = (roiPct ?? 0) >= 0 ? "pos" : "neg";
  }
  return `<span class="conf-chip ${conf.level} ${dirCls}" title="${escapeHtml(conf.tooltip)}">${escapeHtml(conf.label)}</span>`;
}

function render(data) {
  const a = data.agg;
  const dateLabel = data.start_et === data.end_et
    ? data.start_et
    : `${data.start_et} → ${data.end_et}`;

  $("meta-text").textContent =
    `${dateLabel} · ${a.n_parlays} parlays · ${data.pages_fills}p fills, ${data.pages_settlements}p settle · cached ${new Date(data.fetched_at).toLocaleTimeString()}`;

  const wlv = wlvLabel(a);
  const wrCls = wrVsBeClass(a.win_rate_pct, a.breakeven_wr_pct);
  const gapPt = (a.win_rate_pct != null && a.breakeven_wr_pct != null)
    ? a.win_rate_pct - a.breakeven_wr_pct
    : null;
  const wrTip = (gapPt != null)
    ? `Win ${fmtPct(a.win_rate_pct, false)} of your fills; need to win > ${fmtPct(a.breakeven_wr_pct, false)} on average to be profitable. Edge per parlay: ${fmtPct(gapPt, true)}.`
    : "";
  const beTip = `The win rate you need to clear to make money. Computed as the average fill price across decided parlays — at any fill priced p, EV is zero when you win with prob exactly p, so on average you need WR > mean(p). Realized ROI can deviate (size of bet matters in dollars) but this is the right single threshold to compare your WR against.`;

  // ---- Payoff profile (avg win vs avg loss, $ per settled parlay) ----
  const sizeRatio = (a.avg_win != null && a.avg_loss)
    ? a.avg_win / Math.abs(a.avg_loss)
    : null;
  const payoffSub = sizeRatio != null
    ? `<div class="kpi-sub muted" title="Avg winning parlay pays +${fmtMoney(a.avg_win, false)}; avg loser costs ${fmtMoney(a.avg_loss, false)}. Long-NO collects small premiums against big tails, so this is < 1× and you need a high win rate to clear it.">${sizeRatio.toFixed(2)}× win:loss size</div>`
    : "";

  // Account growth (starting balance → ending balance) — the headline block.
  renderBalanceGrowth(data);

  $("summary").innerHTML = [
    kpi("Money risked", fmtMoney(a.cash_deployed)),
    kpi("Net P&amp;L <small>(settled only)</small>", fmtMoney(a.realized_pnl, true), pnlClass(a.realized_pnl)),
    kpi(
      "ROI <small>(on settled $)</small>",
      fmtPct(a.roi_pct),
      pnlClass(a.roi_pct),
      confidenceChip(a.confidence, a.roi_pct),
    ),
    kpi("W &middot; L &middot; V", wlv),
    kpi(
      "Win rate <small>(wins / decided)</small>",
      fmtPct(a.win_rate_pct, false),
      wrCls,
      wrTip ? `<div class="kpi-sub" title="${escapeHtml(wrTip)}">need &gt; ${fmtPct(a.breakeven_wr_pct, false)} to profit · edge ${fmtPct(gapPt, true)}</div>` : "",
    ),
    kpi(
      "Break-even target <small>(avg fill price)</small>",
      fmtPct(a.breakeven_wr_pct, false),
      "",
      `<div class="kpi-sub muted" title="${escapeHtml(beTip)}">win rate needed to break even on average</div>`,
    ),
    kpi("Avg win <small>(per parlay)</small>", a.avg_win != null ? fmtMoney(a.avg_win, true) : "-", a.avg_win != null ? "pos" : "", payoffSub),
    kpi("Avg loss <small>(per parlay)</small>", a.avg_loss != null ? fmtMoney(a.avg_loss, true) : "-", a.avg_loss != null ? "neg" : ""),
  ].join("");

  // Sport breakdown
  renderBreakdown(data);

  // Leg-count breakdown (how does parlay size affect outcomes?)
  renderLegCount(data);

  // Cumulative ROI chart (range mode only)
  renderChart(data);

  // Cumulative realized-$ chart, x = settle time (single-date or range).
  renderPnlChart(data);

  // Parlay table
  if (!data.parlays.length) {
    $("parlays-table-wrap").innerHTML = `<div class="empty">No parlays found in range.</div>`;
    $("parlays-hint").textContent = "";
    return;
  }
  $("parlays-hint").textContent = `${data.parlays.length} rows`;
  const rows = data.parlays.map((p) => {
    const pnl = p.pnl == null ? `<span class="muted">—</span>` : fmtMoney(p.pnl, true);
    return `
      <tr class="row-${p.status}" title="${escapeHtml(p.parlay_ticker)}">
        <td class="t-time">${fmtFillTime(p.first_fill_iso)}</td>
        <td class="t-logos">${renderLogoStrip(p)}</td>
        <td class="t-num">${p.qty.toFixed(0)}</td>
        <td class="t-num">${fmtMoney(p.cost)}</td>
        <td class="t-status">${statusBadge(p.status)}</td>
        <td class="t-num ${pnlClass(p.pnl)}">${pnl}</td>
      </tr>
    `;
  }).join("");
  $("parlays-table-wrap").innerHTML = `
    <table class="recap-table">
      <thead>
        <tr>
          <th>First fill (ET)</th>
          <th>Legs</th>
          <th>Qty</th>
          <th>Cost</th>
          <th>Status</th>
          <th>P&amp;L</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  $("footer-text").textContent =
    `${a.n_parlays} parlays · risked ${fmtMoney(a.cash_deployed)} · realized ${fmtMoney(a.realized_pnl, true)} · ${a.wins}-${a.losses}${a.voids ? `-${a.voids}` : ""}`;
}

function wlvLabel(a) {
  const open = a.open_count ? ` <small>(${a.open_count} open)</small>` : "";
  return `${a.wins}-${a.losses}${a.voids ? `-${a.voids}` : ""}${open}`;
}

// Cap on how many distinct team logos we render per sport row before showing "+N".
const MAX_LOGOS_PER_SPORT_ROW = 18;

function buildParlayMap(parlays) {
  const m = new Map();
  for (const p of parlays || []) m.set(p.parlay_ticker, p);
  return m;
}

/** Render a logo strip for a set of parlay tickers — dedupes (sport,abbr) across all their legs. */
function logoStripForTickers(parlayMap, tickers, defaultSport, opts = {}) {
  const max = opts.max ?? MAX_LOGOS_PER_SPORT_ROW;
  const seen = new Set();
  const out = []; // [{sport, abbr}]
  for (const tk of tickers) {
    const p = parlayMap.get(tk);
    if (!p) continue;
    for (const leg of p.legs || []) {
      const lt = legTeams(leg.ticker, leg.side) || {};
      const { sport, teams, league } = lt;
      if (!sport || !teams) continue;
      // For a sport-row strip, only show teams matching the parent sport (else it
      // gets messy with cross-sport parlays). For "Cross" / unknown rows, show all.
      if (defaultSport && defaultSport !== "CROSS" && defaultSport !== "UNKNOWN") {
        if (sport.toLowerCase() !== defaultSport.toLowerCase()) continue;
      }
      for (const t of teams) {
        const key = `${sport}|${league || ""}|${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ sport, abbr: t, league });
      }
    }
  }
  if (!out.length) return "";
  const truncated = out.length > max ? out.slice(0, max) : out;
  const moreChip = out.length > max ? `<span class="leg-count">+${out.length - max}</span>` : "";
  const imgs = truncated.map(({ sport, abbr, league }) => renderTeamBadge(sport, abbr, league)).join("");
  return `<div class="logo-strip">${imgs}${moreChip}</div>`;
}

/** Render either an <img> (logo/flag) or a small text chip if no logo is known.
 *  Keeps the soccer / unknown-sport rows from being completely blank.
 *  Pass league for soccer (e.g. "LALIGA") so the logo resolver can
 *  disambiguate across leagues. */
function renderTeamBadge(sport, abbr, league) {
  const url = teamLogoUrl(sport, abbr, { league });
  if (url) {
    return `<img class="leg-logo" src="${url}" alt="${escapeHtml(abbr)}" title="${escapeHtml(abbr)} (${escapeHtml(sport)})" loading="lazy" />`;
  }
  return `<span class="leg-badge" title="${escapeHtml(abbr)} (${escapeHtml(sport)})">${escapeHtml(abbr)}</span>`;
}

function renderBreakdown(data) {
  const wrap = $("breakdown-wrap");
  const rows = data.sport_breakdown || [];
  if (!rows.length) {
    wrap.style.display = "none";
    wrap.innerHTML = "";
    return;
  }
  wrap.style.display = "block";
  const parlayMap = buildParlayMap(data.parlays);

  const tableRows = rows.map((row) => {
    const a = row.agg;
    const sportLabel = row.sport === "CROSS" ? "Cross-sport"
      : row.sport === "UNKNOWN" ? "Other"
      : row.sport === "WC" ? "World Cup"
      : row.sport === "INTLFRIENDLY" ? "Intl Friendly"
      : row.sport;
    const logoCell = logoStripForTickers(parlayMap, row.parlay_tickers, row.sport)
      || `<span class="logo-fallback">${row.parlay_tickers.length} parlays</span>`;
    const head = `
      <tr class="breakdown-sport">
        <td class="bk-sport">
          <div class="bk-sport-cell">
            <span class="bk-sport-name">${escapeHtml(sportLabel)}</span>
            ${logoCell}
          </div>
        </td>
        <td class="t-num">${a.n_parlays}</td>
        <td class="t-num">${fmtMoney(a.cash_deployed)}</td>
        <td class="t-num ${pnlClass(a.realized_pnl)}">${fmtMoney(a.realized_pnl, true)}</td>
        <td class="t-num ${pnlClass(a.roi_pct)}">${fmtPct(a.roi_pct)}</td>
        <td class="bk-trust">${confidenceChip(a.confidence, a.roi_pct)}</td>
        <td class="t-num">${wlvLabel(a)}</td>
      </tr>
    `;
    const subs = (row.by_type || []).map((t) => {
      const ta = t.agg;
      const typeLabel = t.type === "player" ? "Player props" : "Game level";
      const typeRow = `
        <tr class="breakdown-sub">
          <td class="bk-sport">
            <div class="bk-sub-cell">
              <span class="bk-sub-tick">└</span>
              <span class="bk-sub-name">${typeLabel}</span>
            </div>
          </td>
          <td class="t-num">${ta.n_parlays}</td>
          <td class="t-num">${fmtMoney(ta.cash_deployed)}</td>
          <td class="t-num ${pnlClass(ta.realized_pnl)}">${fmtMoney(ta.realized_pnl, true)}</td>
          <td class="t-num ${pnlClass(ta.roi_pct)}">${fmtPct(ta.roi_pct)}</td>
          <td class="bk-trust">${confidenceChip(ta.confidence, ta.roi_pct)}</td>
          <td class="t-num">${wlvLabel(ta)}</td>
        </tr>
      `;
      const statRows = (t.by_stat || []).map((s) => {
        const sa = s.agg;
        const label = statSetLabel(s.stats, row.sport);
        const codeChip = s.stat_set && s.stat_set !== "UNKNOWN"
          ? `<span class="bk-stat-code" title="raw stat code(s)">${escapeHtml(s.stat_set)}</span>`
          : "";
        return `
          <tr class="breakdown-stat">
            <td class="bk-sport">
              <div class="bk-stat-cell">
                <span class="bk-stat-tick">└─</span>
                <span class="bk-stat-name">${escapeHtml(label)}</span>
                ${codeChip}
              </div>
            </td>
            <td class="t-num">${sa.n_parlays}</td>
            <td class="t-num">${fmtMoney(sa.cash_deployed)}</td>
            <td class="t-num ${pnlClass(sa.realized_pnl)}">${fmtMoney(sa.realized_pnl, true)}</td>
            <td class="t-num ${pnlClass(sa.roi_pct)}">${fmtPct(sa.roi_pct)}</td>
            <td class="bk-trust">${confidenceChip(sa.confidence, sa.roi_pct)}</td>
            <td class="t-num">${wlvLabel(sa)}</td>
          </tr>
        `;
      }).join("");
      return typeRow + statRows;
    }).join("");
    return head + subs;
  }).join("");

  wrap.innerHTML = `
    <div class="row section-head">
      <h2>By Sport</h2>
      <span class="hint">sport → player-prop vs game-level → individual stat type</span>
    </div>
    <table class="recap-table breakdown-table">
      <thead>
        <tr>
          <th>Sport</th>
          <th class="t-num"># Parlays</th>
          <th class="t-num">Risked</th>
          <th class="t-num">Net P&amp;L</th>
          <th class="t-num">ROI</th>
          <th>Trust</th>
          <th class="t-num">W-L-V</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;
}

// ---------- leg-count breakdown ----------
function renderLegCount(data) {
  const wrap = $("legcount-wrap");
  const rows = data.leg_count_breakdown || [];
  // Only worth showing when there's more than one bucket to compare.
  if (rows.length < 2) {
    wrap.style.display = "none";
    wrap.innerHTML = "";
    return;
  }
  wrap.style.display = "block";
  const tableRows = rows.map((row) => {
    const a = row.agg;
    const label = row.n_legs === 0 ? "Unknown" : `${row.n_legs}-leg`;
    return `
      <tr class="breakdown-sport">
        <td class="bk-sport"><span class="bk-sport-name">${label}</span></td>
        <td class="t-num">${a.n_parlays}</td>
        <td class="t-num">${fmtMoney(a.cash_deployed)}</td>
        <td class="t-num ${pnlClass(a.realized_pnl)}">${fmtMoney(a.realized_pnl, true)}</td>
        <td class="t-num ${pnlClass(a.roi_pct)}">${fmtPct(a.roi_pct)}</td>
        <td class="bk-trust">${confidenceChip(a.confidence, a.roi_pct)}</td>
        <td class="t-num">${wlvLabel(a)}</td>
      </tr>
    `;
  }).join("");

  wrap.innerHTML = `
    <div class="row section-head">
      <h2>By Leg Count</h2>
      <span class="hint">does parlay size change the edge? more legs = more correlation premium, but harder to win</span>
    </div>
    <table class="recap-table breakdown-table">
      <thead>
        <tr>
          <th>Legs</th>
          <th class="t-num"># Parlays</th>
          <th class="t-num">Risked</th>
          <th class="t-num">Net P&amp;L</th>
          <th class="t-num">ROI</th>
          <th>Trust</th>
          <th class="t-num">W-L-V</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;
}

// ---------- logo strip ----------
function renderLogoStrip(parlay) {
  const legs = parlay.legs || [];
  if (!legs.length) {
    // fallback to parlay ticker if no legs
    return `<span class="logo-fallback">${escapeHtml((parlay.sub_title || parlay.parlay_ticker).slice(0, 80))}</span>`;
  }
  // Each leg may resolve to 1-2 team abbrs. Render an inline logo for each
  // distinct (sport,abbr); duplicate teams across legs of the same parlay
  // (very common — same-game) collapse to one rendered logo.
  const seen = new Set();
  const imgs = [];
  for (const leg of legs) {
    const lt = legTeams(leg.ticker, leg.side) || {};
    const { sport, teams, league } = lt;
    if (!sport || !teams || !teams.length) continue;
    for (const t of teams) {
      const key = `${sport}|${league || ""}|${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      imgs.push(renderTeamBadge(sport, t, league));
    }
  }
  if (!imgs.length) {
    return `<span class="logo-fallback">${escapeHtml((parlay.sub_title || parlay.parlay_ticker).slice(0, 80))}</span>`;
  }
  // Trailing leg-count chip helps when same-game collapses many legs to 1-2 logos
  const chip = `<span class="leg-count">${legs.length}-leg</span>`;
  return `<div class="logo-strip">${imgs.join("")}${chip}</div>`;
}

// ---------- account growth (starting → ending balance) ----------
// Format a day count as a human duration for the doubling-time KPI.
function fmtDuration(days) {
  if (days == null || !isFinite(days) || days <= 0) return "—";
  if (days < 1) return "<1 day";
  if (days < 90) return `${days.toFixed(days < 10 ? 1 : 0)} days`;
  const yrs = days / 365;
  return yrs < 10 ? `${yrs.toFixed(1)} yr` : `${Math.round(yrs)} yr`;
}

function renderBalanceGrowth(data) {
  const wrap = $("growth-wrap");
  const g = data.balance_growth;
  if (!g) { wrap.style.display = "none"; wrap.innerHTML = ""; return; }
  wrap.style.display = "block";

  const dayLabel = data.start_et === data.end_et
    ? data.start_et : `${data.start_et} → ${data.end_et}`;
  const nDays = g.n_days || 1;
  const growthCls = pnlClass(g.growth_dollars);
  const pctCls = pnlClass(g.growth_pct);

  const startVal = g.has_balance ? fmtMoney(g.starting_balance) : `<span class="muted">n/a</span>`;
  const endVal = g.has_balance ? fmtMoney(g.ending_balance) : `<span class="muted">n/a</span>`;
  const noBalance = g.has_balance ? "" :
    `<div class="kpi-sub muted">live balance unavailable — can't anchor starting balance</div>`;

  const kpis = [
    kpi("Starting balance", startVal, "",
      g.has_balance
        ? `<div class="kpi-sub muted" title="Realized balance now (cash + cost basis of open positions) minus all settled P&amp;L from bets first-filled on/after ${data.start_et}.">account value at period start</div>`
        : noBalance),
    kpi("Ending balance", endVal, g.has_balance ? growthCls : "",
      g.has_balance ? `<div class="kpi-sub muted">start + settled growth</div>` : ""),
    kpi("Growth <small>(settled $)</small>", fmtMoney(g.growth_dollars, true), growthCls,
      `<div class="kpi-sub muted">realized P&amp;L over period</div>`),
    kpi("Growth %", g.growth_pct != null ? fmtPct(g.growth_pct) : "-", pctCls,
      g.has_balance && g.starting_balance
        ? `<div class="kpi-sub muted" title="Growth ÷ starting balance">on ${fmtMoney(g.starting_balance)} starting</div>`
        : ""),
    kpi("Avg growth / day", g.avg_daily_pct != null ? fmtPct(g.avg_daily_pct) : "-", pnlClass(g.avg_daily_pct),
      `<div class="kpi-sub muted">compounded over ${nDays} day${nDays === 1 ? "" : "s"}</div>`),
    kpi("Doubling time", fmtDuration(g.doubling_days), "",
      `<div class="kpi-sub muted" title="Projected days to double the account at the average daily growth rate, compounded.">at current daily rate</div>`),
  ].join("");

  wrap.innerHTML = `
    <div class="row section-head">
      <h2>Account Growth</h2>
      <span class="hint">${dayLabel} · settled P&amp;L as % of the balance at the start of the period · attributed by fill date</span>
    </div>
    <div class="summary growth-kpis">${kpis}</div>
    ${balanceChartSvg(data, g)}
  `;
}

// Running-balance line: anchor at starting_balance, add each ET day's cumulative
// settled P&L. Reuses data.daily (same fill-date attribution as every other KPI).
function balanceChartSvg(data, g) {
  if (!g.has_balance || g.starting_balance == null) return "";
  const daily = data.daily || [];
  if (!daily.length) return "";
  const start = g.starting_balance;
  const series = [{ date: data.start_et, bal: start, pnl: 0, isStart: true }];
  for (const d of daily) {
    series.push({
      date: d.date,
      bal: start + (d.cum_realized_pnl || 0),
      pnl: d.realized_pnl || 0,
      isStart: false,
    });
  }
  const n = series.length;

  const W = 1000, H = 240;
  const padL = 64, padR = 16, padT = 16, padB = 34;
  const inW = W - padL - padR, inH = H - padT - padB;

  const bals = series.map((s) => s.bal);
  let yMin = Math.min(...bals), yMax = Math.max(...bals);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const span = yMax - yMin;
  yMin -= span * 0.12; yMax += span * 0.12;

  const xFor = (i) => padL + (n === 1 ? inW / 2 : (i / (n - 1)) * inW);
  const yFor = (v) => padT + inH - ((v - yMin) / (yMax - yMin)) * inH;

  const path = series
    .map((s, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(s.bal).toFixed(1)}`)
    .join(" ");

  const dots = series.map((s, i) => {
    const cx = xFor(i), cy = yFor(s.bal);
    const cls = s.isStart ? "dot pending"
      : s.pnl > 0 ? "dot pos" : s.pnl < 0 ? "dot neg" : "dot pending";
    const tip = s.isStart
      ? `${s.date}: start $${s.bal.toFixed(2)}`
      : `${s.date}: ${s.pnl >= 0 ? "+" : "-"}$${Math.abs(s.pnl).toFixed(2)} → balance $${s.bal.toFixed(2)}`;
    return `<circle class="${cls}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.5"><title>${escapeHtml(tip)}</title></circle>`;
  }).join("");

  const yTicks = [];
  for (let t = 0; t < 5; t++) {
    const v = yMin + (t / 4) * (yMax - yMin);
    const yy = yFor(v);
    yTicks.push(`<g class="tick"><line x1="${padL}" y1="${yy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yy.toFixed(1)}"/><text x="${padL - 6}" y="${yy.toFixed(1)}" text-anchor="end" dominant-baseline="central">$${v.toFixed(0)}</text></g>`);
  }

  const xLabels = [];
  const step = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i < n; i += step) {
    xLabels.push(`<text x="${xFor(i).toFixed(1)}" y="${(H - 10).toFixed(1)}" text-anchor="middle">${shortDate(series[i].date)}</text>`);
  }
  if ((n - 1) % step !== 0) {
    xLabels.push(`<text x="${xFor(n - 1).toFixed(1)}" y="${(H - 10).toFixed(1)}" text-anchor="middle">${shortDate(series[n - 1].date)}</text>`);
  }

  const endBal = series[n - 1].bal;
  const pctTxt = g.growth_pct != null ? `${g.growth_pct >= 0 ? "+" : ""}${g.growth_pct.toFixed(1)}%` : "";
  return `
    <div class="chart-wrap">
      <svg class="roi-chart balance-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <g class="axis-y">${yTicks.join("")}</g>
        <path class="line" d="${path}"/>
        <g class="dots">${dots}</g>
        <g class="axis-x">${xLabels.join("")}</g>
      </svg>
      <div class="chart-caption">Account balance by ET day — $${start.toFixed(2)} starting → $${endBal.toFixed(2)} ending${pctTxt ? ` (${pctTxt})` : ""}. Growth = settled P&amp;L attributed by fill date; open positions excluded.</div>
    </div>
  `;
}

// ---------- cumulative ROI chart ----------
function renderChart(data) {
  const wrap = $("chart-wrap");
  const useRange = $("range-toggle").checked && data.start_et !== data.end_et;
  if (!useRange || !data.daily || data.daily.length < 2) {
    wrap.style.display = "none";
    wrap.innerHTML = "";
    return;
  }
  // Use rows that have a defined cum_roi_pct; if all null, hide the chart
  const points = data.daily.map((d, i) => ({ i, d, roi: d.cum_roi_pct }));
  if (!points.some((p) => p.roi !== null)) {
    wrap.style.display = "block";
    wrap.innerHTML = `<div class="empty">No settled parlays yet — cumulative ROI not available.</div>`;
    return;
  }
  wrap.style.display = "block";
  wrap.innerHTML = chartSvg(data.daily);
}

function chartSvg(daily) {
  const W = 1000, H = 220;
  const padL = 48, padR = 16, padT = 16, padB = 32;
  const inW = W - padL - padR;
  const inH = H - padT - padB;

  // Use cumulative ROI; treat nulls (no settled cost yet) as the prior value
  // so the line stays continuous, but mark these dots faintly.
  let last = 0;
  const series = daily.map((d) => {
    const v = d.cum_roi_pct;
    if (v != null) last = v;
    return { date: d.date, roi: v == null ? last : v, hasData: v != null, raw: d };
  });
  const n = series.length;

  const ys = series.map((s) => s.roi);
  let yMin = Math.min(...ys, 0);
  let yMax = Math.max(...ys, 0);
  // Pad a touch
  const span = Math.max(1, yMax - yMin);
  yMin -= span * 0.1; yMax += span * 0.1;

  const xFor = (i) => padL + (n === 1 ? inW / 2 : (i / (n - 1)) * inW);
  const yFor = (v) => padT + inH - ((v - yMin) / (yMax - yMin)) * inH;
  const yZero = yFor(0);

  const path = series
    .map((s, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(s.roi).toFixed(1)}`)
    .join(" ");

  const dots = series.map((s, i) => {
    const cx = xFor(i), cy = yFor(s.roi);
    const cls = s.hasData ? (s.roi >= 0 ? "dot pos" : "dot neg") : "dot pending";
    const tip = s.hasData
      ? `${s.date}: cum ROI ${s.roi >= 0 ? "+" : ""}${s.roi.toFixed(1)}% on $${s.raw.cum_settled_cost.toFixed(2)} settled (cum P&L ${s.raw.cum_realized_pnl >= 0 ? "+" : "-"}$${Math.abs(s.raw.cum_realized_pnl).toFixed(2)})`
      : `${s.date}: no settled yet (carrying ${s.roi >= 0 ? "+" : ""}${s.roi.toFixed(1)}%)`;
    return `<circle class="${cls}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.5"><title>${escapeHtml(tip)}</title></circle>`;
  }).join("");

  // Y axis ticks: 4 ticks across [yMin, yMax]
  const yTicks = [];
  for (let t = 0; t < 5; t++) {
    const frac = t / 4;
    const v = yMin + frac * (yMax - yMin);
    const yy = yFor(v);
    yTicks.push(
      `<g class="tick"><line x1="${padL}" y1="${yy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yy.toFixed(1)}"/><text x="${padL - 6}" y="${yy.toFixed(1)}" text-anchor="end" dominant-baseline="central">${v >= 0 ? "+" : ""}${v.toFixed(0)}%</text></g>`
    );
  }

  // X labels — first, last, plus interior labels every ~7-day step
  const xLabels = [];
  const step = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i < n; i += step) {
    const cx = xFor(i);
    xLabels.push(`<text x="${cx.toFixed(1)}" y="${(H - 10).toFixed(1)}" text-anchor="middle">${shortDate(series[i].date)}</text>`);
  }
  if ((n - 1) % step !== 0) {
    const cx = xFor(n - 1);
    xLabels.push(`<text x="${cx.toFixed(1)}" y="${(H - 10).toFixed(1)}" text-anchor="middle">${shortDate(series[n - 1].date)}</text>`);
  }

  return `
    <svg class="roi-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <g class="axis-y">${yTicks.join("")}</g>
      <line class="zero" x1="${padL}" y1="${yZero.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yZero.toFixed(1)}"/>
      <path class="line" d="${path}"/>
      <g class="dots">${dots}</g>
      <g class="axis-x">${xLabels.join("")}</g>
    </svg>
    <div class="chart-caption">Cumulative ROI on settled cost, by ET day. Open positions excluded.</div>
  `;
}

function shortDate(ymd) {
  // 2026-04-30 -> 4/30
  if (!ymd) return "";
  const [, m, d] = ymd.split("-");
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

// ---------- cumulative realized-$ chart (x = settle time) ----------
// Progression view: every settled parlay in the recap window contributes
// a step at its `settled_time_iso` of +pnl. Voids land as flat dots
// (pnl=0). Open parlays excluded. Settlements that land outside the
// recap date window are still plotted — they're real P&L from bets first
// taken inside the window, so they belong on the curve.
function renderPnlChart(data) {
  const wrap = $("pnl-chart-wrap");
  const points = (data.parlays || [])
    .filter((p) => p.settled_time_iso && p.pnl != null)
    .map((p) => ({
      tMs: Date.parse(p.settled_time_iso),
      pnl: p.pnl,
      cost: p.cost,
      status: p.status,
      tk: p.parlay_ticker,
      sub: p.sub_title || "",
    }))
    .filter((p) => Number.isFinite(p.tMs))
    .sort((a, b) => a.tMs - b.tMs);

  if (points.length < 1) {
    wrap.style.display = "none";
    wrap.innerHTML = "";
    return;
  }
  // Single-point case still useful — show it, but skip the line.
  let cum = 0;
  const series = points.map((p) => {
    cum += p.pnl;
    return { ...p, cum };
  });
  wrap.style.display = "block";
  wrap.innerHTML = pnlChartSvg(series, data.start_et, data.end_et);
}

function pnlChartSvg(series, startEt, endEt) {
  const W = 1000, H = 220;
  const padL = 56, padR = 16, padT = 16, padB = 32;
  const inW = W - padL - padR;
  const inH = H - padT - padB;

  // X domain: full ET window from start_et 00:00 to end_et 24:00, so the
  // chart contextualises gaps (no settlements yet today) instead of
  // hugging the first/last point. Extend right edge to include any
  // settlements that spilled past the window (rare but happens for
  // late-night MLB settling next morning).
  const startMs = etDayStartUtcMsClient(startEt);
  const endMs = etDayEndUtcMsClient(endEt);
  const xMin = Math.min(startMs, series[0].tMs);
  const xMax = Math.max(endMs, series[series.length - 1].tMs);
  const xSpan = Math.max(1, xMax - xMin);

  // Y domain: include zero so the baseline is anchored visually.
  const cums = series.map((s) => s.cum);
  let yMin = Math.min(0, ...cums);
  let yMax = Math.max(0, ...cums);
  const ySpan = Math.max(1, yMax - yMin);
  yMin -= ySpan * 0.08; yMax += ySpan * 0.08;

  const xFor = (ms) => padL + ((ms - xMin) / xSpan) * inW;
  const yFor = (v) => padT + inH - ((v - yMin) / (yMax - yMin)) * inH;
  const yZero = yFor(0);

  // Step path: horizontal at prior cum, vertical jump at each settle.
  // Start the line at (xMin, 0) so the leading flat-at-zero portion
  // (before the first settlement) is visible.
  let d = `M${xFor(xMin).toFixed(1)},${yZero.toFixed(1)}`;
  let prevCum = 0;
  for (const s of series) {
    const x = xFor(s.tMs);
    d += ` L${x.toFixed(1)},${yFor(prevCum).toFixed(1)}`;
    d += ` L${x.toFixed(1)},${yFor(s.cum).toFixed(1)}`;
    prevCum = s.cum;
  }
  // Extend final flat to the right edge so the eye can see "this is
  // where we sit now".
  d += ` L${xFor(xMax).toFixed(1)},${yFor(prevCum).toFixed(1)}`;

  const dots = series.map((s) => {
    const cx = xFor(s.tMs), cy = yFor(s.cum);
    const cls = s.status === "void" ? "dot pending"
      : s.pnl > 0 ? "dot pos"
      : s.pnl < 0 ? "dot neg"
      : "dot pending";
    const sign = s.pnl >= 0 ? "+" : "-";
    const cumSign = s.cum >= 0 ? "+" : "-";
    const tip = `${fmtSettleTime(s.tMs)} · ${s.status} · ${sign}$${Math.abs(s.pnl).toFixed(2)} (cum ${cumSign}$${Math.abs(s.cum).toFixed(2)})${s.sub ? `\n${s.sub}` : ""}`;
    return `<circle class="${cls}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3"><title>${escapeHtml(tip)}</title></circle>`;
  }).join("");

  // Y ticks: 5 evenly spaced; format as signed dollars.
  const yTicks = [];
  for (let t = 0; t < 5; t++) {
    const frac = t / 4;
    const v = yMin + frac * (yMax - yMin);
    const yy = yFor(v);
    const label = (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(0);
    yTicks.push(
      `<g class="tick"><line x1="${padL}" y1="${yy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yy.toFixed(1)}"/><text x="${padL - 6}" y="${yy.toFixed(1)}" text-anchor="end" dominant-baseline="central">${label}</text></g>`
    );
  }

  // X ticks: 7 evenly spaced across the time window.
  const xLabels = [];
  const N_TICKS = 7;
  const multiDay = startEt !== endEt;
  for (let i = 0; i <= N_TICKS; i++) {
    const ms = xMin + (i / N_TICKS) * xSpan;
    const cx = xFor(ms);
    xLabels.push(`<text x="${cx.toFixed(1)}" y="${(H - 10).toFixed(1)}" text-anchor="middle">${escapeHtml(fmtXTime(ms, multiDay))}</text>`);
  }

  const finalCum = series[series.length - 1].cum;
  const cumLabel = (finalCum >= 0 ? "+$" : "-$") + Math.abs(finalCum).toFixed(2);
  return `
    <svg class="roi-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <g class="axis-y">${yTicks.join("")}</g>
      <line class="zero" x1="${padL}" y1="${yZero.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yZero.toFixed(1)}"/>
      <path class="line" d="${d}"/>
      <g class="dots">${dots}</g>
      <g class="axis-x">${xLabels.join("")}</g>
    </svg>
    <div class="chart-caption">Cumulative realized P&amp;L by settle time (ET). ${series.length} settled parlay${series.length === 1 ? "" : "s"} · ending ${cumLabel}. Open positions excluded.</div>
  `;
}

// ET-day boundaries computed client-side (mirrors server recap.ts; ET=UTC-4).
function etDayStartUtcMsClient(ymd) {
  return Date.parse(`${ymd}T04:00:00Z`);
}
function etDayEndUtcMsClient(ymd) {
  return etDayStartUtcMsClient(ymd) + 24 * 3600 * 1000;
}

// "5/27 18:25" for multi-day windows, "18:25" for single-day.
function fmtXTime(ms, multiDay) {
  const e = new Date(ms - 4 * 3600 * 1000);
  const hh = String(e.getUTCHours()).padStart(2, "0");
  const mn = String(e.getUTCMinutes()).padStart(2, "0");
  if (!multiDay) return `${hh}:${mn}`;
  const mm = e.getUTCMonth() + 1;
  const dd = e.getUTCDate();
  return `${mm}/${dd} ${hh}:${mn}`;
}

function fmtSettleTime(ms) {
  const e = new Date(ms - 4 * 3600 * 1000);
  const mm = String(e.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(e.getUTCDate()).padStart(2, "0");
  const hh = String(e.getUTCHours()).padStart(2, "0");
  const mn = String(e.getUTCMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mn} ET`;
}

// ---------- init ----------
$("range-toggle").addEventListener("change", () => {
  $("end-wrap").style.display = $("range-toggle").checked ? "" : "none";
  if ($("range-toggle").checked && !$("end-date").value) {
    $("end-date").value = $("start-date").value;
  }
});
$("load-btn").addEventListener("click", () => loadRecap({ force: false }));
$("refresh-btn").addEventListener("click", () => loadRecap({ force: true }));

// Default to yesterday-ET (matches recap_yesterday.py mental model) so the
// first paint shows fully-settled data.
$("start-date").value = yesterdayEt();
$("end-date").value = yesterdayEt();
$("end-date").max = todayEt();
$("start-date").max = todayEt();

// Account switcher: reload the recap for the newly-selected account if data
// is already on screen (otherwise just wait for the user to hit Load).
initAccountPicker((newAccount) => {
  setStatus(`switched to ${newAccount}`);
  if (state.data) loadRecap({ force: false });
});

setStatus("ready");

// ---- CLV vs Pinnacle close (separate /api/clv fetch; degrades on its own) ----
// Closing fair comes from the Python Dixon-Coles producer (clv_sync.py), so this
// is a standalone fetch keyed to the start date. Hidden when there's no covered
// soccer book for the day.
async function loadClv(date) {
  const wrap = $("clv-wrap");
  try {
    const r = await fetch(withAccount(`/api/clv?date=${date}`));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    renderClv(await r.json(), date);
  } catch {
    wrap.style.display = "none";
    wrap.innerHTML = "";
  }
}

function fmtCents(n) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "¢"; }
function fmtPp(n) { return (n >= 0 ? "+" : "") + n.toFixed(1) + "pp"; }

function clvMetricKpi(label, m, tip) {
  if (!m) return kpi(label, "-", "");
  const sub = m.pct_stake != null ? `${fmtPct(m.pct_stake)} of stake` : "";
  return kpi(label, `${fmtCents(m.cents_per_contract)}/ct`, pnlClass(m.cents_per_contract),
    `<div class="kpi-sub muted" title="${escapeHtml(tip)}">${sub}</div>`);
}

const CLV_TIPS = {
  net: "Value of the positions we took, per Pinnacle's closing fair, minus what we paid — variance-free. It measures price quality, NOT whether bets won. Positive = we sold above the sharp close. = markup + drift.",
  markup: "The edge we built into our price (vig + correlation + surface adjustment) vs our own fair at fill time.",
  drift: "How the closing line moved relative to our fill-time fair. Negative = the market drifted toward the parlay buyer after we filled (mild adverse selection / toxic flow).",
  gap: "Our leg fair vs Pinnacle's closing fair (yes side). + = we priced the outcome MORE likely than the close. ML/Total are fit directly to Pinnacle; Spread/BTTS closes are derived from the fitted scoreline model.",
};

function renderClv(d, date) {
  const wrap = $("clv-wrap");
  if (!d || !d.available || !d.kpi) { wrap.style.display = "none"; wrap.innerHTML = ""; return; }
  wrap.style.display = "block";
  const k = d.kpi, cov = d.coverage;
  const kpis = [
    clvMetricKpi("Net CLV vs close", k.net, CLV_TIPS.net),
    clvMetricKpi("Markup we added", k.markup, CLV_TIPS.markup),
    clvMetricKpi("Line drift (post-fill)", k.drift, CLV_TIPS.drift),
  ].join("");
  const games = d.games.map(clvGameNode).filter(Boolean).join("");
  const covPct = cov.pct_stake != null ? fmtPct(cov.pct_stake, false) : "-";
  wrap.innerHTML = `
    <div class="row section-head">
      <h2>CLV vs Pinnacle close</h2>
      <span class="hint">${escapeHtml(date)} · how far our prices beat the sharpest closing line, variance-free · ${cov.n_covered}/${cov.n_parlays} parlays priced (${covPct} of stake)${d.source === "hf" ? " · via HF" : ""}</span>
    </div>
    <div class="summary clv-kpis">${kpis}</div>
    <div class="clv-tree">${games || '<div class="empty">no covered games for this day</div>'}</div>
  `;
}

function clvGameNode(g) {
  if (!g.kpi) return "";
  const net = g.kpi.net;
  const cls = pnlClass(net.cents_per_contract);
  const bts = g.bettypes.map((b) => {
    const flag = Math.abs(b.gap_pp) >= 4 ? " clv-bt-flag" : "";
    const gcls = b.gap_pp >= 0 ? "pos" : "neg";
    return `<div class="clv-bt${flag}" title="${escapeHtml(CLV_TIPS.gap)}">
      <span class="clv-bt-type">${escapeHtml(b.type)}</span>
      <span class="clv-bt-gap ${gcls}">${fmtPp(b.gap_pp)}</span>
      <span class="clv-bt-detail muted">ours ${(b.our_p * 100).toFixed(0)}% vs close ${(b.close_p * 100).toFixed(0)}% · ${b.n} leg${b.n === 1 ? "" : "s"}</span>
    </div>`;
  }).join("");
  return `<details class="clv-game">
    <summary>
      <span class="clv-game-label">${escapeHtml(g.label)}</span>
      <span class="clv-game-net ${cls}">${fmtCents(net.cents_per_contract)}/ct</span>
      <span class="clv-game-sub muted">${net.pct_stake != null ? fmtPct(net.pct_stake) : ""} · $${g.kpi.stake.toFixed(0)} · ${g.kpi.n} parlay${g.kpi.n === 1 ? "" : "s"}</span>
    </summary>
    <div class="clv-bts">${bts || '<div class="muted">no per-leg breakdown</div>'}</div>
  </details>`;
}

