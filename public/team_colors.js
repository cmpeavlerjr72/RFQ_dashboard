// Canonical per-team bar colors for the live momentum chart. [primary, secondary].
// PRIMARY = the color most associated with the national team — usually the kit /
// identity color, NOT the flag (e.g. NED is orange though orange isn't on the
// flag; ARG sky blue; ITA azzurri). SECONDARY = a distinct fallback used when the
// two teams in a match have near-identical primaries (e.g. two reds), so one bar
// stays readable. White-kit teams use their distinctive visible color (GER/NZL
// black, ENG/JOR red, UZB blue, IRQ green) since white is invisible on the chart.
// Researched against the 2026 World Cup field (kits + traditional identities).
export const TEAM_COLORS = {
  ARG: ["#6CA9DC", "#0C2340"],   // Argentina — sky blue (Albiceleste) / navy
  AUS: ["#FFCD00", "#00843D"],   // Australia — gold / green
  AUT: ["#D6001C", "#2B2B2B"],   // Austria — red / dark
  BEL: ["#D6001C", "#1A1A1A"],   // Belgium — red (Red Devils) / black
  BIH: ["#1B4DA0", "#F2C200"],   // Bosnia — royal blue / yellow
  BRA: ["#F4C300", "#1E50A0"],   // Brazil — canary yellow / blue
  CAN: ["#D52B1E", "#2B2B2B"],   // Canada — red / dark
  CIV: ["#F37021", "#0E7A3B"],   // Ivory Coast — orange (Les Éléphants) / green
  COD: ["#4FA8E0", "#D6001C"],   // DR Congo — light blue (Leopards) / red
  COL: ["#F4C300", "#1B3FA0"],   // Colombia — yellow / blue
  CPV: ["#1E3A8C", "#CE1126"],   // Cape Verde — deep blue (Blue Sharks) / red
  CRO: ["#D6001C", "#1B4DA0"],   // Croatia — red (checkers) / blue
  CUW: ["#1565C0", "#F2C200"],   // Curacao — lucid blue / yellow
  CZE: ["#D6001C", "#11457E"],   // Czechia — red / blue
  DZA: ["#0E7A3B", "#2B2B2B"],   // Algeria — green (Fennecs) / dark
  ECU: ["#F4C300", "#1B3FA0"],   // Ecuador — yellow (La Tri) / blue
  EGY: ["#D6001C", "#1A1A1A"],   // Egypt — red (Pharaohs) / black
  ENG: ["#CE1124", "#16276B"],   // England — red (1966 / cross) / navy
  ESP: ["#C60B1E", "#1A2A5E"],   // Spain — red (La Roja) / navy
  FRA: ["#1E3A8C", "#CE1124"],   // France — blue (Les Bleus) / red
  GER: ["#303030", "#0E7A3B"],   // Germany — black (white kit invisible) / green
  GHA: ["#CE1124", "#107C41"],   // Ghana — red / green
  HTI: ["#1F4FA0", "#CE1124"],   // Haiti — blue / red
  IRI: ["#C8102E", "#107C41"],   // Iran — red / green
  IRQ: ["#107C41", "#1A1A1A"],   // Iraq — green (Lions of Mesopotamia) / black
  JOR: ["#C8102E", "#107C41"],   // Jordan — red / green
  JPN: ["#0C1C8C", "#C8102E"],   // Japan — deep blue (Samurai Blue) / red
  KOR: ["#C8102E", "#0C2340"],   // Korea Republic — red / navy
  KSA: ["#107C41", "#2B2B2B"],   // Saudi Arabia — green (Green Falcons) / dark
  MAR: ["#C1272D", "#0E7A3B"],   // Morocco — red (Atlas Lions) / green
  MEX: ["#0E7A3B", "#C8102E"],   // Mexico — green (El Tri) / red
  NED: ["#FF6900", "#1A2A5E"],   // Netherlands — orange (Oranje) / navy
  NOR: ["#C8102E", "#0C2340"],   // Norway — red / navy
  NZL: ["#1A1A1A", "#9AA0A6"],   // New Zealand — black (All Whites / silver fern) / silver
  PAN: ["#C8102E", "#0C2340"],   // Panama — red / navy
  PAR: ["#C8102E", "#1B4DA0"],   // Paraguay — red (Albirroja) / blue
  POR: ["#C8102E", "#0E7A3B"],   // Portugal — red / green
  QAT: ["#8A1538", "#B8B8B8"],   // Qatar — maroon (The Maroons) / grey
  RSA: ["#E6B800", "#0E7A3B"],   // South Africa — gold (Bafana) / green
  SCO: ["#0C2340", "#3A6FB0"],   // Scotland — navy (Tartan Army) / light blue
  SEN: ["#0E7A3B", "#E6B800"],   // Senegal — green (Lions of Teranga) / gold
  SUI: ["#D6001C", "#2B2B2B"],   // Switzerland — red (white cross) / dark
  SWE: ["#F4C300", "#1B4DA0"],   // Sweden — yellow (Blågult) / blue
  TUN: ["#C8102E", "#1A1A1A"],   // Tunisia — red (Eagles of Carthage) / dark
  TUR: ["#C8102E", "#0C2340"],   // Turkiye — red (Crescent-Stars) / navy
  URU: ["#4AA3DF", "#0C2340"],   // Uruguay — sky blue (Celeste) / navy
  USA: ["#0A2240", "#C8102E"],   // USA — navy / red
  UZB: ["#1565C0", "#0E7A3B"],   // Uzbekistan — blue / green
};

function _rgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function _dist(a, b) { const x = _rgb(a), y = _rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); }

const GENERIC = ["#1f77b4", "#e0512f"];
const CLASH = 120;   // RGB-distance threshold below which two bars read the same

// Resolve the two bar colors for a match, keeping the home team on its primary
// and falling the AWAY team back to its secondary when the primaries clash
// (then the home team's secondary as a last resort).
export function teamBarColors(homeCode, awayCode) {
  const h = TEAM_COLORS[homeCode] || [GENERIC[0], "#5a8fc0"];
  const a = TEAM_COLORS[awayCode] || [GENERIC[1], "#b07a3a"];
  let hc = h[0], ac = a[0];
  if (_dist(hc, ac) < CLASH) {
    if (_dist(hc, a[1]) >= CLASH) ac = a[1];
    else if (_dist(h[1], ac) >= CLASH) hc = h[1];
    else ac = a[1];
  }
  return { home: hc, away: ac };
}
