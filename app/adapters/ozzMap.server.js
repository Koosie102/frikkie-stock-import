import { formatProductTitle } from "../utils/text";

// Unlike Ultra Vision, OZZ's WooCommerce Store API returns "0" for every
// product's price (a deliberate reseller-only catalog — is_purchasable is
// false on every product), so there's no pricingFn parameter here at all:
// every staged product comes in with no cost/retail yet. Real pricing
// merges in afterwards from Coenraad's own PDF dealer+retail pricelist,
// keyed by SKU — see ozzPdf.server.js (not built yet, pending the actual
// pricelist file) and the "Upload pricelist" action on this source's own
// route. Re-fetching the website catalog never touches price fields
// anyway (see utils/stagedUpsert.server.js), so this two-step shape is
// safe: fetch first, upload pricelist whenever, re-fetch later without
// losing merged prices.
function tagsFromCategories(categories) {
  const tags = [];
  const seen = new Set();
  for (const cat of categories || []) {
    const clean = (cat?.name || "").toLowerCase().trim().replace(/\s+/g, "-");
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      tags.push(clean);
    }
  }
  return tags;
}

function stripHtml(html) {
  return (html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// OZZ's WooCommerce content stores some punctuation as literal HTML
// entities (e.g. the inch/double-prime mark as "&#8243;" rather than the
// real ″ character) instead of the actual Unicode character — confirmed
// directly against a pushed product's description, which showed the raw
// "&#8243;" text rather than rendering it. Decoding here (on the raw
// fields, before any of them become title/description/tags) means every
// downstream use — the staged table, CSV export, the pushed Shopify
// product — gets real characters rather than relying on something else
// to interpret the entity later. Only touches "&...;" patterns, so real
// HTML tags in the description are left exactly as they are.
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));
}

export function mapOzzProduct(product, variations, titlePrefix) {
  const isGrouped = Array.isArray(variations) && variations.length > 0;

  const rawVariants = isGrouped
    ? variations.map((v) => ({
        sku: v.sku,
        // WooCommerce variation attributes come as [{ name, value }] —
        // join them for a readable per-variant title/option label
        // (e.g. "Colour: Black, Size: 40W" -> "Black / 40W"), same
        // pattern as Ultra Vision's mapping.
        optionLabel: decodeHtmlEntities((v.attributes || []).map((a) => a.value).filter(Boolean).join(" / ") || v.name || product.name),
        image: v.images?.[0]?.src,
      }))
    : [{ sku: product.sku, optionLabel: decodeHtmlEntities(product.name) }];

  const variants = rawVariants.map((v) => ({
    sku: v.sku,
    title: v.optionLabel,
    priceForeign: null,
    retailZar: null,
    costZar: null,
    priceIsEstimated: false,
    option1: isGrouped ? v.optionLabel : undefined,
  }));

  const first = variants[0];
  const images = (product.images || []).map((img) => img.src).filter(Boolean);

  const decodedName = decodeHtmlEntities(product.name);

  return {
    sourceUrl: product.permalink,
    sku: product.sku || first?.sku || null,
    title: titlePrefix ? formatProductTitle(titlePrefix, decodedName) : decodedName,
    descriptionHtml: decodeHtmlEntities(product.description) || stripHtml(decodeHtmlEntities(product.short_description)) || "",
    images,
    variantsJson: { optionNames: isGrouped ? ["Option"] : [], variants },
    tags: tagsFromCategories(product.categories),
    retailZar: null,
    costZar: null,
    priceIsEstimated: false,
  };
}
