// Pushes a single StagedProduct to Shopify using the productSet mutation
// (single call handles options + variants + price/sku together).
// Lands as DRAFT so nothing goes live until reviewed in the store admin.

const PRODUCT_SET_MUTATION = `#graphql
  mutation CreateStagedProduct($productSet: ProductSetInput!, $synchronous: Boolean!) {
    productSet(synchronous: $synchronous, input: $productSet) {
      product { id }
      userErrors { field message }
    }
  }
`;

// Maps a Source enum value to the vendor name that should land on the
// Shopify product. Was hardcoded to "ALTIQ" previously, which silently
// mislabeled every other source's pushed products — caught while adding
// TrailBait as a 5th source.
const VENDOR_NAMES = {
  STEDI: "STEDI",
  BUSHDOOF: "Bushdoof",
  ULTRA_VISION: "Ultra Vision",
  ALTIQ: "ALTIQ",
  TRAILBAIT: "TrailBait",
};

export async function pushStagedProduct(admin, staged) {
  const { optionNames = [], variants = [] } = staged.variantsJson || {};

  const productSet = {
    title: staged.title,
    descriptionHtml: staged.descriptionHtml || "",
    vendor: VENDOR_NAMES[staged.source] || staged.source,
    status: "DRAFT",
    tags: staged.tags || [],
  };

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
    }));
  } else {
    // No real options — single default variant, no optionValues needed.
    // Use the edited product-level retail price if set, since that's what
    // the review table lets you override; fall back to the original
    // per-variant computed price otherwise.
    const v = variants[0] || {};
    productSet.variants = [
      {
        sku: v.sku || undefined,
        price: staged.retailZar ?? v.retailZar,
      },
    ];
  }

  const response = await admin.graphql(PRODUCT_SET_MUTATION, {
    variables: { productSet, synchronous: true },
  });
  const body = await response.json();
  const result = body.data?.productSet;

  if (!result) {
    throw new Error(JSON.stringify(body.errors || body));
  }
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }

  return result.product.id;
}
