import { Link, useLoaderData } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Badge } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { BRAND_LABELS } from "../utils/vendorNames";

const HERO_IMAGE =
  "https://cdn.shopify.com/s/files/1/0539/2878/8145/files/4x4_Factory_Logo_-_Banner_suppliers.png?v=1785162136";

const SOURCES = [
  { key: "STEDI", label: "STEDI", path: "/app/stedi", note: "Scraped from stedi.com.au" },
  { key: "BUSHDOOF", label: "Bushdoof", path: "/app/bushdoof", note: "Shopify products.json" },
  { key: "ULTRA_VISION", label: "Ultra Vision", path: "/app/ultra-vision", note: "WooCommerce + pricelist" },
  { key: "ALTIQ", label: "ALTIQ", path: "/app/altiq", note: "Shopify products.json" },
  { key: "TRAILBAIT", label: "TrailBait", path: "/app/trailbait", note: "Shopify products.json" },
  { key: "MODS300", label: "300mods", path: "/app/mods300", note: "Shopify products.json" },
  { key: "MAGICSTAR", label: BRAND_LABELS.MAGICSTAR, path: "/app/magicstar", note: "PDF pricelist upload" },
  { key: "NANJING", label: BRAND_LABELS.NANJING, path: "/app/nanjing", note: "PDF pricelist upload" },
  { key: "OZZ", label: BRAND_LABELS.OZZ, path: "/app/ozz", note: "WooCommerce + pricelist (pricing pending)" },
];

const MANAGE_LINKS = [
  { key: "collections", label: "Collections", path: "/app/collections", note: "Smart-collection rules and menu sync, per brand" },
  { key: "settings", label: "Settings", path: "/app/settings", note: "Pricing formulas and other app-wide options" },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const counts = await db.stagedProduct.groupBy({
    by: ["source", "status"],
    _count: true,
  });

  return { counts };
};

// A whole Card wrapped as one Remix Link, so the entire tile is clickable
// rather than just a title or a button inside it — the person can click
// anywhere on a source's card to open it.
function ClickableCard({ to, children }) {
  return (
    <Link to={to} className="dashboard-card-link">
      <Card padding="400">{children}</Card>
    </Link>
  );
}

function SourceCard({ source, staged, pushed }) {
  const pct = staged > 0 ? Math.round((pushed / staged) * 100) : 0;
  return (
    <ClickableCard to={source.path}>
      <BlockStack gap="300">
        <BlockStack gap="050">
          <Text as="h2" variant="headingMd">{source.label}</Text>
          <Text as="p" tone="subdued">{source.note}</Text>
        </BlockStack>
        <BlockStack gap="150">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p">{`${staged} staged`}</Text>
            <Badge tone={pushed > 0 ? "success" : undefined}>{`${pushed} pushed`}</Badge>
          </InlineStack>
          <div className="dashboard-progress-track">
            <div className="dashboard-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </BlockStack>
      </BlockStack>
    </ClickableCard>
  );
}

function ManageCard({ item }) {
  return (
    <ClickableCard to={item.path}>
      <BlockStack gap="050">
        <Text as="h2" variant="headingMd">{item.label}</Text>
        <Text as="p" tone="subdued">{item.note}</Text>
      </BlockStack>
    </ClickableCard>
  );
}

export default function Dashboard() {
  const { counts } = useLoaderData();

  const countFor = (source) =>
    counts.filter((c) => c.source === source).reduce((sum, c) => sum + c._count, 0);

  const pushedFor = (source) =>
    counts.find((c) => c.source === source && c.status === "PUSHED")?._count || 0;

  const totalStaged = SOURCES.reduce((sum, s) => sum + countFor(s.key), 0);
  const totalPushed = SOURCES.reduce((sum, s) => sum + pushedFor(s.key), 0);

  return (
    <Page title="Frikkie's Stock Importer">
      <style>{`
        .dashboard-card-link {
          text-decoration: none;
          color: inherit;
          display: block;
        }
        .dashboard-card-link .Polaris-Card {
          transition: box-shadow 120ms ease, transform 120ms ease;
        }
        .dashboard-card-link:hover .Polaris-Card {
          box-shadow: var(--p-shadow-400, 0 4px 12px rgba(0,0,0,0.12));
          transform: translateY(-1px);
        }
        .dashboard-hero {
          width: 100%;
          height: auto;
          display: block;
          border-radius: var(--p-border-radius-300, 12px);
        }
        .dashboard-progress-track {
          width: 100%;
          height: 6px;
          border-radius: 3px;
          background: var(--p-color-bg-surface-tertiary, #e3e3e3);
          overflow: hidden;
        }
        .dashboard-progress-fill {
          height: 100%;
          border-radius: 3px;
          background: var(--p-color-bg-fill-success, #008060);
        }
        .dashboard-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 16px;
        }
        @media (max-width: 1000px) {
          .dashboard-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 560px) {
          .dashboard-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      <BlockStack gap="500">
        <img src={HERO_IMAGE} alt="4x4 Factory suppliers" className="dashboard-hero" />

        <Text as="p" tone="subdued">
          {`${totalStaged} products staged across ${SOURCES.length} suppliers, ${totalPushed} pushed to Shopify so far.`}
        </Text>

        <BlockStack gap="300">
          <Text as="h2" variant="headingLg">Sources</Text>
          <div className="dashboard-grid">
            {SOURCES.map((s) => (
              <SourceCard key={s.key} source={s} staged={countFor(s.key)} pushed={pushedFor(s.key)} />
            ))}
          </div>
        </BlockStack>

        <BlockStack gap="300">
          <Text as="h2" variant="headingLg">Manage</Text>
          <div className="dashboard-grid">
            {MANAGE_LINKS.map((item) => (
              <ManageCard key={item.key} item={item} />
            ))}
          </div>
        </BlockStack>
      </BlockStack>
    </Page>
  );
}
