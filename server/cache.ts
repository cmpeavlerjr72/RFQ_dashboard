// Tiny TTL cache with adaptive TTL support. Mirrors the pattern from
// Monte-Site liveScores.ts but generic over key/value/TTL.
//
// Each entry caches: { value, fetchedAt }. The TTL is computed at READ time
// via ttlFor(value), so we can shorten the window for "live" payloads (e.g.,
// games in progress) and lengthen it for idle ones.

export interface CacheEntry<V> {
  value: V;
  fetchedAt: number;
  ttlMs: number;
}

export class TTLCache<V> {
  private store = new Map<string, CacheEntry<V>>();

  /**
   * Get a cached value if still fresh. Returns undefined if missing or expired.
   */
  get(key: string): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() - e.fetchedAt > e.ttlMs) return undefined;
    return e.value;
  }

  /**
   * Store a value with the given TTL.
   */
  set(key: string, value: V, ttlMs: number): void {
    this.store.set(key, { value, fetchedAt: Date.now(), ttlMs });
  }

  /**
   * Get-or-fetch. Pass a `ttlMs(value)` function to set adaptive TTL.
   * Concurrent calls collapse onto a single in-flight fetch via the loaders map.
   */
  private loaders = new Map<string, Promise<V>>();
  async getOrFetch(
    key: string,
    fetcher: () => Promise<V>,
    ttlMs: ((v: V) => number) | number,
  ): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const inflight = this.loaders.get(key);
    if (inflight) return inflight;

    const p = (async () => {
      try {
        const v = await fetcher();
        const ttl = typeof ttlMs === "function" ? ttlMs(v) : ttlMs;
        this.set(key, v, ttl);
        return v;
      } finally {
        this.loaders.delete(key);
      }
    })();
    this.loaders.set(key, p);
    return p;
  }

  ageMs(key: string): number | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    return Date.now() - e.fetchedAt;
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Promise wrapper with a fetch timeout that rejects on AbortSignal.
 * Mirrors fetchJsonWithTimeout in Monte-Site liveScores.ts.
 */
export async function fetchJsonWithTimeout(
  url: string,
  ms = 10_000,
  init?: { headers?: Record<string, string> },
): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "cache-control": "no-cache",
        "user-agent": "Mozilla/5.0",
        ...(init?.headers ?? {}),
      },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}
