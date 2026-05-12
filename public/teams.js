// Team and abbreviation mappings used to render bet labels.
// NHL/MLB/NBA/IPL/soccer: hardcoded tables (these don't change often).
// Tennis (ATP/WTA) + UFC: dynamic — we read athlete names and country
// flags off the ESPN scoreboards and match by uppercase last-name prefix.

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

// IPL (Indian Premier League cricket). Kalshi uses the standard 3-letter
// abbrev for each franchise. We render full team names on the slip and
// pull logos from the iplt20.com static CDN, which is publicly hot-linkable.
export const IPL_TEAMS = {
  CSK:  "Chennai Super Kings",
  DC:   "Delhi Capitals",
  GT:   "Gujarat Titans",
  KKR:  "Kolkata Knight Riders",
  LSG:  "Lucknow Super Giants",
  MI:   "Mumbai Indians",
  PBKS: "Punjab Kings",
  RCB:  "Royal Challengers Bengaluru",
  RR:   "Rajasthan Royals",
  SRH:  "Sunrisers Hyderabad",
};

// Soccer leagues — Kalshi uses 3-letter team abbrevs that we resolve here.
// Names are kept human-friendly; logos are deferred (ESPN soccer logos are
// keyed by numeric team-id rather than abbrev, so we'd need a separate map).
export const SOCCER_TEAMS = {
  // La Liga
  RVC: "Real Valladolid", GIR: "Girona", RMA: "Real Madrid", BAR: "Barcelona",
  ATM: "Atletico Madrid", SEV: "Sevilla", BIL: "Athletic Bilbao",
  RSO: "Real Sociedad", VAL: "Valencia", VLL: "Real Valladolid",
  CEL: "Celta Vigo", BET: "Real Betis", VIL: "Villarreal", OSU: "Osasuna",
  RAY: "Rayo Vallecano", GET: "Getafe", LEG: "Leganes", MLL: "Mallorca",
  ESP: "Espanyol", ALA: "Alaves", LPA: "Las Palmas",
  // Serie A
  JUV: "Juventus", INT: "Inter Milan", MIL: "AC Milan", NAP: "Napoli",
  ROM: "Roma", LAZ: "Lazio", ATA: "Atalanta", FIO: "Fiorentina",
  BOL: "Bologna", TOR: "Torino", UDI: "Udinese", GEN: "Genoa",
  VEN: "Venezia", PAR: "Parma", LEC: "Lecce", CAG: "Cagliari",
  EMP: "Empoli", VER: "Verona", COM: "Como", MZA: "Monza",
  // Bundesliga
  BAY: "Bayern Munich", BVB: "Borussia Dortmund", LEV: "Bayer Leverkusen",
  RBL: "RB Leipzig", VFB: "VfB Stuttgart", FRA: "Eintracht Frankfurt",
  WOL: "Wolfsburg", FRE: "Freiburg", MAI: "Mainz", AUG: "Augsburg",
  HOF: "Hoffenheim", HEI: "Heidenheim", BMG: "Borussia Monchengladbach",
  BRE: "Werder Bremen", UNI: "Union Berlin", KIE: "Holstein Kiel",
  BOC: "Bochum", STP: "St. Pauli",
  // Ligue 1
  PSG: "Paris Saint-Germain", MAR: "Marseille", LYO: "Lyon", MON: "Monaco",
  LIL: "Lille", REN: "Rennes", NIC: "Nice", NTS: "Nantes", LEN: "Lens",
  STR: "Strasbourg", REI: "Reims", TLS: "Toulouse", BRT: "Brest",
  AUX: "Auxerre", ANG: "Angers", LEH: "Le Havre", MTP: "Montpellier",
  ASE: "Saint-Etienne",
};

// Soccer league prefixes → human label (used in legLabel).
export const SOCCER_LEAGUES = {
  KXLALIGAGAME:     "La Liga",
  KXLALIGABTTS:     "La Liga BTTS",
  KXLALIGA1H:       "La Liga 1H",
  KXSERIEAGAME:     "Serie A",
  KXSERIEABTTS:     "Serie A BTTS",
  KXSERIEA1H:       "Serie A 1H",
  KXBUNDESLIGAGAME: "Bundesliga",
  KXBUNDESLIGABTTS: "Bundesliga BTTS",
  KXBUNDESLIGA1H:   "Bundesliga 1H",
  KXLIGUE1GAME:     "Ligue 1",
  KXLIGUE1BTTS:     "Ligue 1 BTTS",
  KXLIGUE11H:       "Ligue 1 1H",
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

/**
 * Build a tennis/UFC country-flag URL index keyed the same way as
 * buildAthleteIndex. ESPN puts a flag image URL on athlete.flag.href.
 * Returns { "SIN": "https://...italy.png", ... }.
 */
export function buildAthleteFlagIndex(scoreboards) {
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
        const flag = c?.athlete?.flag?.href
          || c?.athlete?.flag?.alt
          || c?.athletes?.[0]?.flag?.href
          || "";
        if (!display || !flag) continue;
        const last = display.trim().split(/\s+/).pop().toUpperCase();
        if (last.length >= 2) {
          idx[last.slice(0, 3)] = flag;
        }
      }
    }
  }
  return idx;
}

/**
 * IPL franchise logos via iplt20.com's public CDN. URLs verified against
 * scores.iplt20.com on 2026-05-12 — the alternate /documents/IPLHeaderLogo
 * path 404s. Falls back to an inline initials badge if Kalshi adds a new
 * team we don't recognise.
 */
const IPL_LOGOS = {
  CSK:  "https://scores.iplt20.com/ipl/teamlogos/CSK.png",
  DC:   "https://scores.iplt20.com/ipl/teamlogos/DC.png",
  GT:   "https://scores.iplt20.com/ipl/teamlogos/GT.png",
  KKR:  "https://scores.iplt20.com/ipl/teamlogos/KKR.png",
  LSG:  "https://scores.iplt20.com/ipl/teamlogos/LSG.png",
  MI:   "https://scores.iplt20.com/ipl/teamlogos/MI.png",
  PBKS: "https://scores.iplt20.com/ipl/teamlogos/PBKS.png",
  RCB:  "https://scores.iplt20.com/ipl/teamlogos/RCB.png",
  RR:   "https://scores.iplt20.com/ipl/teamlogos/RR.png",
  SRH:  "https://scores.iplt20.com/ipl/teamlogos/SRH.png",
};

export function iplLogoUrl(abbr) {
  return IPL_LOGOS[abbr] || "";
}

/**
 * Static map: ATP/WTA player 3-letter abbrev → ISO-2 country code.
 * Used to render a country flag for tennis legs when ESPN's scoreboard
 * doesn't expose per-match athletes (Rome / French Open tournaments
 * only surface the tournament event at the top level — buildAthleteFlagIndex
 * returns empty for these).
 *
 * Maintained manually for matches that have RFQ flow. Add entries here as
 * new players start appearing in our quote stream. Falls back to a text
 * badge if the player isn't mapped.
 */
const TENNIS_PLAYER_COUNTRY = {
  // ATP Rome 2026-05-12 Round of 16
  SIN: "it", // Jannik Sinner
  PEL: "it", // Mattia Pellegrino
  DAR: "it", // Luciano Darderi
  ZVE: "de", // Alexander Zverev
  RUB: "ru", // Andrey Rublev
  BAS: "ge", // Nikoloz Basilashvili
  MED: "ru", // Daniil Medvedev (also matches Medjedovic in some contexts)
  MEJ: "rs", // Hamad Medjedovic (distinct from MED when both play same day)
  LAN: "es", // Martin Landaluce
  TIR: "ar", // Thiago Tirante
  // WTA Rome 2026-05-12
  GAU: "us", // Coco Gauff
  AND: "ru", // Mirra Andreeva
  CIR: "ro", // Sorana Cirstea
  OST: "lv", // Jelena Ostapenko
  // ATP/WTA — common tour regulars (extend as needed)
  DJO: "rs", // Djokovic
  ALC: "es", // Alcaraz
  FRI: "us", // Fritz
  RUN: "no", // Ruud
  RUUD: "no",
  HUR: "us", // Hurkacz
  TSI: "gr", // Tsitsipas
  ARN: "us", // Arnaldi (Italian) — adjust if collides
  SWI: "pl", // Swiatek
  RYB: "kz", // Rybakina
  PEG: "us", // Pegula
  SVI: "ua", // Svitolina
  KEY: "us", // Keys
  SAB: "by", // Sabalenka
};

/** Country flag URL for a tennis player abbrev. Empty when unmapped. */
export function tennisFlagUrl(abbr) {
  const cc = TENNIS_PLAYER_COUNTRY[abbr];
  return cc ? `https://flagcdn.com/w40/${cc}.png` : "";
}

/**
 * Ticker prefixes the dashboard should hide. The Kalshi account is mixed-use
 * — sports parlays from the maker bot plus some manual non-sports positions
 * (elections, etc.) that the user doesn't want surfaced alongside trading
 * exposure. Filtered out on the live page (open parlays) and in the recap
 * back-end (per-day fills).
 *
 * Match is `ticker.startsWith(prefix)`. Add prefixes as new non-sport
 * positions appear.
 */
export const EXCLUDED_TICKER_PREFIXES = [
  "KXGAPRIMARY",  // Georgia House primary positions (manually held)
];

/** True if this ticker should be hidden from the dashboard entirely. */
export function isExcludedTicker(ticker) {
  if (!ticker) return false;
  for (const p of EXCLUDED_TICKER_PREFIXES) {
    if (ticker.startsWith(p)) return true;
  }
  return false;
}
