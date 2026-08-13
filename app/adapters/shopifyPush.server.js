// Pushes a single StagedProduct to Shopify using the productSet mutation
// (single call handles options + variants + price/sku together).
// Lands as DRAFT so nothing goes live until reviewed in the store admin.

const PRODUCT_SET_MUTATION = `#graphql
  mutation CreateStagedProduct($productSet: ProductSetInput!, $synchronous: Boolean!, $identifier: ProductSetIdentifiers) {
    productSet(synchronous: $synchronous, input: $productSet, identifier: $identifier) {
      product { id }
      userErrors { field message }
    }
  }
`;

const PUBLISH_MUTATION = `#graphql
  mutation PublishToAllChannels($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

const PRIMARY_LOCATION_QUERY = `#graphql
  query PrimaryLocation {
    locations(first: 1, query: "status:active") {
      nodes { id }
    }
  }
`;

const PUBLICATIONS_QUERY = `#graphql
  query AllPublications {
    publications(first: 25) {
      nodes { id }
    }
  }
`;

// Defensive cleanup applied to every tag before it reaches Shopify,
// regardless of where it came from — the source's own raw tags,
// stale staged rows from before the current tag generator existed,
// or anything else that could slip through with an empty string, a
// too-long value, or a near-duplicate. Shopify's tag validation
// ("Product tags is invalid") gives no detail on which tag or why,
// so cleaning up defensively is cheaper than trying to diagnose it
// after the fact every time it happens.
function sanitizeTags(tags) {
  const seen = new Set();
  const cleaned = [];
  for (const raw of tags || []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().slice(0, 255); // Shopify's own per-tag limit
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(trimmed);
  }
  return cleaned;
}

// Maps a Source enum value to the vendor name that should land on the
// Shopify product. Was hardcoded to "ALTIQ" previously, which silently
// mislabeled every other source's pushed products — caught while adding
// TrailBait as a 5th source.
import { VENDOR_NAMES } from "../utils/vendorNames";
export { VENDOR_NAMES };

// Fetches the store's primary/first active location and every sales
// channel (publication) once per push batch — called by the route before
// looping over selected products, rather than per-product, since neither
// changes between pushes in the same batch.
export async function getPushChannelInfo(admin) {
  const [locResponse, pubResponse] = await Promise.all([
    admin.graphql(PRIMARY_LOCATION_QUERY),
    admin.graphql(PUBLICATIONS_QUERY),
  ]);
  const locBody = await locResponse.json();
  const pubBody = await pubResponse.json();

  const locationId = locBody.data?.locations?.nodes?.[0]?.id || null;
  const publicationIds = (pubBody.data?.publications?.nodes || []).map((p) => p.id);

  return { locationId, publicationIds };
}

export async function pushStagedProduct(admin, staged, existingProductId, channelInfo = {}) {
  const { locationId, publicationIds = [] } = channelInfo;
  const { optionNames = [], variants = [] } = staged.variantsJson || {};

  // Shared per-variant fields for cost/inventory tracking — every variant
  // gets these regardless of whether the product has real options.
  // Reported missing: cost-per-item wasn't set at all (Shopify left it
  // blank), and inventory wasn't tracked (so it showed neither a stock
  // count nor "continue selling when out of stock").
  const inventoryFieldsFor = (v) => ({
    inventoryItem: {
      cost: v.costZar != null ? v.costZar.toFixed(2) : undefined,
      tracked: true,
    },
    inventoryPolicy: "CONTINUE",
    inventoryQuantities: locationId
      ? [{ locationId, name: "available", quantity: 0 }]
      : undefined,
  });

  const productSet = {
    title: staged.title,
    descriptionHtml: staged.descriptionHtml || "",
    vendor: VENDOR_NAMES[staged.source] || staged.source,
    status: "DRAFT",
    tags: sanitizeTags(staged.tags),
  };

  if (staged.images?.length) {
    // Shopify fetches each URL server-side and hosts it on this store's own
    // CDN — the source's own image URLs (already public, from their own
    // Shopify/CDN) work directly as originalSource, no upload step needed.
    // Product-level only for now (first becomes the featured image); a
    // later pass could match each URL to its variant like the old
    // Ultra Vision Import Manager did, using image_id from the source data.
    productSet.files = staged.images.map((url) => ({
      originalSource: url,
      contentType: "IMAGE",
      alt: staged.title,
    }));
  }

  if (optionNames.length > 0) {
    // Build each option's distinct value list from the variants, in order.
    productSet.productOptions = optionNames.map((name, idx) => {
      const key = `option${idx + 1}`;
      const seen = new Set();
      const values = [];
      for (const v of variants) {
        const val = v[key];
        if (val && !seen.has(val)) {
          seen.add(val);
          values.push({ name: val });
        }
      }
      return { name, position: idx + 1, values };
    });

    productSet.variants = variants.map((v) => ({
      sku: v.sku || undefined,
      price: v.retailZar,
      optionValues: optionNames.map((name, idx) => ({
        optionName: name,
        name: v[`option${idx + 1}`],
      })),
      ...inventoryFieldsFor(v),
    }));
  } else {
    // No real options — Shopify still requires optionValues on every
    // variant (confirmed via schema: it's a non-null list, not optional),
    // even for a single default variant. Use Shopify's own default
    // option/value convention ("Title" / "Default Title") explicitly.
    // Use the edited product-level retail price if set, since that's what
    // the review table lets you override; fall back to the original
    // per-variant computed price otherwise.
    const v = variants[0] || {};
    productSet.productOptions = [{ name: "Title", position: 1, values: [{ name: "Default Title" }] }];
    productSet.variants = [
      {
        sku: v.sku || undefined,
        price: staged.retailZar ?? v.retailZar,
        optionValues: [{ optionName: "Title", name: "Default Title" }],
        ...inventoryFieldsFor({ costZar: staged.costZar ?? v.costZar }),
      },
    ];
  }

  const response = await admin.graphql(PRODUCT_SET_MUTATION, {
    variables: {
      productSet,
      synchronous: true,
      // When the staged product is already pushed (has its own
      // shopifyProductId) or matches an existing product by SKU,
      // pass that id so productSet updates it in place instead of
      // creating a duplicate. Omitted entirely (not just null) when
      // there's nothing to match — Shopify treats an explicit null
      // the same as "create new", but passing the variable at all
      // when undefined can trip strict validation, so build it
      // conditionally.
      ...(existingProductId ? { identifier: { id: existingProductId } } : {}),
    },
  });
  const body = await response.json();
  const result = body.data?.productSet;

  if (!result) {
    throw new Error(JSON.stringify(body.errors || body));
  }
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }

  const productId = result.product.id;

  // Publish to every sales channel — reported that channels weren't being
  // enabled at all (product created but not available anywhere). DRAFT
  // status already keeps it off storefronts regardless of publication, so
  // this is safe to do unconditionally; it just means every channel is
  // ready the moment the product is switched to Active.
  if (publicationIds.length > 0) {
    try {
      const pubResponse = await admin.graphql(PUBLISH_MUTATION, {
        variables: { id: productId, input: publicationIds.map((id) => ({ publicationId: id })) },
      });
      const pubBody = await pubResponse.json();
      const pubErrors = pubBody.data?.publishablePublish?.userErrors;
      if (pubErrors?.length) {
        console.error(`Publish-to-channels warning for ${productId}:`, pubErrors);
      }
    } catch (err) {
      // Non-fatal — the product itself pushed fine; a channel-publish
      // failure shouldn't be reported as the whole push failing.
      console.error(`Publish-to-channels failed for ${productId}:`, err);
    }
  }

  return productId;
}
