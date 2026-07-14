// Decode a Kalshi leg ticker + side into a sports-betting-slip label.
//
// Examples:
//   ("KXNHLGAME-26APR28MINDAL-MIN", "yes")  → "NHL: Wild win (vs Stars)"
//   ("KXNHLTOTAL-26APR28MINDAL-5", "yes")    → "NHL: Wild vs Stars OVER 5 goals"
//   ("KXATPMATCH-26APR29SINJOD-SIN", "yes")  → "ATP: Sinner win" (when athlete idx resolves)
//   ("KXMLBGAME-26APR281835HOUBAL-BAL", "yes") → "MLB: Orioles win (vs Astros)"
//   ("KXMLBHRR-26APR281915DETATL-ATLMOLSON28-1", "yes") → "MLB: Olson 1+ hits/runs/RBIs"

import {
  NHL_TEAMS, MLB_TEAMS, NBA_TEAMS, WNBA_TEAMS, IPL_TEAMS, SOCCER_TEAMS, SOCCER_LEAGUES,
  MLB_STAT_LABELS, NBA_STAT_LABELS, iplLogoUrl, tennisFlagUrl, soccerLogoUrl,
} from "/teams.js";
import { NATIONAL_TEAMS, countryFlagUrl } from "/national_teams.js";

// Series-prefix → league key used to look up soccer logos.
const SOCCER_LEAGUE_FROM_PREFIX = {
  KXEPLGAME: "EPL", KXEPLSPREAD: "EPL", KXEPLTOTAL: "EPL", KXEPLBTTS: "EPL",
  KXLALIGAGAME: "LALIGA", KXLALIGASPREAD: "LALIGA", KXLALIGATOTAL: "LALIGA",
  KXLALIGABTTS: "LALIGA", KXLALIGA1H: "LALIGA",
  KXSERIEAGAME: "SERIEA", KXSERIEASPREAD: "SERIEA", KXSERIEATOTAL: "SERIEA",
  KXSERIEABTTS: "SERIEA", KXSERIEA1H: "SERIEA",
  KXBUNDESLIGAGAME: "BUNDESLIGA", KXBUNDESLIGASPREAD: "BUNDESLIGA",
  KXBUNDESLIGATOTAL: "BUNDESLIGA", KXBUNDESLIGABTTS: "BUNDESLIGA",
  KXBUNDESLIGA1H: "BUNDESLIGA",
  KXLIGUE1GAME: "LIGUE1", KXLIGUE1SPREAD: "LIGUE1", KXLIGUE1TOTAL: "LIGUE1",
  KXLIGUE1BTTS: "LIGUE1", KXLIGUE11H: "LIGUE1",
  KXUCLGAME: "UCL", KXUCLSPREAD: "UCL", KXUCLTOTAL: "UCL", KXUCLBTTS: "UCL",
};

function soccerLeagueOf(ticker) {
  for (const [pref, league] of Object.entries(SOCCER_LEAGUE_FROM_PREFIX)) {
    if (ticker.startsWith(pref + "-")) return league;
  }
  return null;
}

const TEAM_BY_LEN_HINT = {
  KXMLB: MLB_TEAMS,
  KXNHL: NHL_TEAMS,
  KXNBA: NBA_TEAMS,
  KXWNBA: WNBA_TEAMS,
  KXIPL: IPL_TEAMS,
};

function splitTeams(concat, table) {
  // Try every plausible split (a-length 2..4, b-length 2..4) against the
  // team table; first hit wins. Returns [away, home].
  for (let aLen = 2; aLen <= 4 && aLen < concat.length; aLen++) {
    const a = concat.slice(0, aLen);
    const b = concat.slice(aLen);
    if (b.length < 2 || b.length > 4) continue;
    if (table[a] && table[b]) return [a, b];
  }
  // Looser fallback: at least one side known.
  for (let aLen = 2; aLen <= 4 && aLen < concat.length; aLen++) {
    const a = concat.slice(0, aLen);
    const b = concat.slice(aLen);
    if (b.length < 2 || b.length > 4) continue;
    if (table[a] || table[b]) return [a, b];
  }
  // Last resort: 50/50 split.
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

// The market's `floor_strike` (`fs`) is the AUTHORITATIVE line and is always
// used when provided — it is the half-number the market resolves against
// (e.g. NHL "5" => 5.5, MLB "12" => 11.5). The ticker-integer fallback only
// fires when floor_strike is not loaded, and it is LEAGUE-SPECIFIC: verified
// vs Kalshi 2026-06-02, NHL/NBA tickers are N + 0.5 (KXNHLTOTAL ...-5 has
// floor_strike 5.5), while MLB and everything else are N − 0.5 (ticker "12" =
// the "12+ runs" market = Over 11.5). A uniform N − 0.5 silently printed
// NBA/NHL a full unit low, so the fallback must know the sport.
function _fallbackHalfLine(v, sport) {
  const x = Number(v);
  if (!Number.isFinite(x)) return v;
  const off = (sport === "nhl" || sport === "nba") ? 0.5 : -0.5;
  return String(x + off);
}
function totalLine(v, fs, sport) {
  if (typeof fs === "number") return String(fs);
  return _fallbackHalfLine(v, sport);
}
function spreadLine(v, fs, sport) {
  if (typeof fs === "number") return String(fs);
  return _fallbackHalfLine(v, sport);
}

export function legLabel(ticker, side, athleteIdx, floorStrike) {
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
    if (side === "yes") return `NHL: ${matchup} OVER ${totalLine(n, floorStrike, "nhl")} goals`;
    return `NHL: ${matchup} UNDER ${totalLine(n, floorStrike, "nhl")} goals`;
  }
  if (ticker.startsWith("KXNHLSPREAD-")) {
    const rest = ticker.slice("KXNHLSPREAD-".length);
    const [dt, line] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, NHL_TEAMS);
    return `NHL: ${teamName(NHL_TEAMS, a)} vs ${teamName(NHL_TEAMS, b)} · ${line.replace(/\d+$/, "")} -${spreadLine(line, floorStrike, "nhl")}` + (side === "yes" ? "" : " (no)");
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
    if (side === "yes") return `MLB: ${matchup} OVER ${totalLine(n, floorStrike, "mlb")} runs`;
    return `MLB: ${matchup} UNDER ${totalLine(n, floorStrike, "mlb")} runs`;
  }
  if (ticker.startsWith("KXMLBSPREAD-")) {
    const rest = ticker.slice("KXMLBSPREAD-".length);
    const [dt, line] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, MLB_TEAMS);
    return `MLB: ${teamName(MLB_TEAMS, a)} vs ${teamName(MLB_TEAMS, b)} · ${line.replace(/\d+$/, "")} -${spreadLine(line, floorStrike, "mlb")}` + (side === "yes" ? "" : " (no)");
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
    if (side === "yes") return `NBA: ${matchup} OVER ${totalLine(n, floorStrike, "nba")} points`;
    return `NBA: ${matchup} UNDER ${totalLine(n, floorStrike, "nba")} points`;
  }
  if (ticker.startsWith("KXNBASPREAD-")) {
    const rest = ticker.slice("KXNBASPREAD-".length);
    const [dt, line] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, NBA_TEAMS);
    return `NBA: ${teamName(NBA_TEAMS, a)} vs ${teamName(NBA_TEAMS, b)} · ${line.replace(/\d+$/, "")} -${spreadLine(line, floorStrike, "nba")}` + (side === "yes" ? "" : " (no)");
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
  // KXATPMATCH-26APR29SINJOD-SIN  → "Sinner" if athleteIdx has SIN.
  // We're long NO — for side="no" we flip to the opponent winning, so the
  // card reads in the direction we're rooting for ("Pellegrino beats Sinner").
  if (ticker.startsWith("KXATPMATCH-") || ticker.startsWith("KXWTAMATCH-")) {
    const tour = ticker.startsWith("KXATPMATCH-") ? "ATP" : "WTA";
    const rest = ticker.slice(ticker.indexOf("-") + 1);
    const [dt, pickAbbr] = rest.split("-");
    const m = dt.match(/^(\d{2}[A-Z]{3}\d{2})([A-Z]{3})([A-Z]{3})$/);
    let oppAbbr = "";
    if (m) oppAbbr = m[2] === pickAbbr ? m[3] : m[2];
    const pickName = athleteIdx?.[pickAbbr] || pickAbbr;
    const oppName = athleteIdx?.[oppAbbr] || oppAbbr;
    if (side === "yes") return `${tour}: ${pickName} beats ${oppName}`;
    return `${tour}: ${oppName} beats ${pickName}`;
  }

  // ---------- IPL Cricket ----------
  // KXIPLGAME-26MAY12SRHGT-GT  → "Gujarat Titans win vs Sunrisers Hyderabad"
  // We're long NO — flip to the opposing franchise winning.
  if (ticker.startsWith("KXIPLGAME-")) {
    const rest = ticker.slice("KXIPLGAME-".length);
    const [dt, pickAbbr] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, IPL_TEAMS);
    const opp = pickAbbr === a ? b : a;
    const pickName = teamName(IPL_TEAMS, pickAbbr);
    const oppName = teamName(IPL_TEAMS, opp);
    if (side === "yes") return `IPL: ${pickName} win vs ${oppName}`;
    return `IPL: ${oppName} win vs ${pickName}`;
  }
  if (ticker.startsWith("KXIPLTOTAL-") || ticker.startsWith("KXIPLTEAMTOTAL-")) {
    const prefix = ticker.startsWith("KXIPLTEAMTOTAL-") ? "KXIPLTEAMTOTAL-" : "KXIPLTOTAL-";
    const rest = ticker.slice(prefix.length);
    const [dt, n] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, IPL_TEAMS);
    const matchup = `${teamName(IPL_TEAMS, a)} vs ${teamName(IPL_TEAMS, b)}`;
    const label = prefix === "KXIPLTEAMTOTAL-" ? "team total" : "match total";
    if (side === "yes") return `IPL: ${matchup} OVER ${totalLine(n, floorStrike, "ipl")} runs (${label})`;
    return `IPL: ${matchup} UNDER ${totalLine(n, floorStrike, "ipl")} runs (${label})`;
  }
  if (ticker.startsWith("KXIPLFIRST10-")) {
    const rest = ticker.slice("KXIPLFIRST10-".length);
    const [dt, pickAbbr] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, IPL_TEAMS);
    const opp = pickAbbr === a ? b : a;
    const pickName = teamName(IPL_TEAMS, pickAbbr);
    const oppName = teamName(IPL_TEAMS, opp);
    if (side === "yes") return `IPL: ${pickName} lead first 10 overs vs ${oppName}`;
    return `IPL: ${oppName} lead first 10 overs vs ${pickName}`;
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

  // ---------- Soccer (all 5 leagues × game/spread/total/BTTS/1H) ----------
  for (const [pref, label] of Object.entries(SOCCER_LEAGUES)) {
    if (!ticker.startsWith(pref + "-")) continue;
    const rest = ticker.slice(pref.length + 1);
    const [dt, suffix] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, SOCCER_TEAMS);
    const aName = teamName(SOCCER_TEAMS, a);
    const bName = teamName(SOCCER_TEAMS, b);

    if (pref.endsWith("GAME")) {
      if (suffix === "TIE") {
        if (side === "yes") return `${label}: Draw — ${aName} vs ${bName}`;
        return `${label}: Decisive result — ${aName} vs ${bName}`;
      }
      const pickName = teamName(SOCCER_TEAMS, suffix);
      const oppName = suffix === a ? bName : aName;
      if (side === "yes") return `${label}: ${pickName} win vs ${oppName}`;
      return `${label}: ${oppName} win or draw vs ${pickName}`;
    }
    if (pref.endsWith("SPREAD")) {
      // Suffix is the team abbrev + handicap (e.g. "RMA1" = RMA -1.5).
      // We can't always cleanly parse the handicap; render the matchup and
      // direction at minimum.
      if (side === "yes") return `${label}: ${aName} vs ${bName} spread ${spreadLine(suffix, floorStrike, "soccer")}`;
      return `${label}: ${aName} vs ${bName} spread NOT ${suffix}`;
    }
    if (pref.endsWith("TOTAL")) {
      if (side === "yes") return `${label}: ${aName} vs ${bName} OVER ${totalLine(suffix, floorStrike, "soccer")} goals`;
      return `${label}: ${aName} vs ${bName} UNDER ${totalLine(suffix, floorStrike, "soccer")} goals`;
    }
    if (pref.endsWith("BTTS")) {
      if (side === "yes") return `${label}: Both teams score (${aName} vs ${bName})`;
      return `${label}: Either team blanked (${aName} vs ${bName})`;
    }
    if (pref.endsWith("SCORE")) {
      // Lit exact-score single (2026-07-06): suffix is <TEAM1><h><TEAM2><a>,
      // regulation time. Only full-game families are in SOCCER_LEAGUES —
      // 1H/2H score variants are intentionally absent (not score-resolvable).
      const mCs = (suffix || "").match(/^([A-Z]+?)(\d+)([A-Z]+?)(\d+)$/);
      if (mCs) {
        const n1 = teamName(SOCCER_TEAMS, mCs[1]);
        const n2 = teamName(SOCCER_TEAMS, mCs[3]);
        if (side === "yes") return `${label}: Exact score ${n1} ${mCs[2]}-${mCs[4]} ${n2} (reg)`;
        return `${label}: NOT ${n1} ${mCs[2]}-${mCs[4]} ${n2} (reg)`;
      }
      return `${label}: Exact score (${aName} vs ${bName})`;
    }
    if (pref.endsWith("1H")) {
      if (suffix === "TIE") {
        if (side === "yes") return `${label}: 1H draw — ${aName} vs ${bName}`;
        return `${label}: 1H decisive — ${aName} vs ${bName}`;
      }
      const pickName = teamName(SOCCER_TEAMS, suffix);
      const oppName = suffix === a ? bName : aName;
      if (side === "yes") return `${label}: ${pickName} lead at half vs ${oppName}`;
      return `${label}: ${oppName} lead or draw at half vs ${pickName}`;
    }
    return `${label}: ${aName} vs ${bName}`;
  }

  // ---------- WNBA ----------
  // Own table, NOT NBA_TEAMS: WNBA codes collide with NBA meanings (TOR/ATL)
  // and include 2- and 4-char codes (GS, LA, CONN, PDX). The NBA table sent
  // splitTeams to its 50/50 last resort ("PDXCONN" -> "PDXC"|"ONN", rendering
  // "PDX win vs PDXC" — fixed 2026-07-14).
  if (ticker.startsWith("KXWNBAGAME-")) {
    const rest = ticker.slice("KXWNBAGAME-".length);
    const [dt, pickAbbr] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, WNBA_TEAMS);
    const opp = pickAbbr === a ? b : a;
    const pickName = teamName(WNBA_TEAMS, pickAbbr);
    const oppName = teamName(WNBA_TEAMS, opp);
    if (side === "yes") return `WNBA: ${pickName} win vs ${oppName}`;
    return `WNBA: ${oppName} win vs ${pickName}`;
  }
  // WNBA totals/spreads (KXWNBATOTAL/KXWNBASPREAD, tradable since the 7/14
  // same-game gate change). Lines are N−0.5 like MLB (verified floor_strike
  // 2026-07-14: "-180" = 179.5, "IND7" = 6.5) — "wnba" correctly misses the
  // nhl/nba +0.5 branch in _fallbackHalfLine.
  if (ticker.startsWith("KXWNBATOTAL-")) {
    const rest = ticker.slice("KXWNBATOTAL-".length);
    const [dt, n] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, WNBA_TEAMS);
    const matchup = `${teamName(WNBA_TEAMS, a)} vs ${teamName(WNBA_TEAMS, b)}`;
    if (side === "yes") return `WNBA: ${matchup} OVER ${totalLine(n, floorStrike, "wnba")} points`;
    return `WNBA: ${matchup} UNDER ${totalLine(n, floorStrike, "wnba")} points`;
  }
  if (ticker.startsWith("KXWNBASPREAD-")) {
    const rest = ticker.slice("KXWNBASPREAD-".length);
    const [dt, line] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, WNBA_TEAMS);
    return `WNBA: ${teamName(WNBA_TEAMS, a)} vs ${teamName(WNBA_TEAMS, b)} · ${line.replace(/\d+$/, "")} -${spreadLine(line, floorStrike, "wnba")}` + (side === "yes" ? "" : " (no)");
  }
  // WNBA player props — same blob shape as NBA but the jersey digits are
  // OPTIONAL (KXWNBAPTS-26JUL14PDXCONN-PDXSBARKER-20 has none, WSHSCITRON22
  // does), hence \d* where the NBA regex has \d+.
  const wnbaPlayerMatch = ticker.match(/^KXWNBA([A-Z0-9]+)-(\d{2}[A-Z]{3}\d{2}[A-Z]+)-([A-Z]+\d*)-(\d+)$/);
  if (wnbaPlayerMatch && !["GAME", "SPREAD", "TOTAL"].includes(wnbaPlayerMatch[1])) {
    const [, stat, , playerBlob, threshold] = wnbaPlayerMatch;
    const statLabel = NBA_STAT_LABELS[stat] || stat.toLowerCase();
    let teamAbbr = "";
    let lastName = "";
    for (let teamLen = 4; teamLen >= 2; teamLen--) {
      const candidate = playerBlob.slice(0, teamLen);
      if (WNBA_TEAMS[candidate]) {
        teamAbbr = candidate;
        const tail = playerBlob.slice(teamLen).replace(/\d+$/, "");
        lastName = tail.length > 1 ? tail.slice(1) : tail;
        break;
      }
    }
    const lnPretty = lastName ? lastName.charAt(0) + lastName.slice(1).toLowerCase() : "?";
    if (side === "yes") return `WNBA: ${lnPretty} ${threshold}+ ${statLabel}`;
    return `WNBA: ${lnPretty} UNDER ${threshold} ${statLabel}`;
  }

  // ---------- MLB Run-in-First-Inning ----------
  // Format: KXMLBRFI-{date+time+teams}[-{TEAM}]
  // The team suffix is optional — the most common Kalshi RFI market is a
  // GAME-level "any team scores in 1st" without a team specifier. Render
  // a team-prefixed label only when a valid team abbr is present (else
  // we fall through to a generic YRFI/NRFI label and don't show the
  // misleading "MLB: undefined score in 1st inning").
  if (ticker.startsWith("KXMLBRFI-")) {
    const rest = ticker.slice("KXMLBRFI-".length);
    const [, teamAbbr] = rest.split("-");
    if (teamAbbr && MLB_TEAMS[teamAbbr]) {
      const tn = teamName(MLB_TEAMS, teamAbbr);
      if (side === "yes") return `MLB: ${tn} score in 1st inning`;
      return `MLB: ${tn} scoreless 1st inning`;
    }
    if (side === "yes") return `MLB: run scored in 1st inning (YRFI)`;
    return `MLB: no run in 1st inning (NRFI)`;
  }

  // ---------- NHL player props ----------
  // Format: KXNHL{STAT}-{game}-{TEAM}{PLAYERINITIAL+LASTNAME}{JERSEY}-{THRESHOLD}
  const nhlPlayer = ticker.match(/^KXNHL(GOAL|PTS|AST|FIRSTGOAL)-(\d{2}[A-Z]{3}\d{2}[A-Z]+)-([A-Z]+\d+)(?:-(\d+))?$/);
  if (nhlPlayer) {
    const [, stat, , playerBlob, threshold] = nhlPlayer;
    let teamAbbr = "", lastName = "";
    for (let teamLen = 4; teamLen >= 2; teamLen--) {
      const candidate = playerBlob.slice(0, teamLen);
      if (NHL_TEAMS[candidate]) {
        teamAbbr = candidate;
        const tail = playerBlob.slice(teamLen).replace(/\d+$/, "");
        lastName = tail.length > 1 ? tail.slice(1) : tail;
        break;
      }
    }
    const lnPretty = lastName ? lastName.charAt(0) + lastName.slice(1).toLowerCase() : "?";
    const statLabel = stat === "GOAL" ? "goal" : stat === "PTS" ? "points"
                     : stat === "AST" ? "assists" : "first goal";
    if (stat === "FIRSTGOAL") {
      if (side === "yes") return `NHL: ${lnPretty} scores first goal`;
      return `NHL: ${lnPretty} NOT first goal`;
    }
    if (side === "yes") return `NHL: ${lnPretty} ${threshold}+ ${statLabel}`;
    return `NHL: ${lnPretty} UNDER ${threshold} ${statLabel}`;
  }

  // ---------- UFC Method of Victory ----------
  if (ticker.startsWith("KXUFCMOV-")) {
    const rest = ticker.slice("KXUFCMOV-".length);
    const [dt, method] = rest.split("-");
    const m = dt.match(/^(\d{2}[A-Z]{3}\d{2})([A-Z]{3})([A-Z]{3})$/);
    const matchup = m ? `${m[2]}/${m[3]}` : dt;
    // Method codes: KO/TKO, SUB, DEC
    const methodLabel = method === "KO" ? "KO/TKO" : method === "SUB" ? "submission" : method === "DEC" ? "decision" : method;
    if (side === "yes") return `UFC ${matchup}: wins by ${methodLabel}`;
    return `UFC ${matchup}: NOT by ${methodLabel}`;
  }

  // ---------- UFC Round of Victory ----------
  if (ticker.startsWith("KXUFCVICROUND-")) {
    const rest = ticker.slice("KXUFCVICROUND-".length);
    const [dt, round] = rest.split("-");
    const m = dt.match(/^(\d{2}[A-Z]{3}\d{2})([A-Z]{3})([A-Z]{3})$/);
    const matchup = m ? `${m[2]}/${m[3]}` : dt;
    if (side === "yes") return `UFC ${matchup}: wins in round ${round}`;
    return `UFC ${matchup}: NOT round ${round}`;
  }

  // ---------- PGA ----------
  // KXPGATOUR-{TOURNCODE}-{GOLFER}      → outright winner
  // KXPGATOP5-{TOURNCODE}-{GOLFER}      → Top 5 finisher
  // KXPGATOP10-... / KXPGATOP20-...
  // KXPGAMAKECUT-{TOURNCODE}-{GOLFER}   → make the cut
  // KXPGAR1LEAD-{TOURNCODE}-{GOLFER}    → Round 1 leader
  const pgaMatch = ticker.match(/^KX(PGATOUR|PGATOP5|PGATOP10|PGATOP20|PGAMAKECUT|PGAR1LEAD)-([A-Z0-9]+)-([A-Z]+)$/);
  if (pgaMatch) {
    const [, kind, tournament, golfer] = pgaMatch;
    const golferPretty = golfer.charAt(0) + golfer.slice(1).toLowerCase();
    const label = kind === "PGATOUR" ? "win tournament"
                : kind === "PGATOP5" ? "Top 5 finish"
                : kind === "PGATOP10" ? "Top 10 finish"
                : kind === "PGATOP20" ? "Top 20 finish"
                : kind === "PGAMAKECUT" ? "makes cut"
                : "Round 1 leader";
    if (side === "yes") return `PGA: ${golferPretty} — ${label}`;
    return `PGA: ${golferPretty} — NOT ${label}`;
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

  // IPL
  if (ticker.startsWith("KXIPLGAME-")) {
    const rest = ticker.slice("KXIPLGAME-".length);
    const [dt, pickAbbr] = rest.split("-");
    if (side === "no") {
      const { teams } = parseDateTeams(dt);
      const [a, b] = splitTeams(teams, IPL_TEAMS);
      const opp = pickAbbr === a ? b : a;
      return { sport: "ipl", teams: [opp] };
    }
    return { sport: "ipl", teams: [pickAbbr] };
  }
  if (ticker.startsWith("KXIPLTOTAL-") || ticker.startsWith("KXIPLTEAMTOTAL-") || ticker.startsWith("KXIPLFIRST10-")) {
    const idx = ticker.indexOf("-");
    const rest = ticker.slice(idx + 1);
    const [dt] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, IPL_TEAMS);
    return { sport: "ipl", teams: [a, b] };
  }

  // Tennis (ATP/WTA) — use the 3-letter player abbrev as the "team"; the
  // logo resolver below maps it to a country flag via the athlete index.
  if (ticker.startsWith("KXATPMATCH-") || ticker.startsWith("KXWTAMATCH-")) {
    const tour = ticker.startsWith("KXATPMATCH-") ? "atp" : "wta";
    const rest = ticker.slice(ticker.indexOf("-") + 1);
    const [dt, pickAbbr] = rest.split("-");
    const m = dt.match(/^(\d{2}[A-Z]{3}\d{2})([A-Z]{3})([A-Z]{3})$/);
    let oppAbbr = "";
    if (m) oppAbbr = m[2] === pickAbbr ? m[3] : m[2];
    // For long-NO we cheer the opponent — show their flag only.
    if (side === "no") return { sport: tour, teams: [oppAbbr] };
    return { sport: tour, teams: [pickAbbr] };
  }

  // National-team soccer (World Cup + international friendlies). Codes are
  // 3-letter FIFA/IOC; teamLogoUrl resolves them to country flags. Same
  // both-teams shape as club soccer, but a distinct sport + team table.
  if (ticker.startsWith("KXWC") || ticker.startsWith("KXINTLFRIENDLY")) {
    const sport = ticker.startsWith("KXWC") ? "wcup" : "intlfriendly";
    const rest = ticker.slice(ticker.indexOf("-") + 1);
    const [dt] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, NATIONAL_TEAMS);
    return { sport, teams: [a, b] };
  }

  // Soccer — return both teams + the league so teamLogoUrl can resolve
  // the correct logo (Kalshi abbrevs aren't unique across leagues).
  // KXEPLGAME isn't in SOCCER_LEAGUES (game-only labels), so check it
  // separately too.
  if (ticker.startsWith("KXEPLGAME-") || ticker.startsWith("KXEPLSPREAD-") ||
      ticker.startsWith("KXEPLTOTAL-") || ticker.startsWith("KXEPLBTTS-")) {
    const league = "EPL";
    const idx = ticker.indexOf("-");
    const rest = ticker.slice(idx + 1);
    const [dt] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, SOCCER_TEAMS);
    return { sport: "soccer", league, teams: [a, b] };
  }
  for (const pref of Object.keys(SOCCER_LEAGUES)) {
    if (!ticker.startsWith(pref + "-")) continue;
    const rest = ticker.slice(pref.length + 1);
    const [dt] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, SOCCER_TEAMS);
    const league = soccerLeagueOf(ticker);
    return { sport: "soccer", league, teams: [a, b] };
  }

  // WNBA — same structure as NBA team-side, but its OWN abbr table
  // (NBA_TEAMS mis-split every WNBA chunk with a 2/4-char code).
  if (ticker.startsWith("KXWNBAGAME-")) {
    const rest = ticker.slice("KXWNBAGAME-".length);
    const [dt, pickAbbr] = rest.split("-");
    if (side === "no") {
      const { teams } = parseDateTeams(dt);
      const [a, b] = splitTeams(teams, WNBA_TEAMS);
      const opp = pickAbbr === a ? b : a;
      return { sport: "wnba", teams: [opp] };
    }
    return { sport: "wnba", teams: [pickAbbr] };
  }
  if (ticker.startsWith("KXWNBASPREAD-") || ticker.startsWith("KXWNBATOTAL-")) {
    const prefixLen = (ticker.startsWith("KXWNBASPREAD-") ? "KXWNBASPREAD-" : "KXWNBATOTAL-").length;
    const rest = ticker.slice(prefixLen);
    const [dt] = rest.split("-");
    const { teams } = parseDateTeams(dt);
    const [a, b] = splitTeams(teams, WNBA_TEAMS);
    return { sport: "wnba", teams: [a, b] };
  }
  // WNBA player props (jersey digits optional — see legLabel)
  const wnbaPlayer = ticker.match(/^KXWNBA([A-Z0-9]+)-(\d{2}[A-Z]{3}\d{2}[A-Z]+)-([A-Z]+\d*)-(\d+)$/);
  if (wnbaPlayer && !["GAME", "SPREAD", "TOTAL"].includes(wnbaPlayer[1])) {
    const blob = wnbaPlayer[3];
    for (let n = 4; n >= 2; n--) {
      const cand = blob.slice(0, n);
      if (WNBA_TEAMS[cand]) return { sport: "wnba", teams: [cand] };
    }
  }

  // NHL player props (PTS, AST, FIRSTGOAL) — return the player's team
  const nhlPlayerLT = ticker.match(/^KXNHL(GOAL|PTS|AST|FIRSTGOAL)-(\d{2}[A-Z]{3}\d{2}[A-Z]+)-([A-Z]+\d+)(?:-(\d+))?$/);
  if (nhlPlayerLT) {
    const blob = nhlPlayerLT[3];
    for (let n = 4; n >= 2; n--) {
      const cand = blob.slice(0, n);
      if (NHL_TEAMS[cand]) return { sport: "nhl", teams: [cand] };
    }
  }

  // MLB RFI — first-inning team
  if (ticker.startsWith("KXMLBRFI-")) {
    const rest = ticker.slice("KXMLBRFI-".length);
    const [, teamAbbr] = rest.split("-");
    return { sport: "mlb", teams: [teamAbbr] };
  }

  // UFC method / round of victory — no team logos (fighter sports);
  // recap will render text badges from the matchup abbrevs.
  if (ticker.startsWith("KXUFCMOV-") || ticker.startsWith("KXUFCVICROUND-")) {
    const rest = ticker.slice(ticker.indexOf("-") + 1);
    const [dt] = rest.split("-");
    const m = dt.match(/^(\d{2}[A-Z]{3}\d{2})([A-Z]{3})([A-Z]{3})$/);
    if (m) return { sport: "ufc", teams: [m[2], m[3]] };
    return { sport: "ufc", teams: [] };
  }

  // PGA — text-only (no per-golfer logo). Return the golfer abbrev as
  // the "team" so the renderer shows a labeled chip.
  if (ticker.startsWith("KXPGATOUR-") || ticker.startsWith("KXPGATOP5-") ||
      ticker.startsWith("KXPGATOP10-") || ticker.startsWith("KXPGATOP20-") ||
      ticker.startsWith("KXPGAMAKECUT-") || ticker.startsWith("KXPGAR1LEAD-")) {
    const parts = ticker.split("-");
    const golfer = parts[parts.length - 1] || "";
    return { sport: "pga", teams: golfer ? [golfer] : [] };
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

// Logo context — module-level state so teamLogoUrl can resolve tennis flags
// without recap.js / app.js having to pass scoreboards through every call.
// Initialise via setLogoContext({ playerFlagIdx: { SIN: "https://...png" } }).
let _logoCtx = { playerFlagIdx: {} };
export function setLogoContext(ctx) {
  if (!ctx) return;
  if (ctx.playerFlagIdx) _logoCtx.playerFlagIdx = { ..._logoCtx.playerFlagIdx, ...ctx.playerFlagIdx };
}

/** Logo URL for a (sport, abbr). Optionally pass {league} for soccer.
 *  Falls back to "" when no logo is known — callers should render a text
 *  badge in that case. */
export function teamLogoUrl(sport, abbr, opts = {}) {
  if (!sport || !abbr) return "";
  const s = sport.toLowerCase();
  if (s === "atp" || s === "wta") {
    return _logoCtx.playerFlagIdx?.[abbr] || tennisFlagUrl(abbr);
  }
  if (s === "ipl") return iplLogoUrl(abbr);
  if (s === "wcup" || s === "intlfriendly") return countryFlagUrl(abbr);
  if (s === "soccer") {
    // League required for disambiguation (LEV is Levante in LaLiga AND
    // Leverkusen in Bundesliga; BRE is Brentford in EPL AND Bremen in
    // Bundesliga). Callers should pass {league: "EPL"|"LALIGA"|...}.
    return soccerLogoUrl(opts.league, abbr);
  }
  if (s === "wnba") {
    // ESPN WNBA logos at the same path as NBA but in the wnba category.
    // Kalshi PDX (Portland Fire) has no pdx.png on the CDN — ESPN's slug is
    // por (verified 2026-07-14; conn.png exists so CONN lowercases fine).
    const overrides = { PDX: "por" };
    const a = overrides[abbr] || abbr.toLowerCase();
    return `https://a.espncdn.com/i/teamlogos/wnba/500/${a}.png`;
  }
  if (s === "nba" || s === "nhl" || s === "mlb") {
    const overrides = ESPN_ABBR_OVERRIDES[s] || {};
    const a = overrides[abbr] || abbr.toLowerCase();
    return `https://a.espncdn.com/i/teamlogos/${s}/500/${a}.png`;
  }
  return "";
}

/**
 * Parse a player-prop ticker into structured fields. Returns null if not a prop.
 * Example: "KXMLBHRR-26APR281835HOUBAL-HOUYALVAREZ44-2"
 *   → { stat: "HRR", team: "HOU", lastName: "ALVAREZ", jersey: "44", threshold: 2,
 *       gameKey: "MLB 26APR281835HOUBAL", sport: "mlb" }
 */
export function parsePlayerProp(ticker) {
  // MLB: KXMLB<STAT>-<dateHHMMteams>-<TEAM><initial><LAST><jersey>-<thr>
  const mlb = ticker.match(/^KXMLB([A-Z]+)-(\d{2}[A-Z]{3}\d{2}\d{4}[A-Z]+)-([A-Z]+\d+)-(\d+)$/);
  if (mlb) {
    const [, stat, dt, playerBlob, thresholdStr] = mlb;
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
      // Use the full date+HHMM+teams chunk so findEspnEvent's
      // abbr-in-gameKey check sees the full 3-letter team abbreviations.
      // (The old slice(0,13) truncated "26MAY281610ATLBOS" -> "26MAY281610AT"
      // so "ATL" / "BOS" never matched and rosters/boxscores never resolved.)
      gameKey: `MLB ${dt}`,
      sport: "mlb",
    };
  }
  // NBA: KXNBA<STAT>-<dateTeams>-<TEAM><initial><LAST><jersey>-<thr>
  // STAT may start with a digit (e.g. "3PT"). Skip GAME/SPREAD/TOTAL — those
  // are game-level, not player-level.
  const nba = ticker.match(/^KXNBA([A-Z0-9]+)-(\d{2}[A-Z]{3}\d{2}[A-Z]+)-([A-Z]+\d+)-(\d+)$/);
  if (nba && !["GAME", "SPREAD", "TOTAL"].includes(nba[1])) {
    const [, stat, dt, playerBlob, thresholdStr] = nba;
    let teamAbbr = "";
    let lastName = "";
    let jersey = "";
    for (let teamLen = 4; teamLen >= 2; teamLen--) {
      const candidate = playerBlob.slice(0, teamLen);
      if (NBA_TEAMS[candidate]) {
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
      // findEspnEvent checks team-abbr inclusion in the gameKey string, so
      // wrapping the date+teams chunk works for NBA without a date-token
      // entry in legGameKey().
      gameKey: `NBA ${dt}`,
      sport: "nba",
    };
  }
  // WNBA: same blob shape as NBA except jersey digits are OPTIONAL
  // (KXWNBAPTS-26JUL14PDXCONN-PDXSBARKER-20 has none, WSHSCITRON22 does).
  const wnba = ticker.match(/^KXWNBA([A-Z0-9]+)-(\d{2}[A-Z]{3}\d{2}[A-Z]+)-([A-Z]+\d*)-(\d+)$/);
  if (wnba && !["GAME", "SPREAD", "TOTAL"].includes(wnba[1])) {
    const [, stat, dt, playerBlob, thresholdStr] = wnba;
    let teamAbbr = "";
    let lastName = "";
    let jersey = "";
    for (let teamLen = 4; teamLen >= 2; teamLen--) {
      const candidate = playerBlob.slice(0, teamLen);
      if (WNBA_TEAMS[candidate]) {
        teamAbbr = candidate;
        const tail = playerBlob.slice(teamLen);
        const jerseyMatch = tail.match(/^([A-Z]+)(\d*)$/);
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
      gameKey: `WNBA ${dt}`,
      sport: "wnba",
    };
  }
  // NHL: KXNHL<STAT>-<dateTeams>-<TEAM><initial><LAST><jersey>-<thr>
  // Player stats are GOAL / AST / PTS / FIRSTGOAL; GAME/SPREAD/TOTAL are
  // game-level (handled elsewhere). Same blob shape as NBA (no HHMM in the
  // date chunk). Added 2026-05-29 — without this branch NHL player props
  // were never parsed, so they got no headshot/counter/chip.
  const nhl = ticker.match(/^KXNHL([A-Z]+)-(\d{2}[A-Z]{3}\d{2}[A-Z]+)-([A-Z]+\d+)-(\d+)$/);
  if (nhl && !["GAME", "SPREAD", "TOTAL"].includes(nhl[1])) {
    const [, stat, dt, playerBlob, thresholdStr] = nhl;
    let teamAbbr = "";
    let lastName = "";
    let jersey = "";
    for (let teamLen = 4; teamLen >= 2; teamLen--) {
      const candidate = playerBlob.slice(0, teamLen);
      if (NHL_TEAMS[candidate]) {
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
      gameKey: `NHL ${dt}`,
      sport: "nhl",
    };
  }
  return null;
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
    // Keep the full date+HHMM+teams chunk so findEspnEvent can match team
    // abbreviations by substring (see parsePlayerProp comment for context).
    if (m) return `MLB ${m[1]}`;
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
  // Soccer — needed so legResolutionForUs can find the ESPN event and color
  // the leg live (without this, soccer legs never resolved → all grey chips).
  if (/^KX(EPL|LALIGA|SERIEA|BUNDESLIGA|LIGUE1|UCL)/.test(ticker)) {
    const rest = ticker.split("-")[1];
    return rest ? `soccer ${rest}` : "";
  }
  return "";
}

/**
 * Match a leg's gameKey against the loaded ESPN scoreboards. Returns the
 * matching ESPN event or null. We match by uppercase team-abbreviation
 * intersection (works for NHL/MLB/NBA) and by last-name prefix for tennis/UFC.
 *
 * Date sanity gate: when the gKey carries a parseable date token, reject
 * any candidate ESPN event whose start is more than 12h BEFORE that date.
 * Without this, a Game-5-for-tomorrow leg would silently match the same-
 * matchup Game 4 that completed yesterday (both events live in different
 * date scoreboards, both share team abbrs).
 */
// ESPN team-abbr -> Kalshi team-abbr where the two providers diverge. Mirrors
// app.js ESPN_TO_KALSHI_ABBR. Needed because findEspnEvent matches ESPN abbrs
// by substring against the Kalshi gameKey: e.g. ESPN "ARI" must normalize to
// "AZ" or "AZSEA".includes("ARI") is false and the D-backs event never
// resolves (no roster/headshots/live tracking). gKey's leading token gives
// the sport (mlb/nba/nhl) for the sport-scoped lookup.
const ESPN_TO_KALSHI = {
  mlb: { CHW: "CWS", ARI: "AZ", OAK: "ATH", WAS: "WSH" },
  nba: { GS: "GSW", NO: "NOP", NY: "NYK", SA: "SAS", UTAH: "UTA", WSH: "WAS" },
  // Soccer (gKey token is "soccer"). ESPN club codes diverge from Kalshi's;
  // add entries as we hit them. NICE/ASSE = Ligue 1 barrage 2026-05-29.
  soccer: { NICE: "NIC", ASSE: "STE" },
};
function normEspnAbbr(abbr, gKey) {
  const sport = (gKey || "").split(" ")[0].toLowerCase();
  return ESPN_TO_KALSHI[sport]?.[abbr] || abbr;
}

export function findEspnEvent(gKey, scoreboards) {
  // Extract date token from gKey if present (e.g. "NHL 26MAY29MTLCAR"
  // or "MLB 26MAY281610LAADET").
  const dm = (gKey || "").match(/(\d{2})([A-Z]{3})(\d{2})/);
  let tickerMs = null;
  if (dm) {
    const monthMap = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
    const mon = monthMap[dm[2]];
    if (mon) {
      const y = 2000 + parseInt(dm[1], 10);
      const d = parseInt(dm[3], 10);
      tickerMs = Date.UTC(y, mon - 1, d);
    }
  }
  const dateOk = (ev) => {
    if (tickerMs == null) return true;
    const evMs = Date.parse(ev?.date || "");
    if (!Number.isFinite(evMs)) return true;
    return evMs >= tickerMs - 12 * 3600 * 1000;
  };
  for (const sb of Object.values(scoreboards || {})) {
    if (!sb || !Array.isArray(sb.events)) continue;
    for (const ev of sb.events) {
      if (!dateOk(ev)) continue;
      const competitors = ev?.competitions?.[0]?.competitors || [];
      // Team sports
      const abbrs = competitors
        .map((c) => normEspnAbbr((c?.team?.abbreviation || "").toUpperCase(), gKey))
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
