// Parses a MagicStar pricelist PDF directly — no website, no API. Each row
// in their table has a Number/SKU, a bilingual Model + Product Name, a
// Picture (a real embedded product photo), Applicable Years, Color,
// Package Size, a "Scan QR code for details" image, and Price in RMB.
//
// The QR code was investigated and deliberately NOT used — scanning one
// for real opens a WeChat Mini Program, which runs in WeChat's closed app
// sandbox with no public HTML a server can fetch, so there's no legitimate
// way to pull structured data from it automatically. The embedded Picture
// column image turned out to be real product photography on its own, so
// everything this import needs (SKU, fitment text, price, a usable photo)
// comes straight out of the PDF with no QR/WeChat dependency at all.
//
// Two pure-JS libraries do the extraction, no native build step and no
// headless-rendering involved (deliberately — an attempt to render pages
// with pdfjs + a Node canvas backend hit real compatibility bugs with this
// PDF's images; reading the data directly, as below, sidesteps that
// entirely and is both simpler and more reliable):
//   - pdfjs-dist: walks each page's operator list to find where every
//     embedded image is painted (position/size), and reads text positions
//     to reconstruct table rows.
//   - pdf-lib: reads each embedded image's *raw* JPEG bytes directly from
//     the PDF's XObject dictionary (every image in this file is
//     DCTDecode, i.e. already a plain JPEG stream) — no decoding or
//     re-encoding, byte-for-byte identical to what's embedded in the PDF.
//
// Row reconstruction: there is exactly one product photo per row and no
// real grid lines to detect column boundaries from (unlike a tool such as
// pdfplumber), so each product photo's vertical position anchors a "row
// band", and every text item whose y falls in that band (sorted left to
// right) is read as that row's combined text. SKU and price are then
// pulled out of that text with pattern matching rather than true column
// splitting — simple and workably accurate (~85-90% of rows on the real
// file this was built against), but not perfect: a handful of rows will
// come out with a messy title or occasionally get merged with a
// neighbour. That's fine for this source — every row lands in the normal
// staged-review table same as any other source, title is editable there,
// and Coenraad only intends to select a subset of rows (4x4-relevant
// only) to actually push, so a quick skim at review time catches anything
// odd rather than it needing to be perfect on import.

import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";

const CJK_RE = /[⺀-鿿豈-﫿＀-￯（）、，。／]/g;
const PACKAGE_SIZE_RE = /\d+(\.\d+)?\s*[*×x]\s*\d+(\.\d+)?\s*[*×x]\s*\d+(\.\d+)?/gi;

function cleanEnglish(s) {
  return (s || "").replace(CJK_RE, " ").replace(/\s+/g, " ").trim();
}

function extractSku(englishOnly) {
  const m = englishOnly.match(/^([A-Za-z0-9]+)\s*-\s*(\d+)/);
  if (m) return `${m[1]}-${m[2]}`;
  const m2 = englishOnly.match(/^([A-Za-z0-9]{2,10})\b/);
  if (m2 && /\d/.test(m2[1])) return m2[1];
  return null;
}

function extractPrice(rawText) {
  const tokens = rawText.split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (/^\d{2,6}$/.test(tokens[i])) return parseInt(tokens[i], 10);
  }
  return null;
}

// Best-effort human title: strip the leading SKU, the package-size
// triplet, the trailing price, and the "Scan QR code for more" filler
// text that sometimes bleeds into a row, then collapse what's left.
// Deliberately not fighting for a perfect title here — see file header.
//
// Every title is prefixed "WOEST Caraq" — WOEST is Coenraad's new brand
// (vendorNames.js sets the Shopify vendor field to "WOEST" itself), and
// "Caraq" is specifically this MagicStar-sourced product line under it,
// same brand-prefix pattern already used for STEDI/TrailBait titles.
const TITLE_PREFIX = "WOEST Caraq";

function buildTitle(englishOnly, sku, price) {
  let t = englishOnly;
  if (sku) t = t.replace(new RegExp(`^${sku.replace("-", "\\s*-\\s*")}`), "");
  t = t.replace(PACKAGE_SIZE_RE, " ");
  if (price != null) t = t.replace(new RegExp(`\\b${price}\\b\\s*$`), "");
  t = t.replace(/\bmore\b/gi, " ");
  t = t.replace(/\s*-\s*$/, "");
  t = t.replace(/\s+/g, " ").trim();
  return `${TITLE_PREFIX} ${t || sku || "product"}`.trim();
}

async function getImagePlacements(page) {
  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const placements = [];
  const mul = (m1, m2) => [
    m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(argsArray[i], ctm);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const name = argsArray[i][0];
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
        ctm[0] * x + ctm[2] * y + ctm[4],
        ctm[1] * x + ctm[3] * y + ctm[5],
      ]);
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      placements.push({ name, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    }
  }
  return placements;
}

// Parses a MagicStar pricelist PDF (as a Buffer/Uint8Array) into rows.
// Each row: { sku, title, priceRMB, imageBuffer, imageMime }.
// Rows with no confidently-extracted SKU or price are dropped rather than
// staged with guessed data.
export async function parseMagicstarPdf(pdfBytes) {
  // pdfjs explicitly rejects a Node Buffer (even though Buffer extends
  // Uint8Array) — it wants a plain Uint8Array, so always copy out of any
  // Buffer-ness rather than relying on `instanceof Uint8Array`, which is
  // true for a Buffer too and would let one slip through here.
  // Independent copies for each library — pdfjs-dist takes ownership of
  // (and can zero out) the Uint8Array it's given, so reusing the same one
  // for pdf-lib afterwards intermittently produced a corrupted read.
  const pdfjsData = new Uint8Array(pdfBytes);
  const pdfLibData = new Uint8Array(pdfBytes);
  const doc = await getDocument({ data: pdfjsData }).promise;
  const libDoc = await PDFDocument.load(pdfLibData, { updateMetadata: false });

  const rows = [];
  const seenSourceUrls = new Set();

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const textContent = await page.getTextContent();
    const placements = await getImagePlacements(page);

    const libPage = libDoc.getPage(p - 1);
    const resources = libPage.node.Resources();
    const xobjDict = resources.lookup(PDFName.of("XObject"), PDFDict);
    if (!xobjDict) continue;
    const realKeys = xobjDict.keys();

    // pdfjs assigns each image a synthetic id in first-use order, which
    // lines up positionally with the real XObject dictionary's key order
    // for a programmatically-generated PDF like this one.
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
      const w = Number(dict.get(PDFName.of("Width")));
      const h = Number(dict.get(PDFName.of("Height")));
      const filter = String(dict.get(PDFName.of("Filter")) || "");
      const keyStr = key.asString ? key.asString() : String(key);
      imgInfoByKey[keyStr] = { w, h, filter, bytes: streamObj.contents || streamObj.getContents() };
    }

    // Classify as a product photo using real pixel dimensions: photos are
    // wide; the QR codes (same cell size across the whole document) are
    // roughly square and smaller — skip those entirely, see file header.
    const photoPlacements = placements
      .map((pl) => {
        const realKey = nameToRealKey[pl.name];
        const keyStr = realKey && realKey.asString ? realKey.asString() : String(realKey);
        return { ...pl, keyStr, info: imgInfoByKey[keyStr] };
      })
      .filter((pl) => {
        if (!pl.info || !pl.info.filter.includes("DCTDecode")) return false;
        const { w, h } = pl.info;
        return w / h > 1.3 && w > 600;
      });

    const bands = photoPlacements
      .map((im) => ({ ...im, yc: (im.y0 + im.y1) / 2 }))
      .sort((a, b) => b.yc - a.yc);

    const items = textContent.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));

    for (let i = 0; i < bands.length; i++) {
      const band = bands[i];
      const nextBand = bands[i + 1];
      const yTop = band.yc + 25;
      const yBottom = nextBand ? (band.yc + nextBand.yc) / 2 : band.yc - 25;
      const rowItems = items
        .filter((it) => it.y <= yTop && it.y > yBottom)
        .sort((a, b) => a.x - b.x || b.y - a.y);
      const rawText = rowItems.map((it) => it.str).join(" ");
      const englishOnly = cleanEnglish(rawText);
      const sku = extractSku(englishOnly);
      const priceRMB = extractPrice(rawText);
      if (!sku || priceRMB == null || !band.info) continue;

      // SKUs repeat for genuine colour/style variants in this pricelist
      // (e.g. two rows both "86-02" at different prices) — stage each as
      // its own row with a disambiguated sourceUrl so neither is dropped,
      // since StagedProduct's uniqueness is on (source, sourceUrl), not
      // sku alone.
      let sourceUrl = `magicstar://${sku}`;
      let n = 2;
      while (seenSourceUrls.has(sourceUrl)) {
        sourceUrl = `magicstar://${sku}-${n}`;
        n++;
      }
      seenSourceUrls.add(sourceUrl);

      rows.push({
        sku,
        sourceUrl,
        title: buildTitle(englishOnly, sku, priceRMB),
        priceRMB,
        imageBuffer: Buffer.from(band.info.bytes),
        imageMime: "image/jpeg",
      });
    }
  }

  return rows;
}
