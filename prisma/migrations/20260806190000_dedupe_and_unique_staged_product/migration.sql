-- Fixes duplicate staged products from re-fetching the same source: each
-- fetch was always INSERTing, never checking for an existing row, so
-- clicking "Fetch" more than once stacked duplicate rows per product.
--
-- Before adding the constraint that prevents this going forward, clean up
-- duplicates that already exist from past re-fetches. Keep one row per
-- (source, sourceUrl): prefer a PUSHED row if any duplicate was already
-- pushed to Shopify (so we don't lose that history), otherwise keep the
-- most recently updated one.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY source, "sourceUrl"
           ORDER BY (status = 'PUSHED') DESC, "updatedAt" DESC
         ) AS rn
  FROM "StagedProduct"
  WHERE "sourceUrl" IS NOT NULL
)
DELETE FROM "StagedProduct"
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- AddUniqueConstraint
ALTER TABLE "StagedProduct" ADD CONSTRAINT "StagedProduct_source_sourceUrl_key" UNIQUE (source, "sourceUrl");
