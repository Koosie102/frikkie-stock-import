ALTER TYPE "Source" ADD VALUE 'NANJING';
CREATE TABLE "NanjingImage" (
    "imageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NanjingImage_pkey" PRIMARY KEY ("imageKey")
);
