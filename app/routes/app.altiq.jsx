import { useState } from "react";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Button,
  Banner,
  IndexTable,
  useIndexResourceState,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { fetchAllProducts, mapShopifyProduct } from "../adapters/shopifySource.server";
import { pushStagedProduct } from "../adapters/shopifyPush.server";

const ALTIQ_DOMAIN = "altiq.com.au";
const RETAIL_MULTIPLIER = 24.5;

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const staged = await db.stagedProduct.findMany({
    where: { source: "ALTIQ", status: { not: "PUSHED" } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const pushedCount = await db.stagedProduct.count({
    where: { source: "ALTIQ", status: "PUSHED" },
  });
  return { staged, pushedCount };
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

  if (intent === "push") {
    const ids = formData.getAll("ids");
    let pushed = 0;
    const errors = [];

    for (const id of ids) {
      const staged = await db.stagedProduct.findUnique({ where: { id } });
      if (!staged) continue;

      try {
        const shopifyProductId = await pushStagedProduct(admin, staged);
        await db.stagedProduct.update({
          where: { id },
          data: { status: "PUSHED", shopifyProductId },
        });
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

export default function AltiqSource() {
  const { staged, pushedCount } = useLoaderData();
  const fetchFetcher = useFetcher();
  const pushFetcher = useFetcher();
  const fetching = fetchFetcher.state !== "idle";
  const pushing = pushFetcher.state !== "idle";
  const fetchResult = fetchFetcher.data;
  const pushResult = pushFetcher.data;

  const resourceName = { singular: "product", plural: "products" };
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(staged);

  const zar = (n) => (n == null ? "—" : `R${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  return (
    <Page title="ALTIQ Import">
      <BlockStack gap="400">
        <Banner tone="info">
          Pulls the live ALTIQ catalog from altiq.com.au/products.json and
          prices at AUD retail × {RETAIL_MULTIPLIER}. Pushed products land
          as Drafts in your store so nothing goes live automatically —
          review and publish from the Shopify admin once you're happy.
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
            <Text as="h2" variant="headingMd">Fetch catalog</Text>
            <fetchFetcher.Form method="post">
              <input type="hidden" name="intent" value="fetch" />
              <Button submit loading={fetching} variant="primary">
                {fetching ? "Fetching…" : "Fetch ALTIQ products"}
              </Button>
            </fetchFetcher.Form>
            <Text as="p" tone="subdued">
              {`${staged.length} staged, ${pushedCount} already pushed`}
            </Text>
          </BlockStack>
        </Card>

        <Card padding="0">
          <pushFetcher.Form method="post">
            <input type="hidden" name="intent" value="push" />
            {selectedResources.map((id) => (
              <input key={id} type="hidden" name="ids" value={id} />
            ))}
            <div style={{ padding: "16px 16px 0" }}>
              <Button
                submit
                disabled={selectedResources.length === 0}
                loading={pushing}
              >
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
                { title: "Retail (ZAR)" },
                { title: "Status" },
              ]}
            >
              {staged.map((p, index) => (
                <IndexTable.Row
                  id={p.id}
                  key={p.id}
                  selected={selectedResources.includes(p.id)}
                  position={index}
                >
                  <IndexTable.Cell>{p.title}</IndexTable.Cell>
                  <IndexTable.Cell>{p.sku || "—"}</IndexTable.Cell>
                  <IndexTable.Cell>{zar(p.retailZar)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge>{p.status}</Badge>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </pushFetcher.Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
