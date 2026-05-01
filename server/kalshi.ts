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

let _client: KalshiClient | null = null;

function loadClient(): KalshiClient {
  if (_client) return _client;
  const env = (process.env.KALSHI_ENV || "PROD").toUpperCase();
  const baseUrl = HOSTS[env] || HOSTS.PROD;

  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  if (!apiKeyId) throw new Error("KALSHI_API_KEY_ID not set");

  // Two ways to supply the private key:
  //   1. KALSHI_PRIVATE_KEY      — full PEM contents in an env var (Render-friendly,
  //                                 escape \n as actual newlines)
  //   2. KALSHI_PRIVATE_KEY_PATH — file path (works locally and with Render Secret Files)
  let pem: Buffer | string | undefined;
  const inlineKey = process.env.KALSHI_PRIVATE_KEY;
  if (inlineKey && inlineKey.includes("BEGIN")) {
    pem = inlineKey.replace(/\\n/g, "\n");
  } else {
    const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
    if (!keyPath) throw new Error("KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH must be set");
    const resolved = path.resolve(process.cwd(), keyPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Kalshi private key not found at ${resolved}`);
    }
    pem = fs.readFileSync(resolved);
  }
  const privateKey = crypto.createPrivateKey({ key: pem, format: "pem" });

  _client = { apiKeyId, privateKey, baseUrl };
  return _client;
}

function signedHeaders(method: string, fullPath: string): Record<string, string> {
  const c = loadClient();
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

async function getJson(apiPath: string, retryOn429 = 3): Promise<any> {
  const c = loadClient();
  const fullPath = API_PREFIX + apiPath;
  for (let attempt = 0; attempt <= retryOn429; attempt++) {
    const headers = signedHeaders("GET", fullPath);  // re-sign each attempt (timestamp must be fresh)
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

function rfqDiskPath(rfqId: string): string {
  return path.join(RFQ_DISK_DIR, `${rfqId}.json`);
}

// ----------------------------------------------------------------------------
// Public API consumed by index.ts
// ----------------------------------------------------------------------------

export async function getBalance(force = false): Promise<any> {
  return positionsCache.getOrFetch(
    "balance",
    () => getJson("/portfolio/balance"),
    30_000,
  );
}

export async function getPositions(force = false): Promise<any> {
  if (force) positionsCache.set("positions", undefined as any, 0);
  return positionsCache.getOrFetch(
    "positions",
    () => getJson("/portfolio/positions?limit=200"),
    30_000,
  );
}

export async function getMarket(ticker: string, force = false): Promise<any> {
  if (force) marketCache.set(ticker, undefined as any, 0);
  return marketCache.getOrFetch(
    ticker,
    () => getJson(`/markets/${encodeURIComponent(ticker)}`),
    60_000, // 1 minute; could go adaptive later
  );
}

export async function getMarketsBatch(tickers: string[]): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  // Cap concurrency to be polite to Kalshi
  const CONCURRENCY = 5;
  let i = 0;
  async function worker() {
    while (i < tickers.length) {
      const idx = i++;
      const t = tickers[idx];
      try {
        out[t] = await getMarket(t);
      } catch (e: any) {
        out[t] = { error: String(e?.message || e) };
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, worker);
  await Promise.all(workers);
  return out;
}

export async function getRfqLegs(rfqId: string): Promise<any> {
  // 1. Check in-memory cache
  const cached = rfqMemCache.get(rfqId);
  if (cached) return cached;

  // 2. Check disk cache (only if the cache dir exists)
  const dp = rfqDiskPath(rfqId);
  if (RFQ_DISK_OK && fs.existsSync(dp)) {
    try {
      const v = JSON.parse(fs.readFileSync(dp, "utf-8"));
      rfqMemCache.set(rfqId, v, 86_400_000);
      return v;
    } catch {
      // fall through to refetch
    }
  }

  // 3. Fetch and persist
  const v = await getJson(`/communications/rfqs/${encodeURIComponent(rfqId)}`);
  if (RFQ_DISK_OK) {
    try {
      const tmp = dp + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(v));
      fs.renameSync(tmp, dp);
    } catch (e) {
      console.warn("rfq disk cache write failed:", e);
    }
  }
  rfqMemCache.set(rfqId, v, 86_400_000);
  return v;
}

// ----------------------------------------------------------------------------
// Parlay recovery: when no local fills.jsonl is available (e.g. when running
// the dashboard on a deployed host without the runner's data dir), walk
// fills → order → quote → rfq for an open parlay ticker to recover legs +
// rfq_id + accepted_side. Mirrors sandbox/recover_open_positions.py.
// ----------------------------------------------------------------------------

const RECOVERY_DISK_DIR = path.join(CACHE_ROOT, "parlay_recovery");
const RECOVERY_DISK_OK = ensureDir(RECOVERY_DISK_DIR);
const recoveryMemCache = new TTLCache<any>();

function recoveryDiskPath(parlayTicker: string): string {
  // Filenames must be safe — replace any chars that aren't alnum/-_
  const safe = parlayTicker.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(RECOVERY_DISK_DIR, `${safe}.json`);
}

export interface ParlayRecovery {
  parlay_ticker: string;
  rfq_id: string | null;
  quote_id: string | null;
  accepted_side: string | null;
  legs: { ticker: string; side: string; p: number | null }[];
}

export async function recoverParlay(parlayTicker: string): Promise<ParlayRecovery> {
  // 1. mem cache
  const memHit = recoveryMemCache.get(parlayTicker);
  if (memHit) return memHit;

  // 2. disk cache (only if writable)
  const dp = recoveryDiskPath(parlayTicker);
  if (RECOVERY_DISK_OK && fs.existsSync(dp)) {
    try {
      const v = JSON.parse(fs.readFileSync(dp, "utf-8")) as ParlayRecovery;
      recoveryMemCache.set(parlayTicker, v, 86_400_000);
      return v;
    } catch {}
  }

  // 3. Walk the chain on Kalshi.
  const empty: ParlayRecovery = {
    parlay_ticker: parlayTicker,
    rfq_id: null, quote_id: null, accepted_side: null, legs: [],
  };
  let result: ParlayRecovery = empty;
  try {
    const fills = await getJson(
      `/portfolio/fills?ticker=${encodeURIComponent(parlayTicker)}&limit=20`,
    );
    const fillsList: any[] = fills?.fills || [];
    if (fillsList.length === 0) return empty;
    const sorted = [...fillsList].sort((a, b) =>
      String(a.created_time || "").localeCompare(String(b.created_time || "")),
    );
    const first = sorted[0];
    const orderId = first?.order_id;
    if (!orderId) return empty;

    const order = (await getJson(`/portfolio/orders/${encodeURIComponent(orderId)}`))?.order;
    const clientOrderId: string = order?.client_order_id || "";
    if (!clientOrderId.startsWith("quote:")) return empty;
    const parts = clientOrderId.split(":");
    if (parts.length < 3) return empty;
    const quoteId = parts[2];

    const quote = (await getJson(`/communications/quotes/${encodeURIComponent(quoteId)}`))?.quote;
    const rfqId: string | undefined = quote?.rfq_id;
    if (!rfqId) return empty;

    const rfqResp = await getRfqLegs(rfqId);
    const rfq = rfqResp?.rfq || rfqResp;
    const legsRaw: any[] = rfq?.mve_selected_legs || [];
    const legs = legsRaw
      .map((l) => ({
        ticker: l?.market_ticker || "",
        side: (l?.side || "yes").toLowerCase(),
        p: null as number | null,
      }))
      .filter((l) => l.ticker);

    result = {
      parlay_ticker: parlayTicker,
      rfq_id: rfqId,
      quote_id: quoteId,
      accepted_side: (quote?.accepted_side || first?.side || "").toLowerCase() || null,
      legs,
    };
  } catch (e) {
    console.warn(`recoverParlay(${parlayTicker}) failed:`, (e as any)?.message || e);
    // Return empty (cached briefly so we don't hammer on every refresh)
    recoveryMemCache.set(parlayTicker, empty, 60_000);
    return empty;
  }

  // Persist successful recovery to disk (if writable)
  if (result.rfq_id) {
    if (RECOVERY_DISK_OK) {
      try {
        const tmp = dp + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(result));
        fs.renameSync(tmp, dp);
      } catch (e) {
        console.warn("parlay recovery disk cache write failed:", e);
      }
    }
    recoveryMemCache.set(parlayTicker, result, 86_400_000);
  } else {
    recoveryMemCache.set(parlayTicker, result, 60_000);
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
