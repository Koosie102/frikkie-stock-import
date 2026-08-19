import { formatProductTitle } from "../utils/text";
import { priceToDecimal } from "./wooCommerce.server";

// Ultra Vision sells its own lighting ranges directly (Nitro Maxx,
// Raptor, Vulkan, Atom, Mine) rather than vehicle-specific fitment parts
// — the vehicle-brand/model tag generator built for TrailBait/STEDI
// doesn't apply here. WooCommerce already gives structured category
// data per product, which is a more reliable tag source for this source
// specifically than trying to parse it back out of the title.
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

// pricingFn: (priceForeign) => { retailZar, costZar, priceIsEstimated }
export function mapUltraVisionProduct(product, variations, titlePrefix, pricingFn) {
  const isGrouped = Array.isArray(variations) && variations.length > 0;

  const rawVariants = isGrouped
    ? variations.map((v) => ({
        sku: v.sku,
        // WooCommerce variation attributes come as [{ name, value }] —
        // join them for a readable per-variant title/option label
        // (e.g. "Colour: Black, Size: 40W" -> "Black / 40W").
        optionLabel: (v.attributes || []).map((a) => a.value).filter(Boolean).join(" / ") || v.name || product.name,
        priceForeign: priceToDecimal(v.prices),
        image: v.images?.[0]?.src,
      }))
    : [{
        sku: product.sku,
        optionLabel: product.name,
        priceForeign: priceToDecimal(product.prices),
      }];

  const variants = rawVariants
    .filter((v) => v.priceForeign != null)
    .map((v) => {
      const { retailZar, costZar, priceIsEstimated } = pricingFn(v.priceForeign);
      return {
        sku: v.sku,
        title: v.optionLabel,
        priceForeign: v.priceForeign,
        retailZar,
        costZar,
        priceIsEstimated,
        option1: isGrouped ? v.optionLabel : undefined,
      };
    });

  const first = variants[0];
  const images = (product.images || []).map((img) => img.src).filter(Boolean);

  return {
    sourceUrl: product.permalink,
    sku: product.sku || first?.sku || null,
    title: titlePrefix ? formatProductTitle(titlePrefix, product.name) : product.name,
    descriptionHtml: product.description || stripHtml(product.short_description) || "",
    images,
    variantsJson: { optionNames: isGrouped ? ["Option"] : [], variants },
    tags: tagsFromCategories(product.categories),
    retailZar: first?.retailZar ?? null,
    costZar: first?.costZar ?? null,
    priceIsEstimated: first?.priceIsEstimated ?? false,
  };
}
