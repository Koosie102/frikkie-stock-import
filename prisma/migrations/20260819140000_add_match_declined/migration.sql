-- Tracks when a user explicitly dismisses a fuzzy-match suggestion, so it
-- doesn't keep resurfacing on future page loads for the same staged product.
ALTER TABLE "StagedProduct" ADD COLUMN "matchDeclined" BOOLEAN NOT NULL DEFAULT false;
