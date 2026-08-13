// Batch-looks-up SKUs against the live store catalog via GraphQL, so the
// review table can show "already in store at Rxxx" vs "not in store".
// Shopify's search query has practical length limits, so this chunks.

const CHUNK_SIZE = 20;

const MATCH_QUERY = `#graphql
  query MatchSkus($query: String!) {
    productVariants(first: 100, query: $query) {
      nodes {
        id
        sku
        price
        product { id title status }
      }
    }
  }
`;

export async function matchSkusToShopify(admin, skus) {
  const cleanSkus = [...new Set(skus.filter(Boolean))];
  const matches = {}; // sku -> { price, status, productId, productTitle, variantId }

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
          variantId: node.id,
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

// Batch-checks whether a set of Shopify product IDs still exist — used by
// the "Sync with Shopify" action to catch products that were deleted (or
// otherwise vanished) directly in Shopify admin after being pushed, so
// the staged row's "Pushed" status doesn't silently go stale. Shopify's
// nodes() query returns null in the matching position for any id that
// no longer exists or isn't a Product, which is exactly what's needed
// here — no separate per-id existence check required.
const NODES_EXIST_QUERY = `#graphql
  query CheckProductsExist($ids: [ID!]!) {
    nodes(ids: $ids) {
      id
    }
  }
`;

const NODES_CHUNK_SIZE = 100;

export async function checkProductsExist(admin, productIds) {
  const existing = new Set();
  const ids = [...new Set(productIds.filter(Boolean))];

  for (let i = 0; i < ids.length; i += NODES_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + NODES_CHUNK_SIZE);
    try {
      const response = await admin.graphql(NODES_EXIST_QUERY, { variables: { ids: chunk } });
      const body = await response.json();
      for (const node of body.data?.nodes || []) {
        if (node?.id) existing.add(node.id);
      }
    } catch (err) {
      console.error("Shopify product existence check failed for chunk:", err);
      // Non-fatal — on a failed chunk, leave those ids untouched (not
      // marked missing) rather than risk resetting a product that's
      // actually still there because of a transient error.
      for (const id of chunk) existing.add(id);
    }
  }

  return existing;
}

// Updates a single variant's price on an existing Shopify product — used
// by the "Sync price" action when a staged product's price has drifted
// from what's live on the matched Shopify listing (e.g. after a pricing
// formula change, or a source price update on re-fetch).
const SYNC_PRICE_MUTATION = `#graphql
  mutation SyncVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }
`;

export async function syncVariantPrice(admin, productId, variantId, price) {
  const response = await admin.graphql(SYNC_PRICE_MUTATION, {
    variables: {
      productId,
      variants: [{ id: variantId, price: price.toFixed(2) }],
    },
  });
  const body = await response.json();
  const errors = body.data?.productVariantsBulkUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

// Finds likely matches for staged products that had no exact SKU match —
// covers the common real-world case of a missing/renamed SKU with an
// otherwise-identical or near-identical title already in the store.
// Fetches every product for the vendor once (not per-row) and scores each
// unmatched staged title against it with a simple word-overlap (Jaccard)
// similarity — cheap, dependency-free, and good enough to flag candidates
// for a human to confirm. This never auto-matches; it's surfaced in the
// UI as "Possible match" separately from a confirmed SKU match.
const VENDOR_PRODUCTS_QUERY = `#graphql
  query VendorProducts($query: String!, $cursor: String) {
    products(first: 100, after: $cursor, query: $query) {
      nodes {
        id
        title
        status
        tags
        variants(first: 1) {
          nodes { price }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function normalizeWords(title) {
  return new Set(
    (title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 1),
  );
}

function jaccardSimilarity(a, b) {
  const setA = normalizeWords(a);
  const setB = normalizeWords(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const FUZZY_THRESHOLD = 0.5;
const MAX_PAGES = 5; // caps at 500 vendor products — plenty for these catalogs

export async function fetchVendorProducts(admin, vendor) {
  const products = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await admin.graphql(VENDOR_PRODUCTS_QUERY, {
      variables: { query: `vendor:'${vendor.replace(/'/g, "")}'`, cursor },
    });
    const body = await response.json();
    const data = body.data?.products;
    if (!data) break;
    products.push(
      ...data.nodes.map((n) => ({
        id: n.id,
        title: n.title,
        status: n.status,
        tags: n.tags,
        price: n.variants.nodes[0]?.price ? parseFloat(n.variants.nodes[0].price) : null,
      })),
    );
    if (!data.pageInfo.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
  }
  return products;
}

// unmatchedTitles: array of { id: stagedProductId, title }.
// Returns a map of stagedProductId -> { productId, productTitle, status, price, score }.
export function fuzzyMatchTitles(unmatchedTitles, vendorProducts) {
  const results = {};
  for (const { id, title } of unmatchedTitles) {
    let best = null;
    for (const product of vendorProducts) {
      const score = jaccardSimilarity(title, product.title);
      if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
        best = { ...product, score };
      }
    }
    if (best) {
      results[id] = {
        productId: best.id,
        productTitle: best.title,
        status: best.status,
        price: best.price,
        score: best.score,
      };
    }
  }
  return results;
}
