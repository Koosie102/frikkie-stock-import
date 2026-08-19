// Bulk version of the per-row "Sync to Rxxx" price sync — scans every
// staged product for a source, matches it against the live Shopify
// catalog by SKU (reusing the same lookup the review table already
// uses), and pushes an updated price for every one whose live Shopify
// price no longer matches the staged (freshly recalculated) price.
// Scoped to ALL staged rows with a SKU, not just ones marked Pushed —
// a product can already exist in Shopify (matched by SKU) without
// having been pushed through this app specifically.
import { matchSkusToShopify, syncVariantPrice } from "./shopifyMatch.server";

export async function bulkSyncPrices(admin, db, source) {
  const stagedList = await db.stagedProduct.findMany({
    where: { source, sku: { not: null }, retailZar: { not: null } },
  });

  const skus = stagedList.map((s) => s.sku).filter(Boolean);
  const matches = await matchSkusToShopify(admin, skus);

  let checked = 0;
  let updated = 0;
  const errors = [];

  for (const staged of stagedList) {
    const match = staged.sku ? matches[staged.sku] : null;
    if (!match) continue;
    checked += 1;

    // Compare in cents to avoid float-precision false positives (e.g.
    // 699.0000001 vs 699 reading as "different").
    const priceDiffers = Math.round(match.price * 100) !== Math.round(staged.retailZar * 100);
    if (!priceDiffers) continue;

    try {
      await syncVariantPrice(admin, match.productId, match.variantId, staged.retailZar);
      updated += 1;
    } catch (err) {
      errors.push(`${staged.title}: ${String(err.message || err)}`);
    }
  }

  return { checked, updated, errors };
}
