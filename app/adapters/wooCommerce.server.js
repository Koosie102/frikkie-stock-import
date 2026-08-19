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
// array of IDs. Real per-variation sku/price/attributes/images need
// this dedicated sub-resource, one call per variable product.
export async function fetchProductVariations(productId) {
  const variations = await fetchJson(`/wp-json/wc/store/v1/products/${productId}/variations`);
  return Array.isArray(variations) ? variations : [];
}

export { priceToDecimal };
