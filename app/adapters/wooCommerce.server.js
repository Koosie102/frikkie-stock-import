// Ultra Vision runs on WooCommerce, not Shopify or Magento — this uses
// WooCommerce's public Store API (wc/store/v1), which needs no
// authentication for read access to published products. Verified the
// exact response shapes (price-in-minor-units, the dedicated
// /products/{id}/variations sub-resource) against WooCommerce's own
// developer docs before writing this, rather than guessing.

const BASE_URL = "https://ultra-vision.com.au";
const PER_PAGE = 100;
const REQUEST_DELAY_MS = 300; // polite pacing — Ultra Vision's own site, no known anti-bot issue like STEDI's, but no reason to hammer it either

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  const data = await res.json();
  await sleep(REQUEST_DELAY_MS);
  return data;
}

// Generic, site-parameterized versions of the two fetchers above — added
// for OZZ (also WooCommerce), which needs the exact same Store API calls
// against a different domain. The Ultra Vision-specific exports below are
// left exactly as they were (same signatures, same hardcoded BASE_URL) so
// nothing about that source changes; they could be rewritten as thin
// wrappers around these, but leaving them untouched is zero-risk.
//
// 2026-11-07: OZZ's fetch started failing ("Unexpected token '<' ... is
// not valid JSON"). Confirmed via an independent fetch from outside this
// app's own network that ozzlights.com's Store API returns real JSON
// fine — the request from THIS app's network got an HTML page back
// instead, with a 200 status. Same network/IP-level anti-bot symptom
// already solved for STEDI (see stediScraper.server.js), not a bug in
// the URL or the parsing. Unlike STEDI's block (confirmed permanent),
// OZZ's may be intermittent bot-scoring rather than a hard rule, so
// rather than forcing every call through the paid Bright Data Web
// Unlocker unconditionally, this tries a direct request first — now with
// real browser-style headers, which the old bare `Accept:
// application/json` fetch didn't send and some bot filters key on — and
// only falls back to the Web Unlocker (reusing STEDI's own
// BRIGHTDATA_API_KEY/BRIGHTDATA_UNLOCKER_ZONE Railway env vars) when the
// direct request comes back blocked. Either path now fails with a clear,
// specific error instead of the old cryptic JSON.parse crash.
const BRIGHTDATA_API_URL = "https://api.brightdata.com/request";
const BROWSER_HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

// Same challenge-page sniff STEDI's scraper uses (stediScraper.server.js
// fetchHtml) — a short response containing wording common to
// Cloudflare/anti-bot interstitials, as opposed to a genuine HTTP error
// unrelated to bot-blocking (a real 404/500 body).
function looksLikeBlockPage(text) {
  return (
    text.length < 5000 &&
    /enable javascript|checking your browser|cf-browser-verification|just a moment|attention required/i.test(text)
  );
}

async function fetchJsonViaUnlocker(url) {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  const zone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  if (!apiKey || !zone) {
    throw new Error(
      `Blocked fetching ${url} and BRIGHTDATA_API_KEY/BRIGHTDATA_UNLOCKER_ZONE aren't set, so there's no fallback — these are the same Railway env vars STEDI's scraper needs.`,
    );
  }
  const res = await fetch(BRIGHTDATA_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ zone, url, format: "raw" }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Bright Data Web Unlocker HTTP ${res.status} for ${url}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  const text = await res.text();
  if (looksLikeBlockPage(text)) {
    throw new Error(`Blocked/challenge page returned even via Bright Data's Web Unlocker for ${url}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Bright Data Web Unlocker returned non-JSON for ${url}: ${text.slice(0, 200)}`);
  }
}

async function fetchJsonFrom(baseUrl, path) {
  const url = `${baseUrl}${path}`;
  let res;
  let text;
  try {
    res = await fetch(url, { headers: BROWSER_HEADERS });
    text = await res.text();
  } catch (err) {
    // 2026-11-07, round 2: the connection itself is now being reset
    // ("socket hang up"/ECONNRESET) before any response at all comes
    // back — a step up from the 200-with-HTML-challenge seen earlier the
    // same day, but the same underlying network/IP-level block, just
    // enforced harder. There's no response to inspect here, so go
    // straight to the Web Unlocker rather than letting this throw
    // uncaught the way it did before this fix.
    const data = await fetchJsonViaUnlocker(url);
    await sleep(REQUEST_DELAY_MS);
    return data;
  }

  if (res.ok) {
    try {
      const data = JSON.parse(text);
      await sleep(REQUEST_DELAY_MS);
      return data;
    } catch {
      // Status 200 but not real JSON — a bot-challenge page served with
      // a 200, same symptom already seen on STEDI. Fall through to the
      // Web Unlocker below instead of throwing the old cryptic
      // "Unexpected token '<'" error.
    }
  } else if (!looksLikeBlockPage(text)) {
    // A real HTTP error (404, 500, etc.) unrelated to bot-blocking — the
    // Web Unlocker won't fix that, so surface it directly.
    throw new Error(`HTTP ${res.status} for ${path}: ${text.slice(0, 200)}`);
  }

  const data = await fetchJsonViaUnlocker(url);
  await sleep(REQUEST_DELAY_MS);
  return data;
}

export async function fetchAllWooProducts(baseUrl) {
  const all = [];
  let page = 1;
  while (true) {
    const products = await fetchJsonFrom(baseUrl, `/wp-json/wc/store/v1/products?page=${page}&per_page=${PER_PAGE}`);
    if (!Array.isArray(products) || products.length === 0) break;
    all.push(...products);
    if (products.length < PER_PAGE) break; // last page
    page += 1;
    if (page > 50) break; // sanity guard
  }
  return all;
}

// Same type=variation filtering approach as fetchAllVariations below —
// see that function's comment for why (no authenticated-API dependency).
export async function fetchAllWooVariations(baseUrl) {
  const all = [];
  let page = 1;
  while (true) {
    const variations = await fetchJsonFrom(baseUrl, `/wp-json/wc/store/v1/products?type=variation&page=${page}&per_page=${PER_PAGE}`);
    if (!Array.isArray(variations) || variations.length === 0) break;
    all.push(...variations);
    if (variations.length < PER_PAGE) break;
    page += 1;
    if (page > 50) break; // sanity guard
  }
  return all;
}

// WooCommerce Store API returns prices as integer strings in "minor
// units" (cents) — a price of $11.05 comes back as {"price": "1105",
// "currency_minor_unit": 2}, NOT "11.05". Missing this is a well-known
// gotcha with this API; confirmed the exact shape against WooCommerce's
// own docs before relying on it.
function priceToDecimal(prices) {
  if (!prices || prices.price == null) return null;
  const minor = parseInt(prices.price, 10);
  if (Number.isNaN(minor)) return null;
  const divisor = 10 ** (prices.currency_minor_unit ?? 2);
  return minor / divisor;
}

export async function fetchAllUltraVisionProducts() {
  const all = [];
  let page = 1;
  while (true) {
    const products = await fetchJson(`/wp-json/wc/store/v1/products?page=${page}&per_page=${PER_PAGE}`);
    if (!Array.isArray(products) || products.length === 0) break;
    all.push(...products);
    if (products.length < PER_PAGE) break; // last page
    page += 1;
    if (page > 50) break; // sanity guard
  }
  return all;
}

// Store API excludes variation detail from the main product list by
// design — a variable product's `variations` field there is just an
// array of IDs. Real per-variation sku/price/attributes/images need a
// separate call.
//
// Confirmed via WooCommerce's own docs after an initial wrong guess
// here: there's no /products/{id}/variations sub-resource on this API —
// that path belongs to the separate, authenticated wc/v2/v3 REST API
// (which needs API keys this integration doesn't have, by design, since
// the whole point of the Store API is unauthenticated public access).
// The Store API's own documented approach is filtering the main
// products list with type=variation — confirmed directly in their docs,
// unlike the per-product "parent" query param this could otherwise use,
// which isn't confirmed to exist on this endpoint. Fetching all
// variations once (paginated) and grouping client-side avoids betting
// on that unconfirmed parameter, and is also far fewer requests than
// one call per variable product.
export async function fetchAllVariations() {
  const all = [];
  let page = 1;
  while (true) {
    const variations = await fetchJson(`/wp-json/wc/store/v1/products?type=variation&page=${page}&per_page=${PER_PAGE}`);
    if (!Array.isArray(variations) || variations.length === 0) break;
    all.push(...variations);
    if (variations.length < PER_PAGE) break;
    page += 1;
    if (page > 50) break; // sanity guard
  }
  return all;
}

// A variation's parent-referencing field name isn't confirmed from docs
// alone (WooCommerce's shape has varied here across versions) — check
// every plausible field rather than commit to one guess a second time.
export function variationParentId(variation) {
  return variation.parent_id ?? variation.parent ?? variation.parent_product_id ?? null;
}

// Builds a productId -> variations[] lookup from a flat variations list.
export function groupVariationsByParent(variations) {
  const map = new Map();
  for (const v of variations) {
    const parentId = variationParentId(v);
    if (parentId == null) continue;
    const key = String(parentId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  }
  return map;
}

export { priceToDecimal };
