// Lines tab: pick date -> sport -> game -> bet type -> market, render the
// de-vigged probability (and the posted line, when it moves) through the day.
// Data: /api/lines/* (server proxies the public HF snapshot archive).

const $ = (id) => document.getElementById(id);
const statusDot = $("status-dot"), statusText = $("status-text");

let catalog = [];          // MarketEntry[] for the selected date
let current = null;        // current series payload

function setStatus(s, busy) {
  statusText.textContent = s;
  statusDot.style.background = busy ? "#e6a817" : "#2faa60";
}

function etTodayISO() {
  const d = new Date(Date.now() - 4 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function fmtET(ms) {
  return new Date(ms).toLocaleTimeString("en-US",
    { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || r.statusText);
  return r.json();
}

// ---- cascading dropdowns -----------------------------------------------------

function fill(select, values, keep) {
  const prev = keep ? select.value : null;
  select.innerHTML = "";
  for (const [v, label] of values) {
    const o = document.createElement("option");
    o.value = v; o.textContent = label;
    select.appendChild(o);
  }
  if (prev && [...select.options].some((o) => o.value === prev)) select.value = prev;
}

function refreshSport() {
  const sports = [...new Set(catalog.map((m) => m.sport))].sort();
  fill($("sport-select"), sports.map((s) => [s, s.toUpperCase()]), true);
  refreshGame();
}

function refreshGame() {
  const sport = $("sport-select").value;
  const games = [...new Set(catalog.filter((m) => m.sport === sport).map((m) => m.game))].sort();
  fill($("game-select"), games.map((g) => [g, g]), true);
  refreshBetType();
}

function refreshBetType() {
  const sport = $("sport-select").value, game = $("game-select").value;
  const subset = catalog.filter((m) => m.sport === sport && m.game === game);
  const types = [...new Set(subset.map((m) => m.betType))].sort();
  fill($("bettype-select"), types.map((t) => [t, t]), true);
  refreshMarket();
}

function refreshMarket() {
  const sport = $("sport-select").value, game = $("game-select").value,
        bt = $("bettype-select").value;
  const subset = catalog.filter((m) =>
    m.sport === sport && m.game === game && m.betType === bt);
  fill($("market-select"), subset.map((m) => [
    m.id,
    `${m.label}${m.latestLine !== null ? ` [${m.latestLine}]` : ""} · ${m.src} · ${m.n} snaps`,
  ]), false);
  loadSeries();
}

// ---- chart ---------------------------------------------------------------------

const COLORS = { p: "#3b82f6", p2: "#ef4444", p3: "#9ca3af", line: "#10b981" };

function drawChart(points, market) {
  const svg = $("lines-chart");
  svg.innerHTML = "";
  const W = svg.clientWidth || 1100, H = +svg.getAttribute("height");
  const padL = 52, padR = 56, padT = 14, padB = 30;
  const xs = points.map((p) => p.t);
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1);
  const X = (t) => padL + ((t - x0) / (x1 - x0)) * (W - padL - padR);

  const probSeries = ["p", "p2", "p3"].filter((k) => points.some((q) => q[k] !== null));
  const pv = points.flatMap((q) => probSeries.map((k) => q[k]).filter((v) => v !== null));
  let pLo = Math.min(...pv), pHi = Math.max(...pv);
  if (!isFinite(pLo)) { pLo = 0; pHi = 1; }
  const pad = Math.max(0.02, (pHi - pLo) * 0.15);
  pLo = Math.max(0, pLo - pad); pHi = Math.min(1, pHi + pad);
  const Y = (v) => padT + (1 - (v - pLo) / (pHi - pLo)) * (H - padT - padB);

  const lineVals = points.map((q) => q.line).filter((v) => v !== null);
  const hasLine = lineVals.length > 0 && new Set(lineVals).size >= 1;
  let lLo = Math.min(...lineVals), lHi = Math.max(...lineVals);
  if (lLo === lHi) { lLo -= 1; lHi += 1; }
  const YL = (v) => padT + (1 - (v - lLo) / (lHi - lLo)) * (H - padT - padB);

  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.appendChild(e); return e;
  };

  // y axis (prob)
  for (let i = 0; i <= 4; i++) {
    const v = pLo + (i / 4) * (pHi - pLo), y = Y(v);
    el("line", { x1: padL, y1: y, x2: W - padR, y2: y,
                 stroke: "rgba(127,127,127,.2)", "stroke-width": 1 });
    const t = el("text", { x: padL - 6, y: y + 4, "text-anchor": "end",
                           "font-size": 11, fill: "currentColor" });
    t.textContent = (v * 100).toFixed(1) + "%";
  }
  // x ticks
  for (let i = 0; i <= 6; i++) {
    const t0 = x0 + (i / 6) * (x1 - x0), x = X(t0);
    const t = el("text", { x, y: H - 8, "text-anchor": "middle",
                           "font-size": 11, fill: "currentColor" });
    t.textContent = fmtET(t0);
  }
  // right axis (line)
  if (hasLine) {
    for (let i = 0; i <= 4; i++) {
      const v = lLo + (i / 4) * (lHi - lLo);
      const t = el("text", { x: W - padR + 6, y: YL(v) + 4, "font-size": 11,
                             fill: COLORS.line });
      t.textContent = v.toFixed(1);
    }
  }
  // game start marker
  if (market?.start && market.start >= x0 && market.start <= x1) {
    el("line", { x1: X(market.start), y1: padT, x2: X(market.start), y2: H - padB,
                 stroke: "#e6a817", "stroke-width": 1.5, "stroke-dasharray": "5,4" });
  }

  const step = (key, yFn, color, width) => {
    let d = "", prev = null;
    for (const q of points) {
      if (q[key] === null) continue;
      const x = X(q.t), y = yFn(q[key]);
      d += prev === null ? `M${x},${y}` : `L${x},${prev} L${x},${y}`;
      prev = y;
    }
    if (d) el("path", { d, fill: "none", stroke: color, "stroke-width": width });
    for (const q of points) {
      if (q[key] === null) continue;
      const c = el("circle", { cx: X(q.t), cy: yFn(q[key]), r: 2.6, fill: color });
      const tip = document.createElementNS(NS, "title");
      tip.textContent = `${fmtET(q.t)}  ${key === "line" ? q.line :
        (q[key] * 100).toFixed(1) + "%"}${q.over !== null ? `  (o${q.over}/u${q.under})` : ""}`;
      c.appendChild(tip);
    }
  };
  if (hasLine) step("line", YL, COLORS.line, 1.4);
  for (const k of probSeries) step(k, Y, COLORS[k], 2);

  const legend = $("lines-legend");
  const names = { p: probSeries.length > 1 ? "home win %" : "over / yes %",
                  p2: "away win %", p3: "draw %", line: "posted line (right axis)" };
  legend.innerHTML = "";
  const items = [...probSeries, ...(hasLine ? ["line"] : [])];
  for (const k of items) {
    const s = document.createElement("span");
    s.style.color = COLORS[k]; s.textContent = names[k];
    legend.appendChild(s);
  }
}

function drawTable(points) {
  const tb = $("lines-table");
  const rows = points.slice(-25).reverse();
  tb.innerHTML = "<tr><th>time (ET)</th><th>line</th><th>prob</th><th>over</th><th>under</th><th>limit</th></tr>" +
    rows.map((q) => `<tr><td>${fmtET(q.t)}</td><td>${q.line ?? ""}</td>` +
      `<td>${q.p !== null ? (q.p * 100).toFixed(1) + "%" : ""}</td>` +
      `<td>${q.over ?? ""}</td><td>${q.under ?? ""}</td><td>${q.limit ?? ""}</td></tr>`).join("");
}

// ---- loaders -------------------------------------------------------------------

async function loadCatalog() {
  const date = $("date-input").value;
  setStatus("loading catalog…", true);
  try {
    const data = await getJSON(`/api/lines/catalog?date=${date}`);
    catalog = data.markets;
    setStatus(`${catalog.length} markets`, false);
    refreshSport();
    $("footer-text").textContent =
      `snapshot archive: huggingface.co/datasets/mvpeav/kalshi-prop-closes · ${date}`;
  } catch (e) {
    catalog = [];
    refreshSport();
    setStatus(String(e.message || e), false);
  }
}

async function loadSeries() {
  const id = $("market-select").value;
  if (!id) { $("lines-chart").innerHTML = ""; $("lines-table").innerHTML = ""; $("lines-meta").textContent = ""; return; }
  const date = $("date-input").value;
  setStatus("loading series…", true);
  try {
    current = await getJSON(`/api/lines/series?date=${date}&id=${encodeURIComponent(id)}`);
    const m = current.market || {};
    $("lines-meta").innerHTML =
      `<b>${m.label || id}</b> — ${m.game || ""} · ${m.league || ""}` +
      `<span class="src-badge">${m.src === "bov" ? "Bovada" : "Pinnacle"}</span>` +
      (m.limit ? `<span class="src-badge">limit $${m.limit}</span>` : "") +
      ` · ${current.points.length} snapshots` +
      (m.start ? ` · start ${fmtET(m.start)} ET` : "");
    drawChart(current.points, m);
    drawTable(current.points);
    setStatus("ok", false);
  } catch (e) {
    setStatus(String(e.message || e), false);
  }
}

// ---- init ----------------------------------------------------------------------

$("date-input").value = etTodayISO();
$("date-input").addEventListener("change", loadCatalog);
$("sport-select").addEventListener("change", refreshGame);
$("game-select").addEventListener("change", refreshBetType);
$("bettype-select").addEventListener("change", refreshMarket);
$("market-select").addEventListener("change", loadSeries);
loadCatalog();
