// Shared fetch logic for brands whose own storefront runs on Shopify
// (Bushdoof, ALTIQ). Their public /products.json endpoint gives full
// variant data with no auth needed — same pattern the original Bushdoof
// Node script used against Bushdoof's product.json endpoint.
//
// ALTIQ confirmed running on Shopify (9df15d-3.myshopify.com) — trade
// cost still comes from the ultradealer.com.au B2B portal manually,
// since that's password-protected and not scriptable.

import { formatProductTitle } from "../utils/text";
import { generateTags } from "../utils/tagGenerator";

const PAGE_SIZE = 250;

export async function fetchAllProducts(storeDomain) {
  const products = [];
  let page = 1;

  while (true) {
    const url = `https://${storeDomain}/products.json?limit=${PAGE_SIZE}&page=${page}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FrikkiesStockImporter/1.0)" },
    });

    if (!res.ok) {
      throw new Error(`${storeDomain} products.json failed: ${res.status}`);
    }

    const data = await res.json();
    if (!data.products || data.products.length === 0) break;

    products.push(...data.products);
    if (data.products.length < PAGE_SIZE) break;
    page += 1;
  }

  return products;
}

// Maps a raw Shopify products.json entry into our shared StagedProduct shape.
// costForeign is left null here — Bushdoof/ALTIQ costs come from a
// distributor pricelist or manual trade-portal export, matched in by SKU
// in a separate step (same as the original Bushdoof script's pricing pass).
//
// retailMultiplier: ALTIQ uses AUD retail x24.5 for a first-pass ZAR price
// (per Coenraad, easiest reference for the importer — no cost/margin math).
//
// pricingFn: optional override for sources that have their own formula
// instead of a flat multiplier (e.g. TrailBait uses the STEDI-style
// "retail = price x24 rounded up to nearest R99, cost = retail x0.6").
// Signature: (priceForeign) => { retailZar, costZar, priceIsEstimated }.
// When omitted, falls back to the flat-multiplier behaviour above.
//
// titlePrefix: brand name in caps (e.g. "STEDI", "TRAILBAIT") to prepend
// to every title, title-casing the rest — "Duel Connector Wiring Harness"
// becomes "STEDI Duel Connector Wiring Harness". Omit to leave the
// source's own title untouched.
export function mapShopifyProduct(product, sourceDomain, retailMultiplier = 24.5, pricingFn = null, titlePrefix = null) {
  const images = (product.images || []).map((img) => img.src);

  // Real Shopify option names (e.g. "Color", "Size") — needed to rebuild
  // productOptions correctly when pushing via the productSet mutation.
  // A single-variant product with no real options reports one option
  // named "Title" with the single value "Default Title" — treat that as
  // "no options" rather than building a pointless Title dropdown.
  const rawOptionNames = (product.options || []).map((o) => o.name);
  const hasRealOptions = !(
    rawOptionNames.length === 1 && rawOptionNames[0] === "Title"
  );
  const optionNames = hasRealOptions ? rawOptionNames : [];

  const priceOf = (priceForeign) =>
    pricingFn ? pricingFn(priceForeign) : { retailZar: Math.round(priceForeign * retailMultiplier * 100) / 100 };

  const variants = product.variants.map((v) => {
    const priceForeign = parseFloat(v.price);
    const { retailZar, costZar } = priceOf(priceForeign);
    return {
      sku: v.sku,
      title: v.title,
      priceForeign,
      retailZar,
      costZar,
      option1: v.option1,
      option2: v.option2,
      option3: v.option3,
    };
  });

  const firstPrice = variants[0]?.priceForeign;
  const firstPricing = firstPrice != null ? priceOf(firstPrice) : {};

  return {
    sourceUrl: `https://${sourceDomain}/products/${product.handle}`,
    sku: product.variants?.[0]?.sku || null,
    title: titlePrefix ? formatProductTitle(titlePrefix, product.title) : product.title,
    descriptionHtml: product.body_html,
    images,
    variantsJson: { optionNames, variants },
    // Reported the source's raw tags were too scattered/inconsistent to
    // use as-is — generate a simpler set instead (brand/model/chassis
    // code/item-type), using the source's own product_type field (e.g.
    // "Brackets") as the item-type signal when present, which is far more
    // reliable than guessing from title words alone.
    tags: generateTags(product.title, { productType: product.product_type }),
    retailZar: firstPricing.retailZar ?? null,
    costZar: firstPricing.costZar ?? null,
    priceIsEstimated: firstPricing.priceIsEstimated ?? false,
  };
}
