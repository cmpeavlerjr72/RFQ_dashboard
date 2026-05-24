// Comparison page — fetch /api/recap (ours) + /api/partner-recap (theirs)
// and render side-by-side ROI / WR / volume comparisons.
//
// Design choices:
//  - All comparisons use ROI %, win-rate %, $/fill — NEVER raw $ PnL. Their
//    volume is ~10× ours so $ comparison would be misleading.
//  - "Pregame only" toggle on by default since we don't trade live; we want
//    apples-to-apples.
//  - Per-sport is the cleanest join (sport names match). Per-prop-type is
//    shown side-by-side without forced alignment (their "Total (NBA)" doesn't
//    map cleanly to our "TOTAL" / "GAME+TOTAL" / etc. stat_sets).
//  - Daily chart shows cumulative ROI as two lines so we can see whether
//    the strategies move together or diverge.

const $ = (id) => document.getElementById(id);

const state = {
  loading: false,
  ours: null,
  theirs: null,
  start: null,
  end: null,
};

function setStatus(text, cls = "") {
  $("status-text").textContent = text;
  const dot = $("status-dot");
  dot.classList.remove("live", "error", "fetching");
  if (cls) dot.classList.add(cls);
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtPct(n, signed = true) {
  if (n == null || isNaN(n)) return "—";
  const v = n.toFixed(1);
  return signed ? `${n >= 0 ? "+" : ""}${v}%` : `${v}%`;
}
function fmtN(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString();
}
function fmtDollar(n) {
  if (n == null || isNaN(n)) return "—";
  return `$${Number(n).toFixed(2)}`;
}
function pnlClass(n) {
  if (n == null || n === 0) return "";
  return n > 0 ? "pos" : "neg";
}
function roiClass(n) {
  if (n == null) return "";
  if (Math.abs(n) < 1) return "";
  return n > 0 ? "pos" : "neg";
}
function todayEt() {
  const now = new Date();
  const etMs = now.getTime() - 4 * 3600 * 1000;
  const d = new Date(etMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function ymdToTs(ymd) {
  return Date.parse(ymd + "T00:00:00Z");
}

// ----------------------------------------------------------------------------
// Fetch
// ----------------------------------------------------------------------------
async function fetchAll({ force }) {
  setStatus("fetching…", "fetching");
  state.loading = true;
  const start = $("start-date").value;
  const end = $("end-date").value;
  state.start = start; state.end = end;
  const force_q = force ? "&fresh=1" : "";
  try {
    const [oursR, theirsR] = await Promise.all([
      fetch(`/api/recap?start=${start}&end=${end}${force_q}`).then((r) => r.json()),
      fetch(`/api/partner-recap${force ? "?fresh=1" : ""}`).then((r) => r.json()),
    ]);
    state.ours = oursR;
    state.theirs = theirsR;
    render();
    const partnerNote = theirsR.stale
      ? ` partner: STALE (${Math.round((theirsR.stale_age_ms || 0)/60000)}min old)`
      : ` partner: fresh`;
    setStatus(`loaded — ours: ${oursR.agg.n_parlays} parlays;${partnerNote}`,
              theirsR.stale ? "error" : "live");
    $("meta-text").textContent = `ours: ${oursR.start_et}..${oursR.end_et} · theirs: full window from upstream`;
    $("footer-text").textContent = `ours fetched ${oursR.fetched_at} · theirs ${theirsR.fetched_at}`;
  } catch (e) {
    setStatus("error: " + (e?.message || e), "error");
  } finally {
    state.loading = false;
  }
}

// ----------------------------------------------------------------------------
// Render
// ----------------------------------------------------------------------------
function render() {
  renderSummary();
  renderSportTable();
  renderPropTables();
  renderDayTable();
  renderChart();
}

function renderSummary() {
  const ours = state.ours.agg;
  const theirs = state.theirs;
  const pregameOnly = $("pregame-only").checked;
  // Their pregame-only aggregate: pregame_vs_live[0] (label "Pregame")
  // vs everything (pregame + live).
  let theirAggRoi = null, theirAggN = 0, theirAggWR = null;
  if (theirs && theirs.pregame_vs_live && theirs.pregame_vs_live.length) {
    if (pregameOnly) {
      const p = theirs.pregame_vs_live.find((r) => r.label.toLowerCase() === "pregame");
      if (p) {
        theirAggRoi = p.roi_pct;
        theirAggN = p.n;
        theirAggWR = p.wins != null && p.losses != null && (p.wins + p.losses) > 0
          ? (100 * p.wins) / (p.wins + p.losses) : null;
      }
    } else {
      const totalN = theirs.pregame_vs_live.reduce((a, r) => a + r.n, 0);
      const totalPnL = theirs.pregame_vs_live.reduce((a, r) => a + r.pnl_dollars, 0);
      const totalCost = theirs.pregame_vs_live.reduce((a, r) =>
        a + (r.dollar_per_fill ? r.dollar_per_fill * r.n : 0), 0);
      // ROI = total pnl / (n * $/fill) approx — use weighted avg of roi_pct.
      const wRoi = theirs.pregame_vs_live.reduce((a, r) => a + r.roi_pct * r.n, 0) / Math.max(1, totalN);
      theirAggRoi = wRoi;
      theirAggN = totalN;
      const totalW = theirs.pregame_vs_live.reduce((a, r) => a + (r.wins || 0), 0);
      const totalL = theirs.pregame_vs_live.reduce((a, r) => a + (r.losses || 0), 0);
      theirAggWR = totalW + totalL > 0 ? (100 * totalW) / (totalW + totalL) : null;
    }
  }

  const cards = [
    {
      label: "ROI (settled)", ours: ours.roi_pct, theirs: theirAggRoi,
      fmt: (v) => fmtPct(v, true), cls: roiClass,
    },
    {
      label: "Win rate", ours: ours.win_rate_pct, theirs: theirAggWR,
      fmt: (v) => fmtPct(v, false), cls: (v) => (v != null && v > 50 ? "pos" : ""),
    },
    {
      label: "Settled parlays", ours: ours.settled_count, theirs: theirAggN,
      fmt: fmtN, cls: () => "",
    },
    {
      label: "Break-even WR", ours: ours.breakeven_wr_pct,
      theirs: null, fmt: (v) => v == null ? "—" : fmtPct(v, false),
      cls: () => "",
      note: "Our equal-weighted avg fill price across decided parlays. Partner doesn't expose this.",
    },
  ];
  $("summary-wrap").innerHTML = cards.map((c) => `
    <div class="kpi-card compare-card">
      <div class="kpi-label">${escapeHtml(c.label)}</div>
      <div class="compare-row">
        <div>
          <div class="compare-side-label">Ours</div>
          <div class="kpi-val ${c.cls(c.ours)}">${c.fmt(c.ours)}</div>
        </div>
        <div>
          <div class="compare-side-label">Theirs</div>
          <div class="kpi-val ${c.cls(c.theirs)}">${c.fmt(c.theirs)}</div>
        </div>
      </div>
      ${c.note ? `<div class="kpi-note">${escapeHtml(c.note)}</div>` : ""}
    </div>
  `).join("");
}

function renderSportTable() {
  // Normalize our sport rows (already aggregated). Map partner's sport
  // labels — they use "NBA"/"MLB"/"Soccer"/"Tennis"/"Other" and cross
  // categories like "MLB+NBA". We do likewise. Join on uppercase sport.
  const ours = (state.ours.sport_breakdown || []).map((s) => ({
    sport: s.sport.toUpperCase(),
    n: s.agg.n_parlays,
    wr: s.agg.win_rate_pct,
    roi: s.agg.roi_pct,
    settled: s.agg.settled_count,
  }));
  const theirs = (state.theirs.by_sport || []).map((r) => ({
    sport: r.sport ? r.sport.toUpperCase() : r.label.toUpperCase(),
    n: r.n,
    wr: r.wins != null && r.losses != null && r.wins + r.losses > 0
      ? (100 * r.wins) / (r.wins + r.losses) : null,
    roi: r.roi_pct,
    sig_p: r.sig_p,
  }));
  // Build joined rows; partner-only sports go at the bottom.
  const byKey = new Map();
  for (const o of ours) byKey.set(o.sport, { sport: o.sport, ours: o, theirs: null });
  for (const t of theirs) {
    if (byKey.has(t.sport)) byKey.get(t.sport).theirs = t;
    else byKey.set(t.sport, { sport: t.sport, ours: null, theirs: t });
  }
  // Sort: rows with BOTH sides first (by abs ROI diff desc), then ours-only, then theirs-only.
  const rows = [...byKey.values()];
  rows.sort((a, b) => {
    const aHas = a.ours && a.theirs ? 0 : (a.ours ? 1 : 2);
    const bHas = b.ours && b.theirs ? 0 : (b.ours ? 1 : 2);
    if (aHas !== bHas) return aHas - bHas;
    if (a.ours && a.theirs && b.ours && b.theirs) {
      const ad = Math.abs((a.ours.roi || 0) - (a.theirs.roi || 0));
      const bd = Math.abs((b.ours.roi || 0) - (b.theirs.roi || 0));
      return bd - ad;
    }
    const an = (a.ours?.n || 0) + (a.theirs?.n || 0);
    const bn = (b.ours?.n || 0) + (b.theirs?.n || 0);
    return bn - an;
  });

  $("sport-table-wrap").innerHTML = `
    <table class="compare-table">
      <thead><tr>
        <th>Sport</th>
        <th colspan="3" class="ours-col">Ours</th>
        <th colspan="3" class="theirs-col">Theirs</th>
        <th>ROI diff</th>
      </tr><tr class="sub-head">
        <th></th>
        <th>n</th><th>WR</th><th>ROI</th>
        <th>n</th><th>WR</th><th>ROI</th>
        <th>(us − them)</th>
      </tr></thead>
      <tbody>${rows.map((r) => {
        const diff = (r.ours?.roi != null && r.theirs?.roi != null)
          ? r.ours.roi - r.theirs.roi : null;
        return `
        <tr>
          <td><b>${escapeHtml(r.sport)}</b></td>
          <td>${r.ours ? fmtN(r.ours.settled || r.ours.n) : "—"}</td>
          <td>${r.ours ? fmtPct(r.ours.wr, false) : "—"}</td>
          <td class="${r.ours ? roiClass(r.ours.roi) : ""}">${r.ours ? fmtPct(r.ours.roi) : "—"}</td>
          <td>${r.theirs ? fmtN(r.theirs.n) : "—"}</td>
          <td>${r.theirs ? fmtPct(r.theirs.wr, false) : "—"}</td>
          <td class="${r.theirs ? roiClass(r.theirs.roi) : ""}">${r.theirs ? fmtPct(r.theirs.roi) : "—"}</td>
          <td class="${roiClass(diff)}"><b>${diff == null ? "—" : fmtPct(diff)}</b></td>
        </tr>`;
      }).join("")}</tbody>
    </table>
  `;
}

function renderPropTables() {
  const pregameOnly = $("pregame-only").checked;
  const theirRows = pregameOnly
    ? (state.theirs.pregame_by_prop_type || [])
    : (state.theirs.by_prop_type || []);
  const sortedTheirs = [...theirRows].sort((a, b) => b.n - a.n);
  $("their-prop-wrap").innerHTML = `
    <table class="prop-table">
      <thead><tr><th>Type</th><th>Sport</th><th>n</th><th>WR</th><th>ROI</th><th>$/fill</th></tr></thead>
      <tbody>${sortedTheirs.map((r) => {
        const wr = r.wins != null && r.losses != null && r.wins + r.losses > 0
          ? (100 * r.wins) / (r.wins + r.losses) : null;
        return `<tr>
          <td>${escapeHtml(r.prop_type || r.label)}</td>
          <td>${escapeHtml(r.sport || "—")}</td>
          <td>${fmtN(r.n)}</td>
          <td>${fmtPct(wr, false)}</td>
          <td class="${roiClass(r.roi_pct)}">${fmtPct(r.roi_pct)}</td>
          <td>${fmtDollar(r.dollar_per_fill)}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>
  `;

  // Our side: flatten sport_breakdown's by_stat sub-rows so we get the same
  // granularity as their "Total (NBA)" etc.
  const ourRows = [];
  for (const sp of state.ours.sport_breakdown || []) {
    for (const t of sp.by_type || []) {
      for (const st of t.by_stat || []) {
        ourRows.push({
          stat_set: st.stat_set,
          sport: sp.sport.toUpperCase(),
          type: t.type,
          n: st.agg.n_parlays,
          wr: st.agg.win_rate_pct,
          roi: st.agg.roi_pct,
          settled: st.agg.settled_count,
        });
      }
    }
  }
  ourRows.sort((a, b) => b.n - a.n);
  $("our-prop-wrap").innerHTML = `
    <table class="prop-table">
      <thead><tr><th>Stat set</th><th>Sport</th><th>Type</th><th>n</th><th>WR</th><th>ROI</th></tr></thead>
      <tbody>${ourRows.map((r) => `<tr>
        <td>${escapeHtml(r.stat_set)}</td>
        <td>${escapeHtml(r.sport)}</td>
        <td>${escapeHtml(r.type)}</td>
        <td>${fmtN(r.n)}</td>
        <td>${fmtPct(r.wr, false)}</td>
        <td class="${roiClass(r.roi)}">${fmtPct(r.roi)}</td>
      </tr>`).join("")}</tbody>
    </table>
  `;
}

function renderDayTable() {
  // Build joined daily rows on date. Theirs has many dates outside our window;
  // restrict to dates within [start, end].
  const startMs = ymdToTs(state.start);
  const endMs = ymdToTs(state.end);
  const theirByDate = new Map();
  for (const r of (state.theirs.by_day || [])) {
    const ms = ymdToTs(r.label);
    if (!Number.isFinite(ms) || ms < startMs || ms > endMs) continue;
    theirByDate.set(r.label, r);
  }
  const ourByDate = new Map(
    (state.ours.daily || []).map((r) => [r.date, r])
  );
  const allDates = new Set([...theirByDate.keys(), ...ourByDate.keys()]);
  const dates = [...allDates].sort().reverse();   // newest first

  $("day-table-wrap").innerHTML = `
    <table class="compare-table">
      <thead><tr>
        <th>Date</th>
        <th colspan="3" class="ours-col">Ours</th>
        <th colspan="3" class="theirs-col">Theirs</th>
      </tr><tr class="sub-head">
        <th></th>
        <th>n</th><th>P&amp;L</th><th>cum ROI</th>
        <th>n</th><th>P&amp;L</th><th>ROI</th>
      </tr></thead>
      <tbody>${dates.map((d) => {
        const o = ourByDate.get(d);
        const t = theirByDate.get(d);
        return `<tr>
          <td>${escapeHtml(d)}</td>
          <td>${o ? fmtN(o.n_parlays) : "—"}</td>
          <td class="${o ? pnlClass(o.realized_pnl) : ""}">${o ? fmtDollar(o.realized_pnl) : "—"}</td>
          <td class="${o ? roiClass(o.cum_roi_pct) : ""}">${o && o.cum_roi_pct != null ? fmtPct(o.cum_roi_pct) : "—"}</td>
          <td>${t ? fmtN(t.n) : "—"}</td>
          <td class="${t ? pnlClass(t.pnl_dollars) : ""}">${t ? fmtDollar(t.pnl_dollars) : "—"}</td>
          <td class="${t ? roiClass(t.roi_pct) : ""}">${t ? fmtPct(t.roi_pct) : "—"}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>
  `;
}

// ----------------------------------------------------------------------------
// Chart: two cumulative-ROI lines (ours vs theirs) over the overlap window
// ----------------------------------------------------------------------------
function renderChart() {
  const wrap = $("chart-wrap");
  const startMs = ymdToTs(state.start);
  const endMs = ymdToTs(state.end);

  // Ours: already has cum_roi_pct per day
  const ourSeries = (state.ours.daily || []).map((r) => ({
    date: r.date,
    roi: r.cum_roi_pct,
    n: r.n_parlays,
  }));
  // Theirs: only per-day ROI, no cumulative — compute it ourselves from
  // pnl/volume weighted across the window.
  const theirRaw = (state.theirs.by_day || [])
    .filter((r) => {
      const ms = ymdToTs(r.label);
      return Number.isFinite(ms) && ms >= startMs && ms <= endMs;
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  let cumPnl = 0, cumVol = 0;
  const theirSeries = theirRaw.map((r) => {
    cumPnl += r.pnl_dollars || 0;
    cumVol += r.volume_dollars || 0;
    return {
      date: r.label,
      roi: cumVol > 0 ? (100 * cumPnl) / cumVol : null,
      n: r.n,
    };
  });

  // Align on dates (union)
  const allDates = [...new Set([...ourSeries.map((s) => s.date),
                                ...theirSeries.map((s) => s.date)])].sort();
  if (allDates.length < 2) { wrap.style.display = "none"; return; }

  const ourByDate = new Map(ourSeries.map((s) => [s.date, s]));
  const theirByDate = new Map(theirSeries.map((s) => [s.date, s]));
  // Forward-fill nulls so the line is continuous.
  let lastO = 0, lastT = 0;
  const points = allDates.map((d) => {
    const o = ourByDate.get(d);
    const t = theirByDate.get(d);
    if (o && o.roi != null) lastO = o.roi;
    if (t && t.roi != null) lastT = t.roi;
    return {
      date: d,
      our_roi: lastO, our_has: !!(o && o.roi != null),
      their_roi: lastT, their_has: !!(t && t.roi != null),
    };
  });

  wrap.style.display = "block";
  wrap.innerHTML = compareChartSvg(points);
}

function compareChartSvg(points) {
  const W = 1000, H = 260;
  const padL = 52, padR = 110, padT = 18, padB = 36;
  const inW = W - padL - padR;
  const inH = H - padT - padB;
  const n = points.length;
  const allY = points.flatMap((p) => [p.our_roi, p.their_roi]);
  let yMin = Math.min(0, ...allY);
  let yMax = Math.max(0, ...allY);
  const span = Math.max(1, yMax - yMin);
  yMin -= span * 0.1; yMax += span * 0.1;

  const xFor = (i) => padL + (n === 1 ? inW / 2 : (i / (n - 1)) * inW);
  const yFor = (v) => padT + inH - ((v - yMin) / (yMax - yMin)) * inH;
  const yZero = yFor(0);

  const pathFor = (key) => points.map((p, i) =>
    `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(p[key]).toFixed(1)}`).join(" ");
  const ourPath = pathFor("our_roi");
  const theirPath = pathFor("their_roi");

  const dots = (key, cls) => points.map((p, i) => {
    const cx = xFor(i), cy = yFor(p[key]);
    const had = key === "our_roi" ? p.our_has : p.their_has;
    return `<circle class="dot ${cls}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${had ? 3.5 : 2}" opacity="${had ? 1 : 0.5}"><title>${escapeHtml(p.date + ": " + (p[key]==null?"—":p[key].toFixed(1) + "%"))}</title></circle>`;
  }).join("");

  const yTicks = [];
  for (let t = 0; t < 5; t++) {
    const frac = t / 4;
    const v = yMin + frac * (yMax - yMin);
    const yy = yFor(v);
    yTicks.push(`<g class="tick"><line x1="${padL}" y1="${yy.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yy.toFixed(1)}"/><text x="${padL - 6}" y="${yy.toFixed(1)}" text-anchor="end" dominant-baseline="central">${v >= 0 ? "+" : ""}${v.toFixed(0)}%</text></g>`);
  }
  const xLabels = [];
  const step = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i < n; i += step) {
    const cx = xFor(i);
    const lbl = points[i].date.slice(5);   // MM-DD
    xLabels.push(`<text x="${cx.toFixed(1)}" y="${(H - 10).toFixed(1)}" text-anchor="middle">${lbl}</text>`);
  }
  if ((n - 1) % step !== 0) {
    const cx = xFor(n - 1);
    xLabels.push(`<text x="${cx.toFixed(1)}" y="${(H - 10).toFixed(1)}" text-anchor="middle">${points[n - 1].date.slice(5)}</text>`);
  }

  // Legend on the right
  const legendX = W - padR + 12;
  const legend = `
    <g class="legend" font-size="11">
      <rect x="${legendX}" y="${padT}" width="86" height="56" rx="4" fill="rgba(0,0,0,0.04)" />
      <line x1="${legendX + 6}" y1="${padT + 16}" x2="${legendX + 24}" y2="${padT + 16}" stroke-width="2" stroke="#1976d2"/>
      <text x="${legendX + 28}" y="${padT + 19}">Ours</text>
      <line x1="${legendX + 6}" y1="${padT + 36}" x2="${legendX + 24}" y2="${padT + 36}" stroke-width="2" stroke="#d32f2f"/>
      <text x="${legendX + 28}" y="${padT + 39}">Theirs</text>
    </g>`;

  return `
    <svg class="roi-chart compare" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <g class="axis-y">${yTicks.join("")}</g>
      <line class="zero" x1="${padL}" y1="${yZero.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${yZero.toFixed(1)}"/>
      <path d="${theirPath}" fill="none" stroke="#d32f2f" stroke-width="2"/>
      <path d="${ourPath}" fill="none" stroke="#1976d2" stroke-width="2"/>
      <g class="dots-their">${dots("their_roi", "neg")}</g>
      <g class="dots-our">${dots("our_roi", "pos")}</g>
      <g class="axis-x">${xLabels.join("")}</g>
      ${legend}
    </svg>
    <div class="chart-caption">
      Cumulative ROI over the overlap window. Ours = settled-cost-weighted (from /api/recap).
      Theirs = pnl/volume-weighted from their daily table. Their volume is ~10× ours so noise dampens faster on their side — divergence is the signal.
    </div>
  `;
}

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------
$("load-btn").addEventListener("click", () => fetchAll({ force: false }));
$("refresh-btn").addEventListener("click", () => fetchAll({ force: true }));
$("pregame-only").addEventListener("change", () => {
  if (state.ours && state.theirs) render();
});

// Default to the 5/16-5/23 test window we've been discussing — easy to change
// to any range; reasonable starting view.
$("start-date").value = "2026-05-16";
$("end-date").value = todayEt();
$("end-date").max = todayEt();
$("start-date").max = todayEt();

setStatus("ready — click Load");
