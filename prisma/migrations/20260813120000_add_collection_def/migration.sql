-- CreateTable
CREATE TABLE "CollectionDef" (
    "id" TEXT NOT NULL,
    "source" "Source" NOT NULL,
    "title" TEXT NOT NULL,
    "menuGroup" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "rules" JSONB NOT NULL,
    "shopifyCollectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionDef_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CollectionDef_source_idx" ON "CollectionDef"("source");

-- Seed: the 31 TrailBait collections already created directly in Shopify
-- admin (via GraphQL, before this UI existed) — recorded here with their
-- real shopifyCollectionId so the Collections tab reflects reality
-- immediately instead of prompting a duplicate push.
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Ranger Super Duty', 'Shop by vehicle', 0, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "ford"}, {"column": "TAG", "relation": "EQUALS", "condition": "ranger"}, {"column": "TAG", "relation": "EQUALS", "condition": "super-duty"}]'::jsonb, 'gid://shopify/Collection/357575983281', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Next Gen Ranger', 'Shop by vehicle', 1, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "ford"}, {"column": "TAG", "relation": "EQUALS", "condition": "ranger"}, {"column": "TAG", "relation": "EQUALS", "condition": "next-gen"}]'::jsonb, 'gid://shopify/Collection/357576016049', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Next Gen Ranger Raptor', 'Shop by vehicle', 2, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "ford"}, {"column": "TAG", "relation": "EQUALS", "condition": "ranger"}, {"column": "TAG", "relation": "EQUALS", "condition": "raptor"}, {"column": "TAG", "relation": "EQUALS", "condition": "next-gen"}]'::jsonb, 'gid://shopify/Collection/357576048817', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Next Gen Everest', 'Shop by vehicle', 3, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "ford"}, {"column": "TAG", "relation": "EQUALS", "condition": "everest"}, {"column": "TAG", "relation": "EQUALS", "condition": "next-gen"}]'::jsonb, 'gid://shopify/Collection/357576081585', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Isuzu D-Max', 'Shop by vehicle', 4, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "isuzu"}, {"column": "TAG", "relation": "EQUALS", "condition": "dmax"}]'::jsonb, 'gid://shopify/Collection/357576114353', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Isuzu MU-X', 'Shop by vehicle', 5, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "isuzu"}, {"column": "TAG", "relation": "EQUALS", "condition": "mux"}]'::jsonb, 'gid://shopify/Collection/357576147121', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'BT-50 3rd Gen', 'Shop by vehicle', 6, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "bt50"}, {"column": "TAG", "relation": "EQUALS", "condition": "3rd-gen"}]'::jsonb, 'gid://shopify/Collection/357576179889', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'BT-50 2nd Gen', 'Shop by vehicle', 7, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "bt50"}, {"column": "TAG", "relation": "EQUALS", "condition": "2nd-gen"}]'::jsonb, 'gid://shopify/Collection/357576212657', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'MV Triton', 'Shop by vehicle', 8, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "mitsubishi"}, {"column": "TAG", "relation": "EQUALS", "condition": "triton"}, {"column": "TAG", "relation": "EQUALS", "condition": "mv"}]'::jsonb, 'gid://shopify/Collection/357576245425', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'MR Triton', 'Shop by vehicle', 9, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "mitsubishi"}, {"column": "TAG", "relation": "EQUALS", "condition": "triton"}, {"column": "TAG", "relation": "EQUALS", "condition": "mr"}]'::jsonb, 'gid://shopify/Collection/357576278193', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Pajero Sport', 'Shop by vehicle', 10, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "mitsubishi"}, {"column": "TAG", "relation": "EQUALS", "condition": "pajero"}, {"column": "TAG", "relation": "EQUALS", "condition": "sport"}]'::jsonb, 'gid://shopify/Collection/357576310961', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Navara 2026', 'Shop by vehicle', 11, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "nissan"}, {"column": "TAG", "relation": "EQUALS", "condition": "navara"}, {"column": "TAG", "relation": "EQUALS", "condition": "2026"}]'::jsonb, 'gid://shopify/Collection/357576343729', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Patrol Y62', 'Shop by vehicle', 12, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "nissan"}, {"column": "TAG", "relation": "EQUALS", "condition": "patrol"}, {"column": "TAG", "relation": "EQUALS", "condition": "y62"}]'::jsonb, 'gid://shopify/Collection/357576376497', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Navara NP300', 'Shop by vehicle', 13, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "nissan"}, {"column": "TAG", "relation": "EQUALS", "condition": "navara"}, {"column": "TAG", "relation": "EQUALS", "condition": "np300"}]'::jsonb, 'gid://shopify/Collection/357576409265', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Hilux N90', 'Shop by vehicle', 14, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "toyota"}, {"column": "TAG", "relation": "EQUALS", "condition": "hilux"}, {"column": "TAG", "relation": "EQUALS", "condition": "n90"}]'::jsonb, 'gid://shopify/Collection/357576442033', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'LandCruiser 300 Series', 'Shop by vehicle', 15, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "toyota"}, {"column": "TAG", "relation": "EQUALS", "condition": "landcruiser"}, {"column": "TAG", "relation": "EQUALS", "condition": "300"}]'::jsonb, 'gid://shopify/Collection/357576474801', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Prado 250', 'Shop by vehicle', 16, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "toyota"}, {"column": "TAG", "relation": "EQUALS", "condition": "prado"}, {"column": "TAG", "relation": "EQUALS", "condition": "250"}]'::jsonb, 'gid://shopify/Collection/357576507569', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Hilux N80', 'Shop by vehicle', 17, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "toyota"}, {"column": "TAG", "relation": "EQUALS", "condition": "hilux"}, {"column": "TAG", "relation": "EQUALS", "condition": "n80"}]'::jsonb, 'gid://shopify/Collection/357576540337', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'All-New Amarok', 'Shop by vehicle', 18, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "vw"}, {"column": "TAG", "relation": "EQUALS", "condition": "amarok"}, {"column": "TAG", "relation": "EQUALS", "condition": "all-new"}]'::jsonb, 'gid://shopify/Collection/357576573105', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Amarok', 'Shop by vehicle', 19, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "vw"}, {"column": "TAG", "relation": "EQUALS", "condition": "amarok"}, {"column": "TAG", "relation": "NOT_EQUALS", "condition": "all-new"}]'::jsonb, 'gid://shopify/Collection/357576605873', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Ford F-150', 'Shop by vehicle', 20, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "ford"}, {"column": "TAG", "relation": "EQUALS", "condition": "f150"}]'::jsonb, 'gid://shopify/Collection/357576638641', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Chevrolet Silverado', 'Shop by vehicle', 21, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "chevrolet"}, {"column": "TAG", "relation": "EQUALS", "condition": "silverado"}]'::jsonb, 'gid://shopify/Collection/357576671409', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Ram 1500', 'Shop by vehicle', 22, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "ram"}, {"column": "TAG", "relation": "EQUALS", "condition": "1500"}]'::jsonb, 'gid://shopify/Collection/357576704177', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Shark 6', 'Shop by vehicle', 23, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "byd"}, {"column": "TAG", "relation": "EQUALS", "condition": "shark"}, {"column": "TAG", "relation": "EQUALS", "condition": "6"}]'::jsonb, 'gid://shopify/Collection/357576736945', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Behind-Grille Light Bars', 'Lighting', 24, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "behind-grill"}]'::jsonb, 'gid://shopify/Collection/357576769713', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Ditch Lights', 'Lighting', 25, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "ditch"}]'::jsonb, 'gid://shopify/Collection/357576802481', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Lighting Accessories', 'Lighting', 26, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "accessory"}]'::jsonb, 'gid://shopify/Collection/357576835249', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Electrical', NULL, 27, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "electrical"}]'::jsonb, 'gid://shopify/Collection/357576868017', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Communication', NULL, 28, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "communication"}]'::jsonb, 'gid://shopify/Collection/357576900785', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Storage', NULL, 29, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "storage"}]'::jsonb, 'gid://shopify/Collection/357576933553', now(), now());
INSERT INTO "CollectionDef" ("id", "source", "title", "menuGroup", "position", "rules", "shopifyCollectionId", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'TRAILBAIT', 'Safety', NULL, 30, '[{"column": "VENDOR", "relation": "EQUALS", "condition": "TrailBait"}, {"column": "TAG", "relation": "EQUALS", "condition": "safety"}]'::jsonb, 'gid://shopify/Collection/357576966321', now(), now());
