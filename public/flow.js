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
import { MLB_TEAMS, NHL_TEAMS, NBA_TEAMS, WNBA_TEAMS } from "/teams.js";

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

// metric accessors. DEMAND = the firehose (RFQ count / taker target $) — a faint
// reference. CLEARED = the TRUE volume that printed on the combo (contracts in #
// mode, NO-side $ in $ mode), measured off the trade tape. OURS = our accounts'
// fills (admin-only overlay). Bucket fields are cl_ct/cl_no; game/shape totals are
// cleared_ct/cleared_no — accept either.
const demandOf = (c) => (state.metric === "risk" ? (c.risk || 0) : (c.rfqs || 0));
// avg clearing NO price (¢) = volume-weighted = cleared NO-$ / cleared contracts * 100.
// null when nothing cleared in this window (so the price line BREAKS over the gap
// instead of plotting a fake 0). Accepts bucket (cl_*) or game/shape (cleared_*) fields.
const priceOf = (c) => {
  const ct = c.cl_ct != null ? c.cl_ct : (c.cleared_ct || 0);
  const no = c.cl_no != null ? c.cl_no : (c.cleared_no || 0);
  return ct > 0 ? (100 * no) / ct : null;
};
const clearedOf = (c) => (state.metric === "price" ? priceOf(c)
  : state.metric === "risk" ? (c.cl_no != null ? c.cl_no : (c.cleared_no || 0))
  : (c.cl_ct != null ? c.cl_ct : (c.cleared_ct || 0)));
const oursOf = (c) => (state.metric === "price"
  ? (c.our_ct > 0 ? (100 * (c.our_no || 0)) / c.our_ct : null)   // our avg cost basis (¢) = VWAP of our fills
  : state.metric === "risk" ? (c.our_no || 0) : (c.our_ct || 0));
const metricLabel = () => (state.metric === "risk" ? "$ (NO-side)" : state.metric === "price" ? "avg clear ¢" : "# contracts");
const fmtMetric = (n) => (n == null ? "—"
  : state.metric === "risk" ? fmtMoney(n)
  : state.metric === "price" ? `${n.toFixed(1)}¢`
  : fmtInt(n));

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
  if (s === "WNBA") return WNBA_TEAMS[code] || code;
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
  loadRester(date, force);   // admin-only panel; independent so an error never blanks the public Flow view
  loadEngineDiag(date, force);  // admin-only live engine telemetry
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

const fmtC = (c) => (c == null ? "—" : `${Math.round(c)}¢`);
const fmtK = (n) => (n == null ? "" : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

// "Our resting book" — admin-only panel below the public flow. Fetched separately
// from /api/rester so a failure (or a non-admin instance returning "admin-only")
// just hides the panel without touching the public Flow view.
async function loadEngineDiag(date, force = false) {
  try {
    const r = await fetch(`/api/engine-diag?date=${date}${force ? "&fresh=1" : ""}`);
    if (!r.ok) return;
    state.ediag = await r.json();
    renderEngineDiag();
  } catch { /* admin-only panel */ }
}

function _ediagSvg(pts, opts) {
  // pts: [{x, ys: [y1, y2?]}] normalized externally; two polylines max
  const { w = 460, h = 120, colors = ["#4ade80", "#f87171"], labels = [] } = opts || {};
  if (!pts.length) return "";
  const xs = pts.map(p => p.x), all = pts.flatMap(p => p.ys.filter(v => v != null));
  if (!all.length) return "";
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...all, 0), y1 = Math.max(...all, 0);
  const sx = x => 8 + (w - 16) * (x1 > x0 ? (x - x0) / (x1 - x0) : 0);
  const sy = y => h - 14 - (h - 28) * (y1 > y0 ? (y - y0) / (y1 - y0) : 0.5);
  const lines = [];
  for (let i = 0; i < (pts[0].ys || []).length; i++) {
    const d = pts.filter(p => p.ys[i] != null).map(p => `${sx(p.x).toFixed(1)},${sy(p.ys[i]).toFixed(1)}`).join(" ");
    if (d) lines.push(`<polyline points="${d}" fill="none" stroke="${colors[i]}" stroke-width="1.8"/>`);
  }
  const zero = `<line x1="8" y1="${sy(0).toFixed(1)}" x2="${w - 8}" y2="${sy(0).toFixed(1)}" stroke="#444" stroke-dasharray="3,3" stroke-width="0.7"/>`;
  const leg = labels.map((t, i) => `<tspan fill="${colors[i]}">&#9632; ${t}</tspan>`).join("  ");
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:var(--panel,#161616);border-radius:8px">
    ${zero}${lines.join("")}
    <text x="10" y="12" font-size="10" fill="#888">${leg}</text>
    <text x="${w - 10}" y="12" font-size="10" fill="#888" text-anchor="end">${(y1).toFixed(0)} / ${(y0).toFixed(0)}</text>
  </svg>`;
}

function _nowLegs(o) {
  const legs = (o.legs || []).map(escapeHtml).join(" + ");
  return legs || `<span class="muted" title="${escapeHtml(o.tk || o.mt || "")}">${escapeHtml((o.tk || o.mt || "?").slice(-22))}</span>`;
}

// "Right now" block: chaser leaderboard, canon resting book per account, and
// WHY shapes are being skipped (cell caps / cancel reasons / fail-safe).
function renderEngineNow(n) {
  const el = $("ediag-now");
  if (!el) return;
  if (!n || n.error) { el.innerHTML = n?.error ? `<div class="muted">now-state error: ${escapeHtml(n.error)}</div>` : ""; return; }
  const ch = n.chaser || {}, b = ch.board || {}, sk = ch.skips || {};
  const health = ch.alive
    ? `<span class="pos">chaser LIVE</span>${b.hold ? ' · <span class="neg">PLACEMENT HOLD</span>' : ""}${ch.fail_safe === "fail_safe_hold" ? ' · <span class="neg">FAIL-SAFE</span>' : ""} · ws ${b.ws ? "ok" : '<span class="neg">DOWN</span>'} · headroom ${fmtMoney(b.headroom || 0)} · ${fmtInt(b.rfq_seen || 0)} RFQs seen`
    : '<span class="neg">chaser NOT RUNNING (no board in 5 min)</span>';
  const topRows = (b.top || []).map(t => `<tr>
      <td>${_nowLegs(t)}</td>
      <td class="num">${((t.fair || 0) * 100).toFixed(1)}c</td>
      <td class="num">${((t.p || 0) * 100).toFixed(1)}c</td>
      <td class="num pos">+${((t.edge || 0) * 100).toFixed(2)}c</td>
      <td class="num">${(t.vel || 0).toFixed(1)}/min</td>
      <td class="num">${t.tau_s != null ? Math.round(t.tau_s) + "s" : "—"}</td>
    </tr>`).join("");
  const lbHtml = `<div class="shp-sub-head">Leaderboard now — ${b.feasible || 0}/${b.n || 0} velocity-feasible</div>
    ${topRows ? `<table class="rester-tbl"><thead><tr><th>shape</th><th class="num">fair</th><th class="num">ask</th><th class="num">edge</th><th class="num">velocity</th><th class="num">fill ETA</th></tr></thead><tbody>${topRows}</tbody></table>`
              : '<div class="muted">no shapes passing the edge x velocity gate right now (tape lull or all hot shapes capped below)</div>'}`;

  const divRows = (sk.diversity || []).map(s => `<tr>
      <td>${escapeHtml(s.side)}</td><td class="num">$${escapeHtml(String(s.cap))}</td>
      <td class="num">${s.n}</td>
      <td class="num">${s.last_ts ? new Date(s.last_ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</td>
    </tr>`).join("");
  const cancels = Object.entries(sk.cancels || {}).map(([r, c]) => `${escapeHtml(r)}: ${c}`).join(" · ");
  const skipHtml = `<div class="shp-sub-head">Skips — last hour, with reasons</div>
    ${divRows ? `<table class="rester-tbl"><thead><tr><th>cell side at cap (flow wants this, Kelly cap says no)</th><th class="num">cap left</th><th class="num">blocked</th><th class="num">last</th></tr></thead><tbody>${divRows}</tbody></table>` : '<div class="muted">no cell-cap blocks in the last hour</div>'}
    ${cancels ? `<div class="muted" style="margin-top:4px">slot cancels: ${cancels}</div>` : ""}
    ${sk.post_fail ? `<div class="neg" style="margin-top:4px">post failures: ${sk.post_fail}</div>` : ""}`;

  const restBlocks = Object.entries(n.resting || {}).map(([acct, r]) => {
    const rows = (r.orders || []).map(o => `<tr>
        <td>${_nowLegs(o)}</td>
        <td class="num">${((o.ask || 0) * 100).toFixed(1)}c</td>
        <td class="num">${(o.ct || 0).toFixed(1)}</td>
        <td class="num">${o.filled_ct ? o.filled_ct.toFixed(1) : "—"}</td>
      </tr>`).join("");
    return `<div style="margin-top:6px"><b>${escapeHtml(acct)}</b> <span class="muted">(${escapeHtml(r.engine || "")})</span>
      ${r.error ? '<span class="neg">fetch error</span>'
                : rows ? `<table class="rester-tbl"><thead><tr><th>shape</th><th class="num">ask</th><th class="num">resting ct</th><th class="num">filled</th></tr></thead><tbody>${rows}</tbody></table>`
                       : '<span class="muted">nothing resting</span>'}</div>`;
  }).join("");
  const restHtml = `<div class="shp-sub-head">Resting book — canon /portfolio/orders</div>${restBlocks}`;

  let gridHtml = "";
  const g = n.grid_rester;
  if (g && (g.board || g.stopped)) {
    const st = g.stopped;
    if (st && !g.alive) {
      const f = st.filled || {};
      gridHtml = `<div class="shp-sub-head">Grid rester — ${escapeHtml(g.grid || "")}</div>
        <div class="muted">stopped · sets ${st.sets ?? 0} · locked ${fmtMoney(st.locked_margin || 0)} · committed ${fmtMoney(st.committed || 0)} · fills: ${Object.entries(f).map(([k, v]) => `${escapeHtml(k)} ${v}`).join(" / ")}</div>`;
    } else if (g.board) {
      const rows = (g.board.corners || []).map(c => `<tr>
          <td>${escapeHtml(c.corner)}</td><td class="num">${((c.fair || 0) * 100).toFixed(1)}c</td>
          <td class="num">${((c.ask || 0) * 100).toFixed(1)}c</td>
          <td class="num">${(c.filled || 0).toFixed(1)}</td>
          <td class="num">${(c.allowed || 0).toFixed(0)}</td>
          <td>${c.tape ? "tape" : "fallback"}</td>
        </tr>`).join("");
      gridHtml = `<div class="shp-sub-head">Grid rester LIVE — ${escapeHtml(g.grid || "")} · sets ${g.board.sets ?? 0} · committed ${fmtMoney(g.board.committed || 0)}</div>
        <table class="rester-tbl"><thead><tr><th>corner</th><th class="num">fair</th><th class="num">ask</th><th class="num">filled</th><th class="num">band room</th><th>pricing</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
  }

  el.innerHTML = `<div class="muted" style="margin-bottom:4px">${health}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div>${lbHtml}${gridHtml ? `<div style="margin-top:10px">${gridHtml}</div>` : ""}</div>
      <div>${skipHtml}<div style="margin-top:10px">${restHtml}</div></div>
    </div>`;
}

function renderEngineDiag() {
  const wrap = $("ediag-wrap");
  if (!wrap) return;
  const d = state.ediag;
  const hasNow = d && d.now && !d.now.error && (d.now.chaser || d.now.grid_rester);
  if (!d || d.source === "admin-only" || d.source === "empty" || (!(d.fills || []).length && !hasNow)) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "block";
  renderEngineNow(d.now);
  const t = d.totals || {};
  const rails = d.rails || {};
  const last = (d.series || []).slice(-1)[0] || {};
  const upd = d.generated_at ? new Date(d.generated_at * 1000).toLocaleTimeString() : "—";
  $("ediag-hint").textContent =
    `machine line = cumulative edge banked at fill (skill) · drift = book E minus machine (game variance) · upd ${upd} (${d.source})`;

  $("ediag-summary").innerHTML = [
    kpi("Edge banked", fmtMoney(t.edge_banked || 0), (t.edge_banked || 0) >= 0 ? "pos" : "neg", `${t.n_fills || 0} fills today`),
    kpi("Book E now", last.e_pnl != null ? fmtMoney(last.e_pnl) : "—", (last.e_pnl || 0) >= 0 ? "pos" : "neg", `worst ${last.worst != null ? fmtMoney(last.worst) : "—"} @ ${last.worst_at || "—"}`),
    kpi("P(green)", last.p_green != null ? `${(last.p_green * 100).toFixed(0)}%` : "—", "", `shortfall ${last.shortfall != null ? fmtMoney(last.shortfall) : "—"}`),
    kpi("Rails", `${(rails.g || 0) + (rails.w || 0) + (rails.score || 0)} blocked`, (rails.breaches || 0) === 0 ? "pos" : "neg", `${rails.breaches || 0} breaches · ${rails.errors || 0} errors`),
  ].join("");

  const attr = (d.attribution || []).map(a => ({ x: a.ts, ys: [a.machine, a.drift] }));
  const risk = (d.series || []).filter(s2 => s2.worst != null).map(s2 => ({ x: s2.ts, ys: [s2.worst] }));
  $("ediag-charts").innerHTML =
    `<div>${_ediagSvg(attr, { labels: ["machine (edge)", "game drift"] })}</div>` +
    `<div>${_ediagSvg(risk, { colors: ["#60a5fa"], labels: ["at-risk (worst cell)"] })}</div>`;

  const rows = (d.fills || []).slice(-14).reverse().map(f => {
    const tm = f.ts ? new Date(f.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
    return `<tr>
      <td>${tm}</td><td>${escapeHtml(f.engine || "")}</td>
      <td title="${escapeHtml(f.tk || "")}">${escapeHtml((f.shape || "").slice(0, 34))}</td>
      <td class="num">${(f.ct || 0).toFixed(1)}</td>
      <td class="num">${((f.yes || 0) * 100).toFixed(1)}c</td>
      <td class="num">${((f.fair || 0) * 100).toFixed(1)}c${f.fair_src === "approx" ? "*" : ""}</td>
      <td class="num ${(f.edge || 0) >= 0 ? "pos" : "neg"}">${fmtMoney(f.edge || 0)}</td>
      <td class="num">${f.worst_after != null ? fmtMoney(f.worst_after) : "—"}</td>
    </tr>`;
  }).join("");
  $("ediag-table").innerHTML = `
    <table class="rester-tbl">
      <thead><tr><th>time</th><th>phase</th><th>shape</th><th class="num">ct</th>
        <th class="num">fill</th><th class="num">fair</th><th class="num">edge</th>
        <th class="num">at-risk after</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="muted" style="margin-top:6px;font-size:12px">* fair approximated from margin floor (place log lacked model fair)</div>`;
}

async function loadRester(date, force = false) {
  try {
    const r = await fetch(`/api/rester?date=${date}${force ? "&fresh=1" : ""}`);
    if (!r.ok) return;
    state.rester = await r.json();
    renderRester();
  } catch { /* ignore — admin-only panel */ }
}

function renderRester() {
  const wrap = $("rester-wrap");
  if (!wrap) return;
  const d = state.rester;
  if (!d || d.source === "admin-only" || !d.markets || !d.markets.length) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "block";
  const t = d.totals || {};
  const upd = d.generated_at ? new Date(d.generated_at * 1000).toLocaleTimeString() : "—";
  $("rester-hint").textContent =
    `top markets by 5-min demand · book ●=top ○=outbid · comp = best rival NO bid ×contracts at/above our bid · upd ${upd} (${d.source})`;

  $("rester-summary").innerHTML = [
    kpi("Open resting", fmtMoney(t.open || 0), "", "unfilled NO at rest"),
    kpi("Filled", fmtMoney(t.filled || 0), "pos", "sure-win NO captured"),
    kpi("Free cash", fmtMoney(t.free || 0), "", `${fmtMoney(t.cash || 0)} bankroll`),
    kpi("Locked", fmtMoney(t.locked || 0), "pos", "settled / open positions"),
  ].join("");

  const rows = d.markets.slice(0, 12).map((m) => {
    const tob = m.held
      ? (m.top_of_book ? `<span class="pos">●</span>` : `<span class="neg">○</span>`)
      : "";
    const cov = m.held
      ? `${fmtMoney(m.our_cov)}${m.our_filled ? ` <span class="pos">+${fmtMoney(m.our_filled)}</span>` : ""}`
      : `<span class="muted">—</span>`;
    const fillp = m.fill_pct != null ? ` <span class="muted">${m.fill_pct}%</span>` : "";
    const book = m.held ? `${tob} ${fmtC(m.our_no_c)}` : `<span class="muted">—</span>`;
    // competition: best external NO bid + contracts resting at/above our bid (contest us)
    let comp = `<span class="muted">—</span>`;
    if (m.comp_best_c != null) {
      const contested = m.held && m.comp_ct > 0;          // a rival at/above our price
      const sz = m.comp_ct ? ` ×${fmtK(m.comp_ct)}` : "";
      comp = `<span class="${contested ? "neg" : "muted"}">${fmtC(m.comp_best_c)}${sz}</span>`;
    }
    return `<tr class="${m.held ? "" : "muted-row"}">
      <td title="${escapeHtml(m.ticker)}">${escapeHtml(m.shape)}${m.held ? "" : ` <span class="muted">·new</span>`}</td>
      <td class="num">${fmtInt(m.m5)}/${fmtInt(m.m15)}</td>
      <td class="num">${fmtInt(m.vol)}</td>
      <td class="num">${fmtC(m.clear_no_c)}</td>
      <td class="num">${cov}${fillp}</td>
      <td class="num">${book}</td>
      <td class="num">${comp}</td>
    </tr>`;
  }).join("");

  const accts = (d.accounts || [])
    .map((a) => `${escapeHtml(a.label)} $${fmtInt(a.free)}f/${fmtInt(a.n_resting)}r`)
    .join(" · ");

  $("rester-table").innerHTML = `
    <table class="rester-tbl">
      <thead><tr>
        <th>shape</th><th class="num">5/15m</th><th class="num">vol</th>
        <th class="num">NO-clr</th><th class="num">our cov</th><th class="num">book</th>
        <th class="num">comp</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="muted" style="margin-top:6px;font-size:12px">${accts}</div>`;
}

function render() {
  const d = state.data;
  if (!d) return;
  const s = d.summary || { rfqs: 0, risk: 0, cleared_ct: 0, cleared_no: 0, n_games: 0 };
  const upd = d.updated_at ? new Date(d.updated_at * 1000).toLocaleTimeString() : "—";
  $("meta-text").textContent =
    `${d.date} · ${fmtInt(s.rfqs)} impossible RFQs · ${fmtMoney(s.cleared_no)} cleared · ${s.n_games} games · ${d.source}${d.admin ? " · admin" : ""} · upd ${upd}`;

  $("summary").innerHTML = [
    kpi("Impossible RFQs", fmtInt(s.rfqs), "", "firehose demand today"),
    kpi("Cleared (NO $)", fmtMoney(s.cleared_no), "pos", `${fmtInt(s.cleared_ct)} contracts · all makers`),
    d.admin
      ? kpi("Our exposure (Cost Paid)", fmtMoney(s.our_no || 0), "pos", `${fmtInt(s.our_ct || 0)} ct open · = Live tab`)
      : kpi("Games", fmtInt(s.n_games), "", "with impossible flow"),
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
    `${fmtInt(s.rfqs)} RFQs · ${fmtMoney(s.cleared_no)} cleared (${fmtInt(s.cleared_ct)} ct) · ${s.n_games} games`;
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function trendOf(buckets) {
  const totals = buckets.map((b) => clearedOf(b)).filter((v) => v != null);
  if (totals.length < 4) return { label: "—", cls: "muted", arrow: "" };
  const k = Math.max(1, Math.floor(totals.length / 3));
  const early = avg(totals.slice(0, k)), late = avg(totals.slice(-k));
  if (state.metric === "price") {                 // PRICE: absolute ¢ move early->late
    const d = late - early;
    if (d >= 1.5) return { label: `rising +${d.toFixed(1)}¢`, cls: "pos", arrow: "▲" };
    if (d <= -1.5) return { label: `cooling ${d.toFixed(1)}¢`, cls: "neg", arrow: "▼" };
    return { label: "steady", cls: "muted", arrow: "▬" };
  }
  const ratio = early > 0 ? late / early : (late > 0 ? 2 : 1);
  if (ratio >= 1.25) return { label: "rising", cls: "pos", arrow: "▲" };
  if (ratio <= 0.8) return { label: "cooling", cls: "neg", arrow: "▼" };
  return { label: "steady", cls: "muted", arrow: "▬" };
}

function renderGames() {
  const wrap = $("games-wrap");
  wrap.style.display = "block";
  $("games-hint").textContent = state.metric === "price"
    ? `avg cleared NO price (¢) per 10-min window · dashed = our NO bid · rising ⇒ the market pays up as kickoff nears / the game runs · click a game for shapes`
    : `cleared volume (${metricLabel()}) per 10-min window · dashed line = RFQ demand · click a game for shapes & clearing`;
  $("games-list").innerHTML = state.data.games.map(gameCardHtml).join("");
}

function gameCardHtml(g) {
  const { home, away } = teamsForGame(g);
  const buckets = (g.buckets || []).slice().sort((a, b) => a.ts - b.ts);
  const chart = buckets.length ? flowSvg(buckets) : `<div class="muted" style="padding:8px">no flow</div>`;
  const trend = trendOf(buckets);
  const hName = home ? teamName(g.sport, home) : g.game;
  const aName = away ? teamName(g.sport, away) : "";
  const matchup = aName
    ? `${flagImg(g.sport, home)}<span class="gx-team">${escapeHtml(hName)}</span><span class="gx-vs">vs</span><span class="gx-team">${escapeHtml(aName)}</span>${flagImg(g.sport, away)}`
    : `<span class="gx-team">${escapeHtml(hName)}</span>`;

  const admin = !!(state.data && state.data.admin);
  const expanded = state.expandedGames.has(g.game);
  return `
  <div class="gx-card${expanded ? " open" : ""}" data-game="${escapeHtml(g.game)}">
    <div class="gx-head">
      <div class="gx-match">${matchup}<span class="gx-sport">${escapeHtml(g.sport)}</span></div>
      <div class="gx-kpis">
        <span class="gx-kpi"><b>${fmtInt(g.rfqs)}</b> RFQs</span>
        <span class="gx-kpi" title="True volume that cleared on this game's impossible combos (every maker), off the trade tape. In price mode: the volume-weighted avg NO price it all cleared at.">cleared <b>${fmtMetric(clearedOf(g))}</b>${(state.metric === "risk" || state.metric === "price") ? ` · <b>${fmtInt(g.cleared_ct)}</b> ct` : ""}</span>
        ${admin && (g.our_no || 0) > 0 ? `<span class="gx-kpi pos" title="Our open impossible-parlay exposure on this game (= Cost Paid), and the share of this game's cleared contracts we captured (admin only).">ours <b>${fmtMetric(oursOf(g))}</b>${g.cleared_ct > 0 ? ` · ${Math.min(100, Math.round(100 * (g.our_ct || 0) / g.cleared_ct))}% captured` : ""}</span>` : ""}
        <span class="gx-kpi ${trend.cls}">${trend.arrow} ${trend.label}</span>
        <span class="gx-toggle">${expanded ? "▾" : "▸"} shapes</span>
      </div>
    </div>
    <div class="gx-chart">${chart}
      <div class="gx-legend">
        ${state.metric === "price"
          ? `<span class="gx-lg"><span class="gx-sw" style="background:var(--pos)"></span>avg clear ¢</span>
        <span class="gx-lg"><span class="gx-sw" style="background:#fbbf24;opacity:.75"></span>our NO bid</span>`
          : `<span class="gx-lg"><span class="gx-sw" style="background:var(--pos)"></span>cleared (all makers)</span>
        <span class="gx-lg"><span class="gx-sw" style="background:#fbbf24;opacity:.75"></span>RFQ demand</span>`}
      </div>
    </div>
    <div class="gx-details">${expanded ? pricingBlockHtml(g) + shapesTableHtml(g) : ""}</div>
  </div>`;
}

// Cleared volume per 10-min bucket — green bar = the TRUE volume that printed on
// the combos (off the trade tape). A faint dashed line tracks RFQ demand (firehose)
// for reference (it sits low — many contracts clear per RFQ, plus resting fills with
// no RFQ at all). "Our exposure" is a current positions snapshot (no per-fill time),
// so it's shown as KPIs, not split into these time buckets.
function flowSvg(buckets) {
  if (state.metric === "price") return priceSvg(buckets);
  const W = 600, H = 130, padL = 46, padR = 8, padT = 8, padB = 18;
  const inW = W - padL - padR, inH = H - padT - padB, n = buckets.length;
  let yMax = 0;
  for (const b of buckets) yMax = Math.max(yMax, clearedOf(b), demandOf(b));
  yMax = yMax || 1;
  const bw = Math.max(1, (inW / n) * 0.84);
  const xFor = (i) => padL + (i + 0.5) * (inW / n);
  const yFor = (v) => padT + inH - (v / yMax) * inH;
  const y0 = yFor(0);

  let bars = "";
  buckets.forEach((b, i) => {
    const cleared = clearedOf(b);
    if (cleared <= 0) return;
    const cx = xFor(i) - bw / 2, yc = yFor(cleared);
    bars += `<rect x="${cx.toFixed(1)}" y="${yc.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, y0 - yc).toFixed(1)}" fill="var(--pos)"><title>${etHM(b.ts)} · cleared ${fmtMetric(cleared)} · demand ${fmtMetric(demandOf(b))}</title></rect>`;
  });

  // RFQ demand reference — faint dashed line across bucket centers.
  const pts = buckets.map((b, i) => `${xFor(i).toFixed(1)},${yFor(demandOf(b)).toFixed(1)}`).join(" ");
  const demandLine = pts
    ? `<polyline points="${pts}" fill="none" stroke="#fbbf24" stroke-width="1.4" stroke-dasharray="3 3" opacity="0.75"/>`
    : "";

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
    <g class="axis-y">${yTicks.join("")}</g><g class="bars">${bars}</g>${demandLine}<g class="axis-x">${xLabels.join("")}</g>
  </svg>`;
}

// PRICE mode: the volume-weighted avg cleared NO price (¢) per 10-min bucket, drawn
// as a ZOOMED line (prices cluster 88-99c — bars-from-0 would hide the trend) with a
// dashed reference line at our current NO bid. If the market line sits ABOVE our bid
// and climbs as kickoff nears / the game runs, that's edge we're leaving on the table.
// Buckets with no cleared volume are gaps (the line breaks rather than dropping to 0).
function priceSvg(buckets) {
  const W = 600, H = 130, padL = 46, padR = 8, padT = 8, padB = 18;
  const inW = W - padL - padR, inH = H - padT - padB, n = buckets.length;
  const ourBid = (state.data && state.data.our_no_bid_c != null) ? state.data.our_no_bid_c : null;
  const prices = buckets.map((b) => clearedOf(b));      // ¢, null where nothing cleared
  const vals = prices.filter((v) => v != null);
  if (ourBid != null) vals.push(ourBid);
  if (!vals.length) return `<div class="muted" style="padding:8px">no cleared volume</div>`;
  // zoom the y-axis to the data (incl. our bid) so a few ¢ of drift is readable.
  let lo = Math.max(0, Math.floor(Math.min(...vals)) - 1);
  let hi = Math.min(100, Math.ceil(Math.max(...vals)) + 1);
  if (hi - lo < 3) { lo = Math.max(0, hi - 4); }       // keep a minimum span
  const xFor = (i) => padL + (i + 0.5) * (inW / n);
  const yFor = (v) => padT + inH - ((v - lo) / (hi - lo)) * inH;

  // line in segments so gaps (null buckets) break it; a dot on every real point.
  let path = "", dots = "", seg = [];
  const flush = () => { if (seg.length > 1) path += `<polyline points="${seg.join(" ")}" fill="none" stroke="var(--pos)" stroke-width="1.8"/>`; seg = []; };
  buckets.forEach((b, i) => {
    const v = prices[i];
    if (v == null) { flush(); return; }
    const x = xFor(i), y = yFor(v);
    seg.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    const vol = b.cl_ct != null ? b.cl_ct : (b.cleared_ct || 0);
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2" fill="var(--pos)"><title>${etHM(b.ts)} · avg ${v.toFixed(1)}¢ · ${fmtInt(vol)} ct cleared</title></circle>`;
  });
  flush();

  // our NO-bid reference line (the greed dial) — the thing we'd compare the market to.
  let bidLine = "";
  if (ourBid != null && ourBid >= lo && ourBid <= hi) {
    const yb = yFor(ourBid);
    bidLine = `<line x1="${padL}" y1="${yb.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yb.toFixed(1)}" stroke="#fbbf24" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.9"/>`
      + `<text x="${(W - padR).toFixed(1)}" y="${(yb - 3).toFixed(1)}" text-anchor="end" fill="#fbbf24" font-size="9">our bid ${ourBid}¢</text>`;
  }

  const yTicks = [];
  for (let t = 0; t <= 2; t++) {
    const v = lo + (t / 2) * (hi - lo), yy = yFor(v);
    yTicks.push(`<g class="tick"><line x1="${padL}" y1="${yy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yy.toFixed(1)}"/><text x="${padL - 5}" y="${yy.toFixed(1)}" text-anchor="end" dominant-baseline="central">${v.toFixed(0)}¢</text></g>`);
  }
  const xLabels = [];
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    xLabels.push(`<text x="${xFor(i).toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="middle">${etHM(buckets[i].ts)}</text>`);
  }
  return `<svg class="roi-chart flow-bars gx-svg" viewBox="0 0 ${W} ${H}">
    <g class="axis-y">${yTicks.join("")}</g>${bidLine}<g class="price-line">${path}${dots}</g><g class="axis-x">${xLabels.join("")}</g>
  </svg>`;
}

// ============================================================================
// PRICING SURFACE (expanded view) — the joint price × volume × time picture so
// we can pick the resting price that grabs the most volume at the best edge.
// Data: each bucket carries price_hist = { NO-price-¢ : cleared contracts }.
// ============================================================================

// buckets that carry a non-empty price histogram, time-sorted.
function priceBuckets(g) {
  return (g.buckets || [])
    .filter((b) => b.price_hist && Object.keys(b.price_hist).length)
    .slice().sort((a, b) => a.ts - b.ts);
}

// BUBBLE CHART — x = time, y = NO price ¢, bubble AREA = cleared volume. Far more
// readable than a brightness grid for sparse data: you see at a glance where the
// mass sits and whether it drifts up over time. A white line tracks the volume-
// weighted avg price per bucket (the center); the gold dashed line is our bid.
function priceHeatmapSvg(g, ourBid) {
  const buckets = priceBuckets(g);
  if (!buckets.length) return `<div class="muted" style="padding:8px">no price data yet</div>`;
  let pmin = 100, pmax = 0, maxVol = 0;
  for (const b of buckets) for (const [p, c] of Object.entries(b.price_hist)) {
    const pc = +p; pmin = Math.min(pmin, pc); pmax = Math.max(pmax, pc); maxVol = Math.max(maxVol, c);
  }
  if (ourBid != null) { pmin = Math.min(pmin, ourBid); pmax = Math.max(pmax, ourBid); }
  pmin = Math.max(0, pmin - 1); pmax = Math.min(100, pmax + 1);   // pad so edge bubbles aren't clipped
  const span = (pmax - pmin) || 1, n = buckets.length;
  const W = 620, H = 200, padL = 40, padR = 14, padT = 12, padB = 22;
  const inW = W - padL - padR, inH = H - padT - padB;
  const xFor = (i) => (n > 1 ? padL + (i / (n - 1)) * inW : padL + inW / 2);   // active buckets spread across
  const yFor = (p) => padT + inH - ((p - pmin) / span) * inH;                  // high price at top
  const rFor = (v) => 1.5 + Math.sqrt(Math.max(0, v) / (maxVol || 1)) * 12;    // AREA ∝ volume

  // price gridlines + labels
  const grid = []; const stepc = span <= 8 ? 1 : (span <= 18 ? 2 : 5);
  for (let p = Math.ceil(pmin); p <= pmax; p++) {
    if (p % stepc !== 0) continue;
    const y = yFor(p);
    grid.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--border,#2a2f3a)" stroke-width="0.5" opacity="0.5"/>`
      + `<text x="${(padL - 5).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="end" dominant-baseline="central" font-size="8" fill="var(--muted)">${p}¢</text>`);
  }
  // volume-weighted avg-price trend line (the "center" over time)
  const pts = [];
  buckets.forEach((b, i) => {
    let sc = 0, sv = 0;
    for (const [p, c] of Object.entries(b.price_hist)) { sc += (+p) * c; sv += c; }
    if (sv > 0) pts.push(`${xFor(i).toFixed(1)},${yFor(sc / sv).toFixed(1)}`);
  });
  const trend = pts.length > 1 ? `<polyline points="${pts.join(" ")}" fill="none" stroke="#fff" stroke-width="1.1" opacity="0.55"/>` : "";
  // bubbles (drawn largest-first so small ones stay clickable on top)
  const marks = [];
  buckets.forEach((b, i) => {
    const x = xFor(i);
    for (const [p, c] of Object.entries(b.price_hist)) {
      if (!(c > 0)) continue;
      marks.push({ r: rFor(c), s: `<circle cx="${x.toFixed(1)}" cy="${yFor(+p).toFixed(1)}" r="${rFor(c).toFixed(1)}" fill="var(--pos)" opacity="0.5" stroke="var(--pos)" stroke-width="0.5"><title>${etHM(b.ts)} · ${p}¢ · ${fmtInt(c)} ct</title></circle>` });
    }
  });
  marks.sort((a, b) => b.r - a.r);
  const bubbles = marks.map((m) => m.s).join("");
  // our-bid reference line
  let bidLine = "";
  if (ourBid != null && ourBid >= pmin && ourBid <= pmax) {
    const y = yFor(ourBid);
    bidLine = `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#fbbf24" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.9"/>`
      + `<text x="${(W - padR).toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="end" fill="#fbbf24" font-size="9">our bid ${ourBid}¢</text>`;
  }
  // time labels
  const xL = []; const xstep = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += xstep) xL.push(`<text x="${xFor(i).toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="middle" font-size="8" fill="var(--muted)">${etHM(buckets[i].ts)}</text>`);
  return `<svg class="gx-svg" viewBox="0 0 ${W} ${H}" style="width:100%">${grid.join("")}${trend}${bubbles}${bidLine}${xL.join("")}</svg>`;
}

// Aggregate price_hist over the whole game -> {price¢: volume}, plus the cumulative
// demand curve V(P) = volume that cleared at <= P (capturable by resting at P, since
// a NO bid at P intercepts the sweep before it reaches anything cheaper). Edge per
// contract = (100-P)¢ for sure-win NO; P* maximizes V(P)*(100-P).
function demandModel(g, ourBid) {
  const buckets = priceBuckets(g);
  const tot = {};
  for (const b of buckets) for (const [p, c] of Object.entries(b.price_hist)) tot[+p] = (tot[+p] || 0) + c;
  const ps = Object.keys(tot).map(Number).sort((a, b) => a - b);
  if (!ps.length) return null;
  const total = ps.reduce((s, p) => s + tot[p], 0);
  const rows = []; let cum = 0, best = { P: null, profit: -1, V: 0 }, bidV = 0;
  for (let P = ps[0]; P <= ps[ps.length - 1]; P++) {
    cum += tot[P] || 0;
    const profit = cum * (100 - P) / 100;                 // est $ if it all settles NO
    rows.push({ P, V: cum, profit });
    if (profit > best.profit) best = { P, profit, V: cum };
    if (ourBid != null && P === ourBid) bidV = cum;
  }
  return { rows, total, best, bidV };
}

// DEMAND CURVE — price on Y (high at top), bar = cumulative capturable volume.
// ★ marks the profit-max P*; ◀ marks our current bid.
function demandCurveSvg(g, ourBid) {
  const m = demandModel(g, ourBid);
  if (!m) return `<div class="muted" style="padding:8px">no price data yet</div>`;
  const order = m.rows.slice().reverse();                 // high price at top
  const W = 620, H = Math.max(110, 16 + order.length * 12), padL = 38, padR = 64, padT = 6, padB = 6;
  const inW = W - padL - padR, inH = H - padT - padB, rh = inH / order.length;
  let out = "";
  order.forEach((r, i) => {
    const w = Math.max(1, inW * (r.V / m.total)), y = padT + i * rh;
    const isStar = r.P === m.best.P, isBid = ourBid != null && r.P === ourBid;
    out += `<rect x="${padL}" y="${(y + 1).toFixed(1)}" width="${w.toFixed(1)}" height="${(rh - 2).toFixed(1)}" fill="${isStar ? '#fbbf24' : 'var(--pos)'}" opacity="${isStar ? 0.95 : 0.7}"><title>rest @${r.P}¢ → capture ~${fmtInt(r.V)} ct (${Math.round(100 * r.V / m.total)}%) at ${100 - r.P}¢ edge ≈ ${fmtMoney(r.profit)}</title></rect>`;
    out += `<text x="${(padL - 4).toFixed(1)}" y="${(y + rh / 2).toFixed(1)}" text-anchor="end" dominant-baseline="central" font-size="8" fill="${isBid ? '#fff' : 'var(--muted)'}">${r.P}¢${isBid ? '◀' : ''}</text>`;
    out += `<text x="${(padL + w + 3).toFixed(1)}" y="${(y + rh / 2).toFixed(1)}" dominant-baseline="central" font-size="8" fill="var(--muted)">${Math.round(100 * r.V / m.total)}%${isStar ? ' ★P*' : ''}</text>`;
  });
  return `<svg class="gx-svg" viewBox="0 0 ${W} ${H}" style="width:100%">${out}</svg>`;
}

function pricingBlockHtml(g) {
  const ourBid = (state.data && state.data.our_no_bid_c != null) ? state.data.our_no_bid_c : null;
  const m = demandModel(g, ourBid);
  if (!m) {
    return `<div class="gx-sub"><div class="shp-sub-head">Pricing surface — price × volume × time</div>`
      + `<div class="muted" style="padding:6px 2px">no price-distribution data for this game yet — the producer adds it on its next run (~5 min) and backfills today + yesterday.</div></div>`;
  }
  const pct = (v) => Math.round(100 * v / m.total);
  const summary = `<b>P*=${m.best.P}¢</b> → capture ~${pct(m.best.V)}% (${fmtInt(m.best.V)} ct) at ${100 - m.best.P}¢ edge ≈ <b>${fmtMoney(m.best.profit)}</b>`
    + (ourBid != null ? ` · our bid <b>${ourBid}¢</b> → ~${pct(m.bidV)}% (${fmtInt(m.bidV)} ct)` : "");
  return `<div class="gx-sub">
    <div class="shp-sub-head">Pricing surface — price × volume × time</div>
    <div class="chart-caption">${summary}</div>
    <div style="display:flex;gap:14px;flex-wrap:wrap">
      <div style="flex:1;min-width:280px"><div class="muted" style="font-size:11px;margin-bottom:2px">cleared volume by price over time — <b>bubble size = contracts</b> · white line = avg price · dashed = our bid</div>${priceHeatmapSvg(g, ourBid)}</div>
      <div style="flex:1;min-width:240px"><div class="muted" style="font-size:11px;margin-bottom:2px">cumulative volume capturable if we rest @ price (★ = profit-max P*)</div>${demandCurveSvg(g, ourBid)}</div>
    </div>
    <div class="chart-caption">Model: resting at P captures volume that cleared at ≤ P (a NO bid at P intercepts the sweep before cheaper bids); edge = (100−P)¢ for sure-win NO; <b>P*</b> maximizes capture × edge. First-order — ignores our size limit, market impact and competition, so treat it as a guide.</div>
  </div>`;
}

// ---- shape decoding: turn "[BTTS, USA, 3/NO]" into plain-English legs + a proof
// of impossibility. Mirrors the canonical detector's leg semantics
// (sandbox/impossible_parlay.py _pred): total "N" => total ≥ N (line N-0.5);
// spread "TEAMd" => that team wins by ≥ d; GAME "TEAM" => that team wins; BTTS =>
// both score. "/NO" negates. Soccer chunks are HOME-first.
function assignFromGame(game) {
  const m = String(game || "").match(/^\d{2}[A-Z]{3}\d{2}(?:\d{4})?([A-Z]+)$/);
  if (m && m[1].length === 6) return { home: m[1].slice(0, 3), away: m[1].slice(3, 6) };
  return null;
}
// Decode one shape token -> { raw, label, pred(h,a)|null } where pred is the YES
// resolution AFTER applying the token's side (h = home goals, a = away goals).
function decodeLeg(tok, sport, home, away) {
  let side = "yes", t = String(tok).trim();
  if (/\/NO$/i.test(t)) { side = "no"; t = t.replace(/\/NO$/i, "").trim(); }
  const nm = (c) => teamName(sport, c) || c;
  // label = full plain-English; sh = compact form (BTTS / USA / USA -1.5 / u2.5)
  let base = null, yes = t, no = `not ${t}`, ys = t, ns = `~${t}`;
  if (/^BTTS$/i.test(t)) {
    base = (h, a) => h >= 1 && a >= 1; yes = "Both teams score"; no = "NOT both teams score";
    ys = "BTTS"; ns = "BTTS✗";
  } else if (/^\d+$/.test(t)) {
    // Kalshi total ticker "N" is the half-line floor_strike N-0.5 (matches _pred and
    // the fill cards' "o2.5/u2.5"): YES = over N-0.5, NO = under N-0.5.
    const N = parseInt(t, 10), L = N - 0.5;
    base = (h, a) => (h + a) > L;
    yes = `Over ${L} goals`; no = `Under ${L} goals`;
    ys = `o${L}`; ns = `u${L}`;
  } else {
    const m = t.match(/^([A-Za-z]{2,4})(\d*)$/);
    if (m) {
      const team = m[1].toUpperCase(), d = m[2];
      if (team === "TIE" || team === "DRAW") {
        base = (h, a) => h === a; yes = "Draw"; no = "NOT a draw";
        ys = "draw"; ns = "draw✗";
      } else if (d) {
        const D = parseInt(d, 10), L = D - 0.5;
        base = team === home ? (h, a) => (h - a) > L
             : team === away ? (h, a) => (a - h) > L : null;
        yes = `${nm(team)} win by ${D}+`; no = `${nm(team)} do NOT win by ${D}+`;
        ys = `${team} -${L}`; ns = `${team} -${L}✗`;
      } else {
        base = team === home ? (h, a) => h > a
             : team === away ? (h, a) => a > h : null;
        yes = `${nm(team)} to win`; no = `${nm(team)} do NOT win (draw or opponent)`;
        ys = team; ns = `${team}✗`;
      }
    }
  }
  const pred = base ? (side === "no" ? (h, a) => !base(h, a) : base) : null;
  return { raw: tok, label: side === "no" ? no : yes, short: side === "no" ? ns : ys, pred };
}
function decodeShape(shapeStr, sport, game) {
  const inside = shapeStr.includes(":") ? shapeStr.split(":").slice(1).join(":") : shapeStr;
  const toks = inside.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  const asg = assignFromGame(game);
  return toks.map((t) => decodeLeg(t, sport, asg && asg.home, asg && asg.away));
}
// Why impossible: for each leg, find a final score that satisfies EVERY OTHER leg
// (so that leg is the lone breaker). The list of near-misses is the proof.
function whyImpossible(legs, game) {
  const usable = legs.filter((l) => l.pred);
  if (usable.length < 2) return null;
  const asg = assignFromGame(game);
  const N = 12, misses = [];
  for (let i = 0; i < usable.length; i++) {
    const others = usable.filter((_, j) => j !== i);
    let w = null;
    for (let h = 0; h <= N && !w; h++) for (let a = 0; a <= N; a++) {
      if (others.every((l) => l.pred(h, a))) { w = { h, a }; break; }
    }
    if (w) misses.push({ leg: usable[i], w });
  }
  if (!misses.length) return null;
  const score = (w) => asg ? `${asg.home} ${w.h}–${w.a} ${asg.away}` : `${w.h}–${w.a}`;
  return misses.map((mz) => `<b>${score(mz.w)}</b> satisfies every leg but “${escapeHtml(mz.leg.label)}”`);
}

// Expanded: unique shapes for this game with where each is CLEARING vs our bid.
// A compact, wrapping pill layout (NOT a wide table) so it stays readable on a
// phone — each shape is a block whose stat pills flow onto as many rows as fit.
function shapesTableHtml(g) {
  const mval = (s) => (state.metric === "risk" ? s.risk
    : state.metric === "price" ? (s.cleared_ct > 0 ? (100 * s.cleared_no) / s.cleared_ct : 0)
    : s.rfqs);
  const shapes = (g.shapes || []).slice().sort((a, b) => mval(b) - mval(a));
  if (!shapes.length) return `<div class="muted" style="padding:6px 2px">no shapes</div>`;
  const pill = (lbl, val, cls = "") => `<span class="shp-pill ${cls}"><i>${lbl}</i>${val}</span>`;
  const adminS = !!(state.data && state.data.admin);   // used by both the pills and the caption
  // decode each shape ONCE (reused by the occurrence chart + the detail blocks)
  const decoded = shapes.map((s) => decodeShape(s.shape, g.sport, g.game));
  // compact leg form for the chart: BTTS · USA · u2.5 / BTTS · USA -1.5 · u3.5
  const shortLabel = (i) => decoded[i].map((l) => l.short).join(" · ");

  // OCCURRENCES CHART — one row per distinct shape: short legs on top (wrap so
  // ALL legs read, no truncation), full-width bar below (by current metric).
  const maxv = Math.max(1, ...shapes.map(mval));
  const occChart = shapes.map((s, i) => {
    const v = mval(s), w = Math.max(2, (100 * v) / maxv);
    return `<div class="shp-bar-row">`
      + `<div class="shp-bar-top"><span class="shp-bar-lbl">${escapeHtml(shortLabel(i))}</span>`
      + `<span class="shp-bar-val">${fmtMetric(v)}</span></div>`
      + `<span class="shp-bar-track"><span class="shp-bar-fill" style="width:${w.toFixed(1)}%"></span></span></div>`;
  }).join("");

  const body = shapes.map((s, i) => {
    const raw = s.shape.includes(":") ? s.shape.split(":").slice(1).join(":").trim() : s.shape;
    const legs = decoded[i];
    const legsHtml = legs.map((l) => `<span class="shp-leg">${escapeHtml(l.label)}</span>`).join("");
    const why = whyImpossible(legs, g.game);
    const whyHtml = why
      ? `<div class="shp-why"><span class="shp-why-tag">why impossible</span> no final score satisfies all of these — ${why.join("; ")}.</div>`
      : "";
    const gap = (s.clearing_no_c != null && s.our_bid_c != null) ? (s.our_bid_c - s.clearing_no_c) : null;

    let clrVal = "—", clrCls = "";
    if (s.clearing_no_c != null) {
      const lo = s.clearing_lo, hi = s.clearing_hi, med = s.clearing_no_c;
      clrVal = (lo != null && hi != null && lo !== hi) ? `${lo}-${hi}c (typ ${med})` : `${med}c`;
      if (s.our_bid_c != null) clrCls = s.our_bid_c >= med ? "pos" : "neg";
    }
    // naive (dumb-bot) NO price and how far the market clears from it
    const naive = s.naive_no_c;
    const vsNaive = (naive != null && s.clearing_no_c != null) ? Math.round(s.clearing_no_c - naive) : null;
    // how much of THIS shape's cleared flow we captured (our contracts / total cleared)
    const capPct = (s.cleared_ct > 0) ? Math.min(100, Math.round(100 * (s.our_ct || 0) / s.cleared_ct)) : null;
    const pills = [
      pill("RFQs", fmtInt(s.rfqs)),
      pill("$ bud", fmtMoney(s.risk)),
      pill("cleared", `${fmtInt(s.cleared_ct || 0)} ct · ${fmtMoney(s.cleared_no || 0)}`, "pos"),
      adminS ? pill("ours", `${fmtInt(s.our_ct || 0)} ct · ${fmtMoney(s.our_no || 0)}`, "pos") : "",
      adminS ? pill("captured", capPct != null ? `${capPct}%` : "—", capPct != null && capPct >= 50 ? "pos" : (capPct != null && capPct < 20 ? "neg" : "")) : "",
      pill("clears", clrVal, clrCls),
      naive != null ? pill("naive", `${naive}c`) : "",
      vsNaive != null ? pill("mkt vs naive", (vsNaive >= 0 ? `+${vsNaive}` : `${vsNaive}`), vsNaive >= 0 ? "pos" : "neg") : "",
      pill("our bid", s.our_bid_c != null ? s.our_bid_c + "c" : "—"),
      gap != null ? pill("gap", (gap >= 0 ? `+${gap}` : `${gap}`), gap >= 0 ? "pos" : "neg") : "",
    ].join("");
    // SIZE DISTRIBUTION (small vs huge RFQs) + clearing PER size bucket — chips
    // left->right = small->large; the fill width shows count share, the ¢ shows
    // whether clearing moves as RFQ size grows.
    const sb = (s.size_buckets || []).filter((b) => b.n > 0);
    let sizesHtml = "";
    if (sb.length) {
      const maxn = Math.max(...sb.map((b) => b.n));
      const chips = sb.map((b) => {
        const w = Math.max(4, Math.round((100 * b.n) / maxn));
        return `<span class="shp-sz" title="${b.n} RFQs sized ${b.label} (${fmtMoney(b.risk || 0)} demand)">`
          + `<span class="shp-sz-fill" style="width:${w}%"></span>`
          + `<span class="shp-sz-txt"><b>${b.label}</b> ${fmtInt(b.n)}</span></span>`;
      }).join("");
      sizesHtml = `<div class="shp-sizes"><span class="shp-sz-lbl">by size</span>${chips}</div>`;
    }
    return `<div class="shp">
      <div class="shp-legs">${legsHtml}<span class="shp-raw">${escapeHtml(raw)}</span></div>
      ${whyHtml}
      <div class="shp-stats">${pills}</div>
      ${sizesHtml}
    </div>`;
  }).join("");
  return `<div class="gx-sub">
    <div class="shp-sub-head">Shapes ${state.metric === "price" ? "by avg clear ¢" : `by occurrence · ${metricLabel()}`}</div>
    <div class="shp-chart">${occChart}</div>
    <div class="shp-list">${body}</div>
    <div class="chart-caption">“cleared” = the TRUE volume that printed on this shape's combo — contracts and NO-side $ off the trade tape (EVERY maker, incl. resting/CLOB fills with no RFQ). ${adminS ? `“ours” = our open impossible-parlay exposure on this shape (= Cost Paid). “captured” = our share of the contracts that cleared on this shape (our ct ÷ cleared ct, capped 100%). Admin only. ` : ""}“clears” = the price RANGE it prints at (typ = median NO ¢). “naive” = the NO price a dumb independent-leg bot computes from current leg mids; “mkt vs naive” = how much richer/cheaper the market clears. gap = our bid − typ (<span class="pos">≥0 we win the typical</span>, <span class="neg">&lt;0 priced out</span>). “by size” = RFQ-count distribution by taker $ size (bar = share), left→small right→large.</div>
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
