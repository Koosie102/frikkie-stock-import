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
};
