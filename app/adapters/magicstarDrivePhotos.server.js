// Matches real product photos from Coenraad's MagicStar Google Drive
// folder (shared by their rep, magicstar.kailey@gmail.com) onto already-
// staged WOEST Caraq products, as an alternative to the Alibaba catalog
// scrape in magicstarCatalog.server.js — which has never reliably returned
// anything (Alibaba's anti-bot setup appears to block it even through
// Bright Data's render path; see that file's header and the diagnostic
// logging added to it).
//
// Confirmed directly against the real Drive folder (via the Drive search
// tool, not guessed) before building this: it's organised as
// product/<Vehicle name>/<Model code>/<photo files>.jpg, e.g.
// product/Jimny/JM75/*.jpg — and the model-code folder names match real
// SKUs from the pricelist PDF (parseMagicstarPdf's `sku` field) almost
// exactly:
//   - Most are an exact match: "JM75", "JM25", "KM06", "KM08" etc. line up
//     with the SKU of the same spelling.
//   - Some drop the 2-letter prefix for MagicStar's longer numeric codes,
//     e.g. folder "1001" / "9005" / "9006" for SKUs "JM1001" / "JM9005" /
//     "JM9006" — all seen under a vehicle folder (Jimny / Landcruiser /
//     Nissan Patrol) whose OTHER sibling folders use the "JM" prefix, so
//     that prefix is inferred from siblings rather than guessed blind.
//   - A few folders cover more than one SKU with shared photos, named as
//     space-separated codes, e.g. "KM10 11" (confirmed: the pricelist has
//     both KM10 and KM11 as real, separate SKUs for the same Prado
//     product line) — each token becomes its own candidate SKU, with a
//     bare-digit token borrowing the previous token's letter prefix.
//   - A few folders carry a trailing "-N" variant-photo-set suffix (e.g.
//     "JM50-2") that isn't part of the SKU at all — stripped before
//     matching so a second photo set for the same SKU still lines up with
//     it instead of silently going unmatched.
// Zip parsing doesn't assume Google Drive's own top-level folder name is
// present (Drive's own zip download adds one, but a user could also zip a
// subset of vehicle folders) — only the last two path segments before each
// image file matter.
import { unzipSync } from "fflate";

const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;
const MIME_BY_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

// Parses the uploaded zip into one entry per real image file:
// { vehicleFolder, codeFolder, filename, mimeType, data }. Directory
// markers, non-image junk (desktop.ini, .DS_Store, Drive's own gdoc
// shortcuts) and empty entries are skipped.
export function parseDrivePhotoZip(zipBytes) {
  const files = unzipSync(zipBytes);
  const entries = [];
  for (const [path, data] of Object.entries(files)) {
    if (!data || data.length === 0) continue;
    if (!IMAGE_EXT_RE.test(path)) continue;
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) continue; // no enclosing folder to read a code from
    const filename = parts[parts.length - 1];
    const codeFolder = parts[parts.length - 2];
    const vehicleFolder = parts.length >= 3 ? parts[parts.length - 3] : "";
    const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
    entries.push({
      vehicleFolder,
      codeFolder,
      filename,
      mimeType: MIME_BY_EXT[ext] || "image/jpeg",
      data: Buffer.from(data),
    });
  }
  return entries;
}

function normalizeCode(s) {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// A trailing "-N" (1-2 digits) on a token that starts with a letter is
// read two ways, both offered as candidates: it could be a genuine part
// of the SKU (MagicStar does have real SKUs like "JM12-2"), or a "second
// photo-set for the same product" suffix the rep added only to the folder
// name (e.g. "JM50-2" when there's no "JM50-2" SKU at all, only "JM50").
// There's no way to tell which from the folder name alone, so both
// readings are offered and the real staged-SKU list decides which (if
// either) is real — deliberately NOT done for a space before the digits
// ("KM10 11"), which is a different, confirmed-real pattern: two distinct
// adjacent SKUs sharing one photo set, handled by the token loop below.
function dashVariantBase(token) {
  const m = token.match(/^([A-Za-z].*)-\d{1,2}$/);
  return m ? m[1] : null;
}

// Collects, per vehicle folder, the letter-prefixes used by its OWN
// sibling code-folders that do carry a prefix (e.g. "JM" from "JM75"
// alongside a prefix-less "1001") — used to guess the missing prefix on a
// bare-digit folder. A vehicle folder can legitimately mix prefixes (a
// Landcruiser folder really does hold both "JM9005" and "KM08"-style
// products side by side, confirmed on the real Drive), so every distinct
// sibling prefix is offered as a candidate rather than only a single
// unambiguous one — the actual staged-SKU lookup is what decides which
// guess, if any, is real, so offering more than one never risks a wrong
// match on its own.
function siblingPrefixesByVehicle(entries) {
  const byVehicle = new Map();
  for (const e of entries) {
    if (!byVehicle.has(e.vehicleFolder)) byVehicle.set(e.vehicleFolder, new Set());
    for (const tok of e.codeFolder.trim().split(/\s+/)) {
      const m = tok.match(/^([A-Za-z]+)\d/);
      if (m) byVehicle.get(e.vehicleFolder).add(m[1].toUpperCase());
    }
  }
  return byVehicle;
}

// Every plausible normalized SKU code a single code-folder name could
// represent. Usually exactly one; a compound folder ("KM10 11") yields one
// per whitespace-separated token, with a bare-digit token borrowing the
// previous token's letter prefix.
function candidateCodes(codeFolder, vehicleFolder, prefixesByVehicle) {
  const tokens = codeFolder.trim().split(/\s+/).filter(Boolean);
  const candidates = [];
  let lastPrefix = null;
  for (const tok of tokens) {
    const withPrefix = tok.match(/^([A-Za-z]+)(\d.*)$/);
    if (withPrefix) {
      lastPrefix = withPrefix[1].toUpperCase();
      candidates.push(normalizeCode(tok));
      const dashBase = dashVariantBase(tok);
      if (dashBase) candidates.push(normalizeCode(dashBase));
    } else if (/^\d+$/.test(tok)) {
      if (lastPrefix) {
        // A preceding letter+digit token in THIS SAME folder name (e.g.
        // "KM10 11") already tells us the prefix to use — that local
        // context wins outright, rather than also guessing from
        // unrelated sibling folders under the same vehicle.
        candidates.push(normalizeCode(lastPrefix + tok));
      } else {
        // No local context (this digit token is the whole folder name,
        // e.g. a bare "1001") — try every prefix used by sibling
        // folders under the same vehicle, plus the bare digits as-is.
        for (const prefix of prefixesByVehicle.get(vehicleFolder) || []) {
          candidates.push(normalizeCode(prefix + tok));
        }
        candidates.push(normalizeCode(tok));
      }
    } else {
      candidates.push(normalizeCode(tok));
    }
  }
  return candidates;
}

// Matches parsed zip entries against a list of real staged SKUs.
// Returns:
//   - photosBySku: Map<sku, [{mimeType, data, filename}]> — images sorted
//     by filename for a stable order across re-uploads.
//   - matchedFolders: Set of "vehicleFolder/codeFolder" that matched at
//     least one SKU.
//   - unmatchedFolders: [{ vehicleFolder, codeFolder, fileCount }] for
//     folders that matched nothing — surfaced so Coenraad can tell a
//     genuinely new/renamed code from a parser miss, rather than this
//     silently dropping photos.
export function matchDrivePhotosToSkus(entries, skus) {
  const prefixesByVehicle = siblingPrefixesByVehicle(entries);
  const skusByNormalized = new Map();
  for (const sku of skus) {
    const norm = normalizeCode(sku);
    if (!norm) continue;
    if (!skusByNormalized.has(norm)) skusByNormalized.set(norm, []);
    skusByNormalized.get(norm).push(sku);
  }

  const byFolder = new Map(); // "vehicle/code" -> entries[]
  for (const e of entries) {
    const key = `${e.vehicleFolder}/${e.codeFolder}`;
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(e);
  }

  const photosBySku = new Map();
  const matchedFolders = new Set();
  const unmatchedFolders = [];

  for (const [folderKey, folderEntries] of byFolder) {
    const { vehicleFolder, codeFolder } = folderEntries[0];
    const candidates = candidateCodes(codeFolder, vehicleFolder, prefixesByVehicle);
    const matchedSkus = new Set();
    for (const cand of candidates) {
      for (const sku of skusByNormalized.get(cand) || []) matchedSkus.add(sku);
    }
    if (matchedSkus.size === 0) {
      unmatchedFolders.push({ vehicleFolder, codeFolder, fileCount: folderEntries.length });
      continue;
    }
    matchedFolders.add(folderKey);
    const sorted = [...folderEntries].sort((a, b) => a.filename.localeCompare(b.filename));
    for (const sku of matchedSkus) {
      if (!photosBySku.has(sku)) photosBySku.set(sku, []);
      photosBySku.get(sku).push(...sorted);
    }
  }

  return { photosBySku, matchedFolders, unmatchedFolders };
}
