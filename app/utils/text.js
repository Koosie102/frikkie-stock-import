// Shared text helpers for product titles across all sources.

// Title-cases a string while preserving likely acronyms/alphanumeric codes
// (LED, 4WD, 12V, RGB, etc.) so we don't mangle them into "Led" or "4wd".
// Heuristic: leave a word untouched if it contains a digit, or if it's
// already all-uppercase and short (<=5 chars, likely an acronym).
export function toTitleCase(str) {
  return (str || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      // Strip a trailing ™/®/© from the acronym check so "LED™" still
      // counts as a 3-letter acronym, not a 4-character regular word.
      const core = word.replace(/[™®©]+$/, "");
      if (/\d/.test(core) || (core === core.toUpperCase() && core.length <= 3)) {
        return word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

// Formats a scraped/fetched product title as "<BRAND> Title Cased Rest".
// Strips any existing brand-name prefix first (case-insensitive, and
// tolerant of a trademark symbol like "ALTIQ™" or "ALTIQ®" directly after
// the name) so a re-fetch doesn't produce "STEDI Stedi Duel Connector..."
// or leave a stray symbol behind as "ALTIQ ™ Rogue...".
export function formatProductTitle(brandCaps, rawTitle) {
  const cased = toTitleCase(rawTitle);
  const escaped = brandCaps.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutPrefix = cased.replace(new RegExp(`^${escaped}[™®©]?\\s*`, "i"), "").trim();
  return withoutPrefix ? `${brandCaps} ${withoutPrefix}` : brandCaps;
}
