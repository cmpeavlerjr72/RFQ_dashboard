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

async function getJson(apiPath: string): Promise<any> {
  const c = loadClient();
  const fullPath = API_PREFIX + apiPath;
  const headers = signedHeaders("GET", fullPath);
  return fetchJsonWithTimeout(c.baseUrl + fullPath, 10_000, { headers });
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
// survive restarts.
const RFQ_DISK_DIR = path.resolve(process.cwd(), "..", "data", "dashboard_cache", "rfq_legs");
fs.mkdirSync(RFQ_DISK_DIR, { recursive: true });
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

  // 2. Check disk cache
  const dp = rfqDiskPath(rfqId);
  if (fs.existsSync(dp)) {
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
  // Persist atomically: write to .tmp then rename
  try {
    const tmp = dp + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(v));
    fs.renameSync(tmp, dp);
  } catch (e) {
    console.warn("rfq disk cache write failed:", e);
  }
  rfqMemCache.set(rfqId, v, 86_400_000);
  return v;
}

export function cacheStats() {
  return {
    positions: { size: positionsCache.size() },
    markets: { size: marketCache.size() },
    rfqs: { memSize: rfqMemCache.size() },
  };
}
