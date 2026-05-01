// Team and abbreviation mappings used to render bet labels.
// NHL/MLB/NBA: hardcoded tables (these don't change often).
// Tennis (ATP/WTA) + UFC: dynamic — we read athlete names off the ESPN
// scoreboards and match by uppercase last-name prefix.

export const NHL_TEAMS = {
  ANA: "Ducks", BOS: "Bruins", BUF: "Sabres", CAR: "Hurricanes",
  CBJ: "Blue Jackets", CGY: "Flames", CHI: "Blackhawks", COL: "Avalanche",
  DAL: "Stars", DET: "Red Wings", EDM: "Oilers", FLA: "Panthers",
  LAK: "Kings", MIN: "Wild", MTL: "Canadiens", NSH: "Predators",
  NJD: "Devils", NYI: "Islanders", NYR: "Rangers", OTT: "Senators",
  PHI: "Flyers", PIT: "Penguins", SEA: "Kraken", SJS: "Sharks",
  STL: "Blues", TBL: "Lightning", TOR: "Maple Leafs", UTA: "Mammoth",
  VAN: "Canucks", VGK: "Golden Knights", WSH: "Capitals", WPG: "Jets",
};

export const MLB_TEAMS = {
  ARI: "Diamondbacks", AZ: "Diamondbacks",
  ATH: "Athletics", OAK: "Athletics",
  ATL: "Braves", BAL: "Orioles", BOS: "Red Sox",
  CHC: "Cubs", CHW: "White Sox", CWS: "White Sox",
  CIN: "Reds", CLE: "Guardians", COL: "Rockies",
  DET: "Tigers", HOU: "Astros", KC: "Royals",
  LAA: "Angels", LAD: "Dodgers", MIA: "Marlins", MIL: "Brewers",
  MIN: "Twins", NYM: "Mets", NYY: "Yankees",
  PHI: "Phillies", PIT: "Pirates", SD: "Padres",
  SF: "Giants", SEA: "Mariners", STL: "Cardinals",
  TB: "Rays", TEX: "Rangers", TOR: "Blue Jays", WSH: "Nationals",
};

export const NBA_TEAMS = {
  ATL: "Hawks", BOS: "Celtics", BKN: "Nets", CHA: "Hornets",
  CHI: "Bulls", CLE: "Cavaliers", DAL: "Mavericks", DEN: "Nuggets",
  DET: "Pistons", GSW: "Warriors", HOU: "Rockets", IND: "Pacers",
  LAC: "Clippers", LAL: "Lakers", MEM: "Grizzlies", MIA: "Heat",
  MIL: "Bucks", MIN: "Timberwolves", NOP: "Pelicans", NYK: "Knicks",
  OKC: "Thunder", ORL: "Magic", PHI: "76ers", PHX: "Suns",
  POR: "Trail Blazers", SAC: "Kings", SAS: "Spurs", TOR: "Raptors",
  UTA: "Jazz", WAS: "Wizards",
};

// Stat-suffix decoder for MLB player props
// Ticker forms (suffix after the team-player block + dash + threshold):
//   KXMLBHR-...  → home runs
//   KXMLBHIT-... → hits
//   KXMLBKS-...  → strikeouts (pitcher when player is a pitcher)
//   KXMLBHRR-... → hits + runs + RBIs
//   KXMLBR-...   → runs scored
//   KXMLBRBI-... → RBIs
//   KXMLBTB-...  → total bases
//   KXMLBBB-...  → walks
//   KXMLBIP-...  → innings pitched (pitcher)
//   KXMLBF5-...  → first-5 (game-level)
export const MLB_STAT_LABELS = {
  HR:   "HR",
  HIT:  "hit",
  HITS: "hits",
  KS:   "Ks",
  HRR:  "hits + runs + RBIs",
  R:    "runs",
  RBI:  "RBIs",
  TB:   "total bases",
  BB:   "walks",
  IP:   "IP",
  F5:   "first-5",
};

export const NBA_STAT_LABELS = {
  PTS:  "points",
  REB:  "rebounds",
  AST:  "assists",
  "3PT": "3-pointers",
  STL:  "steals",
  BLK:  "blocks",
};

/**
 * Build a tennis/UFC athlete index keyed by 3-letter uppercase last-name prefix.
 * The Kalshi ticker uses the 3-letter form; ESPN gives us the full name.
 *
 * Pass in all loaded scoreboard payloads. Returns { "SIN": "Jannik Sinner", ... }.
 */
export function buildAthleteIndex(scoreboards) {
  const idx = {};
  for (const sb of Object.values(scoreboards || {})) {
    if (!sb || !Array.isArray(sb.events)) continue;
    for (const ev of sb.events) {
      const competitors = ev?.competitions?.[0]?.competitors || [];
      for (const c of competitors) {
        const display = c?.athlete?.displayName
          || c?.athlete?.fullName
          || c?.athletes?.[0]?.displayName
          || "";
        if (!display) continue;
        const last = display.trim().split(/\s+/).pop().toUpperCase();
        if (last.length >= 2) {
          idx[last.slice(0, 3)] = display;
        }
      }
    }
  }
  return idx;
}
