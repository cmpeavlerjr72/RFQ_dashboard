// Props tab — live MLB RBI/HR prop maker book grouped into game cards.
// Pulls /api/props (server reads MP resting orders + positions, joins ESPN).
import { initAccountPicker, withAccount } from "/account.js";

const $ = (id) => document.getElementById(id);
let timer = null;

function esc(s) { return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function c1(x) { return (x == null) ? "—" : x.toFixed(2); }

function stateBadge(espn) {
  if (!espn || !espn.state) return "";
  const cls = espn.state === "in" ? "in" : espn.state === "post" ? "post" : "pre";
  return `<span class="gc-state ${cls}">${esc(espn.detail || espn.state)}</span>`;
}

function scoreStr(espn, away, home) {
  if (!espn || espn.awayScore == null) return "";
  return `${esc(away)} ${espn.awayScore} — ${espn.homeScore} ${esc(home)}`;
}

function statusCell(p) {
  if (p.status === "settled") {
    return p.won ? `<span class="st-settled-win">WON</span>` : `<span class="st-settled-loss">LOST</span>`;
  }
  if (p.status === "filled") return `<span class="st-filled">${p.filled_ct}✓</span>`;
  if (p.status === "partial") return `<span class="st-partial">${p.filled_ct}✓ / ${p.resting_ct}⧗</span>`;
  return `<span class="st-resting">${p.resting_ct}⧗</span>`;
}

function propRow(p) {
  const edge = p.edge_c == null ? "—"
    : `<span class="${p.edge_c >= 0 ? "edge-pos" : "edge-neg"}">${p.edge_c >= 0 ? "+" : ""}${p.edge_c}c</span>`;
  return `<tr>
    <td>${esc(p.player)}</td>
    <td><span class="badge ${p.kind}">${p.kind} ${p.line}+</span></td>
    <td title="we sell YES / hold NO">NO @ ${c1(p.our_yes)}</td>
    <td>${c1(p.cur_bid)}/${c1(p.cur_ask)}</td>
    <td>${edge}</td>
    <td>${statusCell(p)}</td>
  </tr>`;
}

function gameCard(g) {
  const teamsLbl = g.espn && g.espn.awayName
    ? `${esc(g.espn.awayName)} @ ${esc(g.espn.homeName)}`
    : `${esc(g.away)} @ ${esc(g.home)}`;
  const filled = g.props.filter((p) => p.filled_ct > 0).length;
  return `<div class="game-card">
    <div class="gc-head">
      <span class="gc-teams">${teamsLbl}${stateBadge(g.espn)}</span>
      <span class="gc-score">${scoreStr(g.espn, g.away, g.home)}</span>
    </div>
    <div style="font-size:.72rem;opacity:.65;margin-bottom:.3rem">
      ${g.props.length} props · ${filled} filled · $${g.collateral.toFixed(0)} at risk
    </div>
    <table class="props">
      <thead><tr><th>Player</th><th>Market</th><th>Our side</th><th>K bid/ask</th><th>Edge</th><th>Status</th></tr></thead>
      <tbody>${g.props.map(propRow).join("")}</tbody>
    </table>
  </div>`;
}

async function load() {
  const dot = $("status-dot"), txt = $("status-text");
  dot.className = "dot loading"; txt.textContent = "loading…";
  try {
    const r = await fetch(withAccount("/api/props"));
    const d = await r.json();
    const s = d.summary || {};
    $("summary").innerHTML = [
      ["Games", s.games ?? 0], ["Props", s.props ?? 0],
      ["Resting ct", s.resting_ct ?? 0], ["Filled ct", s.filled_ct ?? 0],
      ["$ at risk", "$" + (s.collateral ?? 0).toFixed(0)],
      ["Realized", "$" + (s.realized ?? 0).toFixed(2)],
    ].map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
    const games = d.games || [];
    $("empty").style.display = games.length ? "none" : "block";
    $("games").innerHTML = games.map(gameCard).join("");
    $("updated").textContent = "updated " + new Date(d.updated).toLocaleTimeString();
    dot.className = "dot ok"; txt.textContent = "live";
  } catch (e) {
    dot.className = "dot err"; txt.textContent = "error";
    $("updated").textContent = String(e).slice(0, 80);
  }
}

function setAuto(on) {
  if (timer) { clearInterval(timer); timer = null; }
  if (on) timer = setInterval(load, 30_000);
}

initAccountPicker(load);
$("refresh-btn").addEventListener("click", load);
$("auto-refresh").addEventListener("change", (e) => setAuto(e.target.checked));
load();
setAuto(true);
