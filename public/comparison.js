// Comparison page — fetch /api/recap (ours) + /api/partner-recap (theirs)
// and render side-by-side ROI / WR / volume comparisons.
//
// Design choices:
//  - All comparisons use ROI %, win-rate %, $/fill — NEVER raw $ PnL. Their
//    volume is ~10× ours so $ comparison would be misleading.
//  - Partner-side: per-day and per-sport tables on their dashboard are
//    combined pregame+live (they don't expose a finer pregame split at those
//    granularities). Per-prop-type IS exposed as pregame-only, so we use
//    pregame_by_prop_type there. Every combined cell is badged with the
//    lifetime pregame share so the user can read past the mix.
//  - Per-sport is the cleanest join (sport names match). Per-prop-type is
//    shown side-by-side without forced alignment (their "Total (NBA)" doesn't
//    map cleanly to our "TOTAL" / "GAME+TOTAL" / etc. stat_sets).
//  - Daily chart shows cumulative ROI as two lines so we can see whether
//    the strategies move together or diverge.

import { initAccountPicker, withAccount } from "/account.js";

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

/**
 * Lifetime pregame share of partner's volume — used to badge combined cells
 * so the user knows roughly how much of the partner number is pregame.
 * Returns {pnlPct, nPct} both in 0..100, or null if the pregame_vs_live
 * table wasn't scraped successfully.
 */
function partnerPregameShare(theirs) {
  const rows = theirs?.pregame_vs_live || [];
  const pre = rows.find((r) => /pregame/i.test(r.label || ""));
  const live = rows.find((r) => /live/i.test(r.label || ""));
  if (!pre || !live) return null;
  const totalPnl = (pre.pnl_dollars || 0) + (live.pnl_dollars || 0);
  const totalN = (pre.n || 0) + (live.n || 0);
  return {
    pnlPct: totalPnl > 0 ? (100 * (pre.pnl_dollars || 0)) / totalPnl : null,
    nPct: totalN > 0 ? (100 * (pre.n || 0)) / totalN : null,
  };
}

/** Tiny inline badge with a tooltip explaining the combined-data caveat. */
function combinedBadge(share) {
  const pct = share?.pnlPct;
  const text = pct != null ? `combined · ~${Math.round(pct)}% pregame` : "combined";
  const tip = pct != null
    ? `Partner exposes only combined (pregame+live) numbers at this granularity. Lifetime split: pregame is ~${pct.toFixed(0)}% of their P&L and ~${(share?.nPct ?? 0).toFixed(0)}% of their fills.`
    : "Partner exposes only combined (pregame+live) numbers at this granularity.";
  return `<span class="combined-badge" title="${escapeHtml(tip)}">${escapeHtml(text)}</span>`;
}

/**
 * Recompute a partner aggregate by summing their by_day rows inside
 * [startYmd, endYmd]. Returns {n, wins, losses, pnl_dollars, volume_dollars,
 * roi_pct, win_rate_pct}. Used in place of pregame_vs_live (which is a
 * lifetime split with no date breakdown — would ignore the date picker).
 */
function aggregatePartnerByDay(theirs, startYmd, endYmd) {
  const out = { n: 0, wins: 0, losses: 0, pnl_dollars: 0, volume_dollars: 0,
                roi_pct: null, win_rate_pct: null, n_days: 0 };
  if (!theirs || !theirs.by_day) return out;
  const startMs = ymdToTs(startYmd);
  const endMs = ymdToTs(endYmd);
  for (const r of theirs.by_day) {
    const ms = ymdToTs(r.label);
    if (!Number.isFinite(ms) || ms < startMs || ms > endMs) continue;
    out.n += r.n || 0;
    out.wins += r.wins || 0;
    out.losses += r.losses || 0;
    out.pnl_dollars += r.pnl_dollars || 0;
    out.volume_dollars += r.volume_dollars || 0;
    out.n_days += 1;
  }
  if (out.volume_dollars > 0) out.roi_pct = (100 * out.pnl_dollars) / out.volume_dollars;
  if (out.wins + out.losses > 0) out.win_rate_pct = (100 * out.wins) / (out.wins + out.losses);
  return out;
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
      fetch(withAccount(`/api/recap?start=${start}&end=${end}${force_q}`)).then((r) => r.json()),
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
  // Partner aggregate = sum of by_day rows in the picked window. This is
  // COMBINED pregame+live since partner doesn't expose a finer per-day split.
  // The per-card combined-badge surfaces that so users aren't misled.
  const theirAgg = aggregatePartnerByDay(state.theirs, state.start, state.end);
  const share = partnerPregameShare(state.theirs);
  const badge = combinedBadge(share);

  const cards = [
    {
      label: "ROI (settled)", ours: ours.roi_pct, theirs: theirAgg.roi_pct,
      fmt: (v) => fmtPct(v, true), cls: roiClass, badge,
    },
    {
      label: "Win rate", ours: ours.win_rate_pct, theirs: theirAgg.win_rate_pct,
      fmt: (v) => fmtPct(v, false), cls: (v) => (v != null && v > 50 ? "pos" : ""), badge,
    },
    {
      label: "Settled parlays", ours: ours.settled_count, theirs: theirAgg.n,
      fmt: fmtN, cls: () => "", badge,
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
          <div class="compare-side-label">Theirs ${c.badge || ""}</div>
          <div class="kpi-val ${c.cls(c.theirs)}">${c.fmt(c.theirs)}</div>
        </div>
      </div>
      ${c.note ? `<div class="kpi-note">${escapeHtml(c.note)}</div>` : ""}
    </div>
  `).join("");
}

function renderSportTable() {
  // Partner's by_sport is combined pregame+live AND lifetime (no per-date),
  // so we just show it badged. The picked-window gate we used to apply here
  // was solving the wrong problem — pregame split isn't available per-sport
  // either, so gating by date didn't actually buy pregame; it just hid the
  // table. Better to surface it always with a clear "combined · lifetime" tag.
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

  const sportShare = partnerPregameShare(state.theirs);
  const sportBadge = combinedBadge(sportShare);
  $("sport-table-wrap").innerHTML = `
    <table class="compare-table">
      <thead><tr>
        <th>Sport</th>
        <th colspan="3" class="ours-col">Ours</th>
        <th colspan="3" class="theirs-col">Theirs &middot; lifetime ${sportBadge}</th>
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
  // Partner exposes pregame at prop-type granularity, so use it directly.
  // No date-window gate either — this table is always lifetime pregame on
  // their side vs the picked window on ours.
  const sortedTheirs = [...(state.theirs.pregame_by_prop_type || [])]
    .sort((a, b) => b.n - a.n);
  $("their-prop-wrap").innerHTML = `
    <div class="prop-subhead">Partner &middot; lifetime <b>pregame-only</b></div>
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

  const dayShare = partnerPregameShare(state.theirs);
  const dayBadge = combinedBadge(dayShare);
  $("day-table-wrap").innerHTML = `
    <table class="compare-table">
      <thead><tr>
        <th>Date</th>
        <th colspan="3" class="ours-col">Ours</th>
        <th colspan="3" class="theirs-col">Theirs ${dayBadge}</th>
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
  wrap.innerHTML = compareChartSvg(points, partnerPregameShare(state.theirs));
}

function compareChartSvg(points, share) {
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
      Theirs = pnl/volume-weighted from their daily table &mdash; <b>combined pregame+live</b>
      (no per-day pregame split exposed; lifetime pregame is ~${share?.pnlPct != null ? Math.round(share.pnlPct) : "?"}% of their P&amp;L).
      Their volume is ~10&times; ours so noise dampens faster on their side &mdash; divergence is the signal.
    </div>
  `;
}

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------
$("load-btn").addEventListener("click", () => fetchAll({ force: false }));
$("refresh-btn").addEventListener("click", () => fetchAll({ force: true }));

// Default to the 5/16-5/23 test window we've been discussing — easy to change
// to any range; reasonable starting view.
$("start-date").value = "2026-05-16";
$("end-date").value = todayEt();
$("end-date").max = todayEt();
$("start-date").max = todayEt();

// Account switcher: our side is account-specific (partner side is not), so
// reload if a comparison is already on screen.
initAccountPicker((newAccount) => {
  setStatus(`switched to ${newAccount}`);
  if (state.ours) fetchAll({ force: false });
});

setStatus("ready — click Load");
