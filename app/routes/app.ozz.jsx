import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useSearchParams, useRevalidator } from "@remix-run/react";
import {
  unstable_parseMultipartFormData,
  unstable_createMemoryUploadHandler,
} from "@remix-run/node";
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
  Modal,
  DropZone,
  Thumbnail,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { fetchAllWooProducts, fetchAllWooVariations, groupVariationsByParent } from "../adapters/wooCommerce.server";
import { mapOzzProduct } from "../adapters/ozzMap.server";
import { parseOzzPricelist } from "../adapters/ozzPdf.server";
import { pushStagedProduct, getPushChannelInfo } from "../adapters/shopifyPush.server";
import { bulkSyncPrices } from "../adapters/bulkPriceSync.server";
import { matchSkusToShopify, syncVariantPrice, fetchVendorProducts, fuzzyMatchTitles, checkProductsExist } from "../adapters/shopifyMatch.server";
import { summarizeVendorTags } from "../adapters/shopifyTaxonomy.server";
import { VENDOR_NAMES } from "../utils/vendorNames";
import { productIdToAdminPath } from "../utils/shopify";
import { buildStagedQuery } from "../utils/stagedQuery.server";
import { upsertStagedProducts } from "../utils/stagedUpsert.server";
import { getSourceSettings, saveSourceSettings } from "../utils/sourceSettings.server";
import { ozzPricing, DEFAULT_SETTINGS as PRICING_DEFAULTS } from "../utils/pricingFormulas";

const OZZ_BRAND = "OZZ";
const OZZ_BASE_URL = "https://ozzlights.com";
const DEFAULT_SETTINGS = PRICING_DEFAULTS.OZZ;
const TABS = [
  { id: "all", label: "All", filter: {} },
  { id: "new", label: "New", filter: { status: { in: ["NEW", "NEEDS_REVIEW"] } } },
  { id: "pushed", label: "Pushed", filter: { status: "PUSHED" } },
];

const SORT_FIELDS = ["title", "sku", "costZar", "retailZar", null, null];

// Merges parsed PDF pricelist rows into already-fetched OZZ staged
// products, matched by SKU — unlike every other PDF source in this app
// (MagicStar/Nanjing), this PDF is price-only and never creates or touches
// StagedProduct rows itself; the website fetch (runOzzFetchInBackground)
// is what creates them. Every variant in a staged product's variantsJson
// is checked against the pricelist map (not just the top-level sku) since
// a grouped/variable product's real per-variant SKUs live there, same as
// Ultra Vision's variant shape. The top-level retailZar/costZar always
// mirrors variants[0] after a merge, same convention Ultra Vision's own
// mapping uses.
async function mergeOzzPricelist(rows, settings) {
  const pdfMap = new Map();
  for (const row of rows) pdfMap.set(row.sku, row); // last-one-wins on duplicate SKUs — see ozzPdf.server.js header

  const staged = await db.stagedProduct.findMany({ where: { source: "OZZ" } });

  const matchedSkus = new Set();
  let productsUpdated = 0;

  for (const product of staged) {
    const variants = product.variantsJson?.variants || [];
    let changed = false;

    const newVariants = variants.map((v) => {
      const pdfRow = v.sku ? pdfMap.get(v.sku) : null;
      if (!pdfRow) return v;
      matchedSkus.add(v.sku);
      changed = true;
      const { retailZar, costZar, priceIsEstimated } = ozzPricing(pdfRow.wholesaleEUR, settings);
      return { ...v, priceForeign: pdfRow.wholesaleEUR, retailZar, costZar, priceIsEstimated };
    });

    if (!changed) continue;

    const first = newVariants[0];
    await db.stagedProduct.update({
      where: { id: product.id },
      data: {
        variantsJson: { ...product.variantsJson, variants: newVariants },
        retailZar: first?.retailZar ?? product.retailZar,
        costZar: first?.costZar ?? product.costZar,
        priceIsEstimated: first?.priceIsEstimated ?? product.priceIsEstimated,
      },
    });
    productsUpdated += 1;
  }

  const unmatched = rows.filter((r) => !matchedSkus.has(r.sku));
  return { productsUpdated, pdfTotal: rows.length, matched: matchedSkus.size, unmatched };
}

// Step 1 of 2 for OZZ: pulls the live catalog (title/images/description/
// specs) from their public WooCommerce Store API, same unauthenticated
// approach proven for Ultra Vision. Deliberately no pricing here — OZZ's
// Store API returns "0" for every price (reseller-only catalog), so every
// product stages with no cost/retail yet. Step 2 (a PDF dealer+retail
// pricelist upload, merged in by SKU) isn't built yet — pending the real
// pricelist file — so for now prices are either left blank or typed in
// manually per row below.
async function runOzzFetchInBackground(runId) {
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
    log("Starting OZZ fetch.");
    await flush({ statusMessage: "Fetching product list…" });

    const products = await fetchAllWooProducts(OZZ_BASE_URL);
    log(`Fetched ${products.length} product(s) from WooCommerce.`);
    await flush({ statusMessage: "Fetching variation data…" });

    const allVariations = await fetchAllWooVariations(OZZ_BASE_URL);
    const variationsByParent = groupVariationsByParent(allVariations);
    log(
      `Fetched ${allVariations.length} variation(s) total. ` +
        `${variationsByParent.size} distinct parent product(s) matched by the grouping key.`,
    );
    await flush({ totalFound: products.length, statusMessage: `Processing 0/${products.length}` });

    let done = 0;
    for (const product of products) {
      try {
        const variations = variationsByParent.get(String(product.id)) || [];
        const mapped = mapOzzProduct(product, variations, OZZ_BRAND);
        await upsertStagedProducts(db, runId, "OZZ", [mapped]);
        log(`[${done + 1}/${products.length}] Staged: ${product.name}${variations.length ? ` (${variations.length} variants)` : ""}`);
      } catch (err) {
        log(`[${done + 1}/${products.length}] FAILED: ${product.name} — ${err.message || err}`);
      }
      done += 1;
      if (done % 5 === 0 || done === products.length) {
        await flush({ totalDone: done, statusMessage: `Processing ${done}/${products.length}` });
      }
    }

    log("Fetch complete.");
    await flush({
      status: "done",
      totalDone: done,
      statusMessage: `Done — ${done} product(s) processed.`,
      finishedAt: new Date(),
    });
  } catch (err) {
    log(`Fetch failed: ${err.message || err}`);
    console.error("OZZ background fetch failed:", err);
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
  const { where, orderBy, tabId, q, sortField, sortDir } = buildStagedQuery("OZZ", url, TABS);

  const staged = await db.stagedProduct.findMany({ where, orderBy, take: 150 });

  const counts = await db.stagedProduct.groupBy({
    by: ["status"],
    where: { source: "OZZ" },
    _count: true,
  });
  const pushedCount = counts.find((c) => c.status === "PUSHED")?._count || 0;
  const totalCount = counts.reduce((sum, c) => sum + c._count, 0);
  const noPriceCount = await db.stagedProduct.count({ where: { source: "OZZ", retailZar: null } });

  const skus = staged.map((p) => p.sku).filter(Boolean);
  const shopifyMatches = await matchSkusToShopify(admin, skus);
  const settings = await getSourceSettings(db, "OZZ", DEFAULT_SETTINGS);

  const unmatched = staged.filter((p) => (!p.sku || !shopifyMatches[p.sku]) && !p.matchDeclined);
  let fuzzyMatches = {};
  let vendorTags = [];
  if (unmatched.length > 0) {
    const vendorProducts = await fetchVendorProducts(admin, VENDOR_NAMES.OZZ);
    fuzzyMatches = fuzzyMatchTitles(unmatched.map((p) => ({ id: p.id, title: p.title })), vendorProducts);
    vendorTags = summarizeVendorTags(vendorProducts);
  }

  const latestRun = await db.importRun.findFirst({
    where: { source: "OZZ" },
    orderBy: { startedAt: "desc" },
  });

  return {
    staged, pushedCount, totalCount, noPriceCount, tabId, q, sortField, sortDir,
    shopDomain: session.shop, shopifyMatches, fuzzyMatches, vendorTags, settings,
    latestRun,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const contentType = request.headers.get("content-type") || "";

  // The pricelist upload form posts multipart/form-data (it carries a
  // file); every other action on this page is a plain fetcher.submit()
  // post, same branching approach as app.nanjing.jsx/app.magicstar.jsx.
  if (contentType.includes("multipart/form-data")) {
    const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: 30 * 1024 * 1024 });
    const formData = await unstable_parseMultipartFormData(request, uploadHandler);
    const file = formData.get("pricelist");

    if (!file || typeof file === "string") {
      return { ok: false, mode: "uploadPricelist", error: "No PDF file was received." };
    }

    let rows;
    try {
      const arrayBuffer = await file.arrayBuffer();
      rows = await parseOzzPricelist(Buffer.from(arrayBuffer));
    } catch (err) {
      console.error("OZZ pricelist parse failed:", err);
      return { ok: false, mode: "uploadPricelist", error: `Couldn't read that PDF: ${String(err.message || err)}` };
    }

    if (rows.length === 0) {
      return { ok: false, mode: "uploadPricelist", error: "No price rows could be read from that PDF — is it the right file?" };
    }

    const settings = await getSourceSettings(db, "OZZ", DEFAULT_SETTINGS);
    const { productsUpdated, pdfTotal, matched, unmatched } = await mergeOzzPricelist(rows, settings);

    return {
      ok: true,
      mode: "uploadPricelist",
      pdfTotal,
      matched,
      productsUpdated,
      unmatchedCount: unmatched.length,
      unmatchedSample: unmatched.slice(0, 8).map((r) => `${r.sku} — ${r.description}`),
    };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "updateSettings") {
    const costMultiplier = parseFloat(formData.get("costMultiplier"));
    const retailMultiplier = parseFloat(formData.get("retailMultiplier"));
    if (Number.isNaN(costMultiplier) || costMultiplier <= 0 || Number.isNaN(retailMultiplier) || retailMultiplier <= 0) {
      return { ok: false, mode: "updateSettings", error: "Both values must be positive numbers." };
    }
    const settings = { costMultiplier, retailMultiplier };
    await saveSourceSettings(db, "OZZ", settings);

    // Recalculate every already-merged variant's price from its stored EUR
    // wholesale figure, same as every other source's formula-save
    // behaviour — a re-upload of the pricelist isn't needed just to apply
    // a new multiplier. Products with no merged price yet (priceForeign
    // still null) are left untouched, same as before.
    const staged = await db.stagedProduct.findMany({ where: { source: "OZZ" } });
    for (const p of staged) {
      const variants = p.variantsJson?.variants || [];
      if (!variants.some((v) => v.priceForeign != null)) continue;
      const newVariants = variants.map((v) => {
        if (v.priceForeign == null) return v;
        const { retailZar, costZar, priceIsEstimated } = ozzPricing(v.priceForeign, settings);
        return { ...v, retailZar, costZar, priceIsEstimated };
      });
      const first = newVariants[0];
      await db.stagedProduct.update({
        where: { id: p.id },
        data: {
          variantsJson: { ...p.variantsJson, variants: newVariants },
          retailZar: first?.retailZar ?? p.retailZar,
          costZar: first?.costZar ?? p.costZar,
        },
      });
    }
    return { ok: true, mode: "updateSettings" };
  }

  if (intent === "fetch") {
    const running = await db.importRun.findFirst({ where: { source: "OZZ", status: "running" } });
    if (running) {
      return { ok: false, mode: "fetch", error: "A fetch is already running — check progress below." };
    }
    const run = await db.importRun.create({ data: { source: "OZZ", status: "running" } });
    runOzzFetchInBackground(run.id); // deliberately not awaited — see function comment
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
      const result = await bulkSyncPrices(admin, db, "OZZ");
      return { ok: result.errors.length === 0, mode: "updateAllPrices", ...result };
    } catch (err) {
      return { ok: false, mode: "updateAllPrices", checked: 0, updated: 0, errors: [String(err.message || err)] };
    }
  }

  if (intent === "syncWithShopify") {
    const pushedItems = await db.stagedProduct.findMany({
      where: { source: "OZZ", status: "PUSHED", shopifyProductId: { not: null } },
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

  async function performPush(stagedList, channelInfo, forceNewIds = new Set()) {
    const skus = stagedList.filter((s) => !forceNewIds.has(s.id)).map((s) => s.sku).filter(Boolean);
    const matches = await matchSkusToShopify(admin, skus);

    let pushed = 0;
    const errors = [];
    for (const staged of stagedList) {
      const existingProductId = forceNewIds.has(staged.id)
        ? null
        : staged.shopifyProductId || matches[staged.sku]?.productId;
      try {
        const shopifyProductId = await pushStagedProduct(admin, staged, existingProductId, channelInfo);
        await db.stagedProduct.update({ where: { id: staged.id }, data: { status: "PUSHED", shopifyProductId } });
        pushed += 1;
      } catch (err) {
        console.error(`OZZ push failed for ${staged.title}:`, err);
        errors.push(`${staged.title}: ${String(err.message || err)}`);
      }
    }
    return { pushed, errors };
  }

  if (intent === "push") {
    const ids = formData.getAll("ids");
    const stagedList = await db.stagedProduct.findMany({ where: { id: { in: ids } } });
    const skus = stagedList.map((s) => s.sku).filter(Boolean);
    const matches = await matchSkusToShopify(admin, skus);

    const conflicts = stagedList
      .filter((s) => !s.shopifyProductId && s.sku && matches[s.sku])
      .map((s) => ({
        id: s.id,
        title: s.title,
        sku: s.sku,
        matchedProductId: matches[s.sku].productId,
        matchedProductTitle: matches[s.sku].productTitle,
        matchedPrice: matches[s.sku].price,
      }));

    if (conflicts.length > 0) {
      return { ok: true, mode: "push", needsResolution: true, conflicts, ids };
    }

    const channelInfo = await getPushChannelInfo(admin);
    const { pushed, errors } = await performPush(stagedList, channelInfo);
    return { ok: errors.length === 0, mode: "push", pushed, errors };
  }

  if (intent === "pushResolved") {
    const ids = formData.getAll("ids");
    const rawStagedList = await db.stagedProduct.findMany({ where: { id: { in: ids } } });

    const forceNewIds = new Set();
    const finalList = [];
    let skipped = 0;
    for (let staged of rawStagedList) {
      const resolution = formData.get(`resolution_${staged.id}`);
      if (resolution === "skip") {
        skipped += 1;
        continue;
      }
      if (resolution === "newsku") {
        const newSku = formData.get(`newsku_${staged.id}`)?.toString().trim();
        if (newSku) {
          await db.stagedProduct.update({ where: { id: staged.id }, data: { sku: newSku } });
          staged = { ...staged, sku: newSku };
        }
        forceNewIds.add(staged.id);
      }
      finalList.push(staged);
    }

    const channelInfo = await getPushChannelInfo(admin);
    const { pushed, errors } = await performPush(finalList, channelInfo, forceNewIds);
    return { ok: errors.length === 0, mode: "push", pushed, errors, skipped };
  }

  return null;
};

const zar = (n) =>
  n == null ? "—" : `R${Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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

  const [confirmation, setConfirmation] = useState(null); // "accepted" | "declined" | null

  useEffect(() => {
    if (acceptFetcher.state === "idle" && acceptFetcher.data?.mode === "acceptMatch" && acceptFetcher.data?.id === staged.id) {
      setConfirmation(acceptFetcher.data.ok ? "accepted" : null);
    }
  }, [acceptFetcher.state, acceptFetcher.data, staged.id]);

  useEffect(() => {
    if (declineFetcher.state === "idle" && declineFetcher.data?.mode === "declineMatch" && declineFetcher.data?.id === staged.id) {
      setConfirmation(declineFetcher.data.ok ? "declined" : null);
    }
  }, [declineFetcher.state, declineFetcher.data, staged.id]);

  const confirmationBadge = confirmation && (
    <Badge tone="success">{confirmation === "accepted" ? "Match accepted" : "Match declined"}</Badge>
  );

  if (match) {
    const priceDiffers = staged.retailZar != null && Math.round(match.price) !== Math.round(staged.retailZar);
    return (
      <BlockStack gap="100">
        {confirmationBadge}
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
            <Button submit size="micro" loading={accepting} disabled={declining}>Accept</Button>
          </acceptFetcher.Form>
          <declineFetcher.Form method="post">
            <input type="hidden" name="intent" value="declineMatch" />
            <input type="hidden" name="id" value={staged.id} />
            <Button submit size="micro" loading={declining} disabled={accepting}>Decline</Button>
          </declineFetcher.Form>
        </InlineStack>
        {acceptFetcher.data?.mode === "acceptMatch" && acceptFetcher.data?.id === staged.id && acceptFetcher.data.ok === false && (
          <Text as="span" tone="critical">Couldn't accept — try again.</Text>
        )}
      </BlockStack>
    );
  }

  return (
    <BlockStack gap="100">
      {confirmationBadge}
      <Text as="span" tone="subdued">Not in store</Text>
    </BlockStack>
  );
}

function PricingFormulaCard({ settings }) {
  const settingsFetcher = useFetcher();
  const saving = settingsFetcher.state !== "idle";
  const result = settingsFetcher.data;
  const [costMultiplier, setCostMultiplier] = useState(String(settings.costMultiplier));
  const [retailMultiplier, setRetailMultiplier] = useState(String(settings.retailMultiplier));

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Pricing formula</Text>
        <Text as="p" tone="subdued">
          Cost (ZAR) = the pricelist's Wholesale (EUR) figure × cost
          multiplier. Retail (ZAR) = Wholesale (EUR) × retail multiplier,
          rounded to the nearest R99 — unlike every other source here,
          Retail isn't derived from Cost, it's its own direct multiplier
          of the EUR figure. Both are Coenraad's own all-in factors (FX +
          SA shipping/duty/margin baked in). Saving recalculates every
          already-merged price immediately, no re-upload needed.
        </Text>
        {result?.mode === "updateSettings" && result.ok === false && <Banner tone="critical">{result.error}</Banner>}
        {result?.mode === "updateSettings" && result.ok === true && <Banner tone="success">Saved and recalculated.</Banner>}
        <settingsFetcher.Form method="post">
          <input type="hidden" name="intent" value="updateSettings" />
          <InlineStack gap="200" blockAlign="end">
            <div style={{ maxWidth: 200 }}>
              <TextField label="Cost multiplier (× EUR)" type="number" step="0.01" name="costMultiplier" value={costMultiplier} onChange={setCostMultiplier} autoComplete="off" />
            </div>
            <div style={{ maxWidth: 200 }}>
              <TextField label="Retail multiplier (× EUR)" type="number" step="0.01" name="retailMultiplier" value={retailMultiplier} onChange={setRetailMultiplier} autoComplete="off" />
            </div>
            <Button submit loading={saving} variant="primary">Save</Button>
          </InlineStack>
        </settingsFetcher.Form>
      </BlockStack>
    </Card>
  );
}

function UploadPricelistCard() {
  const uploadFetcher = useFetcher();
  const uploading = uploadFetcher.state !== "idle";
  const result = uploadFetcher.data;
  const [file, setFile] = useState(null);

  const handleDrop = (_dropFiles, acceptedFiles) => {
    const f = acceptedFiles[0];
    if (f) setFile(f);
  };

  function handleSubmit() {
    if (!file) return;
    const fd = new FormData();
    fd.set("pricelist", file);
    uploadFetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  }

  useEffect(() => {
    if (uploadFetcher.state === "idle" && uploadFetcher.data?.mode === "uploadPricelist" && uploadFetcher.data.ok) {
      setFile(null);
    }
  }, [uploadFetcher.state, uploadFetcher.data]);

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Upload pricelist</Text>
        <Text as="p" tone="subdued">
          Drop OZZ's own wholesale PDF pricelist here — it's matched to
          already-fetched products by SKU (OZZ's "PART NUMBER" column),
          so fetch the catalog first if you haven't yet. Prices in the
          PDF are the Wholesale (EUR) column, not RRP — RRP reflects the
          Swedish/EU retail market and isn't used. Safe to re-upload a
          refreshed pricelist any time; it only updates matched SKUs'
          prices, nothing else.
        </Text>
        {result?.mode === "uploadPricelist" && result.ok === false && <Banner tone="critical" title="Couldn't process that file">{result.error}</Banner>}
        {result?.mode === "uploadPricelist" && result.ok === true && (
          <Banner tone={result.unmatchedCount > 0 ? "warning" : "success"} title="Pricelist processed">
            <BlockStack gap="100">
              <Text as="p">
                {`Read ${result.pdfTotal} price row(s) — matched ${result.matched} SKU(s), updated ${result.productsUpdated} staged product(s).`}
              </Text>
              {result.unmatchedCount > 0 && (
                <Text as="p">
                  {`${result.unmatchedCount} pricelist row(s) had no matching staged product (fetch the catalog if you haven't, or OZZ's site may use a different SKU for these):`}
                  {" "}
                  {result.unmatchedSample.join("; ")}
                  {result.unmatchedCount > result.unmatchedSample.length ? "…" : ""}
                </Text>
              )}
            </BlockStack>
          </Banner>
        )}
        <DropZone accept="application/pdf" type="file" allowMultiple={false} onDrop={handleDrop}>
          {file ? (
            <div style={{ padding: 16 }}>
              <InlineStack gap="200" blockAlign="center">
                <Thumbnail size="small" alt="PDF" source="https://cdn.shopify.com/s/files/applications/0e8/4e4/products/file-icon.png" />
                <Text as="span">{file.name}</Text>
              </InlineStack>
            </div>
          ) : (
            <DropZone.FileUpload actionTitle="Add pricelist PDF" actionHint="or drop a PDF file here" />
          )}
        </DropZone>
        <InlineStack>
          <Button onClick={handleSubmit} disabled={!file} loading={uploading} variant="primary">
            {uploading ? "Parsing…" : "Parse & merge prices"}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function ShopifyTagsCard({ vendorTags }) {
  if (!vendorTags.length) return null;
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Existing Shopify tags for OZZ</Text>
        <Text as="p" tone="subdued">
          Tags already used on OZZ products in your store, most-used first.
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

function FetchProgress({ run }) {
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
          <Text as="h2" variant="headingMd">Fetch status</Text>
          {run.status === "running" && <Badge tone="info">Running</Badge>}
          {run.status === "done" && <Badge tone="success">Done</Badge>}
          {run.status === "failed" && <Badge tone="critical">Failed</Badge>}
        </InlineStack>
        {running && (
          <Text as="p" tone="subdued">
            {run.statusMessage || "Starting…"}
            {" — this runs in the background, feel free to leave this tab and come back."}
          </Text>
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

function ConflictResolutionModal({ pushResult, onDismiss }) {
  const resolveFetcher = useFetcher();
  const [choices, setChoices] = useState({});
  const [newSkus, setNewSkus] = useState({});
  const resolving = resolveFetcher.state !== "idle";

  const conflicts = pushResult?.conflicts || [];

  const allResolved = conflicts.every((c) => {
    const choice = choices[c.id];
    if (!choice) return false;
    if (choice === "newsku" && !newSkus[c.id]?.trim()) return false;
    return true;
  });

  function handleConfirm() {
    const fd = new FormData();
    fd.set("intent", "pushResolved");
    for (const id of pushResult.ids) fd.append("ids", id);
    for (const c of conflicts) {
      const choice = choices[c.id];
      fd.set(`resolution_${c.id}`, choice);
      if (choice === "newsku") fd.set(`newsku_${c.id}`, newSkus[c.id].trim());
    }
    resolveFetcher.submit(fd, { method: "post" });
  }

  useEffect(() => {
    if (resolveFetcher.state === "idle" && resolveFetcher.data?.mode === "push") {
      onDismiss(resolveFetcher.data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveFetcher.state, resolveFetcher.data]);

  return (
    <Modal
      open
      onClose={() => onDismiss(null)}
      title={`${conflicts.length} product(s) already exist in Shopify`}
      primaryAction={{
        content: "Confirm and push",
        onAction: handleConfirm,
        loading: resolving,
        disabled: !allResolved || resolving,
      }}
      secondaryActions={[{ content: "Cancel", onAction: () => onDismiss(null), disabled: resolving }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Text as="p">
            These products' SKUs match a product already in your store
            that this app has never confirmed a link to — pushing them
            as-is would update that existing product. Choose what to do
            with each before continuing; nothing pushes until every item
            below has a choice.
          </Text>
          {conflicts.map((c) => (
            <Card key={c.id}>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">{c.title}</Text>
                <Text as="p" tone="subdued">
                  {`SKU "${c.sku}" matches: ${c.matchedProductTitle} (${zar(c.matchedPrice)})`}
                </Text>
                <InlineStack gap="200">
                  <Button
                    pressed={choices[c.id] === "overwrite"}
                    onClick={() => setChoices((prev) => ({ ...prev, [c.id]: "overwrite" }))}
                  >
                    Overwrite existing
                  </Button>
                  <Button
                    pressed={choices[c.id] === "newsku"}
                    onClick={() => setChoices((prev) => ({ ...prev, [c.id]: "newsku" }))}
                  >
                    Use a different SKU
                  </Button>
                  <Button
                    pressed={choices[c.id] === "skip"}
                    onClick={() => setChoices((prev) => ({ ...prev, [c.id]: "skip" }))}
                  >
                    Skip this one
                  </Button>
                </InlineStack>
                {choices[c.id] === "newsku" && (
                  <TextField
                    label="New SKU"
                    labelHidden
                    placeholder="Enter a SKU that isn't already in use"
                    value={newSkus[c.id] || ""}
                    onChange={(val) => setNewSkus((prev) => ({ ...prev, [c.id]: val }))}
                    autoComplete="off"
                  />
                )}
              </BlockStack>
            </Card>
          ))}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export default function OzzSource() {
  const {
    staged, pushedCount, totalCount, noPriceCount, tabId, q, sortField, sortDir,
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

  const [modalDismissed, setModalDismissed] = useState(false);
  const [resolvedPushResult, setResolvedPushResult] = useState(null);
  useEffect(() => {
    if (pushFetcher.state === "submitting") {
      setModalDismissed(false);
      setResolvedPushResult(null);
    }
  }, [pushFetcher.state]);

  const showConflictModal = pushResult?.needsResolution && !modalDismissed;
  const finalPushResult =
    resolvedPushResult || (pushResult?.mode === "push" && !pushResult.needsResolution ? pushResult : null);

  const resourceName = { singular: "product", plural: "products" };
  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(staged);

  const selectedTabIndex = TABS.findIndex((t) => t.id === tabId);
  const runRunning = latestRun?.status === "running";

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
    <Page title="OZZ Lights Import">
      <BlockStack gap="400">
        <Banner tone={noPriceCount > 0 ? "warning" : "info"}>
          Pulls OZZ's live catalog (title, description, specs, images)
          directly from their WooCommerce store — no auth needed for
          public product data. There is no public pricing: OZZ's Store
          API returns 0 for every price, since it's reseller-only. Fetch
          the catalog below, then upload OZZ's own wholesale PDF
          pricelist to merge real Cost/Retail prices in by SKU — until
          that's done (or for any SKU the pricelist doesn't cover), type
          a cost/retail in per row manually, or push with blank prices
          and fix them up in Shopify afterwards.
          {noPriceCount > 0 && ` ${noPriceCount} staged product(s) currently have no price set.`}
        </Banner>

        {fetchResult?.mode === "fetch" && fetchResult.ok === false && (
          <Banner tone="critical" title="Couldn't start">{fetchResult.error}</Banner>
        )}
        {fetchResult?.mode === "fetch" && fetchResult.ok === true && (
          <Banner tone="success" title="Fetch started">Running in the background — see progress below.</Banner>
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
        {finalPushResult && (
          <Banner tone={finalPushResult.ok ? "success" : "warning"} title="Push finished">
            <BlockStack gap="100">
              <Text as="p">
                {`Pushed ${finalPushResult.pushed} product(s) to Shopify as drafts.`}
                {finalPushResult.skipped > 0 ? ` Skipped ${finalPushResult.skipped} by your choice.` : ""}
              </Text>
              {finalPushResult.errors?.map((e, i) => (
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
                <Button url={`/app/export/OZZ?tab=${tabId}${q ? `&q=${encodeURIComponent(q)}` : ""}`} external>
                  Export CSV
                </Button>
                <fetchFetcher.Form method="post">
                  <input type="hidden" name="intent" value="fetch" />
                  <Button submit loading={fetching} disabled={runRunning} variant="primary">
                    {runRunning ? "Fetch running…" : "Fetch OZZ products"}
                  </Button>
                </fetchFetcher.Form>
              </InlineStack>
            </InlineStack>
            <Text as="p" tone="subdued">
              {`${totalCount} total staged, ${pushedCount} already pushed`}
            </Text>
          </BlockStack>
        </Card>

        <FetchProgress run={latestRun} />

        <UploadPricelistCard />

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
          </pushFetcher.Form>
          <IndexTable
            resourceName={resourceName}
            itemCount={staged.length}
            selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
            onSelectionChange={handleSelectionChange}
            sortable={[true, true, true, true, false, false]}
            sortColumnIndex={sortColumnIndex === -1 ? undefined : sortColumnIndex}
            sortDirection={sortField ? sortDirection : undefined}
              onSort={handleSort}
              headings={[
                { title: "Title" },
                { title: "SKU" },
                { title: "Cost (ZAR)" },
                { title: "Retail (ZAR)" },
                { title: "Status" },
                { title: "In Shopify" },
              ]}
            >
              {staged.map((p, index) => {
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
                    <IndexTable.Cell>
                      <PriceCell id={p.id} label="Cost" value={p.costZar} field="costZar" saveFetcher={priceFetcher} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <PriceCell id={p.id} label="Retail" value={p.retailZar} field="retailZar" saveFetcher={priceFetcher} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="100">
                        <Badge tone={p.status === "PUSHED" ? "success" : undefined}>{p.status}</Badge>
                        {p.retailZar == null && <Badge tone="attention">No price</Badge>}
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <ShopifyMatchCell staged={p} match={match} fuzzyMatch={fuzzyMatches[p.id]} shopDomain={shopDomain} />
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
        </Card>
      </BlockStack>
      {showConflictModal && (
        <ConflictResolutionModal
          pushResult={pushResult}
          onDismiss={(result) => {
            setModalDismissed(true);
            if (result) setResolvedPushResult(result);
          }}
        />
      )}
    </Page>
  );
}
