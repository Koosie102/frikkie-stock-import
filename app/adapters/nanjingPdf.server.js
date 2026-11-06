// Parses a Nanjing Jiuguang Lighting ("JIUGUANG") pricelist PDF — the same
// "drop in a PDF, no website/API" approach as MagicStar (see
// magicstarPdf.server.js for the general rationale). Their own site
// (jg-ledlight.com) was checked and has product pages with specs/photos but
// NO prices anywhere ("Availability: Inquire" on every product) and no
// products.json/WooCommerce-style API — it's a plain HTML catalog with no
// clean way to pull structured data, and since the PDF already carries a
// usable photo per product, scraping that site wasn't worth the extra
// complexity. So, same as MagicStar: everything (SKU, spec text, price,
// photo) comes out of the PDF alone.
//
// This PDF is laid out very differently from MagicStar's, though, which is
// why this isn't just a copy of that file:
//
//  - MagicStar: one borderless row per product, one real photo per row,
//    reconstructed purely from text/image Y-position bands.
//  - Nanjing: real printed table headers ("Model No. | Specifications |
//    Size | ... | Picture | Unit | Price"), a table routinely spans
//    several PAGES with the header only printed once at the top (handled
//    below by carrying the last-seen column layout across pages until a
//    new header appears), and many products are printed as ONE merged
//    block (one Model No., one spec paragraph, one photo) covering
//    SEVERAL price rows underneath it — e.g. a light bar sold in 5
//    lengths, each its own price. Per Coenraad, each size/price variant
//    becomes its own staged row sharing the parent's photo (same pattern
//    MagicStar already uses for colour variants that repeat a SKU), not
//    just the cheapest one.
//
// Column positions are NOT available as drawn vector cell rects for body
// rows in this PDF (only the header row and the section-banner bands are
// real filled rectangles — body-row borders are baked into a background
// template image, not vector content), so column x-ranges are instead
// read once per table from the header row's own text items ("Model No.",
// "Specifications", "Size", "Price", ...) and reused for every row below
// it — including on later pages with no header of their own — until the
// next header. Row grouping uses two levels:
//   1. GROUP band — the vertical span of one product's photo (or stack of
//      photos) in the Picture column. Model No. and Specifications are
//      captured once per group, from anywhere in that whole span, since
//      they're only printed once even when several price rows share them.
//   2. ROW anchor — each "$..." price found inside a group's span is one
//      output row; a narrow sub-band around that price (vs the next price
//      above/below it) pulls that row's own Size/Watt/Qty/Pattern value.
//
// Section banners (the full-width coloured bands like "3-5inch Led Driving
// Lights", "LED Light Bar", "Universal Roll Bar Mount LED work Light") are
// read from their own filled rects and tracked as running state while
// walking the document top to bottom, page to page — but only a banner
// that clearly names a category (see KUDU_RE/VELDT_RE below) changes the
// current category; a plain sub-heading like "3 inch/5 inch Side Shooter
// Series" updates the descriptive text used in the title but leaves the
// Kudu/Veldt classification as it was. Per Coenraad: anything under a
// banner mentioning "driving", "spot" or "light bar" is WOEST Kudu;
// everything else (grill lights, motorcycle lights, whip lights, rock
// lights, mirror lights, turn signal kits, chase lights, UTV pod lights/
// accessories, work lights, ...) is WOEST Veldt. This is a best-effort
// auto-tag baked into the title prefix, exactly like MagicStar's "WOEST
// Caraq" prefix — if a row lands under the wrong one, Coenraad can just
// edit the title at review time, same as any other title cleanup.
//
// Realistic accuracy expectation: this PDF mixes well over half a dozen
// different column layouts across 20 pages, some with missing Model No.
// text entirely, and page-break mid-group is possible. This is messier
// than MagicStar's single consistent layout, so expect a noticeably
// higher fraction of rows needing a manual title/price glance at review
// time — same safety net as MagicStar (editable Title + Price fields,
// hand-picked rows to push), just leaned on harder here.

import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";

const TITLE_PREFIX_KUDU = "WOEST Kudu";
const TITLE_PREFIX_VELDT = "WOEST Veldt";
// Checked first: an explicit Veldt-side signal always wins, so a banner
// like "Universal Roll Bar Mount LED work Light" (which contains the bare
// word "Bar" from "Roll Bar", not a light bar) still lands as Veldt.
// "pods"/"pod lights" is deliberately NOT a bare keyword here — "DRL Pods
// Light" (page 2) is a genuine auxiliary driving-light style under the
// Driving Lights category (Kudu), while only the later, explicitly named
// "UTV PODS LIGHTS" section (page 20) is the Veldt-side accessory.
const VELDT_RE = /work\s*light|whip|rock\s*light|mirror|turn\s*signal|chase\s*light|utv\s*pods?\s*light|accessor|grill|motorcycle|roll\s*bar/i;
const KUDU_RE = /driving|spot|light\s*bar|led\s*bar/i;

const PAGE_TOP = 10000;
const PAGE_BOTTOM = -10000;

function mulMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}
function applyPt(ctm, x, y) {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}

// Walks one page's operator list once, returning both the filled
// rectangles (used for section banners + the header row's own cell
// bounds) and the image placements (used for grouping + the Picture
// column), using the same CTM-tracking approach as magicstarPdf.server.js.
async function getPageGeometry(page) {
  const opList = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const rects = [];
  const images = [];
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mulMatrix(opList.argsArray[i], ctm);
    else if (fn === OPS.constructPath) {
      const subops = opList.argsArray[i][0];
      const data = opList.argsArray[i][1];
      let di = 0;
      for (const subop of subops) {
        if (subop === OPS.rectangle) {
          const [x, y, w, h] = data.slice(di, di + 4);
          di += 4;
          const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => applyPt(ctm, px, py));
          const xs = corners.map((c) => c[0]);
          const ys = corners.map((c) => c[1]);
          rects.push({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
        } else if (subop === OPS.moveTo || subop === OPS.lineTo) {
          di += 2;
        }
      }
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const name = opList.argsArray[i][0];
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => applyPt(ctm, x, y));
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      images.push({ name, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    }
  }
  return { rects, images };
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// Best-effort SKU/model-number token: alphanumeric with hyphens/slashes/
// plusses, at least one digit, 2-20 chars. Looked for anywhere in a
// group's Model No. column text (not always present — some product
// blocks print no model number at all).
function extractModelNo(text) {
  const m = (text || "").match(/\b[A-Za-z][A-Za-z0-9]*(?:[-+/][A-Za-z0-9]+)*\b/g);
  if (!m) return null;
  const candidate = m.find((tok) => /\d/.test(tok) && tok.length >= 3 && tok.length <= 24);
  return candidate || null;
}

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

// Derives a column map {label, x0, x1} from the text items sitting on a
// header row's baseline (clustered by x-gap, since multi-word labels like
// "Wiring Harness" are separate text runs).
function colsFromHeaderBand(items, hy) {
  const headerBand = items.filter((it) => Math.abs(it.y - hy) < 12).sort((a, b) => a.x - b.x || b.y - a.y);
  const clusters = [];
  for (const it of headerBand) {
    const last = clusters[clusters.length - 1];
    if (last && it.x - last.maxX < 20) {
      last.items.push(it);
      last.maxX = Math.max(last.maxX, it.x);
    } else {
      clusters.push({ items: [it], minX: it.x, maxX: it.x });
    }
  }
  const headerItems = clusters.map((c) => ({
    str: cleanText(c.items.sort((a, b) => b.y - a.y || a.x - b.x).map((it) => it.str).join(" ")),
    x: c.minX,
  }));
  const cols = headerItems.map((it, i) => ({
    label: it.str,
    x0: i === 0 ? -Infinity : (headerItems[i - 1].x + it.x) / 2,
  }));
  for (let i = 0; i < cols.length; i++) cols[i].x1 = i + 1 < cols.length ? cols[i + 1].x0 : Infinity;
  return cols;
}

// Processes one contiguous table region (within a single page) using a
// fixed column map, mutating `state` (running banner/category, the
// de-dupe set, and the output rows array) as it goes.
function processRegion(state, { items, images, bannerQueue, cols, yTop, yBottom }) {
  const priceColIdx = cols.findIndex((c) => /price/i.test(c.label));
  const pictureColIdx = cols.findIndex((c) => /picture/i.test(c.label));
  const modelColIdx = cols.findIndex((c) => /model/i.test(c.label));
  const specColIdx = cols.findIndex((c) => /spec/i.test(c.label));
  if (priceColIdx < 0 || pictureColIdx < 0) return;
  const priceCol = cols[priceColIdx];
  const pictureCol = cols[pictureColIdx];

  // bannerQueue is one shared, page-level queue (sorted top to bottom)
  // passed in by the caller and consumed here as we walk down through
  // this region's groups — NOT re-filtered per region, because a banner
  // describes whatever content follows it (often the very next header),
  // not just content that happens to fall inside this region's own
  // y-range.
  // Lenient on purpose: the Picture column's real width (always the
  // widest column by far) isn't reliably recoverable from the header
  // label's own x-position alone — on some pages the actual photos sit
  // well outside the midpoint-derived column bounds even though no new
  // header printed to signal a layout shift. Since this PDF has no
  // embedded images anywhere except product photos, just overlapping the
  // table's Picture-to-Unit span at all (generous margin) is enough —
  // there's nothing else an image placement could legitimately be.
  const picImages = images
    .filter((im) => im.x1 > pictureCol.x0 - 60 && im.x0 < pictureCol.x1 + 60 && im.y0 < yTop && im.y1 > yBottom)
    .sort((a, b) => b.y1 - a.y1);
  const groups = [];
  for (const im of picImages) {
    const last = groups[groups.length - 1];
    if (last && last.y1 - im.y1 < 12) {
      last.y0 = Math.min(last.y0, im.y0);
      last.y1 = Math.max(last.y1, im.y1);
      last.images.push(im);
    } else {
      groups.push({ y0: im.y0, y1: im.y1, images: [im] });
    }
  }
  groups.sort((a, b) => b.y1 - a.y1);
  for (let gi = 0; gi < groups.length; gi++) {
    groups[gi].spanTop = gi === 0 ? yTop : groups[gi - 1].spanBottom;
    groups[gi].spanBottom = gi + 1 < groups.length ? (groups[gi].y0 + groups[gi + 1].y1) / 2 : yBottom;
  }

  for (const group of groups) {
    while (bannerQueue.length && bannerQueue[0].y > group.spanTop) {
      const b = bannerQueue.shift();
      state.currentSection = b.text;
      if (VELDT_RE.test(b.text)) state.currentCategory = "VELDT";
      else if (KUDU_RE.test(b.text)) state.currentCategory = "KUDU";
      // else: a non-category sub-label — updates currentSection (used in
      // the title) but leaves currentCategory as it was.
    }
    const category = state.currentCategory;
    const titlePrefix = category === "KUDU" ? TITLE_PREFIX_KUDU : TITLE_PREFIX_VELDT;

    const inGroup = (col) =>
      items.filter((it) => it.x >= col.x0 && it.x < col.x1 && it.y <= group.spanTop && it.y > group.spanBottom);

    const modelText = modelColIdx >= 0 ? cleanText(inGroup(cols[modelColIdx]).sort((a, b) => b.y - a.y || a.x - b.x).map((it) => it.str).join(" ")) : "";
    const specText = specColIdx >= 0 ? cleanText(inGroup(cols[specColIdx]).sort((a, b) => b.y - a.y || a.x - b.x).map((it) => it.str).join(" ")) : "";
    const modelNo = extractModelNo(modelText) || extractModelNo(specText);

    const priceItems = items
      .filter((it) => it.x >= priceCol.x0 && it.x < priceCol.x1 && it.y <= group.spanTop && it.y > group.spanBottom && /\$\s*[\d,.]+/.test(it.str))
      .sort((a, b) => b.y - a.y);
    if (!priceItems.length) continue;

    const bestImage = group.images.slice().sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
    const imageKey = modelNo ? `nj-${slugify(modelNo)}` : `nj-y${Math.round(group.y1)}-${state.rows.length}`;

    for (let pi = 0; pi < priceItems.length; pi++) {
      const priceItem = priceItems[pi];
      const priceMatch = priceItem.str.match(/\$\s*([\d,.]+)/);
      const priceUSD = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null;
      if (priceUSD == null) continue;

      const rowYTop = pi === 0 ? group.spanTop : (priceItem.y + priceItems[pi - 1].y) / 2;
      const rowYBottom = pi + 1 < priceItems.length ? (priceItem.y + priceItems[pi + 1].y) / 2 : group.spanBottom;

      const variantParts = [];
      for (let ci = 0; ci < cols.length; ci++) {
        if (ci === priceColIdx || ci === pictureColIdx || ci === modelColIdx || ci === specColIdx) continue;
        if (/^unit$/i.test(cols[ci].label)) continue;
        const cellItems = items
          .filter((it) => it.x >= cols[ci].x0 && it.x < cols[ci].x1 && it.y <= rowYTop && it.y > rowYBottom)
          .sort((a, b) => b.y - a.y || a.x - b.x);
        const t = cleanText(cellItems.map((it) => it.str).join(" "));
        if (t) variantParts.push(t);
      }
      const variantLabel = variantParts.join(" ").trim();

      const baseId = modelNo || imageKey.replace(/^nj-/, "");
      let sourceUrl = `nanjing://${baseId}${variantLabel ? `-${slugify(variantLabel)}` : ""}`;
      let n = 2;
      while (state.seenSourceUrls.has(sourceUrl)) {
        sourceUrl = `nanjing://${baseId}${variantLabel ? `-${slugify(variantLabel)}` : ""}-${n}`;
        n++;
      }
      state.seenSourceUrls.add(sourceUrl);

      const titleBits = [titlePrefix, state.currentSection, variantLabel].filter(Boolean);
      const title = titleBits.join(" ").replace(/\s+/g, " ").trim() || `${titlePrefix} ${modelNo || "product"}`;

      state.rows.push({
        sku: modelNo ? `${modelNo}${variantLabel ? `-${slugify(variantLabel)}` : ""}` : slugify(sourceUrl.replace("nanjing://", "")),
        sourceUrl,
        imageKey,
        title,
        category,
        priceUSD,
        imageBuffer: bestImage ? Buffer.from(bestImage.info.bytes) : null,
        imageMime: bestImage ? "image/jpeg" : null,
      });
    }
  }
}

// Parses a Nanjing Jiuguang pricelist PDF (as a Buffer/Uint8Array) into
// rows. Each row: { sku, sourceUrl, imageKey, title, category, priceUSD,
// imageBuffer, imageMime }. imageKey identifies the shared photo for a
// whole size/variant group — several rows can point at the same imageKey,
// mirroring how MagicstarImage is keyed by SKU but here keyed by the
// group rather than the (now per-variant, disambiguated) row SKU.
export async function parseNanjingPdf(pdfBytes) {
  const pdfjsData = new Uint8Array(pdfBytes);
  const pdfLibData = new Uint8Array(pdfBytes);
  const doc = await getDocument({ data: pdfjsData }).promise;
  const libDoc = await PDFDocument.load(pdfLibData, { updateMetadata: false });

  const state = { currentSection: "", currentCategory: "VELDT", seenSourceUrls: new Set(), rows: [] };
  let activeCols = null;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const textContent = await page.getTextContent();
    const { rects, images: placements } = await getPageGeometry(page);

    const libPage = libDoc.getPage(p - 1);
    const resources = libPage.node.Resources();
    const xobjDict = resources.lookup(PDFName.of("XObject"), PDFDict);
    const realKeys = xobjDict ? xobjDict.keys() : [];
    const nameToRealKey = {};
    let slot = 0;
    for (const pl of placements) {
      if (!(pl.name in nameToRealKey)) {
        nameToRealKey[pl.name] = realKeys[slot];
        slot++;
      }
    }
    const imgInfoByKey = {};
    for (const key of realKeys) {
      const ref = xobjDict.get(key);
      const streamObj = libDoc.context.lookup(ref);
      const dict = streamObj.dict;
      const filter = String(dict.get(PDFName.of("Filter")) || "");
      const keyStr = key.asString ? key.asString() : String(key);
      imgInfoByKey[keyStr] = { filter, bytes: streamObj.contents || streamObj.getContents() };
    }
    const images = placements
      .map((pl) => {
        const realKey = nameToRealKey[pl.name];
        const keyStr = realKey && realKey.asString ? realKey.asString() : String(realKey);
        return { ...pl, info: imgInfoByKey[keyStr] };
      })
      .filter((pl) => pl.info && pl.info.filter.includes("DCTDecode"));

    const items = textContent.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));

    const cellRects = rects.filter((r) => r.x1 - r.x0 > 2 && r.y1 - r.y0 > 2);
    const bannerRects = cellRects
      .filter((r) => r.x1 - r.x0 > 350 && r.y1 - r.y0 > 10 && r.y1 - r.y0 < 30)
      .map((r) => {
        const t = cleanText(
          items.filter((it) => it.x >= r.x0 - 1 && it.x <= r.x1 + 1 && it.y >= r.y0 - 1 && it.y <= r.y1 + 1).map((it) => it.str).join(" ")
        );
        return { y: (r.y0 + r.y1) / 2, text: t };
      })
      .filter((b) => b.text && !/^(Model|Price|Specifications)\b/i.test(b.text));

    const byY = {};
    for (const it of items) {
      const key = Math.round(it.y * 2) / 2;
      (byY[key] = byY[key] || []).push(it);
    }
    const headerYs = Object.keys(byY)
      .map(Number)
      .filter((y) => byY[y].some((it) => /^Model$/i.test(it.str.trim())) && byY[y].some((it) => /^Price$/i.test(it.str.trim())))
      .sort((a, b) => b - a);
    const headerEntries = headerYs.map((y) => ({ y, cols: colsFromHeaderBand(items, y) }));

    // Build the region boundary list: PAGE_TOP, each header's y (desc),
    // PAGE_BOTTOM. Region i (between boundary[i] and boundary[i+1]) uses
    // the column map in effect going INTO boundary[i] — the carried-over
    // activeCols for the first region, else the header just above it.
    const bannerQueue = bannerRects.slice().sort((a, b) => b.y - a.y);
    const boundaries = [PAGE_TOP, ...headerEntries.map((h) => h.y), PAGE_BOTTOM];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const cols = i === 0 ? activeCols : headerEntries[i - 1].cols;
      if (!cols) continue;
      const yTop = i === 0 ? PAGE_TOP : boundaries[i] - 2;
      const yBottom = boundaries[i + 1] + 2;
      processRegion(state, { items, images, bannerQueue, cols, yTop, yBottom });
    }
    if (headerEntries.length) activeCols = headerEntries[headerEntries.length - 1].cols;
  }

  return state.rows;
}
