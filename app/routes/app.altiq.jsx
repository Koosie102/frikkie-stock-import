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

const ALTIQ_DOMAIN = "altiq.com.au";
const RETAIL_MULTIPLIER = 24.5;

const TABS = [
  { id: "all", label: "All", filter: {} },
  { id: "new", label: "New", filter: { status: { in: ["NEW", "NEEDS_REVIEW"] } } },
  { id: "pushed", label: "Pushed", filter: { status: "PUSHED" } },
];

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const tabId = url.searchParams.get("tab") || "all";
  const tab = TABS.find((t) => t.id === tabId) || TABS[0];

  const staged = await db.stagedProduct.findMany({
    where: { source: "ALTIQ", ...tab.filter },
    orderBy: { createdAt: "desc" },
    take: 150,
  });

  const counts = await db.stagedProduct.groupBy({
    by: ["status"],
    where: { source: "ALTIQ" },
    _count: true,
  });
  const pushedCount = counts.find((c) => c.status === "PUSHED")?._count || 0;
  const totalCount = counts.reduce((sum, c) => sum + c._count, 0);

  const skus = staged.map((p) => p.sku).filter(Boolean);
  const shopifyMatches = await matchSkusToShopify(admin, skus);

  return { staged, pushedCount, totalCount, tabId, shopDomain: session.shop, shopifyMatches };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "fetch") {
    const run = await db.importRun.create({ data: { source: "ALTIQ", status: "running" } });
    try {
      const products = await fetchAllProducts(ALTIQ_DOMAIN);
      await db.$transaction(
        products.map((p) =>
          db.stagedProduct.create({
            data: {
              runId: run.id,
              source: "ALTIQ",
              ...mapShopifyProduct(p, ALTIQ_DOMAIN, RETAIL_MULTIPLIER),
              status: "NEW",
            },
          }),
        ),
      );
      await db.importRun.update({
        where: { id: run.id },
        data: { status: "done", totalFound: products.length, totalDone: products.length, finishedAt: new Date() },
      });
      return { ok: true, mode: "fetch", count: products.length };
    } catch (err) {
      console.error("ALTIQ import failed:", err);
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
        console.error(`ALTIQ push failed for ${staged.title}:`, err);
        errors.push(`${staged.title}: ${String(err.message || err)}`);
      }
    }
    return { ok: errors.length === 0, mode: "push", pushed, errors };
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

export default function AltiqSource() {
  const { staged, pushedCount, totalCount, tabId, shopDomain, shopifyMatches } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetchFetcher = useFetcher();
  const pushFetcher = useFetcher();
  const priceFetcher = useFetcher();
  const fetching = fetchFetcher.state !== "idle";
  const pushing = pushFetcher.state !== "idle";
  const fetchResult = fetchFetcher.data;
  const pushResult = pushFetcher.data;

  const resourceName = { singular: "product", plural: "products" };
  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(staged);

  const selectedTabIndex = TABS.findIndex((t) => t.id === tabId);

  return (
    <Page title="ALTIQ Import">
      <BlockStack gap="400">
        <Banner tone="info">
          Pulls the live ALTIQ catalog from altiq.com.au/products.json and
          prices at AUD retail × {RETAIL_MULTIPLIER}. Edit Retail/Cost
          inline below before pushing — pushed products land as Drafts, so
          nothing goes live automatically.
        </Banner>

        {fetchResult?.mode === "fetch" && fetchResult.ok === false && (
          <Banner tone="critical" title="Fetch failed">{fetchResult.error}</Banner>
        )}
        {fetchResult?.mode === "fetch" && fetchResult.ok === true && (
          <Banner tone="success" title="Fetch complete">{`Staged ${fetchResult.count} products.`}</Banner>
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
              <fetchFetcher.Form method="post">
                <input type="hidden" name="intent" value="fetch" />
                <Button submit loading={fetching} variant="primary">
                  {fetching ? "Fetching…" : "Fetch ALTIQ products"}
                </Button>
              </fetchFetcher.Form>
            </InlineStack>
            <Text as="p" tone="subdued">
              {`${totalCount} total staged, ${pushedCount} already pushed`}
            </Text>
          </BlockStack>
        </Card>

        <Card padding="0">
          <Tabs
            tabs={TABS.map((t) => ({ id: t.id, content: t.label }))}
            selected={selectedTabIndex === -1 ? 0 : selectedTabIndex}
            onSelect={(index) => {
              const params = new URLSearchParams(searchParams);
              params.set("tab", TABS[index].id);
              setSearchParams(params);
            }}
          />
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
              headings={[
                { title: "Title" },
                { title: "SKU" },
                { title: "Variants" },
                { title: "Cost (ZAR)" },
                { title: "Retail (ZAR)" },
                { title: "Status" },
                { title: "In Shopify" },
              ]}
            >
              {staged.map((p, index) => {
                const variantCount = p.variantsJson?.variants?.length || 0;
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
