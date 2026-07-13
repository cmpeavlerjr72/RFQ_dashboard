// Grids tab — /api/grids (admin-only): same-game quadrant-grid feasibility
// snapshots from pinmaker/grid_tester.py (via the private HF grid dataset).
// Rendered as a TRUE 2x2 matrix per grid (team axis rows x total axis cols):
// each cell = fair / clearing / vol / RFQs / $intent, GREEN when the quadrant
// is trading (fillable), RED when nothing clears there — the red cells are
// exactly what kills the zero-risk set. If all four traded, a banner shows
// the LOCKED profit (sum of clearing VWAPs - 1) per contract set.
const $ = (id) => document.getElementById(id);

function setStatus(text, ok) {
  $("status-text").textContent = text;
  $("status-dot").className = "dot" + (ok === true ? " ok" : ok === false ? " err" : "");
}

const fmt$ = (v) => (v == null ? "—" : "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }));
const fmtC = (v) => (v == null ? "—" : (Number(v) * 100).toFixed(1) + "c");

function axisLabel(axis) {
  const [kind, key] = String(axis).split(":");
  if (kind === "ML") return { name: "Moneyline", yes: key + " win", no: key + " loss" };
  if (kind === "SP") return { name: "Spread " + key, yes: key + " covers", no: "no cover" };
  return { name: "Total " + key, yes: "Over " + key, no: "Under " + key };
}

function cellHtml(q) {
  const clr = q && q.clr;
  const viable = !!clr;
  const cls = viable ? "cell-ok" : "cell-dead";
  const lines = [
    `<div class="c-price"><span>fair</span> ${q && q.fair != null ? fmtC(q.fair) : "—"}</div>`,
    `<div class="c-price"><span>clear</span> ${clr ? fmtC(clr.vwap) : "—"}${clr ? ` <em>(${clr.vol} ct)</em>` : ""}</div>`,
    `<div class="c-meta">${(q && q.req) || 0} RFQs · ${fmt$(q && q.usd)}</div>`,
  ];
  return `<td class="${cls}">${lines.join("")}</td>`;
}

function gridCard(g) {
  const at = axisLabel(g.axis_team);
  const ao = axisLabel(g.axis_total);
  const q = g.quadrants || {};
  const k = g.kpi || {};
  let banner = "";
  if (k.margin_c != null) {
    const win = k.margin_c > 0;
    banner = `<div class="locked ${win ? "locked-win" : "locked-loss"}">
      ${win ? "LOCKED PROFIT" : "LOCKED LOSS"}: ${k.margin_c.toFixed(1)}c per contract set
      · bottleneck ${k.min_vel_ct_min} ct/min → ~${fmt$(k.profit_hr)}/hr</div>`;
  } else {
    const missing = 4 - (k.cov_clr || 0);
    banner = `<div class="locked locked-na">${missing} quadrant${missing === 1 ? "" : "s"} not trading — no locked set available</div>`;
  }
  return `<div class="grid-card">
    <h3>${g.teams} <span class="hint">— ${at.name} × ${ao.name} (${g.chunk})</span></h3>
    ${banner}
    <table class="matrix">
      <thead><tr><th></th><th>${ao.yes}</th><th>${ao.no}</th></tr></thead>
      <tbody>
        <tr><th>${at.yes}</th>${cellHtml(q["yes+yes"])}${cellHtml(q["yes+no"])}</tr>
        <tr><th>${at.no}</th>${cellHtml(q["no+yes"])}${cellHtml(q["no+no"])}</tr>
      </tbody>
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
      <span class="kpi-chip">grids shown: <b>${d.n_grids || 0}</b> (of ${d.n_tracked || d.n_grids || 0} tracked)</span>
      <span class="kpi-chip">quadrant RFQs: <b>${ctx.grid_rfqs || 0}</b></span>
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
  $("footer-text").textContent = `source: ${d.source} · ${d.n_grids || 0}/${d.n_tracked || "?"} grids · snapshot ${d.at_et || "?"}`;
  setStatus("loaded", true);
}

$("refresh-btn").addEventListener("click", () => load(true));
load(false);
setInterval(() => load(false), 120_000);
