import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page, Card, BlockStack, Text, Button, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { fetchAllProducts, mapShopifyProduct } from "../adapters/shopifySource.server";

const ALTIQ_DOMAIN = "altiq.com.au";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const staged = await db.stagedProduct.findMany({
    where: { source: "ALTIQ" },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return { staged };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const run = await db.importRun.create({
    data: { source: "ALTIQ", status: "running" },
  });

  try {
    const products = await fetchAllProducts(ALTIQ_DOMAIN);

    await db.$transaction(
      products.map((p) =>
        db.stagedProduct.create({
          data: {
            runId: run.id,
            source: "ALTIQ",
            ...mapShopifyProduct(p, ALTIQ_DOMAIN),
            // TODO: match SKUs against the ultradealer.com.au trade export
            // once you drop that CSV in — costForeign/costZar/retailZar stay
            // null (status NEEDS_REVIEW) until then.
            status: "NEEDS_REVIEW",
          },
        }),
      ),
    );

    await db.importRun.update({
      where: { id: run.id },
      data: { status: "done", totalFound: products.length, totalDone: products.length, finishedAt: new Date() },
    });
  } catch (err) {
    await db.importRun.update({
      where: { id: run.id },
      data: { status: "failed", errorLog: String(err), finishedAt: new Date() },
    });
  }

  return null;
};

export default function AltiqSource() {
  const { staged } = useLoaderData();
  const fetcher = useFetcher();
  const running = fetcher.state !== "idle";

  return (
    <Page title="ALTIQ Import">
      <BlockStack gap="400">
        <Banner tone="info">
          Pulls the live ALTIQ catalog straight from their Shopify storefront
          (altiq.com.au/products.json). Trade cost from ultradealer.com.au
          still needs to be matched in manually by SKU — that portal is
          password-protected, so it can't be scraped automatically.
        </Banner>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Fetch catalog
            </Text>
            <fetcher.Form method="post">
              <Button submit loading={running} variant="primary">
                {running ? "Fetching…" : "Fetch ALTIQ products"}
              </Button>
            </fetcher.Form>
            <Text as="p" tone="subdued">
              {staged.length} products staged so far (showing latest 50)
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
