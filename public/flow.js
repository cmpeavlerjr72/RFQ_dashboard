// Impossible-Flow tab — pull /api/impflow (per-game firehose of structurally-
// impossible RFQs) for an ET date and render:
//   1. summary KPIs (firehose total · quoted · won)
//   2. one card per game (busiest first): an intraday stacked bar of impossible-
//      RFQ flow per 10-min window — gold = total firehose, blue = we quoted,
//      green = we won — so you see how much of each game's free-money flow we
//      capture, including games/shapes we aren't quoting at all.
//   3. click a game to expand its UNIQUE SHAPES with where each is clearing
//      (NO price off the live tape) vs our bid — no manual lookups.
// One toggle flips every metric between # RFQs and $ budget (taker target cost).

import { teamLogoUrl } from "/labels.js";
import { NATIONAL_TEAMS } from "/national_teams.js";
import { MLB_TEAMS, NHL_TEAMS, NBA_TEAMS } from "/teams.js";

const $ = (id) => document.getElementById(id);
const NATIONAL = new Set(["WC", "INTLFRIENDLY", "UCL", "EPL", "SOCCER"]);

const state = {
  data: null,
  metric: "rfqs",            // "rfqs" (count) | "risk" ($ budget)
  expandedGames: new Set(),
};

// ---- formatting ----
function fmtMoney(n) {
  if (n == null || isNaN(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
const fmtInt = (n) => (n == null || isNaN(n) ? "-" : Math.round(n).toLocaleString());
const fmtPct = (n, dp = 0) => (n == null || isNaN(n) ? "-" : `${n.toFixed(dp)}%`);
function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function etHM(epochSec) {
  const e = new Date(epochSec * 1000 - 4 * 3600 * 1000);
  return `${String(e.getUTCHours()).padStart(2, "0")}:${String(e.getUTCMinutes()).padStart(2, "0")}`;
}
function todayEt() {
  const d = new Date(Date.now() - 4 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// metric accessors
const fireOf = (c) => (state.metric === "risk" ? c.risk : c.rfqs);
const quotedOf = (c) => (state.metric === "risk" ? (c.quoted_risk || 0) : c.quoted);
const wonOf = (c) => (state.metric === "risk" ? (c.won_risk || 0) : c.won);
const metricLabel = () => (state.metric === "risk" ? "$ budget" : "# RFQs");
const fmtMetric = (n) => (state.metric === "risk" ? fmtMoney(n) : fmtInt(n));

// ---- team/flag helpers ----
function logoKeyFor(sport) {
  const s = (sport || "").toUpperCase();
  if (s === "WC") return "wcup";
  if (s === "INTLFRIENDLY") return "intlfriendly";
  if (s === "SOCCER" || s === "UCL" || s === "EPL") return "soccer";
  return s.toLowerCase();
}
function teamName(sport, code) {
  const s = (sport || "").toUpperCase();
  if (NATIONAL.has(s)) return NATIONAL_TEAMS[code] || code;
  if (s === "MLB") return MLB_TEAMS[code] || code;
  if (s === "NHL") return NHL_TEAMS[code] || code;
  if (s === "NBA") return NBA_TEAMS[code] || code;
  return code;
}
function flagImg(sport, code) {
  const u = teamLogoUrl(logoKeyFor(sport), code);
  return u ? `<img class="gx-flag" src="${u}" alt="${escapeHtml(code)}" onerror="this.style.display='none'">` : "";
}

// Derive the two team codes for a game from its shape strings (each shape names
// team codes like "USA", "USA2", "AUS"); strip trailing line digits, take the
// two most frequent, then order by appearance in the game token (soccer/national
// tokens are HOME-first). Falls back to halving the date-stripped matchup.
const NON_TEAM = new Set(["BTTS", "NO", "YES", "OVER", "UNDER", "TIE", "DRAW"]);
function teamsForGame(g) {
  const counts = new Map();
  for (const s of g.shapes || []) {
    const inside = (s.shape.split(":")[1] || s.shape);
    for (const tok of inside.replace(/[[\]]/g, "").split(/[,\/\s]+/)) {
      const base = tok.replace(/\d+$/, "").trim().toUpperCase();
      if (base.length >= 2 && base.length <= 4 && !NON_TEAM.has(base) && /^[A-Z]+$/.test(base)) {
        counts.set(base, (counts.get(base) || 0) + 1);
      }
    }
  }
  let codes = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 2);
  if (codes.length < 2) {
    const m = g.game.replace(/^\d+[A-Z]{3}\d+/, "");   // strip a 26JUN19-style date
    if (m.length >= 4 && m.length % 2 === 0) codes = [m.slice(0, m.length / 2), m.slice(m.length / 2)];
  }
  if (codes.length < 2) return { home: g.game, away: "" };
  const idx = (c) => { const i = g.game.indexOf(c); return i < 0 ? 1e9 : i; };
  const ordered = [...codes].sort((a, b) => idx(a) - idx(b));   // first-in-token first
  const s = (g.sport || "").toUpperCase();
  const awayFirst = !(NATIONAL.has(s));
  return awayFirst ? { home: ordered[1], away: ordered[0] } : { home: ordered[0], away: ordered[1] };
}

function setStatus(text, cls = "") {
  $("status-text").textContent = text;
  const dot = $("status-dot");
  dot.classList.remove("live", "error", "fetching");
  if (cls) dot.classList.add(cls);
}

async function loadFlow({ force = false } = {}) {
  const date = $("flow-date").value || todayEt();
  setStatus(`loading ${date}…`, "fetching");
  $("refresh-btn").disabled = true;
  try {
    const r = await fetch(`/api/impflow?date=${date}${force ? "&fresh=1" : ""}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.data = await r.json();
    render();
    setStatus(state.data.source === "empty" ? "no data" : `loaded (${state.data.source})`,
              state.data.source === "empty" ? "error" : "live");
  } catch (e) {
    setStatus(`error: ${e.message || e}`, "error");
    $("summary").innerHTML = `<div class="empty">${escapeHtml(String(e.message || e))}</div>`;
  } finally {
    $("refresh-btn").disabled = false;
  }
}

function kpi(label, value, cls = "", sub = "") {
  return `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div>${sub ? `<div class="kpi-sub muted">${sub}</div>` : ""}</div>`;
}

function render() {
  const d = state.data;
  if (!d) return;
  const s = d.summary || { rfqs: 0, risk: 0, quoted_rfqs: 0, won_rfqs: 0, won_risk: 0, n_games: 0 };
  const upd = d.updated_at ? new Date(d.updated_at * 1000).toLocaleTimeString() : "—";
  $("meta-text").textContent =
    `${d.date} · ${fmtInt(s.rfqs)} impossible RFQs · ${s.n_games} games · ${d.source} · upd ${upd}`;

  const capturePct = s.rfqs > 0 ? (100 * s.quoted_rfqs) / s.rfqs : 0;
  $("summary").innerHTML = [
    kpi("Impossible RFQs", fmtInt(s.rfqs), "", "in the firehose today"),
    kpi("$ budget (free money)", fmtMoney(s.risk), "", "taker target cost"),
    kpi("We quoted", fmtInt(s.quoted_rfqs), capturePct > 50 ? "pos" : "", `${fmtPct(capturePct)} of flow`),
    kpi("We won", fmtInt(s.won_rfqs), s.won_rfqs ? "pos" : "", `${fmtMoney(s.won_risk)} budget`),
    kpi("Games", fmtInt(s.n_games), "", "with impossible flow"),
    kpi("Our NO bid", d.our_no_bid_c != null ? `${d.our_no_bid_c}c` : "—", "", "sniper greed dial"),
  ].join("");

  if (!d.games || !d.games.length) {
    $("games-wrap").style.display = "none";
    $("empty-wrap").style.display = "block";
    $("empty-text").textContent = d.source === "empty"
      ? "no impossible-flow data for this date (is impossible_flow_feed.py running?)"
      : "no impossible flow captured for this date";
    $("footer-text").textContent = "no flow";
    return;
  }
  $("empty-wrap").style.display = "none";
  renderGames();
  $("footer-text").textContent =
    `${fmtInt(s.rfqs)} impossible RFQs · ${fmtMoney(s.risk)} budget · ${fmtInt(s.quoted_rfqs)} quoted · ${fmtInt(s.won_rfqs)} won`;
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function trendOf(buckets) {
  const totals = buckets.map((b) => fireOf(b));
  if (totals.length < 4) return { label: "—", cls: "muted", arrow: "" };
  const k = Math.max(1, Math.floor(totals.length / 3));
  const early = avg(totals.slice(0, k)), late = avg(totals.slice(-k));
  const ratio = early > 0 ? late / early : (late > 0 ? 2 : 1);
  if (ratio >= 1.25) return { label: "rising", cls: "pos", arrow: "▲" };
  if (ratio <= 0.8) return { label: "cooling", cls: "neg", arrow: "▼" };
  return { label: "steady", cls: "muted", arrow: "▬" };
}

function renderGames() {
  const wrap = $("games-wrap");
  wrap.style.display = "block";
  $("games-hint").textContent =
    `${metricLabel()} per 10-min window · busiest first · click a game for its shapes & clearing prices`;
  $("games-list").innerHTML = state.data.games.map(gameCardHtml).join("");
}

function gameCardHtml(g) {
  const { home, away } = teamsForGame(g);
  const buckets = (g.buckets || []).slice().sort((a, b) => a.ts - b.ts);
  const chart = buckets.length ? flowSvg(buckets) : `<div class="muted" style="padding:8px">no flow</div>`;
  const trend = trendOf(buckets);
  const capture = g.rfqs > 0 ? (100 * g.quoted_rfqs) / g.rfqs : 0;
  const winPct = g.quoted_rfqs > 0 ? (100 * g.won_rfqs) / g.quoted_rfqs : 0;
  const hName = home ? teamName(g.sport, home) : g.game;
  const aName = away ? teamName(g.sport, away) : "";
  const matchup = aName
    ? `${flagImg(g.sport, home)}<span class="gx-team">${escapeHtml(hName)}</span><span class="gx-vs">vs</span><span class="gx-team">${escapeHtml(aName)}</span>${flagImg(g.sport, away)}`
    : `<span class="gx-team">${escapeHtml(hName)}</span>`;

  const expanded = state.expandedGames.has(g.game);
  return `
  <div class="gx-card${expanded ? " open" : ""}" data-game="${escapeHtml(g.game)}">
    <div class="gx-head">
      <div class="gx-match">${matchup}<span class="gx-sport">${escapeHtml(g.sport)}</span></div>
      <div class="gx-kpis">
        <span class="gx-kpi"><b>${fmtMetric(fireOf(g))}</b> flow</span>
        <span class="gx-kpi">quoted <b>${fmtPct(capture)}</b></span>
        <span class="gx-kpi ${g.won_rfqs ? "pos" : ""}">won <b>${fmtInt(g.won_rfqs)}</b>${g.quoted_rfqs ? ` (${fmtPct(winPct)})` : ""}</span>
        <span class="gx-kpi ${trend.cls}">${trend.arrow} ${trend.label}</span>
        <span class="gx-toggle">${expanded ? "▾" : "▸"} shapes</span>
      </div>
    </div>
    <div class="gx-chart">${chart}
      <div class="gx-legend">
        <span class="gx-lg"><span class="gx-sw" style="background:#fbbf24"></span>firehose</span>
        <span class="gx-lg"><span class="gx-sw" style="background:#3b82f6"></span>we quoted</span>
        <span class="gx-lg"><span class="gx-sw" style="background:var(--pos)"></span>we won</span>
      </div>
    </div>
    <div class="gx-details">${expanded ? shapesTableHtml(g) : ""}</div>
  </div>`;
}

// Stacked bar per 10-min bucket: green (won) <= blue (quoted) <= gold (firehose).
function flowSvg(buckets) {
  const W = 600, H = 130, padL = 46, padR = 8, padT = 8, padB = 18;
  const inW = W - padL - padR, inH = H - padT - padB, n = buckets.length;
  let yMax = 0;
  for (const b of buckets) yMax = Math.max(yMax, fireOf(b));
  yMax = yMax || 1;
  const bw = Math.max(1, (inW / n) * 0.84);
  const xFor = (i) => padL + (i + 0.5) * (inW / n);
  const yFor = (v) => padT + inH - (v / yMax) * inH;

  let bars = "";
  buckets.forEach((b, i) => {
    const fire = fireOf(b), q = quotedOf(b), w = wonOf(b);
    if (fire <= 0) return;
    const cx = xFor(i) - bw / 2;
    const seg = (lo, hi, fill, lbl) => {
      if (hi - lo <= 0) return "";
      const y1 = yFor(hi), y0 = yFor(lo);
      return `<rect x="${cx.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, y0 - y1).toFixed(1)}" fill="${fill}"><title>${etHM(b.ts)} · ${lbl}</title></rect>`;
    };
    // base..won (green), won..quoted (blue), quoted..firehose (gold)
    bars += seg(0, Math.min(w, fire), "var(--pos)", `won ${fmtMetric(w)}`);
    bars += seg(Math.min(w, q), Math.min(q, fire), "#3b82f6", `quoted ${fmtMetric(q)}`);
    bars += seg(Math.min(q, fire), fire, "#fbbf24", `firehose ${fmtMetric(fire)}`);
  });

  const yTicks = [];
  for (let t = 0; t <= 2; t++) {
    const v = (t / 2) * yMax, yy = yFor(v);
    yTicks.push(`<g class="tick"><line x1="${padL}" y1="${yy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yy.toFixed(1)}"/><text x="${padL - 5}" y="${yy.toFixed(1)}" text-anchor="end" dominant-baseline="central">${fmtMetric(v)}</text></g>`);
  }
  const xLabels = [];
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    xLabels.push(`<text x="${xFor(i).toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="middle">${etHM(buckets[i].ts)}</text>`);
  }
  return `<svg class="roi-chart flow-bars gx-svg" viewBox="0 0 ${W} ${H}">
    <g class="axis-y">${yTicks.join("")}</g><g class="bars">${bars}</g><g class="axis-x">${xLabels.join("")}</g>
  </svg>`;
}

// Expanded: unique shapes for this game with where each is CLEARING vs our bid.
// A compact, wrapping pill layout (NOT a wide table) so it stays readable on a
// phone — each shape is a block whose stat pills flow onto as many rows as fit.
function shapesTableHtml(g) {
  const shapes = (g.shapes || []).slice().sort((a, b) =>
    (state.metric === "risk" ? b.risk - a.risk : b.rfqs - a.rfqs));
  if (!shapes.length) return `<div class="muted" style="padding:6px 2px">no shapes</div>`;
  const pill = (lbl, val, cls = "") => `<span class="shp-pill ${cls}"><i>${lbl}</i>${val}</span>`;
  const body = shapes.map((s) => {
    const label = s.shape.includes(":") ? s.shape.split(":").slice(1).join(":").trim() : s.shape;
    const gap = (s.clearing_no_c != null && s.our_bid_c != null) ? (s.our_bid_c - s.clearing_no_c) : null;

    let clrVal = "—", clrCls = "";
    if (s.clearing_no_c != null) {
      const rng = (s.clearing_lo != null && s.clearing_hi != null && s.clearing_lo !== s.clearing_hi)
        ? ` (${s.clearing_lo}–${s.clearing_hi})` : "";
      clrVal = `${s.clearing_no_c}c${rng}`;
      if (s.our_bid_c != null) clrCls = s.our_bid_c >= s.clearing_no_c ? "pos" : "neg";
    }
    const pills = [
      pill("RFQs", fmtInt(s.rfqs)),
      pill("$ bud", fmtMoney(s.risk)),
      pill("clears", clrVal, clrCls),
      pill("our bid", s.our_bid_c != null ? s.our_bid_c + "c" : "—"),
      gap != null ? pill("gap", (gap >= 0 ? `+${gap}` : `${gap}`), gap >= 0 ? "pos" : "neg") : "",
      pill("quoted", fmtInt(s.quoted)),
      pill("won", fmtInt(s.won), s.won > 0 ? "pos" : ""),
      pill("traded", `${s.traded_pct}%`),
    ].join("");
    return `<div class="shp">
      <div class="shp-name">${escapeHtml(label)}</div>
      <div class="shp-stats">${pills}</div>
    </div>`;
  }).join("");
  return `<div class="gx-sub">
    <div class="shp-list">${body}</div>
    <div class="chart-caption">“clears” = where this shape's flow actually trades (100 − last YES). gap = our bid − clearing: <span class="pos">≥0 we can win it</span>, <span class="neg">&lt;0 priced out</span>. traded = % of sampled RFQs with a print yet.</div>
  </div>`;
}

// ---- init ----
$("metric-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-metric]");
  if (!b) return;
  state.metric = b.dataset.metric;
  for (const btn of $("metric-toggle").querySelectorAll("button")) btn.classList.toggle("active", btn === b);
  if (state.data) render();
});
$("games-list").addEventListener("click", (e) => {
  const card = e.target.closest(".gx-card");
  if (!card) return;
  const game = card.dataset.game;
  if (state.expandedGames.has(game)) state.expandedGames.delete(game);
  else state.expandedGames.add(game);
  renderGames();
});
$("refresh-btn").addEventListener("click", () => loadFlow({ force: true }));
$("flow-date").addEventListener("change", () => loadFlow());

$("flow-date").value = todayEt();
$("flow-date").max = todayEt();
setStatus("ready");
loadFlow();
