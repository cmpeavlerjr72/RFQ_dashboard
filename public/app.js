// Kalshi RFQ dashboard — bet-slip view, NO perspective.
// We hold NO on every parlay, so each leg is rendered as the OPPOSITE of what
// the buyer took, with NO-side odds. Manual-refresh by default.

import { legLabel, legTeams, teamLogoUrl, legGameKey, legDateLabel, findEspnEvent, parsePlayerProp, setLogoContext } from "/labels.js";
import { buildAthleteIndex, buildAthleteFlagIndex, isExcludedTicker,
         allCompetitions, athleteCodeCandidates,
         NHL_TEAMS, MLB_TEAMS, NBA_TEAMS, SOCCER_TEAMS } from "/teams.js";
import { NATIONAL_TEAMS } from "/national_teams.js";
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
    const [bal, pos, fills, starts] = await Promise.all([
      api("/api/kalshi/balance"),
      api("/api/kalshi/positions"),
      api("/api/fills"),
      // soccer kickoff times (Kalshi milestone feed) — defensive: a failure here
      // must never break the dashboard, so fall back to an empty map.
      api("/api/start-times").catch(() => ({ starts: {} })),
    ]);

    state.soccerStarts = (starts && starts.starts) || {};
    state.soccerScores = (starts && starts.scores) || {};
    state.balance = bal;
    state.fillsByParlay = {};
    for (const f of (fills.fills || [])) {
      if (f.parlay_ticker) state.fillsByParlay[f.parlay_ticker] = f;
    }

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
      if (!gl || (gl.sport !== "nhl" && gl.sport !== "nba")) continue;
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
  // Prefer a split where BOTH halves are real abbreviations for this sport.
  // This is what correctly handles variable-length codes like MLB "AZ"
  // (AZSEA -> AZ|SEA, not the length-heuristic's wrong AZS|EA) and soccer's
  // mix of 3- and 4-char codes. Shortest away-prefix that yields two known
  // abbrs wins, matching Kalshi's away-first convention.
  const known = KNOWN_ABBRS[sport];
  if (known) {
    for (let i = 2; i <= teams.length - 2; i++) {
      const a = teams.slice(0, i), b = teams.slice(i);
      if (known.has(a) && known.has(b)) return [a, b];
    }
  }
  // Fallback when we have no abbr table (or no clean match): old 3/2/4 heuristic.
  for (const len of [3, 2, 4]) {
    if (teams.length - len < 2 || teams.length - len > 4) continue;
    return [teams.slice(0, len), teams.slice(len)];
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
    // ML for the pick hits iff the pick is the winner.
    const [away, home] = parsed.teams;
    let pickWins;
    if (parsed.pick === home) pickWins = margin > 0;
    else if (parsed.pick === away) pickWins = margin < 0;
    else return "unknown";
    if (margin === 0) return "unknown";  // can't happen in NBA but soccer can
    const yesHits = pickWins;
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

// Best/worst $ P&L for the book under a partial assignment. A parlay locked to
// win (some leg misses the buyer) is +max_profit; locked to lose (every leg
// hits, none unknown) is -cost; otherwise envelope (best +max_profit, worst
// -cost). Mirrors computeGameScenarios' accounting.
function _treeNodePnl(parlays, gameKey, asg) {
  let best = 0, worst = 0;
  for (const p of parlays) {
    let anyMiss = false, anyUnknown = false;
    for (const l of p.legs) {
      const r = (legGameGroupKey(l.ticker) === gameKey)
        ? _treeEvalLeg(l.ticker, l.side, asg) : "unknown";
      if (r === "buyer_miss") { anyMiss = true; break; }
      if (r === "unknown") anyUnknown = true;
    }
    if (anyMiss) { best += p.max_profit; worst += p.max_profit; }
    else if (anyUnknown) { best += p.max_profit; worst += -p.cost; }
    else { best += -p.cost; worst += -p.cost; }
  }
  return { best, worst };
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
    exp += pAllHit * (-p.cost) + (1 - pAllHit) * p.max_profit;
  }
  return exp;
}

const _SOCCER_TREE_SPORTS = new Set(["epl", "laliga", "seriea", "bundesliga", "ligue1", "ucl"]);

// Did a settled outcome go our way? Compare the expected $ under the outcome
// that actually happened vs the alternative outcomes for that variable (holding
// everything else already settled). true = the result is the BEST of the
// options for us (green), false = the WORST (red), null = neutral/hedged.
function _pinGood(parlays, gameKey, baseSoFar, optionApplies, actualIdx) {
  if (!optionApplies || optionApplies.length < 2) return null;
  const ps = optionApplies.map((ap) => _treeNodeExpected(parlays, gameKey, ap(baseSoFar)));
  const actual = ps[actualIdx];
  const others = ps.filter((_, i) => i !== actualIdx);
  const bestOther = Math.max(...others), worstOther = Math.min(...others);
  if (actual - bestOther > 0.5) return true;    // the result that happened is best for us
  if (worstOther - actual > 0.5) return false;  // it's the worst for us
  return null;                                   // negligible difference (e.g. hedged)
}

// Determine which variables we hold legs on and turn them into ordered branch
// descriptors. Winner is always first (most intuitive for cheering); the rest
// rank by $ exposure. Capped to keep the tree glanceable.
function gameBranchVars(g, parlays, live) {
  let teams = null;
  const totalLines = new Set();
  let hasWinner = false, hasRfi = false, hasBtts = false;
  let hasSpread = false, hasDrawPick = false;
  // Signed home-margin "cut" points where a held ML/spread leg flips: home
  // covers by n => cut at n (covered at/above); away covers by n => cut at
  // -n+1 (covered below). Used to branch the tree on margin, not just winner.
  const marginCuts = new Set();
  const exp = { winner: 0, total: 0, rfi: 0, btts: 0 };
  const props = new Map(); // key -> {exposure, prop}
  for (const p of parlays) {
    for (const l of p.legs) {
      if (legGameGroupKey(l.ticker) !== g.key) continue;
      const gl = parseGameLevelLeg(l.ticker);
      if (gl) {
        if (gl.kind === "ml" || gl.kind === "spread") {
          hasWinner = true; exp.winner += p.cost; teams = teams || gl.teams;
          if (gl.pick === "TIE" || gl.pick === "DRAW") hasDrawPick = true;
          else if (gl.teams) {
            const [away, home] = gl.teams;
            // Integer cover breakpoint = ceil(real line) so the margin reps line
            // up with the `margin > line` resolver: NHL 1.5 => 2, MLB N−0.5 => N.
            // ML has no line => win breakpoint 1.
            const nc = gl.kind === "spread" ? Math.ceil(gl.line) : 1;
            if (gl.kind === "spread") hasSpread = true;
            if (gl.pick === home) marginCuts.add(nc);
            else if (gl.pick === away) marginCuts.add(-nc + 1);
          }
        }
        // Total branch point = ceil(real line) so the "over" band's rep total
        // (= this value) resolves as over under `total > line`. NHL "5" => 6.
        else if (gl.kind === "total") { totalLines.add(Math.ceil(gl.line)); exp.total += p.cost; }
        else if (gl.kind === "rfi") { hasRfi = true; exp.rfi += p.cost; }
        else if (gl.kind === "btts") { hasBtts = true; exp.btts += p.cost; }
        continue;
      }
      const prop = parsePlayerProp(l.ticker);
      if (prop && prop.threshold != null) {
        const key = `player|${prop.team}|${prop.lastName}|${prop.stat}`;
        const e = props.get(key) || { exposure: 0, prop };
        e.exposure += p.cost; props.set(key, e);
      }
    }
  }

  const vars = [];
  // base = the partial assignment already DECIDED by live play; resolved = the
  // human-readable facts that have happened. A variable that's settled live is
  // pinned into base (and shown as "so far") instead of branched, so the tree
  // and best/worst shift to "given what's happened, here's the situation".
  const base = {};
  const resolved = [];

  // Each pin records whether the settled outcome went our way (good), computed
  // against base BEFORE this pin is applied.

  // MARGIN — for non-draw games where we hold spreads, branch on the signed
  // home margin (not a binary winner) so nested/opposing spreads resolve by how
  // much, reconciling with the card's AT RISK (net). Cut points come from the
  // held legs; we always add the win/loss split at 1. Each region's rep is the
  // smallest margin in it; the leg resolver (_treeEvalLeg) does the real test.
  const useMargin = hasSpread && teams && !hasDrawPick && !_SOCCER_TREE_SPORTS.has(g.sport);
  if (useMargin) {
    const [away, home] = teams;
    marginCuts.add(1); // home wins (>=1) vs away wins (<=0)
    const cuts = [...marginCuts].sort((a, b) => a - b);
    const reps = [cuts[0] - 1, ...cuts];
    const mApply = (r) => (a) => ({ ...a, margin: r });
    const mLabel = (r, i) => {
      const top = i === reps.length - 1, bot = i === 0;
      if (r > 0) return `${home} by ${r}${top ? "+" : ""}`;
      if (r < 0) return `${away} by ${-r}${bot ? "+" : ""}`;
      return `${away} wins`; // r === 0 region (margin <= 0) — away wins, no draw
    };
    if (live && live.final && live.margin != null) {
      let idx = 0;
      for (let i = 0; i < reps.length; i++) if (live.margin >= reps[i]) idx = i;
      const good = _pinGood(parlays, g.key, base, reps.map(mApply), idx);
      base.margin = live.margin;
      resolved.push({
        text: live.margin > 0 ? `${home} by ${live.margin}` : `${away} by ${-live.margin}`,
        good,
      });
    } else {
      vars.push({ kind: "margin", varKey: "margin", exposure: exp.winner,
        options: reps.map((r, i) => ({ label: mLabel(r, i), apply: mApply(r) })) });
    }
  } else
  // WINNER — pinned only when the game is final (it can still flip mid-game).
  if (hasWinner && teams) {
    const [away, home] = teams;
    const winApplies = [(a) => ({ ...a, winner: home }), (a) => ({ ...a, winner: away })];
    if (_SOCCER_TREE_SPORTS.has(g.sport)) winApplies.push((a) => ({ ...a, winner: "__DRAW__" }));
    if (live && live.final && live.margin != null) {
      const w = live.margin > 0 ? home : live.margin < 0 ? away : "__DRAW__";
      const idx = w === home ? 0 : w === away ? 1 : 2;
      const good = _pinGood(parlays, g.key, base, winApplies, idx);
      base.winner = w;
      resolved.push({ text: w === "__DRAW__" ? "draw" : `${w} won`, good });
    } else {
      const opts = [
        { label: `${home} wins`, apply: winApplies[0] },
        { label: `${away} wins`, apply: winApplies[1] },
      ];
      if (_SOCCER_TREE_SPORTS.has(g.sport)) opts.push({ label: "draw", apply: winApplies[2] });
      vars.push({ kind: "winner", varKey: "winner", exposure: exp.winner, options: opts });
    }
  }

  // TOTAL — monotonic (only rises). Over a line locks once crossed; bands the
  // live total has already passed are pruned.
  if (totalLines.size) {
    const lines = [...totalLines].sort((a, b) => a - b);
    const cur = live && live.total != null ? live.total : null;
    const bands = [];
    bands.push({ label: `under ${lines[0] - 0.5}`, bandMax: lines[0] - 1, apply: (a) => ({ ...a, total: lines[0] - 1 }) });
    for (let i = 0; i < lines.length - 1; i++) {
      bands.push({ label: `${lines[i] - 0.5}–${lines[i + 1] - 0.5}`, bandMax: lines[i + 1] - 1, apply: (a) => ({ ...a, total: lines[i] }) });
    }
    bands.push({ label: `over ${lines[lines.length - 1] - 0.5}`, bandMax: Infinity, apply: (a) => ({ ...a, total: lines[lines.length - 1] }) });
    const resolvedTotal = (live && live.final && cur != null) || (cur != null && cur >= lines[lines.length - 1]);
    if (resolvedTotal) {
      let idx = bands.findIndex((o) => cur <= o.bandMax);
      if (idx < 0) idx = bands.length - 1;
      const good = _pinGood(parlays, g.key, base, bands.map((b) => b.apply), idx);
      base.total = cur;
      resolved.push({ text: `total ${cur}`, good });
    } else {
      let opts = cur != null ? bands.filter((o) => o.bandMax >= cur) : bands; // drop surpassed bands
      if (opts.length <= 1) {
        base.total = opts.length ? opts[0].apply({}).total : (cur != null ? cur : lines[0]);
        if (cur != null) resolved.push({ text: `total ${cur}`, good: null });
      } else {
        vars.push({ kind: "total", varKey: "total", exposure: exp.total, options: opts });
      }
    }
  }

  // RFI — pinned once the 1st inning has resolved.
  if (hasRfi) {
    const rfiApplies = [(a) => ({ ...a, rfi: true }), (a) => ({ ...a, rfi: false })];
    if (live && live.firstInningRuns != null) {
      const yes = live.firstInningRuns > 0;
      const good = _pinGood(parlays, g.key, base, rfiApplies, yes ? 0 : 1);
      base.rfi = yes;
      resolved.push({ text: yes ? "run in 1st" : "no run in 1st", good });
    } else {
      vars.push({ kind: "rfi", varKey: null, exposure: exp.rfi, options: [
        { label: "run in 1st", apply: rfiApplies[0] },
        { label: "no run in 1st", apply: rfiApplies[1] },
      ] });
    }
  }

  // BTTS — locks true once both teams have scored.
  if (hasBtts) {
    const bttsApplies = [(a) => ({ ...a, btts: true }), (a) => ({ ...a, btts: false })];
    if (live && live.bothScored === true) {
      const good = _pinGood(parlays, g.key, base, bttsApplies, 0);
      base.btts = true; resolved.push({ text: "both teams scored", good });
    } else if (live && live.final && live.bothScored === false) {
      const good = _pinGood(parlays, g.key, base, bttsApplies, 1);
      base.btts = false; resolved.push({ text: "not both scored", good });
    } else {
      vars.push({ kind: "btts", varKey: "btts", exposure: exp.btts, options: [
        { label: "both teams score", apply: bttsApplies[0] },
        { label: "not both score", apply: bttsApplies[1] },
      ] });
    }
  }

  // PROPS — counting stats are monotonic: current ≥ N locks the "N+" (over);
  // if the game is final and still under, it locks under.
  for (const [key, e] of [...props.entries()].sort((a, b) => b[1].exposure - a[1].exposure)) {
    const pr = e.prop;
    const name = pr.lastName || pr.team;
    const stat = (pr.stat || "").toLowerCase();
    const res = live && live.propResolve ? live.propResolve(pr) : null;
    const cur = res ? res.current : null;
    const st = res ? res.status : null; // "dead"=over locked, "alive"=under locked
    const propApplies = [
      (a) => ({ ...a, props: { ...(a.props || {}), [key]: false } }), // under
      (a) => ({ ...a, props: { ...(a.props || {}), [key]: true } }),  // over (N+)
    ];
    if (st === "dead") {
      const good = _pinGood(parlays, g.key, base, propApplies, 1);
      base.props = { ...(base.props || {}), [key]: true };
      resolved.push({ text: `${name} ${pr.threshold}+ ${stat}${cur != null ? ` (${cur})` : ""}`, good });
    } else if (st === "alive") {
      const good = _pinGood(parlays, g.key, base, propApplies, 0);
      base.props = { ...(base.props || {}), [key]: false };
      resolved.push({ text: `${name} under ${pr.threshold} ${stat}${cur != null ? ` (${cur})` : ""}`, good });
    } else {
      // Props are "N+" markets: under (our NO) = "under N"; over (yes) = "N+".
      vars.push({ kind: "prop", varKey: key, exposure: e.exposure, options: [
        { label: `${name} under ${pr.threshold} ${stat}`, apply: propApplies[0] },
        { label: `${name} ${pr.threshold}+ ${stat}`, apply: propApplies[1] },
      ] });
    }
  }

  // Leverage = how much forcing a variable swings our expected P&L, evaluated
  // ON TOP OF what's already decided (base). The highest-leverage variable —
  // the one that most determines our result from here — splits first; deeper
  // levels matter progressively less.
  for (const v of vars) {
    const exps = v.options.map((o) => _treeNodeExpected(parlays, g.key, o.apply(base)));
    v.leverage = Math.max(...exps) - Math.min(...exps);
  }

  // Dual-direction offsets only resolve once the offsetting variable is fixed
  // (branched OR already pinned in base). If it's still open, FORCE-INCLUDE it
  // so the tree's worst case doesn't inflate to gross. A hedged variable is
  // naturally low-leverage, so it sinks to the bottom of the leverage order —
  // exactly where its low predictive value belongs. Fill remaining slots with
  // the highest leverage variables, then order the chosen set by leverage.
  const offsetting = g.offsettingVars || new Set();
  // The netting keys every ML/spread offset as "margin", but the tree branches
  // that same axis as a "winner" var (ML-only / soccer) OR a "margin" var (when
  // spreads are held). Treat the two as one axis so an offsetting winner var
  // still gets force-branched — otherwise the tree's worst case inflates to
  // gross while the card's AT RISK (net) shows the netted figure (LADAZ: two
  // opposing MLs net to $5.41, but a "winner"-keyed tree var wouldn't match the
  // "margin" offset key and the tree would still show the full $11.41).
  const winnerAxisOffset = offsetting.has("margin") || offsetting.has("winner");
  const matchesOffset = (vk) =>
    offsetting.has(vk) || ((vk === "winner" || vk === "margin") && winnerAxisOffset);
  const essential = vars.filter((v) => v.varKey && matchesOffset(v.varKey));
  const rest = vars.filter((v) => !essential.includes(v)).sort((a, b) => b.leverage - a.leverage);
  const picked = [...essential];
  for (const v of rest) { if (picked.length >= 3) break; picked.push(v); }
  picked.sort((a, b) => b.leverage - a.leverage);
  return { branchVars: picked.slice(0, 3), base, resolved };
}

// Build the nested tree of nodes. Each node: {label, best, worst, leanGood,
// leanBad, children}. Also returns the overall worst/best leaf + their paths.
function buildGameTree(g, parlays, live) {
  // Only parlays touching this game — otherwise other games' costs leak into
  // this game's envelope.
  const ourParlays = parlays.filter((p) => p.legs.some((l) => legGameGroupKey(l.ticker) === g.key));
  if (!ourParlays.length) return null;
  const { branchVars, base, resolved } = gameBranchVars(g, ourParlays, live);

  // Everything that mattered is already decided → no branches, single outcome.
  if (!branchVars.length) {
    const pnl = _treeNodePnl(ourParlays, g.key, base);
    const expected = _treeNodeExpected(ourParlays, g.key, base);
    return { roots: [], worst: pnl.worst, worstPath: [], best: pnl.best, bestPath: [], expected, resolved };
  }

  let worstLeaf = { worst: Infinity, path: [] };
  let bestLeaf = { best: -Infinity, path: [] };

  function build(idx, asg, path) {
    if (idx >= branchVars.length) return null;
    const children = branchVars[idx].options.map((opt) => {
      const asg2 = opt.apply(asg);
      const pnl = _treeNodePnl(ourParlays, g.key, asg2);
      const expected = _treeNodeExpected(ourParlays, g.key, asg2);
      const myPath = path.concat(opt.label);
      const kids = build(idx + 1, asg2, myPath);
      // A node's range is the ACTUAL reachable range within its branch — the
      // min/max over its descendant leaves — not the envelope at this depth.
      // (At a shallow node the envelope is over-pessimistic because the hedged
      // winner isn't resolved yet; aggregating from leaves resolves it and the
      // top nodes reconcile with the headline worst/best.)
      let worst, best;
      if (kids && kids.length) {
        worst = Math.min(...kids.map((k) => k.worst));
        best = Math.max(...kids.map((k) => k.best));
      } else { // leaf — track extremes
        worst = pnl.worst; best = pnl.best;
        if (pnl.worst < worstLeaf.worst) worstLeaf = { worst: pnl.worst, path: myPath };
        if (pnl.best > bestLeaf.best) bestLeaf = { best: pnl.best, path: myPath };
      }
      return { label: opt.label, best, worst, expected, children: kids };
    });
    // Mark the sibling we'd most root for (highest midpoint) and most against.
    if (children.length > 1) {
      const mid = (c) => (c.best + c.worst) / 2;
      const sorted = [...children].sort((a, b) => mid(b) - mid(a));
      sorted[0].leanGood = true;
      sorted[sorted.length - 1].leanBad = true;
    }
    return children;
  }

  const roots = build(0, base, []); // root assignment = what live play has already decided
  return {
    roots,
    worst: worstLeaf.worst === Infinity ? null : worstLeaf.worst,
    worstPath: worstLeaf.path,
    best: bestLeaf.best === -Infinity ? null : bestLeaf.best,
    bestPath: bestLeaf.path,
    resolved,
  };
}

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
  return {
    state, periodLabel,
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
    if (v === "margin" && !drawPossible) cs = cs.filter((x) => x !== 0); // no ties
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

  // Enumerate shared vars (>=2 positions) up to the grid budget for the worst case.
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
  // hitting; a free (other-game/unmodelled) or failing leg lets it break our
  // way. Same enumeration, opposite extreme: min net = worst, max net = best.
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

  let bestNet = null, bestGain = null;
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
// Games are independent (their variables can't offset each other), so the
// portfolio worst case is the sum of each game's worst-case net loss. We bucket
// every parlay into a single "home" game (its first parseable leg) so each
// dollar of cost is counted exactly once — unlike the per-game cards, which
// attribute a cross-game parlay's full cost to EVERY game it touches (useful
// for the per-card "if this game goes bad" view, but it double-counts if you
// sum them). Result is therefore guaranteed ≤ cost paid, and equals cost paid
// when nothing is hedged. Within each game, dual-direction (over+under) flow
// nets down exactly as the quoter's worst_case_net_loss does.
function computePortfolioNetting() {
  const byGame = new Map();
  for (const p of state.positions) {
    const cost = p.cost || 0, qty = p.qty || 0;
    let gk = null;
    for (const l of (p.legs || [])) { const k = legGameGroupKey(l.ticker); if (k) { gk = k; break; } }
    const key = gk || "__nogame__";
    if (!byGame.has(key)) byGame.set(key, []);
    byGame.get(key).push({ contracts: qty, costPer: qty > 0 ? cost / qty : 0, legs: p.legs });
  }
  let worstCase = 0, gross = 0, bestCase = 0, grossWin = 0;
  for (const [key, pos] of byGame) {
    const net = computeGameNetting(pos, key === "__nogame__" ? null : key);
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
  if (["epl", "laliga", "seriea", "bundesliga", "ligue1", "ucl"].includes(sport)) {
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

  const NT = 13;  // total columns (odd => centered on the line)
  const NM = 12;  // margin rows (EVEN => no margin-0 / "tie" row; ties don't occur)
  const sportTotalDefault = { nba: 222, wnba: 162, nhl: 6, mlb: 9 }[g.sport] || 220;
  // Integer-scoring sports (runs/goals): each grid step is ONE run/goal — a ±3
  // step is nonsense for a 9-run / 6-goal game. High-scoring sports (NBA/WNBA)
  // keep the auto-sized larger step. Add other low-scoring sports here as needed.
  const unitStep = g.sport === "mlb" || g.sport === "nhl";
  const tCenter = totalLines.length
    ? (Math.min(...totalLines) + Math.max(...totalLines)) / 2
    : (live && live.total != null ? live.total : sportTotalDefault);
  const tHalf = Math.max(15, (totalLines.length ? (Math.max(...totalLines) - Math.min(...totalLines)) / 2 : 0) + 12);
  const mHalf = Math.max(15, Math.max(...marginCuts.map((m) => Math.abs(m))) + 12);
  const tStep = unitStep ? 1 : Math.max(1, Math.round((2 * tHalf) / (NT - 1)));
  const mStep = unitStep ? 1 : Math.max(1, Math.round(mHalf / (NM / 2)));
  const thalf = (NT - 1) / 2;
  // A game total can never be negative (or zero) — clamp the lowest column to 1
  // and shift the window up so every column stays a realistic total.
  const tStart = Math.max(1, Math.round(tCenter - thalf * tStep));
  const totals = Array.from({ length: NT }, (_, i) => tStart + i * tStep);
  // margins straddle 0 without including it: +6..+1, -1..-6 (× mStep)
  const margins = Array.from({ length: NM }, (_, i) => {
    const k = i < NM / 2 ? (NM / 2 - i) : (NM / 2 - 1 - i);
    return k * mStep;
  });
  const home = teams ? teams[1] : null, away = teams ? teams[0] : null;

  let maxAbs = 0;
  const cells = margins.map((m) => totals.map((t) => {
    const asg = { margin: m, total: t, winner: m > 0 ? home : m < 0 ? away : null };
    const pnl = _treeNodeExpected(ours, g.key, asg);
    if (Math.abs(pnl) > maxAbs) maxAbs = Math.abs(pnl);
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
  return { margins, totals, cells, maxAbs, totalLines, teams: teams || [away, home], mark, mStep, tStep };
}

function renderRiskGridHtml(grid) {
  if (!grid || grid.maxAbs < 0.01) return "";
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
    // winner-flip seam: the first away-win row (prev row was a home win)
    const flip = (r > 0 && margins[r - 1] > 0 && mv < 0) ? " rg-flip" : "";
    // Vegas orientation: label by the WINNING team laying the line. mv = home
    // margin (home−away), so mv>0 => home wins by mv => "HOME -mv"; mv<0 =>
    // away wins by |mv| => "AWAY -|mv|". The reference team flips at the 0 seam,
    // and a win is shown as a NEGATIVE spread (e.g. "CAR -1" = CAR by 1).
    const winTeam = mv > 0 ? home : away;
    const ylab = `${winTeam} -${Math.abs(mv)}`;
    let cellsHtml = `<div class="rg-ylab" title="${escapeHtml(winTeam)} wins by ${Math.abs(mv)}">${escapeHtml(ylab)}</div>`;
    for (let c = 0; c < NC; c++) {
      const pnl = cells[r][c];
      const isMark = (r === markR && c === markC);
      const base = `${winTeam} -${Math.abs(mv)}, total ${totals[c]} → ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}`;
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
  for (let c = 0; c < NC; c++) xlabs += `<div class="rg-xlab">${c % 3 === 1 ? totals[c] : ""}</div>`;
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
          const ab = ourCheeredTeam(parsed, r.buyerSide);
          if (!teamBuckets.has(ab)) teamBuckets.set(ab, { ml: [], spread: [] });
          teamBuckets.get(ab).ml.push({ row: r, parsed });
        } else if (parsed?.kind === "spread") {
          // Bucket under the team WE (long-NO) cheer for to cover the
          // line. Same convention as ML — chip always describes what we
          // want to have happen. Buyer-YES on TEAM means we cheer for the
          // opposing dog; buyer-NO on TEAM means we cheer for TEAM as
          // favorite. The chip-label code signs the spread accordingly
          // (+ if our team is the dog, - if our team is the favorite).
          const ab = ourCheeredTeam(parsed, r.buyerSide);
          if (!teamBuckets.has(ab)) teamBuckets.set(ab, { ml: [], spread: [] });
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
        // i.e., "win" regardless of original buyer side.
        chipLabel = "win";
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
      // bucket team already tells you who. Render just the meta.
      const showThresh = parsed.kind !== "ml";
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
    if (teamBuckets.size > 0 || sharedTotal.length > 0 || sharedBtts.length > 0 || sharedRfi.length > 0 || sharedOther.size > 0 || otherLegs.length > 0) {
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
            ${gameLadderHtml("ML", b.ml, null)}
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
          ${teamBlocks}${totalBlock}${bttsBlock}${rfiBlock}${otherBlocks}${otherTickers}
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
    const tree = buildGameTree(g, state.positions, treeLive);
    // 2D risk surface (margin × total) — only for hedged games (opposing
    // positions create a non-trivial profit/loss shape worth seeing).
    const riskGridHtml = g.hedged
      ? renderRiskGridHtml(computeRiskGrid(g, state.positions, treeLive))
      : "";
    let scenarioHtml = "";
    if (tree) {
      const money = (n) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
      // Thermometer: bar from worst (left, red) to best (right, green); the tick
      // sits at the market-implied EXPECTED outcome. Numbers colored by sign.
      const meterHtml = (worst, best, expected) => {
        const span = best - worst;
        if (span <= 0.01) {
          return `<span class="tree-meter locked" title="locked outcome"><span class="m-end ${worst >= 0 ? "pos" : "neg"}">${money(worst)}</span></span>`;
        }
        const markPct = Math.min(100, Math.max(0, ((expected - worst) / span) * 100));
        return `
          <span class="tree-meter" title="worst ${money(worst)} · expected ${money(expected)} · best ${money(best)} — tick = market-implied likely outcome">
            <span class="m-end ${worst >= 0 ? "pos" : "neg"}">${money(worst)}</span>
            <span class="m-track"><span class="m-mark" style="left:${markPct.toFixed(1)}%"></span></span>
            <span class="m-end ${best >= 0 ? "pos" : "neg"}">${money(best)}</span>
          </span>`;
      };
      const renderNodes = (nodes) => nodes.map((node) => {
        const leanCls = node.leanGood ? " lean-good" : node.leanBad ? " lean-bad" : "";
        const lean = node.leanGood
          ? `<span class="tree-lean good" title="root FOR this — best branch at this fork">▲</span>`
          : node.leanBad
          ? `<span class="tree-lean bad" title="root AGAINST this — worst branch at this fork">▼</span>`
          : "";
        const kids = node.children && node.children.length
          ? `<div class="tree-children">${renderNodes(node.children)}</div>` : "";
        return `
          <div class="tree-node${leanCls}">
            <div class="tree-row">
              <span class="tree-label">${lean}${escapeHtml(node.label)}</span>
              ${meterHtml(node.worst, node.best, node.expected)}
            </div>
            ${kids}
          </div>`;
      }).join("");
      const pathStr = (arr) => (arr && arr.length ? arr.join(" · ") : "—");
      // "So far" — facts live play has already settled (pins the tree). Each
      // pill is green if it went our way, red if it didn't, grey if neutral.
      const resolvedHtml = (tree.resolved && tree.resolved.length)
        ? `<div class="tree-resolved"><span class="tree-resolved-lbl">so far</span>${tree.resolved.map((r) => `<span class="rs${r.good === true ? " good" : r.good === false ? " bad" : ""}">${escapeHtml(r.text)}</span>`).join("")}</div>`
        : "";
      const hasBranches = tree.roots && tree.roots.length;
      const body = hasBranches
        ? `
          <div class="tree-extremes">
            <div class="tree-extreme">
              <span class="tree-extreme-lbl neg">worst case</span>
              <span class="tree-extreme-path">${escapeHtml(pathStr(tree.worstPath))}</span>
              <b class="${tree.worst >= 0 ? "pos" : "neg"}">${money(tree.worst)}</b>
            </div>
            <div class="tree-extreme">
              <span class="tree-extreme-lbl pos">best case</span>
              <span class="tree-extreme-path">${escapeHtml(pathStr(tree.bestPath))}</span>
              <b class="${tree.best >= 0 ? "pos" : "neg"}">${money(tree.best)}</b>
            </div>
          </div>
          <div class="tree-body">${renderNodes(tree.roots)}</div>`
        : `
          <div class="tree-body"><div class="tree-node"><div class="tree-row">
            <span class="tree-label">outcome from here</span>
            ${meterHtml(tree.worst, tree.best, tree.expected)}
          </div></div></div>`;
      scenarioHtml = `
        <div class="scenarios game-tree">
          <div class="cheer-list-head">Rooting interests</div>
          ${resolvedHtml}
          ${body}
        </div>
      `;
    }

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
              ${(g.hedged ? g.worstCase : g.exposure) > 0 ? `
              <span class="stat" title="Game-level ROI = expected ÷ net at-risk (${fmtMoney(g.expectedPnl)} / ${fmtMoney(g.hedged ? g.worstCase : g.exposure)}).">
                <span class="label">ROI</span>
                <span class="value ${g.expectedPnl >= 0 ? "pos" : "neg"}">${g.expectedPnl >= 0 ? "+" : ""}${(g.expectedPnl / (g.hedged ? g.worstCase : g.exposure) * 100).toFixed(0)}%</span>
              </span>` : ""}` : ""}
          </div>
        </div>
        ${collapsed ? "" : `
        <div class="game-card-body">
          ${bodyContent || `<div class="empty">no pending legs</div>`}
          ${resolvedNote}
          ${scenarioHtml}
          ${riskGridHtml}
        </div>`}
      </div>
    `;
  }).join("");

  wrap.innerHTML = html;

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
  const roiDenom = atRisk > 0.005 ? atRisk : totalCost;
  const roiPct = roiDenom > 0 ? (evTotal / roiDenom * 100) : null;
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
    <div class="kpi" title="${escapeHtml(`Expected outcome ÷ amount truly at risk (${fmtMoney(evTotal)} / ${fmtMoney(roiDenom)}). The denominator is worst-case net loss after offsets, not gross cost — return on what we can actually lose.`)}"><div class="label">current ROI</div><div class="value ${pnlClass(roiPct)}">${roiPct != null ? roiPct.toFixed(0) + "%" : "—"}</div></div>
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
