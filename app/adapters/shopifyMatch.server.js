// Batch-looks-up SKUs against the live store catalog via GraphQL, so the
// review table can show "already in store at Rxxx" vs "not in store".
// Shopify's search query has practical length limits, so this chunks.

const CHUNK_SIZE = 20;

const MATCH_QUERY = `#graphql
  query MatchSkus($query: String!) {
    productVariants(first: 100, query: $query) {
      nodes {
        sku
        price
        product { id title status }
      }
    }
  }
`;

export async function matchSkusToShopify(admin, skus) {
  const cleanSkus = [...new Set(skus.filter(Boolean))];
  const matches = {}; // sku -> { price, status, productId, productTitle }

  for (let i = 0; i < cleanSkus.length; i += CHUNK_SIZE) {
    const chunk = cleanSkus.slice(i, i + CHUNK_SIZE);
    const query = chunk.map((sku) => `sku:'${sku.replace(/'/g, "")}'`).join(" OR ");

    try {
      const response = await admin.graphql(MATCH_QUERY, { variables: { query } });
      const body = await response.json();
      const nodes = body.data?.productVariants?.nodes || [];

      for (const node of nodes) {
        if (!node.sku) continue;
        matches[node.sku] = {
          price: parseFloat(node.price),
          status: node.product.status,
          productId: node.product.id,
          productTitle: node.product.title,
        };
      }
    } catch (err) {
      console.error("Shopify SKU match lookup failed for chunk:", err);
      // Non-fatal — matches just stay empty for this chunk, review table
      // shows "not in store" rather than blocking the whole page.
    }
  }

  return matches;
}

// Converts a Shopify GID (gid://shopify/Product/123456) into the numeric
// admin URL path, since that's what the classic /admin/products/ link needs.
export function productIdToAdminPath(gid) {
  const numeric = gid?.split("/").pop();
  return numeric ? `/admin/products/${numeric}` : null;
}
