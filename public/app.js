// Kalshi RFQ dashboard — bet-slip view, NO perspective.
// We hold NO on every parlay, so each leg is rendered as the OPPOSITE of what
// the buyer took, with NO-side odds. Manual-refresh by default.

import { legLabel, legTeams, teamLogoUrl, legGameKey, findEspnEvent, parsePlayerProp } from "/labels.js";
import { buildAthleteIndex } from "/teams.js";

const $ = (id) => document.getElementById(id);

const state = {
  balance: null,
  positions: [],          // each = full parlay record
  fillsByParlay: {},
  scoreboards: {},        // sport:date -> ESPN scoreboard payload
  boxscores: {},          // sport:eventId -> ESPN summary payload
  athleteIdx: {},
  lastRefreshAt: null,
  apiCallsThisSession: 0,
  fetching: false,
};
let autoTimer = null;

// ----------------------------- helpers --------------------------------------

function setStatus(text, cls = "") {
  $("status-text").textContent = text;
  const dot = $("status-dot");
  dot.classList.remove("live", "error", "fetching");
  if (cls) dot.classList.add(cls);
}
function fmtMoney(n) {
  if (n == null || isNaN(n)) return "-";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function pnlClass(n) {
  if (n == null || n === 0) return "";
  return n > 0 ? "pos" : "neg";
}
async function api(path, opts = {}) {
  state.apiCallsThisSession++;
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}
function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function flipSide(s) {
  return (s || "yes").toLowerCase() === "yes" ? "no" : "yes";
}
function dollarsToC(s) {
  if (s == null || s === "") return null;
  const f = parseFloat(s);
  if (!isFinite(f)) return null;
  return f * 100;
}

const SPORT_PREFIXES = {
  KXMLB: "mlb", KXNHL: "nhl", KXNBA: "nba",
  KXATPMATCH: "atp", KXWTAMATCH: "wta", KXUFCFIGHT: "ufc",
};
const MONTHS = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };

function legSport(ticker) {
  for (const [p, s] of Object.entries(SPORT_PREFIXES)) {
    if (ticker.startsWith(p + "-") || ticker.startsWith(p)) return s;
  }
  return null;
}
function legDateYMD(ticker) {
  const m = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return null;
  const yy = parseInt(m[1], 10) + 2000;
  const mon = MONTHS[m[2]];
  const dd = parseInt(m[3], 10);
  return `${yy}${String(mon).padStart(2,"0")}${String(dd).padStart(2,"0")}`;
}

// ----------------------------- data fetch ----------------------------------

async function refresh() {
  if (state.fetching) return;
  state.fetching = true;
  setStatus("fetching", "fetching");
  try {
    const [bal, pos, fills] = await Promise.all([
      api("/api/kalshi/balance"),
      api("/api/kalshi/positions"),
      api("/api/fills"),
    ]);

    state.balance = bal;
    state.fillsByParlay = {};
    for (const f of (fills.fills || [])) {
      if (f.parlay_ticker) state.fillsByParlay[f.parlay_ticker] = f;
    }

    const mp = (pos.market_positions || []).filter(
      (p) => parseFloat(p.position_fp || "0") !== 0,
    );
    state.positions = mp.map((p) => {
      const qty = Math.abs(parseFloat(p.position_fp));
      const exposure = parseFloat(p.market_exposure_dollars || "0");
      const side = parseFloat(p.position_fp) > 0 ? "YES" : "NO";
      const f = state.fillsByParlay[p.ticker] || {};
      return {
        ticker: p.ticker, qty, side,
        cost: exposure,
        avgCostC: qty ? Math.round((exposure / qty) * 100) : 0,
        max_profit: qty - exposure,
        legs: f.legs || [],
        rfq_id: f.rfq_id,
        source: f.source_runner,
        sport: f.sport_hint,
        midC: null, unreal: null,
        legMids: {},
      };
    });

    await enrichMissingLegs();

    // Batch market price fetch (parlays + every leg)
    const tickerSet = new Set();
    for (const p of state.positions) {
      tickerSet.add(p.ticker);
      for (const l of p.legs) tickerSet.add(l.ticker);
    }
    if (tickerSet.size > 0) {
      const tickers = [...tickerSet];
      const CHUNK = 100;
      const markets = {};
      for (let i = 0; i < tickers.length; i += CHUNK) {
        const slice = tickers.slice(i, i + CHUNK);
        const part = await api("/api/kalshi/markets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers: slice }),
        });
        Object.assign(markets, part);
      }
      for (const p of state.positions) {
        const m = markets[p.ticker]?.market || {};
        // Parlay MTM (we hold NO of the parlay)
        const noBidC = dollarsToC(m.no_bid_dollars);
        const noAskC = dollarsToC(m.no_ask_dollars);
        if (noBidC && noAskC && noBidC > 0 && noAskC > 0) {
          const noMidC = (noBidC + noAskC) / 2;
          p.midC = noMidC;
          p.unreal = ((noMidC - p.avgCostC) / 100) * p.qty;
        }
        // Per-leg odds: buyer took side X on leg; we want the OPPOSITE side's price.
        for (const leg of p.legs) {
          const lm = markets[leg.ticker]?.market || {};
          const lLast = dollarsToC(lm.last_price_dollars);
          const lYesBidDirect = dollarsToC(lm.yes_bid_dollars);
          const lYesAskDirect = dollarsToC(lm.yes_ask_dollars);
          const lNoBid = dollarsToC(lm.no_bid_dollars);
          const lNoAsk = dollarsToC(lm.no_ask_dollars);
          // Prefer direct YES prices; fall back to deriving from NO via 100-x.
          const lYesBid = lYesBidDirect != null ? lYesBidDirect : (lNoAsk != null ? 100 - lNoAsk : null);
          const lYesAsk = lYesAskDirect != null ? lYesAskDirect : (lNoBid != null ? 100 - lNoBid : null);
          // Flip the buyer's side to get OUR side
          const ourSide = flipSide(leg.side);
          const bidC = ourSide === "yes" ? lYesBid : lNoBid;
          const askC = ourSide === "yes" ? lYesAsk : lNoAsk;
          // Two-sided quote is "real" only when both endpoints are off the walls.
          // (bidC=0 + askC=100 = empty book, tells us nothing about value.)
          const haveTrueQuote =
            bidC != null && askC != null && bidC > 0 && askC > 0 && askC < 100;
          let midC = null;
          if (haveTrueQuote) {
            midC = (bidC + askC) / 2;
          } else if (lLast != null && lLast >= 0 && lLast <= 100) {
            // last_price is the YES side's last trade — flip for NO side
            midC = ourSide === "yes" ? lLast : (100 - lLast);
          } else if (bidC != null && bidC > 0) {
            midC = bidC;  // winning side, no offers below
          } else if (askC != null && askC > 0 && askC < 100) {
            midC = askC;  // losing side, no bids above
          }
          p.legMids[leg.ticker] = { midC, bidC, askC, status: lm.status };
        }
      }
    }

    // Identify (sport, date) scoreboards we need
    const sbKeys = new Set();
    for (const p of state.positions) {
      for (const leg of p.legs) {
        const sp = legSport(leg.ticker);
        const ymd = legDateYMD(leg.ticker);
        if (sp && ymd) sbKeys.add(`${sp}:${ymd}`);
      }
    }
    await Promise.all([...sbKeys].map(async (k) => {
      const [sport, date] = k.split(":");
      try {
        const sb = await api(`/api/scoreboard?sport=${sport}&date=${date}`);
        state.scoreboards[k] = sb.payload;
      } catch (e) { console.warn("scoreboard fetch failed", k, e); }
    }));

    state.athleteIdx = buildAthleteIndex(state.scoreboards);

    // For player props, pull the boxscore for each game we have a prop on.
    await fetchNeededBoxscores();

    state.lastRefreshAt = new Date();
    setStatus(`updated ${state.lastRefreshAt.toLocaleTimeString()}`, "live");
  } catch (e) {
    console.error(e);
    setStatus(`error: ${e.message}`, "error");
  } finally {
    state.fetching = false;
    render();
    updateFooter();
  }
}

async function enrichMissingLegs() {
  // 1. Positions with rfq_id (came from local fills.jsonl) but no legs yet:
  //    fetch the RFQ directly.
  const haveRfqId = state.positions.filter((p) => p.rfq_id && p.legs.length === 0);
  await Promise.all(haveRfqId.map(async (p) => {
    try {
      const r = await api(`/api/kalshi/rfq/${encodeURIComponent(p.rfq_id)}`);
      const rfq = r.rfq || r;
      const raw = rfq?.mve_selected_legs || [];
      p.legs = raw.map((l) => ({
        ticker: l.market_ticker,
        side: (l.side || "yes"),
        p: null,
      }));
    } catch (e) { console.warn("rfq enrich failed", p.ticker, e); }
  }));

  // 2. Positions with no rfq_id (no local fills file — e.g. deployed dashboard):
  //    walk Kalshi to recover rfq_id, accepted_side, and legs.
  const noRfqId = state.positions.filter((p) => !p.rfq_id && p.legs.length === 0);
  await Promise.all(noRfqId.map(async (p) => {
    try {
      const r = await api(`/api/kalshi/recover/${encodeURIComponent(p.ticker)}`);
      if (r?.rfq_id) {
        p.rfq_id = r.rfq_id;
        p.legs = (r.legs || []).map((l) => ({
          ticker: l.ticker,
          side: (l.side || "yes"),
          p: null,
        }));
      }
    } catch (e) { console.warn("recover failed", p.ticker, e); }
  }));
}

async function fetchNeededBoxscores() {
  // Identify which (sport, eventId) pairs we need based on player-prop legs
  const need = new Map();  // sport:eventId -> {sport, eventId, eventName}
  for (const p of state.positions) {
    for (const leg of p.legs) {
      const prop = parsePlayerProp(leg.ticker);
      if (!prop) continue;
      const ev = findEspnEvent(prop.gameKey, state.scoreboards);
      if (!ev) continue;
      const eventId = String(ev.id || "");
      if (!eventId) continue;
      need.set(`${prop.sport}:${eventId}`, { sport: prop.sport, eventId });
    }
  }
  await Promise.all([...need.values()].map(async ({ sport, eventId }) => {
    try {
      const r = await api(`/api/boxscore?sport=${sport}&eventId=${eventId}`);
      state.boxscores[`${sport}:${eventId}`] = r.payload;
    } catch (e) { console.warn("boxscore fetch failed", sport, eventId, e); }
  }));
}

function updateFooter() {
  const last = state.lastRefreshAt
    ? state.lastRefreshAt.toLocaleTimeString()
    : "never";
  $("footer-text").textContent =
    `last refresh: ${last} · API calls this session: ${state.apiCallsThisSession}`;
  $("meta-text").textContent =
    state.lastRefreshAt ? `${state.positions.length} parlays open` : "";
}

// ----------------------------- player prop stat resolution ------------------

/**
 * Given a parsed player prop and the loaded scoreboard + boxscore,
 * return { current, status, statRaw } where:
 *   current = numeric value of the player's relevant stat right now
 *   status = "alive" (we're winning) | "dead" (we're losing) | "pending" (game not started)
 *
 * Resolution rule (we hold NO):
 *   buyer needs current >= threshold to win YES.
 *   we win NO iff current < threshold (and game is over).
 *
 * Cumulative stats only go up during a game, so:
 *   - if game in-progress and current >= threshold → permanently dead
 *   - if game in-progress and current < threshold → still alive (could flip)
 *   - if game final and current >= threshold → locked dead
 *   - if game final and current < threshold → locked alive
 */
function resolvePlayerProp(prop, scoreboards, boxscores) {
  const ev = findEspnEvent(prop.gameKey, scoreboards);
  if (!ev) return { current: null, status: "pending" };
  const eventId = String(ev.id || "");
  const box = boxscores[`${prop.sport}:${eventId}`];
  const gameState = ev?.status?.type?.state || "pre";
  if (!box) return { current: null, status: gameState === "pre" ? "pending" : "loading" };

  const players = box?.boxscore?.players || [];
  const teamGroup = players.find(
    (g) => (g?.team?.abbreviation || "").toUpperCase() === prop.team.toUpperCase(),
  );
  if (!teamGroup) return { current: null, status: "loading" };

  // Find the player in any stat group whose last name matches.
  let current = null;
  let label = "";
  for (const sg of teamGroup.statistics || []) {
    const keys = sg.keys || [];
    const ath = (sg.athletes || []).find((a) => {
      const nm = (a?.athlete?.displayName || "").trim();
      const last = nm.split(/\s+/).pop().toUpperCase();
      return last === prop.lastName.toUpperCase();
    });
    if (!ath) continue;
    const stats = ath.stats || [];

    function statByKey(key) {
      const idx = keys.indexOf(key);
      if (idx < 0) return null;
      const v = stats[idx];
      if (v == null) return null;
      const f = parseFloat(v);
      return isFinite(f) ? f : null;
    }

    if (prop.stat === "HR") {
      current = statByKey("homeRuns");
      label = `HR: ${current ?? "-"}`;
    } else if (prop.stat === "HIT" || prop.stat === "HITS") {
      current = statByKey("hits");
      label = `H: ${current ?? "-"}`;
    } else if (prop.stat === "R") {
      current = statByKey("runs");
      label = `R: ${current ?? "-"}`;
    } else if (prop.stat === "RBI") {
      current = statByKey("RBIs");
      label = `RBI: ${current ?? "-"}`;
    } else if (prop.stat === "TB") {
      current = statByKey("totalBases");
      label = `TB: ${current ?? "-"}`;
    } else if (prop.stat === "BB") {
      current = statByKey("walks");
      label = `BB: ${current ?? "-"}`;
    } else if (prop.stat === "HRR") {
      const h = statByKey("hits") ?? 0;
      const r = statByKey("runs") ?? 0;
      const rbi = statByKey("RBIs") ?? 0;
      current = h + r + rbi;
      label = `${h}H ${r}R ${rbi}RBI = ${current}`;
    } else if (prop.stat === "KS") {
      // Could be batter (struck out) or pitcher (strikeouts thrown). Pitcher
      // group gets priority because pitcher KS thresholds are larger.
      if (sg.type === "pitching") {
        current = statByKey("strikeouts");
        label = `K: ${current ?? "-"}`;
      } else if (current == null) {
        current = statByKey("strikeouts");
        label = `K: ${current ?? "-"}`;
      }
    } else if (prop.stat === "IP") {
      current = statByKey("inningsPitched");
      label = `IP: ${current ?? "-"}`;
    }
    if (current != null) break;
  }

  if (current == null) return { current: null, status: "loading" };

  let status;
  if (current >= prop.threshold) {
    // For monotonic stats (hits/runs/RBIs/HR), once you cross the threshold
    // you can't uncross. So even if game is in progress, this is locked dead.
    status = "dead";
  } else if (gameState === "post" || gameState === "final") {
    status = "alive";
  } else {
    status = "alive_pending";  // currently alive but stat could still climb
  }
  return { current, status, label, threshold: prop.threshold };
}

// --------------------------------- render ----------------------------------

function render() {
  renderSummary();
  renderParlays();
}

function renderSummary() {
  const cash = parseFloat(state.balance?.balance || 0) / 100;
  const pv   = parseFloat(state.balance?.portfolio_value || 0) / 100;
  const totalCost   = state.positions.reduce((s, p) => s + p.cost, 0);
  const maxProfit   = state.positions.reduce((s, p) => s + p.max_profit, 0);

  // Aggregate live expected P&L from per-parlay implied probabilities.
  // Independence within each parlay; parlays-across summed.
  let evTotal = 0, evMissing = 0;
  for (const p of state.positions) {
    const probs = computeParlayProbabilities(p);
    if (probs.expectedPnl == null) evMissing++;
    else evTotal += probs.expectedPnl;
  }
  const evNote = evMissing > 0 ? ` <small>(${evMissing} missing odds)</small>` : "";
  const roiPct = totalCost > 0 ? (evTotal / totalCost * 100) : null;

  $("summary").innerHTML = `
    <div class="kpi"><div class="label">cash</div><div class="value">${fmtMoney(cash)}</div></div>
    <div class="kpi"><div class="label">portfolio value</div><div class="value">${fmtMoney(pv)}</div></div>
    <div class="kpi"><div class="label">parlays open</div><div class="value">${state.positions.length}</div></div>
    <div class="kpi"><div class="label">cost paid</div><div class="value">${fmtMoney(totalCost)}</div></div>
    <div class="kpi"><div class="label">expected current outcome${evNote}</div><div class="value ${pnlClass(evTotal)}">${fmtMoney(evTotal)}</div></div>
    <div class="kpi"><div class="label">current ROI</div><div class="value ${pnlClass(roiPct)}">${roiPct != null ? roiPct.toFixed(0) + "%" : "—"}</div></div>
    <div class="kpi"><div class="label">max gross profit</div><div class="value pos">+${maxProfit.toFixed(2)}</div></div>
  `;
}

function renderParlays() {
  const wrap = $("parlays");
  if (!state.positions.length) {
    wrap.innerHTML = `<div class="empty">no open positions</div>`;
    return;
  }
  const cards = [...state.positions]
    .sort((a, b) => b.cost - a.cost)
    .map((p, i) => renderParlayCard(p, i + 1));
  wrap.innerHTML = cards.join("");
}

/**
 * Resolution status for a given leg, FROM OUR PERSPECTIVE (long NO):
 *   alive          - we're currently winning this leg
 *   alive_pending  - currently winning but the stat could climb (in-progress prop)
 *   dead           - permanently locked against us
 *   pending        - game not started
 *   loading        - game live but boxscore not loaded yet / stat unknown
 */
function legResolutionForUs(leg, scoreboards, boxscores) {
  const t = leg.ticker;
  const ev = findEspnEvent(legGameKey(t), scoreboards);
  if (!ev) return { status: "pending", label: "scheduled" };
  const status = ev?.status?.type || {};
  const competitors = ev?.competitions?.[0]?.competitors || [];
  const liveLabel = status.shortDetail || status.description || status.state || "";

  // Player props
  const prop = parsePlayerProp(t);
  if (prop) {
    const r = resolvePlayerProp(prop, scoreboards, boxscores);
    // The buyer took YES (current >= threshold wins for them).
    // We win NO when current < threshold at game end.
    let usStatus;
    if (r.status === "dead")          usStatus = "dead";
    else if (r.status === "alive")    usStatus = "alive";
    else if (r.status === "alive_pending") usStatus = "alive_pending";
    else usStatus = r.status === "loading" ? "loading" : "pending";
    return {
      status: usStatus,
      live: liveLabel,
      stat: r.label,
      current: r.current,
      threshold: r.threshold,
    };
  }

  // Game outcome / total / spread legs — flip relative to leg.side
  const buyerSide = (leg.side || "yes").toLowerCase();
  if (status.state === "post") {
    const winner = competitors.find((c) => c?.winner === true);
    const winnerAbbr = (winner?.team?.abbreviation || "").toUpperCase();
    const winnerLast = (winner?.athlete?.displayName || "").trim().split(/\s+/).pop().slice(0, 3).toUpperCase();
    if (t.startsWith("KXMLBGAME-") || t.startsWith("KXNHLGAME-") || t.startsWith("KXNBAGAME-")) {
      const pickAbbr = t.split("-").pop().toUpperCase();
      const yesHits = pickAbbr === winnerAbbr;
      const buyerWins = (buyerSide === "yes") ? yesHits : !yesHits;
      return { status: buyerWins ? "dead" : "alive", live: liveLabel,
               stat: scoreLine(competitors) };
    }
    if (t.startsWith("KXATPMATCH-") || t.startsWith("KXWTAMATCH-") || t.startsWith("KXUFCFIGHT-")) {
      const pickAbbr = t.split("-").pop().toUpperCase();
      const yesHits = pickAbbr === winnerLast;
      const buyerWins = (buyerSide === "yes") ? yesHits : !yesHits;
      return { status: buyerWins ? "dead" : "alive", live: liveLabel,
               stat: scoreLine(competitors) };
    }
    if (t.startsWith("KXMLBTOTAL-") || t.startsWith("KXNHLTOTAL-") || t.startsWith("KXNBATOTAL-")) {
      const totalScore = competitors.reduce((s, c) => s + parseInt(c?.score || "0", 10), 0);
      const m = t.match(/-(\d+)$/);
      if (m) {
        const threshold = parseInt(m[1], 10);
        const yesHits = totalScore > threshold;
        const buyerWins = (buyerSide === "yes") ? yesHits : !yesHits;
        return { status: buyerWins ? "dead" : "alive", live: liveLabel,
                 stat: `total ${totalScore} vs ${threshold}` };
      }
    }
  }

  // In-progress game / total
  if (status.state === "in") {
    if (t.startsWith("KXMLBTOTAL-") || t.startsWith("KXNHLTOTAL-") || t.startsWith("KXNBATOTAL-")) {
      const totalScore = competitors.reduce((s, c) => s + parseInt(c?.score || "0", 10), 0);
      const m = t.match(/-(\d+)$/);
      if (m) {
        const threshold = parseInt(m[1], 10);
        // OVER irreversibly hits the moment total > threshold; UNDER only
        // resolves at game end. So mid-game we can only LOCK in the OVER side.
        const overLocked = totalScore > threshold;
        if (overLocked) {
          // OVER is irreversibly won → buyer-yes wins (we dead), buyer-no loses (we alive)
          if (buyerSide === "yes") {
            return { status: "dead", live: liveLabel, stat: `total ${totalScore} > ${threshold}` };
          }
          return { status: "alive", live: liveLabel, stat: `total ${totalScore} > ${threshold}` };
        }
        // total still ≤ threshold → not yet locked either way
        return { status: "alive_pending", live: liveLabel, stat: `total ${totalScore} of ${threshold}` };
      }
    }
    return { status: "alive_pending", live: liveLabel, stat: scoreLine(competitors) };
  }

  return { status: "pending", live: liveLabel, stat: "" };
}

function scoreLine(competitors) {
  return competitors
    .map((c) => `${c?.team?.abbreviation || c?.athlete?.displayName?.split(" ").pop() || "?"} ${c?.score ?? ""}`)
    .join(" · ");
}

function pBuyerWinsLeg(leg, legMid, res) {
  // Probability the BUYER's side hits on this leg.
  //   - alive (locked our way) → 0
  //   - dead (locked their way) → 1
  //   - else → 1 - (our_mid / 100)  (Kalshi's market view of the OPPOSITE side)
  //   - last resort: fall back to fill-time leg.p (was the runner's
  //     independence-multiplied fair at quote time)
  if (res.status === "alive") return 0;
  if (res.status === "dead") return 1;
  if (legMid?.midC != null) return 1 - legMid.midC / 100;
  if (leg.p != null) return Number(leg.p);
  return null;
}

/**
 * Treat a Kalshi leg as effectively resolved when its market is pinned to the
 * 1¢ / 99¢ wall. This catches player-prop legs and other markets that ESPN
 * doesn't directly resolve for us.
 */
const MARKET_WALL_LO = 1.5;   // our_mid ≤ this → effectively dead
const MARKET_WALL_HI = 98.5;  // our_mid ≥ this → effectively alive

function effectiveStatus(res, legMid) {
  if (res.status === "alive" || res.status === "dead") return res.status;
  if (legMid?.midC != null) {
    if (legMid.midC <= MARKET_WALL_LO) return "dead";
    if (legMid.midC >= MARKET_WALL_HI) return "alive";
  }
  return res.status;
}

function computeParlayProbabilities(p) {
  // Returns { pWin, pLose, expectedPnl, breakdownLegs:[{p_buyer, p_us, eff}], unknown:bool }
  let pLose = 1.0;
  let unknown = false;
  const breakdown = [];
  for (const leg of p.legs) {
    const lm = p.legMids[leg.ticker] || {};
    const res = legResolutionForUs(leg, state.scoreboards, state.boxscores);
    const eff = effectiveStatus(res, lm);
    // Promote market-implied resolution into the prob so locked legs short-circuit
    const resForProb = eff !== res.status
      ? { ...res, status: eff }
      : res;
    const pb = pBuyerWinsLeg(leg, lm, resForProb);
    if (pb == null) { unknown = true; }
    else { pLose *= pb; }
    breakdown.push({ p_buyer: pb, p_us: pb == null ? null : 1 - pb, res, eff, leg });
  }
  if (unknown || p.legs.length === 0) {
    return { pWin: null, pLose: null, expectedPnl: null, unknown: true, breakdown };
  }
  const pWin = 1 - pLose;
  const expectedPnl = pWin * p.max_profit - pLose * p.cost;
  return { pWin, pLose, expectedPnl, unknown: false, breakdown };
}

function renderParlayCard(p, n) {
  let aliveLegs = 0, deadLegs = 0, pendingLegs = 0;
  const probs = computeParlayProbabilities(p);

  const legHtml = p.legs.map((leg, i) => {
    const res = legResolutionForUs(leg, state.scoreboards, state.boxscores);
    const ourSide = flipSide(leg.side);
    const desc = legLabel(leg.ticker, ourSide, state.athleteIdx);
    const lm = p.legMids[leg.ticker] || {};
    const eff = probs.breakdown[i]?.eff || res.status;
    const pUsThisLeg = probs.breakdown[i]?.p_us;
    // Did the market wall (not ESPN) resolve this leg?
    const marketImplied = eff !== res.status && (eff === "alive" || eff === "dead");

    let cls = "", check = "";
    if (eff === "alive") { aliveLegs++; cls = "alive"; check = "✓"; }
    else if (eff === "dead") { deadLegs++; cls = "dead"; check = "✗"; }
    else if (eff === "alive_pending") { pendingLegs++; cls = "partial"; }

    // Single combined probability cell. When the market wall (not ESPN) pinned
    // the leg we tag with "(market)" so it's clear the resolution is implied.
    let probHtml;
    if (eff === "alive")          probHtml = `<span class="v pos">WON${marketImplied ? " (market)" : ""}</span>`;
    else if (eff === "dead")      probHtml = `<span class="v neg">LOST${marketImplied ? " (market)" : ""}</span>`;
    else if (pUsThisLeg != null)  probHtml = `<span class="k">Win chance</span> <span class="v">${(pUsThisLeg*100).toFixed(0)}%</span>`;
    else                          probHtml = `<span class="k">Win chance</span> <span class="v">—</span>`;

    const liveText = res.live || "";
    const liveCls = res.status === "alive_pending" ? "in"
                   : res.status === "alive" ? "post"
                   : res.status === "dead" ? "post" : "";
    const statText = res.stat || "";

    const { sport, teams: logoTeams } = legTeams(leg.ticker);
    const logoHtml = logoTeams.map(abbr =>
      `<img class="team-logo" src="${teamLogoUrl(sport, abbr)}" alt="${escapeHtml(abbr)}" onerror="this.style.display='none'">`
    ).join("");

    return `<div class="leg ${cls}">
      <div class="desc">
        ${logoHtml}
        <span>${escapeHtml(desc)}</span>
        ${check ? `<span class="check">${check}</span>` : ""}
      </div>
      <div class="meta">
        ${probHtml}
        ${liveText ? `<span class="live-state ${liveCls}">${escapeHtml(liveText)}</span>` : ""}
        ${statText ? `<span class="v">${escapeHtml(statText)}</span>` : ""}
      </div>
    </div>`;
  }).join("") || `<div class="leg"><div class="desc">legs unavailable</div></div>`;

  let cardBadge = "open", cardBadgeCls = "";
  if (p.legs.length > 0) {
    if (aliveLegs > 0) {
      // Any single leg we've locked → parlay can't lose anymore.
      cardBadge = "WINNING"; cardBadgeCls = "alive";
    } else if (deadLegs === p.legs.length) {
      cardBadge = "LOST"; cardBadgeCls = "dead";
    } else if (deadLegs > 0) {
      // Some legs locked against us, others still TBD. We need ANY remaining
      // leg to break (turn alive) for us to win.
      cardBadge = "AT RISK"; cardBadgeCls = "dead";
    } else if (pendingLegs > 0) {
      cardBadge = "in play"; cardBadgeCls = "partial";
    }
  }

  const unrealHtml = p.unreal != null
    ? `<div class="col"><div class="lbl">Parlay MTM</div><div class="val ${pnlClass(p.unreal)}">${fmtMoney(p.unreal)}</div></div>`
    : "";
  const pWinHtml = probs.pWin != null
    ? `<div class="col"><div class="lbl">Win chance</div><div class="val">${(probs.pWin*100).toFixed(0)}%</div></div>`
    : "";
  const evHtml = probs.expectedPnl != null
    ? `<div class="col"><div class="lbl">Expected current outcome</div><div class="val ${pnlClass(probs.expectedPnl)}">${fmtMoney(probs.expectedPnl)}</div></div>`
    : "";
  const roiHtml = (probs.expectedPnl != null && p.cost > 0)
    ? `<div class="col"><div class="lbl">Current ROI</div><div class="val ${pnlClass(probs.expectedPnl)}">${(probs.expectedPnl/p.cost*100).toFixed(0)}%</div></div>`
    : "";

  return `<div class="parlay">
    <div class="head">
      <div class="top">
        <span class="badge ${cardBadgeCls}">#${n} · ${cardBadge}</span>
        <span class="source">${escapeHtml(p.source || "—")}</span>
      </div>
      <div class="stake">
        <div class="col"><div class="lbl">Risk</div><div class="val">${fmtMoney(p.cost)}</div></div>
        <div class="col"><div class="lbl">To win</div><div class="val pos">+${p.max_profit.toFixed(2)}</div></div>
        ${pWinHtml}
        ${evHtml}
        ${roiHtml}
        ${unrealHtml}
      </div>
    </div>
    <div class="legs">${legHtml}</div>
  </div>`;
}

// ------------------------------- controls ----------------------------------

$("refresh-btn").addEventListener("click", () => refresh());
$("auto-toggle").addEventListener("change", (e) => {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (e.target.checked) {
    const ms = parseInt($("auto-interval").value, 10) * 1000;
    autoTimer = setInterval(() => refresh(), ms);
  }
});
$("auto-interval").addEventListener("change", () => {
  if ($("auto-toggle").checked) {
    if (autoTimer) clearInterval(autoTimer);
    const ms = parseInt($("auto-interval").value, 10) * 1000;
    autoTimer = setInterval(() => refresh(), ms);
  }
});

refresh();
