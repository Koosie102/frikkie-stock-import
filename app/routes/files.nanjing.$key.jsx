// Public, unauthenticated image route — same rationale as
// files.magicstar.$sku.jsx: Shopify's own servers fetch this URL directly
// when a Nanjing-sourced product is pushed, so it has to be reachable with
// no Shopify session at all. Keyed by imageKey (the shared photo for a
// whole size/variant group), not by the staged row's own SKU — several
// staged rows can point at the same key.
import db from "../db.server";

export const loader = async ({ params }) => {
  const imageKey = params.key;
  const row = await db.nanjingImage.findUnique({ where: { imageKey } });
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
