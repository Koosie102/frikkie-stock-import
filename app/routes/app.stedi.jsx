import { Page, Card, BlockStack, Text, Banner, List } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function StediSource() {
  return (
    <Page title="STEDI Import">
      <BlockStack gap="400">
        <Banner tone="warning" title="Not yet ported">
          <Text as="p">
            This tab is a placeholder. The working scraper lives in the
            standalone STEDI Import Manager (Flask app) — next step is
            porting it into a server-side module here:
          </Text>
        </Banner>
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              To port from the existing STEDI Import Manager
            </Text>
            <List type="bullet">
              <List.Item>
                Category + pagination scrape of www.stedi.com.au (Cloudflare
                needs full browser-like headers, confirmed working)
              </List.Item>
              <List.Item>
                JSON-LD product parsing, incl. grouped-product AggregateOffer
                variant extraction
              </List.Item>
              <List.Item>
                Pricing: retail (ZAR) = AUD price × 24, rounded up to
                nearest R99; cost = retail × 0.6
              </List.Item>
              <List.Item>
                Tag mapping from AU category path → existing Shopify tags
              </List.Item>
              <List.Item>Local image download step (optional here — Shopify media upload can pull directly from source URLs instead)</List.Item>
            </List>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
