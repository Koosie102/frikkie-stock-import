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
