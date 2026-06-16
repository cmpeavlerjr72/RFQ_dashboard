// Flow tab — pull /api/flow (10-min rollup cells) for an ET date and render the
// intraday flow chart (stacked by sport), the filled-flow chart, summary KPIs,
// and sport/game/stat leaderboards. One toggle flips every metric between
// $ risked and # RFQs.

const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  metric: "risk",   // "risk" ($) | "rfqs" (count)
};

// Stable-ish sport colors; unknown sports fall back to a hashed hue.
const SPORT_COLORS = {
  WC: "#2dd4bf", INTLFRIENDLY: "#22d3ee", SOCCER: "#34d399", UCL: "#14b8a6",
  MLB: "#60a5fa", NBA: "#f59e0b", WNBA: "#fb923c", NHL: "#a78bfa",
  NFL: "#4ade80", ATP: "#f472b6", WTA: "#e879f9", UFC: "#f87171",
  GOLF: "#84cc16", PGA: "#84cc16", IPL: "#fbbf24", "?": "#64748b",
};
function sportColor(s) {
  if (SPORT_COLORS[s]) return SPORT_COLORS[s];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 55%)`;
}

function setStatus(text, cls = "") {
  $("status-text").textContent = text;
  const dot = $("status-dot");
  dot.classList.remove("live", "error", "fetching");
  if (cls) dot.classList.add(cls);
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
function fmtInt(n) {
  if (n == null || isNaN(n)) return "-";
  return Math.round(n).toLocaleString();
}
function fmtPct(n, dp = 2) {
  if (n == null || isNaN(n)) return "-";
  return `${n.toFixed(dp)}%`;
}
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

// metric accessors on a cell
const valOf = (cell) => (state.metric === "risk" ? cell.leg_risk : cell.rfqs);
const filledValOf = (cell) => (state.metric === "risk" ? cell.filled_risk : cell.filled_rfqs);
const metricLabel = () => (state.metric === "risk" ? "$ risked" : "# RFQs");
const fmtMetric = (n) => (state.metric === "risk" ? fmtMoney(n) : fmtInt(n));

async function loadFlow({ force = false } = {}) {
  const date = $("flow-date").value || todayEt();
  setStatus(`loading ${date}…`, "fetching");
  $("refresh-btn").disabled = true;
  try {
    const r = await fetch(`/api/flow?date=${date}${force ? "&fresh=1" : ""}`);
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
  const s = d.summary;
  $("meta-text").textContent =
    `${d.date} · ${fmtInt(s.quoted_rfqs)} RFQs quoted · ${s.n_buckets} buckets · ${d.source}`;

  $("summary").innerHTML = [
    kpi("RFQs quoted", fmtInt(s.quoted_rfqs), "", `${fmtInt(s.quoted_legs)} legs`),
    kpi("$ risked (quoted)", fmtMoney(s.quoted_risk)),
    kpi("RFQs filled", fmtInt(s.filled_rfqs), "pos"),
    kpi("$ filled", fmtMoney(s.filled_risk), "pos"),
    kpi("Conversion", fmtPct(s.conversion_pct), "", "filled ÷ quoted RFQs"),
    kpi("$ fill rate", fmtPct(s.fill_dollar_pct), "", "filled ÷ quoted $"),
  ].join("");

  if (!d.rows.length) {
    $("flow-chart-wrap").style.display = "none";
    $("filled-chart-wrap").style.display = "none";
    $("leaderboard-wrap").style.display = "none";
    $("footer-text").textContent = "no flow for this date";
    return;
  }

  renderFlowChart();
  renderFilledChart();
  renderLeaderboards();

  $("footer-text").textContent =
    `${fmtInt(s.quoted_rfqs)} quoted · ${fmtMoney(s.quoted_risk)} risked · ${fmtInt(s.filled_rfqs)} filled (${fmtPct(s.conversion_pct)})`;
}

// ---- stacked-by-sport flow chart ----
const MAX_SPORTS = 8;

function bucketList() {
  return [...new Set(state.data.rows.filter((r) => r.dim === "ALL").map((r) => r.bucket_ts))]
    .sort((a, b) => a - b);
}

function renderFlowChart() {
  const wrap = $("flow-chart-wrap");
  const buckets = bucketList();
  if (buckets.length < 1) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";
  $("flow-chart-hint").textContent = `stacked by sport · ${metricLabel()}`;

  // top sports (by current metric across the day), rest folded into "Other"
  const sportTot = new Map();
  for (const r of state.data.rows) {
    if (r.dim !== "sport") continue;
    sportTot.set(r.key, (sportTot.get(r.key) || 0) + valOf(r));
  }
  const ranked = [...sportTot.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const top = ranked.slice(0, MAX_SPORTS);
  const topSet = new Set(top);
  const hasOther = ranked.length > top.length;
  const stackKeys = hasOther ? [...top, "Other"] : top;

  // value[bucket][sportKey]
  const byBucket = new Map(buckets.map((b) => [b, new Map()]));
  for (const r of state.data.rows) {
    if (r.dim !== "sport") continue;
    const m = byBucket.get(r.bucket_ts);
    if (!m) continue;
    const k = topSet.has(r.key) ? r.key : "Other";
    m.set(k, (m.get(k) || 0) + valOf(r));
  }

  $("flow-chart").innerHTML =
    stackedBarSvg(buckets, stackKeys, byBucket) + legend(stackKeys);
}

function legend(keys) {
  return `<div class="flow-legend">` + keys.map((k) =>
    `<span class="lg-item"><span class="lg-swatch" style="background:${sportColor(k)}"></span>${escapeHtml(k)}</span>`
  ).join("") + `</div>`;
}

function stackedBarSvg(buckets, stackKeys, byBucket) {
  const W = 1000, H = 280, padL = 56, padR = 12, padT = 12, padB = 30;
  const inW = W - padL - padR, inH = H - padT - padB;
  const n = buckets.length;

  let yMax = 0;
  for (const b of buckets) {
    let tot = 0;
    const m = byBucket.get(b);
    for (const k of stackKeys) tot += m.get(k) || 0;
    if (tot > yMax) yMax = tot;
  }
  yMax = yMax || 1;

  const bw = Math.max(1, (inW / n) * 0.82);
  const xFor = (i) => padL + (i + 0.5) * (inW / n);
  const yFor = (v) => padT + inH - (v / yMax) * inH;

  let bars = "";
  buckets.forEach((b, i) => {
    const m = byBucket.get(b);
    let acc = 0;
    const cx = xFor(i) - bw / 2;
    for (const k of stackKeys) {
      const v = m.get(k) || 0;
      if (v <= 0) continue;
      const y0 = yFor(acc), y1 = yFor(acc + v);
      bars += `<rect x="${cx.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, y0 - y1).toFixed(1)}" fill="${sportColor(k)}"><title>${etHM(b)} · ${escapeHtml(k)}: ${fmtMetric(v)}</title></rect>`;
      acc += v;
    }
  });

  const yTicks = [];
  for (let t = 0; t <= 4; t++) {
    const v = (t / 4) * yMax, yy = yFor(v);
    yTicks.push(`<g class="tick"><line x1="${padL}" y1="${yy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yy.toFixed(1)}"/><text x="${padL - 6}" y="${yy.toFixed(1)}" text-anchor="end" dominant-baseline="central">${fmtMetric(v)}</text></g>`);
  }
  const xLabels = [];
  const step = Math.max(1, Math.ceil(n / 10));
  for (let i = 0; i < n; i += step) {
    xLabels.push(`<text x="${xFor(i).toFixed(1)}" y="${(H - 9).toFixed(1)}" text-anchor="middle">${etHM(buckets[i])}</text>`);
  }

  return `<svg class="roi-chart flow-bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <g class="axis-y">${yTicks.join("")}</g>
    <g class="bars">${bars}</g>
    <g class="axis-x">${xLabels.join("")}</g>
  </svg>
  <div class="chart-caption">RFQ flow quoted per 10-min window (ET), stacked by sport · ${metricLabel()}.</div>`;
}

// ---- filled-flow chart (separate scale) ----
function renderFilledChart() {
  const wrap = $("filled-chart-wrap");
  const all = state.data.rows.filter((r) => r.dim === "ALL").sort((a, b) => a.bucket_ts - b.bucket_ts);
  const anyFill = all.some((r) => filledValOf(r) > 0);
  if (!anyFill) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";
  $("filled-chart").innerHTML = filledBarSvg(all);
}

function filledBarSvg(all) {
  const W = 1000, H = 160, padL = 56, padR = 12, padT = 12, padB = 30;
  const inW = W - padL - padR, inH = H - padT - padB;
  const n = all.length;
  const yMax = Math.max(1, ...all.map(filledValOf));
  const bw = Math.max(1, (inW / n) * 0.82);
  const xFor = (i) => padL + (i + 0.5) * (inW / n);
  const yFor = (v) => padT + inH - (v / yMax) * inH;

  const bars = all.map((r, i) => {
    const v = filledValOf(r);
    if (v <= 0) return "";
    const y1 = yFor(v), cx = xFor(i) - bw / 2;
    return `<rect x="${cx.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${(yFor(0) - y1).toFixed(1)}" fill="var(--pos)"><title>${etHM(r.bucket_ts)} · filled ${fmtMetric(v)} (of ${fmtMetric(valOf(r))} quoted)</title></rect>`;
  }).join("");

  const yTicks = [];
  for (let t = 0; t <= 2; t++) {
    const v = (t / 2) * yMax, yy = yFor(v);
    yTicks.push(`<g class="tick"><line x1="${padL}" y1="${yy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yy.toFixed(1)}"/><text x="${padL - 6}" y="${yy.toFixed(1)}" text-anchor="end" dominant-baseline="central">${fmtMetric(v)}</text></g>`);
  }
  const xLabels = [];
  const step = Math.max(1, Math.ceil(n / 10));
  for (let i = 0; i < n; i += step) {
    xLabels.push(`<text x="${xFor(i).toFixed(1)}" y="${(H - 9).toFixed(1)}" text-anchor="middle">${etHM(all[i].bucket_ts)}</text>`);
  }
  return `<svg class="roi-chart flow-bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <g class="axis-y">${yTicks.join("")}</g><g class="bars">${bars}</g><g class="axis-x">${xLabels.join("")}</g>
  </svg>
  <div class="chart-caption">Flow that filled, by the window it was quoted in · ${metricLabel()} (own scale).</div>`;
}

// ---- leaderboards (sport / game / stat) ----
function renderLeaderboards() {
  const wrap = $("leaderboard-wrap");
  wrap.style.display = "block";
  wrap.innerHTML =
    leaderboardTable("By sport", "sport") +
    leaderboardTable("By game", "game") +
    leaderboardTable("By stat", "stat");
}

function leaderboardTable(title, dim) {
  // aggregate cells over all buckets for this dim
  const agg = new Map();
  for (const r of state.data.rows) {
    if (r.dim !== dim) continue;
    const a = agg.get(r.key) || { rfqs: 0, legs: 0, leg_risk: 0, filled_rfqs: 0, filled_risk: 0 };
    a.rfqs += r.rfqs; a.legs += r.legs; a.leg_risk += r.leg_risk;
    a.filled_rfqs += r.filled_rfqs; a.filled_risk += r.filled_risk;
    agg.set(r.key, a);
  }
  const metricVal = (a) => (state.metric === "risk" ? a.leg_risk : a.rfqs);
  const rows = [...agg.entries()].sort((x, y) => metricVal(y[1]) - metricVal(x[1])).slice(0, 12);
  const tot = rows.reduce((s, [, a]) => s + metricVal(a), 0) || 1;
  if (!rows.length) return "";

  const body = rows.map(([key, a]) => {
    const v = metricVal(a);
    const conv = a.rfqs > 0 ? (100 * a.filled_rfqs) / a.rfqs : 0;
    return `<tr>
      <td>${escapeHtml(key)}</td>
      <td class="t-num">${fmtMetric(v)}</td>
      <td class="t-num">${(100 * v / tot).toFixed(0)}%</td>
      <td class="t-num">${fmtInt(a.filled_rfqs)}</td>
      <td class="t-num">${fmtPct(conv)}</td>
    </tr>`;
  }).join("");

  return `<div class="flow-board">
    <div class="row section-head"><h2>${title}</h2><span class="hint">${metricLabel()} · top ${rows.length}</span></div>
    <table class="recap-table breakdown-table">
      <thead><tr><th>${dim === "game" ? "Game" : dim === "stat" ? "Stat" : "Sport"}</th>
        <th class="t-num">${state.metric === "risk" ? "$ risked" : "RFQs"}</th>
        <th class="t-num">share</th><th class="t-num">filled</th><th class="t-num">conv.</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

// ---- init ----
$("metric-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-metric]");
  if (!b) return;
  state.metric = b.dataset.metric;
  for (const btn of $("metric-toggle").querySelectorAll("button")) {
    btn.classList.toggle("active", btn === b);
  }
  if (state.data) render();
});
$("refresh-btn").addEventListener("click", () => loadFlow({ force: true }));
$("flow-date").addEventListener("change", () => loadFlow());

$("flow-date").value = todayEt();
$("flow-date").max = todayEt();
setStatus("ready");
loadFlow();
