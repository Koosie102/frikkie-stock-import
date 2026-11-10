// Scrapes MagicStar's (Zhejiang Huangyan Linxu Plastic Mould Factory)
// Alibaba supplier storefront to pull richer per-product descriptions for
// the "WOEST Caraq" line — the counterpart to nanjingCatalog.server.js,
// but for a genuinely different kind of source: a live, JavaScript-heavy
// storefront rather than a PDF Coenraad uploads.
//
// Confirmed directly (browser-driven, not guessed) before building this:
// - The storefront is at https://tzmagicstar.en.alibaba.com/productlist.html,
//   paginated as productlist.html (page 1), productlist-2.html,
//   productlist-3.html, ... (confirmed by actually clicking "2" in the
//   real pagination control and reading the URL it landed on) — 6 pages,
//   ~20 product tiles each, ~120 products total.
// - Both the storefront and individual product pages are plain empty HTML
//   shells to a non-JS fetch (confirmed: a direct fetch and a Bright Data
//   Web Unlocker call with the default `format:"raw"` both came back as a
//   ~129-byte shell with no product content) — the real content only
//   exists after client-side JavaScript runs. Bright Data's Web Unlocker
//   supports a documented `render:"true"` flag that forces this through a
//   real browser; this is the ONLY path confirmed capable of getting real
//   content back, so every request here goes through it. This could not
//   be tested end-to-end against this specific site's anti-bot setup
//   without a real Bright Data account (Coenraad's production
//   BRIGHTDATA_API_KEY/BRIGHTDATA_UNLOCKER_ZONE, already set on Railway
//   for STEDI/OZZ) — if Alibaba's bot-detection still blocks even the
//   rendered request, this will surface as a clear error in the scrape
//   log rather than silently returning nothing.
// - A product tile's link is any `a[href*="product-detail"]` (class
//   "title-link" in practice) — confirmed by querying the live DOM.
// - A product detail page's vehicle fitment and spec fields live in two
//   confirmed DOM regions: `.module_attribute` (Key attributes — Type,
//   Car Model, Voltage, Warranty, ...) and
//   `.module_industry_compatible_vehicles_up` (the "Compatible vehicles"
//   table — Make / Model text / Year range, repeating). Both are read as
//   flat label-then-value (or Make/Model/Year triples) leaf-text lists,
//   confirmed against a real product page before writing this parser.
//
// Because this needs one real-browser-rendered request per listing page
// PLUS one per product (fitment text is only on each product's own page,
// not the listing), a full catalog sync is ~126 Bright Data requests —
// materially more expensive and slower than every other source in this
// app, and run as a background job (same ImportRun/progress-log pattern
// as the STEDI scraper) rather than a synchronous request/response.
import * as cheerio from "cheerio";

const BASE_URL = "https://tzmagicstar.en.alibaba.com";
const BRIGHTDATA_API_URL = "https://api.brightdata.com/request";
const REQUEST_DELAY_MS = 500;
const MAX_LIST_PAGES = 30; // sanity guard — real catalog has 6

const BROWSER_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function absoluteUrl(href) {
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("http")) return href;
  return new URL(href.replace(/^\//, ""), `${BASE_URL}/`).href;
}

// A JS-shell response (confirmed on this site) is tiny and carries none of
// the real page's markup — cheap, reliable "did we get real content" check
// without having to know every possible anti-bot interstitial's wording.
function looksLikeEmptyShell(html) {
  return !html || html.length < 2000 || !/<body/i.test(html);
}

async function brightDataRequest(url, { render } = {}) {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  const zone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  if (!apiKey || !zone) {
    throw new Error(
      "BRIGHTDATA_API_KEY/BRIGHTDATA_UNLOCKER_ZONE aren't set — the MagicStar catalog scrape requires Bright Data's Web Unlocker (same Railway env vars STEDI/OZZ already use), since Alibaba's storefront needs JavaScript rendering to show real content.",
    );
  }
  const body = { zone, url, format: "raw" };
  if (render) body.render = "true";
  const res = await fetch(BRIGHTDATA_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Bright Data Web Unlocker HTTP ${res.status} for ${url}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  return res.text();
}

// Escalates: a cheap direct fetch first (free — in case Alibaba ever
// serves this to a plain client), then Bright Data without rendering
// (cheaper than the render path), and only pays for `render:"true"` once
// both have been confirmed to return an empty shell. Every step so far
// has come back empty on this site in testing, so production traffic will
// likely always end up paying for the render step — expected, not a bug.
async function fetchRenderedHtml(url) {
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    const html = await res.text();
    if (!looksLikeEmptyShell(html)) return html;
  } catch {
    // fall through to Bright Data
  }

  try {
    const html = await brightDataRequest(url, { render: false });
    if (!looksLikeEmptyShell(html)) return html;
  } catch {
    // fall through to the render path
  }

  const html = await brightDataRequest(url, { render: true });
  if (looksLikeEmptyShell(html)) {
    throw new Error(`Got an empty/JS-shell response even with Bright Data's render flag for ${url} — Alibaba's anti-bot setup may be blocking this specific request.`);
  }
  await sleep(REQUEST_DELAY_MS);
  return html;
}

// Captures the page title and a chunk of body text when a listing page
// returns real, non-shell HTML (passes looksLikeEmptyShell) but still
// matches zero product tiles — the "0 product(s) found, no error" case
// reported in production. Surfaced in the run's log so Coenraad can paste
// it back for diagnosis instead of this failing silently with nothing to
// go on (e.g. a bot-check interstitial that happens to be real, sizeable
// HTML rather than the tiny JS-shell looksLikeEmptyShell already catches).
function diagnosticSnippet($, html) {
  const title = $("title").text().trim();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 300);
  return `title="${title || "(none)"}" htmlLength=${html.length} bodyText="${bodyText || "(empty)"}"`;
}

function listPageUrl(pageNum) {
  return pageNum === 1 ? `${BASE_URL}/productlist.html` : `${BASE_URL}/productlist-${pageNum}.html`;
}

// Walks the storefront's paginated product list, returning
// [{ url, title }]. Stops as soon as a page contributes no new product
// URLs (covers both "ran out of pages" and "site re-serves page 1" cases,
// same defensive pattern used for Nanjing/OZZ's own pagination).
export async function getMagicstarProductList(onProgress) {
  const seen = new Set();
  const products = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const html = await fetchRenderedHtml(listPageUrl(page));
    const $ = cheerio.load(html);
    const before = products.length;
    $('a[href*="product-detail"]').each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const url = absoluteUrl(href).split("?")[0];
      if (seen.has(url)) return;
      seen.add(url);
      const title = $(el).attr("title")?.trim() || $(el).text().trim();
      if (title) products.push({ url, title });
    });
    const foundThisPage = products.length - before;
    if (onProgress) {
      onProgress({
        page,
        foundThisPage,
        totalSoFar: products.length,
        diagnostic: foundThisPage === 0 ? diagnosticSnippet($, html) : null,
      });
    }
    if (foundThisPage === 0) break; // this page added nothing new
  }
  return products;
}

// Reads leaf-text nodes out of a DOM region in document order — the same
// shape confirmed live on a real product page for both the Key Attributes
// block and the Compatible Vehicles block (plain alternating label/value
// or Make/Model/Year text, no attributes to key off beyond that).
function leafTextLines($, root) {
  const lines = [];
  root.find("*").each((_, el) => {
    const node = $(el);
    if (node.children().length === 0) {
      const t = node.text().replace(/\s+/g, " ").trim();
      if (t) lines.push(t);
    }
  });
  return lines;
}

function pairsFromLines(lines) {
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i], lines[i + 1]]);
  return pairs;
}

// Parses one product detail page into
// { url, title, carModel, attributes: [[label,value]], fitmentLines, descriptionHtml }.
export async function parseMagicstarProduct(url) {
  const html = await fetchRenderedHtml(url);
  const $ = cheerio.load(html);

  const title = $("h1").first().text().trim();
  const attrLines = leafTextLines($, $(".module_attribute").first());
  const attributes = pairsFromLines(attrLines);
  const carModel = attributes.find(([label]) => /^car model$/i.test(label))?.[1] || "";

  const fitmentRoot = $(".module_industry_compatible_vehicles_up").first();
  const fitmentRaw = fitmentRoot.length ? leafTextLines($, fitmentRoot) : [];
  // Drop known header/noise tokens ("Compatible vehicles", "All", the
  // column headers "Car Fitment"/"Model"/"Year") rather than assuming a
  // fixed position for them — confirmed these exact tokens on the real
  // page, but their count can vary (e.g. a multi-make product repeats the
  // "All"/make tabs).
  const FITMENT_NOISE = new Set(["compatible vehicles", "all", "car fitment", "model", "year"]);
  const fitmentLines = fitmentRaw.filter((l) => !FITMENT_NOISE.has(l.toLowerCase()));

  const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const descParts = [
    ...attributes.map(([label, value]) => `${label}: ${value}`),
    ...(fitmentLines.length ? [`Compatible vehicles: ${fitmentLines.join(", ")}`] : []),
  ];
  const descriptionHtml = descParts.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n");

  await sleep(REQUEST_DELAY_MS);
  return { url, title, carModel, attributes, fitmentLines, descriptionHtml };
}

// Full crawl: list every product, then fetch each one's detail page.
// onProgress is called after the list phase and after every detail fetch
// so a background job can report live status the same way STEDI's does.
export async function fetchMagicstarCatalog(onProgress) {
  const list = await getMagicstarProductList((p) => onProgress?.({ phase: "listing", ...p }));
  const entries = [];
  for (let i = 0; i < list.length; i++) {
    const { url, title } = list[i];
    try {
      const entry = await parseMagicstarProduct(url);
      entries.push(entry);
    } catch (err) {
      entries.push({ url, title, carModel: "", attributes: [], fitmentLines: [], descriptionHtml: "", error: String(err.message || err) });
    }
    onProgress?.({ phase: "detail", index: i + 1, total: list.length, title });
  }
  return entries;
}

// --- Matching catalog entries to already-staged MagicStar products ------

// There is no model number anywhere on Alibaba's listings (confirmed —
// the only identifying fields are the title and the vehicle fitment), so
// unlike Nanjing's code-based matching this is title-similarity plus a
// vehicle-fitment bonus. Reuses the same word-overlap scorer already used
// elsewhere in this app (shopifyMatch.server.js) rather than inventing a
// second one.
export function scoreMagicstarMatch(stagedTitle, entry, jaccardSimilarity, normalizeWords) {
  const titleScore = jaccardSimilarity(stagedTitle, entry.title);
  let bonus = 0;
  if (entry.carModel) {
    const modelWords = normalizeWords(entry.carModel);
    const stagedWords = normalizeWords(stagedTitle);
    if (modelWords.size > 0 && [...modelWords].every((w) => stagedWords.has(w))) {
      bonus = 0.2;
    }
  }
  return Math.min(1, titleScore + bonus);
}

// Thresholds are deliberately higher than Nanjing's code-based matching
// (0.5/no-floor there) given this is pure fuzzy text matching with no
// model-number anchor at all — better to leave a staged product's
// existing description alone than overwrite it on a weak guess. "exact"
// here means "confident", not "verified same product" the way a matched
// model code is.
const CONFIDENT_THRESHOLD = 0.55;
const APPROX_THRESHOLD = 0.4;

export function matchMagicstarEntry(stagedTitle, entries, jaccardSimilarity, normalizeWords) {
  let best = null;
  for (const entry of entries) {
    if (!entry.descriptionHtml) continue; // nothing useful to pull from a failed fetch
    const score = scoreMagicstarMatch(stagedTitle, entry, jaccardSimilarity, normalizeWords);
    if (!best || score > best.score) best = { entry, score };
  }
  if (!best || best.score < APPROX_THRESHOLD) return null;
  return { entry: best.entry, confidence: best.score >= CONFIDENT_THRESHOLD ? "exact" : "approx" };
}
