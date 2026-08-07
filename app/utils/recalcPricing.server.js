// Recalculates costZar/retailZar for every not-yet-pushed staged product
// of a source, using the given pricing function. Called right after
// saving a source's pricing formula settings — without this, editing the
// formula only affected the *next* fetch, which isn't what "change the
// price math" means to someone looking at products already on screen.
//
// Deliberately skips PUSHED products (their price is already live on the
// actual Shopify product, so silently changing the staged row wouldn't
// reflect reality) but touches everything else, including prices someone
// may have hand-edited — recalculating is the whole point of this action,
// so it isn't hedged the way the upsert-on-refetch path is.
//
// Must update BOTH the top-level retailZar/costZar (used for single-
// variant push) AND each entry in variantsJson.variants (used for
// multi-variant push) — pushStagedProduct reads per-variant prices from
// the latter for anything with real product options.
export async function recalculateStagedPrices(db, source, pricingFn) {
  const items = await db.stagedProduct.findMany({
    where: { source, status: { not: "PUSHED" } },
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
