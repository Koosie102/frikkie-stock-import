// Builds a CSV export of staged products for a source. Kept to the
// columns someone would actually want in a quick spreadsheet check or
// handoff — not a dump of every internal field.

function csvEscape(value) {
  if (value == null) return "";
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const COLUMNS = [
  ["Title", (p) => p.title],
  ["SKU", (p) => p.sku],
  ["Source Price (AUD)", (p) => p.variantsJson?.variants?.[0]?.priceForeign],
  ["Cost (ZAR)", (p) => p.costZar],
  ["Retail (ZAR)", (p) => p.retailZar],
  ["Variants", (p) => p.variantsJson?.variants?.length || 1],
  ["Status", (p) => p.status],
  ["Source URL", (p) => p.sourceUrl],
  ["Shopify Product ID", (p) => p.shopifyProductId],
];

export function buildStagedProductsCsv(staged) {
  const header = COLUMNS.map(([label]) => csvEscape(label)).join(",");
  const rows = staged.map((p) => COLUMNS.map(([, get]) => csvEscape(get(p))).join(","));
  return [header, ...rows].join("\r\n");
}
