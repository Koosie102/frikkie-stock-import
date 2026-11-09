// Fetches Nanjing Jiuguang's own website (jg-ledlight.com) product pages
// to enrich already-staged WOEST Kudu/Veldt products with a real photo and
// a richer description — a second source feeding the SAME catalog-match
// pipeline nanjingCatalog.server.js already built for the uploaded 98-page
// catalog PDF (reuses its baseFamily/matchCatalogEntry logic rather than
// duplicating it), since both use the same "JG-XXXX" model-code scheme —
// confirmed directly on the live site (e.g. the JG-D065 product page shows
// "Model: JG-D065", the exact code the catalog PDF uses for the same
// product).
//
// Confirmed directly (browser-driven, not guessed) before building this:
// - Every product page carries a standard schema.org Product JSON-LD block
//   (<script type="application/ld+json">, a `Product` entry either at the
//   top level or inside an `@graph` array) with `name`, `description` (the
//   full spec table as plain "Label: Value" text, one per line — the same
//   shape the catalog PDF parser already produces as descriptionLines) and
//   `image` (a real, publicly hosted photo URL). This is far more stable
//   to parse across ~390 pages than guessing CSS classes, and it's meant
//   for scrapers in the first place.
// - The description's first field is labelled either "Model:" or "Model
//   Number:" depending on the product (confirmed both spellings on real
//   pages) — handled as one pattern below.
// - This JSON-LD is present in the plain server-rendered HTML with no
//   JavaScript needed (confirmed: an unauthenticated fetch with ordinary
//   browser headers already returns it) — unlike MagicStar's Alibaba
//   storefront, no Bright Data / render step is needed here.
// - The full list of product pages is in /sitemap.xml (confirmed: 392
//   "...-pd<id>.html" URLs, cleanly distinct from the site's news/article
//   pages which use a different "...-id<id>.html" pattern) — far more
//   reliable than scraping the ~20-page paginated product listing by hand.
// - Not every product has a clean "JG-..." style code — a few show a
//   marketing-only model name instead (e.g. "Helix5-FD"). Those just won't
//   match any staged row's SKU, the same quiet miss the catalog PDF's own
//   matcher already accepts for codes it can't place.
import {
  groupByBaseFamily,
  matchCatalogEntry,
  catalogEntryToDescriptionHtml,
} from "./nanjingCatalog.server";

const SITE_BASE = "https://www.jg-ledlight.com";
const REQUEST_DELAY_MS = 400; // courtesy pacing -- this is a small company's own site, not a CDN-backed storefront built for crawling
const MAX_PRODUCTS = 600; // sanity guard -- real catalog is ~392 product pages

const BROWSER_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchProductUrls() {
  const res = await fetch(`${SITE_BASE}/sitemap.xml`, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Couldn't fetch sitemap.xml (HTTP ${res.status}).`);
  const xml = await res.text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  return urls.filter((u) => /-pd\d+\.html$/i.test(u)).slice(0, MAX_PRODUCTS);
}

function extractJsonLdProduct(html) {
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html))) {
    let obj;
    try {
      obj = JSON.parse(m[1]);
    } catch {
      continue; // malformed/unrelated JSON-LD block -- keep scanning
    }
    const graph = Array.isArray(obj["@graph"]) ? obj["@graph"] : [obj];
    const product = graph.find((g) => g && g["@type"] === "Product");
    if (product) return product;
  }
  return null;
}

// Pulls the "Model:"/"Model Number:" line's value out of the JSON-LD
// description text (both spellings confirmed on real pages) and returns
// the remaining lines as descriptionLines — the same
// { code, descriptionLines } shape nanjingCatalog.server.js's PDF parser
// produces, so the rest of that module's matching logic Just Works here.
function parseDescriptionText(text) {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let code = null;
  const descriptionLines = [];
  for (const line of lines) {
    const m = !code && line.match(/^model(?:\s*number)?\s*:\s*(.+)$/i);
    if (m) {
      code = m[1].trim();
      continue;
    }
    descriptionLines.push(line);
  }
  return { code, descriptionLines };
}

// Builds a specLine compatible with nanjingCatalog.server.js's
// parseSizeInches (which looks for a `<number>"` token) from the page
// title — this site writes sizes as "7 inch"/"5inch" rather than the
// catalog PDF's `7"` convention, so that's normalized here instead of
// touching the shared matching code both sources rely on.
function specLineFromTitle(title) {
  return (title || "").replace(/(\d+(?:\.\d+)?)\s*inch(?:es)?\b/gi, '$1"');
}

// Parses one product page into
// { code, title, specLine, descriptionLines, images, url }, or throws if
// the page has no usable Product JSON-LD / model code.
export async function parseWebsiteProduct(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const product = extractJsonLdProduct(html);
  if (!product) throw new Error("No product data (JSON-LD) found on this page.");

  const { code, descriptionLines } = parseDescriptionText(product.description);
  if (!code) throw new Error("No Model/Model Number line in this page's description.");

  return {
    code,
    title: product.name || "",
    specLine: specLineFromTitle(product.name),
    descriptionLines,
    images: Array.isArray(product.image) ? product.image.filter(Boolean) : [],
    url,
  };
}

// Full crawl: list every product page, then fetch+parse each one. A
// per-page failure (no JSON-LD, no model code, a transient HTTP error)
// doesn't abort the whole run — it's recorded with an `error` field so the
// final report is honest about what was actually read, same resilience
// pattern magicstarCatalog.server.js uses for Alibaba.
export async function fetchNanjingWebsiteCatalog(onProgress) {
  const urls = await fetchProductUrls();
  const entries = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    let entry;
    try {
      entry = await parseWebsiteProduct(url);
    } catch (err) {
      entry = { code: null, title: url, specLine: "", descriptionLines: [], images: [], url, error: String(err.message || err) };
    }
    entries.push(entry);
    onProgress?.({ index: i + 1, total: urls.length, title: entry.title || url, code: entry.code, error: entry.error });
    await sleep(REQUEST_DELAY_MS);
  }
  return entries;
}

// Re-exported so the route only needs one import line for the whole
// fetch-and-match flow, same as nanjingCatalog.server.js's own exports.
export { groupByBaseFamily, matchCatalogEntry, catalogEntryToDescriptionHtml };
