// Builders tab — /api/builders (admin-only): per-counterparty profiles of the
// impossible-parlay RFQ creators, classified into tiers + a bot flag.

const $ = (id) => document.getElementById(id);
const state = { data: null, sort: "rfqs" };

const TIERS = ["whale", "shark", "fish", "minnow"];
const TIER_COLOR = { whale: "#fbbf24", shark: "#60a5fa", fish: "var(--muted)", minnow: "#6b7280" };
const TIER_DESC = {
  whale: "≥ $2k total or ≥ $300/RFQ — big money",
  shark: "≥ $300 total or ≥ $50/RFQ — sophisticated mid",
  fish: "ordinary size",
  minnow: "< $5/RFQ — retail dust",
};

function fmtMoney(n) {
  if (n == null || isNaN(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
const fmtInt = (n) => (n == null || isNaN(n) ? "-" : Math.round(n).toLocaleString());
function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function todayEt() {
  const d = new Date(Date.now() - 4 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function etHM(epochSec) {
  if (!epochSec) return "—";
  const e = new Date(epochSec * 1000 - 4 * 3600 * 1000);
  return `${String(e.getUTCHours()).padStart(2, "0")}:${String(e.getUTCMinutes()).padStart(2, "0")}`;
}
function setStatus(text, cls = "") {
  $("status-text").textContent = text;
  const dot = $("status-dot");
  dot.classList.remove("live", "error", "fetching");
  if (cls) dot.classList.add(cls);
}

async function load({ force = false } = {}) {
  const date = $("b-date").value || todayEt();
  setStatus(`loading ${date}…`, "fetching");
  $("refresh-btn").disabled = true;
  try {
    const r = await fetch(`/api/builders?date=${date}${force ? "&fresh=1" : ""}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.data = await r.json();
    render();
    const src = state.data.source;
    setStatus(src === "admin-only" ? "admin only" : src === "empty" ? "no data" : `loaded (${src})`,
              src === "local" || src === "hf" ? "live" : "error");
  } catch (e) {
    setStatus(`error: ${e.message || e}`, "error");
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
  if (d.source === "admin-only") {
    $("summary").innerHTML = "";
    $("tiers-wrap").style.display = $("board-wrap").style.display = "none";
    $("empty-wrap").style.display = "block";
    $("empty-text").textContent = "Builder profiles are admin-only — open this on the admin dashboard (PORTFOLIO=admin).";
    $("footer-text").textContent = "admin only";
    return;
  }
  const s = d.summary || {};
  $("meta-text").textContent = `${d.date} · ${fmtInt(s.n_builders)} builders · ${fmtInt(s.n_rfqs)} impossible RFQs · ${d.source}` + (d.generated_at ? ` · gen ${d.generated_at.slice(11, 16)}` : "");

  $("summary").innerHTML = [
    kpi("Builders", fmtInt(s.n_builders), "", "distinct creator_ids today"),
    kpi("Impossible RFQs", fmtInt(s.n_rfqs), "", "sure-loss parlay requests"),
    kpi("$ requested", fmtMoney(s.total_cost), "pos", "total target cost"),
    kpi("Bots", fmtInt(s.n_bots), s.n_bots > 0 ? "neg" : "", "high-freq automated"),
  ].join("");

  if (!d.builders || !d.builders.length) {
    $("tiers-wrap").style.display = $("board-wrap").style.display = "none";
    $("empty-wrap").style.display = "block";
    $("empty-text").textContent = "no impossible-parlay builders captured for this date yet (creator_id capture started 6/24 ~14:40 ET).";
    $("footer-text").textContent = "no builders";
    return;
  }
  $("empty-wrap").style.display = "none";
  renderTiers(s);
  renderBoard();
  $("footer-text").textContent = `${fmtInt(s.n_builders)} builders · ${fmtInt(s.n_rfqs)} RFQs · ${fmtMoney(s.total_cost)} requested`;
}

function renderTiers(s) {
  $("tiers-wrap").style.display = "block";
  const totB = Object.values(s.by_tier || {}).reduce((a, b) => a + b, 0) || 1;
  const totR = Object.values(s.rfqs_by_tier || {}).reduce((a, b) => a + b, 0) || 1;
  const totC = Object.values(s.cost_by_tier || {}).reduce((a, b) => a + b, 0) || 1;
  $("tiers").innerHTML = TIERS.map((t) => {
    const nb = (s.by_tier || {})[t] || 0, nr = (s.rfqs_by_tier || {})[t] || 0, nc = (s.cost_by_tier || {})[t] || 0;
    const bar = (v, tot) => `<span class="shp-bar-track" style="display:inline-block;width:120px;vertical-align:middle"><span class="shp-bar-fill" style="width:${Math.round(100 * v / tot)}%;background:${TIER_COLOR[t]}"></span></span>`;
    return `<div class="shp" style="border-left:3px solid ${TIER_COLOR[t]}">
      <div class="shp-legs"><span class="shp-leg" style="color:${TIER_COLOR[t]};text-transform:uppercase;font-weight:600">${t}</span>
        <span class="shp-raw">${escapeHtml(TIER_DESC[t])}</span></div>
      <div class="shp-stats">
        <span class="shp-pill"><i>builders</i>${fmtInt(nb)} ${bar(nb, totB)} ${Math.round(100 * nb / totB)}%</span>
        <span class="shp-pill"><i>RFQs</i>${fmtInt(nr)} ${bar(nr, totR)} ${Math.round(100 * nr / totR)}%</span>
        <span class="shp-pill"><i>$ req</i>${fmtMoney(nc)} ${bar(nc, totC)} ${Math.round(100 * nc / totC)}%</span>
      </div></div>`;
  }).join("");
}

function renderBoard() {
  $("board-wrap").style.display = "block";
  $("board-hint").textContent = `top builders by ${state.sort === "cost" ? "$ requested" : "# RFQs"} (click a row to expand shapes)`;
  const rows = state.data.builders.slice().sort((a, b) =>
    state.sort === "cost" ? b.cost - a.cost : b.rfqs - a.rfqs).slice(0, 60);
  const head = `<div class="bld-row bld-head">
    <span>builder</span><span>tier</span><span>RFQs</span><span>$ req</span><span>$ avg</span>
    <span>legs</span><span>shapes</span><span>/min</span><span>active</span></div>`;
  const body = rows.map((b) => {
    const botTag = b.is_bot ? `<span class="bld-bot">BOT</span>` : "";
    const span = `${etHM(b.first_ts)}–${etHM(b.last_ts)}`;
    return `<div class="bld-row" title="${escapeHtml((b.top_shapes || []).map((x) => x[0] + ' ×' + x[1]).join('  ·  '))}">
      <span class="bld-id"><code>${escapeHtml((b.id || "").slice(0, 12))}…</code>${botTag}</span>
      <span style="color:${TIER_COLOR[b.tier] || 'var(--muted)'};text-transform:uppercase;font-size:11px">${escapeHtml(b.tier)}</span>
      <span><b>${fmtInt(b.rfqs)}</b></span>
      <span>${fmtMoney(b.cost)}</span>
      <span class="muted">$${(b.avg_cost || 0).toFixed(1)}</span>
      <span class="muted">${(b.avg_legs || 0).toFixed(1)}</span>
      <span class="muted">${fmtInt(b.n_shapes)} / ${fmtInt(b.n_games)}g</span>
      <span class="muted">${(b.rfq_per_min || 0).toFixed(1)}</span>
      <span class="muted" style="font-size:11px">${span}</span></div>`;
  }).join("");
  $("board").innerHTML = `<div class="bld-table">${head}${body}</div>`
    + `<div class="chart-caption">tier = size class · BOT = ≥150 RFQs at ≥2/min · "shapes" = distinct shapes / games requested · hover a row for the builder's top shapes. Builder ids are opaque Kalshi hashes (no PII).</div>`;
}

$("sort-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-sort]");
  if (!btn) return;
  state.sort = btn.dataset.sort;
  for (const b of $("sort-toggle").querySelectorAll("button")) b.classList.toggle("active", b === btn);
  if (state.data) renderBoard();
});
$("refresh-btn").addEventListener("click", () => load({ force: true }));
$("b-date").addEventListener("change", () => load());
$("b-date").value = todayEt();
$("b-date").max = todayEt();
setStatus("ready");
load();
