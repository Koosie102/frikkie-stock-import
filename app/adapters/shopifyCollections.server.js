// Pushes CollectionDef rows to Shopify as smart collections, and syncs a
// brand's menu subtree into the store's main navigation menu.

const COLLECTION_CREATE_MUTATION = `#graphql
  mutation CreateCollectionDef($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id title }
      userErrors { field message }
    }
  }
`;

const COLLECTION_UPDATE_MUTATION = `#graphql
  mutation UpdateCollectionDef($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id title }
      userErrors { field message }
    }
  }
`;

// Creates the collection if it has no shopifyCollectionId yet, otherwise
// updates the existing one in place — same create-or-update pattern used
// for products, so re-pushing after editing tags/title never duplicates.
export async function pushCollectionDef(admin, def) {
  const input = {
    title: def.title,
    ruleSet: { appliedDisjunctively: false, rules: def.rules },
  };

  if (def.shopifyCollectionId) {
    input.id = def.shopifyCollectionId;
    const response = await admin.graphql(COLLECTION_UPDATE_MUTATION, { variables: { input } });
    const body = await response.json();
    const result = body.data?.collectionUpdate;
    if (!result) throw new Error(JSON.stringify(body.errors || body));
    if (result.userErrors?.length) throw new Error(result.userErrors.map((e) => e.message).join("; "));
    return result.collection.id;
  }

  const response = await admin.graphql(COLLECTION_CREATE_MUTATION, { variables: { input } });
  const body = await response.json();
  const result = body.data?.collectionCreate;
  if (!result) throw new Error(JSON.stringify(body.errors || body));
  if (result.userErrors?.length) throw new Error(result.userErrors.map((e) => e.message).join("; "));
  return result.collection.id;
}

// Pulls in smart collections that already exist in Shopify for a given
// vendor — for brands that had real collections set up directly in
// Shopify before this app existed (only TrailBait's 31 were seeded here
// manually; STEDI/Bushdoof/ALTIQ/Ultra Vision's live collections predate
// this app and were never in the CollectionDef table). Fetches every
// smart collection in the store (paginated) and keeps only the ones
// whose rule set includes a VENDOR rule matching this brand — Shopify
// has no server-side "find collections for vendor X" filter, so this
// has to fetch broadly and filter client-side.
const ALL_COLLECTIONS_QUERY = `#graphql
  query AllCollections($cursor: String) {
    collections(first: 100, after: $cursor) {
      nodes {
        id
        title
        ruleSet {
          rules { column relation condition }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const COLLECTIONS_MAX_PAGES = 10; // 1000 collections — comfortably above what this store has

export async function fetchExistingCollectionsForVendor(admin, vendor) {
  const matches = [];
  let cursor = null;
  for (let page = 0; page < COLLECTIONS_MAX_PAGES; page++) {
    const response = await admin.graphql(ALL_COLLECTIONS_QUERY, { variables: { cursor } });
    const body = await response.json();
    const data = body.data?.collections;
    if (!data) break;

    for (const node of data.nodes) {
      const rules = node.ruleSet?.rules;
      if (!rules) continue; // manual (non-smart) collection — nothing to sync, no rules to read
      const hasVendorRule = rules.some(
        (r) => r.column === "VENDOR" && r.relation === "EQUALS" && r.condition.toLowerCase() === vendor.toLowerCase(),
      );
      if (hasVendorRule) {
        matches.push({ id: node.id, title: node.title, rules });
      }
    }

    if (!data.pageInfo.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
  }
  return matches;
}

// Full 3-level tree, including id/resourceId on every item — needed to
// round-trip every OTHER top-level tab unchanged when we update the menu,
// since menuUpdate replaces the entire items list in one call.
const MAIN_MENU_QUERY = `#graphql
  query MainMenu {
    menus(first: 1, query: "handle:main-menu") {
      nodes {
        id
        title
        handle
        items {
          id
          title
          type
          url
          resourceId
          items {
            id
            title
            type
            url
            resourceId
            items {
              id
              title
              type
              url
              resourceId
            }
          }
        }
      }
    }
  }
`;

export async function fetchMainMenu(admin) {
  const response = await admin.graphql(MAIN_MENU_QUERY);
  const body = await response.json();
  const menu = body.data?.menus?.nodes?.[0];
  if (!menu) throw new Error("Could not find the store's Main Menu (handle: main-menu).");
  return menu;
}

// Converts a fetched menu item (read shape, with __typename-ish extras)
// into the MenuItemUpdateInput shape menuUpdate expects — same fields,
// just stripped of anything not in that input type. Recurses through
// all 3 levels.
function toUpdateInput(item) {
  const out = { title: item.title, type: item.type };
  if (item.id) out.id = item.id;
  if (item.url) out.url = item.url;
  if (item.resourceId) out.resourceId = item.resourceId;
  if (item.items?.length) out.items = item.items.map(toUpdateInput);
  return out;
}

// Builds the MenuItemUpdateInput subtree for one brand's tab from its
// CollectionDefs, grouped by menuGroup. Defs with no menuGroup become
// top-level-ish leaf items directly under the brand tab (flat categories
// like Electrical); defs with a menuGroup nest under an HTTP "#" group
// header for that group (same pattern this store's own "Ultra Vision"
// menu already uses for "Shop by Range").
function buildBrandItems(collectionDefs) {
  const groups = new Map(); // groupName -> [{def}]
  const flat = [];

  for (const def of collectionDefs) {
    if (!def.shopifyCollectionId) continue; // not pushed yet — nothing to link to
    if (def.menuGroup) {
      if (!groups.has(def.menuGroup)) groups.set(def.menuGroup, []);
      groups.get(def.menuGroup).push(def);
    } else {
      flat.push(def);
    }
  }

  const items = [];
  for (const [groupName, defs] of groups) {
    items.push({
      title: groupName,
      type: "HTTP",
      url: "#",
      items: defs.map((def) => ({
        title: def.title,
        type: "COLLECTION",
        resourceId: def.shopifyCollectionId,
      })),
    });
  }
  for (const def of flat) {
    items.push({ title: def.title, type: "COLLECTION", resourceId: def.shopifyCollectionId });
  }
  return items;
}

const MENU_UPDATE_MUTATION = `#graphql
  mutation SyncBrandMenu($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, items: $items) {
      menu { id }
      userErrors { field message }
    }
  }
`;

// Replaces (or appends) the given brand tab's subtree in the live Main
// Menu, leaving every other top-level tab exactly as it was. Since
// menuUpdate takes the whole items list in one call, this always
// re-fetches the current menu first and round-trips every untouched tab
// through toUpdateInput() rather than assuming a stale copy is safe.
export async function syncBrandMenu(admin, brandTabTitle, collectionDefs) {
  const menu = await fetchMainMenu(admin);
  const brandItems = buildBrandItems(collectionDefs);

  const newTabItem = {
    title: brandTabTitle,
    type: "HTTP", // dropdown-only parent, no direct link — same pattern this store's own menu already uses for "Shop by Range"/"Shop by Vehicle" group headers
    url: "#",
    items: brandItems,
  };

  const existingIndex = menu.items.findIndex(
    (item) => item.title.trim().toUpperCase() === brandTabTitle.trim().toUpperCase(),
  );

  const updatedItems = menu.items.map(toUpdateInput);
  if (existingIndex >= 0) {
    // Preserve the existing tab's id so its position/identity is kept —
    // only its title/items are replaced.
    newTabItem.id = menu.items[existingIndex].id;
    updatedItems[existingIndex] = newTabItem;
  } else {
    updatedItems.push(newTabItem);
  }

  const response = await admin.graphql(MENU_UPDATE_MUTATION, {
    variables: { id: menu.id, title: menu.title, items: updatedItems },
  });
  const body = await response.json();
  const result = body.data?.menuUpdate;
  if (!result) throw new Error(JSON.stringify(body.errors || body));
  if (result.userErrors?.length) throw new Error(result.userErrors.map((e) => e.message).join("; "));
  return result.menu.id;
}
