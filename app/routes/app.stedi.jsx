import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useSearchParams, useRevalidator } from "@remix-run/react";
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
  ProgressBar,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getAllProductUrlsWithCategories, parseProduct } from "../adapters/stediScraper.server";
import { mapStediProduct } from "../adapters/stediMap.server";
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

const STEDI_BRAND = "STEDI";
const STEDI_LOGO = "https://www.stedi.com.au/media/logo/stores/1/STEDI_HORIZONTAL_LOGO_WHITE.png";

// Editable via the Pricing formula card below. Same formula as TrailBait:
// retail = AUD price x sourceMultiplier, rounded up to nearest R99;
// cost = retail x costRatio.
const DEFAULT_SETTINGS = { sourceMultiplier: 24, costRatio: 0.6 };

function stediPricing(priceForeign, settings) {
  const raw = priceForeign * settings.sourceMultiplier;
  const retailZar = Math.ceil((raw + 1) / 100) * 100 - 1;
  const costZar = Math.round(retailZar * settings.costRatio * 100) / 100;
  return { retailZar, costZar, priceIsEstimated: true };
}

const TABS = [
  { id: "all", label: "All", filter: {} },
  { id: "new", label: "New", filter: { status: { in: ["NEW", "NEEDS_REVIEW"] } } },
  { id: "pushed", label: "Pushed", filter: { status: "PUSHED" } },
];

const SORT_FIELDS = ["title", "sku", null, null, "costZar", "retailZar", null, null];

// Runs the full scrape in the background — NOT awaited by the action, so
// the request returns immediately instead of blocking for the ~10-15
// minutes a full ~50-category, ~800-product crawl takes at the scraper's
// deliberately polite 600ms-between-requests rate. This only works
// because Railway runs this as a persistent Node process, not a
// short-lived serverless function — the crawl keeps running against the
// same process after the HTTP response is sent. Progress is written to
// the ImportRun row as it goes; the UI polls the loader to show it.
//
// Reported: with only a coarse "discovering categories" / percent-done
// state and no visibility into the ~54-category discovery phase (which
// alone can take several minutes before any product count even appears),
// this looked like it had hung. Now keeps a running statusMessage plus a
// rolling log tail (last ~150 lines) so there's always something visible
// happening, matching the "Logs" tab the original standalone STEDI app had.
async function runStediScrapeInBackground(runId) {
  const logLines = [];
  const log = (line) => {
    const stamp = new Date().toISOString().slice(11, 19);
    logLines.push(`[${stamp}] ${line}`);
    if (logLines.length > 150) logLines.shift();
  };
  const flush = async (extra = {}) => {
    await db.importRun
      .update({ where: { id: runId }, data: { logTail: logLines.join("\n"), ...extra } })
      .catch(() => {});
  };

  try {
    log("Starting STEDI scrape.");
    await flush({ statusMessage: "Discovering categories…" });

    const settings = await getSourceSettings(db, "STEDI", DEFAULT_SETTINGS);
    const pricingFn = (price) => stediPricing(price, settings);

    const { urlToCategories } = await getAllProductUrlsWithCategories(async (progress) => {
      log(
        `Category ${progress.index}/${progress.total}: ${progress.category} — ` +
          `${progress.foundThisCategory} product URL(s) (${progress.totalUrlsSoFar} total so far)`,
      );
      await flush({
        statusMessage: `Discovering categories: ${progress.index}/${progress.total} (${progress.totalUrlsSoFar} product URLs found so far)`,
        totalFound: progress.totalUrlsSoFar,
      });
    });

    const productUrls = [...urlToCategories.keys()];
    log(`Category discovery done — ${productUrls.length} product URLs to process.`);
    await flush({
      totalFound: productUrls.length,
      statusMessage: `Processing products: 0/${productUrls.length}`,
    });

    let done = 0;
    for (const url of productUrls) {
      try {
        const scraped = await parseProduct(url);
        if (scraped.isRealProduct) {
          const mapped = mapStediProduct(scraped, STEDI_BRAND, pricingFn);
          await upsertStagedProducts(db, runId, "STEDI", [mapped]);
          log(`[${done + 1}/${productUrls.length}] Staged: ${scraped.title}`);
        } else {
          log(`[${done + 1}/${productUrls.length}] Skipped (not a real product page): ${url}`);
        }
      } catch (err) {
        log(`[${done + 1}/${productUrls.length}] FAILED: ${url} — ${err.message || err}`);
      }
      done += 1;
      if (done % 5 === 0 || done === productUrls.length) {
        await flush({ totalDone: done, statusMessage: `Processing products: ${done}/${productUrls.length}` });
      }
    }

    log("Scrape complete.");
    await flush({
      status: "done",
      totalDone: done,
      statusMessage: `Done — ${done} product(s) processed.`,
      finishedAt: new Date(),
    });
  } catch (err) {
    log(`Scrape failed: ${err.message || err}`);
    console.error("STEDI background scrape failed:", err);
    await flush({
      status: "failed",
      statusMessage: "Failed — see error below.",
      errorLog: String(err.message || err),
      finishedAt: new Date(),
    });
  }
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const { where, orderBy, tabId, q, sortField, sortDir } = buildStagedQuery("STEDI", url, TABS);

  const staged = await db.stagedProduct.findMany({ where, orderBy, take: 150 });

  const counts = await db.stagedProduct.groupBy({
    by: ["status"],
    where: { source: "STEDI" },
    _count: true,
  });
  const pushedCount = counts.find((c) => c.status === "PUSHED")?._count || 0;
  const totalCount = counts.reduce((sum, c) => sum + c._count, 0);

  const skus = staged.map((p) => p.sku).filter(Boolean);
  const shopifyMatches = await matchSkusToShopify(admin, skus);
  const settings = await getSourceSettings(db, "STEDI", DEFAULT_SETTINGS);

  const unmatched = staged.filter((p) => (!p.sku || !shopifyMatches[p.sku]) && !p.matchDeclined);
  let fuzzyMatches = {};
  let vendorTags = [];
  if (unmatched.length > 0) {
    const vendorProducts = await fetchVendorProducts(admin, VENDOR_NAMES.STEDI);
    fuzzyMatches = fuzzyMatchTitles(unmatched.map((p) => ({ id: p.id, title: p.title })), vendorProducts);
    vendorTags = summarizeVendorTags(vendorProducts);
  }

  const latestRun = await db.importRun.findFirst({
    where: { source: "STEDI" },
    orderBy: { startedAt: "desc" },
  });

  return {
    staged, pushedCount, totalCount, tabId, q, sortField, sortDir,
    shopDomain: session.shop, shopifyMatches, fuzzyMatches, vendorTags, settings,
    latestRun,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "fetch") {
    const running = await db.importRun.findFirst({ where: { source: "STEDI", status: "running" } });
    if (running) {
      return { ok: false, mode: "fetch", error: "A scrape is already running — check progress below." };
    }
    const run = await db.importRun.create({ data: { source: "STEDI", status: "running" } });
    // Deliberately not awaited — see runStediScrapeInBackground's comment.
    runStediScrapeInBackground(run.id);
    return { ok: true, mode: "fetch", started: true };
  }

  if (intent === "acceptMatch") {
    const id = formData.get("id");
    const productId = formData.get("productId");
    const matchedSku = formData.get("sku") || null;
    if (matchedSku) {
      await db.stagedProduct.update({ where: { id }, data: { sku: matchedSku } });
    } else {
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
    const sourceMultiplier = parseFloat(formData.get("sourceMultiplier"));
    const costRatio = parseFloat(formData.get("costRatio"));
    if (Number.isNaN(sourceMultiplier) || sourceMultiplier <= 0) {
      return { ok: false, mode: "updateSettings", error: "Multiplier must be a positive number." };
    }
    if (Number.isNaN(costRatio) || costRatio <= 0 || costRatio > 1) {
      return { ok: false, mode: "updateSettings", error: "Cost ratio must be a number between 0 and 1 (e.g. 0.6 for 60%)." };
    }
    await saveSourceSettings(db, "STEDI", { sourceMultiplier, costRatio });
    const updated = await recalculateStagedPrices(db, "STEDI", (price) =>
      stediPricing(price, { sourceMultiplier, costRatio }),
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
      const result = await bulkSyncPrices(admin, db, "STEDI");
      return { ok: result.errors.length === 0, mode: "updateAllPrices", ...result };
    } catch (err) {
      return { ok: false, mode: "updateAllPrices", checked: 0, updated: 0, errors: [String(err.message || err)] };
    }
  }

  if (intent === "syncWithShopify") {
    const pushedItems = await db.stagedProduct.findMany({
      where: { source: "STEDI", status: "PUSHED", shopifyProductId: { not: null } },
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
        console.error(`STEDI push failed for ${staged.title}:`, err);
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
            saveFetcher.submit({ intent: "updatePrice", id, [field]: local }, { method: "post" });
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
            <Button submit size="micro" loading={syncing}>{`Sync to ${zar(staged.retailZar)}`}</Button>
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
  const [sourceMultiplier, setSourceMultiplier] = useState(String(settings.sourceMultiplier));
  const [costRatio, setCostRatio] = useState(String(settings.costRatio));

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Pricing formula</Text>
        <Text as="p" tone="subdued">
          Retail (ZAR) = AUD price × multiplier, rounded up to the nearest
          R99. Cost (ZAR) = Retail × cost ratio. Saving recalculates every
          un-pushed staged product's price with the new formula — products
          already pushed to Shopify are left untouched.
        </Text>
        {result?.mode === "updateSettings" && result.ok === false && (
          <Banner tone="critical">{result.error}</Banner>
        )}
        {result?.mode === "updateSettings" && result.ok === true && (
          <Banner tone="success">{`Saved. Recalculated ${result.updated} un-pushed product(s).`}</Banner>
        )}
        <settingsFetcher.Form method="post">
          <input type="hidden" name="intent" value="updateSettings" />
          <InlineStack gap="200" blockAlign="end">
            <div style={{ maxWidth: 200 }}>
              <TextField
                label="AUD → ZAR multiplier"
                type="number"
                step="0.1"
                name="sourceMultiplier"
                value={sourceMultiplier}
                onChange={setSourceMultiplier}
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
        <Text as="h2" variant="headingMd">Existing Shopify tags for STEDI</Text>
        <Text as="p" tone="subdued">
          Tags already used on STEDI products in your store, most-used
          first — reference for keeping newly imported tags consistent
          with your existing collections/taxonomy rather than creating
          near-duplicates. STEDI products aren't auto-tagged yet (no
          category→tag mapping ported), so this is worth checking before
          pushing.
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

function ScrapeProgressCard({ run }) {
  const revalidator = useRevalidator();
  const running = run?.status === "running";

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(interval);
  }, [running, revalidator]);

  if (!run) return null;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between">
          <Text as="h2" variant="headingMd">Scrape status</Text>
          {run.status === "running" && <Badge tone="info">Running</Badge>}
          {run.status === "done" && <Badge tone="success">Done</Badge>}
          {run.status === "failed" && <Badge tone="critical">Failed</Badge>}
        </InlineStack>
        {running && (
          <BlockStack gap="200">
            <Text as="p" tone="subdued">
              {run.statusMessage || "Starting…"}
              {" — this runs in the background, feel free to leave this tab and come back."}
            </Text>
            {run.totalFound > 0 && (
              <ProgressBar progress={Math.round((run.totalDone / run.totalFound) * 100)} size="small" />
            )}
          </BlockStack>
        )}
        {run.status === "done" && run.statusMessage && (
          <Text as="p" tone="subdued">{run.statusMessage}</Text>
        )}
        {run.status === "failed" && (
          <Banner tone="critical">{run.errorLog || "Unknown error."}</Banner>
        )}
        {run.logTail && (
          <details>
            <summary style={{ cursor: "pointer", color: "var(--p-color-text-link, #2c6ecb)" }}>
              View log
            </summary>
            <div
              style={{
                marginTop: 8,
                maxHeight: 320,
                overflowY: "auto",
                background: "#1a1a1a",
                color: "#e0e0e0",
                padding: 12,
                borderRadius: 6,
                fontFamily: "monospace",
                fontSize: 12,
                whiteSpace: "pre-wrap",
              }}
            >
              {run.logTail}
            </div>
          </details>
        )}
      </BlockStack>
    </Card>
  );
}

export default function StediSource() {
  const {
    staged, pushedCount, totalCount, tabId, q, sortField, sortDir,
    shopDomain, shopifyMatches, fuzzyMatches, vendorTags, settings, latestRun,
  } = useLoaderData();
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
  const scrapeRunning = latestRun?.status === "running";

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
    <Page
      title="STEDI Import"
      titleMetadata={
        <div style={{ background: "#0a0a0a", padding: "3px 8px", borderRadius: 6, display: "inline-flex" }}>
          <img src={STEDI_LOGO} alt="STEDI" style={{ height: 18 }} />
        </div>
      }
    >
      <BlockStack gap="400">
        <Banner tone="info">
          Scrapes the live STEDI catalog directly from www.stedi.com.au —
          unlike ALTIQ/TrailBait/Bushdoof, STEDI's own site isn't Shopify
          (it's Magento), so there's no products.json shortcut. Formats
          titles as "STEDI Title Cased Rest". A full scrape runs in the
          background and takes roughly 10-15 minutes (STEDI's site is
          rate-limited politely to avoid getting blocked) — the progress
          card below updates live. Pushed products bring their
          description and images across automatically and land as
          Drafts, so nothing goes live without review.
        </Banner>

        {fetchResult?.mode === "fetch" && fetchResult.ok === false && (
          <Banner tone="critical" title="Couldn't start">{fetchResult.error}</Banner>
        )}
        {fetchResult?.mode === "fetch" && fetchResult.ok === true && (
          <Banner tone="success" title="Scrape started">Running in the background — see progress below.</Banner>
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
                <Button url={`/app/export/STEDI?tab=${tabId}${q ? `&q=${encodeURIComponent(q)}` : ""}`} external>
                  Export CSV
                </Button>
                <fetchFetcher.Form method="post">
                  <input type="hidden" name="intent" value="fetch" />
                  <Button submit loading={fetching} disabled={scrapeRunning} variant="primary">
                    {scrapeRunning ? "Scrape running…" : "Fetch STEDI products"}
                  </Button>
                </fetchFetcher.Form>
              </InlineStack>
            </InlineStack>
            <Text as="p" tone="subdued">
              {`${totalCount} total staged, ${pushedCount} already pushed`}
            </Text>
          </BlockStack>
        </Card>

        <ScrapeProgressCard run={latestRun} />

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
                      <Link url={sourceHref} target="_blank" removeUnderline>{p.title}</Link>
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
