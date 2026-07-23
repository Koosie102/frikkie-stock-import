// Shared fetch logic for brands whose own storefront runs on Shopify
// (Bushdoof, ALTIQ). Their public /products.json endpoint gives full
// variant data with no auth needed — same pattern the original Bushdoof
// Node script used against Bushdoof's product.json endpoint.
//
// ALTIQ confirmed running on Shopify (9df15d-3.myshopify.com) — trade
// cost still comes from the ultradealer.com.au B2B portal manually,
// since that's password-protected and not scriptable.

const PAGE_SIZE = 250;

export async function fetchAllProducts(storeDomain) {
  const products = [];
  let page = 1;

  while (true) {
    const url = `https://${storeDomain}/products.json?limit=${PAGE_SIZE}&page=${page}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FrikkiesStockImporter/1.0)" },
    });

    if (!res.ok) {
      throw new Error(`${storeDomain} products.json failed: ${res.status}`);
    }

    const data = await res.json();
    if (!data.products || data.products.length === 0) break;

    products.push(...data.products);
    if (data.products.length < PAGE_SIZE) break;
    page += 1;
  }

  return products;
}

// Maps a raw Shopify products.json entry into our shared StagedProduct shape.
// costForeign is left null here — Bushdoof/ALTIQ costs come from a
// distributor pricelist or manual trade-portal export, matched in by SKU
// in a separate step (same as the original Bushdoof script's pricing pass).
export function mapShopifyProduct(product, sourceDomain) {
  const images = (product.images || []).map((img) => img.src);

  const variantsJson = product.variants.map((v) => ({
    sku: v.sku,
    title: v.title,
    priceForeign: parseFloat(v.price),
    option1: v.option1,
    option2: v.option2,
    option3: v.option3,
  }));

  return {
    sourceUrl: `https://${sourceDomain}/products/${product.handle}`,
    sku: product.variants?.[0]?.sku || null,
    title: product.title,
    descriptionHtml: product.body_html,
    images,
    variantsJson,
    tags: (product.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
  };
}
