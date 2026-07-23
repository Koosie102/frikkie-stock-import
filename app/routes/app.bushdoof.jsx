import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page, Card, BlockStack, Text, Button, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { fetchAllProducts, mapShopifyProduct } from "../adapters/shopifySource.server";

// TODO: confirm Bushdoof's storefront domain matches what the original
// Node script used against their product.json endpoint.
const BUSHDOOF_DOMAIN = "bushdoof.com.au";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const staged = await db.stagedProduct.findMany({
    where: { source: "BUSHDOOF" },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return { staged };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const run = await db.importRun.create({
    data: { source: "BUSHDOOF", status: "running" },
  });

  try {
    const products = await fetchAllProducts(BUSHDOOF_DOMAIN);

    await db.$transaction(
      products.map((p) =>
        db.stagedProduct.create({
          data: {
            runId: run.id,
            source: "BUSHDOOF",
            ...mapShopifyProduct(p, BUSHDOOF_DOMAIN),
            // TODO: port the AUD x 13.5 = ZAR cost, x1.3 retail, round-to-R99
            // pricing formula from the original Bushdoof Node script here.
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

export default function BushdoofSource() {
  const { staged } = useLoaderData();
  const fetcher = useFetcher();
  const running = fetcher.state !== "idle";

  return (
    <Page title="Bushdoof Import">
      <BlockStack gap="400">
        <Banner tone="warning">
          Pricing formula and tag taxonomy from the original Node script
          still need porting into this route — see the TODO in
          app.bushdoof.jsx. Fetching works; pricing doesn't yet.
        </Banner>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Fetch catalog
            </Text>
            <fetcher.Form method="post">
              <Button submit loading={running} variant="primary">
                {running ? "Fetching…" : "Fetch Bushdoof products"}
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
