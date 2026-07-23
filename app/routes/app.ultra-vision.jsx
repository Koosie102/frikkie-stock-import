import { Page, Card, BlockStack, Text, Banner, List } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function UltraVisionSource() {
  return (
    <Page title="Ultra Vision Import">
      <BlockStack gap="400">
        <Banner tone="warning" title="Not yet ported">
          <Text as="p">
            Placeholder — the working logic lives in the standalone Ultra
            Vision Import Manager (most mature of the three original apps).
            Port order: this one first, since it's already battle-tested
            against real pushes.
          </Text>
        </Banner>
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              To port from the existing Ultra Vision Import Manager
            </Text>
            <List type="bullet">
              <List.Item>Distributor pricelist + WooCommerce export merge (SKU fuzzy-matching across the two systems)</List.Item>
              <List.Item>live_refresh.py — WooCommerce Store API pull for content that's gone stale in the CSV export</List.Item>
              <List.Item>Cost-driven pricing model (landed cost × 1.5) with SRP fallback (×18) flagged ESTIMATED</List.Item>
              <List.Item>Grouped-variant push (parent/child SKUs → one Shopify product, 3-option limit workaround, per-variant images)</List.Item>
              <List.Item>Smart collection + navigation menu one-click builder</List.Item>
            </List>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
