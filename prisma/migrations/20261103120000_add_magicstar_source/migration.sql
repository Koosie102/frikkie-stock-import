-- Adds MagicStar as a new import source. Unlike every other source,
-- MagicStar has no website or API at all — the catalog only exists as a
-- PDF pricelist they send, with embedded product photos instead of a
-- fetchable image URL. MagicstarImage stores those extracted photo bytes
-- so the app can serve each one at its own public URL, which Shopify's
-- productSet mutation then fetches the same way it fetches every other
-- source's (already-public, supplier-hosted) image URL.
ALTER TYPE "Source" ADD VALUE 'MAGICSTAR';

CREATE TABLE "MagicstarImage" (
    "sku" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MagicstarImage_pkey" PRIMARY KEY ("sku")
);
