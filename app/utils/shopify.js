// Plain (non-.server) helpers safe to import from both loaders/actions and
// route components. Split out of shopifyMatch.server.js because it was
// being called directly inside component render code (not just loader),
// which Remix can't tree-shake out of the client bundle — a .server.js
// import used outside loader/action/headers breaks the production build
// with "Server-only module referenced by client". Caught when the
// TrailBait route (which follows the same ALTIQ pattern) surfaced it on
// the first real Railway production build of this app.

// Converts a Shopify GID (gid://shopify/Product/123456) into the numeric
// admin URL path, since that's what the classic /admin/products/ link needs.
export function productIdToAdminPath(gid) {
  const numeric = gid?.split("/").pop();
  return numeric ? `/admin/products/${numeric}` : null;
}
