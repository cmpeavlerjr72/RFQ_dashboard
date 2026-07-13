// Grids tab — /api/grids (admin-only): same-game quadrant-grid feasibility
// snapshots from pinmaker/grid_tester.py (via the private HF grid dataset).
// One card per (game, team-axis, total-axis) grid; the 2x2 table shows demand,
// clearing and fair per quadrant. Non-admin instances get an empty
// "admin only" response and never see data (nav link is admin-injected too).
const $ = (id) => document.getElementById(id);

function setStatus(text, ok) {
  $("status-text").textContent = text;
  $("status-dot").className = "dot" + (ok === true ? " ok" : ok === false ? " err" : "");
}

const fmt$ = (v) => (v == null ? "—" : "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }));
const fmtC = (v) => (v == null ? "—" : (Number(v) * 100).toFixed(1) + "c");

const QUAD_ORDER = ["yes+yes", "yes+no", "no+yes", "no+no"];

function axisLabel(axis) {
  // "ML:ATL" -> "ML (ATL side)", "SP:ATL7" -> "Spread ATL7", "OU:180" -> "Total 180"
  const [kind, key] = String(axis).split(":");
  if (kind === "ML") return { name: "ML", yes: key, no: "not " + key };
  if (kind === "SP") return { name: "Spread " + key, yes: key + " covers", no: "no cover" };
  return { name: "Total " + key, yes: "Over", no: "Under" };
}

function quadName(qkey, at, ao) {
  const [st, so] = qkey.split("+");
  return `${st === "yes" ? at.yes : at.no} + ${so === "yes" ? ao.yes : ao.no}`;
}

function gridCard(g) {
  const at = axisLabel(g.axis_team);
  const ao = axisLabel(g.axis_total);
  const k = g.kpi || {};
  const chips = [
    `<span class="kpi-chip${k.cov_req === 4 ? " good" : k.cov_req >= 2 ? " warn" : ""}">demand ${k.cov_req ?? 0}/4 quadrants</span>`,
    `<span class="kpi-chip${k.cov_clr === 4 ? " good" : k.cov_clr >= 2 ? " warn" : ""}">traded ${k.cov_clr ?? 0}/4</span>`,
  ];
  if (k.margin_c != null) {
    chips.push(`<span class="kpi-chip${k.margin_c > 0 ? " good" : ""}">locked margin ${k.margin_c.toFixed(1)}c/set</span>`);
    chips.push(`<span class="kpi-chip">bottleneck ${k.min_vel_ct_min} ct/min</span>`);
    chips.push(`<span class="kpi-chip${k.profit_hr > 0 ? " good" : ""}">~${fmt$(k.profit_hr)}/hr locked</span>`);
  }
  const rows = QUAD_ORDER.map((qk) => {
    const q = (g.quadrants || {})[qk] || {};
    const clr = q.clr || null;
    const dead = !q.req && !clr;
    return `<tr class="${dead ? "quad-dead" : clr ? "quad-hot" : ""}">
      <td>${quadName(qk, at, ao)}</td>
      <td>${q.fair != null ? fmtC(q.fair) : "—"}</td>
      <td>${clr ? fmtC(clr.vwap) : "—"}</td>
      <td>${clr ? clr.vol : "—"}</td>
      <td>${q.req || 0}</td>
      <td>${fmt$(q.usd)}</td>
    </tr>`;
  }).join("");
  return `<div class="grid-card">
    <h3>${g.teams} <span class="hint">— ${at.name} &times; ${ao.name} (${g.chunk})</span></h3>
    <div class="grid-kpis">${chips.join("")}</div>
    <table class="quad-table">
      <thead><tr><th>quadrant</th><th>fair</th><th>clear VWAP</th><th>vol</th><th>RFQs</th><th>$ intent</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

async function load(force) {
  setStatus("loading…");
  let d;
  try {
    d = await (await fetch("/api/grids" + (force ? "?fresh=1" : ""))).json();
  } catch {
    setStatus("fetch failed", false);
    return;
  }
  if (d.source === "admin-only") {
    $("summary").innerHTML = "";
    $("grids-wrap").style.display = "none";
    $("empty-wrap").style.display = "";
    $("empty-text").textContent = "Grid telemetry is admin-only — open this on the admin dashboard.";
    $("footer-text").textContent = "admin only";
    setStatus("admin only", false);
    return;
  }
  const grids = d.grids || [];
  const ctx = d.context || {};
  $("summary").innerHTML = `
    <div class="row">
      <span class="kpi-chip">grids tracked: <b>${d.n_grids || 0}</b></span>
      <span class="kpi-chip">grid RFQs (same-game team&times;total): <b>${ctx.grid_rfqs || 0}</b></span>
      <span class="kpi-chip">other same-game shapes: <b>${(ctx.sgp_other_axes || 0) + (ctx.sgp_hybrid || 0)}</b></span>
      <span class="kpi-chip">window: ${d.window_min || "—"}min</span>
      <span class="kpi-chip">snapshot: ${d.at_et || "—"}</span>
    </div>`;
  if (!grids.length) {
    $("grids-wrap").style.display = "none";
    $("empty-wrap").style.display = "";
    $("empty-text").textContent = "no grids yet — waiting for anchorable games / flow";
  } else {
    $("empty-wrap").style.display = "none";
    $("grids-wrap").style.display = "";
    $("grids").innerHTML = grids.map(gridCard).join("");
  }
  $("footer-text").textContent = `source: ${d.source} · ${d.n_grids || 0} grids · snapshot ${d.at_et || "?"}`;
  setStatus("loaded", true);
}

$("refresh-btn").addEventListener("click", () => load(true));
load(false);
setInterval(() => load(false), 120_000);
