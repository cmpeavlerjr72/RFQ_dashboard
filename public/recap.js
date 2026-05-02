// Recap page — pull /api/recap for an ET date or date range and render
// summary KPIs + (optional) cumulative ROI chart + parlay table.

import { legTeams, teamLogoUrl } from "/labels.js";

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
    const url = `/api/recap?start=${start}&end=${end}${force ? "&fresh=1" : ""}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.data = await r.json();
    render(state.data);
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
  ].join("");

  // Sport breakdown
  renderBreakdown(data);

  // Cumulative ROI chart (range mode only)
  renderChart(data);

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
      const { sport, teams } = legTeams(leg.ticker, leg.side) || {};
      if (!sport || !teams) continue;
      // For a sport-row strip, only show teams matching the parent sport (else it
      // gets messy with cross-sport parlays). For "Cross" / unknown rows, show all.
      if (defaultSport && defaultSport !== "CROSS" && defaultSport !== "UNKNOWN") {
        if (sport.toLowerCase() !== defaultSport.toLowerCase()) continue;
      }
      for (const t of teams) {
        const key = `${sport}|${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ sport, abbr: t });
      }
    }
  }
  if (!out.length) return "";
  const truncated = out.length > max ? out.slice(0, max) : out;
  const moreChip = out.length > max ? `<span class="leg-count">+${out.length - max}</span>` : "";
  const imgs = truncated.map(({ sport, abbr }) => {
    const url = teamLogoUrl(sport, abbr);
    if (!url) return "";
    return `<img class="leg-logo" src="${url}" alt="${escapeHtml(abbr)}" title="${escapeHtml(abbr)}" loading="lazy" />`;
  }).join("");
  return `<div class="logo-strip">${imgs}${moreChip}</div>`;
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
      return `
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
    }).join("");
    return head + subs;
  }).join("");

  wrap.innerHTML = `
    <div class="row section-head">
      <h2>By Sport</h2>
      <span class="hint">player-prop parlays vs game-level (spread/total/ML) parlays</span>
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
    const { sport, teams } = legTeams(leg.ticker, leg.side) || {};
    if (!sport || !teams || !teams.length) continue;
    for (const t of teams) {
      const key = `${sport}|${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const url = teamLogoUrl(sport, t);
      if (!url) continue;
      imgs.push(`<img class="leg-logo" src="${url}" alt="${escapeHtml(t)}" title="${escapeHtml(t)}" loading="lazy" />`);
    }
  }
  if (!imgs.length) {
    return `<span class="logo-fallback">${escapeHtml((parlay.sub_title || parlay.parlay_ticker).slice(0, 80))}</span>`;
  }
  // Trailing leg-count chip helps when same-game collapses many legs to 1-2 logos
  const chip = `<span class="leg-count">${legs.length}-leg</span>`;
  return `<div class="logo-strip">${imgs.join("")}${chip}</div>`;
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

setStatus("ready");
