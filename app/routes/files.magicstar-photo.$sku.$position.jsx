// Public, unauthenticated image route for MagicstarDrivePhoto rows — same
// reasoning as files.magicstar.$sku.jsx (Shopify's own servers fetch this
// directly when a product is pushed, with no Shopify session at all).
import db from "../db.server";

export const loader = async ({ params }) => {
  const sku = params.sku;
  const position = Number(params.position);
  if (!sku || !Number.isInteger(position)) {
    return new Response("Not found", { status: 404 });
  }
  const row = await db.magicstarDrivePhoto.findUnique({ where: { sku_position: { sku, position } } });
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
