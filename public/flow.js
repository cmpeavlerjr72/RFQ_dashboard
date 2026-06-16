// Flow tab — pull /api/flow (10-min rollup cells) for an ET date and render:
//   1. summary KPIs
//   2. game-by-game flow (busiest first): each game's moneyline as an intraday
//      stacked bar by team/tie (momentum-style colors + flags), with a trend KPI
//      and a click-to-expand spread / total / BTTS breakdown
//   3. the all-day flow stacked by sport, the filled-flow chart, leaderboards
// One toggle flips every metric between $ risked and # RFQs.

import { teamBarColors, TEAM_COLORS } from "/team_colors.js";
import { teamLogoUrl } from "/labels.js";
import { NATIONAL_TEAMS } from "/national_teams.js";
import { MLB_TEAMS, NHL_TEAMS, NBA_TEAMS } from "/teams.js";

const $ = (id) => document.getElementById(id);

// ---- game/team helpers (shared by the per-game charts) -----------------------
const NATIONAL = new Set(["WC", "INTLFRIENDLY"]);

// parse_leg sport -> the key teamLogoUrl() expects for flags/logos
function logoKeyFor(sport) {
  const s = (sport || "").toUpperCase();
  if (s === "WC") return "wcup";
  if (s === "INTLFRIENDLY") return "intlfriendly";
  if (s === "SOCCER") return "soccer";
  return s.toLowerCase();   // mlb / wnba / nba / nhl / atp / wta / ipl
}

function teamName(sport, code) {
  const s = (sport || "").toUpperCase();
  if (NATIONAL.has(s)) return NATIONAL_TEAMS[code] || code;
  if (s === "MLB") return MLB_TEAMS[code] || code;
  if (s === "NHL") return NHL_TEAMS[code] || code;
  if (s === "NBA") return NBA_TEAMS[code] || code;
  return code;
}

// hashed fallback color for non-national team codes (national use TEAM_COLORS)
function hashColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 60% 52%)`;
}
const TIE_COLOR = "#7c8794";

// [primary, secondary] per US-league team, mirroring team_colors.js's approach
// for national sides. Secondary is used when two teams in a match clash. Codes
// include the alternate Kalshi abbreviations we see in tickers (AZ/ARI, ATH/OAK,
// CWS/CHW, SF/SFG, SD/SDP, TB/TBR).
const MLB_COLORS = {
  ARI: ["#A71930", "#30CED8"], AZ: ["#A71930", "#30CED8"],
  ATH: ["#003831", "#EFB21E"], OAK: ["#003831", "#EFB21E"],
  ATL: ["#CE1141", "#13274F"], BAL: ["#DF4601", "#000000"],
  BOS: ["#BD3039", "#0C2340"], CHC: ["#0E3386", "#CC3433"],
  CHW: ["#27251F", "#C4CED4"], CWS: ["#27251F", "#C4CED4"],
  CIN: ["#C6011F", "#000000"], CLE: ["#0C2340", "#E50022"],
  COL: ["#5A3B81", "#C4CED4"], DET: ["#0C2340", "#FA4616"],
  HOU: ["#EB6E1F", "#002D62"], KC: ["#004687", "#BD9B60"],
  LAA: ["#BA0021", "#003263"], LAD: ["#005A9C", "#EF3E42"],
  MIA: ["#00A3E0", "#EF3340"], MIL: ["#12284B", "#FFC52F"],
  MIN: ["#002B5C", "#D31145"], NYM: ["#FF5910", "#002D72"],
  NYY: ["#0C2340", "#C4CED4"], PHI: ["#E81828", "#284898"],
  PIT: ["#FDB827", "#27251F"], SD: ["#2F241D", "#FFC425"], SDP: ["#2F241D", "#FFC425"],
  SF: ["#FD5A1E", "#27251F"], SFG: ["#FD5A1E", "#27251F"],
  SEA: ["#005C5C", "#0C2C56"], STL: ["#C41E3A", "#0C2340"],
  TB: ["#092C5C", "#8FBCE6"], TBR: ["#092C5C", "#8FBCE6"],
  TEX: ["#003278", "#C0111F"], TOR: ["#134A8E", "#E8291C"],
  WSH: ["#AB0003", "#14225A"],
};
const WNBA_COLORS = {
  ATL: ["#C8102E", "#1A1A1A"], CHI: ["#418FDE", "#FDD023"],
  CONN: ["#F05023", "#0A2240"], DAL: ["#002B5C", "#C4D600"],
  IND: ["#002D62", "#FDBB30"], LV: ["#000000", "#C8102E"],
  LA: ["#552583", "#FDB927"], MIN: ["#266092", "#79BC43"],
  NY: ["#6ECEB2", "#000000"], PHX: ["#201747", "#E56020"],
  SEA: ["#2C5234", "#FDB927"], WAS: ["#002B5C", "#E03A3E"], WSH: ["#002B5C", "#E03A3E"],
  GS: ["#7E5F9E", "#000000"], GSV: ["#7E5F9E", "#000000"], TOR: ["#B40028", "#1A1A1A"],
};
function colorTableFor(sport) {
  const s = (sport || "").toUpperCase();
  if (s === "MLB") return MLB_COLORS;
  if (s === "WNBA") return WNBA_COLORS;
  return null;
}
const _rgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const _dist = (a, b) => { const x = _rgb(a), y = _rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const CLASH = 110;
// Pick readable colors for two teams from a [primary,secondary] table, falling
// the away team back to its secondary (then home's) when the primaries clash.
function resolvePair(table, home, away) {
  const h = table[home] || [hashColor(home || "H"), hashColor((home || "H") + "2")];
  const a = table[away] || [hashColor(away || "A"), hashColor((away || "A") + "2")];
  let hc = h[0], ac = a[0];
  if (_dist(hc, ac) < CLASH) {
    if (_dist(hc, a[1]) >= CLASH) ac = a[1];
    else if (_dist(h[1], ac) >= CLASH) hc = h[1];
    else ac = a[1];
  }
  return { home: hc, away: ac };
}

// Decide home/away from the game token. Soccer/national tokens are HOME-first
// (26JUN16ARGDZA = ARG home); US sports are AWAY-first (26JUN161845KCWSH = KC
// away). teamCodes = the non-TIE moneyline sides for this game.
function orient(sport, game, teamCodes) {
  const codes = teamCodes.filter((c) => c && c !== "TIE");
  if (codes.length < 2) return { home: codes[0] || "", away: codes[1] || "" };
  const idx = (c) => { const i = game.indexOf(c); return i < 0 ? 1e9 : i; };
  const ordered = [...codes].sort((a, b) => idx(a) - idx(b));   // first-in-token first
  const s = (sport || "").toUpperCase();
  const awayFirst = !(NATIONAL.has(s) || s === "SOCCER");
  return awayFirst
    ? { home: ordered[1], away: ordered[0] }
    : { home: ordered[0], away: ordered[1] };
}

function mlSideColors(sport, home, away) {
  const s = (sport || "").toUpperCase();
  let pair;
  if (NATIONAL.has(s)) {
    pair = teamBarColors(home, away);
  } else {
    const tbl = colorTableFor(s);
    pair = tbl ? resolvePair(tbl, home, away)
               : { home: hashColor(home || "H"), away: hashColor(away || "A") };
  }
  return { [home]: pair.home, [away]: pair.away, TIE: TIE_COLOR };
}

function flagImg(sport, code) {
  const u = teamLogoUrl(logoKeyFor(sport), code);
  return u
    ? `<img class="gx-flag" src="${u}" alt="${escapeHtml(code)}" onerror="this.style.display='none'">`
    : "";
}

const state = {
  data: null,
  metric: "risk",            // "risk" ($) | "rfqs" (count)
  expandedGames: new Set(),  // game tokens with the spread/total/BTTS panel open
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
    $("games-wrap").style.display = "none";
    $("flow-chart-wrap").style.display = "none";
    $("filled-chart-wrap").style.display = "none";
    $("leaderboard-wrap").style.display = "none";
    $("footer-text").textContent = "no flow for this date";
    return;
  }

  renderGames();
  renderFlowChart();
  renderFilledChart();
  renderLeaderboards();

  $("footer-text").textContent =
    `${fmtInt(s.quoted_rfqs)} quoted · ${fmtMoney(s.quoted_risk)} risked · ${fmtInt(s.filled_rfqs)} filled (${fmtPct(s.conversion_pct)})`;
}

// ---- game-by-game flow -------------------------------------------------------
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// Pivot a game's cells for one market into a per-bucket stack.
function pivotMarket(cells, market) {
  const sel = cells.filter((c) => c.market === market);
  const buckets = [...new Set(sel.map((c) => c.bucket))].sort((a, b) => a - b);
  const sides = [...new Set(sel.map((c) => c.side))];
  const byBucket = new Map(buckets.map((b) => [b, new Map()]));
  let tot = 0, rfqs = 0, filled = 0;
  for (const c of sel) {
    const v = valOf(c.r);
    const m = byBucket.get(c.bucket);
    m.set(c.side, (m.get(c.side) || 0) + v);
    tot += v; rfqs += c.r.rfqs; filled += c.r.filled_rfqs;
  }
  return { buckets, sides, byBucket, tot, rfqs, filled };
}

// Is the per-bucket flow rising / cooling / steady over the game's quoting window?
function trendOf(buckets, byBucket) {
  const totals = buckets.map((b) => {
    let t = 0; for (const v of byBucket.get(b).values()) t += v; return t;
  });
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
  const rows = state.data.rows.filter((r) => r.dim === "game_side");
  if (!rows.length) { wrap.style.display = "none"; return; }

  const games = new Map();
  for (const r of rows) {
    const [sport, game, market, side] = r.key.split("|");
    let g = games.get(game);
    if (!g) { g = { sport, game, cells: [], tot: 0 }; games.set(game, g); }
    g.cells.push({ market, side, bucket: r.bucket_ts, r });
    g.tot += valOf(r);
  }
  const ranked = [...games.values()].sort((a, b) => b.tot - a.tot);
  if (!ranked.length) { wrap.style.display = "none"; return; }

  wrap.style.display = "block";
  $("games-hint").textContent =
    `moneyline flow per game, busiest first · ${metricLabel()} · click a game for spread / total / BTTS`;
  $("games-list").innerHTML = ranked.map(gameCardHtml).join("");
}

function gameCardHtml(g) {
  const ml = pivotMarket(g.cells, "ML");
  const teamCodes = ml.sides.filter((s) => s !== "TIE");
  const { home, away } = orient(g.sport, g.game, teamCodes);
  const colorMap = mlSideColors(g.sport, home, away);
  const colorOf = (k) => colorMap[k] || hashColor(k);
  const hasTie = ml.sides.includes("TIE");
  const stackKeys = [home, ...(hasTie ? ["TIE"] : []), away].filter((k) => ml.sides.includes(k));

  const chart = ml.buckets.length
    ? gameStackSvg(ml.buckets, stackKeys, ml.byBucket, colorOf)
    : `<div class="muted" style="padding:8px">no moneyline flow</div>`;
  const trend = trendOf(ml.buckets, ml.byBucket);
  const conv = ml.rfqs > 0 ? (100 * ml.filled) / ml.rfqs : 0;
  const hName = teamName(g.sport, home), aName = teamName(g.sport, away);

  const legend = stackKeys.map((k) => {
    const nm = k === "TIE" ? "Draw" : teamName(g.sport, k);
    return `<span class="gx-lg"><span class="gx-sw" style="background:${colorOf(k)}"></span>${escapeHtml(nm)}</span>`;
  }).join("");

  const expanded = state.expandedGames.has(g.game);
  return `
  <div class="gx-card${expanded ? " open" : ""}" data-game="${escapeHtml(g.game)}">
    <div class="gx-head">
      <div class="gx-match">
        ${flagImg(g.sport, home)}<span class="gx-team" style="color:${colorOf(home)}">${escapeHtml(hName)}</span>
        <span class="gx-vs">vs</span>
        <span class="gx-team" style="color:${colorOf(away)}">${escapeHtml(aName)}</span>${flagImg(g.sport, away)}
        <span class="gx-sport">${escapeHtml(g.sport)}</span>
      </div>
      <div class="gx-kpis">
        <span class="gx-kpi"><b>${fmtMetric(ml.tot)}</b> ML</span>
        <span class="gx-kpi">conv <b>${fmtPct(conv)}</b></span>
        <span class="gx-kpi ${trend.cls}">${trend.arrow} ${trend.label}</span>
        <span class="gx-toggle">${expanded ? "▾" : "▸"} markets</span>
      </div>
    </div>
    <div class="gx-chart">${chart}<div class="gx-legend">${legend}</div></div>
    <div class="gx-details">${expanded ? marketsDetailHtml(g, { sport: g.sport, home, away, colorMap }) : ""}</div>
  </div>`;
}

// Friendly names for the player-prop stat codes (folded into each game card).
const STAT_LABELS = {
  HRR: "Hits+Runs+RBI", HIT: "Hits", KS: "Strikeouts", HR: "Home runs",
  TB: "Total bases", RFI: "Run 1st inning", RBI: "RBIs", SB: "Stolen bases",
  PTS: "Points", REB: "Rebounds", AST: "Assists", "3PT": "3-pointers",
};
const PROP_PALETTE = ["#1e6fd4", "#2f9e44", "#f59f00", "#e8590c", "#c2255c",
  "#7048e8", "#0c8599", "#e8590c", "#495057", "#d6336c"];

function sideLabel(market, side, sport) {
  if (market === "TOTAL") return `O ${side}`;
  if (market === "BTTS") return "Both score";
  if (market === "PROP") return STAT_LABELS[side] || side;
  if (market === "SPREAD") {
    const m = side.match(/^([A-Z]+)(\d+)$/);
    return m ? `${teamName(sport, m[1])} ${m[2]}` : side;
  }
  return side;
}

// The two identity colors [primary, secondary] for a team, used to give the
// same team's multiple spread lines distinct shades.
function teamPair(sport, code) {
  const s = (sport || "").toUpperCase();
  if (NATIONAL.has(s)) return TEAM_COLORS[code] || [hashColor(code || "X"), hashColor((code || "X") + "2")];
  const tbl = colorTableFor(s);
  if (tbl && tbl[code]) return tbl[code];
  return [hashColor(code || "X"), hashColor((code || "X") + "2")];
}
function lighten(hex, amt) {
  if (typeof hex !== "string" || hex[0] !== "#") return hex;   // skip hsl fallbacks
  const [r, g, b] = _rgb(hex);
  const f = (c) => Math.round(c + (255 - c) * amt);
  return `#${[f(r), f(g), f(b)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
// k-th distinct shade for one team: primary, secondary, then lightened variants.
function shadeRamp(pair, k) {
  if (k === 0) return pair[0];
  if (k === 1) return pair[1];
  return lighten(pair[k % 2], 0.2 * Math.floor(k / 2));
}

// Returns side -> color for one market's stacked sub-chart.
function detailColorFn(market, ctx, sides) {
  if (market === "SPREAD") {
    // Group the lines by team and give each line its own shade so stacked
    // same-team spreads (FRA2, FRA3, ...) read as distinct bands.
    const byTeam = {};
    for (const s of sides) {
      const m = s.match(/^([A-Z]+)(\d+)$/);
      const team = m ? m[1] : s;
      (byTeam[team] = byTeam[team] || []).push(s);
    }
    const map = {};
    for (const team of Object.keys(byTeam)) {
      const lines = byTeam[team].sort(
        (a, b) => (parseInt(a.replace(/\D/g, ""), 10) || 0) - (parseInt(b.replace(/\D/g, ""), 10) || 0));
      const pair = teamPair(ctx.sport, team);
      lines.forEach((s, i) => { map[s] = shadeRamp(pair, i); });
    }
    return (s) => map[s] || hashColor(s);
  }
  if (market === "TOTAL") {
    return (s) => PROP_PALETTE[(parseInt(s, 10) || 0) % PROP_PALETTE.length];
  }
  if (market === "PROP") {
    return (s) => PROP_PALETTE[Math.abs(hashCode(s)) % PROP_PALETTE.length];
  }
  return () => "#2dd4bf";   // BTTS
}
function hashCode(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

function orderSides(market, sides) {
  if (market === "TOTAL") return [...sides].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  return [...sides].sort();
}

const MARKET_TITLES = { SPREAD: "Spread", TOTAL: "Total", BTTS: "Both teams to score", PROP: "Player props (by stat)" };

function marketsDetailHtml(g, ctx) {
  const html = ["SPREAD", "TOTAL", "BTTS", "PROP"].map((mkt) => {
    const p = pivotMarket(g.cells, mkt);
    if (!p.buckets.length) return "";
    const sides = orderSides(mkt, p.sides);
    const colorOf = detailColorFn(mkt, ctx, sides);
    const chart = gameStackSvg(p.buckets, sides, p.byBucket, colorOf, { H: 150 });
    const legend = sides.map((s) =>
      `<span class="gx-lg"><span class="gx-sw" style="background:${colorOf(s)}"></span>${escapeHtml(sideLabel(mkt, s, g.sport))}</span>`
    ).join("");
    return `<div class="gx-sub">
      <div class="gx-sub-head">${MARKET_TITLES[mkt]} · ${fmtMetric(p.tot)}</div>
      ${chart}<div class="gx-legend">${legend}</div>
    </div>`;
  }).join("");
  return html || `<div class="muted" style="padding:6px 2px">no other markets quoted for this game</div>`;
}

function gameStackSvg(buckets, stackKeys, byBucket, colorOf, opts = {}) {
  const W = opts.W || 560, H = opts.H || 118, padL = opts.padL || 46, padR = 8, padT = 8, padB = 18;
  const inW = W - padL - padR, inH = H - padT - padB, n = buckets.length;
  let yMax = 0;
  for (const b of buckets) {
    let t = 0; const m = byBucket.get(b);
    for (const k of stackKeys) t += m.get(k) || 0;
    if (t > yMax) yMax = t;
  }
  yMax = yMax || 1;
  const bw = Math.max(1, (inW / n) * 0.84);
  const xFor = (i) => padL + (i + 0.5) * (inW / n);
  const yFor = (v) => padT + inH - (v / yMax) * inH;

  let bars = "";
  buckets.forEach((b, i) => {
    const m = byBucket.get(b); let acc = 0; const cx = xFor(i) - bw / 2;
    for (const k of stackKeys) {
      const v = m.get(k) || 0;
      if (v <= 0) continue;
      const y0 = yFor(acc), y1 = yFor(acc + v);
      bars += `<rect x="${cx.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, y0 - y1).toFixed(1)}" fill="${colorOf(k)}"><title>${etHM(b)} · ${escapeHtml(k)}: ${fmtMetric(v)}</title></rect>`;
      acc += v;
    }
  });

  const yTicks = [];
  for (let t = 0; t <= 2; t++) {
    const v = (t / 2) * yMax, yy = yFor(v);
    yTicks.push(`<g class="tick"><line x1="${padL}" y1="${yy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yy.toFixed(1)}"/><text x="${padL - 5}" y="${yy.toFixed(1)}" text-anchor="end" dominant-baseline="central">${fmtMetric(v)}</text></g>`);
  }
  const xLabels = [];
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    xLabels.push(`<text x="${xFor(i).toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="middle">${etHM(buckets[i])}</text>`);
  }
  return `<svg class="roi-chart flow-bars gx-svg" viewBox="0 0 ${W} ${H}">
    <g class="axis-y">${yTicks.join("")}</g><g class="bars">${bars}</g><g class="axis-x">${xLabels.join("")}</g>
  </svg>`;
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

  return `<svg class="roi-chart flow-bars" viewBox="0 0 ${W} ${H}">
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
  return `<svg class="roi-chart flow-bars" viewBox="0 0 ${W} ${H}">
    <g class="axis-y">${yTicks.join("")}</g><g class="bars">${bars}</g><g class="axis-x">${xLabels.join("")}</g>
  </svg>
  <div class="chart-caption">Flow that filled, by the window it was quoted in · ${metricLabel()} (own scale).</div>`;
}

// ---- leaderboards (sport / game / stat) ----
function renderLeaderboards() {
  const wrap = $("leaderboard-wrap");
  wrap.style.display = "block";
  // Per-game and per-stat flow now live inside the game cards above; only the
  // cross-game sport rollup remains as a table.
  wrap.innerHTML = leaderboardTable("By sport", "sport");
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
// Click anywhere on a game card to expand/collapse its market breakdown.
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
