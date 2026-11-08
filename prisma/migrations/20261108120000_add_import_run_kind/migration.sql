-- Lets a source have more than one kind of background run without
-- stealing a new value in the shared `Source` enum (which StagedProduct,
-- SourceSettings and CollectionDef also key off of). MagicStar's new
-- Alibaba-catalog-enrichment job uses kind = 'catalog'; every existing
-- run (and every other source) keeps kind = NULL and is unaffected.
ALTER TABLE "ImportRun" ADD COLUMN "kind" TEXT;
