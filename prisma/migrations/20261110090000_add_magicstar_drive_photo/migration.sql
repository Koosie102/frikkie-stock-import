-- Real, multi-photo-per-SKU product photos for WOEST Caraq, matched from a
-- ZIP of the MagicStar Google Drive photo folder (see
-- magicstarDrivePhotos.server.js) — distinct from MagicstarImage, which
-- only ever holds the single photo embedded in the pricelist PDF.
CREATE TABLE "MagicstarDrivePhoto" (
    "sku" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MagicstarDrivePhoto_pkey" PRIMARY KEY ("sku","position")
);
