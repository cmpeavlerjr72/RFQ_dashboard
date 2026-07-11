// UFC.com athlete full-body image lookup.
//
// The ufc.com athlete page exposes the "hero cutout" image (the front-page
// McGregor/Holloway style renders) under a styles/athlete_bio_full_body URL.
// The CDN path is hashed per upload, so we fetch the page once per fighter and
// regex it out; results are cached long (images change ~never mid-camp) with a
// shorter negative cache so temporary misses retry.
//
// GET /api/ufc/athlete-image?name=Conor%20McGregor -> { name, url|null }

const cache = new Map<string, { url: string | null; ts: number }>();
const TTL_HIT = 24 * 3600e3;
const TTL_MISS = 3600e3;

function slugify(name: string): string {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // strip diacritics
    .replace(/['".]/g, "")
    .replace(/[^a-z ]/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

export async function getUfcAthleteImage(name: string): Promise<string | null> {
  const slug = slugify(name);
  if (!slug) return null;
  const c = cache.get(slug);
  if (c && Date.now() - c.ts < (c.url ? TTL_HIT : TTL_MISS)) return c.url;
  let url: string | null = null;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const resp = await fetch(`https://www.ufc.com/athlete/${slug}`, {
      signal: ac.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36",
        "Accept": "text/html",
      },
    });
    clearTimeout(t);
    if (resp.ok) {
      const html = await resp.text();
      const m = html.match(/https:\/\/[^"'\s]+athlete_bio_full_body[^"'\s]+?\.(?:png|jpe?g)[^"'\s]*/);
      url = m ? m[0].replace(/&amp;/g, "&") : null;
      if (!url) {
        const og = html.match(/property="og:image" content="([^"]+)"/);
        url = og ? og[1].replace(/&amp;/g, "&") : null;
      }
    }
  } catch { /* fall through to negative cache */ }
  cache.set(slug, { url, ts: Date.now() });
  return url;
}
