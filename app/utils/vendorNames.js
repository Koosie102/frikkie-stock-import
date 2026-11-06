// Maps a Source enum value to the vendor name that should land on the
// Shopify product (and is used to build tag/collection rules). Plain
// data, no server-only APIs — safe to import from both server code and
// client-rendered route components (unlike a .server.js file, which
// Remix strips from the client bundle and breaks the build if a
// component uses it outside loader/action).
export const VENDOR_NAMES = {
  STEDI: "STEDI",
  BUSHDOOF: "Bushdoof",
  ULTRA_VISION: "Ultra Vision",
  ALTIQ: "ALTIQ",
  TRAILBAIT: "TrailBait",
  // Deliberately not "300mods" — Coenraad's 2 existing 300mods products
  // are already listed under this vendor name, and matching it means new
  // imports recognize them as the same products (SKU/fuzzy match, push
  // update-in-place) instead of treating them as duplicates.
  MODS300: "4x4 Factory Products",
  // Deliberately not "MagicStar" or "Magicstar" — these are rebadged under
  // Coenraad's own new brand, WOEST off-road equipment, rather than the
  // Chinese manufacturer's name. The specific product line under WOEST is
  // "WOEST Caraq" — that part is a title prefix (see magicstarPdf.server.js
  // buildTitle), not the vendor, so every WOEST product still groups under
  // one vendor for collections/reporting even as more WOEST sub-lines get
  // added later.
  MAGICSTAR: "WOEST",
  // Same WOEST brand as MagicStar — Kudu (driving lights/spotlights/
  // light bars) vs Veldt (everything else) is a title prefix baked in by
  // nanjingPdf.server.js, not a separate vendor, so both sub-lines still
  // group under one vendor for collections/reporting.
  NANJING: "WOEST",
  // OZZ sells under its own name, no WOEST rebrand (unlike MagicStar/
  // Nanjing) — nothing's been said to the contrary.
  OZZ: "OZZ",
};
