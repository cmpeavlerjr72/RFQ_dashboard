// MLB prop-maker book rendered as game cards INTO the Live page (#prop-cards).
// Independent of app.js's parlay pipeline: owns only #prop-cards, fetches
// /api/props on its own 30s cadence + on account switch. app.js never touches
// this container, so there is no clobber.
import { withAccount } from "/account.js";

const STYLE = `
#prop-cards .pc { background:var(--card,#161a22); border:1px solid #232a36; border-radius:12px; padding:.7rem .85rem; }
#prop-cards .pc-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:.35rem; }
#prop-cards .pc-teams { font-weight:700; }
#prop-cards .pc-score { font-variant-numeric:tabular-nums; font-weight:700; }
#prop-cards .pc-state { font-size:.68rem; padding:.05rem .35rem; border-radius:6px; margin-left:.35rem; }
#prop-cards .pc-state.pre { background:#2a3340; } #prop-cards .pc-state.in { background:#1e5b2e; } #prop-cards .pc-state.post { background:#3a2530; }
#prop-cards .pc-sub { font-size:.7rem; opacity:.65; margin-bottom:.3rem; }
#prop-cards table { width:100%; border-collapse:collapse; font-size:.8rem; }
#prop-cards th { text-align:left; opacity:.55; font-weight:500; font-size:.66rem; text-transform:uppercase; }
#prop-cards td { padding:.16rem .3rem; border-top:1px solid #222; font-variant-numeric:tabular-nums; }
#prop-cards .b { font-size:.64rem; padding:.05rem .3rem; border-radius:5px; }
#prop-cards .b.RBI2 { background:#3b2f5c; } #prop-cards .b.RBI { background:#2f4a5c; } #prop-cards .b.HR { background:#5c3b2f; }
#prop-cards .rest { opacity:.55; } #prop-cards .fill { color:#6fd08c; font-weight:600; } #prop-cards .part { color:#e0c05a; }
#prop-cards .win { color:#6fd08c; } #prop-cards .loss { color:#e06a6a; }
#prop-cards .ep { color:#6fd08c; } #prop-cards .en { color:#e06a6a; }
#prop-summary { display:flex; gap:1rem; flex-wrap:wrap; margin-bottom:.6rem; }
#prop-summary .k { background:var(--card,#161a22); border-radius:9px; padding:.4rem .8rem; }
#prop-summary .k .v { font-size:1.15rem; font-weight:700; } #prop-summary .k .l { font-size:.66rem; opacity:.65; text-transform:uppercase; }
`;

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const c1 = (x) => (x == null ? "—" : x.toFixed(2));

function stateBadge(e) {
  if (!e || !e.state) return "";
  const cls = e.state === "in" ? "in" : e.state === "post" ? "post" : "pre";
  return `<span class="pc-state ${cls}">${esc(e.detail || e.state)}</span>`;
}
function statusCell(p) {
  if (p.status === "settled") return p.won ? `<span class="win">WON</span>` : `<span class="loss">LOST</span>`;
  if (p.status === "filled") return `<span class="fill">${p.filled_ct}✓</span>`;
  if (p.status === "partial") return `<span class="part">${p.filled_ct}✓/${p.resting_ct}⧗</span>`;
  return `<span class="rest">${p.resting_ct}⧗</span>`;
}
function row(p) {
  const edge = p.edge_c == null ? "—" : `<span class="${p.edge_c >= 0 ? "ep" : "en"}">${p.edge_c >= 0 ? "+" : ""}${p.edge_c}c</span>`;
  return `<tr><td>${esc(p.player)}</td><td><span class="b ${p.kind}">${p.kind} ${p.line}+</span></td>
    <td>NO @ ${c1(p.our_yes)}</td><td>${c1(p.cur_bid)}/${c1(p.cur_ask)}</td><td>${edge}</td><td>${statusCell(p)}</td></tr>`;
}
function card(g) {
  const teams = g.espn && g.espn.awayName ? `${esc(g.espn.awayName)} @ ${esc(g.espn.homeName)}` : `${esc(g.away)} @ ${esc(g.home)}`;
  const score = (g.espn && g.espn.awayScore != null) ? `${esc(g.away)} ${g.espn.awayScore}–${g.espn.homeScore} ${esc(g.home)}` : "";
  const filled = g.props.filter((p) => p.filled_ct > 0).length;
  return `<div class="pc">
    <div class="pc-head"><span class="pc-teams">${teams}${stateBadge(g.espn)}</span><span class="pc-score">${score}</span></div>
    <div class="pc-sub">${g.props.length} props · ${filled} filled · $${g.collateral.toFixed(0)} at risk</div>
    <table><thead><tr><th>Player</th><th>Market</th><th>Our side</th><th>K bid/ask</th><th>Edge</th><th>Status</th></tr></thead>
    <tbody>${g.props.map(row).join("")}</tbody></table></div>`;
}

async function load() {
  const wrap = document.getElementById("prop-cards");
  if (!wrap) return;
  try {
    const d = await (await fetch(withAccount("/api/props"))).json();
    const s = d.summary || {};
    const sumEl = document.getElementById("prop-summary");
    if (sumEl) sumEl.innerHTML = [
      ["Games", s.games ?? 0], ["Props", s.props ?? 0], ["Resting ct", s.resting_ct ?? 0],
      ["Filled ct", s.filled_ct ?? 0], ["$ at risk", "$" + (s.collateral ?? 0).toFixed(0)],
      ["Realized", "$" + (s.realized ?? 0).toFixed(2)],
    ].map(([l, v]) => `<div class="k"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
    const games = d.games || [];
    wrap.innerHTML = games.length ? games.map(card).join("")
      : `<div class="empty">no live prop positions or resting orders</div>`;
  } catch (e) {
    wrap.innerHTML = `<div class="empty">props unavailable: ${esc(String(e).slice(0, 60))}</div>`;
  }
}

// inject styles once, then run on load + 30s + account switch
const st = document.createElement("style"); st.textContent = STYLE; document.head.appendChild(st);
load();
setInterval(load, 30_000);
const sel = document.getElementById("account-select");
if (sel) sel.addEventListener("change", () => setTimeout(load, 50));
