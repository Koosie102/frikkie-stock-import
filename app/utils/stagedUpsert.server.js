// Upserts fetched/mapped products into StagedProduct, keyed on the unique
// (source, sourceUrl) pair. Used by every source's "fetch" action instead
// of a plain create-per-row loop, which was the cause of re-fetching the
// same source stacking duplicate rows every time the button was clicked.
//
// On an existing row, only the *catalog* fields are refreshed (title,
// description, images, tags, variant/option data, sku) — retailZar,
// costZar, status, and shopifyProductId are deliberately left untouched.
// That's what makes a re-fetch safe to run any time: it won't wipe out a
// price you've manually edited, and it won't revert an already-pushed
// product back to "needs review".
export async function upsertStagedProducts(db, runId, source, mappedProducts) {
  let created = 0;
  let updated = 0;

  for (const mapped of mappedProducts) {
    const existing = await db.stagedProduct.findUnique({
      where: { source_sourceUrl: { source, sourceUrl: mapped.sourceUrl } },
      select: { id: true },
    });

    if (existing) {
      await db.stagedProduct.update({
        where: { id: existing.id },
        data: {
          runId,
          sku: mapped.sku,
          title: mapped.title,
          descriptionHtml: mapped.descriptionHtml,
          images: mapped.images,
          tags: mapped.tags,
          variantsJson: mapped.variantsJson,
        },
      });
      updated += 1;
    } else {
      await db.stagedProduct.create({
        data: { runId, source, ...mapped, status: "NEEDS_REVIEW" },
      });
      created += 1;
    }
  }

  return { created, updated };
}
