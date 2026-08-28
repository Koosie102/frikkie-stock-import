// Recalculates costZar/retailZar for every staged product of a source,
// using the given pricing function. Called right after saving a source's
// pricing formula settings — without this, editing the formula only
// affected the *next* fetch, which isn't what "change the price math"
// means to someone looking at products already on screen.
//
// Deliberately does NOT skip PUSHED products. This looks like it should
// protect the price already live on Shopify, but it doesn't — updating
// the STAGED retailZar/costZar here never touches Shopify by itself,
// only a separate explicit Push or "Update all prices" action does that.
// Skipping PUSHED rows here just meant a formula change could never
// reach an already-pushed product through any path at all: "Update all
// prices" reads from this same staged value, so it would keep re-sending
// the old stale price forever. Recalculating pushed rows too means the
// staged number correctly reflects "what the new formula says this
// should cost", and the existing price-differs-from-live indicator (and
// Update all prices / per-row Sync buttons) then correctly show up to
// guide pushing that new number to Shopify when ready — nothing here
// changes anything on Shopify directly.
//
// Still touches prices someone may have hand-edited — recalculating is
// the whole point of this action, so it isn't hedged the way the
// upsert-on-refetch path is.
//
// Must update BOTH the top-level retailZar/costZar (used for single-
// variant push) AND each entry in variantsJson.variants (used for
// multi-variant push) — pushStagedProduct reads per-variant prices from
// the latter for anything with real product options.
export async function recalculateStagedPrices(db, source, pricingFn) {
  const items = await db.stagedProduct.findMany({
    where: { source },
  });

  let updated = 0;

  for (const item of items) {
    const variants = item.variantsJson?.variants;
    if (!variants?.length) continue;

    const newVariants = variants.map((v) => {
      if (v.priceForeign == null) return v;
      const { retailZar, costZar } = pricingFn(v.priceForeign);
      return { ...v, retailZar, costZar };
    });

    const first = newVariants[0];
    await db.stagedProduct.update({
      where: { id: item.id },
      data: {
        variantsJson: { ...item.variantsJson, variants: newVariants },
        retailZar: first?.retailZar ?? item.retailZar,
        costZar: first?.costZar ?? item.costZar,
      },
    });
    updated += 1;
  }

  return updated;
}
