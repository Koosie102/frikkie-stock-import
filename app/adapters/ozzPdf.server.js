// Parses OZZ's own PDF wholesale pricelist. Unlike MagicStar/Nanjing, this
// isn't the source of truth for product catalog data (title/images/specs
// come from OZZ's live WooCommerce site — see ozzMap.server.js) — it's
// purely a price list: a clean, single-schema 4-column table (PART NUMBER,
// DESCRIPTION, RRP, Wholesale) with a handful of plain section-banner rows
// ("DRIVING LIGHT", "LED-BARS", "WORK LIGHTS / WARNING LIGHTS",
// "ACCESSORIES", "LENS COVERS", "GRILL KIT") and no embedded images at
// all, so none of Nanjing's rect/image-geometry machinery is needed here —
// just text-position-based row reconstruction.
//
// Column layout is RRP first, Wholesale second (left to right) — Wholesale
// is the dealer/cost basis Coenraad wants to price off (RRP reflects the
// Swedish/EU retail market, not used here). Prices are European-formatted
// ("260,00" = 260.00, comma decimal) and — found empirically on the last
// page (GRILL KIT section) — the € symbol isn't consistently placed before
// vs after the number, so price tokens are matched by their comma-decimal
// shape alone and the € symbol is ignored entirely rather than relied on.
//
// This file only extracts rows ({ sku, description, category, rrpEUR,
// wholesaleEUR }) — it does NOT create or touch StagedProduct rows itself.
// The merge-by-SKU into already-fetched OZZ staged products happens in
// app.ozz.jsx's "uploadPricelist" action, since that's inherently a merge
// onto existing rows (from the website fetch), not a create, unlike every
// other PDF source in this app.

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Matches a European-formatted price number anywhere in a line, deliberately
// without requiring a € symbol on either side (see file header) — e.g.
// "260,00", "1.234,56". Requires a comma-decimal suffix so it doesn't
// accidentally match plain description numbers like "REF 25" or "4X4".
const PRICE_TOKEN_RE = /\d{1,3}(?:\.\d{3})*,\d{2}/g;
const PART_NUMBER_RE = /^(\d{4,8})\s+(.*)$/;

function parseEuroNumber(token) {
  // "1.234,56" -> remove thousands dots, swap decimal comma for a dot.
  return parseFloat(token.replace(/\./g, "").replace(",", "."));
}

// Groups a page's text items into visual rows by y-proximity (items within
// ~3pt share a baseline), then sorts each row left-to-right by x — same
// y-clustering technique used for Nanjing's banner/row detection, just
// without that file's extra rect/image geometry since this table has
// neither merged cells nor embedded photos to reconcile against.
function groupIntoRows(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y); // top to bottom (PDF y grows upward)
  const rows = [];
  for (const item of sorted) {
    const row = rows.find((r) => Math.abs(r.y - item.y) < 3);
    if (row) {
      row.items.push(item);
      row.y = (row.y + item.y) / 2; // drift the band center slightly, tolerant of sub-pixel baseline jitter
    } else {
      rows.push({ y: item.y, items: [item] });
    }
  }
  return rows.map((r) => {
    const text = r.items
      .sort((a, b) => a.x - b.x)
      .map((i) => i.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { y: r.y, text };
  });
}

// Loose heuristic for a section-banner line ("DRIVING LIGHT", "LED-BARS",
// "WORK LIGHTS / WARNING LIGHTS", ...): no leading part number, no price
// token, short, no lowercase letters (these are the PDF's own bold
// all-caps section headers). Purely informational (goes on each row's
// `category` field) — nothing downstream depends on it being perfect.
function looksLikeCategoryBanner(text) {
  if (!text || text.length > 60) return false;
  if (PRICE_TOKEN_RE.test(text)) return false;
  if (/^\d/.test(text)) return false;
  if (/[a-z]/.test(text)) return false; // genuine banners are all-caps in this file
  return /^[A-Z0-9 /&-]+$/.test(text);
}

// Parses an OZZ pricelist PDF (as a Buffer/Uint8Array) into rows:
// { sku, description, category, rrpEUR, wholesaleEUR }. Duplicate SKUs in
// the source file (confirmed present — e.g. 88962 reused across two
// different description rows, 88992 as a literal duplicate line) are kept
// as separate rows; the merge step that consumes this (app.ozz.jsx) uses
// last-one-wins per SKU, which is harmless here since every duplicate
// found in the real file shares the same price across its repeats.
export async function parseOzzPricelist(pdfBytes) {
  const data = new Uint8Array(pdfBytes);
  const doc = await getDocument({ data }).promise;

  const rows = [];
  let currentCategory = "";

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const textContent = await page.getTextContent();
    const items = textContent.items
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
      .filter((it) => it.str.trim() !== "");

    const lines = groupIntoRows(items);

    for (const { text } of lines) {
      if (looksLikeCategoryBanner(text)) {
        currentCategory = text;
        continue;
      }

      const m = text.match(PART_NUMBER_RE);
      if (!m) continue;
      const sku = m[1];
      const rest = m[2];

      const priceTokens = rest.match(PRICE_TOKEN_RE);
      if (!priceTokens || priceTokens.length < 2) continue; // not a real price row — skip rather than guess

      // RRP is always the first price column, Wholesale the last — if a
      // description somehow contains an extra comma-decimal-shaped number
      // this still picks the right two (the real columns are always the
      // rightmost two tokens on a genuine row).
      const rrpToken = priceTokens[priceTokens.length - 2];
      const wholesaleToken = priceTokens[priceTokens.length - 1];

      const description = rest
        .replace(/€/g, "")
        .replace(PRICE_TOKEN_RE, "")
        .replace(/\s+/g, " ")
        .trim();

      rows.push({
        sku,
        description,
        category: currentCategory,
        rrpEUR: parseEuroNumber(rrpToken),
        wholesaleEUR: parseEuroNumber(wholesaleToken),
      });
    }
  }

  return rows;
}
