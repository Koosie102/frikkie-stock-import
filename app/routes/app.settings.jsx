import { useState } from "react";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Button, Banner, TextField } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getSourceSettings, saveSourceSettings } from "../utils/sourceSettings.server";
import { recalculateStagedPrices } from "../utils/recalcPricing.server";
import { DEFAULT_SETTINGS, PRICING_FUNCTIONS } from "../utils/pricingFormulas";

// One entry per source: which fields it has, how to label them, and a
// plain-language description of the formula — kept in sync with each
// source's own "Pricing formula" card (the fields/description here
// should read the same as what's on the ALTIQ/TrailBait/etc. tab
// itself, since this page edits the exact same underlying settings).
const SOURCE_CONFIGS = [
  {
    key: "ALTIQ",
    label: "ALTIQ",
    description: "Retail = AUD price × multiplier, rounded up to the nearest R99. Cost = Retail × cost ratio.",
    fields: [
      { name: "retailMultiplier", label: "Retail multiplier", step: "0.1" },
      { name: "costRatio", label: "Cost as ratio of retail", step: "0.01", helpText: "e.g. 0.6 = 60%", max: 1 },
    ],
  },
  {
    key: "TRAILBAIT",
    label: "TrailBait",
    description: "Retail = AUD price × multiplier, rounded up to the nearest R99. Cost = Retail × cost ratio.",
    fields: [
      { name: "sourceMultiplier", label: "Retail multiplier", step: "0.1" },
      { name: "costRatio", label: "Cost as ratio of retail", step: "0.01", helpText: "e.g. 0.6 = 60%", max: 1 },
    ],
  },
  {
    key: "BUSHDOOF",
    label: "Bushdoof",
    description: "Cost = AUD price × cost multiplier. Retail = Cost × retail markup, rounded to the nearest R99.",
    fields: [
      { name: "costMultiplier", label: "Cost multiplier", step: "0.1" },
      { name: "retailMarkup", label: "Retail markup", step: "0.01", helpText: "e.g. 1.3 = cost + 30%" },
    ],
  },
  {
    key: "STEDI",
    label: "STEDI",
    description: "Retail = AUD price × multiplier, rounded up to the nearest R99. Cost = Retail × cost ratio.",
    fields: [
      { name: "sourceMultiplier", label: "Retail multiplier", step: "0.1" },
      { name: "costRatio", label: "Cost as ratio of retail", step: "0.01", helpText: "e.g. 0.6 = 60%", max: 1 },
    ],
  },
  {
    key: "MODS300",
    label: "300mods",
    description: "Retail = AUD price × multiplier, rounded up to the nearest R99. Cost = Retail × cost ratio.",
    fields: [
      { name: "retailMultiplier", label: "Retail multiplier", step: "0.1" },
      { name: "costRatio", label: "Cost as ratio of retail", step: "0.01", helpText: "e.g. 0.6 = 60%", max: 1 },
    ],
  },
  {
    key: "ULTRA_VISION",
    label: "Ultra Vision",
    description: "Estimated only — no landed-cost data available yet. Retail = AUD SRP × multiplier, rounded to the nearest R×90.",
    fields: [
      { name: "srpMultiplier", label: "SRP multiplier", step: "0.5" },
    ],
  },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const settingsBySource = {};
  for (const config of SOURCE_CONFIGS) {
    settingsBySource[config.key] = await getSourceSettings(db, config.key, DEFAULT_SETTINGS[config.key]);
  }

  return { settingsBySource };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "updateSettings") {
    const source = formData.get("source");
    const config = SOURCE_CONFIGS.find((c) => c.key === source);
    if (!config) {
      return { ok: false, mode: "updateSettings", source, error: "Unknown source." };
    }

    const newSettings = {};
    for (const field of config.fields) {
      const value = parseFloat(formData.get(field.name));
      if (Number.isNaN(value) || value <= 0 || (field.max != null && value > field.max)) {
        const boundHint = field.max != null ? ` between 0 and ${field.max}` : "";
        return { ok: false, mode: "updateSettings", source, error: `${field.label} must be a positive number${boundHint}.` };
      }
      newSettings[field.name] = value;
    }

    await saveSourceSettings(db, source, newSettings);
    const updated = await recalculateStagedPrices(db, source, (price) => PRICING_FUNCTIONS[source](price, newSettings));
    return { ok: true, mode: "updateSettings", source, updated };
  }

  return null;
};

function SourceSettingsCard({ config, settings }) {
  const fetcher = useFetcher();
  const saving = fetcher.state !== "idle";
  const result = fetcher.data;
  const [values, setValues] = useState(
    Object.fromEntries(config.fields.map((f) => [f.name, String(settings[f.name] ?? "")])),
  );

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">{config.label}</Text>
        <Text as="p" tone="subdued">{config.description}</Text>

        {result?.mode === "updateSettings" && result.source === config.key && result.ok === false && (
          <Banner tone="critical">{result.error}</Banner>
        )}
        {result?.mode === "updateSettings" && result.source === config.key && result.ok === true && (
          <Banner tone="success">{`Saved. Recalculated ${result.updated} product(s) — including already-pushed ones, so the price-differs-from-live indicator will show where Shopify needs updating.`}</Banner>
        )}

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="updateSettings" />
          <input type="hidden" name="source" value={config.key} />
          <InlineStack gap="200" blockAlign="end" wrap>
            {config.fields.map((field) => (
              <div key={field.name} style={{ maxWidth: 220 }}>
                <TextField
                  label={field.label}
                  helpText={field.helpText}
                  type="number"
                  step={field.step}
                  max={field.max}
                  name={field.name}
                  value={values[field.name]}
                  onChange={(val) => setValues((prev) => ({ ...prev, [field.name]: val }))}
                  autoComplete="off"
                />
              </div>
            ))}
            <Button submit loading={saving} variant="primary">Save</Button>
          </InlineStack>
        </fetcher.Form>
      </BlockStack>
    </Card>
  );
}

export default function Settings() {
  const { settingsBySource } = useLoaderData();

  return (
    <Page title="Settings">
      <BlockStack gap="400">
        <Banner tone="info">
          Pricing formulas for every source, in one place — the same
          settings as each source's own "Pricing formula" card, editable
          here without switching tabs. Saving recalculates that source's
          staged prices immediately, including already-pushed products
          (this only updates the number shown in the review table — it
          never touches Shopify directly; use the source's own "Update
          all prices" button, or the per-row Sync button, to push a
          changed price to Shopify).
        </Banner>

        {SOURCE_CONFIGS.map((config) => (
          <SourceSettingsCard key={config.key} config={config} settings={settingsBySource[config.key]} />
        ))}
      </BlockStack>
    </Page>
  );
}
