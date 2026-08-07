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
import { pushStagedProduct } from "../adapters/shopifyPush.server";
import { matchSkusToShopify } from "../adapters/shopifyMatch.server";
import { productIdToAdminPath } from "../utils/shopify";
import { buildStagedQuery } from "../utils/stagedQuery.server";
import { upsertStagedProducts } from "../utils/stagedUpsert.server";
import { recalculateStagedPrices } from "../utils/recalcPricing.server";
import { getSourceSettings, saveSourceSettings } from "../utils/sourceSettings.server";

// Was bushdoof.com.au in the original scaffold with a TODO to confirm —
// verified their real storefront is bushdoof.co (Shopify-hosted,
// checkout-api-token confirmed); .com.au isn't their store.
const BUSHDOOF_DOMAIN = "bushdoof.co";
const BUSHDOOF_BRAND = "BUSHDOOF";
const BUSHDOOF_LOGO = "https://bushdoof.co/cdn/shop/files/BD_Icon_-_3.png?v=1746064836";

// Editable via the Pricing formula card below — persisted in
// SourceSettings, these are just the fallback if nothing's been saved yet.
// Cost (ZAR) = AUD price x costMultiplier. Retail (ZAR) = Cost x
// retailMarkup, rounded to the *nearest* R99 (not rounded up, per the
// original Bushdoof Node script's formula — differs from
// STEDI/TrailBait's round-up rule).
const DEFAULT_SETTINGS = { costMultiplier: 13.5, retailMarkup: 1.3 };

function bushdoofPricing(priceForeign, settings) {
  const costZar = Math.round(priceForeign * settings.costMultiplier * 100) / 100;
  const rawRetail = costZar * settings.retailMarkup;
  const retailZar = Math.round((rawRetail + 1) / 100) * 100 - 1; // nearest X99
  return { retailZar, costZar, priceIsEstimated: true };
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
  const { where, orderBy, tabId, q, sortField, sortDir } = buildStagedQuery("BUSHDOOF", url, TABS);

  const staged = await db.stagedProduct.findMany({ where, orderBy, take: 150 });

  const counts = await db.stagedProduct.groupBy({
    by: ["status"],
    where: { source: "BUSHDOOF" },
    _count: true,
  });
  const pushedCount = counts.find((c) => c.status === "PUSHED")?._count || 0;
  const totalCount = counts.reduce((sum, c) => sum + c._count, 0);

  const skus = staged.map((p) => p.sku).filter(Boolean);
  const shopifyMatches = await matchSkusToShopify(admin, skus);
  const settings = await getSourceSettings(db, "BUSHDOOF", DEFAULT_SETTINGS);

  return { staged, pushedCount, totalCount, tabId, q, sortField, sortDir, shopDomain: session.shop, shopifyMatches, settings };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "fetch") {
    const settings = await getSourceSettings(db, "BUSHDOOF", DEFAULT_SETTINGS);
    const run = await db.importRun.create({ data: { source: "BUSHDOOF", status: "running" } });
    try {
      const products = await fetchAllProducts(BUSHDOOF_DOMAIN);
      const mapped = products.map((p) =>
        mapShopifyProduct(p, BUSHDOOF_DOMAIN, undefined, (price) => bushdoofPricing(price, settings), BUSHDOOF_BRAND),
      );
      const { created, updated } = await upsertStagedProducts(db, run.id, "BUSHDOOF", mapped);
      await db.importRun.update({
        where: { id: run.id },
        data: { status: "done", totalFound: products.length, totalDone: products.length, finishedAt: new Date() },
      });
      return { ok: true, mode: "fetch", created, updated };
    } catch (err) {
      console.error("Bushdoof import failed:", err);
      await db.importRun.update({
        where: { id: run.id },
        data: { status: "failed", errorLog: String(err), finishedAt: new Date() },
      });
      return { ok: false, mode: "fetch", error: String(err) };
    }
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
    const costMultiplier = parseFloat(formData.get("costMultiplier"));
    const retailMarkup = parseFloat(formData.get("retailMarkup"));
    if (Number.isNaN(costMultiplier) || costMultiplier <= 0) {
      return { ok: false, mode: "updateSettings", error: "Cost multiplier must be a positive number." };
    }
    if (Number.isNaN(retailMarkup) || retailMarkup <= 0) {
      return { ok: false, mode: "updateSettings", error: "Retail markup must be a positive number." };
    }
    await saveSourceSettings(db, "BUSHDOOF", { costMultiplier, retailMarkup });
    const updated = await recalculateStagedPrices(db, "BUSHDOOF", (price) =>
      bushdoofPricing(price, { costMultiplier, retailMarkup }),
    );
    return { ok: true, mode: "updateSettings", updated };
  }

  if (intent === "push") {
    const ids = formData.getAll("ids");
    let pushed = 0;
    const errors = [];
    for (const id of ids) {
      const staged = await db.stagedProduct.findUnique({ where: { id } });
      if (!staged) continue;
      try {
        const shopifyProductId = await pushStagedProduct(admin, staged);
        await db.stagedProduct.update({ where: { id }, data: { status: "PUSHED", shopifyProductId } });
        pushed += 1;
      } catch (err) {
        console.error(`Bushdoof push failed for ${staged.title}:`, err);
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

function PricingFormulaCard({ settings }) {
  const settingsFetcher = useFetcher();
  const saving = settingsFetcher.state !== "idle";
  const result = settingsFetcher.data;
  const [costMultiplier, setCostMultiplier] = useState(String(settings.costMultiplier));
  const [retailMarkup, setRetailMarkup] = useState(String(settings.retailMarkup));

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Pricing formula</Text>
        <Text as="p" tone="subdued">
          Cost (ZAR) = AUD price × cost multiplier. Retail (ZAR) = Cost ×
          retail markup, rounded to the nearest R99. Saving recalculates
          every un-pushed staged product's price with the new formula —
          products already pushed to Shopify are left untouched.
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
                label="AUD → ZAR cost multiplier"
                type="number"
                step="0.1"
                name="costMultiplier"
                value={costMultiplier}
                onChange={setCostMultiplier}
                autoComplete="off"
              />
            </div>
            <div style={{ maxWidth: 200 }}>
              <TextField
                label="Retail markup on cost"
                helpText="e.g. 1.3 = 30% markup"
                type="number"
                step="0.01"
                name="retailMarkup"
                value={retailMarkup}
                onChange={setRetailMarkup}
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

export default function BushdoofSource() {
  const { staged, pushedCount, totalCount, tabId, q, sortField, sortDir, shopDomain, shopifyMatches, settings } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetchFetcher = useFetcher();
  const pushFetcher = useFetcher();
  const priceFetcher = useFetcher();
  const fetching = fetchFetcher.state !== "idle";
  const pushing = pushFetcher.state !== "idle";
  const fetchResult = fetchFetcher.data;
  const pushResult = pushFetcher.data;

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
    <Page
      title="Bushdoof Import"
      titleMetadata={<img src={BUSHDOOF_LOGO} alt="Bushdoof" style={{ height: 24, borderRadius: 4 }} />}
    >
      <BlockStack gap="400">
        <Banner tone="info">
          Pulls the live Bushdoof catalog from bushdoof.co/products.json
          (their storefront runs on Shopify) and formats titles as
          "BUSHDOOF Title Cased Rest". Re-fetching updates existing staged
          products (title/images/description/tags) instead of duplicating
          them — it won't touch prices you've already edited or revert
          anything already pushed. Pushed products bring their
          description and images across automatically and land as
          Drafts, so nothing goes live without review.
        </Banner>

        {fetchResult?.mode === "fetch" && fetchResult.ok === false && (
          <Banner tone="critical" title="Fetch failed">{fetchResult.error}</Banner>
        )}
        {fetchResult?.mode === "fetch" && fetchResult.ok === true && (
          <Banner tone="success" title="Fetch complete">
            {`${fetchResult.created} new, ${fetchResult.updated} updated.`}
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

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">Fetch catalog</Text>
              <InlineStack gap="200">
                <Button url={`/app/export/BUSHDOOF?tab=${tabId}${q ? `&q=${encodeURIComponent(q)}` : ""}`} external>
                  Export CSV
                </Button>
                <fetchFetcher.Form method="post">
                  <input type="hidden" name="intent" value="fetch" />
                  <Button submit loading={fetching} variant="primary">
                    {fetching ? "Fetching…" : "Fetch Bushdoof products"}
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
                      {match ? (
                        <Link url={`https://${shopDomain}${productIdToAdminPath(match.productId)}`} target="_blank">
                          {`${zar(match.price)} (${match.status})`}
                        </Link>
                      ) : (
                        <Text as="span" tone="subdued">Not in store</Text>
                      )}
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
