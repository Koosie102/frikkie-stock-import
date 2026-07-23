import { useState } from "react";
import { useFetcher } from "@remix-run/react";
import { AppProvider, Page, Card, FormLayout, TextField, Button, BlockStack, Text } from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json" with { type: "json" };
import { login } from "../../shopify.server";

export const loader = async ({ request }) => {
  const errors = await login(request);
  return { errors: errors || {} };
};

export const action = async ({ request }) => {
  const errors = await login(request);
  return { errors: errors || {} };
};

export default function Login() {
  const [shop, setShop] = useState("");
  const fetcher = useFetcher();
  const errors = fetcher.data?.errors || {};

  return (
    <AppProvider i18n={polarisTranslations}>
      <Page narrowWidth>
        <Card>
          <fetcher.Form method="post">
            <BlockStack gap="400">
              <Text as="h1" variant="headingLg">
                Frikkie's Stock Importer
              </Text>
              <FormLayout>
                <TextField
                  label="Shop domain"
                  name="shop"
                  value={shop}
                  onChange={setShop}
                  autoComplete="on"
                  placeholder="4x4-factory-sa.myshopify.com"
                  error={errors.shop}
                />
                <Button submit variant="primary">
                  Log in
                </Button>
              </FormLayout>
            </BlockStack>
          </fetcher.Form>
        </Card>
      </Page>
    </AppProvider>
  );
}
