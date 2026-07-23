-- CreateEnum
CREATE TYPE "Source" AS ENUM ('STEDI', 'BUSHDOOF', 'ULTRA_VISION', 'ALTIQ');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('NEW', 'MATCHED', 'UNMATCHED', 'ESTIMATED_PRICE', 'NEEDS_REVIEW', 'PUSHED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRun" (
    "id" TEXT NOT NULL,
    "source" "Source" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "totalFound" INTEGER NOT NULL DEFAULT 0,
    "totalDone" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "errorLog" TEXT,

    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StagedProduct" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "source" "Source" NOT NULL,
    "sourceUrl" TEXT,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "descriptionHtml" TEXT,
    "costForeign" DOUBLE PRECISION,
    "costZar" DOUBLE PRECISION,
    "retailZar" DOUBLE PRECISION,
    "marginPct" DOUBLE PRECISION,
    "priceIsEstimated" BOOLEAN NOT NULL DEFAULT false,
    "weightKg" DOUBLE PRECISION,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "variantsJson" JSONB,
    "status" "ImportStatus" NOT NULL DEFAULT 'NEW',
    "shopifyProductId" TEXT,
    "matchedShopifyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StagedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceSettings" (
    "source" "Source" NOT NULL,
    "settingsJson" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceSettings_pkey" PRIMARY KEY ("source")
);

-- CreateIndex
CREATE INDEX "StagedProduct_runId_idx" ON "StagedProduct"("runId");

-- CreateIndex
CREATE INDEX "StagedProduct_source_status_idx" ON "StagedProduct"("source", "status");

-- AddForeignKey
ALTER TABLE "StagedProduct" ADD CONSTRAINT "StagedProduct_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ImportRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
