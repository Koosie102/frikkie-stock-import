// Node port of the original STEDI Python scraper (scraper.py), ported
// faithfully rather than re-derived — same Cloudflare-safe headers, same
// verified SEED_CATEGORY_URLS from the live AU nav, same pagination and
// JSON-LD parsing logic, same gallery selector. Where the original had
// inline comments explaining a non-obvious choice (why this selector,
// why this fallback order), those are kept below for the same reason
// they were kept there.
import * as cheerio from "cheerio";

const BASE_URL = "https://www.stedi.com.au"; // confirmed: real AU storefront, Cloudflare-protected
const REQUEST_DELAY_MS = 600; // be polite, avoid getting rate-limited/blocked
const TIMEOUT_MS = 20000;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  // Cloudflare on stedi.com.au rejects requests without a fuller browser-like
  // header set (a bare User-Agent alone got a 403) — keep all of these.
};

// Top-level/category-ish landing pages, taken from the live AU nav
// (discovered by walking every .html link off the homepage in the
// original Python build). Some of these are product detail pages rather
// than true categories (the nav mixes both); harmless — getProductUrlsFromCategory()
// just finds 0 product tiles on those and moves on.
const SEED_CATEGORY_URLS = [
  "/4x4-driving-lights.html",
  "/4x4-driving-lights/boost-integrated-driving-lights.html",
  "/4x4-driving-lights/led-light-bars.html",
  "/4x4-driving-lights/led-light-bars/light-bar-accessories.html",
  "/4x4-driving-lights/led-light-bars/series/st1k-e-mark.html",
  "/4x4-driving-lights/led-light-bars/series/st2k.html",
  "/4x4-driving-lights/led-light-bars/series/st3303.html",
  "/4x4-driving-lights/led-light-bars/series/st3k.html",
  "/4x4-driving-lights/motorcycle-atv.html",
  "/4x4-driving-lights/quad-series.html",
  "/4x4-driving-lights/stedi-type-x-evo.html",
  "/4x4-driving-lights/type-x-pro.html",
  "/4x4-driving-lights/type-x-sport-series.html",
  "/4x4-driving-lights/type-xtm-pro-plus.html",
  "/driving-light-accessories/bull-bar-brackets.html",
  "/driving-light-accessories/led-accessories.html",
  "/driving-light-accessories/replacement-parts.html",
  "/driving-light-accessories/speciality-brackets.html",
  "/led-conversion-kits/7-inch-headlight-units.html",
  "/led-conversion-kits/exterior.html",
  "/led-conversion-kits/fog-light-kits.html",
  "/led-conversion-kits/h7-special-adaptors.html",
  "/led-conversion-kits/headlight-globes.html",
  "/led-conversion-kits/hid-bulbs.html",
  "/led-conversion-kits/led-assemblies.html",
  "/led-flash-lights.html",
  "/led-flash-lights/led-head-torches.html",
  "/led-flash-lights/led-torch-accessories.html",
  "/led-flash-lights/led-torches.html",
  "/led-work-lights/4wd-working-lights.html",
  "/led-work-lights/g-series-lights.html",
  "/led-work-lights/g-series-lights/g-series-light-accessories.html",
  "/led-work-lights/heavy-machinery.html",
  "/led-work-lights/led-rock-lights.html",
  "/led-work-lights/marine.html",
  "/led-work-lights/work-task-lights.html",
  "/merchandise.html",
  "/merchandise/clearance.html",
  "/merchandise/hoodies-jackets.html",
  "/merchandise/other-merchandise.html",
  "/merchandise/tees-shirts.html",
  "/rocker-switches.html",
  "/rocker-switches/amarok-switches.html",
  "/rocker-switches/carling-type-rocker.html",
  "/rocker-switches/d-max-colorado-2012.html",
  "/rocker-switches/ford-mazda-switches.html",
  "/rocker-switches/holden-switches.html",
  "/rocker-switches/mazda-switches.html",
  "/rocker-switches/mitsubishi.html",
  "/rocker-switches/nissan-switches.html",
  "/rocker-switches/suzuki-switches.html",
  "/rocker-switches/switch-fascia.html",
  "/rocker-switches/toyota-switches.html",
  "/wiring-electrical/driving-light-wiring-kits.html",
  "/wiring-electrical/electronic-accessories.html",
  "/wiring-electrical/vehicle-specific-piggy-back-adaptors.html",
  "/wiring-electrical/wiring-accessories.html",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function absoluteUrl(pathOrUrl) {
  return pathOrUrl.startsWith("http") ? pathOrUrl : new URL(pathOrUrl.replace(/^\//, ""), BASE_URL + "/").href;
}

async function fetchHtml(pathOrUrl, retried = false) {
  const url = absoluteUrl(pathOrUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const html = await res.text();
    await sleep(REQUEST_DELAY_MS);
    return { html, url };
  } catch (err) {
    if (!retried) {
      await sleep(2000); // brief pause before the one retry
      return fetchHtml(url, true);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- category discovery ----------

export async function discoverCategoryUrls() {
  const found = new Set(SEED_CATEGORY_URLS);
  try {
    const { html } = await fetchHtml("/");
    const $ = cheerio.load(html);
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (!href || href.startsWith("#")) return;
      let path;
      try {
        const parsed = new URL(href, BASE_URL);
        if (parsed.hostname !== new URL(BASE_URL).hostname) return; // off-site link
        path = parsed.pathname;
      } catch {
        return;
      }
      if (href.includes(".html") && !href.includes("/support/") && !href.includes("/blog/")) {
        found.add(path);
      }
    });
  } catch (err) {
    console.warn("STEDI homepage nav fetch failed, using seed list only:", err.message || err);
  }
  return [...found].sort();
}

// ---------- product URL collection ----------

// Walks pagination (?p=2, ?p=3, ...) on a category page, collecting every
// distinct product detail page URL linked from product tiles.
export async function getProductUrlsFromCategory(categoryUrl) {
  const productUrls = new Set();
  let page = 1;
  while (true) {
    const sep = categoryUrl.includes("?") ? "&" : "?";
    const pageUrl = page === 1 ? categoryUrl : `${categoryUrl}${sep}p=${page}`;
    let html;
    try {
      ({ html } = await fetchHtml(pageUrl));
    } catch (err) {
      console.warn(`STEDI: failed to fetch ${pageUrl}:`, err.message || err);
      break;
    }

    const $ = cheerio.load(html);
    const tiles = $("li.product-item a.product-item-link, .products-grid a.product-item-link");
    if (tiles.length === 0) break;

    const before = productUrls.size;
    tiles.each((_, el) => {
      const href = $(el).attr("href");
      if (href) productUrls.add(absoluteUrl(href));
    });

    // stop once a new page adds nothing new (covers "last page" case where
    // Magento just re-serves page 1 instead of 404ing)
    if (productUrls.size === before) break;
    page += 1;
    if (page > 50) break; // sanity guard
  }
  return productUrls;
}

// Same crawl, but tracks which category each product URL was found under
// (kept for a future tag-inference pass, even though nothing uses
// categoriesByUrl yet — matches the original's url_to_categories shape).
export async function getAllProductUrlsWithCategories(onCategoryDone) {
  const categories = await discoverCategoryUrls();
  const categoryUrlsAbsolute = new Set(categories.map((c) => absoluteUrl(c)));

  const urlToCategories = new Map();
  for (const cat of categories) {
    const urls = await getProductUrlsFromCategory(cat);
    for (const url of urls) {
      if (!urlToCategories.has(url)) urlToCategories.set(url, []);
      urlToCategories.get(url).push(cat);
    }
    if (onCategoryDone) onCategoryDone(cat, urls.size, urlToCategories.size);
  }

  // Some category pages link out to other category/series pages using the
  // same tile markup as products (confirmed: light-bar "series" landing
  // pages were getting swept in this way) — strip anything that's
  // actually one of our known category URLs before returning.
  for (const catUrl of categoryUrlsAbsolute) {
    urlToCategories.delete(catUrl);
  }

  return { urlToCategories, categories };
}

// ---------- product page parsing ----------

export async function parseProduct(productUrl) {
  const { html, url: finalUrl } = await fetchHtml(productUrl);
  const $ = cheerio.load(html);

  const product = {
    url: finalUrl,
    title: null,
    sku: null,
    priceAud: null,
    descriptionHtml: null,
    images: [],
    isGrouped: false,
    groupChildren: [],
  };

  // Magento often embeds schema.org Product JSON-LD — far more reliable
  // than scraping rendered HTML classes, use it when present.
  let sawJsonLd = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try {
      data = JSON.parse($(el).contents().text() || "{}");
    } catch {
      return;
    }
    const candidates = Array.isArray(data) ? data : [data];
    for (const d of candidates) {
      if (!d || typeof d !== "object" || d["@type"] !== "Product") continue;
      sawJsonLd = true;
      product.title = d.name || product.title;
      product.sku = d.sku || product.sku;
      if (d.description) product.descriptionHtml = d.description;

      const offers = d.offers;
      if (offers && typeof offers === "object" && offers["@type"] === "AggregateOffer") {
        // Grouped product (Magento "grouped" type) — e.g. a "Modern
        // Accessories" kit where each option (bezel, fascia colour, cover
        // style, etc.) is a genuinely separate product with its own
        // SKU/price/image, all listed in offers.offers. Use lowPrice as
        // the headline priceAud (for display/sort), and keep the full
        // per-child list for variant building.
        product.isGrouped = true;
        product.priceAud = offers.lowPrice;
        for (const child of offers.offers || []) {
          if (!child || typeof child !== "object") continue;
          product.groupChildren.push({
            name: (child.name || "").trim(),
            sku: child.sku,
            priceAud: child.price,
            image: child.image,
          });
        }
      } else if (offers && typeof offers === "object") {
        product.priceAud = offers.price;
      } else if (Array.isArray(offers) && offers.length) {
        product.priceAud = offers[0]?.price;
      }

      const img = d.image;
      if (typeof img === "string") product.images.push(img);
      else if (Array.isArray(img)) product.images.push(...img);
    }
  });

  // Fallbacks from rendered HTML if JSON-LD was missing/incomplete
  if (!product.title) {
    const h1 = $("h1.page-title, h1.product-name, h1").first();
    if (h1.length) product.title = h1.text().trim();
  }

  if (!product.priceAud) {
    const priceEl = $(".product-info-price .price, span.price").first();
    if (priceEl.length) {
      const m = priceEl.text().match(/[\d,]+\.?\d*/);
      if (m) product.priceAud = m[0].replace(/,/g, "");
    }
  }

  if (!product.sku) {
    const skuEl = $(".product.attribute.sku .value").first();
    if (skuEl.length) product.sku = skuEl.text().trim();
  }

  const descEl = $("#description .value, .product.attribute.description .value").first();
  if (descEl.length) {
    // Prefer real HTML from the page over JSON-LD's plain text, when available
    product.descriptionHtml = $.html(descEl);
  } else if (product.descriptionHtml && !product.descriptionHtml.includes("<")) {
    // JSON-LD gave us plain text with \r\n breaks — wrap it into paragraphs
    // so it renders properly rather than running together on Shopify
    const paragraphs = product.descriptionHtml.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
    product.descriptionHtml = paragraphs.map((p) => `<p>${p}</p>`).join("");
  }

  // Real gallery lives in div.product-view-gallery (class="lazyload" on
  // each <img>) — confirmed by inspecting the live markup. Broad class
  // guesses (fotorama__img etc.) don't match this theme and also risk
  // picking up mobile-crop duplicates or "related products" thumbnails
  // further down the page, so scope tightly to this container.
  const galleryImages = [];
  $("div.product-view-gallery img.lazyload").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-image");
    if (src) galleryImages.push(absoluteUrl(src));
  });
  for (const src of galleryImages) {
    if (!product.images.includes(src)) product.images.push(src);
  }

  // A real product page has JSON-LD Product schema, or at minimum a SKU or
  // images. Category/series landing pages that get mistakenly swept up as
  // "products" (via mistyled tile links elsewhere on the site) fail all
  // three — this catches those regardless of where they're linked from,
  // which a URL blocklist can't guarantee.
  product.isRealProduct = Boolean(sawJsonLd || product.sku || product.images.length);

  return product;
}
