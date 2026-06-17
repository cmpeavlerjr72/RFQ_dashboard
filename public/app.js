// Kalshi RFQ dashboard — bet-slip view, NO perspective.
// We hold NO on every parlay, so each leg is rendered as the OPPOSITE of what
// the buyer took, with NO-side odds. Manual-refresh by default.

import { legLabel, legTeams, teamLogoUrl, legGameKey, legDateLabel, findEspnEvent, parsePlayerProp, setLogoContext } from "/labels.js";
import { buildAthleteIndex, buildAthleteFlagIndex, isExcludedTicker,
         allCompetitions, athleteCodeCandidates,
         NHL_TEAMS, MLB_TEAMS, NBA_TEAMS, SOCCER_TEAMS } from "/teams.js";
import { NATIONAL_TEAMS } from "/national_teams.js";
import { teamBarColors } from "/team_colors.js";
import { initAccountPicker, withAccount } from "/account.js";

const $ = (id) => document.getElementById(id);

// Global crash reporter — historically the Live page would die silently on
// iOS Safari (heavy page / unhandled throw in render) leaving a blank screen
// with nothing logged. Surface any uncaught error/rejection as a dismissible
// banner so it can be read/screenshotted on devices we can't debug directly.
function showCrashBanner(label, err) {
  try {
    const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
    let bar = $("crash-banner");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "crash-banner";
      bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9999;" +
        "background:#7f1d1d;color:#fff;font:12px/1.4 ui-monospace,monospace;" +
        "padding:8px 12px;white-space:pre-wrap;max-height:40vh;overflow:auto;" +
        "box-shadow:0 -2px 8px rgba(0,0,0,.4)";
      bar.addEventListener("click", () => bar.remove());
      document.body.appendChild(bar);
    }
    bar.textContent = `⚠️ ${label}: ${msg}\n(tap to dismiss)`;
  } catch (_) { /* never let the reporter itself throw */ }
}
window.addEventListener("error", (e) => showCrashBanner("error", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => showCrashBanner("promise", e.reason));

const state = {
  balance: null,
  positions: [],          // each = full parlay record
  fillsByParlay: {},
  // EVERY fill row from /api/fills (real contracts only), in file order. Each
  // row carries ts + legs(+sides+fill-time probs) + contracts + cost, which is
  // exactly enough to rebuild the book "as of" any moment — feeds the risk-grid
  // fill scrubber (2026-06-12). fillsByParlay above keeps only the latest row
  // per ticker and stays as-is for the per-position fill-time stamp.
  fillRows: [],
  // gameGroupKey -> scrubber position (fill index 1..N). Absent/null = "now"
  // (live grid, default). Survives the periodic re-render.
  gridScrub: {},
  // gameKey -> risk-grid view mode: "prob" (cell odds) or "ev" (P&L x odds =
  // contribution to expected $). Absent = "pnl", the default $ view.
  // Soccer score grids only (the $/%/$x% toggle, 2026-06-12).
  gridView: {},
  scoreboards: {},        // sport:date -> ESPN scoreboard payload
  // ML event ticker (KXWCGAME-…, KXINTLFRIENDLYGAME-…) -> ISO kickoff, from
  // Kalshi's milestone feed (/api/start-times). Used to show a kickoff time on
  // soccer cards ESPN doesn't cover (lower-tier international friendlies).
  soccerStarts: {},
  // ML event ticker -> {home, away, statusText, half, winner, matchStatus} from
  // Kalshi /live_data. Live/final scores for soccer games ESPN doesn't cover.
  soccerScores: {},
  // gameGroupKey -> projected FINAL total from the Kalshi total ladder (the
  // strike closest to 50/50 right now). Null when the live ladder isn't priced
  // (risk-grid then falls back to a pace-blend projection). Live games only.
  proj50ByGame: {},
  boxscores: {},          // sport:eventId -> ESPN summary payload
  rosters: {},            // sport:teamId -> ESPN /teams/{id}/roster payload
  // Flat index keyed by "{sport}:{kalshi-abbr}:{LASTNAME}" -> {displayName,
  // headshot, jersey, position}. Populated from rosters so we can render
  // headshots PREGAME (boxscore.players is empty before tipoff/first pitch).
  athletesByKey: {},
  athleteIdx: {},
  lastRefreshAt: null,
  apiCallsThisSession: 0,
  fetching: false,
  // --- Games On The Board section state ---
  // Tracks the game keys (legGameGroupKey) that the user has EXPANDED.
  // Default empty -> every card starts collapsed; click a head to drill in.
  gameExpanded: new Set(),
  // --- Open Parlays section state ---
  parlaySortCol: "cost",   // 'cost' | 'maxWin' | 'pWin' | 'evPnl' | 'roi'
  parlaySortDir: "desc",   // 'asc' | 'desc'
  parlayExpanded: new Set(), // tickers currently expanded; default = none
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

// Fill timestamp → short local "MMM D, h:mm:ss am/pm" for the parlay card.
// Uses the fill epoch seconds (preferred) or the ISO string.
function fmtFillTs(p) {
  const d = (typeof p.fillTs === "number")
    ? new Date(p.fillTs * 1000)
    : (p.fillIso ? new Date(p.fillIso) : null);
  if (!d || isNaN(d.getTime())) return null;
  return d.toLocaleString([], {
    month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit",
  });
}
function pnlClass(n) {
  if (n == null || n === 0) return "";
  return n > 0 ? "pos" : "neg";
}
async function api(path, opts = {}) {
  state.apiCallsThisSession++;
  // Route same-origin API calls through the active account. ESPN endpoints
  // ignore the extra ?account= param harmlessly; Kalshi endpoints need it.
  const url = path.startsWith("/api/") ? withAccount(path) : path;
  const r = await fetch(url, opts);
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
  // Soccer — per-league sport codes (each maps to its own ESPN slug
  // server-side). Enables game cards + live score/clock tracking. Game-level
  // only (ML/spread/total/BTTS); soccer has no player props in our universe.
  KXEPL: "epl", KXLALIGA: "laliga", KXSERIEA: "seriea",
  KXBUNDESLIGA: "bundesliga", KXLIGUE1: "ligue1", KXUCL: "ucl",
  // National-team soccer (flags, not crests). KXWC covers WC ML/spread/total/
  // BTTS/1H; KXINTLFRIENDLY the friendlies. Added 2026-06-04.
  KXWC: "wcup", KXINTLFRIENDLY: "intlfriendly",
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
    const [bal, pos, fills, starts, momentum] = await Promise.all([
      api("/api/kalshi/balance"),
      api("/api/kalshi/positions"),
      api("/api/fills"),
      // soccer kickoff times (Kalshi milestone feed) — defensive: a failure here
      // must never break the dashboard, so fall back to an empty map.
      api("/api/start-times").catch(() => ({ starts: {} })),
      // Live FotMob match-momentum (account-independent; non-fatal).
      fetch("/api/momentum").then((r) => r.json()).catch(() => ({ games: {} })),
    ]);

    state.soccerStarts = (starts && starts.starts) || {};
    state.soccerScores = (starts && starts.scores) || {};
    state.momentum = (momentum && momentum.games) || {};
    state.balance = bal;
    state.fillsByParlay = {};
    for (const f of (fills.fills || [])) {
      if (f.parlay_ticker) state.fillsByParlay[f.parlay_ticker] = f;
    }
    // Full per-fill history for the grid scrubber: drop phantom rows (0
    // contracts = 204-ack that never delivered) and legless rows.
    state.fillRows = (fills.fills || []).filter(
      (f) => (Number(f.contracts) || 0) > 0 && Array.isArray(f.legs) && f.legs.length
             && typeof f.ts === "number",
    );

    // Separate excluded positions (non-sports tickers) so we can still
    // subtract their current value from the displayed portfolio total —
    // Kalshi's balance.portfolio_value counts EVERY position. Without the
    // adjustment, "portfolio value" on the dashboard would include the
    // hidden GA-01 contracts.
    const allNonZero = (pos.market_positions || []).filter(
      (p) => parseFloat(p.position_fp || "0") !== 0,
    );
    const excludedPositions = allNonZero.filter((p) => isExcludedTicker(p.ticker));
    state.excludedPortfolioValue = await computeExcludedPortfolioValue(excludedPositions);

    const mp = allNonZero.filter((p) => !isExcludedTicker(p.ticker));
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
        fillTs: typeof f.ts === "number" ? f.ts : null,
        fillIso: f.ts_iso || null,
        // Correlation ratio the runner priced at fill time (yes_prob_adj /
        // yes_prob, 2026-06-11). Per-leg displays multiply independently,
        // which misstates correlated parlays — e.g. a negatively-correlated
        // ML+Under (ratio <1) looked -EV from the jump. Folded into
        // _treeNodeExpected + computeParlayProbabilities as a cosmetic
        // first-order correction; null when the fill predates the field.
        corrRatio: (typeof f.yes_prob_adj === "number" && typeof f.yes_prob === "number"
                    && f.yes_prob > 0 && f.yes_prob_adj > 0)
          ? f.yes_prob_adj / f.yes_prob : null,
        midC: null, unreal: null,
        legMids: {},
      };
    });

    await enrichMissingLegs();

    // Fold positions that hold the EXACT same legs into one logical parlay
    // (legs are known now). Must run before the price/legMid loop so the merged
    // position gets its mids computed once.
    state.positions = mergeIdenticalParlays(state.positions);

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
        // Record each market's authoritative line (floor_strike) so netting +
        // labels use the REAL line, not a league-dependent ticker-integer guess.
        for (const [tk, v] of Object.entries(part)) {
          const fs = v?.market?.floor_strike;
          if (typeof fs === "number") _floorStrikeByTicker[tk] = fs;
        }
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
          // Mid preference order:
          //   1. Tight two-sided quote (both off walls): exact bid/ask midpoint
          //   2. WIDE two-sided quote (bid > 0, ask at wall e.g. 100): still
          //      use midpoint — beats falling back to a stale "bid only"
          //      reading on illiquid late-game prop markets where bid=1c
          //      lingers from morning and last_price is just as stale.
          //   3. last_price (flipped for our side) as a recency signal
          //   4. one-sided book heuristics
          const haveTrueQuote =
            bidC != null && askC != null && bidC > 0 && askC > 0 && askC < 100;
          const haveWideQuote =
            bidC != null && askC != null && bidC > 0 && askC > 0;
          let midC = null;
          if (haveTrueQuote) {
            midC = (bidC + askC) / 2;
          } else if (haveWideQuote) {
            midC = (bidC + askC) / 2;   // wall-ask case: still beats bidC alone
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
    setLogoContext({ playerFlagIdx: buildAthleteFlagIndex(state.scoreboards) });

    // For player props, pull the boxscore for each game we have a prop on,
    // plus the team roster (boxscore is empty pregame; roster gives us
    // headshots/jerseys/positions so the player cards render before tipoff).
    // Live total-ladder projections run alongside (needs scoreboards above to
    // know which games are live; never blocks the other two if it fails).
    await Promise.all([fetchNeededBoxscores(), fetchNeededRosters(),
      fetchLiveTotalProjections().catch((e) => console.warn("total proj fetch failed", e))]);

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
  // Each recover call fans out up to 4 sequential Kalshi requests, so cap
  // concurrency to avoid 429s. Successful results are cached on the server.
  const noRfqId = state.positions.filter((p) => !p.rfq_id && p.legs.length === 0);
  const CONCURRENCY = 3;
  let cursor = 0;
  async function recoverWorker() {
    while (cursor < noRfqId.length) {
      const idx = cursor++;
      const p = noRfqId[idx];
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
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, noRfqId.length) }, recoverWorker),
  );
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
  // NHL & NBA game cards need the /summary even when we hold only game-level
  // legs (no player props): the goalie/shooting lines, penalty/team stats, and
  // rink/court shot plot all come from the boxscore + play-by-play.
  for (const p of state.positions) {
    for (const leg of p.legs) {
      const gl = parseGameLevelLeg(leg.ticker);
      if (!gl || (gl.sport !== "nhl" && gl.sport !== "nba"
                  && !_SOCCER_TREE_SPORTS.has(gl.sport))) continue;
      const ev = findEspnEventForGameKey(legGameGroupKey(leg.ticker));
      const eventId = String(ev?.id || "");
      if (eventId) need.set(`${gl.sport}:${eventId}`, { sport: gl.sport, eventId });
    }
  }
  await Promise.all([...need.values()].map(async ({ sport, eventId }) => {
    try {
      const r = await api(`/api/boxscore?sport=${sport}&eventId=${eventId}`);
      state.boxscores[`${sport}:${eventId}`] = r.payload;
    } catch (e) { console.warn("boxscore fetch failed", sport, eventId, e); }
  }));
}

/** Resolve a Kalshi (sport, team-abbr) to its ESPN numeric team id by
 *  matching against the scoreboard event's competitors. Returns null if no
 *  match — typically because the scoreboard hasn't loaded yet for this sport. */
function findEspnTeamId(prop) {
  const ev = findEspnEvent(prop.gameKey, state.scoreboards);
  const comps = ev?.competitions?.[0]?.competitors || [];
  for (const c of comps) {
    const abbr = normAbbrForKalshi((c?.team?.abbreviation || "").toUpperCase(), prop.sport);
    if (abbr === (prop.team || "").toUpperCase()) {
      return c?.team?.id || null;
    }
  }
  return null;
}

async function fetchNeededRosters() {
  // For every player-prop leg we hold, identify the (sport, ESPN teamId)
  // pair and pull the team's roster. Server-side TTL is an hour so refresh
  // cost is near-zero after the first fetch.
  const need = new Map();   // "sport:teamId" -> {sport, teamId, abbr}
  for (const p of state.positions) {
    for (const leg of p.legs) {
      const prop = parsePlayerProp(leg.ticker);
      if (!prop) continue;
      const teamId = findEspnTeamId(prop);
      if (!teamId) continue;
      const k = `${prop.sport}:${teamId}`;
      if (!need.has(k)) need.set(k, { sport: prop.sport, teamId, abbr: prop.team });
    }
  }
  await Promise.all([...need.values()].map(async ({ sport, teamId }) => {
    try {
      const r = await api(`/api/roster?sport=${sport}&teamId=${encodeURIComponent(teamId)}`);
      state.rosters[`${sport}:${teamId}`] = r.payload;
    } catch (e) { console.warn("roster fetch failed", sport, teamId, e); }
  }));
  // Build the athlete index. ESPN's NBA/MLB/NHL roster response is
  // {athletes: [...]} where elements are either flat athlete records or
  // position-grouped {items: [...]} containers — flatten both.
  state.athletesByKey = {};
  for (const [key, payload] of Object.entries(state.rosters)) {
    const [sport] = key.split(":");
    const teamAbbr = normAbbrForKalshi(
      (payload?.team?.abbreviation || "").toUpperCase(),
      sport,
    );
    if (!teamAbbr) continue;
    const top = payload?.athletes || [];
    const flat = top.flatMap((x) => (Array.isArray(x.items) ? x.items : [x]));
    for (const a of flat) {
      const dn = (a?.displayName || a?.fullName || `${a?.firstName || ""} ${a?.lastName || ""}`.trim());
      const last = normLast(a?.lastName || lastNameFromDisplay(dn));
      if (!last) continue;
      state.athletesByKey[`${sport}:${teamAbbr}:${last}`] = {
        displayName: dn || last,
        headshot: a?.headshot?.href || null,
        jersey: a?.jersey || null,
        position: a?.position?.abbreviation || a?.position?.name || null,
      };
    }
  }
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
  // Pregame: ESPN's /summary can populate season-to-date stats in the
  // boxscore.players[] block before first pitch. Those would falsely
  // resolve a u3 HRR leg as "lost" with 52H/29RBI. Return pending here
  // so the chip stays grey until the game actually starts.
  if (gameState === "pre") return { current: null, status: "pending" };

  const players = box?.boxscore?.players || [];
  const teamGroup = players.find(
    (g) => normAbbrForKalshi((g?.team?.abbreviation || "").toUpperCase(), prop.sport)
      === prop.team.toUpperCase(),
  );
  if (!teamGroup) return { current: null, status: "loading" };

  // Find the player in any stat group whose last name matches.
  let current = null;
  let label = "";
  // A player who's out of the game can't add to his stat (locks an under
  // before the game ends): ESPN flags him active:false in the box once he's
  // subbed out / pulled. (Belt-and-suspenders: also treat a pitcher as done
  // when his team has since used a later pitcher.)
  let playerOut = false;
  let pitcherRelieved = false;
  const propLast = normLast(prop.lastName);
  for (const sg of teamGroup.statistics || []) {
    const keys = sg.keys || [];
    const aths = sg.athletes || [];
    const ath = aths.find((a) => {
      const nm = (a?.athlete?.displayName || "").trim();
      return normLast(a?.athlete?.lastName || lastNameFromDisplay(nm)) === propLast;
    });
    if (!ath) continue;
    if (ath.active === false) playerOut = true;
    if (sg.type === "pitching" && aths.indexOf(ath) < aths.length - 1) pitcherRelieved = true;
    const stats = ath.stats || [];

    function statByKey(key) {
      const idx = keys.indexOf(key);
      if (idx < 0) return null;
      const v = stats[idx];
      if (v == null) return null;
      const f = parseFloat(v);
      return isFinite(f) ? f : null;
    }

    if (prop.sport === "nhl") {
      // NHL skater box keys: goals, assists (no "points" key — compute it).
      // FIRSTGOAL needs scoring-play parsing — left null (stays pending).
      if (prop.stat === "GOAL") {
        current = statByKey("goals");
        label = `G: ${current ?? "-"}`;
      } else if (prop.stat === "AST") {
        current = statByKey("assists");
        label = `A: ${current ?? "-"}`;
      } else if (prop.stat === "PTS") {
        const g = statByKey("goals");
        const a = statByKey("assists");
        if (g != null || a != null) {
          current = (g ?? 0) + (a ?? 0);
          label = `${g ?? 0}G ${a ?? 0}A = ${current}`;
        }
      }
    } else if (prop.stat === "HR") {
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
      // ESPN's compact batting box doesn't carry doubles/triples in
      // its keys, but the athlete's stats line includes an atBats[]
      // array of play-IDs that resolve into box.plays[]. We sum TB
      // exactly by classifying each at-bat's text:
      //   singled / doubled / tripled / homered (or "home run")
      // Walks, K's, outs contribute 0. Fall back to hits + 3*HR
      // lower bound if box.plays isn't populated yet.
      const h = statByKey("hits");
      const hr = statByKey("homeRuns") ?? 0;
      if (h != null) {
        const playIds = new Set(
          (ath.atBats || [])
            .map((ab) => ab?.playId || ab?.id)
            .filter(Boolean),
        );
        const plays = box?.plays || [];
        let exactTB = null;
        if (playIds.size > 0 && plays.length > 0) {
          let tb = 0;
          let matched = 0;
          for (const p of plays) {
            if (!playIds.has(p.id) && !playIds.has(p.playId)) continue;
            matched++;
            const t = (p.text || "").toLowerCase();
            if (t.includes("home run") || t.includes("homered")) tb += 4;
            else if (t.includes("tripled")) tb += 3;
            else if (t.includes("doubled")) tb += 2;
            else if (t.includes("singled")) tb += 1;
            // Walks, outs, K's, HBP -> 0 TB.
          }
          if (matched === playIds.size) exactTB = tb;
        }
        if (exactTB != null) {
          current = exactTB;
          label = `TB: ${current}`;
        } else {
          // Fall back to the safe lower bound when we can't resolve plays
          // (early in-game before play log populates, or play-id miss).
          current = h + 3 * hr;
          label = `TB ≥ ${current}`;
        }
      }
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
    } else if (prop.stat === "PTS") {
      current = statByKey("points") ?? statByKey("PTS");
      label = `PTS: ${current ?? "-"}`;
    } else if (prop.stat === "REB") {
      current = statByKey("rebounds") ?? statByKey("REB");
      label = `REB: ${current ?? "-"}`;
    } else if (prop.stat === "AST") {
      current = statByKey("assists") ?? statByKey("AST");
      label = `AST: ${current ?? "-"}`;
    } else if (prop.stat === "3PT") {
      // ESPN NBA stores 3PT as "made-attempted" (string like "3-7") under
      // either "threePointFieldGoalsMade-threePointFieldGoalsAttempted" or
      // the short "3PT" key. Take the first integer.
      const long = "threePointFieldGoalsMade-threePointFieldGoalsAttempted";
      const idxLong = (keys || []).indexOf(long);
      const idxShort = (keys || []).indexOf("3PT");
      const raw = idxLong >= 0 ? stats[idxLong] : idxShort >= 0 ? stats[idxShort] : null;
      if (raw != null) {
        const made = parseInt(String(raw).split("-")[0], 10);
        if (Number.isFinite(made)) current = made;
      }
      label = `3PT: ${current ?? "-"}`;
    } else if (prop.stat === "STL") {
      current = statByKey("steals") ?? statByKey("STL");
      label = `STL: ${current ?? "-"}`;
    } else if (prop.stat === "BLK") {
      current = statByKey("blocks") ?? statByKey("BLK");
      label = `BLK: ${current ?? "-"}`;
    }
    if (current != null) break;
  }

  if (current == null) return { current: null, status: "loading" };

  // The stat can no longer change once the game is over or the player is out
  // (subbed out / pitcher pulled).
  const frozen = gameState === "post" || gameState === "final" || playerOut || pitcherRelieved;
  let status;
  if (current >= prop.threshold) {
    // For monotonic stats (hits/runs/RBIs/HR), once you cross the threshold
    // you can't uncross. So even if game is in progress, this is locked dead.
    status = "dead";
  } else if (frozen) {
    status = "alive";
  } else {
    status = "alive_pending";  // currently alive but stat could still climb
  }
  return { current, status, frozen, label, threshold: prop.threshold };
}

// --------------------------------- render ----------------------------------

function render() {
  renderSummary();
  renderGameCards();
  renderParlays();
}

// Underlying-game group key for a leg ticker — "{sport}|{dateToken}|{teams}".
// Different from labels.js#legGameKey() which adds a sport prefix and isn't
// implemented for NBA; this version works for every sport whose tickers
// follow the standard {DATE}{HHMM?}{TEAMS} chunk layout.
function legGameGroupKey(ticker) {
  const sport = legSport(ticker);
  if (!sport) return null;
  const parts = ticker.split("-");
  if (parts.length < 2) return null;
  const m = parts[1].match(/^(\d{2}[A-Z]{3}\d{2})(\d{4})?([A-Z]+)$/);
  if (!m) return null;
  return `${sport}|${m[1]}|${m[3]}`;
}

// ESPN team-abbr -> Kalshi team-abbr where the two providers diverge.
// Sport-scoped because NBA and MLB Nationals/Wizards both use "WAS"/"WSH"
// in their respective leagues with opposite mapping. MLB source of truth:
// sandbox/build_start_times.py#MLB_CODE. NBA was derived empirically from
// labels.js#TEAM_LOGO_SLUG (Kalshi->ESPN slug) inverted.
const ESPN_TO_KALSHI_ABBR = {
  mlb: {
    CHW: "CWS",   // White Sox
    ARI: "AZ",    // Diamondbacks
    OAK: "ATH",   // Athletics (Kalshi kept ATH after the Sacramento move)
    WAS: "WSH",   // Nationals
  },
  nba: {
    GS: "GSW",    // Warriors
    NO: "NOP",    // Pelicans
    NY: "NYK",    // Knicks
    SA: "SAS",    // Spurs
    UTAH: "UTA",  // Jazz
    WSH: "WAS",   // Wizards (note: inverse of MLB Nationals!)
  },
  // Soccer: ESPN club codes diverge from Kalshi's. Keyed by the per-league
  // sport code (legSport). Add entries as encountered.
  ligue1: { NICE: "NIC", ASSE: "STE" },  // Ligue 1 barrage 2026-05-29
  // National teams: ESPN uses its own 3-letter codes; Kalshi diverges for a few.
  // Without a map entry the card never matches its ESPN event, so it drops to a
  // kickoff-only panel with no flag / country name / record (confirmed live
  // 2026-06-15 on IRN/IRI = IRINZL). Scanned the upcoming fifa.world fixtures
  // for the rest of the divergences. ESPN -> Kalshi:
  //   IRN -> IRI (Iran), ALG -> DZA (Algeria), HAI -> HTI (Haiti)
  wcup: { IRN: "IRI", ALG: "DZA", HAI: "HTI" },
  intlfriendly: { IRN: "IRI", ALG: "DZA", HAI: "HTI" },
};
function normAbbrForKalshi(espnAbbr, sport) {
  if (!espnAbbr) return espnAbbr;
  return ESPN_TO_KALSHI_ABBR[sport]?.[espnAbbr] || espnAbbr;
}
// Player-name normaliser used on both sides of every roster/boxscore
// match. Has to swallow three things Kalshi flattens away:
//   1. Diacritics via NFD decomposition (Acuña -> Acuna, García -> Garcia)
//   2. Non-decomposing Latin letters (Đoković -> Djokovic, Søderling ->
//      Soderling, Björn -> Bjorn) — these can't be NFD'd; we map them.
//   3. Suffix tokens (Jr., Sr., II/III/IV) that ESPN appends but Kalshi's
//      ticker tag doesn't carry.
const NON_LATIN_FLATTEN = {
  "Đ":"D","Ð":"D","Ø":"O","Æ":"AE","Œ":"OE","ß":"SS","Ł":"L","Þ":"TH",
  "đ":"d","ð":"d","ø":"o","æ":"ae","œ":"oe","ł":"l","þ":"th",
};
const NAME_SUFFIX_RE = /\s+(JR|SR|II|III|IV|V)\.?$/;
function normLast(s) {
  if (!s) return "";
  let t = String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
  t = t.split("").map((c) => NON_LATIN_FLATTEN[c] || c).join("");
  t = t.toUpperCase().replace(NAME_SUFFIX_RE, "");
  return t.replace(/[^A-Z]/g, "");
}
// Last-name extraction from a free-form displayName. "Ronald Acuña Jr." -> "Acuña Jr."
// (then normLast strips the suffix). "Shai Gilgeous-Alexander" -> "Gilgeous-Alexander".
// We prefer ESPN's lastName field where present; this is the fallback.
function lastNameFromDisplay(dn) {
  if (!dn) return "";
  const tokens = String(dn).trim().split(/\s+/);
  return tokens.length < 2 ? (tokens[0] || "") : tokens.slice(1).join(" ");
}

// Find the ESPN event for a game-card key, restricted to that game's sport
// scoreboard so a 3-letter abbrev collision across sports can't mis-match.
// Also rejects events whose start is meaningfully before the ticker date —
// without that, an already-completed Game 4 satisfies a Game 5 ticker when
// ESPN hasn't yet posted Game 5 on its scoreboard for tomorrow's date.
function findEspnEventForGameKey(gameKey) {
  const [sport, dateToken, teams] = gameKey.split("|");
  if (!sport || !teams) return null;
  // legDateYMD wants a ticker but the date-token chunk is all it actually
  // parses, so we wrap it into a synthetic ticker prefix.
  const ymd = legDateYMD(`KX-${dateToken}`);
  const tickerMs = ymd
    ? Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`)
    : null;
  // Try the (sport,date) scoreboard first; fall back to any same-sport board
  // (handles ESPN's day-boundary drift on late-night starts).
  const candidates = [];
  if (ymd) candidates.push(state.scoreboards[`${sport}:${ymd}`]);
  for (const [k, sb] of Object.entries(state.scoreboards)) {
    if (k.startsWith(`${sport}:`) && !candidates.includes(sb)) candidates.push(sb);
  }
  // Tennis: ESPN nests individual matches under event.groupings[].competitions[]
  // (the top-level event is the tournament, e.g. "Roland Garros", and its
  // competitions[] is empty). The scoreboard returns the WHOLE tournament, so
  // we match on the player pair — two players meet at most once in a draw, so
  // the pair is unique — and break ties on the competition date nearest the
  // ticker date. Returns a synthetic event whose competitions[0] is the match.
  if (sport === "atp" || sport === "wta") {
    let best = null;
    let bestDelta = Infinity;
    for (const sb of candidates) {
      if (!sb || !Array.isArray(sb.events)) continue;
      for (const ev of sb.events) {
        for (const comp of allCompetitions(ev)) {
          const players = (comp.competitors || [])
            .map((c) => c?.athlete?.displayName || c?.athlete?.fullName || "")
            .filter(Boolean);
          if (players.length < 2) continue;
          const hitA = athleteCodeCandidates(players[0]).find((x) => teams.includes(x));
          const hitB = athleteCodeCandidates(players[1]).find((x) => teams.includes(x));
          if (!hitA || !hitB || hitA === hitB) continue;
          const evMs = Date.parse(comp?.date || ev?.date || "");
          const delta = (tickerMs && Number.isFinite(evMs)) ? Math.abs(evMs - tickerMs) : 0;
          if (delta < bestDelta) {
            bestDelta = delta;
            best = { id: comp.id || ev.id, status: comp.status, competitions: [comp], __tennis: true };
          }
        }
      }
    }
    return best;
  }
  for (const sb of candidates) {
    if (!sb || !Array.isArray(sb.events)) continue;
    for (const ev of sb.events) {
      // Date sanity gate: reject events that start >12h before the ticker
      // date. A Game 4 that ended last night must NOT satisfy a Game 5
      // ticker for tomorrow; the 12h buffer lets us still match a late
      // ET-evening game that crosses into the next UTC day on ESPN.
      if (tickerMs) {
        const evMs = Date.parse(ev?.date || "");
        if (Number.isFinite(evMs) && evMs < tickerMs - 12 * 3600 * 1000) continue;
      }
      const abbrs = (ev?.competitions?.[0]?.competitors || [])
        .map((c) => normAbbrForKalshi((c?.team?.abbreviation || "").toUpperCase(), sport))
        .filter(Boolean);
      if (abbrs.length >= 2 && abbrs.every((a) => teams.includes(a))) return ev;
    }
  }
  return null;
}

// Bucket a game-level leg into a display group ("Moneyline" / "Spread" /
// "Total" / "First 5" / "First 5 spread" / "First 5 total" / "Team total" /
// "Run in 1st" / "Both teams to score" / "First half"). Returns null for
// player-prop and unrecognized tickers — caller routes those into the
// player section instead.
const GAME_LEVEL_GROUP_BY_STAT = {
  GAME: "Moneyline",
  SPREAD: "Spread",
  TOTAL: "Total",
  F5: "First 5 moneyline",
  F5SPREAD: "First 5 spread",
  F5TOTAL: "First 5 total",
  TEAMTOTAL: "Team total",
  RFI: "Run in 1st",
  BTTS: "Both teams to score",
  "1H": "First half",
  FIRST10: "First 10 overs",
};
// Display order within a card — ML first, then spread/total, then sport
// extras. Anything not listed sorts alphabetically at the end.
const GAME_LEVEL_GROUP_ORDER = [
  "Moneyline", "Spread", "Total",
  "First 5 moneyline", "First 5 spread", "First 5 total",
  "Team total", "Run in 1st", "Both teams to score", "First half",
  "First 10 overs",
];
function legGameLevelGroup(ticker) {
  if (!ticker || !ticker.startsWith("KX")) return null;
  // Match "KX{SPORT_PREFIX}{STAT}-..." — sport prefix is the leading word
  // (KXMLB, KXNBA, KXNHL, KXLALIGA, etc.); STAT is what's between that and
  // the first dash. We anchor on the dash to avoid grabbing player blobs.
  const m = ticker.match(/^KX([A-Z0-9]+)-/);
  if (!m) return null;
  const head = m[1];
  // Try every known stat key as a suffix of `head` so we can support both
  // 3-letter sport prefixes (KXMLB+GAME) and longer ones (KXLALIGA+TOTAL).
  for (const stat of Object.keys(GAME_LEVEL_GROUP_BY_STAT)) {
    if (head.endsWith(stat)) return GAME_LEVEL_GROUP_BY_STAT[stat];
  }
  return null;
}

// Pull headshot + jersey + position for a player prop, looking through the
// already-loaded ESPN boxscore. Returns null if the boxscore isn't loaded
// yet (game pregame) or the athlete can't be found by last-name match.
function findAthleteMeta(prop, boxscores) {
  if (!prop) return null;
  // Prefer the boxscore — it's the source of truth once the game starts and
  // matches the stat resolver. Falls back to the per-team roster index
  // (populated by fetchNeededRosters), which works pregame too.
  const ev = findEspnEvent(prop.gameKey, state.scoreboards);
  const eventId = String(ev?.id || "");
  const box = eventId ? boxscores[`${prop.sport}:${eventId}`] : null;
  const players = box?.boxscore?.players || [];
  // Boxscore.players[].team.abbreviation comes from ESPN — alias it before
  // matching the prop's Kalshi abbr.
  const teamGroup = players.find(
    (g) => normAbbrForKalshi((g?.team?.abbreviation || "").toUpperCase(), prop.sport)
      === prop.team.toUpperCase(),
  );
  const propLast = normLast(prop.lastName);
  let boxMeta = null;
  if (teamGroup) {
    for (const sg of teamGroup.statistics || []) {
      for (const a of sg.athletes || []) {
        const nm = (a?.athlete?.displayName || "").trim();
        const last = normLast(a?.athlete?.lastName || lastNameFromDisplay(nm));
        if (last === propLast) {
          boxMeta = {
            displayName: nm,
            headshot: a.athlete?.headshot?.href || null,
            jersey: a.athlete?.jersey || null,
            position: a.athlete?.position?.abbreviation || null,
          };
          break;
        }
      }
      if (boxMeta) break;
    }
  }
  // Roster-index fallback — keyed by (sport, kalshi-abbr, LASTNAME-stripped).
  const k = `${prop.sport}:${(prop.team || "").toUpperCase()}:${propLast}`;
  const rosterMeta = state.athletesByKey?.[k] || null;
  // If boxscore found the player but with no headshot (happens for some
  // bench guys mid-season), borrow the headshot from the roster index.
  if (boxMeta && !boxMeta.headshot && rosterMeta?.headshot) {
    boxMeta.headshot = rosterMeta.headshot;
  }
  return boxMeta || rosterMeta;
}

// ---------- Game-level scenario tracker ------------------------------------
// Parses a leg into a structured game-level predicate, or returns null if it's
// a player prop / not a recognized game-level market. The scenario evaluator
// only needs to evaluate game-level legs deterministically; player legs are
// handled as a best/worst envelope by the caller (we can't predict points).
//
// Returns shapes:
//   {kind:"ml",    sport, teams:[away,home], pick:"SAS"}
//   {kind:"spread", sport, teams, pick:"SAS", threshold:3}   // SAS by >N.5
//   {kind:"total",  sport, teams, threshold:218}             // total >N.5
function parseGameLevelLeg(ticker) {
  const sport = legSport(ticker);
  if (!sport) return null;
  // Generic prefixes that map to spread/ML/total across team sports.
  // Returns sport-specific game-level metadata; player props (ones with a
  // player-blob segment between matchup and threshold) return null below.
  const mGame = ticker.match(/^KX[A-Z0-9]+GAME-(\d{2}[A-Z]{3}\d{2}(?:\d{4})?[A-Z]+)-([A-Z]+)$/);
  if (mGame) {
    const dt = mGame[1];
    const pick = mGame[2];
    const teams = parseTeamsFromChunk(dt, sport);
    if (!teams) return null;
    return { kind: "ml", sport, teams, pick };
  }
  const mSpread = ticker.match(/^KX[A-Z0-9]+SPREAD-(\d{2}[A-Z]{3}\d{2}(?:\d{4})?[A-Z]+)-([A-Z]+)(\d+)$/);
  if (mSpread) {
    const dt = mSpread[1];
    const pick = mSpread[2];
    const threshold = parseInt(mSpread[3], 10);
    const teams = parseTeamsFromChunk(dt, sport);
    if (!teams) return null;
    // `line` = the market's REAL signed cover line (floor_strike; league-aware
    // fallback). Resolution/tree use this, NOT the raw ticker integer, which is
    // a full unit off for NHL/NBA (covers iff margin > line, e.g. NHL 1.5 => ≥2).
    return { kind: "spread", sport, teams, pick, threshold, line: _lineForTicker(ticker, threshold) };
  }
  const mTotal = ticker.match(/^KX[A-Z0-9]+TOTAL-(\d{2}[A-Z]{3}\d{2}(?:\d{4})?[A-Z]+)-(\d+)$/);
  if (mTotal) {
    const dt = mTotal[1];
    const threshold = parseInt(mTotal[2], 10);
    const teams = parseTeamsFromChunk(dt, sport);
    if (!teams) return null;
    // `line` = the market's REAL total line (floor_strike; league-aware fallback).
    // Over iff total > line (e.g. NHL "5" => 5.5 => total ≥ 6), NOT total ≥ N.
    return { kind: "total", sport, teams, threshold, line: _lineForTicker(ticker, threshold) };
  }
  // MLB Run-in-First-Inning. Binary market — yes = a run scored. The team
  // suffix is optional (game-level "any team" is most common).
  const mRfi = ticker.match(/^KX[A-Z0-9]+RFI-(\d{2}[A-Z]{3}\d{2}(?:\d{4})?[A-Z]+)(?:-[A-Z]+)?$/);
  if (mRfi) {
    const teams = parseTeamsFromChunk(mRfi[1], sport);
    if (!teams) return null;
    return { kind: "rfi", sport, teams };
  }
  // Soccer Both-Teams-To-Score. Binary; ticker is KX<LEAGUE>BTTS-<game>-BTTS.
  const mBtts = ticker.match(/^KX[A-Z0-9]+BTTS-(\d{2}[A-Z]{3}\d{2}(?:\d{4})?[A-Z]+)-[A-Z]+$/);
  if (mBtts) {
    const teams = parseTeamsFromChunk(mBtts[1], sport);
    if (!teams) return null;
    return { kind: "btts", sport, teams };
  }
  return null;
}

// For an ML/spread leg, return the team whose perspective the buyer is
// effectively taking. Buyer-YES uses the Kalshi pick directly; buyer-NO
// flips to the opposing team (because "NO on OKC wins" === "YES on SAS
// wins", and "NO on DET by 2+" === "YES on LAA +2 cover"). Falls back to
// parsed.pick if we can't identify the opposing team.
function effectivePick(parsed, buyerSide) {
  const isYes = (buyerSide || "yes").toLowerCase() === "yes";
  if (isYes) return parsed.pick;
  const [a, b] = parsed.teams || [];
  if (!a || !b) return parsed.pick;
  return parsed.pick === a ? b : a;
}

// The team WE are rooting for on a leg. We hold the parlay-NO side, so we
// cheer for the team the buyer is NOT effectively rooting for — i.e., the
// opposite of effectivePick. Used to bucket ML legs (an LAA-NO ML leg
// means we cheer for LAA -> show under LAA, not under DET).
function ourCheeredTeam(parsed, buyerSide) {
  const eff = effectivePick(parsed, buyerSide);
  const [a, b] = parsed.teams || [];
  if (!a || !b) return eff;
  return eff === a ? b : a;
}

// Extract [away,home] team abbrs from a Kalshi event chunk like "26MAY28OKCSAS"
// or "26MAY281310LAADET". We don't currently differentiate which is home —
// we assume the first abbr is the away team (Kalshi's convention).
// Known-abbreviation sets per sport, used to disambiguate the team split.
// Keyed by the sport codes legSport() returns. Soccer leagues all share the
// combined SOCCER_TEAMS table.
const KNOWN_ABBRS = {
  mlb: new Set(Object.keys(MLB_TEAMS)),
  nhl: new Set(Object.keys(NHL_TEAMS)),
  nba: new Set(Object.keys(NBA_TEAMS)),
  epl: new Set(Object.keys(SOCCER_TEAMS)),
  laliga: new Set(Object.keys(SOCCER_TEAMS)),
  seriea: new Set(Object.keys(SOCCER_TEAMS)),
  bundesliga: new Set(Object.keys(SOCCER_TEAMS)),
  ligue1: new Set(Object.keys(SOCCER_TEAMS)),
  ucl: new Set(Object.keys(SOCCER_TEAMS)),
  wcup: new Set(Object.keys(NATIONAL_TEAMS)),
  intlfriendly: new Set(Object.keys(NATIONAL_TEAMS)),
};
function parseTeamsFromChunk(chunk, sport) {
  const m = chunk.match(/^\d{2}[A-Z]{3}\d{2}(?:\d{4})?([A-Z]+)$/);
  if (!m) return null;
  const teams = m[1];
  if (teams.length < 4 || teams.length > 8) return null;
  // RETURN CONTRACT: [away, home] — every consumer (scenario eval, tree,
  // grids, spread orientation) depends on it.
  //
  // Token order is SPORT-SPECIFIC (verified live 2026-06-11): US sports list
  // away-first ("26MAY28SASDAL" = SAS @ DAL), but Kalshi SOCCER chunks are
  // HOME-FIRST — "26JUN11MEXRSA" is Mexico (home) vs South Africa, confirmed
  // vs ESPN ("RSA @ MEX") + Pinnacle for all four 6/11-12 WC games. The old
  // away-first assumption inverted the live mark + chip coloring on soccer
  // (grid showed RSA up 1-0 while Mexico led 1-0).
  const homeFirst = _SOCCER_TREE_SPORTS.has(sport);
  const order = (first, second) => (homeFirst ? [second, first] : [first, second]);
  // Prefer a split where BOTH halves are real abbreviations for this sport.
  // This is what correctly handles variable-length codes like MLB "AZ"
  // (AZSEA -> AZ|SEA, not the length-heuristic's wrong AZS|EA) and soccer's
  // mix of 3- and 4-char codes. Shortest first-token prefix that yields two
  // known abbrs wins.
  const known = KNOWN_ABBRS[sport];
  if (known) {
    for (let i = 2; i <= teams.length - 2; i++) {
      const a = teams.slice(0, i), b = teams.slice(i);
      if (known.has(a) && known.has(b)) return order(a, b);
    }
  }
  // Fallback when we have no abbr table (or no clean match): old 3/2/4 heuristic.
  for (const len of [3, 2, 4]) {
    if (teams.length - len < 2 || teams.length - len > 4) continue;
    return order(teams.slice(0, len), teams.slice(len));
  }
  return null;
}

// Evaluate a game-level leg in a scenario. Returns:
//   "buyer_hit"  — the leg's yes-side resolves to the buyer's chosen side
//   "buyer_miss" — the leg breaks against the buyer (saves us on this leg)
//   "unknown"    — scenario doesn't pin the relevant variable (e.g. total
//                  leg in a margin-only scenario)
//
// Scenario fields used:
//   margin: home_score - away_score  (positive => home wins)
//   total:  optional, total points scored
function evalGameLegInScenario(parsed, buyerSide, scenario) {
  if (!parsed) return "unknown";
  const margin = scenario.margin;
  if (parsed.kind === "ml") {
    if (margin == null) return "unknown";
    // Soccer 3-way TIE pick: YES hits iff the game is level (2026-06-11).
    if (parsed.pick === "TIE") {
      return resolveLeg(margin === 0, buyerSide);
    }
    // ML for the pick hits iff the pick is the winner. A level score
    // (margin 0 — possible in soccer, transient elsewhere) means the pick
    // is NOT currently winning, which is exactly what the chips/tree need
    // (a drawn soccer final = team-ML miss; was "unknown" => grey forever).
    const [away, home] = parsed.teams;
    let yesHits;
    if (parsed.pick === home) yesHits = margin > 0;
    else if (parsed.pick === away) yesHits = margin < 0;
    else return "unknown";
    return resolveLeg(yesHits, buyerSide);
  }
  if (parsed.kind === "spread") {
    if (margin == null) return "unknown";
    // Covers iff the pick's signed margin exceeds the REAL line (floor_strike),
    // e.g. NHL 1.5 => margin ≥ 2. NOT margin ≥ ticker-int N (off by a unit for
    // NHL/NBA).
    const [away, home] = parsed.teams;
    let yesHits;
    if (parsed.pick === home) yesHits = margin > parsed.line;
    else if (parsed.pick === away) yesHits = -margin > parsed.line;
    else return "unknown";
    return resolveLeg(yesHits, buyerSide);
  }
  if (parsed.kind === "total") {
    if (scenario.total == null) return "unknown";
    // Over iff total > the REAL line (floor_strike), e.g. NHL 5.5 => total ≥ 6.
    const yesHits = scenario.total > parsed.line;
    return resolveLeg(yesHits, buyerSide);
  }
  if (parsed.kind === "btts") {
    // YES = both teams have scored. Needs per-team scores.
    if (scenario.awayScore == null || scenario.homeScore == null) return "unknown";
    const yesHits = scenario.awayScore > 0 && scenario.homeScore > 0;
    return resolveLeg(yesHits, buyerSide);
  }
  if (parsed.kind === "rfi") {
    // YES resolves once a run scores in the 1st. Caller supplies
    // firstInningRuns only when the 1st is complete (or game final), so
    // mid-1st-with-0-runs returns "unknown" instead of misleadingly green.
    if (scenario.firstInningRuns == null) return "unknown";
    const yesHits = scenario.firstInningRuns > 0;
    return resolveLeg(yesHits, buyerSide);
  }
  return "unknown";
}

function resolveLeg(yesHits, buyerSide) {
  const buyerYes = (buyerSide || "yes").toLowerCase() === "yes";
  const buyerHits = (buyerYes && yesHits) || (!buyerYes && !yesHits);
  return buyerHits ? "buyer_hit" : "buyer_miss";
}

// Per-sport scenario palette. Each entry = {label, scenario}. Other sports
// fall back to no scenarios (the section just won't render) until we add
// per-sport coverage. Margin convention = home - away. We pick representative
// integer margins that straddle each plausible spread threshold so spread legs
// resolve cleanly.
function scenariosForSport(sport) {
  if (sport === "nba" || sport === "wnba") {
    return [
      { label: "Home blowout (10+)",    scenario: { margin:  12 } },
      { label: "Home comfortable (4-9)", scenario: { margin:   6 } },
      { label: "Home narrow (1-3)",      scenario: { margin:   2 } },
      { label: "Away narrow (1-3)",      scenario: { margin:  -2 } },
      { label: "Away comfortable (4-9)", scenario: { margin:  -6 } },
      { label: "Away blowout (10+)",     scenario: { margin: -12 } },
    ];
  }
  if (sport === "mlb" || sport === "nhl") {
    return [
      { label: "Home wins by 3+",     scenario: { margin:  3 } },
      { label: "Home wins by 1-2",    scenario: { margin:  1 } },
      { label: "Away wins by 1-2",    scenario: { margin: -1 } },
      { label: "Away wins by 3+",     scenario: { margin: -3 } },
    ];
  }
  if (sport === "atp" || sport === "wta") {
    return [
      { label: "Home/listed first wins", scenario: { margin:  1 } },
      { label: "Away/listed second wins", scenario: { margin: -1 } },
    ];
  }
  return [];
}

// ---- Chip color helpers shared by player and game-level ladders ----
// Sign class: a LOCKED outcome takes priority over the market view (pUs).
//   locked=true  -> we've LOCKED the win  -> solid green
//   locked=false -> we've LOCKED the loss -> solid red
//   otherwise color by the market win prob: pUs >= 50% green, < 50% red.
// (Color matches the % shown on the chip; a not-yet-decided 20% leg is red.)
function chipSignClass(pUs, locked) {
  if (locked === true) return "pos";
  if (locked === false) return "neg";
  if (pUs != null) return pUs >= 0.5 ? "pos" : "neg";
  return "pending";
}
// Background / border shading. Direction matches the sign class. Locked
// outcomes render at full intensity; otherwise intensity scales by how far the
// market is from 50/50 (strong when confident, faint near a coin flip).
function chipShadeStyle(pUs, locked) {
  let isPos, dist;
  if (locked === true) { isPos = true; dist = 1; }
  else if (locked === false) { isPos = false; dist = 1; }
  else if (pUs != null) { isPos = pUs >= 0.5; dist = Math.min(1, Math.abs(pUs - 0.5) * 2); }
  else return "";  // truly unknown -> pending grey from CSS default
  const bgAlpha = (0.06 + dist * 0.32).toFixed(2);
  const borderAlpha = (0.20 + dist * 0.50).toFixed(2);
  const rgb = isPos ? "21, 128, 61" : "190, 18, 60";
  return `background: rgba(${rgb}, ${bgAlpha}); border-color: rgba(${rgb}, ${borderAlpha});`;
}

// Compute per-card scenario rows: for each scenario, walk every parlay
// touching this game and assemble best/worst $P&L. Player-prop and unknown
// legs are treated as an envelope (best = they all fail buyer; worst = they
// all hit buyer). If even the game-level legs alone determine the parlay,
// best == worst.
function computeGameScenarios(g, parlays) {
  const scenarios = scenariosForSport(g.sport);
  if (!scenarios.length) return [];
  const ourParlays = parlays.filter((p) =>
    p.legs.some((l) => legGameGroupKey(l.ticker) === g.key)
  );
  if (!ourParlays.length) return [];
  return scenarios.map(({ label, scenario }) => {
    let best = 0;
    let worst = 0;
    for (const p of ourParlays) {
      // Walk every leg of the parlay; only this-game legs use the scenario.
      // Other-game legs are treated as "unknown" (envelope), so a cross-game
      // parlay's other-game legs only widen the swing, never lock it.
      let anyBuyerMiss = false;       // already guarantees we win
      let anyUnknown = false;          // creates envelope
      let allHit = true;
      for (const l of p.legs) {
        const inThisGame = legGameGroupKey(l.ticker) === g.key;
        const parsed = inThisGame ? parseGameLevelLeg(l.ticker) : null;
        const res = parsed ? evalGameLegInScenario(parsed, l.side, scenario) : "unknown";
        if (res === "buyer_miss") { anyBuyerMiss = true; break; }
        if (res === "unknown")    { anyUnknown = true; allHit = false; }
        // "buyer_hit" leaves allHit true; everything else flips it
      }
      if (anyBuyerMiss) {
        // Locked: we win this parlay.
        const winPnl = p.qty - p.cost;
        best  += winPnl;
        worst += winPnl;
      } else if (anyUnknown) {
        // Envelope: best case we still win (one unknown fails buyer),
        // worst case we lose (every unknown hits buyer).
        best  += p.qty - p.cost;
        worst += -p.cost;
      } else if (allHit) {
        // Locked: every leg hit, we lose.
        best  += -p.cost;
        worst += -p.cost;
      }
    }
    return { label, best, worst };
  });
}

// ── "If the game goes…" decision tree ──────────────────────────────────────
// A flow-chart of game outcomes branching by the variables we actually hold
// legs on (winner → total → biggest player prop), so a glance shows what to
// cheer for. Each node carries the best..worst $ envelope for its branch;
// player props left unbranched stay in the envelope (best = they fail the
// buyer, worst = they hit). Spreads collapse to the winner category exactly
// like the quoter's leg_constraint, so leaf worst/best reconcile with the
// AT RISK (net) / TO WIN numbers on the card header.

function _treeResolveBuyer(yesHits, side) {
  const buyerYes = (side || "yes").toLowerCase() === "yes";
  const buyerHits = buyerYes ? yesHits : !yesHits;
  return buyerHits ? "buyer_hit" : "buyer_miss";
}

// Resolve one leg under a partial assignment. Returns buyer_hit | buyer_miss |
// unknown. unknown => the leg's variable isn't pinned yet (stays in envelope).
function _treeEvalLeg(ticker, side, asg) {
  const gl = parseGameLevelLeg(ticker);
  if (gl) {
    if (gl.kind === "ml" || gl.kind === "spread") {
      const team = gl.pick;
      // Draw/tie pick stays on the categorical winner axis.
      if (team === "TIE" || team === "DRAW") {
        if (asg.winner == null) return "unknown";
        return _treeResolveBuyer(asg.winner === "__DRAW__", side);
      }
      // Margin-aware (matches the netting margin var): SPREAD covers iff signed
      // margin > the REAL line (floor_strike, e.g. NHL 1.5 => ≥2); ML wins iff
      // margin >= 1. asg.margin is home-positive.
      if (asg.margin != null && gl.teams) {
        const [away, home] = gl.teams;
        const tm = team === home ? asg.margin : team === away ? -asg.margin : null;
        if (tm != null) {
          const hit = gl.kind === "spread" ? tm > gl.line : tm >= 1;
          return _treeResolveBuyer(hit, side);
        }
      }
      // Fallback (soccer/draw branches still use the winner category).
      if (asg.winner == null) return "unknown";
      return _treeResolveBuyer(team === asg.winner, side);
    }
    if (gl.kind === "total") {
      if (asg.total == null) return "unknown";
      return _treeResolveBuyer(asg.total > gl.line, side); // over iff total > real line
    }
    if (gl.kind === "rfi") {
      if (asg.rfi == null) return "unknown";
      return _treeResolveBuyer(asg.rfi, side); // yes = a run scored in the 1st
    }
    if (gl.kind === "btts") {
      if (asg.btts == null) return "unknown";
      return _treeResolveBuyer(asg.btts, side); // yes = both teams score
    }
    return "unknown";
  }
  const prop = parsePlayerProp(ticker);
  if (prop && prop.threshold != null) {
    const key = `player|${prop.team}|${prop.lastName}|${prop.stat}`;
    if (!asg.props || !(key in asg.props)) return "unknown";
    return _treeResolveBuyer(asg.props[key], side); // true = over threshold
  }
  return "unknown";
}

// Market-implied probability that OUR side wins a leg (pUs), from the live
// leg mid (preferred) or the fill-time fair as fallback. null when unknown.
function _treeLegPUs(p, leg) {
  const lm = p.legMids?.[leg.ticker];
  if (lm && lm.midC != null) return Math.min(1, Math.max(0, lm.midC / 100));
  if (leg.p != null) return Math.min(1, Math.max(0, 1 - Number(leg.p)));
  return null;
}

// Expected $ P&L for the book under a partial assignment, using market-implied
// per-leg probabilities for everything not pinned by the assignment. Lies
// inside [worst, best], so its position on that range is the thermometer mark.
// Unknown-prob legs fall back to 50/50.
function _treeNodeExpected(parlays, gameKey, asg) {
  let exp = 0;
  for (const p of parlays) {
    let pAllHit = 1;
    for (const l of p.legs) {
      const r = (legGameGroupKey(l.ticker) === gameKey) ? _treeEvalLeg(l.ticker, l.side, asg) : "unknown";
      let pHit;
      if (r === "buyer_hit") pHit = 1;
      else if (r === "buyer_miss") pHit = 0;
      else { const pu = _treeLegPUs(p, l); pHit = pu == null ? 0.5 : (1 - pu); }
      pAllHit *= pHit;
    }
    // Fold in the runner's fill-time correlation ratio (cosmetic first-order:
    // entry-time joint/product, held fixed as mids move). Skip decided
    // parlays (pAllHit 0/1) where correlation no longer applies.
    if (p.corrRatio != null && pAllHit > 0 && pAllHit < 1) {
      pAllHit = Math.min(1, Math.max(0, pAllHit * p.corrRatio));
    }
    exp += pAllHit * (-p.cost) + (1 - pAllHit) * p.max_profit;
  }
  return exp;
}

// (scenario-tree builders removed 2026-06-11 -- game-level book uses the risk grid;
//  _treeNodeExpected/_treeEvalLeg remain: the grid and resolution logic use them)
const _SOCCER_TREE_SPORTS = new Set(["epl", "laliga", "seriea", "bundesliga", "ligue1", "ucl",
  "wcup", "intlfriendly"]);   // intl comps were missing -> friendlies were treated no-draw/2-way

// Dashboard sport code -> Kalshi ML (…GAME) series prefix. Used to join a game
// card to state.soccerStarts (keyed by the ML event ticker) so we can show a
// kickoff time on soccer games ESPN has no data for (lower-tier friendlies).
const SOCCER_GAME_SERIES = {
  epl: "KXEPLGAME", laliga: "KXLALIGAGAME", seriea: "KXSERIEAGAME",
  bundesliga: "KXBUNDESLIGAGAME", ligue1: "KXLIGUE1GAME", ucl: "KXUCLGAME",
  wcup: "KXWCGAME", intlfriendly: "KXINTLFRIENDLYGAME",
};

// The Kalshi ML event ticker for a soccer game card (joins to the milestone
// kickoff/score maps), or null for non-soccer / unparseable cards.
function soccerEventTicker(g) {
  const series = SOCCER_GAME_SERIES[g && g.sport];
  if (!series || !g.key) return null;
  const [, dateToken, matchup] = g.key.split("|");
  if (!dateToken || !matchup) return null;
  return `${series}-${dateToken}${matchup}`;
}

// Kickoff Date for a soccer game card from the Kalshi milestone map, or null.
function kickoffForGame(g) {
  const et = soccerEventTicker(g);
  const iso = et && state.soccerStarts[et];
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

// Live/final score for a soccer card from Kalshi /live_data, or null. Shape:
// {home, away, statusText, half, winner, matchStatus}. matchStatus "live"|"ended".
function soccerScoreForGame(g) {
  const et = soccerEventTicker(g);
  const sc = et && state.soccerScores[et];
  if (!sc || sc.home == null || sc.away == null) return null;
  return sc;
}

// "Kickoff 2:00 PM" (viewer-local) for a soccer card, or null when unknown.
function kickoffLabel(g) {
  const d = kickoffForGame(g);
  if (!d) return null;
  return "Kickoff " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Compact live-state summary for an ESPN event: { state, score, periodLabel }.
// score is "AWAY n - n HOME" with the away team first (ESPN convention).
// `sport` is required so team-abbr aliasing (e.g. ESPN "SA" -> Kalshi "SAS")
// resolves to the convention the rest of the card uses.
function liveStateFor(ev, sport) {
  if (!ev) return null;
  const comp = ev?.competitions?.[0];
  if (!comp) return null;
  const state = ev?.status?.type?.state || "pre";   // "pre" | "in" | "post"
  const detail = ev?.status?.type?.shortDetail || ev?.status?.type?.description || "";
  const period = ev?.status?.period || null;
  const clock = ev?.status?.displayClock || "";
  // Tennis: competitors are athletes (no team), scored by sets. linescores[]
  // holds games per set; a set this player won has winner === true. Show sets
  // won as the score and the set-by-set games in the status line.
  if (sport === "atp" || sport === "wta") {
    const cs = comp.competitors || [];
    const c0 = cs.find((c) => c.homeAway === "away") || cs[0];
    const c1 = cs.find((c) => c.homeAway === "home") || cs[1];
    const sideOf = (c) => {
      const name = c?.athlete?.displayName || c?.athlete?.fullName || "";
      const codes = athleteCodeCandidates(name);
      const setsWon = (c?.linescores || []).filter((s) => s?.winner === true).length;
      const games = (c?.linescores || []).map((s) => parseInt(s?.value ?? "", 10))
        .filter((nn) => Number.isFinite(nn));
      return { abbr: codes[0] || "", name: name || codes[0] || "", setsWon, games };
    };
    const a = sideOf(c0), h = sideOf(c1);
    const sets = [];
    const ns = Math.max(a.games.length, h.games.length);
    for (let i = 0; i < ns; i++) sets.push(`${a.games[i] ?? 0}-${h.games[i] ?? 0}`);
    const setStr = sets.join(", ");
    let periodLabel;
    if (state === "pre") periodLabel = detail || "Scheduled";
    else if (state === "post") periodLabel = setStr ? `Final · ${setStr}` : (detail || "Final");
    else periodLabel = setStr ? `In Progress · ${setStr}` : (detail || "In Progress");
    return {
      state, periodLabel,
      away: { abbr: a.abbr, name: a.name, score: a.setsWon, record: "" },
      home: { abbr: h.abbr, name: h.name, score: h.setsWon, record: "" },
      firstInningRuns: null,
      raw: ev,
    };
  }
  const competitors = comp.competitors || [];
  const away = competitors.find((c) => c.homeAway === "away") || competitors[0];
  const home = competitors.find((c) => c.homeAway === "home") || competitors[1];
  const awayAbbr = normAbbrForKalshi((away?.team?.abbreviation || "").toUpperCase(), sport);
  const homeAbbr = normAbbrForKalshi((home?.team?.abbreviation || "").toUpperCase(), sport);
  const awayScore = parseInt(away?.score ?? "0", 10);
  const homeScore = parseInt(home?.score ?? "0", 10);
  const recordOf = (c) => (c?.records?.[0]?.summary || c?.records?.[0]?.displayValue || "");
  let periodLabel = "";
  if (state === "pre") periodLabel = detail || "Pregame";
  else if (state === "post") periodLabel = detail || "Final";
  else if (state === "in") {
    const isSoccer = ["epl", "laliga", "seriea", "bundesliga", "ligue1", "ucl"].includes(sport);
    if (sport === "mlb") {
      // Baseball: top/bottom of an inning, not quarters. ESPN shortDetail is
      // "Top 8th" / "Bot 8th" / "Mid 8th" / "End 8th". Render ▲8 / ▼8 with
      // Mid/End spelled out; fall back to the raw detail if it's unexpected.
      const inn = period || (detail.match(/(\d+)/) || [])[1] || "";
      const d = (detail || "").toLowerCase();
      if (d.startsWith("top")) periodLabel = `▲${inn}`;
      else if (d.startsWith("bot")) periodLabel = `▼${inn}`;
      else if (d.startsWith("mid")) periodLabel = `Mid ${inn}`;
      else if (d.startsWith("end")) periodLabel = `End ${inn}`;
      else periodLabel = detail || `Inn ${inn}`;
    } else if (sport === "nhl") {
      // Hockey: periods, not quarters (P4 = OT).
      periodLabel = period != null ? `P${period}${clock ? " " + clock : ""}` : (detail || "In Progress");
    } else if (isSoccer) {
      periodLabel = clock || detail || "In Progress";   // ESPN soccer clock is e.g. "67'"
    } else if (period != null && clock) {
      periodLabel = `Q${period} ${clock}`;
    } else {
      periodLabel = detail || "In Progress";
    }
  }
  // MLB-only: extract 1st-inning runs from linescores once the inning is
  // complete (period > 1, i.e., the game has moved on, or the game is
  // final). Used by RFI chip eval; left null otherwise so RFI chips stay
  // pending mid-1st instead of falsely going green at 0 runs.
  let firstInningRuns = null;
  if (sport === "mlb") {
    const period = ev?.status?.period || 0;
    const isFinal = state === "post";
    if (isFinal || period > 1) {
      const a0 = parseInt(away?.linescores?.[0]?.value ?? "", 10);
      const h0 = parseInt(home?.linescores?.[0]?.value ?? "", 10);
      if (Number.isFinite(a0) && Number.isFinite(h0)) {
        firstInningRuns = a0 + h0;
      }
    }
  }
  // MLB live situation: outs, baserunners, count, current batter/pitcher.
  // ESPN puts it on competition.situation for in-progress games.
  let baseball = null;
  if (sport === "mlb" && state === "in") {
    const sit = comp?.situation;
    if (sit) {
      const nm = (x) => (x?.athlete?.shortName || x?.athlete?.displayName || "");
      const num = (v) => (Number.isFinite(+v) ? +v : null);
      baseball = {
        outs: num(sit.outs) ?? 0,
        balls: num(sit.balls),
        strikes: num(sit.strikes),
        onFirst: !!sit.onFirst,
        onSecond: !!sit.onSecond,
        onThird: !!sit.onThird,
        batter: nm(sit.batter),
        batterLine: sit.batter?.summary || "",
        pitcher: nm(sit.pitcher),
        pitcherId: sit.pitcher?.athlete?.id || null,
        pitcherLine: sit.pitcher?.summary || "",
        lastPlay: sit.lastPlay?.text || "",
        lastPlayId: sit.lastPlay?.id || null,
      };
    }
  }
  // Probable starting pitchers (pregame) — anchors the pitcher-K props.
  let probables = null;
  if (sport === "mlb" && state === "pre") {
    const pa = (away?.probables || [])[0]?.athlete;
    const ph = (home?.probables || [])[0]?.athlete;
    if (pa || ph) probables = {
      away: pa?.shortName || pa?.displayName || "",
      home: ph?.shortName || ph?.displayName || "",
    };
  }
  // NHL probable starting goalies (pregame) — the hockey analog to probable
  // pitchers; anchors any goalie/save props.
  let probableGoalies = null;
  if (sport === "nhl" && state === "pre") {
    const gOf = (c) => {
      const pr = (c?.probables || []).find((x) => x.name === "probableStartingGoalie") || (c?.probables || [])[0];
      const a = pr?.athlete;
      return a ? {
        name: a.shortName || a.displayName || "",
        confirmed: (pr?.status?.type === "confirmed"),
      } : null;
    };
    const ga = gOf(away), gh = gOf(home);
    if (ga || gh) probableGoalies = { away: ga, home: gh };
  }
  // NHL live situation: a minimal seed from the scoreboard (last play + abbrs);
  // the card render enriches it from the /summary with goalie lines, penalty /
  // power-play stats, and shot coordinates for the rink plot.
  let hockey = null;
  if (sport === "nhl" && (state === "in" || state === "post")) {
    // Live or final: the summary-derived goalie lines, penalty stats, and shot
    // plot are worth showing both in-game and for post-game review.
    hockey = {
      lastPlay: comp?.situation?.lastPlay?.text || "",
      awayAbbr, homeAbbr,
    };
  }
  // NBA live situation: a minimal seed (abbrs only — the NBA scoreboard carries
  // no `situation`, so last play + everything else is enriched from the
  // /summary in the card render). The hoops analog to the `hockey` seed.
  let basketball = null;
  if (sport === "nba" && (state === "in" || state === "post")) {
    basketball = { awayAbbr, homeAbbr };
  }
  // Soccer match events (2026-06-11): the scoreboard event carries
  // competitions[0].details[] — goals (with scorer + clock), yellow/red
  // cards, subs. We keep the raw entries + a teamId->abbr map so the card
  // can render a match timeline. Stats (possession/shots) are enriched
  // later from the /summary boxscore in renderGameCards.
  let soccer = null;
  if (_SOCCER_TREE_SPORTS.has(sport) && (state === "in" || state === "post")) {
    const idAbbr = {};
    if (away?.team?.id) idAbbr[String(away.team.id)] = awayAbbr;
    if (home?.team?.id) idAbbr[String(home.team.id)] = homeAbbr;
    soccer = { details: comp?.details || [], idAbbr, stats: null };
  }
  return {
    state, periodLabel, soccer,
    away: {
      abbr: awayAbbr,
      name: away?.team?.shortDisplayName || away?.team?.name || awayAbbr,
      score: awayScore,
      record: recordOf(away),
    },
    home: {
      abbr: homeAbbr,
      name: home?.team?.shortDisplayName || home?.team?.name || homeAbbr,
      score: homeScore,
      record: recordOf(home),
    },
    firstInningRuns,
    baseball,
    probables,
    probableGoalies,
    hockey,
    basketball,
    raw: ev,
  };
}

// Strike-zone plot for the current at-bat. ESPN pitchCoordinate space is
// calibrated empirically (1.7k pitches): called strikes sit in x[82,148],
// y[146,197]; the plot window pads that so out-of-zone pitches show outside the
// box. Dots: strike red, ball green, in-play blue.
function strikeZoneSvg(pitches) {
  if (!pitches || !pitches.length) return "";
  const W = 56, H = 72, R = 4;
  const PX0 = 50, PX1 = 180, PY0 = 120, PY1 = 230; // plot window (ESPN coords)
  const ZX0 = 82, ZX1 = 148, ZY0 = 146, ZY1 = 197; // strike zone (ESPN coords)
  const sx = (x) => Math.max(R, Math.min(W - R, ((x - PX0) / (PX1 - PX0)) * W));
  const sy = (y) => Math.max(R, Math.min(H - R, ((y - PY0) / (PY1 - PY0)) * H));
  const zx = ((ZX0 - PX0) / (PX1 - PX0)) * W, zy = ((ZY0 - PY0) / (PY1 - PY0)) * H;
  const zw = ((ZX1 - ZX0) / (PX1 - PX0)) * W, zh = ((ZY1 - ZY0) / (PY1 - PY0)) * H;
  const dots = pitches.map((p) =>
    `<circle class="pz-dot ${p.cls}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${R}"><title>pitch ${p.n}: ${p.cls}</title></circle>`
  ).join("");
  return `
    <svg class="pz" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-label="pitch locations this at-bat">
      <rect class="pz-zone" x="${zx.toFixed(1)}" y="${zy.toFixed(1)}" width="${zw.toFixed(1)}" height="${zh.toFixed(1)}" rx="2"/>
      ${dots}
    </svg>`;
}

// Compact live-baseball widget: bases diamond (occupied bags filled), outs
// dots, count, the current AB (batter + pitcher), and a strike-zone plot of
// this at-bat's pitches. MLB in-progress only.
// Stylized pitch panel (2026-06-11). ESPN's public soccer feed exposes NO
// shot coordinates (verified live), so unlike the NHL rink / NBA court this
// is SCHEMATIC: halves tinted by possession share, each team's shots(on)/
// corners posted at the goal it attacks, and goal markers (with minute)
// stacked at the net they went into. Honest with the data we actually have.
function soccerPitchHtml(sc) {
  if (!sc.stats || sc.stats.length !== 2) return "";
  // tA owns the LEFT half (defends the left goal, attacks right); tB mirror.
  const [tA, tB] = sc.stats;
  const pA = parseFloat(tA.poss) || 50, pB = parseFloat(tB.poss) || 50;
  const oA = (0.05 + 0.25 * pA / 100).toFixed(2);
  const oB = (0.05 + 0.25 * pB / 100).toFixed(2);
  const H = 134, W = 260, TOP = 16, BOT = H - 14;
  // goals per team (scoreboard details), shown in the net they went INTO
  const goals = { [tA.abbr]: [], [tB.abbr]: [] };
  for (const d of sc.details || []) {
    if (!d.scoringPlay) continue;
    const ab = sc.idAbbr[String(d?.team?.id)];
    if (goals[ab]) goals[ab].push(d?.clock?.displayValue || "");
  }
  const ball = (x, y, min) =>
    `<circle cx="${x}" cy="${y}" r="4" fill="#fff" stroke="#333" stroke-width="1.2"/>` +
    `<text x="${x}" y="${y - 6.5}" font-size="6.5" text-anchor="middle" fill="#555">${escapeHtml(min)}</text>`;
  const ballsA = goals[tA.abbr].map((m, i) => ball(W - 26, TOP + 10 + i * 15, m)).join("");
  const ballsB = goals[tB.abbr].map((m, i) => ball(26, TOP + 10 + i * 15, m)).join("");

  // Starting XI in formation. Rows from the formation string ("4-1-4-1" ->
  // [GK,4,1,4,1]); players placed by formationPlace order within rows.
  // Dots are CIRCULAR FLAGS (ESPN has headshots for ~1/22 WC starters, so
  // flags are the deterministic choice) with "F. Lastname" beneath. Subbed-
  // off players dim; hover keeps the full name + shirt number.
  const shortName = (n) => {
    const parts = String(n || "").trim().split(/\s+/);
    if (parts.length < 2) return parts[0] || "";
    return `${parts[0][0]}. ${parts[parts.length - 1]}`;
  };
  let _clipSeq = 0;
  const clips = [];
  // clip ids must be unique across ALL soccer cards on the page
  const _cidp = `socp${Math.random().toString(36).slice(2, 7)}`;
  const lineupSvg = (lu, leftSide, flagUrl) => {
    if (!lu || !lu.players || !lu.players.length) return "";
    const rows = [1].concat((lu.formation || "").split("-").map((n) => parseInt(n, 10)).filter(Boolean));
    if (rows.reduce((s, n) => s + n, 0) !== 11) {
      // unknown formation -> simple 1-4-4-2-ish fallback by place order
      rows.length = 0; rows.push(1, 4, 4, 2);
    }
    const players = lu.players.slice().sort((a, b) => a.place - b.place);
    const out = [];
    let idx = 0;
    const R = 6;
    const halfW = 106, x0 = leftSide ? 14 : W - 14;
    for (let ri = 0; ri < rows.length && idx < players.length; ri++) {
      const depth = rows.length === 1 ? 0 : ri / (rows.length - 1);
      const x = leftSide ? x0 + depth * halfW : x0 - depth * halfW;
      const k = rows[ri];
      for (let j = 0; j < k && idx < players.length; j++, idx++) {
        const y = TOP + 2 + (BOT - TOP - 14) * ((j + 1) / (k + 1));
        const p = players[idx];
        const cid = `${_cidp}_${++_clipSeq}`;
        clips.push(`<clipPath id="${cid}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${R}"/></clipPath>`);
        const subMark = p.on
          ? `<text x="${(x + R - 1).toFixed(1)}" y="${(y - R + 2).toFixed(1)}" font-size="6.5" fill="#15803d" font-weight="700">▲</text>`
          : "";
        const redMark = p.red != null
          ? `<rect x="${(x + R - 2).toFixed(1)}" y="${(y - R - 3).toFixed(1)}" width="4.5" height="6" rx="0.8" fill="#dc2626"/>`
          : "";
        const tip = p.red != null
          ? `#${p.jersey} ${p.name} (SENT OFF ${p.red} — team down a man)`
          : p.on
          ? `#${p.jersey} ${p.name} (on ${p.on.min} for ${p.on.forName})`
          : `#${p.jersey} ${p.name}${p.off ? " (subbed off)" : ""}`;
        // Sent-off players render near-transparent — the gap in the shape IS
        // the information (team playing with 10).
        const alpha = p.red != null ? 0.18 : p.off ? 0.35 : 1;
        out.push(
          `<g opacity="${alpha}">` +
          (flagUrl
            ? `<image href="${flagUrl}" x="${(x - R - 2).toFixed(1)}" y="${(y - R).toFixed(1)}" width="${2 * R + 4}" height="${2 * R}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${cid})"/>`
            : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${R}" fill="${leftSide ? "#1d4ed8" : "#b91c1c"}"/>`) +
          `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${R}" fill="none" stroke="${p.red != null ? "#dc2626" : leftSide ? "#1d4ed8" : "#b91c1c"}" stroke-width="1.3"/>` +
          `<text x="${x.toFixed(1)}" y="${(y + R + 6.5).toFixed(1)}" font-size="5.4" text-anchor="middle" fill="#333">${escapeHtml(shortName(p.name))}</text>` +
          `<title>${escapeHtml(tip)}</title>` +
          `</g>` + (p.red != null ? `<g opacity="0.9">${redMark}</g>` : "") + (p.on ? `<g>${subMark}</g>` : ""));
      }
    }
    return out.join("");
  };
  const luA = sc.lineups ? sc.lineups[tA.abbr] : null;
  const luB = sc.lineups ? sc.lineups[tB.abbr] : null;
  const formA = luA?.formation ? ` ${luA.formation}` : "";
  const formB = luB?.formation ? ` ${luB.formation}` : "";

  const stat = (t) => `${t.shots || 0}(${t.sot || 0}) shots · ${t.corners || 0} corn`;
  return `
    <svg class="soc-pitch" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <rect x="6" y="${TOP - 4}" width="124" height="${BOT - TOP + 8}" fill="rgba(34,139,34,${oA})"/>
      <rect x="130" y="${TOP - 4}" width="124" height="${BOT - TOP + 8}" fill="rgba(34,139,34,${oB})"/>
      <rect x="6" y="${TOP - 4}" width="248" height="${BOT - TOP + 8}" rx="5" fill="none" stroke="#7aa67a" stroke-width="1.5"/>
      <line x1="130" y1="${TOP - 4}" x2="130" y2="${BOT + 4}" stroke="#7aa67a" stroke-width="1.2"/>
      <circle cx="130" cy="${(TOP + BOT) / 2}" r="12" fill="none" stroke="#7aa67a" stroke-width="1.2"/>
      <rect x="6" y="${(TOP + BOT) / 2 - 18}" width="20" height="36" fill="none" stroke="#7aa67a" stroke-width="1.2"/>
      <rect x="234" y="${(TOP + BOT) / 2 - 18}" width="20" height="36" fill="none" stroke="#7aa67a" stroke-width="1.2"/>
      ${lineupSvg(luA, true, sc.flagByAbbr ? sc.flagByAbbr[tA.abbr] : "")}${lineupSvg(luB, false, sc.flagByAbbr ? sc.flagByAbbr[tB.abbr] : "")}
      <defs>${clips.join("")}</defs>
      ${ballsA}${ballsB}
      <text x="8" y="9" font-size="8.5" font-weight="700" fill="#333">${escapeHtml(tA.abbr)} ${pA}%${escapeHtml(formA)} →</text>
      <text x="${W - 8}" y="9" font-size="8.5" font-weight="700" fill="#333" text-anchor="end">← ${escapeHtml(tB.abbr)} ${pB}%${escapeHtml(formB)}</text>
      <text x="8" y="${H - 1}" font-size="7.5" fill="#555">${escapeHtml(stat(tA))}</text>
      <text x="${W - 8}" y="${H - 1}" font-size="7.5" fill="#555" text-anchor="end">${escapeHtml(stat(tB))}</text>
    </svg>`;
}


// Soccer live situation (2026-06-11): match timeline (goals w/ scorer +
// minute, red/yellow cards) from the scoreboard details[] + a one-line team
// stat strip (possession / shots / corners) from the summary boxscore. The
// soccer analogue of the MLB bases diamond / NHL shot plot.
function soccerSituationHtml(sc) {
  const short = (n) => {
    const parts = String(n || "").trim().split(/\s+/);
    return parts.length < 2 ? (parts[0] || "") : `${parts[0][0]}. ${parts[parts.length - 1]}`;
  };
  const minOf = (c) => parseInt(String(c || "").replace(/[^\d]/g, ""), 10) || 0;
  // Categorize the match events into GROUPS (goals / cards / subs), each
  // sorted by minute — one labeled row per group, chips per event.
  const goals = [], cards = [], subs = [];
  for (const d of sc.details || []) {
    const txt = (d?.type?.text || "").toLowerCase();
    const who = short(d?.athletesInvolved?.[0]?.displayName || "");
    const team = sc.idAbbr[String(d?.team?.id)] || "";
    const clock = d?.clock?.displayValue || "";
    if (d.scoringPlay) {
      const tag = txt.includes("own goal") ? " (og)" : txt.includes("penalty") ? " (pen)" : "";
      goals.push({ icon: "⚽", text: `${clock} ${who}${tag}`, team, min: minOf(clock), big: true });
    } else if (d.redCard || txt.includes("red card")) {
      cards.push({ icon: "🟥", text: `${clock} ${who}`, team, min: minOf(clock), big: true });
    } else if (d.yellowCard || txt.includes("yellow card")) {
      cards.push({ icon: "🟨", text: `${clock} ${who}`, team, min: minOf(clock), big: false });
    }
  }
  for (const s of sc.subs || []) {
    subs.push({ icon: "🔁", text: `${s.min} ${short(s.inName)} ⟵ ${short(s.outName)}`,
                team: s.team, min: minOf(s.min), big: false });
  }
  // Each group splits into two per-team sub-columns headed by the team's
  // flag (the flag IS the team label — no abbr text on chips).
  const [tA, tB] = (sc.stats && sc.stats.length === 2)
    ? [sc.stats[0].abbr, sc.stats[1].abbr] : ["", ""];
  const flagImg = (ab) => {
    const url = sc.flagByAbbr ? sc.flagByAbbr[ab] : "";
    return url
      ? `<img class="soc-tflag" src="${url}" alt="${escapeHtml(ab)}" title="${escapeHtml(ab)}" loading="lazy" decoding="async">`
      : `<b class="soc-tflag-txt">${escapeHtml(ab)}</b>`;
  };
  const row = (label, items) => {
    if (!items.length) return "";
    items.sort((a, b) => a.min - b.min);
    const col = (ab) => {
      const mine = items.filter((e) => e.team === ab
        || (!e.team && ab === tA));          // unknown-team chips fall to col A
      const chips = mine.map((e) =>
        `<span class="soc-chip${e.big ? " big" : ""}">${e.icon} ${escapeHtml(e.text)}</span>`).join("");
      return `<div class="soc-teamcol">${flagImg(ab)}${chips}</div>`;
    };
    return `<div class="soc-group"><span class="soc-glbl">${label}</span>` +
           `<div class="soc-teamcols">${col(tA)}${col(tB)}</div></div>`;
  };
  const inner = row("Goals", goals) + row("Cards", cards) + row("Subs", subs);
  const groups = inner ? `<div class="soc-groups">${inner}</div>` : "";
  let stats = "";
  if (sc.stats && sc.stats.length === 2) {
    const [a, h] = sc.stats;
    const cell = (t) =>
      `<span class="soc-stat"><b>${escapeHtml(t.abbr)}</b> ${escapeHtml(t.poss || "–")}% poss · ${escapeHtml(t.shots || "0")}(${escapeHtml(t.sot || "0")}) shots · ${escapeHtml(t.corners || "0")} corn</span>`;
    stats = `<div class="soc-stats">${cell(a)}${cell(h)}</div>`;
  }
  const pitch = soccerPitchHtml(sc);
  if (!groups && !stats && !pitch) return "";
  // Pitch centered up top; grouped event rows below; the text stat strip
  // only as fallback before the boxscore feeds the pitch.
  return `<div class="soccer-situation">${pitch}${groups}${pitch ? "" : stats}</div>`;
}


function bbSituationHtml(bb) {
  if (!bb) return "";
  const onCls = (b) => (b ? " on" : "");
  const outs = bb.outs || 0;
  const count = (bb.balls != null && bb.strikes != null) ? `${bb.balls}-${bb.strikes}` : "";
  return `
    <div class="bb-situation">
      <div class="bb-row">
      <svg class="bb-diamond" viewBox="0 0 40 36" width="34" height="31" aria-hidden="true">
        <rect class="bb-bag${onCls(bb.onSecond)}" x="15.5" y="3.5"  width="9" height="9" rx="1.5" transform="rotate(45 20 8)"/>
        <rect class="bb-bag${onCls(bb.onThird)}"  x="4.5"  y="14.5" width="9" height="9" rx="1.5" transform="rotate(45 9 19)"/>
        <rect class="bb-bag${onCls(bb.onFirst)}"  x="26.5" y="14.5" width="9" height="9" rx="1.5" transform="rotate(45 31 19)"/>
      </svg>
      <div class="bb-meta">
        <div class="bb-outs">
          <span class="bb-out${0 < outs ? " on" : ""}"></span>
          <span class="bb-out${1 < outs ? " on" : ""}"></span>
          <span class="bb-outs-lbl">${outs} out${outs === 1 ? "" : "s"}</span>
          ${count ? `<span class="bb-count">${count}</span>` : ""}
        </div>
        <div class="bb-ab">
          ${bb.batter ? `<span class="bb-pa"><span class="bb-role">AB</span>${escapeHtml(bb.batter)}${bb.batterLine ? ` <span class="bb-line">${escapeHtml(bb.batterLine)}</span>` : ""}</span>` : ""}
          ${bb.pitcher ? `<span class="bb-pa${bb.pitcherHeld ? " held" : ""}"><span class="bb-role">P</span>${escapeHtml(bb.pitcher)}${(bb.pitches != null || bb.ks != null) ? ` <span class="bb-line">${bb.pitches != null ? `${bb.pitches}P` : ""}${bb.pitches != null && bb.ks != null ? " · " : ""}${bb.ks != null ? `${bb.ks} K` : ""}</span>` : ""}${bb.pullRisk ? ` <span class="bb-pull" title="high pitch count — likely pulled soon, which caps a strikeout-over">⚠ pull risk</span>` : ""}</span>` : ""}
        </div>
      </div>
      ${strikeZoneSvg(bb.abPitches)}
      </div>
      ${bb.lastPlay ? `<div class="bb-lastplay">${escapeHtml(bb.lastPlay)}${(bb.lastPitchMph || bb.lastPitchType) ? ` <span class="bb-pitch-detail">${bb.lastPitchMph ? `${bb.lastPitchMph} mph` : ""}${bb.lastPitchMph && bb.lastPitchType ? " · " : ""}${bb.lastPitchType ? escapeHtml(bb.lastPitchType) : ""}</span>` : ""}</div>` : ""}
    </div>`;
}

// Rink shot plot — the NHL analog to the strike-zone plot. ESPN hockey play
// coordinates are ~x∈[-100,100] (goal-to-goal long axis) and y∈[-42.5,42.5]
// (width). We draw a horizontal rink (boards, blue lines, center red line, goal
// lines, center faceoff) and plot each shot: goal = red (larger), shot-on-goal
// = blue, missed = grey.
function rinkShotPlot(shots) {
  if (!shots || !shots.length) return "";
  const W = 120, H = 51, R = 2.1, GLD = 9;   // R = shot/miss dot radius; GLD = goal-logo diameter
  const sx = (x) => Math.max(R, Math.min(W - R, ((x + 100) / 200) * W));
  const sy = (y) => Math.max(R, Math.min(H - R, ((y + 42.5) / 85) * H));
  const dots = shots.map((s) => {
    const cx = sx(s.x), cy = sy(s.y);
    // A goal shows the scoring team's logo at the shot location; falls back to a
    // coloured dot if the logo is unavailable.
    if (s.cls === "goal" && s.logo) {
      return `<image class="rink-goal-logo" href="${s.logo}" x="${(cx - GLD / 2).toFixed(1)}" y="${(cy - GLD / 2).toFixed(1)}" width="${GLD}" height="${GLD}"><title>goal</title></image>`;
    }
    return `<circle class="rink-dot ${s.cls}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${R.toFixed(1)}"><title>${s.cls}</title></circle>`;
  }).join("");
  const cx = W / 2, midY = H / 2;
  const gxL = sx(-89), gxR = sx(89), creaseR = 3.6, goalH = 1.8, netD = 2.4;
  // Goal nets (rectangles just behind each goal line) + creases (semicircles in
  // front of each net) so shot locations read relative to where the goals are.
  const goals = `
      <path class="rink-crease" d="M ${gxL.toFixed(1)} ${(midY - creaseR).toFixed(1)} A ${creaseR} ${creaseR} 0 0 1 ${gxL.toFixed(1)} ${(midY + creaseR).toFixed(1)} Z"/>
      <path class="rink-crease" d="M ${gxR.toFixed(1)} ${(midY - creaseR).toFixed(1)} A ${creaseR} ${creaseR} 0 0 0 ${gxR.toFixed(1)} ${(midY + creaseR).toFixed(1)} Z"/>
      <rect class="rink-net" x="${(gxL - netD).toFixed(1)}" y="${(midY - goalH).toFixed(1)}" width="${netD.toFixed(1)}" height="${(goalH * 2).toFixed(1)}"/>
      <rect class="rink-net" x="${gxR.toFixed(1)}" y="${(midY - goalH).toFixed(1)}" width="${netD.toFixed(1)}" height="${(goalH * 2).toFixed(1)}"/>`;
  return `
    <svg class="rink" viewBox="0 0 ${W} ${H}" width="100%" aria-label="shot locations this game">
      <rect class="rink-board" x="0.6" y="0.6" width="${W - 1.2}" height="${H - 1.2}" rx="${(H * 0.18).toFixed(1)}"/>
      <line class="rink-blue" x1="${sx(-25).toFixed(1)}" y1="0" x2="${sx(-25).toFixed(1)}" y2="${H}"/>
      <line class="rink-blue" x1="${sx(25).toFixed(1)}" y1="0" x2="${sx(25).toFixed(1)}" y2="${H}"/>
      <line class="rink-center" x1="${cx}" y1="0" x2="${cx}" y2="${H}"/>
      <line class="rink-goal" x1="${gxL.toFixed(1)}" y1="0" x2="${gxL.toFixed(1)}" y2="${H}"/>
      <line class="rink-goal" x1="${gxR.toFixed(1)}" y1="0" x2="${gxR.toFixed(1)}" y2="${H}"/>
      ${goals}
      <circle class="rink-faceoff" cx="${cx}" cy="${midY.toFixed(1)}" r="${(H * 0.16).toFixed(1)}"/>
      ${dots}
    </svg>`;
}

// Compact live-hockey widget: both goalies' live lines (saves / SV% / GA),
// power-play + penalty info per team, recent penalties, last play, and a rink
// shot plot of every shot/goal/miss. NHL in-progress only. Mirrors
// bbSituationHtml's role for baseball.
function hockeySituationHtml(hk) {
  if (!hk) return "";
  const g = hk.goalies || {};
  const goalieLine = (lbl, gl) => gl
    ? `<span class="hk-goalie"><span class="hk-role">${escapeHtml(lbl)}</span>${escapeHtml(gl.name)} <span class="hk-line">${gl.saves ?? "?"}/${gl.shotsAgainst ?? "?"} sv${gl.savePct ? ` · ${escapeHtml(String(gl.savePct))}` : ""}${gl.goalsAgainst != null ? ` · ${gl.goalsAgainst} GA` : ""}</span></span>`
    : "";
  const ts = hk.teamStats || {};
  const ppLine = (lbl, m) => {
    if (!m) return "";
    const pp = (m.powerPlayGoals != null && m.powerPlayOpportunities != null) ? `PP ${m.powerPlayGoals}/${m.powerPlayOpportunities}` : "";
    const pen = m.penalties != null ? `${m.penalties} pen` : "";
    const pim = m.penaltyMinutes != null ? `${m.penaltyMinutes} PIM` : "";
    const parts = [pp, pen, pim].filter(Boolean).join(" · ");
    return parts ? `<span class="hk-pen"><span class="hk-role">${escapeHtml(lbl)}</span>${parts}</span>` : "";
  };
  const pensRecent = (hk.penalties || []).slice(-2).map((p) =>
    `<div class="hk-penrow">⚑ P${p.period ?? "?"} ${escapeHtml(p.clock || "")} ${escapeHtml((p.text || "").slice(0, 60))}</div>`).join("");
  const goalieHtml = (g.away || g.home) ? `<div class="hk-goalies">${goalieLine(hk.awayAbbr, g.away)}${goalieLine(hk.homeAbbr, g.home)}</div>` : "";
  const penHtml = (ts.away || ts.home) ? `<div class="hk-pens">${ppLine(hk.awayAbbr, ts.away)}${ppLine(hk.homeAbbr, ts.home)}</div>` : "";
  return `
    <div class="hk-situation">
      ${goalieHtml}
      ${penHtml}
      ${pensRecent ? `<div class="hk-penlist">${pensRecent}</div>` : ""}
      ${hk.lastPlay ? `<div class="hk-lastplay">${escapeHtml(hk.lastPlay)}</div>` : ""}
      ${rinkShotPlot(hk.shots)}
    </div>`;
}

// Full-court shot chart — the NBA analog to the rink shot plot. ESPN basketball
// play coordinates are normalised onto a single half (origin at the hoop:
// ex∈[0,50] is court WIDTH centred on the hoop, ey = feet from the hoop toward
// half-court; free throws + tip-offs carry a sentinel ~-2.1e9 and are filtered
// upstream). We un-normalise onto a FULL 94×50 court — the HOME team attacks the
// left basket, the AWAY team the right (a 180° rotation of the away half). Made
// shots show the shooting team's logo (like NHL goals); misses are translucent
// team-coloured dots. We draw both keys (painted), free-throw + centre circles,
// the restricted-area arc, three-point line, rim and backboard at each end.
function courtShotPlot(shots) {
  if (!shots || !shots.length) return "";
  const L = 94, W = 50;                 // court dimensions (feet) = viewBox units
  const R = 1.0;                        // miss-dot radius (feet)
  const LOGO = 4.4;                     // made-shot logo size (feet)
  // ESPN (ex, ey) -> full-court (X along length, Y across width). Home hoop at
  // X=5.25, away hoop at X=88.75 (both at width-centre 25).
  const cx = (s) => (s.team === "home" ? 5.25 + s.y : 88.75 - s.y);
  const cy = (s) => (s.team === "home" ? s.x : 50 - s.x);
  const clX = (v) => Math.max(R, Math.min(L - R, v));
  const clY = (v) => Math.max(R, Math.min(W - R, v));
  const dots = shots.map((s) => {
    const X = clX(cx(s)), Y = clY(cy(s));
    if (s.make && s.logo) {
      return `<image class="court-logo" href="${s.logo}" x="${(X - LOGO / 2).toFixed(1)}" y="${(Y - LOGO / 2).toFixed(1)}" width="${LOGO}" height="${LOGO}" preserveAspectRatio="xMidYMid meet"><title>make</title></image>`;
    }
    return `<circle class="nba-shot ${s.team || "away"} ${s.make ? "make" : "miss"}" cx="${X.toFixed(1)}" cy="${Y.toFixed(1)}" r="${R}"><title>${s.make ? "make" : "miss"}</title></circle>`;
  }).join("");
  // One basket end's furniture. baseX = the baseline (0 or 94); dir = +1 (left
  // end, court extends +x) or −1 (right end). side tints the paint by team.
  const end = (baseX, dir, side) => {
    const hoopX = baseX + dir * 5.25, bbX = baseX + dir * 4, ftX = baseX + dir * 19;
    const keyX = Math.min(baseX, ftX), keyW = Math.abs(ftX - baseX);
    const brk = (hoopX + dir * 8.95).toFixed(1);         // 3pt arc break: √(23.75²−22²)≈8.95
    const sweep = dir > 0 ? 1 : 0;                        // arc bulges toward centre court
    return `
      <rect class="court-paint ${side}" x="${keyX.toFixed(1)}" y="17" width="${keyW.toFixed(1)}" height="16"/>
      <line class="court-line" x1="${ftX}" y1="17" x2="${ftX}" y2="33"/>
      <circle class="court-line" cx="${ftX}" cy="25" r="6"/>
      <path class="court-line" d="M ${baseX} 3 L ${brk} 3 A 23.75 23.75 0 0 ${sweep} ${brk} 47 L ${baseX} 47"/>
      <path class="court-line" d="M ${hoopX.toFixed(1)} 21 A 4 4 0 0 ${sweep} ${hoopX.toFixed(1)} 29"/>
      <line class="court-bb" x1="${bbX}" y1="22" x2="${bbX}" y2="28"/>
      <line class="court-rim-neck" x1="${bbX}" y1="25" x2="${hoopX.toFixed(2)}" y2="25"/>
      <circle class="court-rim" cx="${hoopX.toFixed(2)}" cy="25" r="0.9"/>`;
  };
  return `
    <svg class="court" viewBox="-1.5 -1.5 97 53" width="100%" aria-label="shot locations this game — home left, away right">
      <rect class="court-floor" x="0" y="0" width="${L}" height="${W}" rx="1"/>
      <line class="court-line" x1="47" y1="0" x2="47" y2="${W}"/>
      <circle class="court-line" cx="47" cy="25" r="6"/>
      ${end(0, 1, "home")}
      ${end(L, -1, "away")}
      ${dots}
    </svg>`;
}

// Compact live-basketball widget: each team's shooting line (FG / 3PT / REB /
// AST / TO), the scoring/rebound/assist leaders, players in foul trouble, the
// last play, and a full-court shot chart. NBA in-progress or final. Mirrors
// hockeySituationHtml's role for hockey.
function nbaSituationHtml(bk) {
  if (!bk) return "";
  const ts = bk.teamStats || {};
  const statLine = (lbl, m) => {
    if (!m) return "";
    const parts = [
      m.fg ? `FG ${m.fg}${m.fgPct ? ` (${m.fgPct}%)` : ""}` : "",
      m.tp ? `3PT ${m.tp}` : "",
      m.reb != null ? `${m.reb} REB` : "",
      m.ast != null ? `${m.ast} AST` : "",
      m.to != null ? `${m.to} TO` : "",
    ].filter(Boolean).join(" · ");
    return parts ? `<span class="nba-team"><span class="nba-role">${escapeHtml(lbl)}</span>${parts}</span>` : "";
  };
  const ld = bk.leaders || {};
  const leaderLine = (lbl, L) => {
    if (!L) return "";
    const bits = [
      L.pts ? `${escapeHtml(L.pts)}` : "",
      L.reb ? `${escapeHtml(L.reb)}` : "",
      L.ast ? `${escapeHtml(L.ast)}` : "",
    ].filter(Boolean).join(" · ");
    return bits ? `<span class="nba-ldr"><span class="nba-role">${escapeHtml(lbl)}</span>${bits}</span>` : "";
  };
  const fouls = (bk.foulTrouble || []).map((p) =>
    `<span class="nba-foul${p.held ? " held" : ""}">${escapeHtml(p.name)} <span class="nba-foul-n">${p.pf}PF</span></span>`).join("");
  const tsHtml = (ts.away || ts.home) ? `<div class="nba-teams">${statLine(bk.awayAbbr, ts.away)}${statLine(bk.homeAbbr, ts.home)}</div>` : "";
  const ldHtml = (ld.away || ld.home) ? `<div class="nba-ldrs">${leaderLine(bk.awayAbbr, ld.away)}${leaderLine(bk.homeAbbr, ld.home)}</div>` : "";
  return `
    <div class="nba-situation">
      ${tsHtml}
      ${ldHtml}
      ${fouls ? `<div class="nba-fouls"><span class="nba-foul-lbl">⚠ foul trouble</span>${fouls}</div>` : ""}
      ${bk.lastPlay ? `<div class="nba-lastplay">${escapeHtml(bk.lastPlay)}</div>` : ""}
      ${courtShotPlot(bk.shots)}
    </div>`;
}

// Combine positions holding the EXACT same legs into one logical parlay.
// Kalshi mints a distinct parlay ticker per RFQ accept and per MVE collection,
// so the same economic bet (e.g. Wood u1 HIT + u2 HRR) can show up as 2+
// separate positions across KXMVECROSSCATEGORY / KXMVESPORTSMULTIGAMEEXTENDED.
// They're perfectly correlated identical bets, so summing qty/cost/max_profit
// is exact for exposure, netting and EV. The merged position keeps the first
// ticker as its id (so expand/collapse + parlay MTM still resolve) and records
// mergedTickers/mergedCount for the UI. Positions whose legs aren't known yet
// key on their own ticker so they never collapse together.
function mergeIdenticalParlays(positions) {
  const keyOf = (p) => (p.legs && p.legs.length)
    ? `${(p.side || "").toUpperCase()}::` +
      p.legs.map((l) => `${l.ticker}|${(l.side || "").toLowerCase()}`).sort().join("~")
    : `__solo__${p.ticker}`;
  const out = new Map();
  for (const p of positions) {
    const k = keyOf(p);
    const ex = out.get(k);
    if (!ex) {
      out.set(k, { ...p, mergedCount: 1, mergedTickers: [p.ticker] });
      continue;
    }
    ex.qty += p.qty;
    ex.cost += p.cost;
    ex.max_profit += p.max_profit;
    ex.avgCostC = ex.qty ? Math.round((ex.cost / ex.qty) * 100) : 0;
    ex.mergedCount += 1;
    ex.mergedTickers.push(p.ticker);
    // keep the earliest fill time so the combined card sorts/labels by first entry
    if (p.fillTs != null && (ex.fillTs == null || p.fillTs < ex.fillTs)) {
      ex.fillTs = p.fillTs; ex.fillIso = p.fillIso;
    }
  }
  return [...out.values()];
}

// --------------------------- leg exposure ----------------------------------

/**
 * Aggregate every leg across every open parlay into a "what to cheer for" view.
 * Each unique leg ticker is summed across all parlays it appears in:
 *   - exposure: total cost we'd lose if every containing parlay hits
 *   - maxWin:   total max_profit we'd collect if this leg breaks our way
 *   - pUs:      probability our side wins THIS leg (live mid, flipped to NO side)
 *
 * A leg "breaking our way" voids any parlay it's in, so this is the single most
 * actionable view: which player/team underperformance would clear the most $$
 * off the book at once.
 */
function aggregateLegExposure() {
  const byTicker = new Map();
  for (const p of state.positions) {
    for (const leg of p.legs) {
      const tk = leg.ticker;
      // Key by ticker AND our side: a hedged market (we hold both the over and
      // the under of the same threshold — e.g. CINCBURNS26-8 yes+no) must stay
      // two rows, else the opposing legs merge into one chip with summed
      // exposure across sides and a single (wrong) label.
      const rowKey = `${tk}|${leg.side}`;
      let row = byTicker.get(rowKey);
      if (!row) {
        row = {
          ticker: tk,
          buyerSide: leg.side,         // what the buyer needs (parlay hits)
          ourSide: flipSide(leg.side), // what we need (parlay voids)
          parlays: 0,
          exposure: 0,
          maxWin: 0,
          legMid: null,                // most recent legMid we've seen
          fillP: null,                 // fill-time fair (fallback)
        };
        byTicker.set(rowKey, row);
      }
      row.parlays++;
      row.exposure += p.cost;
      row.maxWin += p.max_profit;
      const lm = p.legMids[tk];
      if (lm && lm.midC != null) row.legMid = lm;
      if (leg.p != null) row.fillP = Number(leg.p);
    }
  }

  // Resolve probability + status per leg using the same rules as the parlay cards
  const out = [];
  for (const row of byTicker.values()) {
    const synthetic = { ticker: row.ticker, side: row.buyerSide };
    const res = legResolutionForUs(synthetic, state.scoreboards, state.boxscores);
    const eff = effectiveStatus(res, row.legMid);
    let pUs = null;
    if (eff === "alive") pUs = 1;
    else if (eff === "dead") pUs = 0;
    else if (row.legMid?.midC != null) {
      // legMid is for OUR side already (flipped during refresh), midC ∈ [0,100]
      pUs = row.legMid.midC / 100;
    } else if (row.fillP != null) {
      // fill-time fair was the buyer's prob; ours is 1 - that
      pUs = 1 - row.fillP;
    }
    out.push({ ...row, eff, pUs, statText: res.stat || "", live: res.live || "" });
  }

  return out;
}

// ── Dual-direction / netting math ──────────────────────────────────────────
// JS mirror of run_netting_maker.py `worst_case_net_loss` + `leg_constraint`.
// We accept offsetting ("dual direction") flow on a game, so a game's GROSS
// at-risk overstates real risk: opposing positions on the same game variable
// can't both hit in the same outcome. We enumerate feasible outcomes and, in
// each, charge -cost for parlays that hit against us and +(1-cost_per)*qty for
// parlays that void in our favor; the worst scenario is the net loss. Surfaced
// as offset% so the card shows the same number the quoter caps against.
const _NET_GRID_BUDGET = 200_000;
const _NET_OTHER = "__OTHER__";

// Authoritative line per ticker = the market's `floor_strike` (yes ⟺ value >
// floor_strike). Populated in the markets-fetch loop on refresh. Always prefer
// it; the ticker-integer offset is league-specific (MLB total/spread = N−0.5,
// but NBA & NHL = N+0.5), so a UNIFORM ±0.5 rule silently mis-prints NBA/NHL by
// a full unit. _lineForTicker() encapsulates "floor_strike first, league-aware
// offset only as a fallback" — use it everywhere instead of a bare n±0.5.
const _floorStrikeByTicker = {};

// Real line for a ticker: prefer the market's floor_strike; otherwise fall back
// to the ticker integer with the LEAGUE-SPECIFIC offset (verified vs Kalshi
// 2026-06-02: NHL/NBA tickers are N+0.5, e.g. KXNHLTOTAL ...-5 = 5.5; MLB &
// everything else are N−0.5). A uniform N−0.5 silently printed NBA/NHL a full
// unit low. Used for DISPLAY fallbacks only — netting prefers floor_strike.
function _lineForTicker(ticker, n) {
  const fs = _floorStrikeByTicker[ticker];
  if (typeof fs === "number") return fs;
  if (n == null) return null;
  const off = (ticker.startsWith("KXNHL") || ticker.startsWith("KXNBA")) ? 0.5 : -0.5;
  return n + off;
}

// One leg -> {varKey, vtype:'num'|'cat', op, line|set, team?} or null (not
// modelled => auto-satisfiable, conservative). Polarity matches the runner:
// total/player yes=over; GAME/SPREAD => signed margin from `team`'s view
// (yes=team covers), so nested/opposing spreads net correctly — except a
// draw/tie pick stays on the categorical winner axis; btts yes=both score.
// Margin legs carry `team`; computeGameNetting re-orients them onto one
// reference team per game (mirrors leg_constraint + worst_case_net_loss).
const _SOCCER_NET_SPORTS = new Set(["wcup", "intlfriendly", "epl", "laliga",
  "seriea", "bundesliga", "ligue1", "ucl"]);

function _legConstraintNet(ticker, buyerSide) {
  const yes = (buyerSide || "yes").toLowerCase() !== "no";
  const gl = parseGameLevelLeg(ticker);
  if (gl) {
    if (gl.kind === "ml" || gl.kind === "spread") {
      const team = String(gl.pick || "").replace(/\d+$/, "") || gl.pick;
      if (!team) return null;
      if (team === "TIE" || team === "DRAW") {
        return { varKey: "winner", vtype: "cat", op: yes ? "in" : "notin", set: [team] };
      }
      // Soccer ML is 3-way {home, TIE, away}: put team picks on the SAME winner
      // axis as TIE so the three form one partition and NO positions across them
      // net (you can lose at most one). SPREAD stays a margin threshold. Mirrors
      // leg_constraint / worst_case_net_loss (2026-06-09 3-way fix).
      if (gl.kind === "ml" && _SOCCER_NET_SPORTS.has(gl.sport)) {
        return { varKey: "winner", vtype: "cat", op: yes ? "in" : "notin", set: [team] };
      }
      // SPREAD => team covers <=> margin_team > floor_strike (Kalshi strike_type
      // "greater"). Use the market's real floor_strike (e.g. NHL CAR1 = 1.5)
      // via _lineForTicker, which falls back to the LEAGUE-SPECIFIC offset
      // (NHL/NBA = N+0.5, MLB & others = N−0.5) only when floor_strike is
      // unloaded — never a uniform n−0.5, which collapsed the margin candidate
      // grid and produced phantom "100% hedged" cards. ML has no line: win <=>
      // margin_team >= 1 <=> > 0.5 (no floor_strike on the moneyline market).
      const line = gl.kind === "spread"
        ? _lineForTicker(ticker, gl.threshold)
        : 0.5;
      if (line == null) return null;
      return { varKey: "margin", vtype: "num", op: yes ? "gt" : "le", line, team };
    }
    if (gl.kind === "total") {
      // total over <=> total > floor_strike (e.g. NHL "5" = over 5.5). Prefer
      // the real floor_strike; _lineForTicker falls back to the league-aware
      // ticker offset (NHL/NBA = N+0.5, MLB & others = N−0.5) only if unloaded.
      const line = _lineForTicker(ticker, gl.threshold);
      if (line == null) return null;
      return { varKey: "total", vtype: "num", op: yes ? "gt" : "le", line };
    }
    if (gl.kind === "btts") {
      return { varKey: "btts", vtype: "cat", op: "in", set: [yes ? "yes" : "no"] };
    }
    return null; // rfi + anything else not modelled
  }
  const prop = parsePlayerProp(ticker);
  if (prop && prop.threshold != null && prop.lastName) {
    return {
      varKey: `player|${prop.team}|${prop.lastName}|${prop.stat}`,
      vtype: "num", op: yes ? "gt" : "le", line: prop.threshold,
    };
  }
  return null;
}

// Side-independent var key for a leg — used to tag offsetting chips/rows.
function _legVarKey(ticker) {
  const c = _legConstraintNet(ticker, "yes");
  return c ? c.varKey : null;
}

function _numCandsNet(linesArr) {
  const s = new Set();
  for (const L of linesArr) { s.add(L - 0.5); s.add(L + 0.5); }
  return [...s].sort((a, b) => a - b);
}

function _satNet(c, val) {
  if (c.vtype === "num") return c.op === "gt" ? val > c.line : val <= c.line;
  return c.op === "in" ? c.set.includes(val) : !c.set.includes(val);
}

// Mirror of worst_case_net_loss for one game. positions: [{contracts, costPer,
// legs:[{ticker, side}]}] (side = buyer side). Returns {gross, worstCase,
// offsetRatio, offsetPct, offsettingVars:Set, hedged}.
function computeGameNetting(positions, gameKey) {
  const posList = [];
  const varType = new Map(), varLines = new Map(), varCats = new Map(), varPositions = new Map();
  let gross = 0;
  // Game key is "sport|date|teams". A margin of 0 is a tie — feasible only in
  // draw sports (soccer); excluding it elsewhere keeps best-case honest (no
  // phantom both-win on an impossible tie). Unknown sport -> keep it (the
  // no-game bucket has no margin var anyway).
  const sport = gameKey ? String(gameKey).split("|")[0] : null;
  const drawPossible = sport ? _SOCCER_TREE_SPORTS.has(sport) : true;

  // Pass 1: gather raw constraints for this game and pick a reference team per
  // margin var (deterministic: smallest team abbr). Mirrors worst_case_net_loss.
  const raw = [];        // [{ c, cp, cons:[lc...] }]
  const marginRef = new Map();
  for (const pos of positions) {
    const c = pos.contracts || 0, cp = pos.costPer || 0;
    gross += cp * c;
    const cons = [];
    for (const leg of (pos.legs || [])) {
      // gameKey === null => portfolio scope: keep every leg as a constraint.
      // Otherwise scope to this game; other-game legs are auto-satisfiable.
      if (gameKey != null && legGameGroupKey(leg.ticker) !== gameKey) continue;
      const lc = _legConstraintNet(leg.ticker, leg.side);
      if (!lc) continue;
      cons.push(lc);
      if (lc.vtype === "num" && lc.team != null) {
        const cur = marginRef.get(lc.varKey);
        if (cur == null || lc.team < cur) marginRef.set(lc.varKey, lc.team);
      }
    }
    raw.push({ c, cp, cons, legCount: (pos.legs || []).length });
  }

  // Pass 2: canonicalise margin specs onto the reference axis (flip legs about
  // the other team: margin_other = -margin_ref, so ">L" <=> "<=-L"), then build
  // the variable tables.
  for (const { c, cp, cons, legCount } of raw) {
    const idx = posList.length;
    const ccons = [];
    for (const lc0 of cons) {
      let lc = lc0;
      if (lc0.vtype === "num" && lc0.team != null && lc0.team !== marginRef.get(lc0.varKey)) {
        lc = { varKey: lc0.varKey, vtype: "num",
               op: lc0.op === "gt" ? "le" : "gt", line: -lc0.line };
      }
      ccons.push(lc);
      varType.set(lc.varKey, lc.vtype);
      if (lc.vtype === "num") {
        if (!varLines.has(lc.varKey)) varLines.set(lc.varKey, new Set());
        varLines.get(lc.varKey).add(lc.line);
      } else {
        if (!varCats.has(lc.varKey)) varCats.set(lc.varKey, new Set());
        for (const t of lc.set) varCats.get(lc.varKey).add(t);
      }
      if (!varPositions.has(lc.varKey)) varPositions.set(lc.varKey, new Set());
      varPositions.get(lc.varKey).add(idx);
    }
    posList.push({ c, cp, cons: ccons, legCount });
  }

  const candOf = (v) => {
    if (varType.get(v) !== "num") return [...varCats.get(v)].sort().concat([_NET_OTHER]);
    let cs = _numCandsNet([...varLines.get(v)]);
    // margin 0 is an impossible tie for a no-draw sport, but for a moneyline-only
    // var (line 0.5 => cands {0,1}) the 0 is the SOLE representative of the "ref
    // team loses" (margin<0) region. Deleting it blinds the worst-case to losses
    // on that side (a shared buyer-NO ML reads worstCase 0). Remap 0 -> -1 (a real
    // "ref loses by 1" outcome) instead — keeps losing-side coverage, only adds
    // real scenarios. Mirrors run_netting_maker.worst_case_net_loss.
    if (v === "margin" && !drawPossible) cs = [...new Set(cs.map((x) => x === 0 ? -1 : x))].sort((a, b) => a - b);
    return cs;
  };

  // Offsetting var = the >=2 positions touching it can't all hit at once (no
  // single outcome satisfies every position's constraint). That's the
  // structural "dual direction" we want to flag.
  const offsettingVars = new Set();
  for (const [v, posSet] of varPositions) {
    if (posSet.size < 2) continue;
    const cands = candOf(v);
    const consByPos = [...posSet].map((i) => posList[i].cons.filter((c) => c.varKey === v));
    const anyAllSat = cands.some((val) => consByPos.every((cl) => cl.every((c) => _satNet(c, val))));
    if (!anyAllSat) offsettingVars.add(v);
  }

  let bestNet = null, bestGain = null;

  // SOCCER: enumerate REAL integer scorelines (mirrors the runner's
  // scoreline_worst_case — the number the quoter now caps against) so BOTH the
  // worst cell (At Risk NET) and best cell (To Win net) are FEASIBLE — not
  // impossible (margin,total) joints — and reconcile with the risk grid. Single
  // game scope only; cross-match components (scope=null) keep the axis enum.
  const soccerScore = drawPossible && gameKey != null &&
    ["winner", "margin", "total", "btts"].some((v) => varType.has(v));
  if (soccerScore) {
    const winCats = varCats.get("winner") || new Set();
    const drawTok = winCats.has("DRAW") ? "DRAW" : "TIE";
    const winTeams = [...winCats].filter((t) => t !== "TIE" && t !== "DRAW").sort();
    let ref = marginRef.get("margin");
    if (ref == null) ref = winTeams[0] ?? null;
    let other = winTeams.find((t) => t !== ref);
    if (other == null) other = "__OTHER__";
    let maxLine = 0.5;
    for (const L of (varLines.get("margin") || [])) maxLine = Math.max(maxLine, Math.abs(L));
    for (const L of (varLines.get("total") || [])) maxLine = Math.max(maxLine, Math.abs(L));
    const N = Math.max(12, Math.ceil(maxLine) + 3);   // past every line; mirrors min_cap
    // value of var `c` at the scoreline (g_ref, g_other); margin cons are already
    // canonicalised onto ref so margin = g_ref - g_other. undefined = a
    // non-scoreline leg (player prop / other game) -> auto-satisfiable.
    const scoreVal = (c, gr, go) =>
      c.varKey === "winner" ? (gr > go ? ref : go > gr ? other : drawTok)
      : c.varKey === "margin" ? gr - go
      : c.varKey === "total" ? gr + go
      : c.varKey === "btts" ? ((gr > 0 && go > 0) ? "yes" : "no")
      : undefined;
    for (let gr = 0; gr <= N; gr++) {
      for (let go = 0; go <= N; go++) {
        let netW = 0, netB = 0;
        for (const pos of posList) {
          const win = (1 - pos.cp) * pos.c, lose = -pos.cp * pos.c;
          // worst: loses iff EVERY con hits (non-scoreline cons assumed to hit).
          // best: wins UNLESS fully pinned to lose (no free leg, every con a
          // scoreline con AND satisfied here).
          let allHit = true, pinnedLose = pos.legCount <= pos.cons.length;
          for (const c of pos.cons) {
            const v = scoreVal(c, gr, go);
            const sat = v === undefined ? true : _satNet(c, v);
            if (!sat) allHit = false;
            if (v === undefined || !_satNet(c, v)) pinnedLose = false;
          }
          netW += allHit ? lose : win;
          netB += pinnedLose ? lose : win;
        }
        if (bestNet === null || netW < bestNet) bestNet = netW;
        if (bestGain === null || netB > bestGain) bestGain = netB;
      }
    }
  } else {
    // Non-soccer (and cross-match portfolio scope): independent-var enumeration.
    const shared = [...varPositions.entries()].filter(([, s]) => s.size >= 2)
      .map(([v]) => v).sort((a, b) => varPositions.get(b).size - varPositions.get(a).size);
    const enumVars = []; let grid = 1;
    for (const v of shared) {
      const n = Math.max(1, candOf(v).length);
      if (grid * n > _NET_GRID_BUDGET) break;
      enumVars.push(v); grid *= n;
    }
    const cand = {}; for (const v of enumVars) cand[v] = candOf(v);
    const enumIdx = new Map(enumVars.map((v, i) => [v, i]));
    // Worst case: a parlay LOSES (-cost) when all its enumerated legs hit (others
    // assumed to hit too — conservative). Best case: a parlay WINS (+profit)
    // unless it's fully PINNED to lose — every leg modelled, enumerated, and
    // hitting; a free (other-game/unmodelled) or failing leg lets it break our way.
    const allHits = (pos, asg) => pos.cons.every((c) =>
      !enumIdx.has(c.varKey) || _satNet(c, asg[enumIdx.get(c.varKey)]));
    const voidsBest = (pos, asg) => {
      if (pos.legCount > pos.cons.length) return true;     // has a free leg
      for (const c of pos.cons) {
        if (!enumIdx.has(c.varKey)) return true;
        if (!_satNet(c, asg[enumIdx.get(c.varKey)])) return true;
      }
      return false;                                        // fully pinned to lose
    };
    if (enumVars.length) {
      const lists = enumVars.map((v) => cand[v]);
      const total = lists.reduce((a, l) => a * l.length, 1);
      for (let i = 0; i < total; i++) {
        const asg = []; let rem = i;
        for (const l of lists) { asg.push(l[rem % l.length]); rem = Math.floor(rem / l.length); }
        let netW = 0, netB = 0;
        for (const pos of posList) {
          const win = (1 - pos.cp) * pos.c, lose = -pos.cp * pos.c;
          netW += allHits(pos, asg) ? lose : win;
          netB += voidsBest(pos, asg) ? win : lose;
        }
        if (bestNet === null || netW < bestNet) bestNet = netW;
        if (bestGain === null || netB > bestGain) bestGain = netB;
      }
    } else {
      bestNet = posList.reduce((a, pos) => a + (-pos.cp * pos.c), 0);          // all lose
      bestGain = posList.reduce((a, pos) => a + ((1 - pos.cp) * pos.c), 0);    // all win
    }
  }
  const worstCase = Math.max(0, -(bestNet == null ? 0 : bestNet));
  const offsetRatio = gross > 0 ? worstCase / gross : 1;
  const offsetPct = Math.round((1 - offsetRatio) * 100);
  // "Hedged" once at least ~3% of gross is netted away by opposing flow.
  const hedged = offsettingVars.size > 0 && offsetPct >= 3;
  // Best-case net gain ("to win"): the naive sum of max_profit overstates when
  // offsetting positions can't all win at once. grossWin = that naive sum.
  const grossWin = posList.reduce((a, pos) => a + (1 - pos.cp) * pos.c, 0);
  const bestCase = bestGain == null ? grossWin : bestGain;
  const winOffsetPct = grossWin > 0.005 ? Math.round((1 - bestCase / grossWin) * 100) : 0;
  return { gross, worstCase, offsetRatio, offsetPct, offsettingVars, hedged,
           grossWin, bestCase, winOffsetPct };
}

// Portfolio-wide worst-case net loss — our TRUE risk across the whole book.
// 2026-06-14 FIX: the old version bucketed each parlay into its FIRST leg's
// game and summed per-game worst cases. That severed a CROSS-MATCH parlay's
// offset against the other game it touches and OVERSTATED risk (a Roth
// Sweden+CIV book read $44.02 vs a true joint worst case of $32.91, matching
// the Sweden card). Fix: union games linked by a shared parlay into connected
// components; a single-game component scopes to that game (identical to before)
// while a multi-game component uses computeGameNetting(pos, null) = portfolio
// scope so the cross-match nets across BOTH games. Verified against the live
// book in sandbox/_netting_test.js. Independent components stay additive.
function computePortfolioNetting() {
  const parlays = state.positions.map((p) => ({
    contracts: p.qty || 0,
    costPer: (p.qty > 0 ? (p.cost || 0) / p.qty : 0),
    legs: p.legs || [],
    games: [...new Set((p.legs || []).map((l) => legGameGroupKey(l.ticker)).filter(Boolean))],
  }));
  // union-find over game keys; a cross-match parlay unions the games it spans.
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x; while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; }
    return r;
  };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  for (const p of parlays) {
    const gs = p.games.length ? p.games : ["__nogame__"];
    gs.forEach(find);
    for (let i = 1; i < gs.length; i++) union(gs[0], gs[i]);
  }
  const comps = new Map();
  for (const p of parlays) {
    const root = find((p.games.length ? p.games : ["__nogame__"])[0]);
    if (!comps.has(root)) comps.set(root, []);
    comps.get(root).push(p);
  }
  let worstCase = 0, gross = 0, bestCase = 0, grossWin = 0;
  for (const [root, pos] of comps) {
    const games = new Set();
    for (const p of pos) for (const g of p.games) games.add(g);
    // 1 game -> scope to it (identical to per-game netting); 2+ -> null = joint
    // scope so a cross-match parlay nets across every game it touches.
    const scope = (games.size === 1 && root !== "__nogame__") ? root : null;
    const net = computeGameNetting(pos, scope);
    worstCase += net.worstCase;
    gross += net.gross;
    bestCase += net.bestCase;       // realistic max gain (offsets can't all win)
    grossWin += net.grossWin;       // naive sum of max_profit
  }
  const offsetPct = gross > 0 ? Math.round((1 - worstCase / gross) * 100) : 0;
  const winOffsetPct = grossWin > 0.005 ? Math.round((1 - bestCase / grossWin) * 100) : 0;
  return { gross, worstCase, offsetPct, bestCase, grossWin, winOffsetPct };
}

/**
 * Group every open parlay's cheer-for legs into per-game cards. Game-level
 * cost/maxWin are attributed PER GAME: a cross-game parlay counts its full
 * cost into each game it touches (so the cards don't sum cleanly to the
 * portfolio total — they answer "if this game went our way, what could
 * happen", which is the useful question per-card).
 */
function aggregateGameCards() {
  const legRows = aggregateLegExposure();
  const games = new Map();
  for (const leg of legRows) {
    const key = legGameGroupKey(leg.ticker);
    if (!key) continue;
    let g = games.get(key);
    if (!g) {
      const { sport: sportLogo, teams: logoTeams, league } = legTeams(leg.ticker, leg.buyerSide);
      g = {
        key,
        sport: legSport(leg.ticker),
        sportLogoKey: sportLogo,
        league,
        teams: logoTeams,
        dateLabel: legDateLabel(leg.ticker),
        // EVERY leg (pending, alive, dead) goes here. Resolved legs stay
        // visible in the card so users can see what won / lost. Chip
        // shading + strikethrough handle the visual differentiation
        // (alive -> full green; dead -> full red + line-through).
        legs: [],
        parlayTickers: new Set(),
        exposure: 0,
        maxWin: 0,
      };
      games.set(key, g);
    }
    g.legs.push(leg);
  }
  // Game-level exposure/maxWin/expectedPnl are the SUM of unique parlays
  // touching the game (each parlay counted once per game), not the sum of
  // leg rows. expectedPnl uses live legMid where available and falls back
  // to the fill-time fair price; it's a "where are we headed if current
  // odds hold" projection across this game's parlays.
  for (const p of state.positions) {
    const seen = new Set();
    for (const leg of p.legs) {
      const key = legGameGroupKey(leg.ticker);
      if (!key) continue;
      const g = games.get(key);
      if (!g) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      // state.positions uses .ticker (not .parlay_ticker) for the parlay id;
      // adding undefined dedupes the Set to a single entry per card.
      g.parlayTickers.add(p.ticker);
      g.exposure += p.cost;
      g.maxWin += p.max_profit;
      // Probability ALL legs hit the buyer's chosen side, taken across every
      // leg of the parlay (incl. legs outside this game — cross-game parlays
      // are saved by their other-game legs too). We win iff at least one leg
      // fails the buyer, so pWeWin = 1 - prod(pBuyerHitsLeg).
      let pAllHit = 1;
      let havePrice = true;
      for (const lg of p.legs) {
        let pBuyerHits = null;
        const lm = p.legMids?.[lg.ticker];
        if (lm && lm.midC != null) {
          // legMid is for OUR side; buyer's hit prob is complement.
          pBuyerHits = 1 - (lm.midC / 100);
        } else if (lg.p != null) {
          // Fill-time fair was the buyer's prob.
          pBuyerHits = Number(lg.p);
        }
        if (pBuyerHits == null || !Number.isFinite(pBuyerHits)) {
          havePrice = false;
          break;
        }
        pAllHit *= Math.min(1, Math.max(0, pBuyerHits));
      }
      if (havePrice) {
        // Fold in the fill-time correlation ratio (2026-06-11) — this was the
        // THIRD independent-product EV path (tree + parlay cards were corr-
        // baked, this one wasn't), so a game card could read negative while
        // every parlay card on it was green: the big CZE-by-1 fill's loss
        // prob is 29% independent vs 20% true (ratio 0.676), a ~$2 swing.
        if (p.corrRatio != null && pAllHit > 0 && pAllHit < 1) {
          pAllHit = Math.min(1, Math.max(0, pAllHit * p.corrRatio));
        }
        const pWeWin = 1 - pAllHit;
        g.expectedPnl = (g.expectedPnl || 0) + (pWeWin * p.qty - p.cost);
        g.expectedCovered = (g.expectedCovered || 0) + 1;
      }
      g.parlayCount = (g.parlayCount || 0) + 1;
    }
  }
  // Sort each card's pending legs by max-win desc (highest-impact first).
  for (const g of games.values()) {
    g.legs.sort((a, b) => b.maxWin - a.maxWin);
  }
  // Per-game netting: how much offsetting (dual-direction) flow cancels the
  // gross at-risk. Mirrors the quoter's worst_case_net_loss exactly.
  for (const g of games.values()) {
    const gpos = state.positions
      .filter((p) => p.legs.some((l) => legGameGroupKey(l.ticker) === g.key))
      .map((p) => ({
        contracts: p.qty || 0,
        costPer: (p.qty > 0 ? p.cost / p.qty : 0),
        legs: p.legs,
      }));
    const net = computeGameNetting(gpos, g.key);
    g.gross = net.gross;
    g.worstCase = net.worstCase;
    g.offsetPct = net.offsetPct;
    g.offsettingVars = net.offsettingVars;
    g.hedged = net.hedged;
    // Best-case net gain ("to win"): below the gross max_profit sum (g.maxWin)
    // when offsetting positions can't all win at once. winHedged once >~3% of
    // the upside is unreachable due to offsets.
    g.bestWin = net.bestCase;
    g.winHedged = net.winOffsetPct >= 3 && (net.grossWin - net.bestCase) > 0.005;
  }
  // Sort cards by total exposure desc (where the money is).
  return Array.from(games.values()).sort((a, b) => b.exposure - a.exposure);
}

// ── 2D risk surface (home-margin × total) for hedged games ─────────────────
// The KX sport prefix a ticker starts with (e.g. "KXNHL" for KXNHLGAME-...).
function kxSportPrefix(ticker) {
  for (const p of Object.keys(SPORT_PREFIXES)) if (ticker.startsWith(p)) return p;
  return null;
}

// "12:34" -> 12.567 (minutes, as a float). null if unparseable.
function parseClockMin(displayClock) {
  const m = String(displayClock || "").match(/(\d+):(\d{2})/);
  return m ? parseInt(m[1], 10) + parseInt(m[2], 10) / 60 : null;
}

// Fraction of the game still to be played (1 pregame, 0 final), from ESPN
// game state. Used to weight the pregame total when projecting the finish:
// the further along, the less unplayed game remains to add scoring.
function gameFracRemaining(live, sport) {
  if (!live || live.state === "pre") return 1;
  if (live.state === "post") return 0;
  const st = live.raw?.status || {};
  const period = st.period || 0;
  const clock = st.displayClock || "";
  if (sport === "mlb") {
    const inning = period || 1;
    const d = (st.type?.shortDetail || st.type?.description || "").toLowerCase();
    // top in progress .25, between halves (mid) .5, bottom .75, inning done 1.0
    let half = 0.25;
    if (d.startsWith("mid")) half = 0.5;
    else if (d.startsWith("bot")) half = 0.75;
    else if (d.startsWith("end")) half = 1.0;
    const elapsed = (inning - 1 + half) / 9;
    return Math.max(0, Math.min(1, 1 - elapsed));
  }
  const reg = { nhl: { p: 3, len: 20 }, nba: { p: 4, len: 12 }, wnba: { p: 4, len: 10 } }[sport];
  if (reg) {
    if (period > reg.p) return 0.03;  // overtime: essentially over
    const total = reg.p * reg.len;
    const rem = parseClockMin(clock);
    if (rem == null) return Math.max(0, Math.min(1, 1 - ((period - 0.5) * reg.len) / total));
    const elapsedMin = (period - 1) * reg.len + (reg.len - rem);
    return Math.max(0, Math.min(1, 1 - elapsedMin / total));
  }
  if (_SOCCER_TREE_SPORTS.has(sport)) {
    const m = String(clock).match(/(\d+)/);  // ESPN soccer clock e.g. "67'"
    return m ? Math.max(0, Math.min(1, 1 - parseInt(m[1], 10) / 90)) : 0.5;
  }
  return 0.5;  // unknown sport: neutral
}

// Market-implied projected total = the strike whose P(over) is closest to 50/50
// right now, interpolated between the two strikes that bracket 0.5. P(over) is
// the YES mid. Needs >=2 strikes with a real two-sided quote; null otherwise so
// the caller falls back to the pace-blend. P(over) decreases as the line rises.
function fiftyFiftyTotalFromLadder(markets) {
  const pts = [];
  for (const m of markets || []) {
    const line = typeof m.floor_strike === "number" ? m.floor_strike : null;
    if (line == null) continue;
    // Kalshi populates the *_dollars strings here (the cent fields can be null);
    // fall back to the cent fields just in case.
    const yb = m.yes_bid_dollars != null ? dollarsToC(m.yes_bid_dollars)
      : (typeof m.yes_bid === "number" ? m.yes_bid : null);
    const ya = m.yes_ask_dollars != null ? dollarsToC(m.yes_ask_dollars)
      : (typeof m.yes_ask === "number" ? m.yes_ask : null);
    if (yb == null || ya == null || yb <= 0 || ya >= 100) continue;  // need a real two-sided quote
    pts.push({ line, pOver: (yb + ya) / 200 });
  }
  if (pts.length < 2) return null;
  pts.sort((a, b) => a.line - b.line);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.pOver >= 0.5 && b.pOver <= 0.5) {
      const t = (a.pOver - 0.5) / ((a.pOver - b.pOver) || 1e-9);
      return a.line + t * (b.line - a.line);
    }
  }
  // No 0.5 crossing on the priced rungs: clamp to the ladder edge. If even the
  // lowest line is already under-ish (pOver<0.5) the game projects below it;
  // if even the highest is over-ish, above it.
  return pts[0].pOver < 0.5 ? pts[0].line : pts[pts.length - 1].line;
}

// For each LIVE game we hold a game-level leg on, fetch its Kalshi total ladder
// and store the 50/50 line -> state.proj50ByGame[gameKey]. Best-effort: a thin/
// unpriced ladder leaves null (risk-grid falls back to the pace-blend).
async function fetchLiveTotalProjections() {
  state.proj50ByGame = {};
  const targets = new Map();  // gameKey -> total event ticker
  for (const p of state.positions) {
    for (const leg of p.legs) {
      const gl = parseGameLevelLeg(leg.ticker);
      if (!gl) continue;                      // only game-level legs define a total event
      const gk = legGameGroupKey(leg.ticker);
      if (!gk || targets.has(gk)) continue;
      const ev = findEspnEventForGameKey(gk);
      const ls = ev ? liveStateFor(ev, gl.sport) : null;
      if (!ls || ls.state !== "in") continue;  // projection only matters live
      const prefix = kxSportPrefix(leg.ticker);
      const seg = leg.ticker.split("-")[1];
      if (prefix && seg) targets.set(gk, `${prefix}TOTAL-${seg}`);
    }
  }
  await Promise.all([...targets.entries()].map(async ([gk, evt]) => {
    try {
      const resp = await api(`/api/kalshi/event-markets/${encodeURIComponent(evt)}`);
      const k50 = fiftyFiftyTotalFromLadder(resp?.markets || []);
      state.proj50ByGame[gk] = k50 != null && isFinite(k50) ? k50 : null;
    } catch (e) { state.proj50ByGame[gk] = null; }
  }));
}

// ── Soccer cell probabilities for the $/% grid toggle (2026-06-12) ──────────
// The dashboard has no lambda feed, but it DOES hold live mids for the legs we
// quote — enough to fit an independent-Poisson score model in the browser:
// total-goals rate mu from an over/under mid, home/away split from an ML mid.
// Display-grade (the engine's Dixon-Coles grid differs slightly in the corners)
// but plenty to answer "is the deep red sitting on low-odds cells?".
function _poisPmf(lam, k) {
  let p = Math.exp(-lam);
  for (let i = 1; i <= k; i++) p *= lam / i;
  return p;
}

// Current YES prob for a leg ticker: live mid first, fill-time mark fallback.
// CAREFUL: legMids store the mid in OUR-side terms (the opposite of the buyer's
// leg side — see the price loop), so flip back to YES terms via the leg's side.
// Reading midC as a YES prob fed the live model inverted ML inputs (2026-06-12,
// caught when Bosnia scored and the conditional fit pinned at its boundary).
function _legYesProbNow(ticker) {
  for (const p of state.positions) {
    const lm = p.legMids?.[ticker];
    if (lm && lm.midC != null) {
      const leg = (p.legs || []).find((l) => l.ticker === ticker);
      const buyerYes = !leg || (leg.side || "yes").toLowerCase() === "yes";
      const v = Math.min(1, Math.max(0, lm.midC / 100));
      return buyerYes ? 1 - v : v;   // buyer yes => our (stored) side is NO
    }
  }
  for (const f of state.fillRows) {
    for (const l of (f.legs || [])) {
      if (l.ticker === ticker && l.p != null) {
        const v = Number(l.p);
        return l.side === "yes" ? v : 1 - v;
      }
    }
  }
  return null;
}

// P(remaining ~ Poisson(mu) >= n)
function _poisGE(mu, n) {
  if (n <= 0) return 1.0;
  let cdf = 0;
  for (let k = 0; k < n; k++) cdf += _poisPmf(mu, k);
  return 1 - cdf;
}
// P(curMargin + (H_rem - A_rem) {>|<|==} 0) for remaining rates (lh, la)
function _pCondResult(curMargin, lh, la, cmp) {
  let p = 0;
  for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 10; j++) {
      const m = curMargin + i - j;
      if ((cmp === "home" && m > 0) || (cmp === "away" && m < 0) || (cmp === "draw" && m === 0)) {
        p += _poisPmf(lh, i) * _poisPmf(la, j);
      }
    }
  }
  return p;
}

// P(final away=a, home=h) matrix oriented like the score grid's cells[a][h].
// Returns null when we can't even locate the game's tickers.
// liveCond = {curH, curA, fracLeft, final} switches to the IN-GAME CONDITIONAL
// model (2026-06-12): final = current score + Poisson(remaining), with the
// remaining-goal rate solved from the in-game mids read CONDITIONALLY — the
// live over-X price is P(remaining >= X - curTotal), the live ML price is
// P(curMargin + remaining-difference > 0). A full-match refit misreads those
// same mids (it puts mass below the current score and ignores the clock).
function soccerScoreProbs(gameKey, teams, Na, Nh, liveCond) {
  // Find this game's chunk + GAME-series prefix from any held leg.
  let chunk = null, gameSeries = null;
  outer:
  for (const src of [state.positions, state.fillRows]) {
    for (const p of src) {
      for (const l of (p.legs || [])) {
        if (legGameGroupKey(l.ticker) !== gameKey) continue;
        const parts = l.ticker.split("-");
        if (parts.length < 2) continue;
        chunk = chunk || parts[1];
        if (parts[0].endsWith("GAME")) gameSeries = parts[0];
        if (chunk && gameSeries) break outer;
      }
    }
  }
  if (!chunk) return null;
  gameSeries = gameSeries || "KXWCGAME";
  const [away, home] = teams;

  // ── IN-GAME: conditional remaining-goals model ──
  if (liveCond && liveCond.curH != null && liveCond.curA != null) {
    const { curH, curA } = liveCond;
    if (liveCond.final) {                       // settled: all mass on the final
      const probs = Array.from({ length: Na }, (_, a) =>
        Array.from({ length: Nh }, (_, h) => (a === curA && h === curH ? 1 : 0)));
      return { probs, lh: 0, la: 0, live: true };
    }
    const fracLeft = liveCond.fracLeft != null
      ? Math.max(0.02, Math.min(1, liveCond.fracLeft)) : 0.5;
    const curTotal = curH + curA, curMargin = curH - curA;
    // remaining-goal rate from the most informative live total strike
    let muRem = null;
    for (const k of [3, 4, 2, 5, 6, 1]) {
      const p = _legYesProbNow(`KXWCTOTAL-${chunk}-${k}`);
      const need = k - curTotal;                // goals still required for OVER
      if (p == null || p <= 0.04 || p >= 0.96 || need <= 0) continue;
      muRem = _bisect(0.02, 6, (m) => _poisGE(m, need) - p);
      break;
    }
    if (muRem == null) muRem = 2.5 * fracLeft;  // decayed league-average fallback
    // Staleness guard: thin in-game books can leave the total mid frozen at
    // pregame levels; never let the implied REMAINING goals exceed a generous
    // tempo allowance for the time actually left on the clock. 5.0/match (was
    // 3.2): 3.2 truncated legit high-scoring games — a WC game with a ~5.5
    // pregame total sitting 1-1 at 29' implies ~3.5 remaining, which 3.2*fracLeft
    // clamped to ~2.1, lowering the reachable home-win prob below the live ML and
    // forcing the supremacy solver to pin (-> equal split, see below). A stale
    // frozen mid late in a low-scoring game still implies far more than
    // 5*fracLeft, so the guard keeps working.
    muRem = Math.max(0.05, Math.min(muRem, 5.0 * fracLeft));
    // remaining supremacy from the live ML (home first, away as backup —
    // P(draw) is non-monotone in s, so TIE can't anchor a bisection)
    let s = 0;
    const pH = _legYesProbNow(`${gameSeries}-${chunk}-${home}`);
    const pA = _legYesProbNow(`${gameSeries}-${chunk}-${away}`);
    const sLim = Math.max(0.01, muRem - 0.02);
    if (pH != null && pH > 0.02 && pH < 0.98) {
      s = _bisect(-sLim, sLim,
                  (sv) => _pCondResult(curMargin, (muRem + sv) / 2, (muRem - sv) / 2, "home") - pH);
    } else if (pA != null && pA > 0.02 && pA < 0.98) {
      s = _bisect(-sLim, sLim,
                  (sv) => pA - _pCondResult(curMargin, (muRem + sv) / 2, (muRem - sv) / 2, "away"));
    }
    // Pinned solver: the live ML's win-prob isn't reachable within the
    // remaining-goal budget. For a LEGIT heavy favorite (Germany vs Curacao)
    // that's expected — HOLD the max tilt (underdog scores ~never) rather than
    // equal-splitting, which handed a 90%-favorite's opponent a ~coin-flip to
    // win from level (the old bug published Germany 35% / Curacao 35% at 1-1).
    // Only neutralize to an even split when the pin would make the team that is
    // currently AHEAD stop scoring — the inverted/stale-mid signature this guard
    // was first added for (a trailing team mispriced as the favorite).
    if (Math.abs(s) >= sLim * 0.97) {
      const pinHome = s > 0;   // home gets ~all remaining goals (away ~stops)
      const contradictsLeader =
        (pinHome && curMargin < 0) || (!pinHome && curMargin > 0);
      s = contradictsLeader ? 0 : Math.sign(s) * sLim;
    }
    const lhR = Math.max(0.01, (muRem + s) / 2), laR = Math.max(0.01, (muRem - s) / 2);
    const probs = Array.from({ length: Na }, (_, a) =>
      Array.from({ length: Nh }, (_, h) =>
        (h >= curH && a >= curA)
          ? _poisPmf(lhR, h - curH) * _poisPmf(laR, a - curA) : 0));
    return { probs, lh: lhR, la: laR, live: true };
  }

  // ── PREGAME: full-match fit (unchanged) ──
  // mu from the first total strike with a usable prob (P(total >= k) = p).
  let mu = 2.6;                                   // soccer default
  for (const k of [3, 4, 2, 5, 1]) {
    const p = _legYesProbNow(`KXWCTOTAL-${chunk}-${k}`);
    if (p != null && p > 0.01 && p < 0.99) {
      mu = _bisect(0.2, 8, (m) => {
        let cum = 0;
        for (let i = 0; i < k; i++) cum += _poisPmf(m, i);
        return (1 - cum) - p;
      });
      break;
    }
  }
  // supremacy (lh - la) from an ML mid: home, else away, else draw.
  const targets = [
    [`${gameSeries}-${chunk}-${home}`, (lh, la) => _pHgtA(lh, la)],
    [`${gameSeries}-${chunk}-${away}`, (lh, la) => _pHgtA(la, lh)],
    [`${gameSeries}-${chunk}-TIE`, (lh, la) => _pDraw(lh, la)],
  ];
  let s = 0;
  for (const [tk, fn] of targets) {
    const p = _legYesProbNow(tk);
    if (p != null && p > 0.01 && p < 0.99) {
      s = _bisect(-(mu - 0.05), mu - 0.05,
                  (sv) => fn((mu + sv) / 2, (mu - sv) / 2) - p);
      break;
    }
  }
  const lh = (mu + s) / 2, la = (mu - s) / 2;
  const probs = Array.from({ length: Na }, (_, a) =>
    Array.from({ length: Nh }, (_, h) => _poisPmf(la, a) * _poisPmf(lh, h)));
  return { probs, lh, la };
}

function _pHgtA(lh, la) {
  let p = 0;
  for (let h = 0; h <= 10; h++) for (let a = 0; a < h; a++)
    p += _poisPmf(lh, h) * _poisPmf(la, a);
  return p;
}
function _pDraw(lh, la) {
  let p = 0;
  for (let k = 0; k <= 10; k++) p += _poisPmf(lh, k) * _poisPmf(la, k);
  return p;
}
// Monotone-bracket bisection: fn crosses 0 once in [lo, hi].
function _bisect(lo, hi, fn) {
  let flo = fn(lo);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2, fm = fn(mid);
    if ((fm <= 0) === (flo <= 0)) { lo = mid; flo = fm; } else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── 3D expected-$ surface (the "3D" grid view, 2026-06-12) ──────────────────
// Textbook-style isometric 3D BAR plot of EV(a,h) = P&L x probability per
// scoreline: one prism per cell, centered on the cell, rising above the z=0
// floor (green, lifts E) or hanging below it (red, drags E). Pure SVG string
// (composes with the innerHTML-swapping scrubber/toggle pipeline). Painted
// back-to-front; tick labels sit on the bar centers; axis titles carry flags.
let _evSvgUid = 0;   // unique clipPath ids across the multiple SVGs on a page

function _evSurfaceSvg(na, nh, cells, probs, maxEv, awayName, homeName, markCell, flags) {
  _evSvgUid++;
  // na = away rows, nh = home cols (rectangular; score value == index).
  const ux = 26, uy = 14, Z = 46;          // iso step + max bar height (px)
  const k = 0.36;                          // bar footprint half-fraction of a cell
  const cx = 185, cy = 64;
  const W = 380, H = 280;
  const ev = (a, h) => probs[a][h] * cells[a][h];
  const zOf = (a, h) => (maxEv > 0 ? (ev(a, h) / maxEv) * Z : 0);
  const C = (h, a) => [cx + (h - a) * ux, cy + (h + a) * uy];
  const fmt = (p) => p[0].toFixed(1) + "," + p[1].toFixed(1);
  const out = [];

  // z=0 floor: cell diamonds (so empty cells still read as the floor plane)
  let base = "";
  for (let s = 0; s <= (na - 1) + (nh - 1); s++) {
    for (let h = 0; h < nh; h++) {
      const a = s - h;
      if (a < 0 || a >= na) continue;
      const [x, y] = C(h, a);
      const d = [[x, y - 2 * k * uy], [x + 2 * k * ux, y], [x, y + 2 * k * uy], [x - 2 * k * ux, y]];
      base += `<polygon points="${d.map(fmt).join(" ")}"/>`;
    }
  }
  out.push(`<g fill="rgba(128,128,140,.07)" stroke="rgba(128,128,140,.30)" stroke-width=".7">${base}</g>`);

  // tick labels centered on the OUTER cells of each axis row/column
  let labels = "";
  for (let i = 0; i < nh; i++) {            // home (x) ticks
    const [hx, hy] = C(i, -0.95);          // just outside the a=0 edge
    labels += `<text x="${hx.toFixed(1)}" y="${(hy + 2.5).toFixed(1)}" text-anchor="middle">${i}</text>`;
  }
  for (let i = 0; i < na; i++) {            // away (y) ticks
    const [ax, ay] = C(-0.95, i);          // just outside the h=0 edge
    labels += `<text x="${ax.toFixed(1)}" y="${(ay + 2.5).toFixed(1)}" text-anchor="middle">${i}</text>`;
  }
  out.push(`<g font-size="8.5" fill="rgba(150,150,162,.95)">${labels}</g>`);

  // axis titles with flags, along each axis direction
  const title = (x, y, name, url, arrowAfter) => {
    const img = url ? `<image href="${url}" x="${(x - (arrowAfter ? 34 : -22)).toFixed(1)}" y="${(y - 9).toFixed(1)}" width="11" height="11" preserveAspectRatio="xMidYMid meet"/>` : "";
    return `${img}<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${arrowAfter ? "end" : "start"}" font-size="9" font-weight="700" fill="rgba(150,150,162,.95)">${escapeHtml(name)} ${arrowAfter ? "→" : ""}</text>`
      + (arrowAfter ? "" : `<text x="${(x - 8).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="end" font-size="9" font-weight="700" fill="rgba(150,150,162,.95)">←</text>`);
  };
  const [htx, hty] = C(nh - 0.4, -2.0);
  const [atx, aty] = C(-2.0, na - 0.4);
  out.push(`<g>${title(htx, hty, homeName, flags && flags.home, true)}${title(atx, aty, awayName, flags && flags.away, false)}</g>`);

  // bars, painter's order (back to front)
  const cellsOrder = [];
  for (let h = 0; h < nh; h++) for (let a = 0; a < na; a++) cellsOrder.push([h, a]);
  cellsOrder.sort((q, r) => (q[0] + q[1]) - (r[0] + r[1]));
  let bars = "";
  for (const [h, a] of cellsOrder) {
    const z = zOf(a, h);
    const e = ev(a, h), pnl = cells[a][h], p = probs[a][h];
    const tip = `${awayName} ${a} – ${homeName} ${h} → ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}`
              + ` · ${(p * 100).toFixed(1)}% · EV ${e >= 0 ? "+" : "−"}$${Math.abs(e).toFixed(2)}`;
    const [x, y] = C(h, a);
    const isMark = markCell && markCell.a === a && markCell.h === h;
    // mark rides the bar cap when raised; sits on the rim for pits/flat cells
    const markTxt = isMark
      ? `<text x="${x.toFixed(1)}" y="${(y - Math.max(0, z) + 3).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="800" fill="#000">${markCell.final ? "●" : "✕"}</text>`
      : "";
    if (Math.abs(z) < 0.6) {               // ~zero EV: the floor diamond carries the tooltip
      bars += `<g><polygon points="${[[x, y - 2 * k * uy], [x + 2 * k * ux, y], [x, y + 2 * k * uy], [x - 2 * k * ux, y]].map(fmt).join(" ")}"`
            + ` fill="rgba(128,128,140,.10)" stroke="rgba(128,128,140,.35)" stroke-width=".6"/><title>${escapeHtml(tip)}</title>${markTxt}</g>`;
      continue;
    }
    // base diamond corners: Back/Right/Front/Left around the center
    const B0 = [x, y - 2 * k * uy], R0 = [x + 2 * k * ux, y], F0 = [x, y + 2 * k * uy], L0 = [x - 2 * k * ux, y];
    const lift = (pt) => [pt[0], pt[1] - z];
    const Bz = lift(B0), Rz = lift(R0), Fz = lift(F0), Lz = lift(L0);
    const face = (pts, fill) =>
      `<polygon points="${pts.map(fmt).join(" ")}" fill="${fill}" fill-opacity=".92" stroke="rgba(20,20,30,.5)" stroke-width=".6"/>`;
    if (z > 0) {
      // raised bar: left/right outer walls + cap on top
      bars += `<g>${face([F0, L0, Lz, Fz], "#1f7a46")}${face([F0, R0, Rz, Fz], "#155c34")}`
            + `${face([Fz, Rz, Bz, Lz], "#2ea35f")}<title>${escapeHtml(tip)}</title>${markTxt}</g>`;
    } else {
      // sunken PIT: everything clipped to the cell opening so the hole never
      // paints over neighbors — you look down past the rim onto the pit floor
      // and the two inner back walls.
      const cid = `evpit${_evSvgUid}x${h}${a}`;
      const diamond = [B0, R0, F0, L0].map(fmt).join(" ");
      bars += `<g><defs><clipPath id="${cid}"><polygon points="${diamond}"/></clipPath></defs>`
            + `<g clip-path="url(#${cid})">`
            + face([Fz, Rz, Bz, Lz], "#d4365c")            // pit floor (brightest)
            + face([B0, L0, Lz, Bz], "#a32646")            // inner back-left wall
            + face([B0, R0, Rz, Bz], "#7d1c36")            // inner back-right wall
            + `</g><polygon points="${diamond}" fill="none" stroke="rgba(212,54,92,.85)" stroke-width="1"/>`
            + `<title>${escapeHtml(tip)}</title>${markTxt}</g>`;
    }
  }
  out.push(bars);
  return `<svg class="rg-ev3d" viewBox="0 0 ${W} ${H}" role="img" aria-label="3D expected-value surface">${out.join("")}</svg>`;
}

// A heatmap of EXPECTED $ P&L across game outcomes: each cell is the book's
// expected P&L if the game lands at that (home margin, combined total), with
// player-prop / RFI / BTTS legs marginalized at their market-implied prob —
// reuses _treeNodeExpected, so it reconciles with the tree + the card header.
// Green = we profit there, red = we lose. Straight boundaries fall on the
// spread/total lines we hold. Only built for games where we hold a game-level
// leg (ML/spread/total); pure-prop games have no margin/total structure.
function computeRiskGrid(g, parlays, live) {
  const ours = parlays.filter((p) => p.legs.some((l) => legGameGroupKey(l.ticker) === g.key));
  if (!ours.length) return null;
  // Gather the game-level lines we actually hold, to center + size the grid.
  const totalLines = [];
  const marginCuts = [0];
  let haveGameLeg = false, teams = null;
  for (const p of ours) {
    for (const l of p.legs) {
      if (legGameGroupKey(l.ticker) !== g.key) continue;
      const gl = parseGameLevelLeg(l.ticker);
      if (!gl) continue;
      if (gl.kind === "total") { totalLines.push(gl.line); haveGameLeg = true; }
      else if (gl.kind === "ml" || gl.kind === "spread") {
        haveGameLeg = true; teams = teams || gl.teams;
        if (gl.teams && gl.pick !== "TIE" && gl.pick !== "DRAW") {
          const [away, home] = gl.teams;
          const cut = gl.kind === "spread" ? Math.ceil(gl.line) : 1;
          if (gl.pick === home) marginCuts.push(cut);
          else if (gl.pick === away) marginCuts.push(-cut + 1);
        }
      }
    }
  }
  if (!haveGameLeg) return null;

  const isSoccer = _SOCCER_TREE_SPORTS.has(g.sport) ||
    (g.legs && g.legs.length ? _SOCCER_TREE_SPORTS.has(legSport(g.legs[0].ticker)) : false);

  // SOCCER (2026-06-11 v2): direct SCORELINE axes — away score (rows) ×
  // home score (cols), 0..5 each. The margin×total framing was a lossy
  // projection for soccer (the cells already pin exact scorelines, and the
  // parity-impossible holes only existed because of the projection). Every
  // score×score cell is a real outcome; the draw band is just the diagonal.
  if (isSoccer) {
    // Team codes: from any ML/spread leg if held (parseTeamsFromChunk,
    // [away, home]), else split the game chunk directly — soccer chunks are
    // HOME-FIRST (2026-06-11 fix), so away = second code.
    if (!teams) {
      // No ML/spread leg held (e.g. a total/BTTS-only card), so `teams` was
      // never set above. Derive it from the game key. g.key is the pipe-
      // delimited "sport|DATE|TEAMS" from legGameGroupKey — the old regex
      // expected a bare "26JUN14CIVECU" chunk and so NEVER matched the key,
      // leaving every total/BTTS-only soccer card stuck on the AWAY/HOME
      // fallback (no flags, literal "AWAY"/"HOME" axis labels). Rebuild the
      // date+teams chunk and run it through the same home-first-aware splitter
      // the ML/spread path uses. 2026-06-14.
      const parts = (g.key || "").split("|");   // [sport, DATE, TEAMS]
      teams = parseTeamsFromChunk((parts[1] || "") + (parts[2] || ""), g.sport)
        || ["AWAY", "HOME"];
    }
    const [away, home] = teams;
    const inProgress = !!(live && live.total != null && live.margin != null && !live.final);
    const haveScore = !!(live && live.total != null && live.margin != null);
    // Current per-team scores recovered from (margin=h−a, total=a+h).
    const curH = haveScore ? Math.round((live.total + live.margin) / 2) : null;
    const curA = haveScore ? Math.round((live.total - live.margin) / 2) : null;
    // DYNAMIC PER-AXIS SIZE: default 0..5, but once a team's CURRENT (or final)
    // score reaches the axis midpoint (3), grow that axis's top by 1 per goal so
    // the live score never falls off the grid (Germany 6-1 used to clamp at 5).
    // Each axis sizes to ITS OWN team's score (rectangular), capped at 11.
    const axisMax = (cur) => Math.min(11, Math.max(5, (cur || 0) + 3));
    const scoresH = Array.from({ length: (haveScore ? axisMax(curH) : 5) + 1 }, (_, i) => i);
    const scoresA = Array.from({ length: (haveScore ? axisMax(curA) : 5) + 1 }, (_, i) => i);
    // Reachability is exact and simple in score space: goals only increase.
    const reach = scoresA.map((a) =>
      scoresH.map((h) => !inProgress || (a >= curA && h >= curH)));
    let maxAbs = 0;
    const cells = scoresA.map((a) => scoresH.map((h) => {
      const asg = { margin: h - a, total: a + h,
                    winner: h > a ? home : a > h ? away : "__DRAW__",
                    btts: a > 0 && h > 0 };
      const pnl = _treeNodeExpected(ours, g.key, asg);
      if (reach[a][h] && Math.abs(pnl) > maxAbs) maxAbs = Math.abs(pnl);
      return pnl;
    }));
    const mark = haveScore ? { a: curA, h: curH, final: !!live.final } : null;
    // Cell probabilities for the $/% toggle — display-grade Poisson fit from
    // live mids; null (toggle hidden) when the fit has nothing to chew on.
    // Once live, switch to the conditional model: current score + Poisson of
    // the REMAINING goals (rates read conditionally off the in-game mids).
    const liveCond = haveScore
      ? { curH, curA, fracLeft: live.fracRemaining != null ? live.fracRemaining : null,
          final: !!live.final }
      : null;
    let prob = null;
    try { prob = soccerScoreProbs(g.key, [away, home], scoresA.length, scoresH.length, liveCond); }
    catch (_) { prob = null; }
    return { kind: "score", scoresA, scoresH, cells, reach, maxAbs, teams, mark,
             probs: prob ? prob.probs : null, lambdas: prob ? [prob.lh, prob.la] : null,
             probsLive: !!(prob && prob.live),
             gameKey: g.key, logoKey: g.sportLogoKey, league: g.league };
  }

  // NON-SOCCER: margin × total grid (the generic auto-sized projection).
  const NT = isSoccer ? 8 : 13;  // total columns (odd => centered on the line)
  const NM = isSoccer ? 7 : 12;  // margin rows (EVEN => no margin-0 row; soccer ODD => draw row)
  const sportTotalDefault = { nba: 222, wnba: 162, nhl: 6, mlb: 9,
                              wcup: 3, intlfriendly: 3 }[g.sport] || (isSoccer ? 3 : 220);
  // Integer-scoring sports (runs/goals): each grid step is ONE run/goal — a ±3
  // step is nonsense for a 9-run / 6-goal game. High-scoring sports (NBA/WNBA)
  // keep the auto-sized larger step. Add other low-scoring sports here as needed.
  const unitStep = g.sport === "mlb" || g.sport === "nhl" || isSoccer;
  const tCenter = totalLines.length
    ? (Math.min(...totalLines) + Math.max(...totalLines)) / 2
    : (live && live.total != null ? live.total : sportTotalDefault);
  const tHalf = Math.max(15, (totalLines.length ? (Math.max(...totalLines) - Math.min(...totalLines)) / 2 : 0) + 12);
  const mHalf = Math.max(15, Math.max(...marginCuts.map((m) => Math.abs(m))) + 12);
  const tStep = unitStep ? 1 : Math.max(1, Math.round((2 * tHalf) / (NT - 1)));
  const mStep = unitStep ? 1 : Math.max(1, Math.round(mHalf / (NM / 2)));
  const thalf = (NT - 1) / 2;
  // Live state: scores only INCREASE, so curTotal is the lowest total still
  // reachable and a final (margin m, total t) is reachable iff the remaining
  // goals (t − curTotal) cover the margin swing |m − curMargin|.
  const inProgress = !!(live && live.total != null && live.margin != null && !live.final);
  const curTotal = inProgress ? live.total : null;
  const curMargin = inProgress ? live.margin : null;
  // A game total can never be negative (or zero) — clamp the lowest column to 1.
  // Once in progress, START the axis at curTotal so the grid SHIFTS LEFT onto the
  // still-reachable region: leftmost column = lowest total still possible, no
  // columns wasted on dead low totals (e.g. at 3-1 the axis begins at 4).
  // Soccer starts at 0-0 (a 0 total is a real, common final); others clamp to 1.
  let tStart = isSoccer ? 0 : Math.max(1, Math.round(tCenter - thalf * tStep));
  if (inProgress) tStart = Math.max(isSoccer ? 0 : 1, curTotal);
  const totals = Array.from({ length: NT }, (_, i) => tStart + i * tStep);
  // Soccer: +3..0..-3 (draw row in the middle). Others straddle 0 without
  // including it: +6..+1, -1..-6 (× mStep).
  const margins = isSoccer
    ? Array.from({ length: NM }, (_, i) => (NM - 1) / 2 - i)
    : Array.from({ length: NM }, (_, i) => {
        const k = i < NM / 2 ? (NM / 2 - i) : (NM / 2 - 1 - i);
        return k * mStep;
      });
  const home = teams ? teams[1] : null, away = teams ? teams[0] : null;

  // Per-cell reachability (off-diagonal cells within the window can still be
  // impossible — they're blanked + dropped from the color scale below).
  const reach = margins.map((m) =>
    totals.map((t) => {
      // Soccer unit grid: (margin, total) must form a real scoreline —
      // total >= |margin| and the same parity (h=(t+m)/2 integer). 2-1 with
      // total 2 doesn't exist; blank those instead of pricing nonsense.
      if (isSoccer && (t < Math.abs(m) || (t - Math.abs(m)) % 2 !== 0)) return false;
      return !inProgress || (t - curTotal) >= Math.abs(m - curMargin) - 1e-9;
    }));
  let maxAbs = 0;
  const cells = margins.map((m, ri) => totals.map((t, ci) => {
    let asg;
    if (isSoccer) {
      // Unit soccer cell pins the EXACT scoreline: h=(t+m)/2, a=(t-m)/2.
      // That resolves the draw (winner __DRAW__ for TIE legs) AND BTTS
      // exactly — no 50/50 fallbacks inside the grid.
      const h = (t + m) / 2, a = (t - m) / 2;
      asg = { margin: m, total: t,
              winner: m > 0 ? home : m < 0 ? away : "__DRAW__",
              btts: h > 0 && a > 0 };
    } else {
      asg = { margin: m, total: t, winner: m > 0 ? home : m < 0 ? away : null };
    }
    const pnl = _treeNodeExpected(ours, g.key, asg);
    if (reach[ri][ci] && Math.abs(pnl) > maxAbs) maxAbs = Math.abs(pnl);
    return pnl;
  }));

  // The ✕ marks where the game is HEADING, not where it is. Margin stays the
  // live margin (who's winning now); the total is PROJECTED to the finish:
  //   1. Kalshi 50/50 line (market-implied final total) when the ladder's priced
  //   2. else pace-blend: current total + pregame total × fraction of game left
  //      (trusts the line early, the actual score late). tCenter is our pregame
  //      total estimate. Once final, just use the actual total.
  let mark = null;
  if (live && live.margin != null && live.total != null) {
    let total = live.total, projected = false;
    if (!live.final) {
      if (live.proj50 != null && isFinite(live.proj50)) {
        total = live.proj50; projected = true;
      } else if (live.fracRemaining != null) {
        total = live.total + tCenter * live.fracRemaining; projected = true;
      }
    }
    mark = { margin: live.margin, total, final: !!live.final, projected };
  }
  return { margins, totals, cells, reach, maxAbs, totalLines, teams: teams || [away, home], mark, mStep, tStep };
}

// Soccer scoreline grid, graph-style: ORIGIN (0,0) at the BOTTOM-LEFT — away
// team's goals climb the y-axis, home team's goals run along the x-axis.
// Ticks are plain 0..5; each axis carries a flag + country-name title. The
// diagonal is the draw band.
function renderScoreGridHtml(grid) {
  const { scoresA, scoresH, cells, reach, maxAbs, mark, teams, logoKey, league, probs } = grid;
  const [away, home] = teams;
  const awayName = NATIONAL_TEAMS[away] || away;
  const homeName = NATIONAL_TEAMS[home] || home;
  const view = (probs && grid.gameKey && state.gridView[grid.gameKey]) || "pnl";
  const probView = view === "prob", evView = view === "ev", ev2dView = view === "ev2d";
  let maxProb = 0, maxEv = 0, evSum = 0;
  if (probs) {
    for (let a = 0; a < probs.length; a++) {
      for (let h = 0; h < probs[a].length; h++) {
        const p = probs[a][h];
        if (p > maxProb) maxProb = p;
        const ev = p * cells[a][h];
        evSum += ev;
        if ((!reach || reach[a][h]) && Math.abs(ev) > maxEv) maxEv = Math.abs(ev);
      }
    }
  }
  const flag = (ab) => {
    const url = teamLogoUrl(logoKey || "wcup", ab, { league });
    return url ? `<img class="rg-axis-flag" src="${url}" alt="${escapeHtml(ab)}" onerror="this.style.display='none'" loading="lazy" decoding="async">` : "";
  };
  const color = (pnl) => {
    const a = Math.min(1, Math.abs(pnl) / maxAbs);
    const alpha = (0.08 + a * 0.64).toFixed(2);
    return `rgba(${pnl >= 0 ? "21,128,61" : "190,18,60"},${alpha})`;
  };
  // Probability view: one blue scale, deepest = modal scoreline.
  const probColor = (p) => {
    const a = maxProb > 0 ? Math.min(1, p / maxProb) : 0;
    return `rgba(59,130,246,${(0.06 + a * 0.66).toFixed(2)})`;
  };
  const pctTxt = (p) => {
    const pct = p * 100;
    return pct >= 9.5 ? String(Math.round(pct)) : pct >= 1 ? pct.toFixed(1) : "·";
  };
  // flat $x% view: diverging green/red scaled to the largest |P&L x p|
  const evColor = (ev) => {
    const a = maxEv > 0 ? Math.min(1, Math.abs(ev) / maxEv) : 0;
    return `rgba(${ev >= 0 ? "21,128,61" : "190,18,60"},${(0.08 + a * 0.64).toFixed(2)})`;
  };
  const evTxt = (ev) => {
    const v = Math.abs(ev);
    if (v < 0.05) return "·";
    const s = ev > 0 ? "+" : "-";
    return v >= 9.5 ? s + Math.round(v) : s + v.toFixed(1);
  };
  const dollar = (v) => { const r = Math.round(v); return r > 0 ? "+" + r : "" + r; };
  const Na = scoresA.length, Nh = scoresH.length;   // rows (away) × cols (home)
  const topA = Na - 1;
  // Live/final mark cell (the dynamic axes keep it on-grid; clamp defensively).
  let markA = -1, markH = -1;
  if (mark) {
    markA = Math.min(Na - 1, Math.max(0, mark.a));
    markH = Math.min(Nh - 1, Math.max(0, mark.h));
  }
  let rows = "";
  for (let a = topA; a >= 0; a--) {         // top row = most away goals; 0 lands at the bottom
    let cellsHtml = `<div class="rg-ylab" title="${escapeHtml(awayName)} scores ${a}">${a}</div>`;
    for (let h = 0; h < Nh; h++) {
      const isDraw = a === h;
      const drawCls = isDraw ? " rg-draw" : "";
      if (reach && !reach[a][h]) {
        cellsHtml += `<div class="rg-cell rg-dead${drawCls}" style="background:rgba(80,80,90,0.05);color:rgba(160,160,170,0.25)" `
          + `title="unreachable from the current score">·</div>`;
        continue;
      }
      const pnl = cells[a][h];
      const cellP = probs ? probs[a][h] : null;
      const cellEv = cellP != null ? cellP * pnl : null;
      const isMark = (a === markA && h === markH);
      const extraTxt = cellP != null
        ? ` · ${(cellP * 100).toFixed(1)}% chance · EV ${cellEv >= 0 ? "+" : "−"}$${Math.abs(cellEv).toFixed(2)}`
        : "";
      const base = `${awayName} ${a} – ${homeName} ${h}${isDraw ? " (draw)" : ""} → ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}${extraTxt}`;
      const title = isMark ? (mark.final ? `FINAL — ${base}` : `current score — ${base}`) : base;
      const bg = probView ? probColor(cellP) : ev2dView ? evColor(cellEv) : color(pnl);
      const body = isMark ? (mark.final ? "●" : "✕")
        : probView ? pctTxt(cellP)
        : ev2dView ? evTxt(cellEv)
        : dollar(pnl);
      cellsHtml += `<div class="rg-cell${drawCls}${isMark ? " rg-mark" : ""}" style="background:${bg}" `
        + `title="${escapeHtml(title)}">${body}</div>`;
    }
    rows += `<div class="rg-row">${cellsHtml}</div>`;
  }
  let xlabs = `<div class="rg-corner"></div>`;
  for (let h = 0; h < Nh; h++) xlabs += `<div class="rg-xlab">${scoresH[h]}</div>`;
  rows += `<div class="rg-row rg-xrow">${xlabs}</div>`;
  const toggle = probs ? `
        <span class="rg-view-toggle" data-game-key="${escapeHtml(grid.gameKey)}">
          <span class="rg-view-row">
            <button type="button" class="rg-view-btn${view === "pnl" ? " on" : ""}" data-view="pnl" title="expected $ P&L per final score">$</button>
            <button type="button" class="rg-view-btn${probView ? " on" : ""}" data-view="prob" title="chance of each final score (Poisson fit from live mids)">%</button>
            <button type="button" class="rg-view-btn${evView ? " on" : ""}" data-view="ev" title="3D bar surface: height = P&L x chance per scoreline (heights sum to the book's E[P&L])">3D</button>
          </span>
          <span class="rg-view-row">
            <button type="button" class="rg-view-btn${ev2dView ? " on" : ""}" data-view="ev2d" title="P&L x chance per cell, flat heatmap: contribution to expected $ (cells sum to the book's E[P&L])">2D</button>
          </span>
        </span>` : "";
  const markLegend = mark ? `· <span class="rg-markk">${mark.final ? "●" : "✕"}</span>${mark.final ? "final" : "current score"}` : "";
  const legend = probView
    ? `darker blue = more likely · % chance shown in each cell ${grid.probsLive
        ? `(LIVE conditional: score + clock, ~${grid.lambdas ? (grid.lambdas[0] + grid.lambdas[1]).toFixed(1) : "?"} goals left)`
        : `(model est. ${grid.lambdas ? grid.lambdas.map((x) => x.toFixed(1)).join("/") : ""} goals)`}
        ${markLegend} · diagonal = draws · hover a cell for its $`
    : ev2dView
    ? `<span class="rg-sw neg"></span>drags E<span class="rg-sw pos"></span>lifts E · $ P&L × chance per cell — contribution to expected $
        ${markLegend} · cells sum to E[P&L] ≈ ${evSum >= 0 ? "+" : "−"}$${Math.abs(evSum).toFixed(2)}`
    : evView
    ? `<span class="rg-sw neg"></span>pit (drags E)<span class="rg-sw pos"></span>peak (lifts E) · bar height = $ P&L × chance per scoreline
        · heights sum to E[P&L] ≈ ${evSum >= 0 ? "+" : "−"}$${Math.abs(evSum).toFixed(2)} · hover a bar for $/%/EV`
    : `<span class="rg-sw neg"></span>loss<span class="rg-sw pos"></span>profit · $ shown in each cell
        ${markLegend} · diagonal = draws · max ±$${maxAbs.toFixed(0)}`;
  const headTitle = probView ? "chance of each final score"
    : ev2dView ? "P&L × chance (expected-$ contribution)"
    : evView ? "expected-$ surface (P&L × chance)"
    : "expected $ P&L by final score";
  const flagUrl = (ab) => teamLogoUrl(logoKey || "wcup", ab, { league }) || null;
  const body = evView
    ? _evSurfaceSvg(Na, Nh, cells, probs, maxEv, awayName, homeName,
                    mark ? { a: markA, h: markH, final: !!mark.final } : null,
                    { home: flagUrl(home), away: flagUrl(away) })
    : `
      <div class="rg-wrap">
        <div class="rg-ytitle" title="${escapeHtml(awayName)} goals (y-axis)">
          ${flag(away)}
          <span class="rg-axis-name">${escapeHtml(awayName)}</span>
        </div>
        <div class="rg-grid" style="--rg-n:${Nh}">${rows}</div>
      </div>
      <div class="rg-xtitle" title="${escapeHtml(homeName)} goals (x-axis)">${flag(home)}<span class="rg-axis-name-x">${escapeHtml(homeName)}</span></div>`;
  return `
    <div class="risk-grid">
      <div class="rg-head">Risk surface — ${headTitle}${toggle}</div>
      ${body}
      <div class="rg-legend">${legend}</div>
    </div>`;
}

function renderRiskGridHtml(grid) {
  if (!grid || grid.maxAbs < 0.01) return "";
  if (grid.kind === "score") return renderScoreGridHtml(grid);
  const { margins, totals, cells, maxAbs, mark, teams } = grid;
  const NR = margins.length, NC = totals.length;
  const color = (pnl) => {
    const a = Math.min(1, Math.abs(pnl) / maxAbs);
    const alpha = (0.08 + a * 0.64).toFixed(2);
    return `rgba(${pnl >= 0 ? "21,128,61" : "190,18,60"},${alpha})`;
  };
  const dollar = (v) => { const r = Math.round(v); return r > 0 ? "+" + r : "" + r; };
  // nearest cell to the live/final mark
  let markR = -1, markC = -1;
  if (mark) {
    let bd = 1e9, bm = 1e9;
    margins.forEach((m, r) => { const d = Math.abs(m - mark.margin); if (d < bd) { bd = d; markR = r; } });
    totals.forEach((t, c) => { const d = Math.abs(t - mark.total); if (d < bm) { bm = d; markC = c; } });
  }
  const home = teams[1] || "HOME", away = teams[0] || "AWAY";
  let rows = "";
  for (let r = 0; r < NR; r++) {
    const mv = margins[r];
    // winner-flip seam: the first away-win row (prev row was a home win).
    // Soccer grids carry a margin-0 DRAW row — bracket it with seams on both
    // sides so the three outcome bands (home / draw / away) read at a glance.
    const flip = (r > 0 && ((margins[r - 1] > 0 && mv <= 0) ||
                            (margins[r - 1] === 0 && mv < 0))) ? " rg-flip" : "";
    // Vegas orientation: label by the WINNING team laying the line. mv = home
    // margin (home−away), so mv>0 => home wins by mv => "HOME -mv"; mv<0 =>
    // away wins by |mv| => "AWAY -|mv|". The reference team flips at the 0 seam,
    // and a win is shown as a NEGATIVE spread (e.g. "CAR -1" = CAR by 1).
    // mv === 0 (soccer only) is the DRAW row.
    const winTeam = mv > 0 ? home : away;
    const ylab = mv === 0 ? "DRAW" : `${winTeam} -${Math.abs(mv)}`;
    const ytitle = mv === 0 ? "draw (level at full time)" : `${winTeam} wins by ${Math.abs(mv)}`;
    let cellsHtml = `<div class="rg-ylab" title="${escapeHtml(ytitle)}">${escapeHtml(ylab)}</div>`;
    for (let c = 0; c < NC; c++) {
      // Live-impossible cell (can't be reached from the current score): blank it.
      if (grid.reach && !grid.reach[r][c]) {
        cellsHtml += `<div class="rg-cell${flip} rg-dead" style="background:rgba(80,80,90,0.05);color:rgba(160,160,170,0.25)" `
          + `title="impossible scoreline (margin ${mv} with total ${totals[c]})">·</div>`;
        continue;
      }
      const pnl = cells[r][c];
      const isMark = (r === markR && c === markC);
      const outcome = mv === 0 ? "DRAW" : `${winTeam} -${Math.abs(mv)}`;
      const base = `${outcome}, total ${totals[c]} → ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}`;
      const title = isMark
        ? (mark.final ? `FINAL — ${base}`
          : `projected finish${mark.projected ? ` (total ~${mark.total.toFixed(1)})` : ""} — ${base}`)
        : base;
      cellsHtml += `<div class="rg-cell${flip}${isMark ? " rg-mark" : ""}" style="background:${color(pnl)}" `
        + `title="${escapeHtml(title)}">`
        + `${isMark ? (mark.final ? "●" : "✕") : dollar(pnl)}</div>`;
    }
    rows += `<div class="rg-row">${cellsHtml}</div>`;
  }
  let xlabs = `<div class="rg-corner"></div>`;
  // Small (soccer) grids label every total column; big grids every third.
  for (let c = 0; c < NC; c++) xlabs += `<div class="rg-xlab">${NC <= 9 || c % 3 === 1 ? totals[c] : ""}</div>`;
  rows += `<div class="rg-row rg-xrow">${xlabs}</div>`;
  return `
    <div class="risk-grid">
      <div class="rg-head">Risk surface — expected $ P&L · ${escapeHtml(away)}↔${escapeHtml(home)} margin (rows) × total (cols)</div>
      <div class="rg-grid" style="--rg-n:${NC}">${rows}</div>
      <div class="rg-legend">
        <span class="rg-sw neg"></span>loss<span class="rg-sw pos"></span>profit · $ shown in each cell
        ${mark ? `· <span class="rg-markk">${mark.final ? "●" : "✕"}</span>${mark.final ? "final" : `projected finish${mark.projected ? ` · total ~${mark.total.toFixed(1)}` : ""}`}` : ""}
        · line = winner flips · max ±$${maxAbs.toFixed(0)}
      </div>
    </div>`;
}

// ── Top-5 scoreline summary strip (2026-06-12) ──────────────────────────────
// Compact card-level read of the soccer book: the five most likely final
// scores as flag chips (green = pays us, red = costs us) plus the probability
// mass split between winning and losing scorelines. Pure derivation from the
// same cells+probs the risk grid uses; reflects the LIVE book (not the scrub).
function renderScoreSummaryHtml(grid) {
  if (!grid || grid.kind !== "score" || !grid.probs) return "";
  const { cells, probs, reach, teams, logoKey, league } = grid;
  const [away, home] = teams;
  const homeName = NATIONAL_TEAMS[home] || home;
  const awayName = NATIONAL_TEAMS[away] || away;
  const items = [];
  let pw = 0, pl = 0, tot = 0, evw = 0, evl = 0;
  for (let a = 0; a < probs.length; a++) {            // away rows
    for (let h = 0; h < probs[a].length; h++) {       // home cols
      if (reach && !reach[a][h]) continue;
      const p = probs[a][h], pnl = cells[a][h];
      tot += p;
      if (pnl > 0.005) { pw += p; evw += p * pnl; }
      else if (pnl < -0.005) { pl += p; evl += p * pnl; }
      items.push({ h, a, p, pnl });
    }
  }
  if (!tot) return "";
  items.sort((x, y) => y.p - x.p);
  const flag = (ab) => {
    const u = teamLogoUrl(logoKey || "wcup", ab, { league });
    return u ? `<img class="rg-t5flag" src="${u}" alt="${escapeHtml(ab)}" onerror="this.style.display='none'" loading="lazy" decoding="async">`
             : `<span class="rg-t5abbr">${escapeHtml(ab)}</span>`;
  };
  const chips = items.slice(0, 5).map((it) => {
    const cls = it.pnl > 0.005 ? " pos" : it.pnl < -0.005 ? " neg" : "";
    const tip = `${homeName} ${it.h} – ${awayName} ${it.a}: ${(it.p * 100).toFixed(1)}% chance → ${it.pnl >= 0 ? "+" : "−"}$${Math.abs(it.pnl).toFixed(2)} for us`;
    return `<span class="rg-t5chip${cls}" title="${escapeHtml(tip)}">`
      + `${flag(home)}<b>${it.h}–${it.a}</b>${flag(away)}`
      + `<span class="rg-t5p">${(it.p * 100).toFixed(0)}%</span>`
      + `<span class="rg-t5d">${it.pnl >= 0 ? "+" : "−"}$${Math.abs(it.pnl).toFixed(0)}</span></span>`;
  }).join("");
  const pwn = (pw / tot) * 100, pln = (pl / tot) * 100;
  // conditional magnitudes: avg $ GIVEN a winning / losing scoreline. Frequency
  // alone misreads a short-the-mode book — pw*avgW - pl*avgL = E completes it.
  // (Means, not medians: only means multiply back out to E. The probability-
  // weighted MEDIANS — the "typical" win/loss, immune to tail cells — go in
  // the tooltip.)
  const avgW = pw > 0 ? evw / pw : 0;
  const avgL = pl > 0 ? Math.abs(evl) / pl : 0;
  const e = (evw + evl) / tot;
  const wmedian = (rows, side) => {
    const xs = items.filter((it) => side > 0 ? it.pnl > 0.005 : it.pnl < -0.005)
      .map((it) => ({ v: Math.abs(it.pnl), p: it.p }))
      .sort((x, y) => x.v - y.v);
    const half = xs.reduce((s, x) => s + x.p, 0) / 2;
    let cum = 0;
    for (const x of xs) { cum += x.p; if (cum >= half) return x.v; }
    return xs.length ? xs[xs.length - 1].v : 0;
  };
  const medW = wmedian(items, +1), medL = wmedian(items, -1);
  return `
    <div class="rg-t5">
      <span class="rg-t5lab" title="the five most likely final scores and what each pays us${grid.probsLive ? " (LIVE: conditional on the current score + clock)" : " (model fit from live mids)"}">most likely:</span>
      ${chips}
      <span class="rg-t5split" title="probability mass of winning vs losing scorelines × average $ given each side = expected $ (the line is exact arithmetic). Typical (probability-weighted median) win +$${medW.toFixed(0)} / loss −$${medL.toFixed(0)} — medians resist the tail cells that pull the averages.">
        <span class="rg-sw pos"></span>${pwn.toFixed(0)}% pay us <i>(avg +$${avgW.toFixed(0)})</i>
        <span class="rg-sw neg"></span>${pln.toFixed(0)}% cost us <i>(avg −$${avgL.toFixed(0)})</i>
        <b class="${e >= 0 ? "pos" : "neg"}">→ E ${e >= 0 ? "+" : "−"}$${Math.abs(e).toFixed(2)}</b>
      </span>
    </div>`;
}

// ── Risk-grid FILL SCRUBBER (2026-06-12) ────────────────────────────────────
// A slider above each grid replays how the book built: position k shows the
// grid with only the first k fills touching the game. Dots on the track mark
// each fill's arrival time. Rightmost position = the live grid (default,
// identical to pre-scrubber behavior). Replay grids are rebuilt from the raw
// fill rows (state.fillRows) — legs marginalize at their FILL-TIME side prob
// (leg.p), so a replay step is "that moment's book at entry-time fairs", while
// the live position uses current legMids as before.

// Per-render context the input handler needs to rebuild a card's grid.
const _gridScrubCtx = new Map();   // gameKey -> {g, treeLive, events}

function gameFillEvents(gameKey) {
  return state.fillRows
    .filter((f) => f.legs.some((l) => legGameGroupKey(l.ticker) === gameKey))
    .sort((x, y) => x.ts - y.ts);
}

// Fill rows -> the parlay shape _treeNodeExpected/computeRiskGrid consume.
// legMids stays empty on purpose: _treeLegPUs then falls back to leg.p.
function fillRowsAsParlays(rows) {
  return rows.map((f) => ({
    ticker: f.parlay_ticker,
    legs: f.legs,
    cost: Number(f.cost_paid_dollars) || 0,
    max_profit: (Number(f.contracts) || 0) - (Number(f.cost_paid_dollars) || 0),
    corrRatio: (typeof f.yes_prob_adj === "number" && typeof f.yes_prob === "number"
                && f.yes_prob > 0 && f.yes_prob_adj > 0)
      ? f.yes_prob_adj / f.yes_prob : null,
    legMids: {},
  }));
}

function _scrubGridHtml(g, treeLive, events, idx) {
  // idx in [1..events.length]; events.length = live book (real positions).
  if (idx >= events.length) {
    return renderRiskGridHtml(computeRiskGrid(g, state.positions, treeLive));
  }
  const pseudo = fillRowsAsParlays(events.slice(0, idx));
  return renderRiskGridHtml(computeRiskGrid(g, pseudo, treeLive))
    || `<div class="rg-scrub-empty">grid too small to draw at this point</div>`;
}

function _scrubLabel(events, idx) {
  const live = idx >= events.length;
  const f = events[Math.min(idx, events.length) - 1];
  const t = new Date(f.ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  let cum = 0;
  for (let i = 0; i < idx && i < events.length; i++) cum += Number(events[i].cost_paid_dollars) || 0;
  return live
    ? `now · ${events.length} fills · book $${cum.toFixed(2)}`
    : `<span class="rg-scrub-replay">REPLAY</span> after fill ${idx}/${events.length} · ${t} · book $${cum.toFixed(2)}`;
}

// Slider + time-positioned dots + the grid itself, all in one container the
// input handler can re-render in place.
function renderGridWithScrubber(g, treeLive) {
  const liveGrid = renderRiskGridHtml(computeRiskGrid(g, state.positions, treeLive));
  const events = gameFillEvents(g.key);
  if (!liveGrid || events.length < 2) return liveGrid;   // nothing to scrub
  _gridScrubCtx.set(g.key, { g, treeLive, events });

  const saved = state.gridScrub[g.key];
  const idx = (saved != null && saved >= 1 && saved < events.length) ? saved : events.length;
  const t0 = events[0].ts, t1 = events[events.length - 1].ts;
  const span = Math.max(1, t1 - t0);
  const dots = events.map((f, i) => {
    const pct = ((f.ts - t0) / span) * 100;
    const t = new Date(f.ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const legs = f.legs.length;
    return `<span class="rg-scrub-dot${i < idx ? " on" : ""}" style="left:${pct.toFixed(1)}%" `
      + `title="fill ${i + 1}: ${t} · ${legs} leg${legs > 1 ? "s" : ""} · $${(Number(f.cost_paid_dollars) || 0).toFixed(2)}"></span>`;
  }).join("");

  const atLive = idx >= events.length;
  return `
    <div class="rg-scrub-zone" data-game-key="${escapeHtml(g.key)}">
      <div class="rg-scrub">
        <div class="rg-scrub-track">${dots}</div>
        <div class="rg-scrub-controls">
          <button type="button" class="rg-scrub-btn" data-step="-1" title="previous fill"
                  ${idx <= 1 ? "disabled" : ""}>◀</button>
          <input type="range" min="1" max="${events.length}" step="1" value="${idx}"
                 aria-label="replay book build by fill">
          <button type="button" class="rg-scrub-btn" data-step="1" title="next fill"
                  ${atLive ? "disabled" : ""}>▶</button>
          <button type="button" class="rg-scrub-btn rg-scrub-now" data-now="1"
                  title="jump to the current book" ${atLive ? "disabled" : ""}>current</button>
        </div>
        <div class="rg-scrub-label">${_scrubLabel(events, idx)}</div>
      </div>
      <div class="rg-scrub-body">${_scrubGridHtml(g, treeLive, events, idx)}</div>
    </div>`;
}

function wireGridScrubbers(wrap) {
  wrap.querySelectorAll(".rg-scrub-zone").forEach((zone) => {
    const key = zone.getAttribute("data-game-key");
    const ctx = _gridScrubCtx.get(key);
    const inp = zone.querySelector('input[type="range"]');
    if (!ctx || !inp) return;
    const N = ctx.events.length;
    const setIdx = (raw) => {
      const idx = Math.max(1, Math.min(N, Number(raw) || 1));
      // Remember replay positions; "current" clears the entry so new fills extend the range.
      if (idx >= N) delete state.gridScrub[key];
      else state.gridScrub[key] = idx;
      inp.value = String(idx);
      zone.querySelector(".rg-scrub-body").innerHTML = _scrubGridHtml(ctx.g, ctx.treeLive, ctx.events, idx);
      zone.querySelector(".rg-scrub-label").innerHTML = _scrubLabel(ctx.events, idx);
      zone.querySelectorAll(".rg-scrub-dot").forEach((d, i) => d.classList.toggle("on", i < idx));
      const atLive = idx >= N;
      zone.querySelector('[data-step="-1"]').disabled = idx <= 1;
      zone.querySelector('[data-step="1"]').disabled = atLive;
      zone.querySelector("[data-now]").disabled = atLive;
    };
    inp.addEventListener("input", () => setIdx(inp.value));
    zone.querySelectorAll("[data-step]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        setIdx((Number(inp.value) || 1) + Number(btn.getAttribute("data-step")));
      });
    });
    zone.querySelector("[data-now]").addEventListener("click", (e) => {
      e.stopPropagation();
      setIdx(N);
    });
    // Don't let drags on the slider toggle the card collapse.
    inp.addEventListener("click", (e) => e.stopPropagation());
  });
}

// Live FotMob match-momentum bar strip for a soccer game card. Per-minute series
// mirrored FotMob->HF (sandbox/fotmob_momentum_feed.py); value +=home pushing
// (bars up, home color), -=away (bars down). Keyed by the Kalshi chunk so it
// joins the card directly. Returns "" when there's no momentum for this game.
function renderMomentumHtml(g) {
  const parts = (g.key || "").split("|");        // [sport, DATE, TEAMS]
  const chunk = (parts[1] || "") + (parts[2] || "");
  const mom = state.momentum && state.momentum[chunk];
  if (!mom) return "";
  const data = (mom.momentum || []).filter(
    (p) => p && typeof p.value === "number" && p.minute != null);
  if (data.length < 3) return "";
  const W = 360, H = 56, mid = H / 2;
  const maxM = Math.max(90, ...data.map((p) => p.minute));
  const maxAbs = Math.max(30, ...data.map((p) => Math.abs(p.value)));
  // Per-team bar colors (home pushes UP, away DOWN), with a clash fallback so
  // two similar-colored teams stay distinguishable.
  const { home: homeCol, away: awayCol } = teamBarColors(mom.home_code, mom.away_code);
  const bw = Math.max(1.0, (W / maxM) * 0.9);
  let bars = "";
  for (const p of data) {
    const x = (p.minute / maxM) * W;
    const h = (Math.abs(p.value) / maxAbs) * (mid - 3);
    const y = p.value >= 0 ? mid - h : mid;
    bars += `<rect x="${(x - bw / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" `
      + `height="${Math.max(0.4, h).toFixed(2)}" fill="${p.value >= 0 ? homeCol : awayCol}" opacity="0.9"/>`;
  }
  const curX = (data[data.length - 1].minute / maxM) * W;
  const htX = (45 / maxM) * W;
  const homeName = escapeHtml(mom.home_name || (g.teams || [])[1] || "Home");
  const awayName = escapeHtml(mom.away_name || (g.teams || [])[0] || "Away");
  const flag = (ab) => {
    const u = teamLogoUrl(g.sportLogoKey || "wcup", ab, { league: g.league });
    return u ? `<img class="mom-flag" src="${u}" alt="${escapeHtml(ab || "")}" onerror="this.style.display='none'">` : "";
  };
  const clock = escapeHtml(mom.clock || "");
  const score = Array.isArray(mom.score) ? `${mom.score[0]}–${mom.score[1]}` : "";
  // Home team on TOP (its bars rise up), away on BOTTOM (bars drop down).
  return `
    <div class="mom-card">
      <div class="mom-row">
        <span class="mom-team" style="color:${homeCol}">${flag(mom.home_code)}${homeName}</span>
        <span class="mom-mid">match momentum${score ? ` · ${score}` : ""}${clock ? ` · ${clock}` : ""}</span>
      </div>
      <svg class="mom-svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
        ${bars}
        <line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="rgba(140,140,150,.55)" stroke-width="0.5"/>
        <line x1="${htX.toFixed(1)}" y1="2" x2="${htX.toFixed(1)}" y2="${H - 2}" stroke="rgba(140,140,150,.3)" stroke-width="0.4" stroke-dasharray="2 2"/>
        <line x1="${curX.toFixed(1)}" y1="2" x2="${curX.toFixed(1)}" y2="${H - 2}" stroke="rgba(0,0,0,.45)" stroke-width="0.6"/>
      </svg>
      <div class="mom-row">
        <span class="mom-team" style="color:${awayCol}">${flag(mom.away_code)}${awayName}</span>
      </div>
    </div>`;
}

function renderGameCards() {
  const wrap = $("game-cards");
  const cards = aggregateGameCards();
  // Render every card that has any legs, including all-resolved ones —
  // they stay visible (alive = green, dead = red+strike) so the user can
  // see how the slate landed.
  const live = cards.filter((g) => g.legs.length > 0);
  if (!live.length) {
    wrap.innerHTML = `<div class="empty">no open exposure</div>`;
    return;
  }

  const html = live.map((g) => {
    const logos = (g.teams || []).map((abbr) =>
      `<img class="team-logo" src="${teamLogoUrl(g.sportLogoKey, abbr, { league: g.league })}" alt="${escapeHtml(abbr)}" onerror="this.style.display='none'" loading="lazy" decoding="async">`
    ).join("");
    const sport = (g.sport || "").toUpperCase();
    const live = liveStateFor(findEspnEventForGameKey(g.key), g.sport);
    // Pregame soccer: prefer our actual kickoff time (Kalshi milestone feed)
    // over ESPN's vague "Scheduled".
    if (live && live.state === "pre") {
      const ko = kickoffLabel(g);
      if (ko) live.periodLabel = ko;
    }
    // Tennis cards: show full athlete names ("Matteo Berrettini vs Francisco
    // Comesana") joined with "vs". The matched ESPN competition carries the
    // correct names; the global athlete index can collide on 3-letter codes
    // (BER = Bertola OR Berrettini), so prefer the live-state names, then the
    // index, then the raw code.
    const isTennisCard = g.sport === "atp" || g.sport === "wta";
    const isNationalCard = g.sport === "wcup" || g.sport === "intlfriendly";
    const title = isTennisCard
      ? (live
          ? [live.away.name, live.home.name].filter(Boolean).join(" vs ")
          : (g.teams || []).map((a) => state.athleteIdx[a] || a).join(" vs "))
      : isNationalCard
        ? (g.teams || []).map((a) => NATIONAL_TEAMS[a] || a).join(" vs ")
        : (g.teams || []).join(" @ ");
    const dateHtml = g.dateLabel ? `<span class="game-date">${escapeHtml(g.dateLabel)}</span>` : "";
    const collapsed = !state.gameExpanded.has(g.key);
    const chevron = collapsed ? "▸" : "▾";

    // Pitcher-strikeout props we hold on THIS game, by last name — used to
    // highlight the matching ESPN starter / current pitcher.
    const heldKPitchers = new Set();
    for (const r of (g.legs || [])) {
      const pp = parsePlayerProp(r.ticker);
      if (pp && pp.stat === "KS" && pp.lastName) heldKPitchers.add(pp.lastName.toUpperCase());
    }
    const lastOf = (n) => (n || "").replace(/^[A-Z]\.\s*/, "").toUpperCase();

    // Enrich the live soccer situation with team stats from the summary
    // boxscore (possession / shots / shots-on-target / corners) + the
    // starting XI in formation (rosters: formation string, formationPlace
    // 1..11, jersey, sub flags) for the pitch panel.
    if (live && live.soccer) {
      const summary = state.boxscores[`${g.sport}:${live.raw?.id}`];
      const teams = summary?.boxscore?.teams;
      if (Array.isArray(teams) && teams.length === 2) {
        const pick = (t, name) =>
          (t?.statistics || []).find((s) => s?.name === name)?.displayValue;
        live.soccer.stats = teams.map((t) => ({
          abbr: t?.team?.abbreviation || "",
          poss: pick(t, "possessionPct"),
          shots: pick(t, "totalShots"),
          sot: pick(t, "shotsOnTarget"),
          corners: pick(t, "wonCorners"),
        }));
      }
      // Flag URLs for the pitch dots (ESPN has headshots for ~1/22 WC
      // starters — checked live 6/11 — so dots are circular flags instead).
      if (live.soccer.stats) {
        live.soccer.flagByAbbr = {};
        for (const t of live.soccer.stats) {
          live.soccer.flagByAbbr[t.abbr] =
            teamLogoUrl(g.sportLogoKey, t.abbr, { league: g.league }) || "";
        }
      }
      // Red cards: map sent-off athletes (by id) so the pitch can ghost them
      // — the visual "this team is down to 10".
      live.soccer.reds = {};
      for (const d of live.soccer.details || []) {
        if (!d?.redCard) continue;
        const a = (d.athletesInvolved || [])[0];
        if (a?.id) live.soccer.reds[String(a.id)] = d?.clock?.displayValue || "";
      }
      const rosters = summary?.rosters;
      if (Array.isArray(rosters) && rosters.length === 2) {
        live.soccer.lineups = {};
        live.soccer.subs = [];
        const subMin = (e) => {
          const pl = (e?.plays || []).find((p) => p?.substitution);
          return pl?.clock?.displayValue || "";
        };
        for (const r of rosters) {
          const abbr = r?.team?.abbreviation || "";
          const all = r?.roster || [];
          const byId = new Map(all.map((e) => [String(e?.athlete?.id || ""), e]));
          const byJersey = new Map(all.map((e) => [String(e?.jersey || ""), e]));
          const starters = all.filter((e) => e?.starter);
          // Resolve each formation spot to the player CURRENTLY in it: follow
          // the subbedOutFor chain (ESPN links pairs both ways) so a sub who
          // is later subbed off himself resolves to the latest man on.
          const resolve = (e, depth = 0) => {
            if (!e?.subbedOut || depth > 4) return e;
            const rep = e?.subbedOutFor;
            const repEntry = byId.get(String(rep?.athlete?.id || ""))
              || byJersey.get(String(rep?.jersey || ""));
            return repEntry ? resolve(repEntry, depth + 1) : e;
          };
          live.soccer.lineups[abbr] = {
            formation: r?.formation || "",
            players: starters.map((e) => {
              const cur = resolve(e);
              const swapped = cur !== e;
              const redMin = live.soccer.reds[String(cur?.athlete?.id || "")];
              return {
                place: parseInt(e?.formationPlace || "0", 10) || 0,
                jersey: cur?.jersey || "",
                name: cur?.athlete?.displayName || "",
                off: !swapped && !!e?.subbedOut,   // off w/ no known replacement
                on: swapped ? { min: subMin(cur), forName: e?.athlete?.displayName || "" } : null,
                red: redMin != null ? redMin : null,   // sent off -> team down a man
              };
            }),
          };
          // Timeline sub events from the roster pairs (the scoreboard
          // details[] feed doesn't carry substitutions).
          for (const e of all) {
            if (e?.subbedIn && e?.subbedInFor) {
              live.soccer.subs.push({
                team: abbr, min: subMin(e),
                inName: e?.athlete?.displayName || "",
                outName: e?.subbedInFor?.athlete?.displayName || "",
              });
            }
          }
        }
      }
    }

    // Enrich the live baseball situation with the current pitcher's workload
    // (pitch count derived from the summary's play-by-play, IP from the box
    // line) + a pull-risk flag, and flag if it's a pitcher whose K-prop we hold.
    if (live && live.baseball && live.baseball.pitcherId) {
      const summary = state.boxscores[`${g.sport}:${live.raw?.id}`];
      // Pitch count + strikeouts for the current pitcher, both derived from the
      // play-by-play (boxscore pitching is null early). A strikeout is a "Play
      // Result" whose text says "struck out", credited to the pitcher participant.
      let pitches = null, ks = null;
      if (summary && Array.isArray(summary.plays)) {
        pitches = 0; ks = 0;
        for (const pl of summary.plays) {
          const isOurs = (pl.participants || []).some((pt) => pt.type === "pitcher" && String(pt.athlete?.id) === String(live.baseball.pitcherId));
          if (!isOurs) continue;
          if (pl.summaryType === "P") pitches++;
          if (/struck out/i.test(pl.text || "")) ks++;
        }
      }
      live.baseball.pitches = pitches;
      live.baseball.ks = ks;
      live.baseball.pullRisk = pitches != null && pitches >= 85;
      live.baseball.pitcherHeld = heldKPitchers.has(lastOf(live.baseball.pitcher));

      // Current at-bat pitch locations for the strike-zone plot. Each pitch in
      // summary.plays carries pitchCoordinate {x,y} + a type; classify it as
      // strike (called/swinging/foul = red), ball (green), or in-play (blue).
      if (summary && Array.isArray(summary.plays) && live.baseball.batter) {
        const pitchPlays = summary.plays.filter((pl) => pl.summaryType === "P" && pl.pitchCoordinate);
        if (pitchPlays.length) {
          const curAb = pitchPlays[pitchPlays.length - 1].atBatId;
          live.baseball.abPitches = pitchPlays
            .filter((pl) => pl.atBatId === curAb)
            .map((pl) => {
              const t = ((pl.type || {}).text || "").toLowerCase();
              const cls = (t.includes("foul") || t.includes("strike")) ? "strike"
                        : t.includes("ball") ? "ball" : "inplay";
              return { x: pl.pitchCoordinate.x, y: pl.pitchCoordinate.y, cls, n: pl.atBatPitchNumber };
            });
        }
      }

      // If the last play was a pitch, pull its velocity + type from the matching
      // summary play (the scoreboard lastPlay.text has neither).
      if (summary && Array.isArray(summary.plays) && live.baseball.lastPlayId) {
        const lp = summary.plays.find((pl) => String(pl.id) === String(live.baseball.lastPlayId));
        if (lp && lp.pitchVelocity) {
          live.baseball.lastPitchMph = lp.pitchVelocity;
          live.baseball.lastPitchType = (lp.pitchType || {}).text || (lp.pitchType || {}).abbreviation || "";
        }
      }
    }

    // Enrich the NHL live situation from the /summary: each goalie's live line
    // (saves / SV% / GA), team penalty + power-play stats, recent penalties, and
    // shot coordinates for the rink plot. Mirrors the MLB block above.
    if (live && live.hockey) {
      const summary = state.boxscores[`${g.sport}:${live.raw?.id}`];
      const box = summary && summary.boxscore;
      if (box) {
        // The goalie with the most ice time on each team = the one who's played.
        const toiSec = (s) => { const [m, ss] = String(s || "0:00").split(":").map(Number); return (m || 0) * 60 + (ss || 0); };
        const goalieFor = (teamAbbr) => {
          for (const tp of box.players || []) {
            const ab = normAbbrForKalshi((tp.team?.abbreviation || "").toUpperCase(), "nhl");
            if (ab !== teamAbbr) continue;
            const grp = (tp.statistics || []).find((s) => s.name === "goalies");
            if (!grp || !(grp.athletes || []).length) return null;
            const keys = grp.keys || [];
            const idx = (k) => keys.indexOf(k);
            let best = null, bestToi = -1;
            for (const ath of grp.athletes) {
              const t = toiSec(ath.stats?.[idx("timeOnIce")]);
              if (t > bestToi) { bestToi = t; best = ath; }
            }
            if (!best) return null;
            const st = (k) => (idx(k) >= 0 ? best.stats?.[idx(k)] : null);
            return {
              name: best.athlete?.shortName || best.athlete?.displayName || "",
              saves: st("saves"), shotsAgainst: st("shotsAgainst"),
              savePct: st("savePct"), goalsAgainst: st("goalsAgainst"), toi: st("timeOnIce"),
            };
          }
          return null;
        };
        const teamStat = (teamAbbr) => {
          for (const t of box.teams || []) {
            const ab = normAbbrForKalshi((t.team?.abbreviation || "").toUpperCase(), "nhl");
            if (ab !== teamAbbr) continue;
            const m = {};
            for (const s of t.statistics || []) m[s.name] = s.displayValue;
            return m;
          }
          return null;
        };
        live.hockey.goalies = { away: goalieFor(live.away.abbr), home: goalieFor(live.home.abbr) };
        live.hockey.teamStats = { away: teamStat(live.away.abbr), home: teamStat(live.home.abbr) };
      }
      if (summary && Array.isArray(summary.plays)) {
        // Map ESPN team id -> our abbr so a goal can show the scoring team's logo
        // (play.team is just {id}). Built from the scoreboard competitors.
        const abbrById = {};
        for (const c of (live.raw?.competitions?.[0]?.competitors || [])) {
          const id = String(c?.team?.id || "");
          if (id) abbrById[id] = normAbbrForKalshi((c?.team?.abbreviation || "").toUpperCase(), "nhl");
        }
        const shots = [];
        for (const pl of summary.plays) {
          const c = pl.coordinate;
          if (!c || typeof c.x !== "number") continue;
          const t = (pl.type?.text || "").toLowerCase();
          let cls = null;
          if (pl.scoringPlay || t === "goal") cls = "goal";
          else if (t === "shot") cls = "shot";          // on goal (saved)
          else if (t === "missed" || t === "miss") cls = "miss";
          if (!cls) continue;
          const shot = { x: c.x, y: c.y, cls };
          if (cls === "goal") {
            const ab = abbrById[String(pl.team?.id || "")];
            if (ab) shot.logo = teamLogoUrl(g.sportLogoKey, ab, { league: g.league });
          }
          shots.push(shot);
        }
        live.hockey.shots = shots;
        // Penalty plays are typed by infraction ("Hooking", "Cross checking"),
        // not "Penalty" — the reliable marker is type.penaltyType / penaltyMinutes.
        live.hockey.penalties = summary.plays
          .filter((pl) => pl.type?.penaltyType || pl.type?.penaltyMinutes)
          .slice(-4)
          .map((pl) => ({ period: pl.period?.number, clock: pl.clock?.displayValue, text: pl.text || "" }));
      }
    }

    // Enrich the NBA live situation from the /summary: each team's shooting line
    // (FG / 3PT / REB / AST / TO), the scoring leaders, players in foul trouble,
    // the last play, and shot coordinates for the court plot. Mirrors the NHL
    // block above. The NBA scoreboard has no `situation`, so EVERYTHING here
    // comes from the summary.
    if (live && live.basketball) {
      const summary = state.boxscores[`${g.sport}:${live.raw?.id}`];
      const box = summary && summary.boxscore;
      // Last names of players whose props we hold on THIS game — used to bold a
      // foul-trouble name we have exposure on (the hoops analog to heldKPitchers).
      const heldProps = new Set();
      for (const r of (g.legs || [])) {
        const pp = parsePlayerProp(r.ticker);
        if (pp && pp.lastName) heldProps.add(pp.lastName.toUpperCase());
      }
      if (box) {
        const teamStat = (teamAbbr) => {
          for (const t of box.teams || []) {
            const ab = normAbbrForKalshi((t.team?.abbreviation || "").toUpperCase(), "nba");
            if (ab !== teamAbbr) continue;
            const raw = {};
            for (const s of t.statistics || []) raw[s.name] = s.displayValue;
            return {
              fg: raw["fieldGoalsMade-fieldGoalsAttempted"],
              fgPct: raw.fieldGoalPct,
              tp: raw["threePointFieldGoalsMade-threePointFieldGoalsAttempted"],
              reb: raw.totalRebounds, ast: raw.assists, to: raw.totalTurnovers ?? raw.turnovers,
            };
          }
          return null;
        };
        live.basketball.teamStats = { away: teamStat(live.away.abbr), home: teamStat(live.home.abbr) };
        // Foul trouble: anyone with 4+ personal fouls who has played. Bold if we
        // hold one of their props.
        const fouls = [];
        for (const tp of box.players || []) {
          const grp = (tp.statistics || [])[0];
          if (!grp || !(grp.athletes || []).length) continue;
          const keys = grp.keys || [];
          const pfI = keys.indexOf("fouls"), minI = keys.indexOf("minutes");
          if (pfI < 0) continue;
          for (const ath of grp.athletes) {
            const pf = parseInt(ath.stats?.[pfI] ?? "", 10);
            const min = parseInt(ath.stats?.[minI] ?? "", 10);
            if (!Number.isFinite(pf) || pf < 4 || !(min > 0)) continue;
            const name = ath.athlete?.shortName || ath.athlete?.displayName || "";
            const last = (name.split(/\s+/).pop() || "").toUpperCase();
            fouls.push({ name, pf, held: heldProps.has(last) });
          }
        }
        live.basketball.foulTrouble = fouls.sort((a, b) => b.pf - a.pf).slice(0, 6);
      }
      // Scoring / rebound / assist leaders per team.
      if (summary && Array.isArray(summary.leaders)) {
        const fmt = (L, key, sfx) => {
          const cat = (L.leaders || []).find((x) => x.name === key);
          const top = cat?.leaders?.[0];
          return top ? `${top.athlete?.shortName || ""} ${top.displayValue}${sfx}` : "";
        };
        const leadersFor = (teamAbbr) => {
          for (const L of summary.leaders) {
            const ab = normAbbrForKalshi((L.team?.abbreviation || "").toUpperCase(), "nba");
            if (ab !== teamAbbr) continue;
            return { pts: fmt(L, "points", "p"), reb: fmt(L, "rebounds", "r"), ast: fmt(L, "assists", "a") };
          }
          return null;
        };
        live.basketball.leaders = { away: leadersFor(live.away.abbr), home: leadersFor(live.home.abbr) };
      }
      if (summary && Array.isArray(summary.plays) && summary.plays.length) {
        // Map ESPN team id -> {side, abbr} so a shot lands on the right half of
        // the court (home left / away right) and a make can show its team logo.
        const sideById = {}, abbrById = {};
        for (const c of (live.raw?.competitions?.[0]?.competitors || [])) {
          const id = String(c?.team?.id || "");
          if (!id) continue;
          const ab = normAbbrForKalshi((c?.team?.abbreviation || "").toUpperCase(), "nba");
          abbrById[id] = ab;
          sideById[id] = ab === live.away.abbr ? "away" : "home";
        }
        const shots = [];
        for (const pl of summary.plays) {
          if (!pl.shootingPlay) continue;
          const c = pl.coordinate;
          // Free throws / tip-offs carry a sentinel coordinate (~-2.1e9); skip.
          if (!c || typeof c.x !== "number" || Math.abs(c.x) > 1000) continue;
          const id = String(pl.team?.id || "");
          const make = !!pl.scoringPlay;
          const shot = { x: c.x, y: c.y, make, three: pl.pointsAttempted === 3, team: sideById[id] || "away" };
          // Made shots render as the shooting team's logo (NHL-goal style).
          if (make && abbrById[id]) shot.logo = teamLogoUrl(g.sportLogoKey, abbrById[id], { league: g.league });
          shots.push(shot);
        }
        live.basketball.shots = shots;
        live.basketball.lastPlay = summary.plays[summary.plays.length - 1]?.text || "";
      }
    }

    let scorePanel = "";
    if (!live) {
      // No ESPN data for this game (e.g. a lower-tier international friendly ESPN
      // doesn't cover). Fall back to Kalshi's own data: show the live/final SCORE
      // from /live_data when the match is underway/over, otherwise our kickoff
      // time from the milestone feed. (g.teams is in title order = [home, away].)
      const sc = soccerScoreForGame(g);
      if (sc) {
        const dot = sc.matchStatus === "live" ? "live-dot live" : "live-dot post";
        const label = sc.statusText || sc.half || (sc.matchStatus === "live" ? "Live" : "Final");
        const teams = g.teams || [];
        const homeName = NATIONAL_TEAMS[teams[0]] || teams[0] || "Home";
        const awayName = NATIONAL_TEAMS[teams[1]] || teams[1] || "Away";
        scorePanel = `
        <div class="score-panel">
          <div class="score-status"><span class="${dot}"></span><span>${escapeHtml(label)}</span></div>
          <div class="score-team ${sc.winner === "home" ? "leading" : ""}"><span class="score-name">${escapeHtml(homeName)}</span><span class="score-num">${sc.home}</span></div>
          <div class="score-team ${sc.winner === "away" ? "leading" : ""}"><span class="score-name">${escapeHtml(awayName)}</span><span class="score-num">${sc.away}</span></div>
        </div>`;
      } else {
        const ko = kickoffLabel(g);
        if (ko) {
          scorePanel = `
          <div class="score-panel">
            <div class="score-status"><span class="live-dot pre"></span><span>${escapeHtml(ko)}</span></div>
          </div>`;
        }
      }
    }
    if (live) {
      const dotCls = live.state === "in" ? "live-dot live" : live.state === "post" ? "live-dot post" : "live-dot pre";
      const probName = (n) => `<span class="${heldKPitchers.has(lastOf(n)) ? "sp-held" : ""}">${escapeHtml(n)}</span>`;
      const probablesHtml = live.probables
        ? `<div class="bb-probables"><span class="bb-role">SP</span>${probName(live.probables.away)}<span class="sp-vs">vs</span>${probName(live.probables.home)}</div>`
        : "";
      // NHL probable starting goalies (pregame), with a ✓ when confirmed.
      const probGoalie = (gl) => gl ? `${escapeHtml(gl.name)}${gl.confirmed ? " <span class=\"sp-conf\" title=\"confirmed\">✓</span>" : ""}` : "TBD";
      const goaliesHtml = live.probableGoalies
        ? `<div class="bb-probables"><span class="bb-role">G</span>${probGoalie(live.probableGoalies.away)}<span class="sp-vs">vs</span>${probGoalie(live.probableGoalies.home)}</div>`
        : "";
      const awayLeading = live.state !== "pre" && live.away.score > live.home.score;
      const homeLeading = live.state !== "pre" && live.home.score > live.away.score;
      const teamRow = (t, leading) => {
        const logoUrl = teamLogoUrl(g.sportLogoKey, t.abbr, { league: g.league });
        const logoImg = logoUrl
          ? `<img class="team-logo" src="${logoUrl}" alt="${escapeHtml(t.abbr)}" onerror="this.style.display='none'" loading="lazy" decoding="async">`
          : "";
        return `
          <div class="score-team ${leading ? "leading" : ""}">
            <span class="score-logo">${logoImg}</span>
            <span class="score-abbr">${escapeHtml(t.abbr)}</span>
            <span class="score-name">${escapeHtml(t.name)}</span>
            ${t.record ? `<span class="score-record">${escapeHtml(t.record)}</span>` : ""}
            <span class="score-num">${live.state === "pre" ? "" : t.score}</span>
          </div>`;
      };
      scorePanel = `
        <div class="score-panel">
          <div class="score-status"><span class="${dotCls}"></span><span>${escapeHtml(live.periodLabel)}</span></div>
          ${teamRow(live.away, awayLeading)}
          ${teamRow(live.home, homeLeading)}
          ${probablesHtml}
          ${goaliesHtml}
          ${live.baseball ? bbSituationHtml(live.baseball) : ""}
          ${live.hockey ? hockeySituationHtml(live.hockey) : ""}
          ${live.basketball ? nbaSituationHtml(live.basketball) : ""}
          ${live.soccer ? soccerSituationHtml(live.soccer) : ""}
        </div>`;
    }

    // ---- Bucket pending legs ----
    //   teamBuckets : per-team ML and SPREAD legs, grouped under the team
    //                they're on (long-NO on SAS3 lives in SAS's bucket).
    //   sharedTotal : TOTAL legs render under both teams as a "Total" ladder.
    //   sharedOther : remaining game-level legs (F5, RFI, BTTS, 1H, etc.) we
    //                don't yet parse into a predicate — flat list for now.
    //   playerGroups: as before.
    const teamBuckets = new Map();    // abbr -> {ml: [{row,parsed}], spread: [{row,parsed}]}
    const sharedTotal = [];           // [{row, parsed}]
    const sharedRfi = [];             // [{row, parsed}] — MLB Run-in-First-Inning
    const sharedBtts = [];            // [{row, parsed}] — soccer Both-Teams-To-Score
    const sharedDraw = [];            // [{row, parsed}] — soccer 3-way TIE legs
    const sharedOther = new Map();    // groupName -> [row]
    const playerGroups = new Map();
    const otherLegs = [];
    for (const r of g.legs) {
      const groupName = legGameLevelGroup(r.ticker);
      if (groupName) {
        const parsed = parseGameLevelLeg(r.ticker);
        if (parsed?.kind === "ml") {
          // ML chip = "we want this team to win". Bucket under the team WE
          // cheer for (= opposite of buyer's effective pick, since we hold
          // parlay-NO). So a buyer-YES on DET ML and a buyer-NO on LAA ML
          // both land under LAA (we win either when LAA wins).
          //
          // SOCCER (3-way, 2026-06-11): "not X" is NOT "Y wins" — the draw
          // also goes our way. So buyer-YES on X buckets under Y but in a
          // separate "Win or draw" ladder (the old bare "ML" chip silently
          // dropped the draw half of our cheer). TIE legs get their own
          // shared Draw row — bucketing them under a team was just wrong.
          const isSoccer3Way = _SOCCER_TREE_SPORTS.has(parsed.sport);
          const buyerYes = (r.buyerSide || "yes").toLowerCase() === "yes";
          if (isSoccer3Way && parsed.pick === "TIE") {
            sharedDraw.push({ row: r, parsed });
          } else {
            const ab = ourCheeredTeam(parsed, r.buyerSide);
            if (!teamBuckets.has(ab)) teamBuckets.set(ab, { ml: [], mlOrDraw: [], spread: [] });
            if (isSoccer3Way && buyerYes) {
              // Buyer needs PICK to win; we cheer the other team OR a draw.
              teamBuckets.get(ab).mlOrDraw.push({ row: r, parsed });
            } else {
              teamBuckets.get(ab).ml.push({ row: r, parsed });
            }
          }
        } else if (parsed?.kind === "spread") {
          // Bucket under the team WE (long-NO) cheer for to cover the
          // line. Same convention as ML — chip always describes what we
          // want to have happen. Buyer-YES on TEAM means we cheer for the
          // opposing dog; buyer-NO on TEAM means we cheer for TEAM as
          // favorite. The chip-label code signs the spread accordingly
          // (+ if our team is the dog, - if our team is the favorite).
          const ab = ourCheeredTeam(parsed, r.buyerSide);
          if (!teamBuckets.has(ab)) teamBuckets.set(ab, { ml: [], mlOrDraw: [], spread: [] });
          teamBuckets.get(ab).spread.push({ row: r, parsed });
        } else if (parsed?.kind === "total") {
          sharedTotal.push({ row: r, parsed });
        } else if (parsed?.kind === "btts") {
          sharedBtts.push({ row: r, parsed });
        } else if (parsed?.kind === "rfi") {
          sharedRfi.push({ row: r, parsed });
        } else {
          if (!sharedOther.has(groupName)) sharedOther.set(groupName, []);
          sharedOther.get(groupName).push(r);
        }
        continue;
      }
      const prop = parsePlayerProp(r.ticker);
      if (prop && prop.team && prop.lastName) {
        const key = `${prop.team}|${prop.lastName}`;
        let pg = playerGroups.get(key);
        if (!pg) {
          pg = {
            team: prop.team,
            lastName: prop.lastName,
            jersey: prop.jersey,
            prop,
            meta: findAthleteMeta(prop, state.boxscores),
            legs: [],
          };
          playerGroups.set(key, pg);
        }
        pg.legs.push({ row: r, prop });
        continue;
      }
      otherLegs.push(r);
    }

    // Per-leg row HTML used by both game and player sections.
    const legRowHtml = (r, prop) => {
      const desc = legLabel(r.ticker, r.ourSide, state.athleteIdx, _floorStrikeByTicker[r.ticker]);
      const pUsPct = r.pUs != null ? `${(r.pUs * 100).toFixed(0)}%` : "—";
      let liveStat = "";
      if (prop) {
        const pr = resolvePlayerProp(prop, state.scoreboards, state.boxscores);
        if (pr && pr.current != null) {
          // Color from OUR perspective: over the threshold is bad on an under
          // leg (buyer-yes) but GOOD on an over hedge leg (buyer-no).
          const overThreshold = pr.current >= prop.threshold;
          const ourOver = (r.buyerSide || "yes").toLowerCase() === "no";
          const goodForUs = ourOver ? overThreshold : !overThreshold;
          liveStat = `<span class="cheer-live ${goodForUs ? "pos" : "neg"}" title="player's current value vs threshold">${pr.current} / ${prop.threshold}</span>`;
        }
      } else if (r.statText) {
        liveStat = `<span class="cheer-live" title="current game state">${escapeHtml(r.statText)}</span>`;
      }
      const isOffset = g.offsettingVars?.has(_legVarKey(r.ticker));
      const offsetTag = isOffset
        ? `<span class="offset-tag" title="Dual-direction flow on this market — offsetting positions cancel against the other side.">⇄ offset</span>`
        : "";
      return `
        <div class="cheer-row">
          <div class="cheer-desc">
            <span>${escapeHtml(desc)}</span>
            ${offsetTag}
            ${liveStat}
          </div>
          <div class="cheer-meta">
            <span title="parlays this leg appears in">in ${r.parlays}</span>
            <span title="$ we lose if this leg hits the buyer's way">at risk ${fmtMoney(r.exposure)}</span>
            <span class="pos" title="$ we win if this leg breaks our way">+${r.maxWin.toFixed(2)}</span>
            <span title="estimated chance this leg breaks our way">${pUsPct}</span>
          </div>
        </div>`;
    };

    // ---- Game-level section ----
    // Live scenario for chip color + "current" displays (from the score
    // panel). Pregame -> null -> chips render as pending grey.
    const liveSc = live && live.state !== "pre"
      ? {
          margin: live.home.score - live.away.score,
          total: live.away.score + live.home.score,
          awayScore: live.away.score,
          homeScore: live.home.score,
          firstInningRuns: live.firstInningRuns,
        }
      : null;
    // Chip-builder shared by ML/Spread/Total ladders. parsed.kind drives
    // the chip label so the same ladder renderer works for all three.
    const gameChipHtml = ({ row, parsed }) => {
      const buyerSide = (row.buyerSide || "yes").toLowerCase();
      const res = liveSc ? evalGameLegInScenario(parsed, buyerSide, liveSc) : "unknown";
      // Locked-loss strikethrough only when the bad-for-us outcome is
      // permanent. Totals are monotonic so market-YES is permanent once
      // it flips, but market-NO isn't (mid-game the total can still climb
      // past the line) — so buyer-NO totals don't lock until game post.
      // RFI is only emitted once the 1st inning is done, so either side
      // is permanent at that point. ML / spread mid-game never lock since
      // the score can still flip; only post-game locks them.
      const stateIsPost = live?.state === "post";
      let lockedLoss = false;
      if (res === "buyer_hit") {
        if (stateIsPost) {
          lockedLoss = true;
        } else if (parsed.kind === "rfi") {
          lockedLoss = true;
        } else if ((parsed.kind === "total" || parsed.kind === "btts") && buyerSide === "yes") {
          // Over-total and BTTS-yes are monotonic: once crossed they can't
          // un-cross, so a buyer hit is permanently against us.
          lockedLoss = true;
        }
      }
      // Symmetric: when have we LOCKED a win (buyer permanently misses)?
      let lockedWin = false;
      if (res === "buyer_miss") {
        if (stateIsPost) lockedWin = true;
        else if (parsed.kind === "rfi") lockedWin = true;
        else if ((parsed.kind === "total" || parsed.kind === "btts") && buyerSide === "no") {
          // buyer-no on a monotonic market: a miss means the over/both already
          // happened, so the buyer's under is permanently busted (our win).
          lockedWin = true;
        }
      }
      // locked tri-state; mid-game ML/spread stay null and color by the market %.
      const locked = lockedWin ? true : lockedLoss ? false : null;
      const sign = chipSignClass(row.pUs, locked);
      const style = chipShadeStyle(row.pUs, locked);
      const cls = sign + (lockedLoss ? " locked-loss" : "");
      const pUsPct = row.pUs != null ? `${(row.pUs * 100).toFixed(0)}%` : "—";
      let chipLabel;
      if (parsed.kind === "ml") {
        // Chip is rendered under the effective-pick team (after buyer-side
        // flip), so the chip itself is always "the displayed team wins" -—
        // i.e., "win" regardless of original buyer side. Soccer TIE legs
        // live in the shared Draw ladder: chip text states OUR cheer
        // explicitly (buyer-YES on TIE => we want anything but a draw).
        chipLabel = parsed.pick === "TIE"
          ? (buyerSide === "yes" ? "no draw" : "draw")
          : "win";
      } else if (parsed.kind === "spread") {
        // Chip displays our cheering perspective at the market's REAL line
        // (floor_strike), not a ticker-integer guess. Buyer-YES on TEAM: we
        // cheer the OPPOSING dog at +line; Buyer-NO: TEAM at −line.
        const sign = buyerSide === "yes" ? "+" : "-";
        const line = _lineForTicker(row.ticker, parsed.threshold);
        chipLabel = `${sign}${line}`;
      } else if (parsed.kind === "total") {
        // Same rule for total: show OUR side at the real line (floor_strike).
        // Buyer-YES (over) -> we cheer under; buyer-NO -> over.
        const line = _lineForTicker(row.ticker, parsed.threshold);
        chipLabel = buyerSide === "yes" ? `u${line}` : `o${line}`;
      } else if (parsed.kind === "rfi") {
        // RFI is binary "any run in 1st". Buyer-YES (a run scored) -> we
        // cheer for under 1 (no run); buyer-NO -> we cheer for over 1.
        chipLabel = buyerSide === "yes" ? "u1" : "o1";
      } else if (parsed.kind === "btts") {
        // Both-Teams-To-Score. Our long-NO side: buyer-YES -> we cheer for
        // NOT both scoring ("NG"); buyer-NO -> we cheer for both ("GG").
        chipLabel = buyerSide === "yes" ? "NG" : "GG";
      } else {
        chipLabel = "?";
      }
      const tip =
        `In ${row.parlays} parlay${row.parlays === 1 ? "" : "s"} · at risk ${fmtMoney(row.exposure)} · ` +
        `+$${row.maxWin.toFixed(2)} if it breaks our way · win chance ${pUsPct}` +
        (res === "buyer_hit" ? " · currently AGAINST us"
          : res === "buyer_miss" ? " · currently FOR us"
          : "");
      // ML is a binary "team wins" — no threshold to label since the
      // bucket team already tells you who. Render just the meta. Soccer
      // TIE chips DO show their text (draw / no draw) — there's no team
      // head to carry the meaning.
      const showThresh = parsed.kind !== "ml" || parsed.pick === "TIE";
      return `
        <span class="ladder-chip ${cls}${showThresh ? "" : " no-thresh"}" style="${style}" title="${escapeHtml(tip)}">
          ${showThresh ? `<span class="ladder-chip-thresh">${escapeHtml(chipLabel)}</span>` : ""}
          <span class="ladder-chip-meta">
            +$${row.maxWin.toFixed(0)}<span class="ladder-chip-sep">·</span>${pUsPct}
          </span>
        </span>`;
    };
    const gameLadderHtml = (label, items, currentText) => {
      if (!items.length) return "";
      const chips = items.slice()
        .sort((a, b) => (a.parsed.threshold || 0) - (b.parsed.threshold || 0))
        .map(gameChipHtml).join("");
      // Tag the row when this market carries dual-direction flow that nets
      // against the opposite side (e.g. we hold both teams' ML).
      const isOffset = items.some((it) => g.offsettingVars?.has(_legVarKey(it.row.ticker)));
      const offsetTag = isOffset
        ? ` <span class="offset-tag" title="Dual-direction flow on this market — offsetting positions cancel against the other side.">⇄ offset</span>`
        : "";
      // Only render a "current" cell if we actually have a number to show.
      // ML row (and any other lookless row) leaves it out instead of "—".
      const currentChip = currentText != null
        ? `<span class="stat-current">${escapeHtml(currentText)}</span>`
        : "";
      return `
        <div class="stat-ladder">
          <div class="stat-ladder-head">
            <span class="stat-label">${escapeHtml(label)}${offsetTag}</span>
            ${currentChip}
          </div>
          <div class="stat-ladder-chips">${chips}</div>
        </div>`;
    };

    let gameSection = "";
    // Soccer game => 3-way wording on the ML ladders ("To win" / "Win or
    // draw") instead of the 2-way "ML".
    const isSoccerGame = g.legs.length > 0 &&
      _SOCCER_TREE_SPORTS.has(legSport(g.legs[0].ticker));
    if (teamBuckets.size > 0 || sharedTotal.length > 0 || sharedBtts.length > 0 || sharedDraw.length > 0 || sharedRfi.length > 0 || sharedOther.size > 0 || otherLegs.length > 0) {
      // Team display order: away then home (matches the score panel). Falls
      // back to insertion order when there's no ESPN match.
      const orderedTeams = live
        ? [live.away.abbr, live.home.abbr].filter((ab) => teamBuckets.has(ab))
        : [...teamBuckets.keys()];
      // Any team-bucket entries that didn't match the score panel get appended
      // (e.g. a stale ticker or a sport where we couldn't find an event).
      for (const ab of teamBuckets.keys()) {
        if (!orderedTeams.includes(ab)) orderedTeams.push(ab);
      }
      const teamBlocks = orderedTeams.map((ab) => {
        const b = teamBuckets.get(ab);
        const isHome = live && live.home.abbr === ab;
        const teamScore = liveSc
          ? (isHome ? live.home.score : (live.away.abbr === ab ? live.away.score : null))
          : null;
        const oppScore = liveSc
          ? (isHome ? live.away.score : (live.away.abbr === ab ? live.home.score : null))
          : null;
        const teamMargin = (teamScore != null && oppScore != null) ? teamScore - oppScore : null;
        const logoUrl = teamLogoUrl(g.sportLogoKey, ab, { league: g.league });
        const logo = logoUrl
          ? `<img class="player-head" src="${logoUrl}" alt="${escapeHtml(ab)}" onerror="this.style.display='none'" loading="lazy" decoding="async">`
          : `<div class="player-head fallback">${escapeHtml(ab.slice(0, 1))}</div>`;
        const headLine = teamScore != null
          ? `score ${teamScore}${teamMargin != null ? ` · ${teamMargin > 0 ? "leading by " + teamMargin : teamMargin < 0 ? "trailing by " + (-teamMargin) : "tied"}` : ""}`
          : (live?.periodLabel || "");
        const teamHead = `
          <div class="player-head-row">
            ${logo}
            <div class="player-meta">
              <div class="player-name">${escapeHtml(ab)}</div>
              <div class="player-pos">${escapeHtml(headLine)}</div>
            </div>
          </div>`;
        // ML doesn't take a "current" — the team head already shows the score
        // and lead state. Spread row shows the team's live margin in VEGAS
        // orientation (same as the spread chips beside it): leading => negative
        // (laying points, e.g. up 6 = "-6"), trailing => positive ("+3"), tied 0.
        const spreadCurrent = teamMargin != null
          ? (teamMargin > 0 ? `-${teamMargin}` : teamMargin < 0 ? `+${-teamMargin}` : "0")
          : null;
        return `
          <div class="player-block">
            ${teamHead}
            ${gameLadderHtml(isSoccerGame ? "To win" : "ML", b.ml, null)}
            ${gameLadderHtml("Win or draw", b.mlOrDraw || [], null)}
            ${gameLadderHtml("Spread", b.spread, spreadCurrent)}
          </div>`;
      }).join("");

      // Shared TOTAL row under both teams (with live total points).
      const totalCurrent = liveSc ? String(liveSc.total) : null;
      const totalBlock = sharedTotal.length
        ? `<div class="player-block shared-block">${gameLadderHtml("Total", sharedTotal, totalCurrent)}</div>`
        : "";
      // Shared RFI row — current = live first-inning-runs count once the
      // 1st inning has resolved, else blank.
      const rfiCurrent = liveSc?.firstInningRuns != null ? String(liveSc.firstInningRuns) : null;
      const rfiBlock = sharedRfi.length
        ? `<div class="player-block shared-block">${gameLadderHtml("Run in 1st", sharedRfi, rfiCurrent)}</div>`
        : "";
      // Shared BTTS row — counter shows the live score so you can see how
      // close both teams are to scoring (e.g. "1-0" = home needs one more).
      const bttsCurrent = liveSc ? `${liveSc.awayScore}-${liveSc.homeScore}` : null;
      const bttsBlock = sharedBtts.length
        ? `<div class="player-block shared-block">${gameLadderHtml("Both teams score", sharedBtts, bttsCurrent)}</div>`
        : "";
      // Shared DRAW row (soccer 3-way TIE legs) — chips say "draw"/"no draw"
      // from OUR cheering POV; counter shows tied-or-not while live.
      const drawCurrent = liveSc
        ? (liveSc.margin === 0 ? "tied" : `${liveSc.margin > 0 ? "+" : ""}${liveSc.margin}`)
        : null;
      const drawBlock = sharedDraw.length
        ? `<div class="player-block shared-block">${gameLadderHtml("Draw", sharedDraw, drawCurrent)}</div>`
        : "";

      // Remaining game-level legs we don't parse (F5/RFI/BTTS/1H/etc.) — flat
      // group list until we add predicate evaluators for them.
      const otherBlocks = [...sharedOther.entries()].map(([name, items]) => `
        <div class="leg-group">
          <div class="leg-group-head">${escapeHtml(name)}</div>
          ${items.map((row) => legRowHtml(row, null)).join("")}
        </div>`).join("");
      const otherTickers = otherLegs.length ? `
        <div class="leg-group">
          <div class="leg-group-head">Other</div>
          ${otherLegs.map((row) => legRowHtml(row, parsePlayerProp(row.ticker))).join("")}
        </div>` : "";

      gameSection = `
        <div class="card-section">
          <div class="section-title">Game</div>
          ${teamBlocks}${drawBlock}${totalBlock}${bttsBlock}${rfiBlock}${otherBlocks}${otherTickers}
        </div>`;
    }

    // ---- Player section ----
    let playerSection = "";
    if (playerGroups.size > 0) {
      const players = [...playerGroups.values()].sort((a, b) => {
        const aMax = Math.max(...a.legs.map((l) => l.row.maxWin));
        const bMax = Math.max(...b.legs.map((l) => l.row.maxWin));
        return bMax - aMax;
      });
      const blocks = players.map((p) => {
        const meta = p.meta || {};
        const pretty = p.lastName.charAt(0) + p.lastName.slice(1).toLowerCase();
        const headshot = meta.headshot
          ? `<img class="player-head" src="${meta.headshot}" alt="${escapeHtml(pretty)}" onerror="this.style.display='none'" loading="lazy" decoding="async">`
          : `<div class="player-head fallback">${escapeHtml(p.lastName.slice(0, 1))}</div>`;
        const jersey = meta.jersey || p.jersey;
        const posCell = [p.team, meta.position, jersey ? `#${jersey}` : ""].filter(Boolean).join(" · ");

        // Group this player's legs by stat code (PTS / REB / 3PT / HIT / KS
        // / ...). For each stat we resolve the player's current value once
        // and render a compact ladder of thresholds as chips. A "u25" chip
        // is green when current < 25 (still alive for us), red when
        // current >= 25 (buyer locked it), grey when no current is known.
        const byStat = new Map();
        for (const it of p.legs) {
          const s = it.prop.stat;
          if (!byStat.has(s)) byStat.set(s, []);
          byStat.get(s).push(it);
        }
        // Stat-display ordering: high-volume / headline stats first.
        const STAT_ORDER = [
          "PTS", "REB", "AST", "3PT", "STL", "BLK",
          "HIT", "HR", "HRR", "TB", "RBI", "R", "BB",
          "KS", "IP",
        ];
        const orderedStats = [...byStat.keys()].sort((a, b) => {
          const ai = STAT_ORDER.indexOf(a);
          const bi = STAT_ORDER.indexOf(b);
          return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        });
        const ladders = orderedStats.map((stat) => {
          // Sort by threshold; at an equal threshold put our under (buyer-yes)
          // before our over (buyer-no) so a hedged pair reads "u8 o8".
          const items = byStat.get(stat).slice().sort((a, b) =>
            (a.prop.threshold - b.prop.threshold) ||
            (((a.row.buyerSide || "yes") === "no") - ((b.row.buyerSide || "yes") === "no")));
          const sampleProp = items[0].prop;
          const pr = resolvePlayerProp(sampleProp, state.scoreboards, state.boxscores);
          const current = pr?.current;
          const currentChip = current != null
            ? `<span class="stat-current">${current}</span>`
            : `<span class="stat-current pending">—</span>`;
          const chips = items.map(({ row, prop }) => {
            // Monotonic stats: once current crosses threshold the market
            // YES is permanently true. That's locked-loss only if WE
            // hold the buyer's opposite — i.e., buyer-yes leg with dead.
            // Buyer-no leg with dead means buyer LOSES (we won) — no
            // strikethrough on a win.
            const dead = current != null && current >= prop.threshold; // over hit
            const buyerSide = (row.buyerSide || "yes").toLowerCase();
            // Our side: buyer-yes => we're UNDER (long NO); buyer-no => we hold
            // the OVER (the hedge leg). Label/tooltip flip on this; the locked
            // logic below is already side-aware.
            const ourOver = buyerSide === "no";
            // locked tri-state from OUR perspective: true = we've locked the
            // win, false = locked the loss, null = still live (color by market).
            //   over hit  -> buyer-yes loses us / buyer-no wins us
            //   under locked (frozen, still short) -> buyer-yes wins us / buyer-no loses us
            let locked = null;
            if (dead) locked = buyerSide === "yes" ? false : true;
            else if (current != null && pr?.frozen) locked = buyerSide === "yes" ? true : false;
            const lockedLoss = locked === false;
            const sign = chipSignClass(row.pUs, locked);
            const style = chipShadeStyle(row.pUs, locked);
            const cls = sign + (lockedLoss ? " locked-loss" : "");
            const pUsPct = row.pUs != null ? `${(row.pUs * 100).toFixed(0)}%` : "—";
            const tip =
              (ourOver
                ? `Buyer needs ${stat} < ${prop.threshold} (we're OVER — need ${stat} ≥ ${prop.threshold}).\n`
                : `Buyer needs ${stat} ≥ ${prop.threshold} (we're under ${prop.threshold}).\n`) +
              `${current != null ? `Current ${stat}: ${current} — ${dead ? (ourOver ? "we hit it (locked win)" : "buyer hit it (locked loss)") : "still alive"}\n` : ""}` +
              `In ${row.parlays} parlay${row.parlays === 1 ? "" : "s"} · at risk ${fmtMoney(row.exposure)} · ` +
              `+$${row.maxWin.toFixed(2)} if it breaks our way · win chance ${pUsPct}`;
            return `
              <span class="ladder-chip ${cls}" style="${style}" title="${escapeHtml(tip)}">
                <span class="ladder-chip-thresh">${ourOver ? "o" : "u"}${prop.threshold}</span>
                <span class="ladder-chip-meta">
                  +$${row.maxWin.toFixed(0)}<span class="ladder-chip-sep">·</span>${pUsPct}
                </span>
              </span>`;
          }).join("");
          // Flag the stat when we hold dual-direction (over+under) flow on it —
          // same offsetting-var test the quoter and game ladders use.
          const isOffset = items.some((it) => g.offsettingVars?.has(_legVarKey(it.row.ticker)));
          const offsetTag = isOffset
            ? ` <span class="offset-tag" title="Dual-direction flow on this stat — over and under legs cancel against each other.">⇄ offset</span>`
            : "";
          return `
            <div class="stat-ladder">
              <div class="stat-ladder-head">
                <span class="stat-label">${escapeHtml(stat)}${offsetTag}</span>
                ${currentChip}
              </div>
              <div class="stat-ladder-chips">${chips}</div>
            </div>`;
        }).join("");
        return `
          <div class="player-block">
            <div class="player-head-row">
              ${headshot}
              <div class="player-meta">
                <div class="player-name">${escapeHtml(meta.displayName || pretty)}</div>
                <div class="player-pos">${escapeHtml(posCell)}</div>
              </div>
            </div>
            ${ladders}
          </div>`;
      }).join("");
      playerSection = `
        <div class="card-section">
          <div class="section-title">Players</div>
          ${blocks}
        </div>`;
    }

    const bodyContent = `${gameSection}${playerSection}`;

    // resolvedNote retired — resolved legs now render inline (green for
    // wins, red+strikethrough for losses) so the count line is redundant.
    const resolvedNote = "";

    // "If the game goes…" — a decision tree branching on the variables we
    // hold legs on (winner → total → biggest prop). Each node shows its
    // best..worst $ envelope; the favorable branch at each fork is flagged so
    // a glance tells you what to root for. Overall worst/best up top.
    // Live context so the tree can pin what's already happened (winner once
    // final, total over a crossed line, the 1st-inning result, a prop that's
    // already hit) and only branch what's still undecided. Pregame → null.
    const treeLive = liveSc ? {
      final: !!(live && live.state === "post"),
      margin: liveSc.margin,
      total: liveSc.total,
      firstInningRuns: liveSc.firstInningRuns,
      bothScored: liveSc.awayScore > 0 && liveSc.homeScore > 0,
      propResolve: (pr) => resolvePlayerProp(pr, state.scoreboards, state.boxscores),
      // Projected-finish inputs for the risk-grid ✕ marker (NOT used by the
      // tree, which keys off the CURRENT total). proj50 = Kalshi 50/50 line
      // (preferred); fracRemaining drives the pace-blend fallback.
      proj50: state.proj50ByGame[g.key] != null ? state.proj50ByGame[g.key] : null,
      fracRemaining: gameFracRemaining(live, g.sport),
    } : null;
    // 2D risk surface (margin × total) on EVERY game card (2026-06-11: the
    // scenario tree was removed — it earned its complexity for player-prop
    // books, but the book is game-level-only now and the grid shows the same
    // information better: full outcome envelope, expected mark, live ✕,
    // hedge shape). computeRiskGrid returns null when a card has no
    // game-level legs, which renders as nothing. Wrapped with the fill
    // scrubber (2026-06-12) when the game has 2+ fills to replay, topped by
    // the most-likely-scores summary strip (soccer only).
    const scoreSummaryHtml = renderScoreSummaryHtml(computeRiskGrid(g, state.positions, treeLive));
    const riskGridHtml = scoreSummaryHtml + renderGridWithScrubber(g, treeLive);
    const momentumHtml = renderMomentumHtml(g);

    return `
      <div class="game-card${collapsed ? " collapsed" : ""}" data-game-key="${escapeHtml(g.key)}">
        <div class="game-card-head" role="button" tabindex="0">
          <div class="game-title">
            <span class="card-chevron">${chevron}</span>
            <span class="sport-badge">${escapeHtml(sport)}</span>
            <span class="game-logos">${logos}</span>
            <span class="game-name">${escapeHtml(title)}</span>
            ${dateHtml}
            ${g.hedged ? `<span class="hedge-badge" title="Dual-direction flow: opposing positions on this game cancel out. ${g.offsetPct}% of the $${g.exposure.toFixed(2)} gross at-risk is netted away — worst-case net loss is $${g.worstCase.toFixed(2)} (the number the quoter caps against).">⇄ HEDGED ${g.offsetPct}%</span>` : ""}
          </div>
          ${scorePanel}
          <div class="game-stats">
            <span class="stat"><span class="label">parlays</span><span class="value">${g.parlayTickers.size}</span></span>
            <span class="stat" title="${g.hedged ? "Worst-case net loss after dual-direction offsets (the quoter's cap number). Gross is the un-netted sum of every parlay's cost." : "Total cost across every parlay touching this game."}">
              <span class="label">at risk${g.hedged ? " (net)" : ""}</span>
              <span class="value">${fmtMoney(g.hedged ? g.worstCase : g.exposure)}</span>
              ${g.hedged ? `<span class="stat-sub">gross ${fmtMoney(g.exposure)}</span>` : ""}
            </span>
            <span class="stat" title="${g.winHedged ? "Best-case net gain after dual-direction offsets — offsetting positions can't all win in the same outcome, so the most we can net is below the un-netted sum of every parlay's max profit (shown as gross)." : "Most we win if every parlay touching this game breaks our way."}">
              <span class="label">to win${g.winHedged ? " (net)" : ""}</span>
              <span class="value ${(g.winHedged ? g.bestWin : g.maxWin) >= 0 ? "pos" : "neg"}">${(g.winHedged ? g.bestWin : g.maxWin) >= 0 ? "+" : ""}${(g.winHedged ? g.bestWin : g.maxWin).toFixed(2)}</span>
              ${g.winHedged ? `<span class="stat-sub">gross +${g.maxWin.toFixed(2)}</span>` : ""}
            </span>
            ${g.expectedPnl != null && g.expectedCovered === g.parlayCount ? `
              <span class="stat" title="Expected $ if current live odds hold across every parlay touching this game. Sum of (P(we win parlay) * qty - cost) using the latest legMid (else fill-time fair).">
                <span class="label">expected</span>
                <span class="value ${g.expectedPnl >= 0 ? "pos" : "neg"}">${g.expectedPnl >= 0 ? "+" : ""}${g.expectedPnl.toFixed(2)}</span>
              </span>
              ${g.exposure > 0 ? `
              <span class="stat" title="ROI (gross) = expected ÷ total premium on this game (${fmtMoney(g.expectedPnl)} / ${fmtMoney(g.exposure)}) — return on capital deployed.">
                <span class="label">ROI gross</span>
                <span class="value ${g.expectedPnl >= 0 ? "pos" : "neg"}">${g.expectedPnl >= 0 ? "+" : ""}${(g.expectedPnl / g.exposure * 100).toFixed(0)}%</span>
              </span>` : ""}
              ${g.worstCase > 0.005 ? `
              <span class="stat" title="RoR (net) = expected ÷ worst-case net loss after dual-direction offsets (${fmtMoney(g.expectedPnl)} / ${fmtMoney(g.worstCase)}) — return on the risk actually carried. ${g.hedged ? `${g.offsetPct}% of gross is netted away, so RoR runs above ROI.` : "Nothing offsets here, so this equals ROI gross."}">
                <span class="label">RoR net</span>
                <span class="value ${g.expectedPnl >= 0 ? "pos" : "neg"}">${g.expectedPnl >= 0 ? "+" : ""}${(g.expectedPnl / g.worstCase * 100).toFixed(0)}%</span>
              </span>` : ""}` : ""}
          </div>
        </div>
        ${collapsed ? "" : `
        <div class="game-card-body">
          ${bodyContent || `<div class="empty">no pending legs</div>`}
          ${resolvedNote}
          ${momentumHtml}
          ${riskGridHtml}
        </div>`}
      </div>
    `;
  }).join("");

  wrap.innerHTML = html;

  wireGridScrubbers(wrap);

  // $/% grid-view toggle — DELEGATED and attached once (the scrubber swaps the
  // grid's innerHTML on every drag, which would orphan per-button listeners).
  if (!wrap._rgViewWired) {
    wrap._rgViewWired = true;
    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest(".rg-view-btn");
      if (!btn) return;
      e.stopPropagation();
      const key = btn.closest(".rg-view-toggle")?.getAttribute("data-game-key");
      if (!key) return;
      const v = btn.getAttribute("data-view");
      if (v === "pnl") delete state.gridView[key];
      else state.gridView[key] = v;
      renderGameCards();
    });
  }

  // Toggle collapse when the header is clicked (or activated by keyboard).
  wrap.querySelectorAll(".game-card-head").forEach((head) => {
    const card = head.closest(".game-card");
    const key = card?.getAttribute("data-game-key");
    if (!key) return;
    const toggle = () => {
      if (state.gameExpanded.has(key)) state.gameExpanded.delete(key);
      else state.gameExpanded.add(key);
      renderGameCards();
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  });
}

/** Look up the current market value of each excluded position and sum.
 *  Kalshi's balance.portfolio_value can't be filtered server-side, so we
 *  subtract this from the displayed PV. Long YES → qty*yes_bid, long NO →
 *  |qty|*no_bid (conservative sell-side, matches what user could realize). */
async function computeExcludedPortfolioValue(excludedPositions) {
  if (!excludedPositions || !excludedPositions.length) return 0;
  let total = 0;
  for (const p of excludedPositions) {
    const qty_fp = parseFloat(p.position_fp || "0");
    if (qty_fp === 0) continue;
    try {
      const mr = await api(`/api/kalshi/market/${encodeURIComponent(p.ticker)}`);
      const m = mr?.market || mr;
      const price = qty_fp > 0
        ? parseFloat(m?.yes_bid_dollars || "0")
        : parseFloat(m?.no_bid_dollars || "0");
      total += Math.abs(qty_fp) * price;
    } catch (e) {
      console.warn("excluded value fetch failed", p.ticker, e);
    }
  }
  return total;
}

function renderSummary() {
  const cash = parseFloat(state.balance?.balance || 0) / 100;
  // Kept around for the tooltip — Kalshi's liquidation-style value is still
  // useful context, just not the primary KPI per user preference.
  const pvRaw = parseFloat(state.balance?.portfolio_value || 0) / 100;
  const pvKalshi = pvRaw - (state.excludedPortfolioValue || 0);
  const totalCost   = state.positions.reduce((s, p) => s + p.cost, 0);

  // Aggregate live expected P&L from per-parlay implied probabilities.
  // Independence within each parlay; parlays-across summed.
  let evTotal = 0, evMissing = 0;
  for (const p of state.positions) {
    const probs = computeParlayProbabilities(p);
    if (probs.expectedPnl == null) evMissing++;
    else evTotal += probs.expectedPnl;
  }
  const evNote = evMissing > 0 ? ` <small>(${evMissing} missing odds)</small>` : "";
  // True risk = portfolio worst-case net loss after dual-direction offsets.
  // This is what we can actually lose, so it's the right ROI denominator:
  // ROI = expected outcome ÷ amount truly at risk. Falls back to cost paid
  // only if the netting math somehow returns nothing.
  const net = computePortfolioNetting();
  const atRisk = net.worstCase;
  const hedgedPortfolio = net.offsetPct >= 1 && net.gross - net.worstCase > 0.005;
  // Two distinct yardsticks (see also game-level cards):
  //   ROI (gross) = expected ÷ total premium deployed — return on CAPITAL.
  //   RoR  (net)  = expected ÷ worst-case net loss after offsets — return on
  //                 the RISK we actually carry. Netting drives these apart: as
  //                 offsetting flow cancels worst-case, RoR climbs while ROI on
  //                 the capital tied up stays flat. When nothing is hedged the
  //                 two converge (worst-case == cost).
  const roiGrossPct = totalCost > 0.005 ? (evTotal / totalCost * 100) : null;
  const rorNetPct   = atRisk   > 0.005 ? (evTotal / atRisk   * 100) : roiGrossPct;
  // Portfolio value = total account value we expect to walk away with: free
  // cash PLUS the open parlays' cost paid plus their summed expected P&L.
  // Inherits the same "missing odds" caveat as the EV line. Kalshi's
  // liquidation-style portfolio_value (positions only) + cash goes in the
  // tooltip for cross-check.
  const pv = cash + totalCost + evTotal;
  const pvTip = `free cash (${fmtMoney(cash)}) + cost paid (${fmtMoney(totalCost)}) + expected current outcome (${fmtMoney(evTotal)}). Kalshi's liquidation-value reading (incl. cash): ${fmtMoney(pvKalshi + cash)}.`;
  // Upside: max gross = sum of every parlay's max profit (if they all won);
  // to-win (net) = the most we can actually net, since offsetting positions
  // can't all win in the same outcome. Symmetric to cost-paid / at-risk(net).
  const maxWinNet = net.bestCase;
  const winHedgedP = net.winOffsetPct >= 1 && (net.grossWin - net.bestCase) > 0.005;

  $("summary").innerHTML = `
    <div class="kpi"><div class="label">cash</div><div class="value">${fmtMoney(cash)}</div></div>
    <div class="kpi" title="${escapeHtml(pvTip)}"><div class="label">portfolio value${evNote}</div><div class="value">${fmtMoney(pv)}</div></div>
    <div class="kpi kpi-split" title="${escapeHtml(`Cost paid = total premium out the door across every open parlay (gross). NET = worst-case net loss after dual-direction (over+under) offsets — our true risk, each parlay counted once.${hedgedPortfolio ? ` ${net.offsetPct}% of cost is hedged away.` : " Nothing is hedged, so NET equals cost."}`)}">
      <div class="kpi-half"><div class="label">cost paid</div><div class="value">${fmtMoney(totalCost)}</div></div>
      <div class="kpi-half"><div class="label">at risk (net)</div><div class="value ${hedgedPortfolio ? "pos" : ""}">${fmtMoney(atRisk)}</div></div>
    </div>
    <div class="kpi"><div class="label">expected current outcome${evNote}</div><div class="value ${pnlClass(evTotal)}">${fmtMoney(evTotal)}</div></div>
    <div class="kpi kpi-split" title="${escapeHtml(`ROI (gross) = expected outcome ÷ total premium deployed (${fmtMoney(evTotal)} / ${fmtMoney(totalCost)}) — return on the capital tied up. RoR (net) = expected outcome ÷ worst-case net loss after offsets (${fmtMoney(evTotal)} / ${fmtMoney(atRisk)}) — return on the risk we actually carry. Netting pushes these apart: as offsetting flow cancels worst-case, RoR rises while ROI on capital stays flat. Equal when nothing is hedged.`)}">
      <div class="kpi-half"><div class="label">ROI (gross)</div><div class="value ${pnlClass(roiGrossPct)}">${roiGrossPct != null ? roiGrossPct.toFixed(0) + "%" : "—"}</div></div>
      <div class="kpi-half"><div class="label">RoR (net)</div><div class="value ${pnlClass(rorNetPct)}">${rorNetPct != null ? rorNetPct.toFixed(0) + "%" : "—"}</div></div>
    </div>
    <div class="kpi kpi-split" title="${escapeHtml(`Max gross = un-netted sum of every parlay's max profit (if they all won). TO WIN (net) = the most we can actually net — offsetting positions can't all win in the same outcome.${winHedgedP ? ` ${net.winOffsetPct}% of the upside is unreachable due to offsets.` : " Nothing offsets, so they're equal."}`)}">
      <div class="kpi-half"><div class="label">max gross</div><div class="value pos">+${net.grossWin.toFixed(2)}</div></div>
      <div class="kpi-half"><div class="label">to win (net)</div><div class="value ${maxWinNet >= 0 ? "pos" : "neg"}">${maxWinNet >= 0 ? "+" : ""}${maxWinNet.toFixed(2)}</div></div>
    </div>
  `;
}

// Sort options for the parlay list. Each value-extractor takes the position
// record and its precomputed { probs } so we don't recompute per comparator.
const PARLAY_SORT_OPTIONS = [
  { key: "fillTs", label: "Fill Time", get: (p, x) => p.fillTs ?? -Infinity },
  { key: "cost",   label: "Risk",     get: (p, x) => p.cost },
  { key: "maxWin", label: "To Win",   get: (p, x) => p.max_profit },
  { key: "pWin",   label: "Win Chance", get: (p, x) => x.probs.pWin ?? -1 },
  { key: "evPnl",  label: "Expected Outcome", get: (p, x) => x.probs.expectedPnl ?? -Infinity },
  { key: "roi",    label: "Current ROI", get: (p, x) =>
      (x.probs.expectedPnl != null && p.cost > 0) ? (x.probs.expectedPnl / p.cost) : -Infinity },
];

function renderParlaySortBar() {
  const bar = $("parlay-sort-bar");
  if (!bar) return;
  if (!state.positions.length) { bar.innerHTML = ""; return; }
  const arrow = (k) =>
    state.parlaySortCol === k
      ? (state.parlaySortDir === "asc" ? " ▲" : " ▼")
      : "";
  const buttons = PARLAY_SORT_OPTIONS.map((o) =>
    `<button class="sort-btn ${state.parlaySortCol === o.key ? "active" : ""}" data-sort="${o.key}">${escapeHtml(o.label)}${arrow(o.key)}</button>`
  ).join("");
  bar.innerHTML = `<span class="sort-label">Sort:</span>${buttons}
    <span class="parlay-sort-actions">
      <button class="sort-action" id="parlay-expand-all">Expand all</button>
      <button class="sort-action" id="parlay-collapse-all">Collapse all</button>
    </span>`;
  bar.querySelectorAll("button.sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const col = btn.getAttribute("data-sort");
      if (state.parlaySortCol === col) {
        state.parlaySortDir = state.parlaySortDir === "asc" ? "desc" : "asc";
      } else {
        state.parlaySortCol = col;
        state.parlaySortDir = "desc";
      }
      renderParlays();
    });
  });
  $("parlay-expand-all")?.addEventListener("click", () => {
    state.parlayExpanded = new Set(state.positions.map((p) => p.ticker));
    renderParlays();
  });
  $("parlay-collapse-all")?.addEventListener("click", () => {
    state.parlayExpanded = new Set();
    renderParlays();
  });
}

function renderParlays() {
  renderParlaySortBar();
  const wrap = $("parlays");
  if (!state.positions.length) {
    wrap.innerHTML = `<div class="empty">no open positions</div>`;
    return;
  }
  // Precompute probabilities once per position so the sort comparator is cheap.
  const enriched = state.positions.map((p) => ({ p, probs: computeParlayProbabilities(p) }));
  const opt = PARLAY_SORT_OPTIONS.find((o) => o.key === state.parlaySortCol) || PARLAY_SORT_OPTIONS[0];
  const dirMul = state.parlaySortDir === "asc" ? 1 : -1;
  enriched.sort((a, b) => (opt.get(a.p, a) - opt.get(b.p, b)) * dirMul);

  wrap.innerHTML = enriched
    .map((x, i) => renderParlayCard(x.p, i + 1, x.probs))
    .join("");

  // Click / keyboard toggle on each parlay head
  wrap.querySelectorAll(".parlay > .head").forEach((head) => {
    const toggle = (e) => {
      if (e.target.closest("a, button")) return;
      const tk = head.getAttribute("data-ticker");
      if (!tk) return;
      if (state.parlayExpanded.has(tk)) state.parlayExpanded.delete(tk);
      else state.parlayExpanded.add(tk);
      renderParlays();
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle(e);
      }
    });
  });
}

/**
 * Resolution status for a given leg, FROM OUR PERSPECTIVE (long NO):
 *   alive          - we're currently winning this leg
 *   alive_pending  - currently winning but the stat could climb (in-progress prop)
 *   dead           - permanently locked against us
 *   pending        - game not started
 *   loading        - game live but boxscore not loaded yet / stat unknown
 */
// Ticker-shape matchers spanning every team sport incl. soccer leagues, so the
// live resolver below isn't a brittle per-sport startsWith chain.
const SOCCER_LEAGUE_CODES = "EPL|LALIGA|SERIEA|BUNDESLIGA|LIGUE1|UCL";
const GAME_TICKER_RE = new RegExp(`^KX(MLB|NHL|NBA|${SOCCER_LEAGUE_CODES})GAME-`);
const TOTAL_TICKER_RE = new RegExp(`^KX(MLB|NHL|NBA|${SOCCER_LEAGUE_CODES})TOTAL-`);
const BTTS_TICKER_RE = new RegExp(`^KX(${SOCCER_LEAGUE_CODES})BTTS-`);

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
    if (GAME_TICKER_RE.test(t)) {
      // Soccer ML settles on regulation: a draw means no winner → the picked
      // team's YES did not hit, which the winnerAbbr="" comparison handles.
      const pickAbbr = t.split("-").pop().toUpperCase();
      const yesHits = pickAbbr === winnerAbbr;
      const buyerWins = (buyerSide === "yes") ? yesHits : !yesHits;
      return { status: buyerWins ? "dead" : "alive", live: liveLabel,
               stat: scoreLine(competitors) };
    }
    if (BTTS_TICKER_RE.test(t)) {
      const bothScored = competitors.length >= 2 &&
        competitors.every((c) => parseInt(c?.score || "0", 10) > 0);
      const buyerWins = (buyerSide === "yes") ? bothScored : !bothScored;
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
    if (TOTAL_TICKER_RE.test(t)) {
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
    if (BTTS_TICKER_RE.test(t)) {
      // BTTS-YES irreversibly locks the moment both teams have scored (goals
      // don't decrease); BTTS-NO only settles at full time. Mirror over-total.
      const bothScored = competitors.length >= 2 &&
        competitors.every((c) => parseInt(c?.score || "0", 10) > 0);
      if (bothScored) {
        return { status: buyerSide === "yes" ? "dead" : "alive",
                 live: liveLabel, stat: `both scored — ${scoreLine(competitors)}` };
      }
      return { status: "alive_pending", live: liveLabel, stat: scoreLine(competitors) };
    }
    if (TOTAL_TICKER_RE.test(t)) {
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
  // Bake in the runner's fill-time correlation ratio (see corrRatio above):
  // pLose is the independent product, which overstates the loss prob on
  // negatively-correlated parlays. Skip decided parlays (pLose 0/1).
  if (p.corrRatio != null && pLose > 0 && pLose < 1) {
    pLose = Math.min(1, Math.max(0, pLose * p.corrRatio));
  }
  const pWin = 1 - pLose;
  const expectedPnl = pWin * p.max_profit - pLose * p.cost;
  return { pWin, pLose, expectedPnl, unknown: false, breakdown };
}

/**
 * Logo strip showing every team involved in the parlay, deduped across legs.
 * Walks BOTH buyer-yes and buyer-no resolutions of each leg so game-pick legs
 * contribute both teams of the matchup, not just the side the buyer picked.
 */
function parlayLegLogosHtml(p, max = 8) {
  const seen = new Set();
  const out = [];
  for (const leg of p.legs || []) {
    for (const side of ["yes", "no"]) {
      const lt = legTeams(leg.ticker, side) || {};
      const { sport, teams, league } = lt;
      if (!sport || !teams) continue;
      for (const t of teams) {
        const key = `${sport}|${league || ""}|${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ sport, abbr: t, league });
      }
    }
  }
  if (!out.length) return "";
  const truncated = out.length > max ? out.slice(0, max) : out;
  const extra = out.length > max
    ? `<span class="parlay-logo-more">+${out.length - max}</span>`
    : "";
  const imgs = truncated.map(({ sport, abbr, league }) =>
    `<img class="team-logo" src="${teamLogoUrl(sport, abbr, { league })}" alt="${escapeHtml(abbr)}" title="${escapeHtml(abbr)}" onerror="this.style.display='none'" loading="lazy" decoding="async">`
  ).join("");
  return `<span class="parlay-logos">${imgs}${extra}</span>`;
}

function renderParlayCard(p, n, probs) {
  let aliveLegs = 0, deadLegs = 0, pendingLegs = 0;
  if (!probs) probs = computeParlayProbabilities(p);
  const expanded = state.parlayExpanded.has(p.ticker);

  const legHtml = p.legs.map((leg, i) => {
    const res = legResolutionForUs(leg, state.scoreboards, state.boxscores);
    const ourSide = flipSide(leg.side);
    const desc = legLabel(leg.ticker, ourSide, state.athleteIdx, _floorStrikeByTicker[leg.ticker]);
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
    else if (pUsThisLeg != null)  probHtml = `<span class="k">Win chance</span> <span class="v">${(pUsThisLeg*100).toFixed(1)}%</span>`;
    else                          probHtml = `<span class="k">Win chance</span> <span class="v">—</span>`;

    const liveText = res.live || "";
    const liveCls = res.status === "alive_pending" ? "in"
                   : res.status === "alive" ? "post"
                   : res.status === "dead" ? "post" : "";
    const statText = res.stat || "";

    // Pass our flipped side so game-pick legs show the OPPOSITE team's logo
    // (e.g. parlay leg picks ATL but we hold long-NO → show COL logo, our
    // rooting interest).
    const { sport, teams: logoTeams, league } = legTeams(leg.ticker, ourSide);
    const logoHtml = logoTeams.map(abbr =>
      `<img class="team-logo" src="${teamLogoUrl(sport, abbr, { league })}" alt="${escapeHtml(abbr)}" onerror="this.style.display='none'" loading="lazy" decoding="async">`
    ).join("");

    // Date tag — disambiguates same-matchup legs across multiple dates
    // (e.g. a 3-game ATL@COL series stack).
    const dateLabel = legDateLabel(leg.ticker);
    const dateHtml = dateLabel
      ? `<span class="leg-date">${escapeHtml(dateLabel)}</span>`
      : "";

    return `<div class="leg ${cls}">
      <div class="desc">
        ${logoHtml}
        <span>${escapeHtml(desc)}</span>
        ${dateHtml}
        ${check ? `<span class="check">${check}</span>` : ""}
      </div>
      <div class="meta">
        ${probHtml}
        ${liveText ? `<span class="live-state ${liveCls}">${escapeHtml(liveText)}</span>` : ""}
        ${statText ? `<span class="v">${escapeHtml(statText)}</span>` : ""}
      </div>
    </div>`;
  }).join("") || `<div class="leg"><div class="desc">legs unavailable</div></div>`;

  // Status pill rules:
  //   LOST     — every leg hit for the buyer (we paid out)
  //   WON      — at least one leg locked our way → parlay can't lose, win chance 100%
  //   AT RISK  — neither WON nor LOST, but live expected outcome is negative (ROI < 0)
  //   TRACKING — neither WON nor LOST and ROI ≥ 0 (or ROI unknown)
  let cardBadge = "TRACKING", cardBadgeCls = "";
  if (p.legs.length > 0) {
    if (deadLegs === p.legs.length) {
      cardBadge = "LOST"; cardBadgeCls = "dead";
    } else if (aliveLegs > 0) {
      cardBadge = "WON"; cardBadgeCls = "alive";
    } else if (probs.expectedPnl != null && probs.expectedPnl < 0) {
      cardBadge = "AT RISK"; cardBadgeCls = "partial";
    } else {
      cardBadge = "TRACKING"; cardBadgeCls = "";
    }
  }

  const pWinHtml = probs.pWin != null
    ? `<div class="col"><div class="lbl">Win chance</div><div class="val">${(probs.pWin*100).toFixed(0)}%</div></div>`
    : "";
  // Fill-time correlation the runner priced (joint / independent product),
  // rendered as a top-row chip. <1 = negatively-correlated legs (the parlay
  // is HARDER to lose than the leg product implies; green); >1 = positively-
  // correlated chalk premium (amber).
  const corrBadge = (p.corrRatio != null && Math.abs(p.corrRatio - 1) >= 0.005)
    ? `<span class="corr-badge ${p.corrRatio < 1 ? "corr-neg" : "corr-pos"}" title="Runner's fill-time correlation: joint probability = ×${p.corrRatio.toFixed(3)} the independent leg product. Baked into Win chance / EV / ROI.">⛓ corr ×${p.corrRatio.toFixed(2)}</span>`
    : "";
  const evHtml = probs.expectedPnl != null
    ? `<div class="col"><div class="lbl">Expected current outcome</div><div class="val ${pnlClass(probs.expectedPnl)}">${fmtMoney(probs.expectedPnl)}</div></div>`
    : "";
  const roiHtml = (probs.expectedPnl != null && p.cost > 0)
    ? `<div class="col"><div class="lbl">Current ROI</div><div class="val ${pnlClass(probs.expectedPnl)}">${(probs.expectedPnl/p.cost*100).toFixed(0)}%</div></div>`
    : "";

  const fillStr = fmtFillTs(p);
  const fillTsHtml = fillStr
    ? `<span class="fill-ts" title="When this parlay filled">🕒 ${escapeHtml(fillStr)}</span>`
    : "";

  // Identical-leg fills folded into this card (see mergeIdenticalParlays).
  const mergedHtml = (p.mergedCount > 1)
    ? `<span class="merged-badge" title="${escapeHtml(`${p.mergedCount} fills with identical legs combined into one. Risk / To win / qty are summed.\n${p.mergedTickers.join("\n")}`)}">⧉ ${p.mergedCount} fills</span>`
    : "";

  return `<div class="parlay ${expanded ? "expanded" : "collapsed"}">
    <div class="head" data-ticker="${escapeHtml(p.ticker)}" role="button" aria-expanded="${expanded}" tabindex="0">
      <div class="top">
        <span class="badge ${cardBadgeCls}">#${n} · ${cardBadge}</span>
        ${parlayLegLogosHtml(p)}
        ${corrBadge}
        ${mergedHtml}
        ${fillTsHtml}
        <span class="chev" aria-hidden="true">${expanded ? "▾" : "▸"}</span>
      </div>
      <div class="stake">
        <div class="col"><div class="lbl">Risk</div><div class="val">${fmtMoney(p.cost)}</div></div>
        <div class="col"><div class="lbl">To win</div><div class="val pos">+${p.max_profit.toFixed(2)}</div></div>
        ${pWinHtml}
        ${evHtml}
        ${roiHtml}
      </div>
    </div>
    ${expanded ? `<div class="legs">${legHtml}</div>` : ""}
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

// Account switcher: on change, wipe account-specific state and reload so the
// page shows the newly-selected account's balance / positions / fills.
function resetForAccountSwitch() {
  state.balance = null;
  state.positions = [];
  state.fillsByParlay = {};
  state.scoreboards = {};
  state.boxscores = {};
  state.rosters = {};
  state.athletesByKey = {};
  state.athleteIdx = {};
  state.gameExpanded = new Set();
  state.parlayExpanded = new Set();
  state.excludedPortfolioValue = 0;
  render();
}

initAccountPicker((newAccount) => {
  setStatus(`switched to ${newAccount}`, "");
  resetForAccountSwitch();
  refresh();
}).then(() => {
  refresh();
});
