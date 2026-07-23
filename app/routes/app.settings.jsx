import { Page, Card, BlockStack, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function Settings() {
  return (
    <Page title="Settings">
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            Per-source settings
          </Text>
          <Text as="p" tone="subdued">
            Pricing multipliers, tag map overrides, and other per-brand
            settings (replacing each old app's local settings.json) will
            live here, backed by the SourceSettings table.
          </Text>
        </BlockStack>
      </Card>
    </Page>
  );
}
