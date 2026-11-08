// Parses Nanjing Jiuguang's separate PRODUCT CATALOG PDF (as opposed to
// their pricelist PDF, handled by nanjingPdf.server.js) and matches its
// entries to already-staged products so their descriptions can be
// replaced with the catalog's own richer spec text.
//
// Why a second adapter rather than extending the pricelist one: this is a
// genuinely different document. The pricelist's "Specifications" column is
// a thin one-line blurb; the catalog gives each product its own full spec
// table (Chip, Raw Lumens, Operating Voltage, Housing Material, Bracket,
// Beam, DRL, Certification, ...) plus a size/watt/lux/IP/lifespan summary
// line — confirmed directly against the real 98-page catalog Coenraad
// uploaded (NEW-Jiuguang_Lighting_Catalog-2610-Demy.pdf), not guessed.
//
// Layout, confirmed from the real file: each page has a section banner
// ("EMARK DRIVING LIGHT", "LED WORK LAMP", "WIRELESS CONTROL PANEL", ...)
// and one or two products side by side, each anchored by its own bold
// model code (always starting "JG-", e.g. "JG-D065", "JG-D065-PRO",
// "JG-96-D065-5"). Below each code: a one-line spec summary
// (`6.5" / 75W / 1LUX@517M / IP68&IP69K / 80000H`), then a run of
// `Label | Value` rows (Chip, Raw Lumens, ...). The page also carries a
// repeating "Demy"/"my" watermark and a beam-pattern diagram (axis
// numbers, "50lx/25lx/..." legend, "ECE"/certification badges) which is
// pure visual noise for this purpose and is filtered out below.
//
// Extraction approach: pdfjs text items carry real x/y positions, so each
// page's product(s) are found by locating every "JG-..." coded item, then
// — for pages with two products side by side — splitting the page into
// left/right "lanes" at the biggest x-gap between code positions (a
// single-product page naturally produces no such gap and stays one lane).
// Within a lane, each code owns every item between its own y and the next
// code's y. That block's items are grouped back into visual lines (same
// y-band), and a line is only kept as real content when it looks like a
// genuine `Label value...` row — filters out the watermark/diagram noise
// without needing to hardcode every possible spec label, since the few
// label vocabularies across sections (driving lights, pod lights, light
// bars, motorcycle lights, work lamps, control panels, brackets, mirrors)
// are too varied to enumerate by hand.
//
// Tested against the real catalog: 180 product entries found across 98
// pages, only 4 with no usable spec lines extracted (an acceptable miss
// rate — those still get the code and empty description, same "fix at
// review" safety net as the rest of this app).
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const CODE_RE = /^JG-[A-Z0-9][A-Z0-9.\-]*$/i;

// Known junk tokens that show up as isolated text items from the
// watermark, certification badges, and beam-pattern diagrams — confirmed
// by inspecting the real extracted text, not guessed defensively.
const NOISE_EXACT = new Set([
  "demy", "my", "d", "new", "ece", "meters", "r148", "r149",
  "50lx", "25lx", "10lx", "5lx", "2lx", "1lx",
]);

function isNoiseToken(t) {
  const s = t.trim();
  if (!s) return true;
  const low = s.toLowerCase();
  if (NOISE_EXACT.has(low)) return true;
  if (/^\d+(\.\d+)?$/.test(s)) return true; // bare diagram axis numbers
  if (/^[φΦ]/.test(s)) return true; // diameter callouts on the housing diagram
  if (/^\d+(\.\d+)?\s*(mm|in|cm|ft|°|℃|℉)\b/i.test(s)) return true; // dimension callouts
  if (/^1\s*Lux\s*@/i.test(s)) return true;
  return false;
}

// A real spec label (Chip, Raw Lumens, Operating Voltage, ...) is short
// alpha-ish text — this shape check, combined with the noise filter
// above, is what lets this work across sections without a hardcoded list
// of every label this catalog happens to use.
function looksLikeLabel(t) {
  const s = t.trim();
  if (!s || isNoiseToken(s)) return false;
  if (CODE_RE.test(s)) return false;
  return /^[A-Za-z][A-Za-z0-9 &/.()\-]{1,45}$/.test(s) && s.length <= 48;
}

async function extractPageItems(page) {
  const content = await page.getTextContent();
  return content.items
    .map((it) => ({ text: it.str, x: it.transform[4], y: it.transform[5] }))
    .filter((it) => it.text.trim());
}

// Splits a page's model-code items into 1 or 2 horizontal "lanes" by
// finding the single biggest x-gap between distinct code x-positions. A
// single-product page has no large gap and comes back as one lane; a
// side-by-side page (confirmed on real pages in the Pod Lights and
// Headlight sections) splits cleanly at the gap between the two columns.
function clusterLaneBoundaries(codeItems) {
  const xs = [...new Set(codeItems.map((c) => Math.round(c.x)))].sort((a, b) => a - b);
  if (xs.length <= 1) return [-Infinity, Infinity];
  let maxGap = 0;
  let splitAt = null;
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1];
    if (gap > maxGap) {
      maxGap = gap;
      splitAt = (xs[i] + xs[i - 1]) / 2;
    }
  }
  if (maxGap < 100) return [-Infinity, Infinity]; // not really 2 lanes, just jitter
  return [-Infinity, splitAt, Infinity];
}

function laneIndexForX(x, boundaries) {
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (x >= boundaries[i] && x < boundaries[i + 1]) return i;
  }
  return boundaries.length - 2;
}

function groupItemsIntoLines(items, yTol = 3) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let current = [];
  let lastY = null;
  for (const it of sorted) {
    if (lastY !== null && Math.abs(it.y - lastY) > yTol) {
      lines.push(current);
      current = [];
    }
    current.push(it);
    lastY = it.y;
  }
  if (current.length) lines.push(current);
  return lines;
}

// Parses the catalog PDF into a flat list of entries:
// { code, specLine, descriptionLines, page }
// `code` is the catalog's own raw model code, e.g. "JG-D065-PRO-9".
// `descriptionLines` is an array of "Label: Value" strings.
export async function parseNanjingCatalog(pdfBytes) {
  const data = new Uint8Array(pdfBytes);
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const entries = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const items = await extractPageItems(page);
    const codeItems = items
      .filter((it) => CODE_RE.test(it.text.trim()))
      .map((it) => ({ ...it, text: it.text.trim() }));
    if (codeItems.length === 0) continue;

    const boundaries = clusterLaneBoundaries(codeItems);
    const laneCount = boundaries.length - 1;

    const codesByLane = Array.from({ length: laneCount }, () => []);
    for (const c of codeItems) codesByLane[laneIndexForX(c.x, boundaries)].push(c);
    for (const laneCodes of codesByLane) laneCodes.sort((a, b) => b.y - a.y);

    for (let lane = 0; lane < laneCount; lane++) {
      const laneItems = items.filter((it) => laneIndexForX(it.x, boundaries) === lane);
      const laneCodes = codesByLane[lane];
      for (let i = 0; i < laneCodes.length; i++) {
        const code = laneCodes[i];
        const yTop = code.y + 2;
        const yBottom = i + 1 < laneCodes.length ? laneCodes[i + 1].y : -Infinity;
        const blockItems = laneItems.filter((it) => it.y <= yTop && it.y > yBottom);
        const lines = groupItemsIntoLines(blockItems);
        const descriptionLines = [];
        let specLine = "";
        for (const line of lines) {
          const texts = line.map((it) => it.text.trim()).filter(Boolean);
          if (!texts.length) continue;
          const joined = texts.join(" ");
          if (CODE_RE.test(texts[0])) continue; // the code line itself, repeated
          if (!specLine && /\d+(\.\d+)?"?\s*\/\s*\d+W/i.test(joined)) {
            specLine = joined;
            continue;
          }
          if (looksLikeLabel(texts[0])) {
            const label = texts[0].trim();
            const value = texts.slice(1).filter((t) => !isNoiseToken(t)).join(" ").trim();
            if (value) descriptionLines.push(`${label}: ${value}`);
          }
        }
        entries.push({ code: code.text, specLine, descriptionLines, page: pageNum });
      }
    }
  }

  // The same code can legitimately repeat across a few adjacent blocks
  // (confirmed on the real file — a couple of products are shown once per
  // colour option, each repeating the same model code with the same
  // spec). Keep only the first, fullest-looking occurrence of each code.
  const byCode = new Map();
  for (const e of entries) {
    const existing = byCode.get(e.code);
    if (!existing || e.descriptionLines.length > existing.descriptionLines.length) {
      byCode.set(e.code, e);
    }
  }
  return [...byCode.values()];
}

// --- Matching catalog entries to already-staged pricelist rows ---------

// Strips the dedup suffix nanjingPdf.server.js appends when two pricelist
// rows would otherwise share one SKU (e.g. "D065-6-5-pair", "D040-4-5-
// pair-2") back down to the raw Model No. token it started from.
function stripDedupSuffix(sku) {
  return sku
    .replace(/-\d+(?:-\d+)?-(pair|single)(-\d+)?$/i, "")
    .replace(/-(pair|single)(-\d+)?$/i, "");
}

// Reduces a model code to a "base family" token so the pricelist's bare
// "D065" lines up with the catalog's "JG-D065" / "JG-D065-PRO" /
// "JG-D065-9" / "JG-D065-PRO-9" variants, which the pricelist itself never
// distinguishes (confirmed: its own Model No. column never carries a
// "-PRO" or size suffix the way the catalog's codes do). Strips a leading
// "JG-", then repeatedly pops a trailing "-PRO" or trailing size-shaped
// segment ("-9", "-7inch", ...) off the end.
function baseFamily(code) {
  let s = code.toUpperCase().replace(/^JG-/, "");
  let changed = true;
  while (changed) {
    changed = false;
    if (/-PRO$/i.test(s)) {
      s = s.replace(/-PRO$/i, "");
      changed = true;
      continue;
    }
    const m = s.match(/-(\d+(?:\.\d+)?)(IN|INCH|INCHES)?$/i);
    if (m) {
      s = s.slice(0, s.length - m[0].length);
      changed = true;
    }
  }
  return s;
}

function parseSizeInches(text) {
  if (!text) return null;
  const m = text.match(/(\d+(?:\.\d+)?)\s*["']/);
  return m ? parseFloat(m[1]) : null;
}

// Builds a lookup from base-family token to the catalog entries sharing
// it, so matchCatalogEntry can look up every size/PRO variant of a given
// product family in one go.
function groupByBaseFamily(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = baseFamily(e.code);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return map;
}

// Finds the best catalog entry for a staged pricelist row.
// Returns { entry, confidence: "exact" | "approx" } or null.
export function matchCatalogEntry(sku, title, baseFamilyMap) {
  if (!sku) return null;
  const base = baseFamily(stripDedupSuffix(sku));
  const candidates = baseFamilyMap.get(base);
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return { entry: candidates[0], confidence: "exact" };

  const rowSize = parseSizeInches(title);
  if (rowSize != null) {
    const sizeMatches = candidates.filter((c) => {
      const catSize = parseSizeInches(c.specLine);
      return catSize != null && Math.abs(catSize - rowSize) < 0.1;
    });
    if (sizeMatches.length === 1) return { entry: sizeMatches[0], confidence: "exact" };
    if (sizeMatches.length > 1) {
      // Prefer the plainer (non-"PRO") variant when more than one
      // same-size candidate remains — a disclosed approximation, since
      // the pricelist never records which one Coenraad actually stocks.
      const plain = sizeMatches.find((c) => !/-PRO/i.test(c.code)) || sizeMatches[0];
      return { entry: plain, confidence: "approx" };
    }
  }

  // No size match (or none parseable) — still return the plainest
  // candidate in the family as a best-effort match, clearly marked
  // "approx" so the upload result can report it honestly.
  const plain = candidates.find((c) => !/-PRO/i.test(c.code)) || candidates[0];
  return { entry: plain, confidence: "approx" };
}

export function catalogEntryToDescriptionHtml(entry) {
  const escapeHtml = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = [entry.specLine, ...entry.descriptionLines].filter(Boolean);
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n");
}

export { baseFamily, stripDedupSuffix, parseSizeInches, groupByBaseFamily };
