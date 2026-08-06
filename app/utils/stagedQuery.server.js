// Builds the Prisma where/orderBy for a source's staged-product review
// table from the request's URL search params (tab, q, sort, dir). Same
// logic across every source's route loader, so search/sort behave
// identically everywhere instead of being reimplemented per tab.

// Maps the column a heading can sort by to its real Prisma field name —
// only real scalar columns are sortable (title/sku/costZar/retailZar);
// the AUD source price lives inside variantsJson and isn't sortable here.
const SORTABLE_FIELDS = new Set(["title", "sku", "costZar", "retailZar"]);

export function buildStagedQuery(source, url, tabs) {
  const tabId = url.searchParams.get("tab") || tabs[0].id;
  const tab = tabs.find((t) => t.id === tabId) || tabs[0];

  const q = (url.searchParams.get("q") || "").trim();
  const searchWhere = q
    ? {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { sku: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};

  const sortParam = url.searchParams.get("sort");
  const sortField = SORTABLE_FIELDS.has(sortParam) ? sortParam : "createdAt";
  const sortDir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";

  return {
    where: { source, ...tab.filter, ...searchWhere },
    orderBy: { [sortField]: sortDir },
    tabId,
    q,
    sortField: SORTABLE_FIELDS.has(sortParam) ? sortParam : null,
    sortDir,
  };
}
