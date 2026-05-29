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

// Soccer team abbrev → full name. Keys are the 3-4 char codes Kalshi
// actually uses in event tickers (derived from /events?series_ticker=...
// titles, 2026-05-12). Some abbrevs collide across leagues (LEV, BRE,
// PAR), so callers using these names for matchup labels should also
// pass league when looking up logos.
export const SOCCER_TEAMS = {
  // EPL
  ARS: "Arsenal", AVL: "Aston Villa", BOU: "Bournemouth", BRE: "Brentford",
  BRI: "Brighton", BUR: "Burnley", CFC: "Chelsea", CRY: "Crystal Palace",
  EVE: "Everton", FUL: "Fulham", LEE: "Leeds United", LFC: "Liverpool",
  MCI: "Manchester City", MUN: "Manchester United", NEW: "Newcastle",
  NFO: "Nottingham Forest", SUN: "Sunderland", TOT: "Tottenham",
  WHU: "West Ham", WOL: "Wolves",
  // La Liga (Kalshi codes: RBB=Real Betis, RCC=Celta, VCF=Valencia,
  // RVC=Vallecano, ATH=Athletic Bilbao — differ from ESPN's abbrevs.)
  ALA: "Alaves", ATH: "Athletic Bilbao", ATM: "Atletico Madrid",
  BAR: "Barcelona", RBB: "Real Betis", RCC: "Celta Vigo", ELC: "Elche",
  ESP: "Espanyol", GET: "Getafe", GIR: "Girona", LEV: "Levante",
  MAL: "Mallorca", OSA: "Osasuna", OVI: "Real Oviedo", RVC: "Rayo Vallecano",
  RMA: "Real Madrid", RSO: "Real Sociedad", SEV: "Sevilla", VCF: "Valencia",
  VIL: "Villarreal",
  // Serie A
  ATA: "Atalanta", BFC: "Bologna", CAG: "Cagliari", COM: "Como",
  CRE: "Cremonese", FIO: "Fiorentina", GEN: "Genoa", INT: "Inter Milan",
  JUV: "Juventus", LAZ: "Lazio", LEC: "Lecce", ACM: "AC Milan",
  NAP: "Napoli", PAR: "Parma", PIS: "Pisa", ROM: "Roma", SAS: "Sassuolo",
  TOR: "Torino", UDI: "Udinese", VER: "Hellas Verona",
  // Bundesliga (BMU=Bayern, BMG=M'gladbach, FCU/UNI=Union Berlin)
  B04: "Bayer Leverkusen", BMG: "B. Monchengladbach", BVB: "Borussia Dortmund",
  FCA: "Augsburg", FCU: "Union Berlin", UNI: "Union Berlin",
  HDH: "Heidenheim", HSV: "Hamburg SV", KOE: "FC Koln", M05: "Mainz",
  BMU: "Bayern Munich", RBL: "RB Leipzig", SCF: "SC Freiburg",
  SGE: "Eintracht Frankfurt", STP: "St. Pauli", SVW: "Werder Bremen",
  TSG: "Hoffenheim", VFB: "VfB Stuttgart", WOB: "Wolfsburg",
  // Ligue 1 (FCN=Nantes, ASM=Monaco, OM=Marseille, OL=Lyon)
  ANG: "Angers", AUX: "Auxerre", STB: "Stade Brest", HAC: "Le Havre",
  LIL: "Lille", FCL: "Lorient", OL: "Lyon", FCM: "Metz",
  ASM: "AS Monaco", FCN: "Nantes", NIC: "Nice", OM: "Marseille", STE: "Saint-Etienne",
  RCL: "Lens", REN: "Rennes", RCS: "Strasbourg", TFC: "Toulouse",
  // PAR is also Ligue 1 Paris FC but conflicts with SerieA Parma; mainly
  // labelled via PSG (PSG = Paris Saint-Germain, distinct).
  PSG: "Paris Saint-Germain",
};

// Soccer league prefixes → human label (used in legLabel).
// Each league has GAME / SPREAD / TOTAL / BTTS markets in Kalshi's combo
// product. 1H (first half) exists for some leagues but isn't in the
// user-confirmed combo list — kept entries here for legacy decoding.
export const SOCCER_LEAGUES = {
  // EPL
  KXEPLGAME:        "EPL",
  KXEPLSPREAD:      "EPL spread",
  KXEPLTOTAL:       "EPL total",
  KXEPLBTTS:        "EPL BTTS",
  // La Liga
  KXLALIGAGAME:     "La Liga",
  KXLALIGASPREAD:   "La Liga spread",
  KXLALIGATOTAL:    "La Liga total",
  KXLALIGABTTS:     "La Liga BTTS",
  KXLALIGA1H:       "La Liga 1H",
  // Serie A
  KXSERIEAGAME:     "Serie A",
  KXSERIEASPREAD:   "Serie A spread",
  KXSERIEATOTAL:    "Serie A total",
  KXSERIEABTTS:     "Serie A BTTS",
  KXSERIEA1H:       "Serie A 1H",
  // Bundesliga
  KXBUNDESLIGAGAME:   "Bundesliga",
  KXBUNDESLIGASPREAD: "Bundesliga spread",
  KXBUNDESLIGATOTAL:  "Bundesliga total",
  KXBUNDESLIGABTTS:   "Bundesliga BTTS",
  KXBUNDESLIGA1H:     "Bundesliga 1H",
  // Ligue 1
  KXLIGUE1GAME:     "Ligue 1",
  KXLIGUE1SPREAD:   "Ligue 1 spread",
  KXLIGUE1TOTAL:    "Ligue 1 total",
  KXLIGUE1BTTS:     "Ligue 1 BTTS",
  KXLIGUE11H:       "Ligue 1 1H",
  // UEFA Champions League
  KXUCLGAME:        "Champions League",
  KXUCLSPREAD:      "Champions League spread",
  KXUCLTOTAL:       "Champions League total",
  KXUCLBTTS:        "Champions League BTTS",
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
 * Soccer team logos by league. Resolved 2026-05-12 from ESPN's per-league
 * /teams endpoint cross-referenced against Kalshi's event titles. Each entry
 * is a league prefix (EPL / LALIGA / SERIEA / BUNDESLIGA / LIGUE1) → Kalshi's
 * 3-letter team abbrev → ESPN team-logo URL.
 *
 * Note: Kalshi's abbrevs differ from ESPN's in several places (e.g.
 * KXLALIGAGAME uses RCC for Celta Vigo where ESPN uses CEL; Kalshi uses
 * BMU for Bayern where ESPN uses MUN). And some abbrevs collide across
 * leagues (LEV = Levante in LaLiga AND Bayer Leverkusen in Bundesliga;
 * BRE = Brentford in EPL AND Brest in Ligue 1). League-aware lookup is
 * required.
 */
const SOCCER_LOGOS = {
  EPL: {
    ARS: "https://a.espncdn.com/i/teamlogos/soccer/500/359.png",  // Arsenal
    AVL: "https://a.espncdn.com/i/teamlogos/soccer/500/362.png",  // Aston Villa
    BOU: "https://a.espncdn.com/i/teamlogos/soccer/500/349.png",  // AFC Bournemouth
    BRE: "https://a.espncdn.com/i/teamlogos/soccer/500/337.png",  // Brentford
    BRI: "https://a.espncdn.com/i/teamlogos/soccer/500/331.png",  // Brighton
    BUR: "https://a.espncdn.com/i/teamlogos/soccer/500/379.png",  // Burnley
    CFC: "https://a.espncdn.com/i/teamlogos/soccer/500/363.png",  // Chelsea
    CRY: "https://a.espncdn.com/i/teamlogos/soccer/500/384.png",  // Crystal Palace
    EVE: "https://a.espncdn.com/i/teamlogos/soccer/500/368.png",  // Everton
    FUL: "https://a.espncdn.com/i/teamlogos/soccer/500/370.png",  // Fulham
    LEE: "https://a.espncdn.com/i/teamlogos/soccer/500/357.png",  // Leeds
    LFC: "https://a.espncdn.com/i/teamlogos/soccer/500/364.png",  // Liverpool
    MCI: "https://a.espncdn.com/i/teamlogos/soccer/500/382.png",  // Man City
    MUN: "https://a.espncdn.com/i/teamlogos/soccer/500/360.png",  // Man United
    NEW: "https://a.espncdn.com/i/teamlogos/soccer/500/361.png",  // Newcastle
    NFO: "https://a.espncdn.com/i/teamlogos/soccer/500/393.png",  // Nottingham Forest
    SUN: "https://a.espncdn.com/i/teamlogos/soccer/500/366.png",  // Sunderland
    TOT: "https://a.espncdn.com/i/teamlogos/soccer/500/367.png",  // Tottenham
    WHU: "https://a.espncdn.com/i/teamlogos/soccer/500/371.png",  // West Ham
    WOL: "https://a.espncdn.com/i/teamlogos/soccer/500/380.png",  // Wolves
  },
  LALIGA: {
    ALA: "https://a.espncdn.com/i/teamlogos/soccer/500/96.png",   // Alavés
    ATH: "https://a.espncdn.com/i/teamlogos/soccer/500/93.png",   // Athletic Bilbao
    ATM: "https://a.espncdn.com/i/teamlogos/soccer/500/1068.png", // Atlético Madrid
    BAR: "https://a.espncdn.com/i/teamlogos/soccer/500/83.png",   // Barcelona
    RBB: "https://a.espncdn.com/i/teamlogos/soccer/500/244.png",  // Real Betis
    RCC: "https://a.espncdn.com/i/teamlogos/soccer/500/85.png",   // Celta Vigo
    ELC: "https://a.espncdn.com/i/teamlogos/soccer/500/3751.png", // Elche
    ESP: "https://a.espncdn.com/i/teamlogos/soccer/500/88.png",   // Espanyol
    GET: "https://a.espncdn.com/i/teamlogos/soccer/500/2922.png", // Getafe
    GIR: "https://a.espncdn.com/i/teamlogos/soccer/500/9812.png", // Girona
    LEV: "https://a.espncdn.com/i/teamlogos/soccer/500/1538.png", // Levante
    MAL: "https://a.espncdn.com/i/teamlogos/soccer/500/84.png",   // Mallorca
    OSA: "https://a.espncdn.com/i/teamlogos/soccer/500/97.png",   // Osasuna
    OVI: "https://a.espncdn.com/i/teamlogos/soccer/500/92.png",   // Real Oviedo
    RVC: "https://a.espncdn.com/i/teamlogos/soccer/500/101.png",  // Rayo Vallecano
    RMA: "https://a.espncdn.com/i/teamlogos/soccer/500/86.png",   // Real Madrid
    RSO: "https://a.espncdn.com/i/teamlogos/soccer/500/89.png",   // Real Sociedad
    SEV: "https://a.espncdn.com/i/teamlogos/soccer/500/243.png",  // Sevilla
    VCF: "https://a.espncdn.com/i/teamlogos/soccer/500/94.png",   // Valencia
    VIL: "https://a.espncdn.com/i/teamlogos/soccer/500/102.png",  // Villarreal
  },
  SERIEA: {
    ATA: "https://a.espncdn.com/i/teamlogos/soccer/500/105.png",  // Atalanta
    BFC: "https://a.espncdn.com/i/teamlogos/soccer/500/107.png",  // Bologna
    CAG: "https://a.espncdn.com/i/teamlogos/soccer/500/2925.png", // Cagliari
    COM: "https://a.espncdn.com/i/teamlogos/soccer/500/2572.png", // Como
    CRE: "https://a.espncdn.com/i/teamlogos/soccer/500/4050.png", // Cremonese
    FIO: "https://a.espncdn.com/i/teamlogos/soccer/500/109.png",  // Fiorentina
    GEN: "https://a.espncdn.com/i/teamlogos/soccer/500/3263.png", // Genoa
    INT: "https://a.espncdn.com/i/teamlogos/soccer/500/110.png",  // Inter
    JUV: "https://a.espncdn.com/i/teamlogos/soccer/500/111.png",  // Juventus
    LAZ: "https://a.espncdn.com/i/teamlogos/soccer/500/112.png",  // Lazio
    LEC: "https://a.espncdn.com/i/teamlogos/soccer/500/113.png",  // Lecce
    ACM: "https://a.espncdn.com/i/teamlogos/soccer/500/103.png",  // AC Milan
    NAP: "https://a.espncdn.com/i/teamlogos/soccer/500/114.png",  // Napoli
    PAR: "https://a.espncdn.com/i/teamlogos/soccer/500/115.png",  // Parma
    PIS: "https://a.espncdn.com/i/teamlogos/soccer/500/3956.png", // Pisa
    ROM: "https://a.espncdn.com/i/teamlogos/soccer/500/104.png",  // Roma
    SAS: "https://a.espncdn.com/i/teamlogos/soccer/500/3997.png", // Sassuolo
    TOR: "https://a.espncdn.com/i/teamlogos/soccer/500/239.png",  // Torino
    UDI: "https://a.espncdn.com/i/teamlogos/soccer/500/118.png",  // Udinese
    VER: "https://a.espncdn.com/i/teamlogos/soccer/500/119.png",  // Hellas Verona
  },
  BUNDESLIGA: {
    B04: "https://a.espncdn.com/i/teamlogos/soccer/500/131.png",  // Leverkusen
    LEV: "https://a.espncdn.com/i/teamlogos/soccer/500/131.png",  // Leverkusen (alt)
    BMG: "https://a.espncdn.com/i/teamlogos/soccer/500/268.png",  // M'gladbach
    BVB: "https://a.espncdn.com/i/teamlogos/soccer/500/124.png",  // Dortmund
    FCA: "https://a.espncdn.com/i/teamlogos/soccer/500/3841.png", // Augsburg
    FCU: "https://a.espncdn.com/i/teamlogos/soccer/500/598.png",  // Union Berlin
    UNI: "https://a.espncdn.com/i/teamlogos/soccer/500/598.png",  // Union Berlin (alt)
    HDH: "https://a.espncdn.com/i/teamlogos/soccer/500/6418.png", // Heidenheim
    HEI: "https://a.espncdn.com/i/teamlogos/soccer/500/6418.png", // (alt)
    HSV: "https://a.espncdn.com/i/teamlogos/soccer/500/127.png",  // Hamburg SV
    KOE: "https://a.espncdn.com/i/teamlogos/soccer/500/122.png",  // FC Köln
    M05: "https://a.espncdn.com/i/teamlogos/soccer/500/2950.png", // Mainz
    MAI: "https://a.espncdn.com/i/teamlogos/soccer/500/2950.png", // Mainz (alt)
    BMU: "https://a.espncdn.com/i/teamlogos/soccer/500/132.png",  // Bayern Munich
    BAY: "https://a.espncdn.com/i/teamlogos/soccer/500/132.png",  // Bayern (alt)
    RBL: "https://a.espncdn.com/i/teamlogos/soccer/500/11420.png",// RB Leipzig
    SCF: "https://a.espncdn.com/i/teamlogos/soccer/500/126.png",  // Freiburg
    FRE: "https://a.espncdn.com/i/teamlogos/soccer/500/126.png",  // Freiburg (alt)
    SGE: "https://a.espncdn.com/i/teamlogos/soccer/500/125.png",  // Frankfurt
    FRA: "https://a.espncdn.com/i/teamlogos/soccer/500/125.png",  // Frankfurt (alt)
    STP: "https://a.espncdn.com/i/teamlogos/soccer/500/270.png",  // St. Pauli
    SVW: "https://a.espncdn.com/i/teamlogos/soccer/500/137.png",  // Werder Bremen
    BRE: "https://a.espncdn.com/i/teamlogos/soccer/500/137.png",  // Bremen (Kalshi BRE)
    TSG: "https://a.espncdn.com/i/teamlogos/soccer/500/7911.png", // Hoffenheim
    HOF: "https://a.espncdn.com/i/teamlogos/soccer/500/7911.png", // Hoffenheim (alt)
    VFB: "https://a.espncdn.com/i/teamlogos/soccer/500/134.png",  // Stuttgart
    WOB: "https://a.espncdn.com/i/teamlogos/soccer/500/138.png",  // Wolfsburg
    WOL: "https://a.espncdn.com/i/teamlogos/soccer/500/138.png",  // Wolfsburg (alt)
  },
  LIGUE1: {
    ANG: "https://a.espncdn.com/i/teamlogos/soccer/500/7868.png", // Angers
    AUX: "https://a.espncdn.com/i/teamlogos/soccer/500/172.png",  // Auxerre
    STB: "https://a.espncdn.com/i/teamlogos/soccer/500/6997.png", // Stade Brest
    BRT: "https://a.espncdn.com/i/teamlogos/soccer/500/6997.png", // Brest (alt)
    HAC: "https://a.espncdn.com/i/teamlogos/soccer/500/3236.png", // Le Havre
    LEH: "https://a.espncdn.com/i/teamlogos/soccer/500/3236.png", // Le Havre (alt)
    LIL: "https://a.espncdn.com/i/teamlogos/soccer/500/166.png",  // Lille
    FCL: "https://a.espncdn.com/i/teamlogos/soccer/500/273.png",  // Lorient
    OL:  "https://a.espncdn.com/i/teamlogos/soccer/500/167.png",  // Lyon
    LYO: "https://a.espncdn.com/i/teamlogos/soccer/500/167.png",  // Lyon (alt)
    FCM: "https://a.espncdn.com/i/teamlogos/soccer/500/177.png",  // Metz
    ASM: "https://a.espncdn.com/i/teamlogos/soccer/500/174.png",  // Monaco
    MON: "https://a.espncdn.com/i/teamlogos/soccer/500/174.png",  // Monaco (alt)
    FCN: "https://a.espncdn.com/i/teamlogos/soccer/500/165.png",  // Nantes
    NTS: "https://a.espncdn.com/i/teamlogos/soccer/500/165.png",  // Nantes (alt)
    NIC: "https://a.espncdn.com/i/teamlogos/soccer/500/2502.png", // Nice
    STE: "https://a.espncdn.com/i/teamlogos/soccer/500/178.png",  // Saint-Etienne
    OM:  "https://a.espncdn.com/i/teamlogos/soccer/500/176.png",  // Marseille
    MAR: "https://a.espncdn.com/i/teamlogos/soccer/500/176.png",  // Marseille (alt)
    PAR: "https://a.espncdn.com/i/teamlogos/soccer/500/6851.png", // Paris FC
    PSG: "https://a.espncdn.com/i/teamlogos/soccer/500/160.png",  // PSG
    RCL: "https://a.espncdn.com/i/teamlogos/soccer/500/175.png",  // Lens
    LEN: "https://a.espncdn.com/i/teamlogos/soccer/500/175.png",  // Lens (alt)
    REN: "https://a.espncdn.com/i/teamlogos/soccer/500/169.png",  // Rennes
    RCS: "https://a.espncdn.com/i/teamlogos/soccer/500/180.png",  // Strasbourg
    STR: "https://a.espncdn.com/i/teamlogos/soccer/500/180.png",  // Strasbourg (alt)
    TFC: "https://a.espncdn.com/i/teamlogos/soccer/500/179.png",  // Toulouse
    TLS: "https://a.espncdn.com/i/teamlogos/soccer/500/179.png",  // Toulouse (alt)
  },
};

/** Soccer team logo URL by league + Kalshi abbrev. Empty when unmapped. */
export function soccerLogoUrl(league, abbr) {
  if (!abbr) return "";
  const direct = league && SOCCER_LOGOS[league]?.[abbr];
  if (direct) return direct;
  // Cross-league fallback: UCL/Europa pull clubs from many domestic leagues
  // (and have no logo table of their own), so search every league for the
  // abbr. Only runs when the league-specific lookup misses, so known-league
  // disambiguation (LEV, BRE) is unaffected.
  for (const tbl of Object.values(SOCCER_LOGOS)) {
    if (tbl[abbr]) return tbl[abbr];
  }
  return "";
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
  // 2026-05-12: accidental yes-side fill (1 contract @ $0.01) before the
  // long-no-only hard guard patch landed. Wrong-side trade, don't let it
  // distort PnL/ROI. Full ticker so we exclude only this single market.
  "KXMVECROSSCATEGORY-S2026DCED9D7F34E-03691C96109",
];

/** True if this ticker should be hidden from the dashboard entirely. */
export function isExcludedTicker(ticker) {
  if (!ticker) return false;
  for (const p of EXCLUDED_TICKER_PREFIXES) {
    if (ticker.startsWith(p)) return true;
  }
  return false;
}
