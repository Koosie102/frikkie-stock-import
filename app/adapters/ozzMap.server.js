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

function escapeHtml(str) {
  return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// WooCommerce's Store API splits a product's real content across THREE
// separate fields, and the previous version of this adapter only ever
// read one of them (whichever of description/short_description happened
// to be non-empty) — confirmed empirically against OZZ's real API
// response (via a fresh fetch, not assumed) that this was silently
// dropping most of the actual product copy:
//   - short_description: the short prose paragraphs (fitment, material,
//     install notes) — often the ONLY place with real descriptive text.
//   - description: a block-editor section (Key Features / Related
//     documents / contact CTA) — can be non-empty even when it has none
//     of the actual descriptive prose, which is what made the `||`
//     fallback wrong: a non-empty `description` was masking a real,
//     non-empty `short_description` sitting right next to it.
//   - attributes: product-level spec data (voltage, IP rating, weight,
//     EAN code, etc.) — not prose at all, and wasn't being read anywhere
//     before this; confirmed shape is [{ name, terms: [{ name }] }]
//     (terms holds the value(s), not a plain "value" field).
// All three are concatenated here so nothing is silently dropped,
// regardless of which fields a given product happens to populate.
function specsTableHtml(attributes) {
  if (!Array.isArray(attributes) || attributes.length === 0) return "";
  const rows = attributes
    .map((a) => {
      const label = (a?.name || "").trim();
      // Seen in the real data: placeholder "-" values and values with a
      // literal newline in them (e.g. a lumen/wattage pair) — joined with
      // ", " and placeholder-only entries skipped rather than shown as
      // a meaningless "-" row.
      const value = (a?.terms || [])
        .map((t) => (t?.name || "").replace(/\n+/g, ", ").trim())
        .filter((v) => v && v !== "-")
        .join(", ");
      return label && value ? `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>` : null;
    })
    .filter(Boolean);
  if (rows.length === 0) return "";
  return `<table><tbody>${rows.join("")}</tbody></table>`;
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

  const descriptionParts = [
    decodeHtmlEntities(product.short_description),
    decodeHtmlEntities(product.description),
    specsTableHtml(product.attributes),
  ].filter((part) => part && part.trim());

  return {
    sourceUrl: product.permalink,
    sku: product.sku || first?.sku || null,
    title: titlePrefix ? formatProductTitle(titlePrefix, decodedName) : decodedName,
    descriptionHtml: descriptionParts.join("\n"),
    images,
    variantsJson: { optionNames: isGrouped ? ["Option"] : [], variants },
    tags: tagsFromCategories(product.categories),
    retailZar: null,
    costZar: null,
    priceIsEstimated: false,
  };
}
