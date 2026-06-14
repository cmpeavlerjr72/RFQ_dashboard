// Live FotMob match-momentum, mirrored by the home box to a PUBLIC HF dataset
// (sandbox/fotmob_momentum_feed.py, polled every 60s). We read it tokenless and
// cache briefly — momentum is per-minute, so a ~25s cache is plenty. A missing
// file / fetch error just yields {games:{}}, so the card simply omits the chart.
import { gunzipSync } from "node:zlib";

const HF_MOMENTUM_URL =
  "https://huggingface.co/datasets/mvpeav/kalshi-rfq-momentum/resolve/main/fotmob_momentum.json.gz";
const TTL_MS = 25 * 1000;

let cache: { fetchedAt: number; data: any } | null = null;

export async function getMomentum(): Promise<any> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.data;
  try {
    const resp = await fetch(HF_MOMENTUM_URL, { redirect: "follow" });
    if (!resp.ok) return cache ? cache.data : { games: {} };
    const text = gunzipSync(Buffer.from(await resp.arrayBuffer())).toString("utf-8");
    const data = JSON.parse(text);
    cache = { fetchedAt: Date.now(), data };
    return data;
  } catch {
    return cache ? cache.data : { games: {} };
  }
}
