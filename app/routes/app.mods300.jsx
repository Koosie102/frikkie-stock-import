import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  IndexTable,
  useIndexResourceState,
  Badge,
  TextField,
  Tabs,
  Link,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { fetchAllProducts, mapShopifyProduct } from "../adapters/shopifySource.server";
import { pushStagedProduct, getPushChannelInfo } from "../adapters/shopifyPush.server";
import { bulkSyncPrices } from "../adapters/bulkPriceSync.server";
import { matchSkusToShopify, syncVariantPrice, fetchVendorProducts, fuzzyMatchTitles, checkProductsExist } from "../adapters/shopifyMatch.server";
import { summarizeVendorTags } from "../adapters/shopifyTaxonomy.server";
import { VENDOR_NAMES } from "../adapters/shopifyPush.server";
import { productIdToAdminPath } from "../utils/shopify";
import { buildStagedQuery } from "../utils/stagedQuery.server";
import { upsertStagedProducts } from "../utils/stagedUpsert.server";
import { recalculateStagedPrices } from "../utils/recalcPricing.server";
import { getSourceSettings, saveSourceSettings } from "../utils/sourceSettings.server";

const MODS300_DOMAIN = "www.300mods.com.au";
const MODS300_BRAND = "300mods";

// Editable via the Pricing formula card below — persisted in
// SourceSettings, these are just the fallback if nothing's been saved yet.
// Same round-up-to-R99 shape as TrailBait/Bushdoof/STEDI: retail = AUD
// price x multiplier, rounded up to the nearest R99; cost = retail x
// costRatio.
const DEFAULT_SETTINGS = { retailMultiplier: 24.5, costRatio: 0.6 };

function mods300Pricing(priceForeign, settings) {
  const raw = priceForeign * settings.retailMultiplier;
  const retailZar = Math.ceil((raw + 1) / 100) * 100 - 1;
  const costZar = Math.round(retailZar * settings.costRatio * 100) / 100;
  return { retailZar, costZar, priceIsEstimated: true };
}

// 300mods runs Shopify Markets (multi-currency — confirmed via its own
// country/currency selector, unlike ALTIQ/TrailBait/Bushdoof). Shopify's
// public products.json can reflect the requester's *presentment*
// currency rather than the store's AUD base currency on Markets-enabled
// stores, and there's no reliable public param to force a currency on
// that endpoint. Rather than assume Railway's server happens to get
// geo-mapped to AUD, this checks one specific product's price against a
// real AUD figure confirmed directly from the live site
// (300mods.com.au/products/toyota-landcruiser-300-series-12-pin-trailer-plug-loom-kit-for-towing
// — "From $185.00 AUD" at the time this was built) before trusting any
// of the fetched prices. A wide tolerance allows for real price changes
// over time while still catching a currency mismatch (which would be off
// by a very different, non-coincidental margin — e.g. ~35% low for USD,
// ~30% low for EUR).
const CURRENCY_CHECK_HANDLE = "toyota-landcruiser-300-series-12-pin-trailer-plug-loom-kit-for-towing";
const CURRENCY_CHECK_EXPECTED_AUD = 185;
const CURRENCY_CHECK_TOLERANCE = 0.2; // ±20% — tight enough to catch a currency mismatch (AUD→USD/EUR conversion typically differs 30-40%), loose enough to allow a real, modest price change since this was written

function checkCurrencyLooksRight(products) {
  const referenceProduct = products.find((p) => p.handle === CURRENCY_CHECK_HANDLE);
  if (!referenceProduct) {
    // Product may have been renamed/removed since this was built — not
    // itself a currency problem, but means this specific safeguard can't
    // run. Flagged in the fetch result rather than silently skipped.
    return { checked: false };
  }
  const price = parseFloat(referenceProduct.variants?.[0]?.price);
  if (Number.isNaN(price)) return { checked: false };
  const lowerBound = CURRENCY_CHECK_EXPECTED_AUD * (1 - CURRENCY_CHECK_TOLERANCE);
  const upperBound = CURRENCY_CHECK_EXPECTED_AUD * (1 + CURRENCY_CHECK_TOLERANCE);
  const withinRange = price >= lowerBound && price <= upperBound;
  return { checked: true, ok: withinRange, observedPrice: price };
}

const TABS = [
  { id: "all", label: "All", filter: {} },
  { id: "new", label: "New", filter: { status: { in: ["NEW", "NEEDS_REVIEW"] } } },
  { id: "pushed", label: "Pushed", filter: { status: "PUSHED" } },
];

// Column order shared by headings/sortable/onSort below — index-aligned.
const SORT_FIELDS = ["title", "sku", null, null, "costZar", "retailZar", null, null];

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const { where, orderBy, tabId, q, sortField, sortDir } = buildStagedQuery("MODS300", url, TABS);

  const staged = await db.stagedProduct.findMany({ where, orderBy, take: 150 });

  const counts = await db.stagedProduct.groupBy({
    by: ["status"],
    where: { source: "MODS300" },
    _count: true,
  });
  const pushedCount = counts.find((c) => c.status === "PUSHED")?._count || 0;
  const totalCount = counts.reduce((sum, c) => sum + c._count, 0);

  const skus = staged.map((p) => p.sku).filter(Boolean);
  const shopifyMatches = await matchSkusToShopify(admin, skus);
  const settings = await getSourceSettings(db, "MODS300", DEFAULT_SETTINGS);

  // Only worth the extra Shopify calls if there's something unmatched to
  // resolve — a fuzzy pass and a vendor-wide product/tag fetch are wasted
  // work on a fully-matched or empty page.
  const unmatched = staged.filter((p) => (!p.sku || !shopifyMatches[p.sku]) && !p.matchDeclined);
  let fuzzyMatches = {};
  let vendorTags = [];
  if (unmatched.length > 0) {
    const vendorProducts = await fetchVendorProducts(admin, VENDOR_NAMES.MODS300);
    fuzzyMatches = fuzzyMatchTitles(unmatched.map((p) => ({ id: p.id, title: p.title })), vendorProducts);
    vendorTags = summarizeVendorTags(vendorProducts);
  }

  return {
    staged, pushedCount, totalCount, tabId, q, sortField, sortDir,
    shopDomain: session.shop, shopifyMatches, fuzzyMatches, vendorTags, settings,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "fetch") {
    const settings = await getSourceSettings(db, "MODS300", DEFAULT_SETTINGS);
    const run = await db.importRun.create({ data: { source: "MODS300", status: "running" } });
    try {
      const products = await fetchAllProducts(MODS300_DOMAIN);

      // Fail loudly on a currency mismatch (see checkCurrencyLooksRight
      // comment above) rather than silently stage a whole catalog's worth
      // of wrong prices — this is the one thing that could go wrong here
      // in a way that isn't visibly obvious afterward.
      const currencyCheck = checkCurrencyLooksRight(products);
      if (currencyCheck.checked && !currencyCheck.ok) {
        throw new Error(
          `Currency check failed: expected the reference product's price to be roughly $${CURRENCY_CHECK_EXPECTED_AUD} AUD, ` +
            `but the fetched price was ${currencyCheck.observedPrice} — this looks like products.json returned a different ` +
            `currency than AUD (Shopify Markets can do this based on server location), not a real price change. Fix this before trusting any prices from this fetch.`,
        );
      }

      const mapped = products.map((p) =>
        mapShopifyProduct(p, MODS300_DOMAIN, undefined, (price) => mods300Pricing(price, settings), MODS300_BRAND),
      );
      const { created, updated } = await upsertStagedProducts(db, run.id, "MODS300", mapped);
      await db.importRun.update({
        where: { id: run.id },
        data: { status: "done", totalFound: products.length, totalDone: products.length, finishedAt: new Date() },
      });
      return {
        ok: true,
        mode: "fetch",
        created,
        updated,
        currencyChecked: currencyCheck.checked,
      };
    } catch (err) {
      console.error("300mods import failed:", err);
      await db.importRun.update({
        where: { id: run.id },
        data: { status: "failed", errorLog: String(err), finishedAt: new Date() },
      });
      return { ok: false, mode: "fetch", error: String(err) };
    }
  }

  if (intent === "acceptMatch") {
    const id = formData.get("id");
    const productId = formData.get("productId");
    const matchedSku = formData.get("sku") || null;
    if (matchedSku) {
      // Aligning our sku to the real one is enough — it becomes a normal
      // SKU match from here on (shows "already in store", price-syncs,
      // and pushes update-in-place), same as any other matched product.
      await db.stagedProduct.update({ where: { id }, data: { sku: matchedSku } });
    } else {
      // Rare case: the matched product itself has no SKU to align on —
      // link directly by product id instead so it's still treated as
      // matched rather than pushed as a duplicate.
      await db.stagedProduct.update({ where: { id }, data: { shopifyProductId: productId, status: "PUSHED" } });
    }
    return { ok: true, mode: "acceptMatch", id };
  }

  if (intent === "declineMatch") {
    const id = formData.get("id");
    await db.stagedProduct.update({ where: { id }, data: { matchDeclined: true } });
    return { ok: true, mode: "declineMatch", id };
  }

  if (intent === "updatePrice") {
    const id = formData.get("id");
    const retailZar = formData.get("retailZar");
    const costZar = formData.get("costZar");
    await db.stagedProduct.update({
      where: { id },
      data: {
        retailZar: retailZar === "" ? null : parseFloat(retailZar),
        costZar: costZar === "" ? null : parseFloat(costZar),
      },
    });
    return { ok: true, mode: "updatePrice" };
  }

  if (intent === "updateSettings") {
    const retailMultiplier = parseFloat(formData.get("retailMultiplier"));
    const costRatio = parseFloat(formData.get("costRatio"));
    if (Number.isNaN(retailMultiplier) || retailMultiplier <= 0) {
      return { ok: false, mode: "updateSettings", error: "Retail multiplier must be a positive number." };
    }
    if (Number.isNaN(costRatio) || costRatio <= 0 || costRatio > 1) {
      return { ok: false, mode: "updateSettings", error: "Cost ratio must be a number between 0 and 1 (e.g. 0.6 for 60%)." };
    }
    await saveSourceSettings(db, "MODS300", { retailMultiplier, costRatio });
    const updated = await recalculateStagedPrices(db, "MODS300", (price) =>
      mods300Pricing(price, { retailMultiplier, costRatio }),
    );
    return { ok: true, mode: "updateSettings", updated };
  }

  if (intent === "syncPrice") {
    const id = formData.get("id");
    const staged = await db.stagedProduct.findUnique({ where: { id } });
    if (!staged?.sku) {
      return { ok: false, mode: "syncPrice", id, error: "No SKU to match against." };
    }
    const matches = await matchSkusToShopify(admin, [staged.sku]);
    const match = matches[staged.sku];
    if (!match) {
      return { ok: false, mode: "syncPrice", id, error: "No matching Shopify product found." };
    }
    try {
      await syncVariantPrice(admin, match.productId, match.variantId, staged.retailZar);
      return { ok: true, mode: "syncPrice", id };
    } catch (err) {
      return { ok: false, mode: "syncPrice", id, error: String(err.message || err) };
    }
  }

  if (intent === "updateAllPrices") {
    try {
      const result = await bulkSyncPrices(admin, db, "MODS300");
      return { ok: result.errors.length === 0, mode: "updateAllPrices", ...result };
    } catch (err) {
      return { ok: false, mode: "updateAllPrices", checked: 0, updated: 0, errors: [String(err.message || err)] };
    }
  }

  if (intent === "syncWithShopify") {
    const pushedItems = await db.stagedProduct.findMany({
      where: { source: "MODS300", status: "PUSHED", shopifyProductId: { not: null } },
      select: { id: true, shopifyProductId: true },
    });
    const existingIds = await checkProductsExist(admin, pushedItems.map((p) => p.shopifyProductId));
    const missing = pushedItems.filter((p) => !existingIds.has(p.shopifyProductId));
    if (missing.length > 0) {
      await db.stagedProduct.updateMany({
        where: { id: { in: missing.map((p) => p.id) } },
        data: { status: "NEEDS_REVIEW", shopifyProductId: null },
      });
    }
    return { ok: true, mode: "syncWithShopify", checked: pushedItems.length, reset: missing.length };
  }

  if (intent === "push") {
    const ids = formData.getAll("ids");
    const stagedList = await db.stagedProduct.findMany({ where: { id: { in: ids } } });
    // Batch-match all selected SKUs once, so a product already in the
    // store (pushed via this app before, or listed some other way) gets
    // updated in place instead of creating a duplicate.
    const skus = stagedList.map((s) => s.sku).filter(Boolean);
    const matches = await matchSkusToShopify(admin, skus);
    const channelInfo = await getPushChannelInfo(admin);

    let pushed = 0;
    const errors = [];
    for (const staged of stagedList) {
      const existingProductId = staged.shopifyProductId || matches[staged.sku]?.productId;
      try {
        const shopifyProductId = await pushStagedProduct(admin, staged, existingProductId, channelInfo);
        await db.stagedProduct.update({ where: { id: staged.id }, data: { status: "PUSHED", shopifyProductId } });
        pushed += 1;
      } catch (err) {
        console.error(`300mods push failed for ${staged.title}:`, err);
        errors.push(`${staged.title}: ${String(err.message || err)}`);
      }
    }
    return { ok: errors.length === 0, mode: "push", pushed, errors };
  }

  return null;
};

const zar = (n) =>
  n == null ? "—" : `R${Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const aud = (n) => (n == null ? "—" : `$${Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function PriceCell({ id, label, value, field, saveFetcher }) {
  const [local, setLocal] = useState(value ?? "");
  useEffect(() => setLocal(value ?? ""), [value]);

  return (
    <div style={{ minWidth: 110 }}>
      <TextField
        label={label}
        labelHidden
        type="number"
        value={String(local)}
        onChange={setLocal}
        onBlur={() => {
          if (String(local) !== String(value ?? "")) {
            saveFetcher.submit(
              { intent: "updatePrice", id, [field]: local },
              { method: "post" },
            );
          }
        }}
        autoComplete="off"
        prefix="R"
      />
    </div>
  );
}

function ShopifyMatchCell({ staged, match, fuzzyMatch, shopDomain }) {
  const syncFetcher = useFetcher();
  const syncing = syncFetcher.state !== "idle";
  const syncResult = syncFetcher.data;
  const acceptFetcher = useFetcher();
  const declineFetcher = useFetcher();
  const accepting = acceptFetcher.state !== "idle";
  const declining = declineFetcher.state !== "idle";

  if (match) {
    const priceDiffers = staged.retailZar != null && Math.round(match.price) !== Math.round(staged.retailZar);
    return (
      <BlockStack gap="100">
        <Link url={`https://${shopDomain}${productIdToAdminPath(match.productId)}`} target="_blank">
          {`${zar(match.price)} (${match.status})`}
        </Link>
        {priceDiffers && (
          <syncFetcher.Form method="post">
            <input type="hidden" name="intent" value="syncPrice" />
            <input type="hidden" name="id" value={staged.id} />
            <Button submit size="micro" loading={syncing}>
              {`Sync to ${zar(staged.retailZar)}`}
            </Button>
          </syncFetcher.Form>
        )}
        {syncResult?.mode === "syncPrice" && syncResult.id === staged.id && syncResult.ok === false && (
          <Text as="span" tone="critical">{syncResult.error}</Text>
        )}
      </BlockStack>
    );
  }

  if (fuzzyMatch) {
    return (
      <BlockStack gap="100">
        <Badge tone="warning">{`Possible match (${Math.round(fuzzyMatch.score * 100)}%)`}</Badge>
        <Link url={`https://${shopDomain}${productIdToAdminPath(fuzzyMatch.productId)}`} target="_blank">
          {fuzzyMatch.productTitle}
        </Link>
        <InlineStack gap="100">
          <acceptFetcher.Form method="post">
            <input type="hidden" name="intent" value="acceptMatch" />
            <input type="hidden" name="id" value={staged.id} />
            <input type="hidden" name="productId" value={fuzzyMatch.productId} />
            <input type="hidden" name="sku" value={fuzzyMatch.sku || ""} />
            <Button submit size="micro" loading={accepting}>Accept</Button>
          </acceptFetcher.Form>
          <declineFetcher.Form method="post">
            <input type="hidden" name="intent" value="declineMatch" />
            <input type="hidden" name="id" value={staged.id} />
            <Button submit size="micro" loading={declining}>Decline</Button>
          </declineFetcher.Form>
        </InlineStack>
      </BlockStack>
    );
  }

  return <Text as="span" tone="subdued">Not in store</Text>;
}

function PricingFormulaCard({ settings }) {
  const settingsFetcher = useFetcher();
  const saving = settingsFetcher.state !== "idle";
  const result = settingsFetcher.data;
  const [retailMultiplier, setRetailMultiplier] = useState(String(settings.retailMultiplier));
  const [costRatio, setCostRatio] = useState(String(settings.costRatio));

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Pricing formula</Text>
        <Text as="p" tone="subdued">
          Retail (ZAR) = AUD price × multiplier, rounded up to the nearest
          R99. Cost (ZAR) = Retail × cost ratio. Saving recalculates every staged product's price with the new
          formula, including ones already pushed to Shopify — this
          only updates the number shown here, it never touches
          Shopify directly. Already-pushed products will then show
          a Sync button (or use "Update all prices" for all of
          them at once) if the new price differs from what's live.
        </Text>
        {result?.mode === "updateSettings" && result.ok === false && (
          <Banner tone="critical">{result.error}</Banner>
        )}
        {result?.mode === "updateSettings" && result.ok === true && (
          <Banner tone="success">{`Saved. Recalculated ${result.updated} product(s) — including already-pushed ones, so the price-differs-from-live indicator will show where Shopify needs updating.`}</Banner>
        )}
        <settingsFetcher.Form method="post">
          <input type="hidden" name="intent" value="updateSettings" />
          <InlineStack gap="200" blockAlign="end">
            <div style={{ maxWidth: 200 }}>
              <TextField
                label="Retail multiplier"
                type="number"
                step="0.1"
                name="retailMultiplier"
                value={retailMultiplier}
                onChange={setRetailMultiplier}
                autoComplete="off"
              />
            </div>
            <div style={{ maxWidth: 200 }}>
              <TextField
                label="Cost as ratio of retail"
                helpText="e.g. 0.6 = 60%"
                type="number"
                step="0.01"
                name="costRatio"
                value={costRatio}
                onChange={setCostRatio}
                autoComplete="off"
              />
            </div>
            <Button submit loading={saving} variant="primary">Save</Button>
          </InlineStack>
        </settingsFetcher.Form>
      </BlockStack>
    </Card>
  );
}

function ShopifyTagsCard({ vendorTags }) {
  if (!vendorTags.length) return null;
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Existing Shopify tags for 300mods</Text>
        <Text as="p" tone="subdued">
          Tags already used on 300mods products in your store, most-used
          first — reference for keeping newly imported tags consistent
          with your existing collections/taxonomy rather than creating
          near-duplicates.
        </Text>
        <InlineStack gap="150">
          {vendorTags.slice(0, 40).map(({ tag, count }) => (
            <Badge key={tag}>{`${tag} (${count})`}</Badge>
          ))}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function Mods300Source() {
  const { staged, pushedCount, totalCount, tabId, q, sortField, sortDir, shopDomain, shopifyMatches, fuzzyMatches, vendorTags, settings } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetchFetcher = useFetcher();
  const pushFetcher = useFetcher();
  const priceFetcher = useFetcher();
  const syncFetcher = useFetcher();
  const updateAllFetcher = useFetcher();
  const fetching = fetchFetcher.state !== "idle";
  const pushing = pushFetcher.state !== "idle";
  const syncing = syncFetcher.state !== "idle";
  const updatingAll = updateAllFetcher.state !== "idle";
  const fetchResult = fetchFetcher.data;
  const pushResult = pushFetcher.data;
  const syncResult = syncFetcher.data;
  const updateAllResult = updateAllFetcher.data;

  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => setSearchInput(q), [q]);

  const resourceName = { singular: "product", plural: "products" };
  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(staged);

  const selectedTabIndex = TABS.findIndex((t) => t.id === tabId);

  function updateParams(mutate) {
    const params = new URLSearchParams(searchParams);
    mutate(params);
    setSearchParams(params);
  }

  function runSearch(e) {
    e.preventDefault();
    updateParams((params) => {
      if (searchInput) params.set("q", searchInput);
      else params.delete("q");
    });
  }

  function handleSort(headingIndex, direction) {
    const field = SORT_FIELDS[headingIndex];
    if (!field) return;
    updateParams((params) => {
      params.set("sort", field);
      params.set("dir", direction === "ascending" ? "asc" : "desc");
    });
  }

  const sortColumnIndex = sortField ? SORT_FIELDS.indexOf(sortField) : undefined;
  const sortDirection = sortDir === "asc" ? "ascending" : "descending";

  return (
    <Page title="300mods Import">
      <BlockStack gap="400">
        <Banner tone="info">
          Pulls the live 300mods catalog from www.300mods.com.au/products.json
          and formats titles as "300mods Title Cased Rest". Pushed products
          use vendor "4x4 Factory Products" (matching your 2 existing
          300mods listings, so they're recognized as the same products
          rather than duplicates) rather than "300mods" itself. Re-fetching
          updates existing staged products (title/images/description/tags)
          instead of duplicating them — it won't touch prices you've
          already edited or revert anything already pushed. Pushed products
          bring their description and images across automatically and land
          as Drafts, so nothing goes live without review. 300mods runs
          multi-currency (Shopify Markets) — every fetch checks one
          reference product's price against a known AUD value first, and
          fails loudly rather than staging anything if that check doesn't
          look right, since a currency mismatch would otherwise produce
          wrong prices with no obvious sign anything was off.
        </Banner>

        {fetchResult?.mode === "fetch" && fetchResult.ok === false && (
          <Banner tone="critical" title="Fetch failed">{fetchResult.error}</Banner>
        )}
        {fetchResult?.mode === "fetch" && fetchResult.ok === true && (
          <Banner tone="success" title="Fetch complete">
            {`${fetchResult.created} new, ${fetchResult.updated} updated.`}
            {fetchResult.currencyChecked ? " Currency check passed." : " (Currency check couldn't run — reference product not found; prices are unverified this time.)"}
          </Banner>
        )}
        {pushResult?.mode === "push" && (
          <Banner tone={pushResult.ok ? "success" : "warning"} title="Push finished">
            <BlockStack gap="100">
              <Text as="p">{`Pushed ${pushResult.pushed} product(s) to Shopify as drafts.`}</Text>
              {pushResult.errors?.map((e, i) => (
                <Text as="p" tone="critical" key={i}>{e}</Text>
              ))}
            </BlockStack>
          </Banner>
        )}

        {syncResult?.mode === "syncWithShopify" && (
          <Banner tone="success" title="Synced with Shopify">
            {syncResult.reset > 0
              ? `Checked ${syncResult.checked} pushed product(s) — ${syncResult.reset} no longer exist in Shopify and were reset to Needs Review.`
              : `Checked ${syncResult.checked} pushed product(s) — all still exist in Shopify.`}
          </Banner>
        )}

        {updateAllResult?.mode === "updateAllPrices" && (
          <Banner tone={updateAllResult.ok ? "success" : "warning"} title="Prices updated">
            <BlockStack gap="100">
              <Text as="p">
                {`Checked ${updateAllResult.checked} matched product(s) — ${updateAllResult.updated} price(s) updated on Shopify.`}
              </Text>
              {updateAllResult.errors?.map((e, i) => (
                <Text as="p" tone="critical" key={i}>{e}</Text>
              ))}
            </BlockStack>
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">Fetch catalog</Text>
              <InlineStack gap="200">
                <syncFetcher.Form method="post">
                  <input type="hidden" name="intent" value="syncWithShopify" />
                  <Button submit loading={syncing}>Sync with Shopify</Button>
                </syncFetcher.Form>
                <updateAllFetcher.Form method="post">
                  <input type="hidden" name="intent" value="updateAllPrices" />
                  <Button submit loading={updatingAll}>Update all prices</Button>
                </updateAllFetcher.Form>
                <Button url={`/app/export/MODS300?tab=${tabId}${q ? `&q=${encodeURIComponent(q)}` : ""}`} external>
                  Export CSV
                </Button>
                <fetchFetcher.Form method="post">
                  <input type="hidden" name="intent" value="fetch" />
                  <Button submit loading={fetching} variant="primary">
                    {fetching ? "Fetching…" : "Fetch 300mods products"}
                  </Button>
                </fetchFetcher.Form>
              </InlineStack>
            </InlineStack>
            <Text as="p" tone="subdued">
              {`${totalCount} total staged, ${pushedCount} already pushed`}
            </Text>
          </BlockStack>
        </Card>

        <PricingFormulaCard settings={settings} />

        <ShopifyTagsCard vendorTags={vendorTags} />

        <Card padding="0">
          <Tabs
            tabs={TABS.map((t) => ({ id: t.id, content: t.label }))}
            selected={selectedTabIndex === -1 ? 0 : selectedTabIndex}
            onSelect={(index) => updateParams((params) => params.set("tab", TABS[index].id))}
          />
          <div style={{ padding: "12px 16px 0" }}>
            <form onSubmit={runSearch}>
              <InlineStack gap="200" blockAlign="end">
                <div style={{ minWidth: 260 }}>
                  <TextField
                    label="Search by title or SKU"
                    labelHidden
                    placeholder="Search by title or SKU"
                    value={searchInput}
                    onChange={setSearchInput}
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => {
                      setSearchInput("");
                      updateParams((params) => params.delete("q"));
                    }}
                  />
                </div>
                <Button submit>Search</Button>
              </InlineStack>
            </form>
          </div>
          <pushFetcher.Form method="post">
            <input type="hidden" name="intent" value="push" />
            {selectedResources.map((id) => (
              <input key={id} type="hidden" name="ids" value={id} />
            ))}
            <div style={{ padding: "16px" }}>
              <Button submit disabled={selectedResources.length === 0} loading={pushing}>
                {`Push ${selectedResources.length || ""} selected to Shopify`}
              </Button>
            </div>
            <IndexTable
              resourceName={resourceName}
              itemCount={staged.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              sortable={[true, true, false, false, true, true, false, false]}
              sortColumnIndex={sortColumnIndex === -1 ? undefined : sortColumnIndex}
              sortDirection={sortField ? sortDirection : undefined}
              onSort={handleSort}
              headings={[
                { title: "Title" },
                { title: "SKU" },
                { title: "Price (AUD)" },
                { title: "Variants" },
                { title: "Cost (ZAR)" },
                { title: "Retail (ZAR)" },
                { title: "Status" },
                { title: "In Shopify" },
              ]}
            >
              {staged.map((p, index) => {
                const variantCount = p.variantsJson?.variants?.length || 0;
                const sourcePrice = p.variantsJson?.variants?.[0]?.priceForeign;
                const match = p.sku ? shopifyMatches[p.sku] : null;
                const sourceHref = p.status === "PUSHED"
                  ? `https://${shopDomain}${productIdToAdminPath(p.shopifyProductId) || ""}`
                  : p.sourceUrl;

                return (
                  <IndexTable.Row id={p.id} key={p.id} selected={selectedResources.includes(p.id)} position={index}>
                    <IndexTable.Cell>
                      <Link url={sourceHref} target="_blank" removeUnderline>
                        {p.title}
                      </Link>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{p.sku || "—"}</IndexTable.Cell>
                    <IndexTable.Cell>{aud(sourcePrice)}</IndexTable.Cell>
                    <IndexTable.Cell>{variantCount || 1}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <PriceCell id={p.id} label="Cost" value={p.costZar} field="costZar" saveFetcher={priceFetcher} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <PriceCell id={p.id} label="Retail" value={p.retailZar} field="retailZar" saveFetcher={priceFetcher} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={p.status === "PUSHED" ? "success" : undefined}>{p.status}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <ShopifyMatchCell staged={p} match={match} fuzzyMatch={fuzzyMatches[p.id]} shopDomain={shopDomain} />
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          </pushFetcher.Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
