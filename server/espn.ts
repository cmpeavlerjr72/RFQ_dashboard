// ESPN scoreboard proxy with adaptive TTL caching.
// Modeled directly on Monte-Site server/liveScores.ts patterns.
//
// One ESPN call per (sport, date) per cache window — even with 100 viewers,
// ESPN gets hit at most ~3 times/min when games are live, ~0.5 times/min idle.

import { TTLCache, fetchJsonWithTimeout } from "./cache.js";

export type Sport = "mlb" | "nhl" | "nba" | "ufc" | "atp" | "wta";

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
    case "ufc":
      return `https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=${d}&limit=300`;
    case "atp":
      return `https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard?dates=${d}&limit=300`;
    case "wta":
      return `https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard?dates=${d}&limit=300`;
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
    () => fetchJsonWithTimeout(espnUrl(sport, dateYYYYMMDD)),
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
    ufc: "mma/ufc",
    atp: "tennis/atp",
    wta: "tennis/wta",
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
