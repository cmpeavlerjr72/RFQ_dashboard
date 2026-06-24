// Signed Kalshi proxy. The browser hits us; we sign and forward to Kalshi
// with adaptive caching so even an open dashboard makes ~120 calls/hour total
// regardless of viewer count.
//
// Auth scheme matches src/quote_client.py exactly:
//   timestamp = ms epoch
//   signature = base64(RSA-PSS-SHA256(privateKey, ts + method + sign_path))
//   sign_path = path without query string

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DASH_ACCOUNTS, envVarsFor, defaultDashboardLabel } from "./accounts.js";

import { TTLCache, fetchJsonWithTimeout } from "./cache.js";

const API_PREFIX = "/trade-api/v2";

const HOSTS: Record<string, string> = {
  PROD: "https://api.elections.kalshi.com",
  DEMO: "https://demo-api.kalshi.co",
};

interface KalshiClient {
  apiKeyId: string;
  privateKey: crypto.KeyObject;
  baseUrl: string;
}

// ----------------------------------------------------------------------------
// Multi-account registry
// ----------------------------------------------------------------------------
// Each account maps a UI label to the env-var names that hold its credentials.
// MVPeav keeps the original unsuffixed names so existing single-account
// deployments behave identically with zero config changes. GPeavT uses the
// `_SECOND` suffix, matching the runner's .env convention.
//
// Two ways to supply each private key (checked per account):
//   1. <inline> env var  — full PEM contents (Render-friendly, escape \n as newlines)
//   2. <keyPath> env var — file path (works locally and with Render Secret Files)

interface AccountConfig {
  keyId: string;     // env var holding the API key id
  inline: string;    // env var holding the inline PEM (optional)
  keyPath: string;   // env var holding the PEM file path (optional)
  // True only for an account the OWNER also trades manually (taker fills). When
  // set, getPositions() drops taker-acquired tickers so the view shows only our
  // maker book. MP/ROTH are pure-maker (false); GPeavT is the brother's account.
  ownerTakes?: boolean;
}

// Built from the shared account fact sheet (accounts.json). Each account's
// env-var names are derived from its suffix (matching the runner's .env), so
// adding an account is a JSON edit — no code change here.
const ACCOUNTS: Record<string, AccountConfig> = Object.fromEntries(
  DASH_ACCOUNTS.map((a) => {
    const ev = envVarsFor(a);
    return [a.dashboardLabel, {
      keyId: ev.keyId, inline: ev.inline, keyPath: ev.keyPath,
      ownerTakes: a.ownerTakes,
    }];
  }),
);

export const DEFAULT_ACCOUNT = defaultDashboardLabel();

export function isValidAccount(a: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACCOUNTS, a);
}

export function listAccounts(): string[] {
  return Object.keys(ACCOUNTS);
}

/** True if the OWNER also trades this account manually (taker fills that must be
 *  excluded from our maker book). Only GPeavT; MP/ROTH are pure-maker. */
export function accountOwnerTakes(account: string): boolean {
  return !!ACCOUNTS[resolveAccount(account)]?.ownerTakes;
}

/** Normalise an arbitrary account input to a known account, defaulting safely. */
export function resolveAccount(a: string | undefined | null): string {
  const v = (a || "").trim();
  return isValidAccount(v) ? v : DEFAULT_ACCOUNT;
}

const _clients = new Map<string, KalshiClient>();

function loadClient(account: string = DEFAULT_ACCOUNT): KalshiClient {
  const acct = resolveAccount(account);
  const cached = _clients.get(acct);
  if (cached) return cached;

  const cfg = ACCOUNTS[acct];
  const env = (process.env.KALSHI_ENV || "PROD").toUpperCase();
  const baseUrl = HOSTS[env] || HOSTS.PROD;

  const apiKeyId = process.env[cfg.keyId];
  if (!apiKeyId) throw new Error(`${cfg.keyId} not set (account ${acct})`);

  let pem: Buffer | string | undefined;
  const inlineKey = process.env[cfg.inline];
  if (inlineKey && inlineKey.includes("BEGIN")) {
    pem = inlineKey.replace(/\\n/g, "\n");
  } else {
    const keyPath = process.env[cfg.keyPath];
    if (!keyPath) {
      throw new Error(`${cfg.inline} or ${cfg.keyPath} must be set (account ${acct})`);
    }
    const resolved = path.resolve(process.cwd(), keyPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Kalshi private key not found at ${resolved} (account ${acct})`);
    }
    pem = fs.readFileSync(resolved);
  }
  const privateKey = crypto.createPrivateKey({ key: pem, format: "pem" });

  const client: KalshiClient = { apiKeyId, privateKey, baseUrl };
  _clients.set(acct, client);
  return client;
}

function signedHeaders(account: string, method: string, fullPath: string): Record<string, string> {
  const c = loadClient(account);
  const ts = String(Date.now());
  // Strip query string before signing — matches Python signer
  const signPath = fullPath.split("?", 1)[0];
  const message = ts + method.toUpperCase() + signPath;
  const sig = crypto.sign("sha256", Buffer.from(message), {
    key: c.privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return {
    "KALSHI-ACCESS-KEY": c.apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": sig.toString("base64"),
    "KALSHI-ACCESS-TIMESTAMP": ts,
    accept: "application/json",
  };
}

export async function getJson(account: string, apiPath: string, retryOn429 = 3): Promise<any> {
  const c = loadClient(account);
  const fullPath = API_PREFIX + apiPath;
  for (let attempt = 0; attempt <= retryOn429; attempt++) {
    const headers = signedHeaders(account, "GET", fullPath);  // re-sign each attempt (timestamp must be fresh)
    try {
      return await fetchJsonWithTimeout(c.baseUrl + fullPath, 10_000, { headers });
    } catch (e: any) {
      const msg = String(e?.message || e);
      const is429 = msg.includes("429") || /too[_ ]many[_ ]requests/i.test(msg);
      if (!is429 || attempt === retryOn429) throw e;
      // Exponential backoff with jitter: 250ms, 750ms, 1750ms…
      const wait = 250 * Math.pow(3, attempt) + Math.random() * 200;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  // Unreachable, satisfies the type checker
  throw new Error("getJson: exhausted retries");
}

// ----------------------------------------------------------------------------
// Caches with adaptive TTLs
// ----------------------------------------------------------------------------

// Positions snapshot — 30s. Refreshed on every dashboard tick.
const positionsCache = new TTLCache<any>();

// Per-parlay market price — adaptive. Live games (we currently don't probe
// status here) get a 30s TTL; others 5min. The dashboard can pass ?fresh=1
// to force a refetch for one cycle.
const marketCache = new TTLCache<any>();

// RFQ legs — permanent (never change once posted). Disk-backed so they
// survive restarts. CACHE_DIR can be overridden by env (CACHE_DIR or
// RENDER_DISK_PATH); defaults to a path INSIDE the project so we don't depend
// on the parent dir being writable on hosted runtimes.
function resolveCacheRoot(): string {
  const fromEnv = process.env.CACHE_DIR || process.env.RENDER_DISK_PATH;
  if (fromEnv) return path.resolve(fromEnv);
  // Local-dev convention: write to ../data/dashboard_cache when that dir
  // already exists; otherwise fall back to a project-local cache/ dir.
  const sibling = path.resolve(process.cwd(), "..", "data", "dashboard_cache");
  if (fs.existsSync(path.dirname(sibling))) return sibling;
  return path.resolve(process.cwd(), "cache");
}
const CACHE_ROOT = resolveCacheRoot();

function ensureDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (e) {
    console.warn(`cache dir ${dir} not writable: ${(e as any)?.message || e}`);
    return false;
  }
}

const RFQ_DISK_DIR = path.join(CACHE_ROOT, "rfq_legs");
const RFQ_DISK_OK = ensureDir(RFQ_DISK_DIR);
const rfqMemCache = new TTLCache<any>();

// Soccer milestones from Kalshi's OWN feed — the authoritative source
// build_start_times.py uses as primary (covers obscure international friendlies
// ESPN omits). Each carries the ML event ticker (KXWCGAME-…, KXINTLFRIENDLYGAME-…),
// the milestone id (for /live_data score lookups), and the kickoff. 10-min TTL.
interface SoccerMilestone { ticker: string; id: string; start: string; }
const soccerMilestoneCache = new TTLCache<SoccerMilestone[]>();
// Combined kickoff + live-score map for the dashboard (25s TTL). Scores come
// from /live_data/milestone/{id}, fetched only for games near "now" so the call
// count stays bounded regardless of how many milestones the feed has. Works on
// the Render deploy (pulled from Kalshi, not the local start_times file).
const soccerDataCache = new TTLCache<{ starts: Record<string, string>; scores: Record<string, any> }>();

function rfqDiskPath(account: string, rfqId: string): string {
  return path.join(RFQ_DISK_DIR, `${account}__${rfqId}.json`);
}

// ----------------------------------------------------------------------------
// Public API consumed by index.ts
// ----------------------------------------------------------------------------

export async function getBalance(account: string, force = false): Promise<any> {
  const key = `${account}:balance`;
  if (force) positionsCache.set(key, undefined as any, 0);
  return positionsCache.getOrFetch(
    key,
    () => getJson(account, "/portfolio/balance"),
    30_000,
  );
}

/**
 * Soccer milestones from Kalshi's feed: {ticker (ML event ticker), id, start}.
 * Mirrors sandbox/build_start_times.py kalshi_soccer_milestone_starts: paginate
 * /milestones?type=soccer_tournament_multi_leg, read details.main_game_event_ticker
 * + id + start_date. No team-name matching; covers matches ESPN doesn't.
 */
async function getSoccerMilestones(account: string): Promise<SoccerMilestone[]> {
  return soccerMilestoneCache.getOrFetch(
    `${account}:soccer-milestones`,
    async () => {
      const min = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) + "T00:00:00Z";
      const out: SoccerMilestone[] = [];
      let cursor = "";
      for (let i = 0; i < 20; i++) {
        const p = `/milestones?limit=200&type=soccer_tournament_multi_leg`
          + `&minimum_start_date=${encodeURIComponent(min)}`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        let d: any;
        try { d = await getJson(account, p); } catch { break; }
        for (const m of (d?.milestones || [])) {
          const sd = m?.start_date;
          const id = m?.id;
          if (!sd || !id) continue;
          const det = m?.details || {};
          let mt: string | undefined = det.main_game_event_ticker;
          if (!(mt && mt.includes("GAME-"))) {
            mt = (m?.primary_event_tickers || []).find((t: string) => t.includes("GAME-")) || mt;
          }
          if (mt) out.push({ ticker: mt, id, start: sd });
        }
        cursor = d?.cursor || "";
        if (!cursor) break;
      }
      return out;
    },
    600_000, // 10 min
  );
}

/**
 * Kickoff times + live/final scores for soccer, keyed by ML event ticker.
 *   { starts: {ticker: ISO kickoff}, scores: {ticker: {home, away, statusText, half, winner, matchStatus}} }
 * Scores come from /live_data/milestone/{id} — Kalshi's own score feed, which
 * covers EVERY game it makes markets on (including friendlies ESPN omits). To
 * keep the call count bounded we only pull /live_data for games near "now"
 * (started within the last 12h, up to 30min out) — finished-long-ago and
 * far-future games don't need live polling. 25s TTL.
 */
export async function getSoccerStartData(
  account: string,
): Promise<{ starts: Record<string, string>; scores: Record<string, any> }> {
  return soccerDataCache.getOrFetch(
    `${account}:soccer-data`,
    async () => {
      const ms = await getSoccerMilestones(account);
      const starts: Record<string, string> = {};
      const scores: Record<string, any> = {};
      const now = Date.now();
      for (const m of ms) starts[m.ticker] = m.start;
      const near = ms.filter((m) => {
        const t = Date.parse(m.start);
        return t && t >= now - 12 * 3600_000 && t <= now + 30 * 60_000;
      });
      await Promise.all(near.map(async (m) => {
        try {
          const ld = await getJson(account, `/live_data/milestone/${m.id}`);
          const d = ld?.live_data?.details;
          if (d && d.match_status && d.match_status !== "scheduled") {
            scores[m.ticker] = {
              home: d.home_same_game_score,
              away: d.away_same_game_score,
              statusText: d.status_text,
              half: d.half,
              winner: d.winner,
              matchStatus: d.match_status,
            };
          }
        } catch { /* a single game's live_data failing must not drop the rest */ }
      }));
      return { starts, scores };
    },
    25_000,
  );
}

/**
 * Tickers on `account` whose CURRENT holding was acquired purely as a TAKER —
 * i.e. the position has taker fills and no maker fills. On the secondary (TP)
 * account that is the owner's own betting (he takes; our runner only ever makes
 * via RFQ quotes), so these positions must be excluded from the live exposure
 * view. Parlay market tickers are minted per RFQ accept, so a given ticker is
 * effectively all-ours (maker) or all-his (taker) — the maker-fill guard just
 * protects the rare case where he also took one of our own parlay markets.
 */
async function takerOnlyTickers(account: string, maxPages = 12): Promise<Set<string>> {
  const makerTk = new Set<string>();
  const takerTk = new Set<string>();
  let cursor = "";
  for (let i = 0; i < maxPages; i++) {
    const q = "/portfolio/fills?limit=200" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const body = await getJson(account, q);
    const page: any[] = body?.fills || [];
    for (const f of page) {
      const tk = f?.market_ticker || f?.ticker || "";
      if (!tk) continue;
      if (f?.is_taker) takerTk.add(tk); else makerTk.add(tk);
    }
    cursor = body?.cursor || "";
    if (!page.length || !cursor) break;
  }
  const out = new Set<string>();
  for (const tk of takerTk) if (!makerTk.has(tk)) out.add(tk);
  return out;
}

export async function getPositions(account: string, force = false): Promise<any> {
  const key = `${account}:positions`;
  if (force) positionsCache.set(key, undefined as any, 0);
  return positionsCache.getOrFetch(
    key,
    async () => {
      const raw = await getJson(account, "/portfolio/positions?limit=200");
      // EXCLUDE non-KXMVE positions: our runner ONLY ever holds the multi-game
      // parlay products (KXMVE…). Anything else on the account is the OWNER's
      // personal betting — e.g. a direct KXATPMATCH tennis taker (~$150) or a
      // manually-held KXGAPRIMARY — which must NOT contaminate our positions /
      // exposure / sport breakdowns. Mirrors the runner's hydration filter
      // (run_netting_maker.py: positions startswith "KXMVE"). 2026-06-03.
      const keep = (p: any) => (p?.ticker || "").startsWith("KXMVE");
      if (raw && typeof raw === "object") {
        if (Array.isArray(raw.market_positions))
          raw.market_positions = raw.market_positions.filter(keep);
        if (Array.isArray(raw.event_positions))
          raw.event_positions = raw.event_positions.filter(
            (e: any) => (e?.event_ticker || "").startsWith("KXMVE"),
          );
      }
      // On the secondary (TP) account, the owner also makes his OWN bets — which
      // fill as TAKER orders, sometimes even on KXMVE parlay markets (so the
      // KXMVE filter above doesn't catch them). Drop any position that was
      // acquired purely as a taker so the live view shows only our maker book.
      // MP (default) and ROTH are pure-maker accounts, left untouched. Only an
      // account flagged ownerTakes (GPeavT) carries the owner's manual taker
      // trades that must be stripped. 2026-06-03; ownerTakes flag 2026-06-14.
      if (ACCOUNTS[account]?.ownerTakes && raw && Array.isArray(raw.market_positions)) {
        try {
          const takerTk = await takerOnlyTickers(account);
          if (takerTk.size) {
            raw.market_positions = raw.market_positions.filter(
              (p: any) => !takerTk.has(p?.ticker || ""),
            );
          }
        } catch (e) {
          // Best-effort: if the fills lookup fails, fall back to the KXMVE-only
          // filter rather than breaking the positions view.
          console.warn("takerOnlyTickers failed for", account, e);
        }
      }
      return raw;
    },
    30_000,
  );
}

export async function getMarket(account: string, ticker: string, force = false): Promise<any> {
  // Market price is account-independent public data, but namespacing the key
  // keeps the cache uniform and avoids any cross-account surprise.
  const key = `${account}:${ticker}`;
  if (force) marketCache.set(key, undefined as any, 0);
  return marketCache.getOrFetch(
    key,
    () => getJson(account, `/markets/${encodeURIComponent(ticker)}`),
    60_000, // 1 minute; could go adaptive later
  );
}

export async function getMarketsBatch(account: string, tickers: string[]): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  // Cap concurrency to be polite to Kalshi
  const CONCURRENCY = 5;
  let i = 0;
  async function worker() {
    while (i < tickers.length) {
      const idx = i++;
      const t = tickers[idx];
      try {
        out[t] = await getMarket(account, t);
      } catch (e: any) {
        out[t] = { error: String(e?.message || e) };
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, worker);
  await Promise.all(workers);
  return out;
}

// All markets (strikes) under one event ticker, e.g. KXNHLTOTAL-26JUN04VGKCAR
// -> every total line for that game. Used by the dashboard to find the live
// "50/50" total (the market-implied projected finish). Cached 30s — these move
// during a game but we don't need sub-30s freshness for a projection marker.
const eventMarketsCache = new TTLCache<any>();
export async function getEventMarkets(account: string, eventTicker: string): Promise<any> {
  const key = `${account}:${eventTicker}`;
  return eventMarketsCache.getOrFetch(
    key,
    () => getJson(account, `/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=200`),
    30_000,
  );
}

export async function getRfqLegs(account: string, rfqId: string): Promise<any> {
  // RFQ legs are immutable + account-independent, but we namespace the cache
  // key/disk path by account anyway for uniformity.
  const cacheKey = `${account}:${rfqId}`;
  // 1. Check in-memory cache
  const cached = rfqMemCache.get(cacheKey);
  if (cached) return cached;

  // 2. Check disk cache (only if the cache dir exists)
  const dp = rfqDiskPath(account, rfqId);
  if (RFQ_DISK_OK && fs.existsSync(dp)) {
    try {
      const v = JSON.parse(fs.readFileSync(dp, "utf-8"));
      rfqMemCache.set(cacheKey, v, 86_400_000);
      return v;
    } catch {
      // fall through to refetch
    }
  }

  // 3. Fetch and persist
  const v = await getJson(account, `/communications/rfqs/${encodeURIComponent(rfqId)}`);
  if (RFQ_DISK_OK) {
    try {
      const tmp = dp + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(v));
      fs.renameSync(tmp, dp);
    } catch (e) {
      console.warn("rfq disk cache write failed:", e);
    }
  }
  rfqMemCache.set(cacheKey, v, 86_400_000);
  return v;
}

// ----------------------------------------------------------------------------
// Parlay recovery: recover an open parlay's legs (+ rfq_id/accepted_side) so positions
// can be sorted into games even without the runner's local fills.jsonl. PRIMARY leg
// source = the market's own mve_selected_legs, which works for BOTH the sniper's RFQ
// fills AND the bait/rester resting fills (the resting fills aren't in fills.jsonl and
// aren't quote-placed, so the old fills→order→quote→rfq walk returned no legs for them
// — that walk is now best-effort enrichment). Mirrors sandbox/recover_open_positions.py.
// ----------------------------------------------------------------------------

const RECOVERY_DISK_DIR = path.join(CACHE_ROOT, "parlay_recovery");
const RECOVERY_DISK_OK = ensureDir(RECOVERY_DISK_DIR);
const recoveryMemCache = new TTLCache<any>();

function recoveryDiskPath(account: string, parlayTicker: string): string {
  // Filenames must be safe — replace any chars that aren't alnum/-_
  const safe = parlayTicker.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(RECOVERY_DISK_DIR, `${account}__${safe}.json`);
}

export interface ParlayRecovery {
  parlay_ticker: string;
  rfq_id: string | null;
  quote_id: string | null;
  accepted_side: string | null;
  legs: { ticker: string; side: string; p: number | null }[];
}

export async function recoverParlay(account: string, parlayTicker: string): Promise<ParlayRecovery> {
  const memKey = `${account}:${parlayTicker}`;
  // 1. mem cache
  const memHit = recoveryMemCache.get(memKey);
  if (memHit) return memHit;

  // 2. disk cache (only if writable)
  const dp = recoveryDiskPath(account, parlayTicker);
  if (RECOVERY_DISK_OK && fs.existsSync(dp)) {
    try {
      const v = JSON.parse(fs.readFileSync(dp, "utf-8")) as ParlayRecovery;
      recoveryMemCache.set(memKey, v, 86_400_000);
      return v;
    } catch {}
  }

  // 3. Recover legs from the parlay MARKET's own structure (/markets/<ticker> ->
  //    mve_selected_legs). Works for ANY open position — the sniper's RFQ-quote fills AND
  //    the bait/rester resting fills — because the MVE market carries its own legs. (The old
  //    fills -> order -> quote -> rfq walk only yielded legs for quote-placed orders, so
  //    resting-fill positions never got sorted into games.) ONE cached call; we no longer
  //    recover rfq_id/accepted_side — the frontend keys grouping + valuation off legs only,
  //    so dropping the extra walk keeps recovery fast (no 429s under many open positions).
  const empty: ParlayRecovery = {
    parlay_ticker: parlayTicker,
    rfq_id: null, quote_id: null, accepted_side: null, legs: [],
  };
  let result: ParlayRecovery = empty;
  try {
    const mkt = (await getJson(account, `/markets/${encodeURIComponent(parlayTicker)}`))?.market;
    const legs = (mkt?.mve_selected_legs || [])
      .map((l: any) => ({ ticker: l?.market_ticker || "", side: (l?.side || "yes").toLowerCase(), p: null as number | null }))
      .filter((l: { ticker: string }) => l.ticker);
    result = { parlay_ticker: parlayTicker, rfq_id: null, quote_id: null, accepted_side: null, legs };
  } catch (e) {
    console.warn(`recoverParlay(${account}/${parlayTicker}) failed:`, (e as any)?.message || e);
    recoveryMemCache.set(memKey, empty, 60_000);
    return empty;
  }

  // Persist if we recovered LEGS (was: only if rfq_id, which silently excluded resting positions).
  if (result.legs.length) {
    if (RECOVERY_DISK_OK) {
      try {
        const tmp = dp + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(result));
        fs.renameSync(tmp, dp);
      } catch (e) {
        console.warn("parlay recovery disk cache write failed:", e);
      }
    }
    recoveryMemCache.set(memKey, result, 86_400_000);
  } else {
    recoveryMemCache.set(memKey, result, 60_000);
  }
  return result;
}

export function cacheStats() {
  return {
    positions: { size: positionsCache.size() },
    markets: { size: marketCache.size() },
    rfqs: { memSize: rfqMemCache.size() },
    recovery: { memSize: recoveryMemCache.size() },
  };
}
