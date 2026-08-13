import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  IndexTable,
  Badge,
  TextField,
  Tabs,
  Link,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { fetchVendorProducts } from "../adapters/shopifyMatch.server";
import { summarizeVendorTags } from "../adapters/shopifyTaxonomy.server";
import { VENDOR_NAMES } from "../utils/vendorNames";
import { pushCollectionDef, syncBrandMenu } from "../adapters/shopifyCollections.server";

const SOURCES = ["STEDI", "BUSHDOOF", "ULTRA_VISION", "ALTIQ", "TRAILBAIT"];

// Turns the editable "tags" text field (comma-separated, "!tag" = exclude)
// into the rules array pushCollectionDef expects, always prefixed with the
// vendor rule so every collection stays scoped to this brand.
function tagsCsvToRules(source, tagsCsv) {
  const vendorRule = { column: "VENDOR", relation: "EQUALS", condition: VENDOR_NAMES[source] };
  const tagRules = tagsCsv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) =>
      t.startsWith("!")
        ? { column: "TAG", relation: "NOT_EQUALS", condition: t.slice(1) }
        : { column: "TAG", relation: "EQUALS", condition: t },
    );
  return [vendorRule, ...tagRules];
}

function rulesToTagsCsv(rules) {
  return (rules || [])
    .filter((r) => r.column === "TAG")
    .map((r) => (r.relation === "NOT_EQUALS" ? `!${r.condition}` : r.condition))
    .join(", ");
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const source = SOURCES.includes(url.searchParams.get("source")) ? url.searchParams.get("source") : "TRAILBAIT";

  const collectionDefs = await db.collectionDef.findMany({
    where: { source },
    orderBy: { position: "asc" },
  });

  const vendorProducts = await fetchVendorProducts(admin, VENDOR_NAMES[source]);
  const vendorTags = summarizeVendorTags(vendorProducts);

  return { source, collectionDefs, vendorTags, shopDomain: session.shop };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const source = formData.get("source");

  if (intent === "addDef") {
    const maxPos = await db.collectionDef.aggregate({ where: { source }, _max: { position: true } });
    const created = await db.collectionDef.create({
      data: {
        source,
        title: "New collection",
        menuGroup: null,
        position: (maxPos._max.position ?? -1) + 1,
        rules: tagsCsvToRules(source, ""),
      },
    });
    return { ok: true, mode: "addDef", id: created.id };
  }

  if (intent === "saveDef") {
    const id = formData.get("id");
    const title = formData.get("title");
    const menuGroup = formData.get("menuGroup") || null;
    const tagsCsv = formData.get("tagsCsv") || "";
    await db.collectionDef.update({
      where: { id },
      data: { title, menuGroup, rules: tagsCsvToRules(source, tagsCsv) },
    });
    return { ok: true, mode: "saveDef", id };
  }

  if (intent === "deleteDef") {
    const id = formData.get("id");
    await db.collectionDef.delete({ where: { id } });
    return { ok: true, mode: "deleteDef", id };
  }

  if (intent === "pushDef") {
    const id = formData.get("id");
    const def = await db.collectionDef.findUnique({ where: { id } });
    if (!def) return { ok: false, mode: "pushDef", id, error: "Not found." };
    try {
      const shopifyCollectionId = await pushCollectionDef(admin, def);
      await db.collectionDef.update({ where: { id }, data: { shopifyCollectionId } });
      return { ok: true, mode: "pushDef", id };
    } catch (err) {
      return { ok: false, mode: "pushDef", id, error: String(err.message || err) };
    }
  }

  if (intent === "pushAllDefs") {
    const defs = await db.collectionDef.findMany({ where: { source } });
    let pushed = 0;
    const errors = [];
    for (const def of defs) {
      try {
        const shopifyCollectionId = await pushCollectionDef(admin, def);
        await db.collectionDef.update({ where: { id: def.id }, data: { shopifyCollectionId } });
        pushed += 1;
      } catch (err) {
        errors.push(`${def.title}: ${String(err.message || err)}`);
      }
    }
    return { ok: errors.length === 0, mode: "pushAllDefs", pushed, errors };
  }

  if (intent === "syncMenu") {
    const brandTabTitle = formData.get("brandTabTitle");
    const defs = await db.collectionDef.findMany({ where: { source }, orderBy: { position: "asc" } });
    try {
      await syncBrandMenu(admin, brandTabTitle, defs);
      return { ok: true, mode: "syncMenu" };
    } catch (err) {
      return { ok: false, mode: "syncMenu", error: String(err.message || err) };
    }
  }

  return null;
};

function CollectionRow({ def, source, shopDomain, saveFetcher, pushFetcher, deleteFetcher }) {
  const [title, setTitle] = useState(def.title);
  const [menuGroup, setMenuGroup] = useState(def.menuGroup || "");
  const [tagsCsv, setTagsCsv] = useState(rulesToTagsCsv(def.rules));
  const dirty = title !== def.title || menuGroup !== (def.menuGroup || "") || tagsCsv !== rulesToTagsCsv(def.rules);

  const pushing = pushFetcher.state !== "idle" && pushFetcher.formData?.get("id") === def.id;
  const pushResult = pushFetcher.data;
  const thisPushFailed = pushResult?.mode === "pushDef" && pushResult.id === def.id && pushResult.ok === false;

  return (
    <IndexTable.Row id={def.id} position={0}>
      <IndexTable.Cell>
        <div style={{ minWidth: 180 }}>
          <TextField labelHidden label="Title" value={title} onChange={setTitle} autoComplete="off" />
        </div>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <div style={{ minWidth: 140 }}>
          <TextField
            labelHidden
            label="Menu group"
            placeholder="(top-level)"
            value={menuGroup}
            onChange={setMenuGroup}
            autoComplete="off"
          />
        </div>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <div style={{ minWidth: 260 }}>
          <TextField
            labelHidden
            label="Tags"
            placeholder="toyota, hilux, n90"
            helpText="Comma-separated. Prefix with ! to exclude, e.g. !all-new"
            value={tagsCsv}
            onChange={setTagsCsv}
            autoComplete="off"
          />
        </div>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {def.shopifyCollectionId ? (
          <Link
            url={`https://${shopDomain}/admin/collections/${def.shopifyCollectionId.split("/").pop()}`}
            target="_blank"
          >
            <Badge tone="success">Linked</Badge>
          </Link>
        ) : (
          <Badge>Not pushed</Badge>
        )}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="150">
          <Button
            size="slim"
            disabled={!dirty}
            onClick={() =>
              saveFetcher.submit(
                { intent: "saveDef", source, id: def.id, title, menuGroup, tagsCsv },
                { method: "post" },
              )
            }
          >
            Save
          </Button>
          <Button
            size="slim"
            variant="primary"
            loading={pushing}
            onClick={() => pushFetcher.submit({ intent: "pushDef", source, id: def.id }, { method: "post" })}
          >
            {def.shopifyCollectionId ? "Update" : "Push"}
          </Button>
          <Button
            size="slim"
            tone="critical"
            onClick={() => {
              if (confirm(`Delete "${def.title}" from this list? (Won't delete it from Shopify if already pushed.)`)) {
                deleteFetcher.submit({ intent: "deleteDef", source, id: def.id }, { method: "post" });
              }
            }}
          >
            Remove
          </Button>
        </InlineStack>
        {thisPushFailed && <Text as="p" tone="critical">{pushResult.error}</Text>}
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

export default function CollectionsTab() {
  const { source, collectionDefs, vendorTags, shopDomain } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const addFetcher = useFetcher();
  const saveFetcher = useFetcher();
  const pushFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const pushAllFetcher = useFetcher();
  const menuFetcher = useFetcher();

  const [brandTabTitle, setBrandTabTitle] = useState(VENDOR_NAMES[source].toUpperCase());
  useEffect(() => setBrandTabTitle(VENDOR_NAMES[source].toUpperCase()), [source]);

  const selectedTabIndex = SOURCES.indexOf(source);
  const pushAllResult = pushAllFetcher.data;
  const menuResult = menuFetcher.data;
  const pushedCount = collectionDefs.filter((d) => d.shopifyCollectionId).length;

  return (
    <Page title="Collections">
      <BlockStack gap="400">
        <Banner tone="info">
          Manage smart-collection definitions per brand — title, which menu
          group they nest under, and the tag rules that become a Shopify
          smart collection. Push creates the collection the first time and
          updates it in place after that. Shopify collections only support
          "vendor AND tag AND tag..." in one rule set — there's no way to
          do "OR" across tags here, which is why some collections (like
          flat categories) rely on a single consolidated tag rather than
          several alternatives.
        </Banner>

        <Card padding="0">
          <Tabs
            tabs={SOURCES.map((s) => ({ id: s, content: VENDOR_NAMES[s] }))}
            selected={selectedTabIndex === -1 ? 4 : selectedTabIndex}
            onSelect={(index) => {
              const params = new URLSearchParams(searchParams);
              params.set("source", SOURCES[index]);
              setSearchParams(params);
            }}
          />
        </Card>

        {pushAllResult?.mode === "pushAllDefs" && (
          <Banner tone={pushAllResult.ok ? "success" : "warning"} title="Push finished">
            <BlockStack gap="100">
              <Text as="p">{`Pushed/updated ${pushAllResult.pushed} collection(s).`}</Text>
              {pushAllResult.errors?.map((e, i) => (
                <Text as="p" tone="critical" key={i}>{e}</Text>
              ))}
            </BlockStack>
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">{`${VENDOR_NAMES[source]} collections`}</Text>
              <InlineStack gap="200">
                <addFetcher.Form method="post">
                  <input type="hidden" name="intent" value="addDef" />
                  <input type="hidden" name="source" value={source} />
                  <Button submit loading={addFetcher.state !== "idle"}>Add collection</Button>
                </addFetcher.Form>
                <pushAllFetcher.Form method="post">
                  <input type="hidden" name="intent" value="pushAllDefs" />
                  <input type="hidden" name="source" value={source} />
                  <Button submit variant="primary" loading={pushAllFetcher.state !== "idle"}>
                    Push all to Shopify
                  </Button>
                </pushAllFetcher.Form>
              </InlineStack>
            </InlineStack>
            <Text as="p" tone="subdued">
              {`${collectionDefs.length} collection(s) defined, ${pushedCount} linked to Shopify`}
            </Text>

            <IndexTable
              resourceName={{ singular: "collection", plural: "collections" }}
              itemCount={collectionDefs.length}
              headings={[
                { title: "Title" },
                { title: "Menu group" },
                { title: "Tags" },
                { title: "Status" },
                { title: "Actions" },
              ]}
              selectable={false}
            >
              {collectionDefs.map((def) => (
                <CollectionRow
                  key={def.id}
                  def={def}
                  source={source}
                  shopDomain={shopDomain}
                  saveFetcher={saveFetcher}
                  pushFetcher={pushFetcher}
                  deleteFetcher={deleteFetcher}
                />
              ))}
            </IndexTable>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Sync menu</Text>
            <Text as="p" tone="subdued">
              Builds a "Shop by vehicle"/"Lighting"/etc. dropdown structure
              from the pushed collections above and merges it into your
              store's Main Menu as one tab — every other tab is left
              exactly as-is. If a tab with this exact title already
              exists, its contents are replaced; otherwise a new tab is
              appended. Only collections that have already been pushed to
              Shopify (green "Linked" badge above) are included.
            </Text>
            {menuResult?.mode === "syncMenu" && menuResult.ok === false && (
              <Banner tone="critical">{menuResult.error}</Banner>
            )}
            {menuResult?.mode === "syncMenu" && menuResult.ok === true && (
              <Banner tone="success">Menu synced.</Banner>
            )}
            <menuFetcher.Form method="post">
              <input type="hidden" name="intent" value="syncMenu" />
              <input type="hidden" name="source" value={source} />
              <InlineStack gap="200" blockAlign="end">
                <div style={{ maxWidth: 260 }}>
                  <TextField
                    label="Menu tab title"
                    name="brandTabTitle"
                    value={brandTabTitle}
                    onChange={setBrandTabTitle}
                    autoComplete="off"
                    helpText="Must match an existing tab's title exactly to update it instead of creating a new one."
                  />
                </div>
                <Button submit variant="primary" loading={menuFetcher.state !== "idle"}>
                  Sync menu to Shopify
                </Button>
              </InlineStack>
            </menuFetcher.Form>
          </BlockStack>
        </Card>

        {vendorTags.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{`Existing Shopify tags for ${VENDOR_NAMES[source]}`}</Text>
              <Text as="p" tone="subdued">
                Reference for writing tag rules above — every tag already
                in use on this vendor's products in your store, most-used
                first.
              </Text>
              <InlineStack gap="150">
                {vendorTags.slice(0, 60).map(({ tag, count }) => (
                  <Badge key={tag}>{`${tag} (${count})`}</Badge>
                ))}
              </InlineStack>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
