// Reference data for lining up a new import with what's already in the
// store: which tags are already used on this vendor's products (so new
// products can reuse the same spelling/casing instead of creating
// near-duplicate tags), and what collections exist in the store.
//
// This is informational only for now — it doesn't rewrite tags
// automatically on push. Surfaced in a "Shopify tags & collections"
// card so Coenraad can see the existing taxonomy before/while reviewing
// a fetch, and manually align staged tags if needed.

const COLLECTIONS_QUERY = `#graphql
  query AllCollections($cursor: String) {
    collections(first: 100, after: $cursor) {
      nodes { id title handle }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Tags already in use across this vendor's existing products, sorted by
// frequency (most-used first) — built from the same vendor product list
// fetchVendorProducts() already pulls for fuzzy title matching, so this
// doesn't cost a second query when called right after that.
export function summarizeVendorTags(vendorProducts) {
  const counts = new Map();
  for (const product of vendorProducts) {
    for (const tag of product.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
}

export async function fetchAllCollections(admin) {
  const collections = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const response = await admin.graphql(COLLECTIONS_QUERY, { variables: { cursor } });
    const body = await response.json();
    const data = body.data?.collections;
    if (!data) break;
    collections.push(...data.nodes.map((n) => ({ id: n.id, title: n.title, handle: n.handle })));
    if (!data.pageInfo.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
  }
  return collections;
}
