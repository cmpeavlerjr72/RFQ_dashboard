// Decode a Kalshi leg ticker + side into a sports-betting-slip label.
//
// Examples:
//   ("KXNHLGAME-26APR28MINDAL-MIN", "yes")  → "NHL: Wild win (vs Stars)"
//   ("KXNHLTOTAL-26APR28MINDAL-5", "yes")    → "NHL: Wild vs Stars OVER 5 goals"
//   ("KXATPMATCH-26APR29SINJOD-SIN", "yes")  → "ATP: Sinner win" (when athlete idx resolves)
//   ("KXMLBGAME-26APR281835HOUBAL-BAL", "yes") → "MLB: Orioles win (vs Astros)"
//   ("KXMLBHRR-26APR281915DETATL-ATLMOLSON28-1", "yes") → "MLB: Olson 1+ hits/runs/RBIs"

import { NHL_TEAMS, MLB_TEAMS, NBA_TEAMS, MLB_STAT_LABELS, NBA_STAT_LABELS } from "/teams.js";

const TEAM_BY_LEN_HINT = {
  KXMLB: MLB_TEAMS,
  KXNHL: NHL_TEAMS,
  KXNBA: NBA_TEAMS,
};

function splitTeams(concat, table) {
  // Try every prefix length 2-4 against the team table; return [away, home]
  for (let i = 2; i <= 4; i++) {
    const a = concat.slice(0, i);
    const b = concat.slice(i);
    if (table[a] && table[b]) return [a, b];
  }
  // Fallback: best-effort 50/50 split
  const mid = Math.ceil(concat.length / 2);
  return [concat.slice(0, mid), concat.slice(mid)];
}

function teamName(table, abbr) {
  return table[abbr] || abbr;
}

/**
 * Parse the date+teams chunk of a ticker.
 *   "26APR28MINDAL"             → { date:"26APR28", time:null, teams:"MINDAL" }
 *   "26APR281835HOUBAL"         → { date:"26APR28", time:"1835", teams:"HOUBAL" }
 */
function parseDateTeams(chunk) {
  const m = chunk.match(/^(\d{2}[A-Z]{3}\d{2})(\d{4})?([A-Z]+)$/);
  if (!m) return { date: "", time: null, teams: chunk };
  return { date: m[1], time: m[2] || null, teams: m[3] };
}

function ymdHumanFromTicker(date /* "26APR28" */) {
  const m = date.match(/^(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return date;
  const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthMap = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
  const mon = monthMap[m[2]];
  return `${monthNames[mon]} ${parseInt(m[3], 10)}`;
}

// ---------- main ----------

export function legLabel(ticker, side, athleteIdx) {
  side = (side || "yes").toLowerCase();

  // ---------- NHL ----------
  if (ticker.startsWith("KXNHLGAME-")) {
    const rest = ticker.slice("KXNHLGAME-".length);
    const [dt, pickAbbr] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, NHL_TEAMS);
    const opp = pickAbbr === a ? b : a;
    const pickName = teamName(NHL_TEAMS, pickAbbr);
    const oppName = teamName(NHL_TEAMS, opp);
    if (side === "yes") return `NHL: ${pickName} win vs ${oppName}`;
    return `NHL: ${oppName} win vs ${pickName}`;
  }
  if (ticker.startsWith("KXNHLTOTAL-")) {
    const rest = ticker.slice("KXNHLTOTAL-".length);
    const [dt, n] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, NHL_TEAMS);
    const matchup = `${teamName(NHL_TEAMS, a)} vs ${teamName(NHL_TEAMS, b)}`;
    if (side === "yes") return `NHL: ${matchup} OVER ${n} goals`;
    return `NHL: ${matchup} UNDER ${n} goals`;
  }
  if (ticker.startsWith("KXNHLSPREAD-")) {
    const rest = ticker.slice("KXNHLSPREAD-".length);
    const [dt, line] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, NHL_TEAMS);
    return `NHL: ${teamName(NHL_TEAMS, a)} vs ${teamName(NHL_TEAMS, b)} spread ${line}` + (side === "yes" ? "" : " (no)");
  }

  // ---------- MLB ----------
  if (ticker.startsWith("KXMLBGAME-")) {
    const rest = ticker.slice("KXMLBGAME-".length);
    const [dt, pickAbbr] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, MLB_TEAMS);
    const opp = pickAbbr === a ? b : a;
    const pickName = teamName(MLB_TEAMS, pickAbbr);
    const oppName = teamName(MLB_TEAMS, opp);
    if (side === "yes") return `MLB: ${pickName} win vs ${oppName}`;
    return `MLB: ${oppName} win vs ${pickName}`;
  }
  if (ticker.startsWith("KXMLBTOTAL-")) {
    const rest = ticker.slice("KXMLBTOTAL-".length);
    const [dt, n] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, MLB_TEAMS);
    const matchup = `${teamName(MLB_TEAMS, a)} vs ${teamName(MLB_TEAMS, b)}`;
    if (side === "yes") return `MLB: ${matchup} OVER ${n} runs`;
    return `MLB: ${matchup} UNDER ${n} runs`;
  }
  if (ticker.startsWith("KXMLBSPREAD-")) {
    const rest = ticker.slice("KXMLBSPREAD-".length);
    const [dt, line] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, MLB_TEAMS);
    return `MLB: ${teamName(MLB_TEAMS, a)} vs ${teamName(MLB_TEAMS, b)} spread ${line}` + (side === "yes" ? "" : " (no)");
  }

  // MLB player props
  // Format: KXMLB<STAT>-<date+teams>-<TEAM><INITIAL><LASTNAME><JERSEY>-<THRESHOLD>
  //   KXMLBHRR-26APR281835HOUBAL-BALGHENDERSON2-1
  //   KXMLBKS-26APR231310MILDET-DETTSKUBAL29-7
  const playerMatch = ticker.match(/^KXMLB([A-Z]+)-([0-9]{2}[A-Z]{3}[0-9]{2}[0-9]{4}[A-Z]+)-([A-Z]+[0-9]+)-([0-9]+)$/);
  if (playerMatch) {
    const [, stat, dt, playerBlob, threshold] = playerMatch;
    const statLabel = MLB_STAT_LABELS[stat] || stat.toLowerCase();
    let teamAbbr = "";
    let lastName = "";
    for (let teamLen = 4; teamLen >= 2; teamLen--) {
      const candidate = playerBlob.slice(0, teamLen);
      if (MLB_TEAMS[candidate]) {
        teamAbbr = candidate;
        const tail = playerBlob.slice(teamLen).replace(/\d+$/, "");
        lastName = tail.length > 1 ? tail.slice(1) : tail;
        break;
      }
    }
    const lnPretty = lastName ? lastName.charAt(0) + lastName.slice(1).toLowerCase() : "?";
    if (side === "yes") return `MLB: ${lnPretty} ${threshold}+ ${statLabel}`;
    return `MLB: ${lnPretty} UNDER ${threshold} ${statLabel}`;
  }

  // ---------- NBA ----------
  if (ticker.startsWith("KXNBAGAME-")) {
    const rest = ticker.slice("KXNBAGAME-".length);
    const [dt, pickAbbr] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, NBA_TEAMS);
    const opp = pickAbbr === a ? b : a;
    const pickName = teamName(NBA_TEAMS, pickAbbr);
    const oppName = teamName(NBA_TEAMS, opp);
    if (side === "yes") return `NBA: ${pickName} win vs ${oppName}`;
    return `NBA: ${oppName} win vs ${pickName}`;
  }
  if (ticker.startsWith("KXNBATOTAL-")) {
    const rest = ticker.slice("KXNBATOTAL-".length);
    const [dt, n] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, NBA_TEAMS);
    const matchup = `${teamName(NBA_TEAMS, a)} vs ${teamName(NBA_TEAMS, b)}`;
    if (side === "yes") return `NBA: ${matchup} OVER ${n} points`;
    return `NBA: ${matchup} UNDER ${n} points`;
  }
  if (ticker.startsWith("KXNBASPREAD-")) {
    const rest = ticker.slice("KXNBASPREAD-".length);
    const [dt, line] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, NBA_TEAMS);
    return `NBA: ${teamName(NBA_TEAMS, a)} vs ${teamName(NBA_TEAMS, b)} spread ${line}` + (side === "yes" ? "" : " (no)");
  }

  // NBA player props
  // Format: KXNBA<STAT>-<date+teams>-<TEAM><INITIAL><LASTNAME><JERSEY>-<THRESHOLD>
  //   KXNBAPTS-26APR30NYKATL-NYKJBRUNSON11-25
  //   KXNBA3PT-26APR30NYKATL-NYKOANUNOBY8-2
  //   KXNBAREB-26APR30NYKATL-NYKKTOWNS32-10
  // (stat may start with a digit, e.g. "3PT")
  const nbaPlayerMatch = ticker.match(/^KXNBA([A-Z0-9]+)-(\d{2}[A-Z]{3}\d{2}[A-Z]+)-([A-Z]+\d+)-(\d+)$/);
  if (nbaPlayerMatch && !["GAME", "SPREAD", "TOTAL"].includes(nbaPlayerMatch[1])) {
    const [, stat, , playerBlob, threshold] = nbaPlayerMatch;
    const statLabel = NBA_STAT_LABELS[stat] || stat.toLowerCase();
    let teamAbbr = "";
    let lastName = "";
    for (let teamLen = 4; teamLen >= 2; teamLen--) {
      const candidate = playerBlob.slice(0, teamLen);
      if (NBA_TEAMS[candidate]) {
        teamAbbr = candidate;
        const tail = playerBlob.slice(teamLen).replace(/\d+$/, "");
        lastName = tail.length > 1 ? tail.slice(1) : tail;
        break;
      }
    }
    const lnPretty = lastName ? lastName.charAt(0) + lastName.slice(1).toLowerCase() : "?";
    if (side === "yes") return `NBA: ${lnPretty} ${threshold}+ ${statLabel}`;
    return `NBA: ${lnPretty} UNDER ${threshold} ${statLabel}`;
  }

  // ---------- Tennis ATP/WTA ----------
  // KXATPMATCH-26APR29SINJOD-SIN  → "Sinner" if athleteIdx has SIN
  if (ticker.startsWith("KXATPMATCH-") || ticker.startsWith("KXWTAMATCH-")) {
    const tour = ticker.startsWith("KXATPMATCH-") ? "ATP" : "WTA";
    const rest = ticker.slice(ticker.indexOf("-") + 1);
    const [dt, winnerAbbr] = rest.split("-");
    // dt = "26APR29SINJOD" — date(7) + p1(3) + p2(3)
    const m = dt.match(/^(\d{2}[A-Z]{3}\d{2})([A-Z]{3})([A-Z]{3})$/);
    let oppAbbr = "";
    if (m) {
      oppAbbr = m[2] === winnerAbbr ? m[3] : m[2];
    }
    const winnerName = athleteIdx?.[winnerAbbr] || winnerAbbr;
    const oppName = athleteIdx?.[oppAbbr] || oppAbbr;
    if (side === "yes") return `${tour}: ${winnerName} d. ${oppName}`;
    return `${tour}: ${oppName} d. ${winnerName}`;
  }

  // ---------- UFC ----------
  if (ticker.startsWith("KXUFCFIGHT-")) {
    const rest = ticker.slice("KXUFCFIGHT-".length);
    const [dt, winnerAbbr] = rest.split("-");
    const m = dt.match(/^(\d{2}[A-Z]{3}\d{2})([A-Z]{3})([A-Z]{3})$/);
    let oppAbbr = "";
    if (m) {
      oppAbbr = m[2] === winnerAbbr ? m[3] : m[2];
    }
    const winnerName = athleteIdx?.[winnerAbbr] || winnerAbbr;
    const oppName = athleteIdx?.[oppAbbr] || oppAbbr;
    if (side === "yes") return `UFC: ${winnerName} d. ${oppName}`;
    return `UFC: ${oppName} d. ${winnerName}`;
  }

  // ---------- Soccer (rough) ----------
  const soccerLeagues = {
    KXLALIGAGAME: "La Liga", KXSERIEAGAME: "Serie A",
    KXBUNDESLIGAGAME: "Bundesliga", KXLIGUE1GAME: "Ligue 1",
  };
  for (const [pref, label] of Object.entries(soccerLeagues)) {
    if (ticker.startsWith(pref + "-")) {
      const rest = ticker.slice(pref.length + 1);
      const [dt, pick] = rest.split("-");
      return `${label}: ${pick} ${side === "yes" ? "win" : "(no win)"} (${ymdHumanFromTicker(dt.slice(0,7))})`;
    }
  }

  // Fallback
  return `${ticker} (${side})`;
}

/**
 * Return { sport, teams: [abbr,...] } for a leg ticker. For game/spread/total
 * legs we return both teams (matchup); for player props we return the player's
 * team only; for team-side picks (KXNBAGAME-...-NYK) we return the picked team.
 * Used to pick logos to display next to the leg label.
 */
export function legTeams(ticker, side) {
  // `side` is OUR side after the flip (e.g. "no" when we hold long-NO).
  // For game-pick legs, the ticker encodes the bettor's pick. When we're
  // on the opposite side, return the OPPOSITE team's logo so the dashboard
  // shows our rooting interest, not the bettor's.
  side = (side || "yes").toLowerCase();

  // NBA team-side
  if (ticker.startsWith("KXNBAGAME-")) {
    const rest = ticker.slice("KXNBAGAME-".length);
    const [dt, pickAbbr] = rest.split("-");
    if (side === "no") {
      const { teams } = parseDateTeams(dt);
      const [a, b] = splitTeams(teams, NBA_TEAMS);
      const opp = pickAbbr === a ? b : a;
      return { sport: "nba", teams: [opp] };
    }
    return { sport: "nba", teams: [pickAbbr] };
  }
  if (ticker.startsWith("KXNBASPREAD-") || ticker.startsWith("KXNBATOTAL-")) {
    const prefixLen = (ticker.startsWith("KXNBASPREAD-") ? "KXNBASPREAD-" : "KXNBATOTAL-").length;
    const rest = ticker.slice(prefixLen);
    const [dt] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, NBA_TEAMS);
    return { sport: "nba", teams: [a, b] };
  }
  const nbaPlayer = ticker.match(/^KXNBA([A-Z0-9]+)-(\d{2}[A-Z]{3}\d{2}[A-Z]+)-([A-Z]+\d+)-(\d+)$/);
  if (nbaPlayer && !["GAME", "SPREAD", "TOTAL"].includes(nbaPlayer[1])) {
    const blob = nbaPlayer[3];
    for (let n = 4; n >= 2; n--) {
      const cand = blob.slice(0, n);
      if (NBA_TEAMS[cand]) return { sport: "nba", teams: [cand] };
    }
  }

  // NHL
  if (ticker.startsWith("KXNHLGAME-")) {
    const rest = ticker.slice("KXNHLGAME-".length);
    const [dt, pickAbbr] = rest.split("-");
    if (side === "no") {
      const { teams } = parseDateTeams(dt);
      const [a, b] = splitTeams(teams, NHL_TEAMS);
      const opp = pickAbbr === a ? b : a;
      return { sport: "nhl", teams: [opp] };
    }
    return { sport: "nhl", teams: [pickAbbr] };
  }
  if (ticker.startsWith("KXNHLSPREAD-") || ticker.startsWith("KXNHLTOTAL-") || ticker.startsWith("KXNHLGOAL-")) {
    const idx = ticker.indexOf("-");
    const rest = ticker.slice(idx + 1);
    const [dt] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, NHL_TEAMS);
    return { sport: "nhl", teams: [a, b] };
  }

  // MLB
  if (ticker.startsWith("KXMLBGAME-")) {
    const rest = ticker.slice("KXMLBGAME-".length);
    const [dt, pickAbbr] = rest.split("-");
    if (side === "no") {
      const { teams } = parseDateTeams(dt);
      const [a, b] = splitTeams(teams, MLB_TEAMS);
      const opp = pickAbbr === a ? b : a;
      return { sport: "mlb", teams: [opp] };
    }
    return { sport: "mlb", teams: [pickAbbr] };
  }
  if (ticker.startsWith("KXMLBSPREAD-") || ticker.startsWith("KXMLBTOTAL-")) {
    const prefixLen = (ticker.startsWith("KXMLBSPREAD-") ? "KXMLBSPREAD-" : "KXMLBTOTAL-").length;
    const rest = ticker.slice(prefixLen);
    const [dt] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, MLB_TEAMS);
    return { sport: "mlb", teams: [a, b] };
  }
  const mlbPlayer = ticker.match(/^KXMLB([A-Z]+)-(\d{2}[A-Z]{3}\d{2}\d{4}[A-Z]+)-([A-Z]+\d+)-(\d+)$/);
  if (mlbPlayer) {
    const blob = mlbPlayer[3];
    for (let n = 4; n >= 2; n--) {
      const cand = blob.slice(0, n);
      if (MLB_TEAMS[cand]) return { sport: "mlb", teams: [cand] };
    }
  }

  return { sport: null, teams: [] };
}

const ESPN_ABBR_OVERRIDES = {
  nba: { GSW: "gs", NOP: "no", NYK: "ny", SAS: "sa", UTA: "utah", WAS: "wsh" },
  nhl: { LAK: "la", NJD: "nj", SJS: "sj", TBL: "tb", VGK: "vgs" },
  mlb: { CWS: "chw", AZ: "ari", KC: "kc", SD: "sd", SF: "sf", TB: "tb" },
};

/** ESPN logo CDN URL for the team. Falls back to lowercase Kalshi abbr. */
export function teamLogoUrl(sport, abbr) {
  if (!sport || !abbr) return "";
  const overrides = ESPN_ABBR_OVERRIDES[sport] || {};
  const a = overrides[abbr] || abbr.toLowerCase();
  return `https://a.espncdn.com/i/teamlogos/${sport}/500/${a}.png`;
}

/**
 * Parse a player-prop ticker into structured fields. Returns null if not a prop.
 * Example: "KXMLBHRR-26APR281835HOUBAL-HOUYALVAREZ44-2"
 *   → { stat: "HRR", team: "HOU", lastName: "ALVAREZ", jersey: "44", threshold: 2,
 *       gameKey: "MLB 26APR281835HOUBAL", sport: "mlb" }
 */
export function parsePlayerProp(ticker) {
  const m = ticker.match(/^KXMLB([A-Z]+)-(\d{2}[A-Z]{3}\d{2}\d{4}[A-Z]+)-([A-Z]+\d+)-(\d+)$/);
  if (!m) return null;
  const [, stat, dt, playerBlob, thresholdStr] = m;
  let teamAbbr = "";
  let lastName = "";
  let jersey = "";
  for (let teamLen = 4; teamLen >= 2; teamLen--) {
    const candidate = playerBlob.slice(0, teamLen);
    if (MLB_TEAMS[candidate]) {
      teamAbbr = candidate;
      const tail = playerBlob.slice(teamLen);
      const jerseyMatch = tail.match(/^([A-Z]+)(\d+)$/);
      if (jerseyMatch) {
        const initialAndLast = jerseyMatch[1];
        lastName = initialAndLast.length > 1 ? initialAndLast.slice(1) : initialAndLast;
        jersey = jerseyMatch[2];
      }
      break;
    }
  }
  return {
    stat,
    team: teamAbbr,
    lastName,
    jersey,
    threshold: parseInt(thresholdStr, 10),
    gameKey: `MLB ${dt.slice(0, 13)}`,
    sport: "mlb",
  };
}

/**
 * Human-readable date for a leg (e.g. "May 1"). Empty string if the ticker
 * doesn't have a parseable date prefix. Used to disambiguate parlay legs
 * across multiple dates (e.g. a 3-game series stack).
 */
export function legDateLabel(ticker) {
  const m = ticker.match(/-(\d{2}[A-Z]{3}\d{2})/);
  if (!m) return "";
  return ymdHumanFromTicker(m[1]);
}


/**
 * Build the underlying-game key for a leg, used for matching to ESPN events.
 * Returns the same string that ESPN-side rendering can match against.
 */
export function legGameKey(ticker) {
  if (ticker.startsWith("KXMLB")) {
    const m = ticker.match(/^KX[A-Z]+-(\d{2}[A-Z]{3}\d{2}\d{4}[A-Z]+)/);
    if (m) return `MLB ${m[1].slice(0, 13)}`;
  }
  if (ticker.startsWith("KXNHL")) {
    const rest = ticker.split("-")[1];
    return `NHL ${rest}`;
  }
  if (ticker.startsWith("KXATPMATCH-") || ticker.startsWith("KXWTAMATCH-")) {
    const rest = ticker.split("-")[1];
    return `tennis ${rest}`;
  }
  if (ticker.startsWith("KXUFCFIGHT-")) {
    const rest = ticker.split("-")[1];
    return `UFC ${rest}`;
  }
  return "";
}

/**
 * Match a leg's gameKey against the loaded ESPN scoreboards. Returns the
 * matching ESPN event or null. We match by uppercase team-abbreviation
 * intersection (works for NHL/MLB/NBA) and by last-name prefix for tennis/UFC.
 */
export function findEspnEvent(gKey, scoreboards) {
  for (const sb of Object.values(scoreboards || {})) {
    if (!sb || !Array.isArray(sb.events)) continue;
    for (const ev of sb.events) {
      const competitors = ev?.competitions?.[0]?.competitors || [];
      // Team sports
      const abbrs = competitors
        .map((c) => (c?.team?.abbreviation || "").toUpperCase())
        .filter(Boolean);
      if (abbrs.length >= 2 && abbrs.every((a) => gKey.includes(a))) {
        return ev;
      }
      // Athlete sports (tennis/UFC)
      const lastNames = competitors
        .map((c) => {
          const n = c?.athlete?.displayName || c?.athletes?.[0]?.displayName || "";
          return n.trim().split(/\s+/).pop().slice(0, 3).toUpperCase();
        })
        .filter(Boolean);
      if (lastNames.length >= 2 && lastNames.every((ln) => gKey.includes(ln))) {
        return ev;
      }
    }
  }
  return null;
}
