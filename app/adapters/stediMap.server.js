import { formatProductTitle } from "../utils/text";

// Maps a scraped STEDI product (from stediScraper.server.js) into the same
// StagedProduct shape mapShopifyProduct() produces for the Shopify-source
// brands, so pushStagedProduct/matchSkusToShopify/recalculateStagedPrices
// all work unchanged regardless of where the data came from.
//
// pricingFn: (priceForeign) => { retailZar, costZar, priceIsEstimated }.
export function mapStediProduct(scraped, titlePrefix, pricingFn) {
  const isGrouped = scraped.isGrouped && scraped.groupChildren?.length > 0;

  const rawVariants = isGrouped
    ? scraped.groupChildren.map((child) => ({
        sku: child.sku,
        title: child.name || scraped.title,
        priceForeign: parseFloat(child.priceAud),
        image: child.image,
      }))
    : [{
        sku: scraped.sku,
        title: scraped.title,
        priceForeign: parseFloat(scraped.priceAud),
      }];

  const variants = rawVariants
    .filter((v) => !Number.isNaN(v.priceForeign))
    .map((v) => {
      const { retailZar, costZar } = pricingFn(v.priceForeign);
      return {
        sku: v.sku,
        title: v.title,
        priceForeign: v.priceForeign,
        retailZar,
        costZar,
        option1: isGrouped ? v.title : undefined,
      };
    });

  const first = variants[0];

  return {
    sourceUrl: scraped.url,
    sku: scraped.sku || first?.sku || null,
    title: titlePrefix ? formatProductTitle(titlePrefix, scraped.title) : scraped.title,
    descriptionHtml: scraped.descriptionHtml || "",
    images: scraped.images,
    variantsJson: { optionNames: isGrouped ? ["Option"] : [], variants },
    tags: [], // no category->tag mapping ported yet — see ShopifyTagsCard for the existing-tag reference instead
    retailZar: first?.retailZar ?? null,
    costZar: first?.costZar ?? null,
    priceIsEstimated: true,
  };
}
