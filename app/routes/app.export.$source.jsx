import { authenticate } from "../shopify.server";
import db from "../db.server";
import { buildStagedProductsCsv } from "../utils/csvExport.server";

const VALID_SOURCES = new Set(["STEDI", "BUSHDOOF", "ULTRA_VISION", "ALTIQ", "TRAILBAIT"]);

const TAB_FILTERS = {
  all: {},
  new: { status: { in: ["NEW", "NEEDS_REVIEW"] } },
  pushed: { status: "PUSHED" },
};

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);

  const source = params.source?.toUpperCase();
  if (!VALID_SOURCES.has(source)) {
    throw new Response("Unknown source", { status: 404 });
  }

  const url = new URL(request.url);
  const tabId = url.searchParams.get("tab") || "all";
  const tabFilter = TAB_FILTERS[tabId] || TAB_FILTERS.all;
  const q = (url.searchParams.get("q") || "").trim();
  const searchWhere = q
    ? {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { sku: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};

  // No `take` cap here (unlike the review table's 150) — an export should
  // include everything matching the current view, not just the first page.
  const staged = await db.stagedProduct.findMany({
    where: { source, ...tabFilter, ...searchWhere },
    orderBy: { createdAt: "desc" },
  });

  const csv = buildStagedProductsCsv(staged);
  const filename = `${source.toLowerCase()}-products-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
