import { useState, useEffect, useRef } from "react";
import { useLoaderData, useFetcher, useSearchParams, useRevalidator } from "@remix-run/react";
import {
  unstable_parseMultipartFormData,
  unstable_createMemoryUploadHandler,
} from "@remix-run/node";
import {
  Page, Card, BlockStack, InlineStack, Text, Button, Banner,
  IndexTable, useIndexResourceState, Badge, TextField, Tabs, Link, Modal,
  DropZone, Thumbnail, ProgressBar,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { parseNanjingPdf } from "../adapters/nanjingPdf.server";
import {
  parseNanjingCatalog,
  matchCatalogEntry,
  groupByBaseFamily,
  catalogEntryToDescriptionHtml,
} from "../adapters/nanjingCatalog.server";
import { fetchNanjingWebsiteCatalog } from "../adapters/nanjingWebsite.server";
import { pushStagedProduct, getPushChannelInfo } from "../adapters/shopifyPush.server";
import { bulkSyncPrices } from "../adapters/bulkPriceSync.server";
import { matchSkusToShopify, syncVariantPrice, fetchVendorProducts, fuzzyMatchTitles, checkProductsExist } from "../adapters/shopifyMatch.server";
import { VENDOR_NAMES } from "../utils/vendorNames";
import { generateTags } from "../utils/tagGenerator";
import { productIdToAdminPath } from "../utils/shopify";
import { buildStagedQuery } from "../utils/stagedQuery.server";
import { upsertStagedProducts } from "../utils/stagedUpsert.server";
import { getSourceSettings, saveSourceSettings } from "../utils/sourceSettings.server";
import { nanjingPricing, DEFAULT_SETTINGS as PRICING_DEFAULTS } from "../utils/pricingFormulas";

const DEFAULT_SETTINGS = PRICING_DEFAULTS.NANJING;
const TABS = [
  { id: "all", label: "All", filter: {} },
  { id: "new", label: "New", filter: { status: { in: ["NEW", "NEEDS_REVIEW"] } } },
  { id: "pushed", label: "Pushed", filter: { status: "PUSHED" } },
];
const SORT_FIELDS = ["title", "sku", null, "costZar", "retailZar", null, null];

// Runs the Jiuguang website fetch + match in the background, same
// ImportRun/log-tail pattern used by MagicStar's Alibaba catalog fetch and
// STEDI's scraper — ~390 product-page requests, even at a courteous pace,
// takes a few minutes and isn't something to block the request on. Uses
// source "NANJING" (the only valid Source enum value for this tab) with
// kind "website" so its ImportRun rows don't collide with the pricelist
// upload's "latest run" status — same `kind` column added for MagicStar's
// catalog-vs-pricelist split.
async function runNanjingWebsiteCatalogInBackground(runId) {
  const logLines = [];
  const log = (line) => {
    const stamp = new Date().toISOString().slice(11, 19);
    logLines.push(`[${stamp}] ${line}`);
    if (logLines.length > 150) logLines.shift();
  };
  const flush = async (extra = {}) => {
    await db.importRun.update({ where: { id: runId }, data: { logTail: logLines.join("\n"), ...extra } }).catch(() => {});
  };

  try {
    log("Starting Jiuguang website fetch.");
    await flush({ statusMessage: "Reading sitemap…" });

    const entries = await fetchNanjingWebsiteCatalog(async (progress) => {
      if (progress.error) {
        log(`[${progress.index}/${progress.total}] Skipped: ${progress.title} — ${progress.error}`);
      } else {
        log(`[${progress.index}/${progress.total}] Fetched: ${progress.title} (${progress.code})`);
      }
      await flush({ totalFound: progress.total, totalDone: progress.index, statusMessage: `Fetching product pages: ${progress.index}/${progress.total}` });
    });

    const withCode = entries.filter((e) => e.code);
    const failed = entries.length - withCode.length;
    log(`Website fetch done — ${withCode.length} product(s) read with a model code (${failed} skipped/failed).`);
    await flush({ statusMessage: `Matching ${withCode.length} website entries to staged products…` });

    const baseFamilyMap = groupByBaseFamily(withCode);
    const staged = await db.stagedProduct.findMany({
      where: { source: "NANJING", sku: { not: null } },
      select: { id: true, sku: true, title: true },
    });

    let exact = 0, approx = 0;
    for (const p of staged) {
      const match = matchCatalogEntry(p.sku, p.title, baseFamilyMap);
      if (!match) continue;
      const data = { descriptionHtml: catalogEntryToDescriptionHtml(match.entry) };
      if (match.entry.images?.length) data.images = match.entry.images;
      await db.stagedProduct.update({ where: { id: p.id }, data });
      log(`Matched (${match.confidence}, staged "${p.title}") -> ${match.entry.url}`);
      if (match.confidence === "exact") exact += 1; else approx += 1;
    }

    log("Website catalog match complete.");
    await flush({
      status: "done",
      statusMessage: `Done — ${withCode.length} product(s) read from the website, ${failed} skipped/failed. Of ${staged.length} staged product(s): ${exact} matched confidently (photo + description updated), ${approx} matched approximately, ${staged.length - exact - approx} had no good match.`,
      finishedAt: new Date(),
    });
  } catch (err) {
    log(`Fetch failed: ${err.message || err}`);
    console.error("Nanjing website catalog fetch failed:", err);
    await flush({ status: "failed", statusMessage: "Failed — see error below.", errorLog: String(err.message || err), finishedAt: new Date() });
  }
}

function imageUrlFor(request, imageKey) {
  const appUrl = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
  return `${appUrl}/files/nanjing/${encodeURIComponent(imageKey)}`;
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const { where, orderBy, tabId, q, sortField, sortDir } = buildStagedQuery("NANJING", url, TABS);

  const staged = await db.stagedProduct.findMany({ where, orderBy, take: 150 });

  const counts = await db.stagedProduct.groupBy({
    by: ["status"],
    where: { source: "NANJING" },
    _count: true,
  });
  const pushedCount = counts.find((c) => c.status === "PUSHED")?._count || 0;
  const totalCount = counts.reduce((sum, c) => sum + c._count, 0);

  const skus = staged.map((p) => p.sku).filter(Boolean);
  const shopifyMatches = await matchSkusToShopify(admin, skus);
  const settings = await getSourceSettings(db, "NANJING", DEFAULT_SETTINGS);

  const unmatched = staged.filter((p) => (!p.sku || !shopifyMatches[p.sku]) && !p.matchDeclined);
  let fuzzyMatches = {};
  if (unmatched.length > 0) {
    const vendorProducts = await fetchVendorProducts(admin, VENDOR_NAMES.NANJING);
    fuzzyMatches = fuzzyMatchTitles(unmatched.map((p) => ({ id: p.id, title: p.title })), vendorProducts);
  }

  const latestWebsiteCatalogRun = await db.importRun.findFirst({
    where: { source: "NANJING", kind: "website" },
    orderBy: { startedAt: "desc" },
  });

  return {
    staged, pushedCount, totalCount, tabId, q, sortField, sortDir,
    shopDomain: session.shop, shopifyMatches, fuzzyMatches, settings,
    latestWebsiteCatalogRun,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const contentType = request.headers.get("content-type") || "";

  // The upload form posts multipart/form-data (it carries a file); every
  // other action on this page is a plain fetcher.submit() post, same as
  // every other source's route — branch on content-type rather than
  // trying to parse every request the same way.
  if (contentType.includes("multipart/form-data")) {
    const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: 60 * 1024 * 1024 });
    const formData = await unstable_parseMultipartFormData(request, uploadHandler);

    // The product catalog is a separate, much larger PDF (98 pages of
    // supplier spec sheets, not pricing) — handled as its own upload/
    // merge step rather than folding it into the pricelist branch below,
    // since it doesn't create or price any staged rows, only enriches
    // descriptions on rows the pricelist upload already created.
    const catalogFile = formData.get("catalog");
    if (catalogFile && typeof catalogFile !== "string") {
      let entries;
      try {
        const arrayBuffer = await catalogFile.arrayBuffer();
        entries = await parseNanjingCatalog(Buffer.from(arrayBuffer));
      } catch (err) {
        console.error("Nanjing catalog parse failed:", err);
        return { ok: false, mode: "uploadCatalog", error: `Couldn't read that catalog PDF: ${String(err.message || err)}` };
      }
      if (entries.length === 0) {
        return { ok: false, mode: "uploadCatalog", error: "No product entries could be read from that catalog PDF — is it the right file?" };
      }

      const baseFamilyMap = groupByBaseFamily(entries);
      const staged = await db.stagedProduct.findMany({
        where: { source: "NANJING", sku: { not: null } },
        select: { id: true, sku: true, title: true },
      });

      let exact = 0, approx = 0;
      for (const p of staged) {
        const match = matchCatalogEntry(p.sku, p.title, baseFamilyMap);
        if (!match) continue;
        await db.stagedProduct.update({
          where: { id: p.id },
          data: { descriptionHtml: catalogEntryToDescriptionHtml(match.entry) },
        });
        if (match.confidence === "exact") exact += 1;
        else approx += 1;
      }

      return {
        ok: true,
        mode: "uploadCatalog",
        catalogEntries: entries.length,
        checked: staged.length,
        exact,
        approx,
        unmatched: staged.length - exact - approx,
      };
    }

    const file = formData.get("pricelist");

    if (!file || typeof file === "string") {
      return { ok: false, mode: "upload", error: "No PDF file was received." };
    }

    let rows;
    try {
      const arrayBuffer = await file.arrayBuffer();
      rows = await parseNanjingPdf(Buffer.from(arrayBuffer));
    } catch (err) {
      console.error("Nanjing PDF parse failed:", err);
      return { ok: false, mode: "upload", error: `Couldn't read that PDF: ${String(err.message || err)}` };
    }

    if (rows.length === 0) {
      return { ok: false, mode: "upload", error: "No product rows could be read from that PDF — is it the right file?" };
    }

    const settings = await getSourceSettings(db, "NANJING", DEFAULT_SETTINGS);
    const run = await db.importRun.create({
      data: { source: "NANJING", status: "done", totalFound: rows.length, totalDone: rows.length, finishedAt: new Date() },
    });

    // Several staged rows (one per size/variant) can share one photo, so
    // this is keyed by imageKey (the shared product-group id), not by the
    // row's own disambiguated SKU — re-upserting the same key for every
    // variant of a group is harmless, it just writes the same bytes again.
    const seenImageKeys = new Set();
    const mapped = [];
    for (const row of rows) {
      if (row.imageBuffer && !seenImageKeys.has(row.imageKey)) {
        seenImageKeys.add(row.imageKey);
        await db.nanjingImage.upsert({
          where: { imageKey: row.imageKey },
          create: { imageKey: row.imageKey, mimeType: row.imageMime, data: row.imageBuffer },
          update: { mimeType: row.imageMime, data: row.imageBuffer },
        });
      }

      const { retailZar, costZar, priceIsEstimated } = nanjingPricing(row.priceUSD, settings);
      mapped.push({
        sourceUrl: row.sourceUrl,
        sku: row.sku,
        title: row.title,
        descriptionHtml: row.descriptionHtml || "",
        images: [imageUrlFor(request, row.imageKey)],
        tags: generateTags(row.title, {}),
        variantsJson: { optionNames: [], variants: [{ sku: row.sku, priceForeign: row.priceUSD, retailZar, costZar }] },
        retailZar,
        costZar,
        priceIsEstimated,
      });
    }

    const { created, updated } = await upsertStagedProducts(db, run.id, "NANJING", mapped);
    return { ok: true, mode: "upload", created, updated, total: rows.length };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

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

  if (intent === "updateTitle") {
    const id = formData.get("id");
    const title = (formData.get("title") || "").toString().trim();
    if (!title) return { ok: false, mode: "updateTitle", id, error: "Title can't be empty." };
    await db.stagedProduct.update({ where: { id }, data: { title } });
    return { ok: true, mode: "updateTitle", id };
  }

  if (intent === "updateSettings") {
    const usdMultiplier = parseFloat(formData.get("usdMultiplier"));
    const retailMarkup = parseFloat(formData.get("retailMarkup"));
    if (Number.isNaN(usdMultiplier) || usdMultiplier <= 0 || Number.isNaN(retailMarkup) || retailMarkup <= 0) {
      return { ok: false, mode: "updateSettings", error: "Both values must be positive numbers." };
    }
    const settings = { usdMultiplier, retailMarkup };
    await saveSourceSettings(db, "NANJING", settings);

    // Recalculate every already-staged (not yet pushed) row's price from
    // its original USD figure, same as every other source's formula-save
    // behaviour — a re-upload isn't needed just to apply a new multiplier.
    const staged = await db.stagedProduct.findMany({ where: { source: "NANJING" } });
    for (const p of staged) {
      const priceUSD = p.variantsJson?.variants?.[0]?.priceForeign;
      if (priceUSD == null) continue;
      const { retailZar, costZar } = nanjingPricing(priceUSD, settings);
      await db.stagedProduct.update({ where: { id: p.id }, data: { retailZar, costZar } });
    }
    return { ok: true, mode: "updateSettings" };
  }

  if (intent === "syncPrice") {
    const id = formData.get("id");
    const staged = await db.stagedProduct.findUnique({ where: { id } });
    if (!staged?.sku) return { ok: false, mode: "syncPrice", id, error: "No SKU to match against." };
    const matches = await matchSkusToShopify(admin, [staged.sku]);
    const match = matches[staged.sku];
    if (!match) return { ok: false, mode: "syncPrice", id, error: "No matching Shopify product found." };
    try {
      await syncVariantPrice(admin, match.productId, match.variantId, staged.retailZar);
      return { ok: true, mode: "syncPrice", id };
    } catch (err) {
      return { ok: false, mode: "syncPrice", id, error: String(err.message || err) };
    }
  }

  if (intent === "updateAllPrices") {
    try {
      const result = await bulkSyncPrices(admin, db, "NANJING");
      return { ok: result.errors.length === 0, mode: "updateAllPrices", ...result };
    } catch (err) {
      return { ok: false, mode: "updateAllPrices", checked: 0, updated: 0, errors: [String(err.message || err)] };
    }
  }

  if (intent === "syncWithShopify") {
    const pushedItems = await db.stagedProduct.findMany({
      where: { source: "NANJING", status: "PUSHED", shopifyProductId: { not: null } },
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

  // The pricelist parser's row-identity formula (what makes a sourceUrl,
  // which decides whether a re-upload updates an existing row or creates
  // a new one) changed twice as parsing bugs got fixed — so a pricelist
  // re-uploaded after one of those fixes landed no longer matches the
  // rows an earlier upload created under the old formula, and both sets
  // pile up side by side instead of the old one being replaced. Every
  // upload stamps the ImportRun it belongs to onto every row it
  // touches (new or updated), so "not part of the most recent run" is
  // exactly what a leftover from an old formula looks like — cleared
  // here rather than silently left to double-count "total staged" and
  // get enriched twice by the catalog upload above. PUSHED rows are
  // never auto-deleted (deleting one would orphan a live Shopify
  // listing's link); they're reported instead so you can look at them.
  if (intent === "removeDuplicates") {
    const latestRun = await db.importRun.findFirst({
      where: { source: "NANJING" },
      orderBy: { startedAt: "desc" },
    });
    if (!latestRun) {
      return { ok: false, mode: "removeDuplicates", error: "No pricelist upload found yet — upload one first." };
    }
    const stale = await db.stagedProduct.findMany({
      where: { source: "NANJING", runId: { not: latestRun.id } },
      select: { id: true, status: true },
    });
    const deletable = stale.filter((p) => p.status !== "PUSHED");
    const pushedStale = stale.length - deletable.length;
    if (deletable.length > 0) {
      await db.stagedProduct.deleteMany({ where: { id: { in: deletable.map((p) => p.id) } } });
    }
    return { ok: true, mode: "removeDuplicates", removed: deletable.length, pushedStale };
  }

  if (intent === "fetchWebsiteCatalog") {
    const running = await db.importRun.findFirst({ where: { source: "NANJING", kind: "website", status: "running" } });
    if (running) {
      return { ok: false, mode: "fetchWebsiteCatalog", error: "A website fetch is already running — check progress below." };
    }
    const run = await db.importRun.create({ data: { source: "NANJING", kind: "website", status: "running" } });
    // Deliberately not awaited — see runNanjingWebsiteCatalogInBackground's comment.
    runNanjingWebsiteCatalogInBackground(run.id);
    return { ok: true, mode: "fetchWebsiteCatalog" };
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
        console.error(`Nanjing push failed for ${staged.title}:`, err);
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
        id: s.id, title: s.title, sku: s.sku,
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
      if (resolution === "skip") { skipped += 1; continue; }
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

const zar = (n) => (n == null ? "—" : `R${Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const usd = (n) => (n == null ? "—" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function TitleCell({ id, title, saveFetcher }) {
  const [local, setLocal] = useState(title);
  useEffect(() => setLocal(title), [title]);
  return (
    <div style={{ minWidth: 220 }}>
      <TextField
        label="Title" labelHidden value={local} onChange={setLocal}
        onBlur={() => {
          if (local.trim() && local !== title) {
            saveFetcher.submit({ intent: "updateTitle", id, title: local }, { method: "post" });
          }
        }}
        autoComplete="off" multiline={2}
      />
    </div>
  );
}

function PriceCell({ id, label, value, field, saveFetcher }) {
  const [local, setLocal] = useState(value ?? "");
  useEffect(() => setLocal(value ?? ""), [value]);
  return (
    <div style={{ minWidth: 110 }}>
      <TextField
        label={label} labelHidden type="number" value={String(local)} onChange={setLocal}
        onBlur={() => {
          if (String(local) !== String(value ?? "")) {
            saveFetcher.submit({ intent: "updatePrice", id, [field]: local }, { method: "post" });
          }
        }}
        autoComplete="off" prefix="R"
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
  const [confirmation, setConfirmation] = useState(null);

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
  const [usdMultiplier, setUsdMultiplier] = useState(String(settings.usdMultiplier));
  const [retailMarkup, setRetailMarkup] = useState(String(settings.retailMarkup));

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Pricing formula</Text>
        <Text as="p" tone="subdued">
          Cost (ZAR) = USD price × landed-cost factor (covers FX, shipping
          and duty to South Africa — not a live exchange rate). Retail
          (ZAR) = Cost × markup, rounded to the nearest R99. Saving
          recalculates every already-staged, not-yet-pushed row — no need
          to re-upload the PDF.
        </Text>
        {result?.mode === "updateSettings" && result.ok === false && <Banner tone="critical">{result.error}</Banner>}
        {result?.mode === "updateSettings" && result.ok === true && <Banner tone="success">Saved and recalculated.</Banner>}
        <settingsFetcher.Form method="post">
          <input type="hidden" name="intent" value="updateSettings" />
          <InlineStack gap="200" blockAlign="end">
            <div style={{ maxWidth: 220 }}>
              <TextField label="Landed-cost factor (× USD)" type="number" step="0.01" name="usdMultiplier" value={usdMultiplier} onChange={setUsdMultiplier} autoComplete="off" />
            </div>
            <div style={{ maxWidth: 180 }}>
              <TextField label="Retail markup (× Cost)" type="number" step="0.05" name="retailMarkup" value={retailMarkup} onChange={setRetailMarkup} autoComplete="off" />
            </div>
            <Button submit loading={saving} variant="primary">Save</Button>
          </InlineStack>
        </settingsFetcher.Form>
      </BlockStack>
    </Card>
  );
}

function UploadCard() {
  const uploadFetcher = useFetcher();
  const uploading = uploadFetcher.state !== "idle";
  const result = uploadFetcher.data;
  const [file, setFile] = useState(null);
  const formRef = useRef(null);

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
    if (uploadFetcher.state === "idle" && uploadFetcher.data?.mode === "upload" && uploadFetcher.data.ok) {
      setFile(null);
    }
  }, [uploadFetcher.state, uploadFetcher.data]);

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Upload pricelist</Text>
        <Text as="p" tone="subdued">
          Drop Nanjing Jiuguang's PDF pricelist here. Each row's own
          embedded product photo, model number, specs and price (in USD)
          are read directly from the file — their own site (jg-ledlight.com)
          has product pages but no prices anywhere, so there's nothing
          useful to pull from it beyond what this PDF already gives you.
          Driving lights, spotlights and light bars are tagged "WOEST
          Kudu"; everything else (grill/motorcycle lights, whip lights,
          rock lights, mirror lights, turn signal kits, chase lights, UTV
          pod lights/accessories, ...) is tagged "WOEST Veldt" — this is a
          best-effort auto-tag, so skim the titles and fix up any that
          landed under the wrong one, same as you'd fix any other title.
          This pricelist mixes more table layouts than most, so expect to
          lean on that title/price review a bit more than usual.
        </Text>
        {result?.mode === "upload" && result.ok === false && <Banner tone="critical" title="Couldn't process that file">{result.error}</Banner>}
        {result?.mode === "upload" && result.ok === true && (
          <Banner tone="success" title="Pricelist processed">
            {`Read ${result.total} row(s) — ${result.created} new, ${result.updated} updated.`}
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
            {uploading ? "Parsing…" : "Parse & stage products"}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function UploadCatalogCard() {
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
    fd.set("catalog", file);
    uploadFetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  }

  useEffect(() => {
    if (uploadFetcher.state === "idle" && uploadFetcher.data?.mode === "uploadCatalog" && uploadFetcher.data.ok) {
      setFile(null);
    }
  }, [uploadFetcher.state, uploadFetcher.data]);

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Upload product catalog (optional)</Text>
        <Text as="p" tone="subdued">
          Separate from the pricelist above — Jiuguang's own product
          catalog PDF has a full spec sheet per model (chip, lumens,
          voltage, housing, bracket, beam, DRL, certification, ...),
          richer than the pricelist's thin spec column. Upload it after
          staging products from the pricelist and any product it can match
          gets its description replaced with the catalog's own spec text.
          Matching is by model code, not exact — the catalog's codes often
          split one pricelist model into several size/"PRO" variants the
          pricelist itself doesn't distinguish, so a few matches are a
          best-effort pick of the closest variant rather than a guaranteed
          exact one (flagged as such below); products with no model code
          recovered from the pricelist (shown as an "NJ-..." SKU) can't be
          matched at all and keep their existing description.
        </Text>
        {result?.mode === "uploadCatalog" && result.ok === false && <Banner tone="critical" title="Couldn't process that file">{result.error}</Banner>}
        {result?.mode === "uploadCatalog" && result.ok === true && (
          <Banner tone="success" title="Catalog matched">
            {`Read ${result.catalogEntries} catalog entries. Of ${result.checked} staged product(s) with a SKU: ${result.exact} matched exactly, ${result.approx} matched approximately (closest variant), ${result.unmatched} had no match.`}
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
            <DropZone.FileUpload actionTitle="Add catalog PDF" actionHint="or drop a PDF file here" />
          )}
        </DropZone>
        <InlineStack>
          <Button onClick={handleSubmit} disabled={!file} loading={uploading} variant="primary">
            {uploading ? "Matching…" : "Match catalog to staged products"}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function WebsiteCatalogCard({ run }) {
  const fetchFetcher = useFetcher();
  const fetching = fetchFetcher.state !== "idle";
  const result = fetchFetcher.data;
  const revalidator = useRevalidator();
  const running = run?.status === "running";

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(interval);
  }, [running, revalidator]);

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between">
          <Text as="h2" variant="headingMd">Fetch from Jiuguang's website (optional)</Text>
          {run?.status === "running" && <Badge tone="info">Running</Badge>}
          {run?.status === "done" && <Badge tone="success">Done</Badge>}
          {run?.status === "failed" && <Badge tone="critical">Failed</Badge>}
        </InlineStack>
        <Text as="p" tone="subdued">
          Jiuguang's own site (jg-ledlight.com) now has a real page per
          product — a full spec table like the catalog PDF, plus (unlike
          the PDF) a real product photo. Matching is by model code, same as
          the catalog PDF upload above, and on a match both the description
          AND the photo are replaced — there's still no pricing on the
          site, so prices are untouched either way. This reads ~390 pages
          one at a time at a courteous pace, so it's a background job and
          takes a few minutes.
        </Text>
        {result?.mode === "fetchWebsiteCatalog" && result.ok === false && <Banner tone="critical">{result.error}</Banner>}
        {running && (
          <BlockStack gap="200">
            <Text as="p" tone="subdued">
              {run.statusMessage || "Starting…"}
              {" — this runs in the background, feel free to leave this tab and come back."}
            </Text>
            {run.totalFound > 0 && <ProgressBar progress={Math.round((run.totalDone / run.totalFound) * 100)} size="small" />}
          </BlockStack>
        )}
        {run?.status === "done" && run.statusMessage && <Text as="p" tone="subdued">{run.statusMessage}</Text>}
        {run?.status === "failed" && <Banner tone="critical">{run.errorLog || "Unknown error."}</Banner>}
        {run?.logTail && (
          <details>
            <summary style={{ cursor: "pointer", color: "var(--p-color-text-link, #2c6ecb)" }}>View log</summary>
            <div style={{ marginTop: 8, maxHeight: 320, overflowY: "auto", background: "#1a1a1a", color: "#e0e0e0", padding: 12, borderRadius: 6, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
              {run.logTail}
            </div>
          </details>
        )}
        <fetchFetcher.Form method="post">
          <input type="hidden" name="intent" value="fetchWebsiteCatalog" />
          <Button submit loading={fetching || running} disabled={fetching || running}>
            {running ? "Running…" : "Fetch from website"}
          </Button>
        </fetchFetcher.Form>
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
      open onClose={() => onDismiss(null)}
      title={`${conflicts.length} product(s) already exist in Shopify`}
      primaryAction={{ content: "Confirm and push", onAction: handleConfirm, loading: resolving, disabled: !allResolved || resolving }}
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
                <Text as="p" tone="subdued">{`SKU "${c.sku}" matches: ${c.matchedProductTitle} (${zar(c.matchedPrice)})`}</Text>
                <InlineStack gap="200">
                  <Button pressed={choices[c.id] === "overwrite"} onClick={() => setChoices((prev) => ({ ...prev, [c.id]: "overwrite" }))}>Overwrite existing</Button>
                  <Button pressed={choices[c.id] === "newsku"} onClick={() => setChoices((prev) => ({ ...prev, [c.id]: "newsku" }))}>Use a different SKU</Button>
                  <Button pressed={choices[c.id] === "skip"} onClick={() => setChoices((prev) => ({ ...prev, [c.id]: "skip" }))}>Skip this one</Button>
                </InlineStack>
                {choices[c.id] === "newsku" && (
                  <TextField label="New SKU" labelHidden placeholder="Enter a SKU that isn't already in use" value={newSkus[c.id] || ""} onChange={(val) => setNewSkus((prev) => ({ ...prev, [c.id]: val }))} autoComplete="off" />
                )}
              </BlockStack>
            </Card>
          ))}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export default function NanjingSource() {
  const {
    staged, pushedCount, totalCount, tabId, q, sortField, sortDir,
    shopDomain, shopifyMatches, fuzzyMatches, settings, latestWebsiteCatalogRun,
  } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const pushFetcher = useFetcher();
  const priceFetcher = useFetcher();
  const titleFetcher = useFetcher();
  const syncFetcher = useFetcher();
  const updateAllFetcher = useFetcher();
  const dedupeFetcher = useFetcher();
  const pushing = pushFetcher.state !== "idle";
  const syncing = syncFetcher.state !== "idle";
  const updatingAll = updateAllFetcher.state !== "idle";
  const dedupeing = dedupeFetcher.state !== "idle";
  const pushResult = pushFetcher.data;
  const syncResult = syncFetcher.data;
  const updateAllResult = updateAllFetcher.data;
  const dedupeResult = dedupeFetcher.data;

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
  const finalPushResult = resolvedPushResult || (pushResult?.mode === "push" && !pushResult.needsResolution ? pushResult : null);

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
    updateParams((params) => { if (searchInput) params.set("q", searchInput); else params.delete("q"); });
  }

  function handleSort(headingIndex, direction) {
    const field = SORT_FIELDS[headingIndex];
    if (!field) return;
    updateParams((params) => { params.set("sort", field); params.set("dir", direction === "ascending" ? "asc" : "desc"); });
  }

  const sortColumnIndex = sortField ? SORT_FIELDS.indexOf(sortField) : undefined;
  const sortDirection = sortDir === "asc" ? "ascending" : "descending";

  return (
    <Page title="Nanjing (WOEST Kudu / Veldt) Import">
      <BlockStack gap="400">
        <Banner tone="info">
          Nanjing Jiuguang's own site has no prices anywhere — this reads
          products straight out of their PDF pricelist (model number, spec
          text, price, and each product's own embedded photo). Products
          are rebadged under your own WOEST brand rather than Nanjing's —
          driving lights/spotlights/light bars as "WOEST Kudu", everything
          else as "WOEST Veldt" — same rebadging approach as MagicStar's
          WOEST Caraq line.
        </Banner>

        {syncResult?.mode === "syncWithShopify" && (
          <Banner tone="success" title="Synced with Shopify">
            {syncResult.reset > 0
              ? `Checked ${syncResult.checked} pushed product(s) — ${syncResult.reset} no longer exist in Shopify and were reset to Needs Review.`
              : `Checked ${syncResult.checked} pushed product(s) — all still exist in Shopify.`}
          </Banner>
        )}
        {dedupeResult?.mode === "removeDuplicates" && dedupeResult.ok === false && (
          <Banner tone="critical">{dedupeResult.error}</Banner>
        )}
        {dedupeResult?.mode === "removeDuplicates" && dedupeResult.ok === true && (
          <Banner tone={dedupeResult.removed > 0 ? "success" : "info"} title="Duplicate cleanup">
            {dedupeResult.removed > 0
              ? `Removed ${dedupeResult.removed} leftover row(s) from an earlier parsing version of the pricelist.`
              : "No leftover duplicate rows found."}
            {dedupeResult.pushedStale > 0
              ? ` ${dedupeResult.pushedStale} older row(s) look like duplicates too but are already Pushed, so they were left alone — worth a manual look.`
              : ""}
          </Banner>
        )}
        {updateAllResult?.mode === "updateAllPrices" && (
          <Banner tone={updateAllResult.ok ? "success" : "warning"} title="Prices updated">
            <BlockStack gap="100">
              <Text as="p">{`Checked ${updateAllResult.checked} matched product(s) — ${updateAllResult.updated} price(s) updated on Shopify.`}</Text>
              {updateAllResult.errors?.map((e, i) => <Text as="p" tone="critical" key={i}>{e}</Text>)}
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
              {finalPushResult.errors?.map((e, i) => <Text as="p" tone="critical" key={i}>{e}</Text>)}
            </BlockStack>
          </Banner>
        )}

        <UploadCard />
        <UploadCatalogCard />
        <WebsiteCatalogCard run={latestWebsiteCatalogRun} />

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">Staged products</Text>
              <InlineStack gap="200">
                <syncFetcher.Form method="post">
                  <input type="hidden" name="intent" value="syncWithShopify" />
                  <Button submit loading={syncing}>Sync with Shopify</Button>
                </syncFetcher.Form>
                <updateAllFetcher.Form method="post">
                  <input type="hidden" name="intent" value="updateAllPrices" />
                  <Button submit loading={updatingAll}>Update all prices</Button>
                </updateAllFetcher.Form>
                <dedupeFetcher.Form method="post">
                  <input type="hidden" name="intent" value="removeDuplicates" />
                  <Button submit loading={dedupeing}>Remove duplicates</Button>
                </dedupeFetcher.Form>
                <Button url={`/app/export/NANJING?tab=${tabId}${q ? `&q=${encodeURIComponent(q)}` : ""}`} external>Export CSV</Button>
              </InlineStack>
            </InlineStack>
            <Text as="p" tone="subdued">{`${totalCount} total staged, ${pushedCount} already pushed`}</Text>
          </BlockStack>
        </Card>

        <PricingFormulaCard settings={settings} />

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
                    label="Search by title or SKU" labelHidden placeholder="Search by title or SKU"
                    value={searchInput} onChange={setSearchInput} autoComplete="off" clearButton
                    onClearButtonClick={() => { setSearchInput(""); updateParams((params) => params.delete("q")); }}
                  />
                </div>
                <Button submit>Search</Button>
              </InlineStack>
            </form>
          </div>
          <pushFetcher.Form method="post">
            <input type="hidden" name="intent" value="push" />
            {selectedResources.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
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
            sortable={[true, true, false, true, true, false, false]}
            sortColumnIndex={sortColumnIndex === -1 ? undefined : sortColumnIndex}
            sortDirection={sortField ? sortDirection : undefined}
            onSort={handleSort}
            headings={[
              { title: "Photo / Title" },
              { title: "SKU" },
              { title: "Price (USD)" },
              { title: "Cost (ZAR)" },
              { title: "Retail (ZAR)" },
              { title: "Status" },
              { title: "In Shopify" },
            ]}
          >
            {staged.map((p, index) => {
              const sourcePrice = p.variantsJson?.variants?.[0]?.priceForeign;
              const match = p.sku ? shopifyMatches[p.sku] : null;
              const imageUrl = p.images?.[0];

              return (
                <IndexTable.Row id={p.id} key={p.id} selected={selectedResources.includes(p.id)} position={index}>
                  <IndexTable.Cell>
                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                      {imageUrl && (
                        <Link url={imageUrl} target="_blank">
                          <Thumbnail size="small" source={imageUrl} alt={p.title} />
                        </Link>
                      )}
                      <TitleCell id={p.id} title={p.title} saveFetcher={titleFetcher} />
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{p.sku || "—"}</IndexTable.Cell>
                  <IndexTable.Cell>{usd(sourcePrice)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <PriceCell id={p.id} label="Cost" value={p.costZar} field="costZar" saveFetcher={priceFetcher} />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <PriceCell id={p.id} label="Retail" value={p.retailZar} field="retailZar" saveFetcher={priceFetcher} />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="100">
                      <Badge tone={p.status === "PUSHED" ? "success" : undefined}>{p.status}</Badge>
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
          onDismiss={(result) => { setModalDismissed(true); if (result) setResolvedPushResult(result); }}
        />
      )}
    </Page>
  );
}
