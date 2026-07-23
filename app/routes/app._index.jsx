import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, InlineGrid, Badge } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const SOURCES = [
  { key: "STEDI", label: "STEDI", path: "/app/stedi", note: "Scraped from stedi.com.au" },
  { key: "BUSHDOOF", label: "Bushdoof", path: "/app/bushdoof", note: "Shopify products.json" },
  { key: "ULTRA_VISION", label: "Ultra Vision", path: "/app/ultra-vision", note: "WooCommerce + pricelist" },
  { key: "ALTIQ", label: "ALTIQ", path: "/app/altiq", note: "Shopify products.json" },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const counts = await db.stagedProduct.groupBy({
    by: ["source", "status"],
    _count: true,
  });

  return { counts };
};

export default function Dashboard() {
  const { counts } = useLoaderData();

  const countFor = (source) =>
    counts.filter((c) => c.source === source).reduce((sum, c) => sum + c._count, 0);

  const pushedFor = (source) =>
    counts.find((c) => c.source === source && c.status === "PUSHED")?._count || 0;

  return (
    <Page title="Frikkie's Stock Importer">
      <Layout>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            {SOURCES.map((s) => (
              <Card key={s.key}>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    {s.label}
                  </Text>
                  <Text as="p" tone="subdued">
                    {s.note}
                  </Text>
                  <BlockStack gap="100">
                    <Text as="p">{countFor(s.key)} staged</Text>
                    <Badge tone={pushedFor(s.key) > 0 ? "success" : undefined}>
                      {`${pushedFor(s.key)} pushed`}
                    </Badge>
                  </BlockStack>
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
