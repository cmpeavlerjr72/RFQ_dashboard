// ESPN scoreboard proxy with adaptive TTL caching.
// Modeled directly on Monte-Site server/liveScores.ts patterns.
//
// One ESPN call per (sport, date) per cache window — even with 100 viewers,
// ESPN gets hit at most ~3 times/min when games are live, ~0.5 times/min idle.

import { TTLCache, fetchJsonWithTimeout } from "./cache.js";

export type Sport =
  | "mlb" | "nhl" | "nba" | "wnba" | "ufc" | "atp" | "wta"
  // Soccer leagues — each maps to its own ESPN slug. Game cards + live
  // score/clock tracking; no player props (no boxscore/roster use, but the
  // slug maps below carry entries so the Record<Sport,string> stays total).
  | "epl" | "laliga" | "seriea" | "bundesliga" | "ligue1" | "ucl"
  // National-team soccer: 2026 World Cup + international friendlies.
  | "wcup" | "intlfriendly";

// ESPN soccer league slugs, shared by scoreboard/boxscore/roster URL builders.
const SOCCER_SLUG: Record<string, string> = {
  epl: "eng.1", laliga: "esp.1", seriea: "ita.1",
  bundesliga: "ger.1", ligue1: "fra.1", ucl: "uefa.champions",
  wcup: "fifa.world", intlfriendly: "fifa.friendly",
};

// Extra ESPN soccer slugs whose events get MERGED into a league's scoreboard.
// ESPN files promotion/relegation play-off ("barrage") matches under a
// separate competition slug, not the regular-season league — so without this
// the Ligue 1 barrage (Nice vs St-Étienne) is invisible to fra.1. Empty/absent
// off-season; the extra fetch just returns 0 events then.
const SOCCER_EXTRA_SLUGS: Record<string, string[]> = {
  ligue1: ["fra.1.promotion.relegation"],
};

function soccerScoreboardUrl(slug: string, dateYYYYMMDD: string): string {
  const d = String(dateYYYYMMDD).replace(/-/g, "");
  return `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${d}&limit=300`;
}

// Fetch the league scoreboard and fold in any extra-slug events (barrages).
async function fetchScoreboardMerged(sport: Sport, dateYYYYMMDD: string): Promise<ScoreboardPayload> {
  const base = await fetchJsonWithTimeout(espnUrl(sport, dateYYYYMMDD));
  const extras = SOCCER_EXTRA_SLUGS[sport];
  if (extras) {
    for (const slug of extras) {
      try {
        const ex = await fetchJsonWithTimeout(soccerScoreboardUrl(slug, dateYYYYMMDD));
        if (Array.isArray(ex?.events) && ex.events.length) {
          base.events = [...(base?.events || []), ...ex.events];
        }
      } catch { /* extra slug is best-effort */ }
    }
  }
  return base;
}

interface ScoreboardPayload {
  [k: string]: any;
}

const cache = new TTLCache<ScoreboardPayload>();

function espnUrl(sport: Sport, dateYYYYMMDD: string): string {
  const d = String(dateYYYYMMDD).replace(/-/g, "");
  switch (sport) {
    case "mlb":
      return `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${d}&limit=300`;
    case "nhl":
      return `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${d}&limit=300`;
    case "nba":
      return `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${d}&limit=300`;
    case "wnba":
      return `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${d}&limit=300`;
    case "ufc":
      return `https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=${d}&limit=300`;
    case "atp":
      return `https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard?dates=${d}&limit=300`;
    case "wta":
      return `https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard?dates=${d}&limit=300`;
    default:
      // Soccer leagues
      return `https://site.api.espn.com/apis/site/v2/sports/soccer/${SOCCER_SLUG[sport]}/scoreboard?dates=${d}&limit=300`;
  }
}

function countLive(payload: ScoreboardPayload): number {
  try {
    const events: any[] = Array.isArray(payload?.events) ? payload.events : [];
    return events.filter((e) => e?.status?.type?.state === "in").length;
  } catch {
    return 0;
  }
}

function ttlFor(payload: ScoreboardPayload): number {
  return countLive(payload) > 0 ? 20_000 : 120_000;
}

export async function getScoreboard(
  sport: Sport,
  dateYYYYMMDD: string,
  force = false,
): Promise<ScoreboardPayload> {
  const key = `${sport}:${dateYYYYMMDD}`;
  if (force) cache.set(key, {}, 0);
  return cache.getOrFetch(
    key,
    () => fetchScoreboardMerged(sport, dateYYYYMMDD),
    ttlFor,
  );
}

export function cacheStats() {
  return { size: cache.size() };
}

// ----------------------------------------------------------------------------
// Per-game box score (player stats)
// ----------------------------------------------------------------------------

const boxscoreCache = new TTLCache<any>();

function boxscoreUrl(sport: Sport, eventId: string): string {
  const segByLeague: Record<Sport, string> = {
    mlb: "baseball/mlb",
    nhl: "hockey/nhl",
    nba: "basketball/nba",
    wnba: "basketball/wnba",
    ufc: "mma/ufc",
    atp: "tennis/atp",
    wta: "tennis/wta",
    // Soccer (no player props; present only to keep the Record total).
    epl: "soccer/eng.1",
    laliga: "soccer/esp.1",
    seriea: "soccer/ita.1",
    bundesliga: "soccer/ger.1",
    ligue1: "soccer/fra.1",
    ucl: "soccer/uefa.champions",
    wcup: "soccer/fifa.world",
    intlfriendly: "soccer/fifa.friendly",
  };
  const seg = segByLeague[sport];
  return `https://site.api.espn.com/apis/site/v2/sports/${seg}/summary?event=${encodeURIComponent(eventId)}`;
}

function ttlForBoxscore(payload: any): number {
  // If the game is "in" (live), refresh fast. Otherwise slow.
  const state = payload?.header?.competitions?.[0]?.status?.type?.state
    || payload?.gameInfo?.status?.type?.state;
  return state === "in" ? 30_000 : 180_000;
}

export async function getBoxscore(
  sport: Sport,
  eventId: string,
  force = false,
): Promise<any> {
  const key = `box:${sport}:${eventId}`;
  if (force) boxscoreCache.set(key, {}, 0);
  return boxscoreCache.getOrFetch(
    key,
    () => fetchJsonWithTimeout(boxscoreUrl(sport, eventId)),
    ttlForBoxscore,
  );
}

export function boxscoreCacheStats() {
  return { size: boxscoreCache.size() };
}

// ----------------------------------------------------------------------------
// Per-team roster (headshots + jersey + position, available pregame)
//
// Box scores only populate athletes once the game starts, so pregame cards
// can't get headshots from /summary. The /teams/{id}/roster endpoint works
// any time and rosters change infrequently (trades, injuries), so we cache
// these for an hour — plenty fresh for jersey/position/headshot use.
// ----------------------------------------------------------------------------

const rosterCache = new TTLCache<any>();

function rosterUrl(sport: Sport, teamId: string): string {
  const segByLeague: Record<Sport, string> = {
    mlb: "baseball/mlb",
    nhl: "hockey/nhl",
    nba: "basketball/nba",
    wnba: "basketball/wnba",
    ufc: "mma/ufc",
    atp: "tennis/atp",
    wta: "tennis/wta",
    // Soccer (no player props; present only to keep the Record total).
    epl: "soccer/eng.1",
    laliga: "soccer/esp.1",
    seriea: "soccer/ita.1",
    bundesliga: "soccer/ger.1",
    ligue1: "soccer/fra.1",
    ucl: "soccer/uefa.champions",
    wcup: "soccer/fifa.world",
    intlfriendly: "soccer/fifa.friendly",
  };
  const seg = segByLeague[sport];
  return `https://site.api.espn.com/apis/site/v2/sports/${seg}/teams/${encodeURIComponent(teamId)}/roster`;
}

export async function getRoster(
  sport: Sport,
  teamId: string,
  force = false,
): Promise<any> {
  const key = `roster:${sport}:${teamId}`;
  if (force) rosterCache.set(key, {}, 0);
  return rosterCache.getOrFetch(
    key,
    () => fetchJsonWithTimeout(rosterUrl(sport, teamId)),
    3_600_000,   // 1 hour TTL
  );
}

export function rosterCacheStats() {
  return { size: rosterCache.size() };
}

/**
 * ESPN date in America/New_York as YYYYMMDD — same helper as Monte-Site uses.
 */
export function currentETDate(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}${m}${d}`;
}
