// Public, unauthenticated image route — deliberately NOT under app/routes/
// app.* (that's what puts a route behind authenticate.admin / the Shopify
// embedded-app session). Shopify's own servers fetch this URL directly
// when a MagicStar product is pushed (see shopifyPush.server.js's
// `originalSource` handling), the same way they fetch any other source's
// already-public, supplier-hosted image URL — so this has to be reachable
// with no Shopify session at all.
import db from "../db.server";

export const loader = async ({ params }) => {
  const sku = params.sku;
  const row = await db.magicstarImage.findUnique({ where: { sku } });
  if (!row) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(row.data, {
    headers: {
      "Content-Type": row.mimeType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
